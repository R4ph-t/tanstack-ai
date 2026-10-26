import { orderedAssistantBlocks } from '@tanstack/ai'
import type { ContentPart, ModelMessage, ToolCall } from '@tanstack/ai'
import type {
  AssistantMessage,
  ImageContent,
  JsonObject,
  Message,
  TextContent,
  ToolResultMessage,
  Usage,
} from '@earendil-works/pi-ai'

/** The model fields of a pi assistant message. */
export type PiModelFields = Pick<AssistantMessage, 'api' | 'provider' | 'model'>

/** `value[key]` when `value` is an object, or undefined. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? Reflect.get(value, key)
    : undefined
}

/** `value[key]` when it is a string, or undefined. */
function stringField(value: unknown, key: string): string | undefined {
  const found = field(value, key)
  return typeof found === 'string' ? found : undefined
}

/** `metadata.tanstack[key]` of an event or a resume entry, or undefined. */
export function tanstackField(metadata: unknown, key: string): unknown {
  return field(field(metadata, 'tanstack'), key)
}

/** A pi `Usage` with every count zero. */
function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/**
 * Tool call arguments as a JSON object. Empty text is a call with no
 * arguments.
 *
 * @throws An error when the text is not a JSON object.
 */
function parseJsonObject(text: string): JsonObject {
  if (text.trim() === '') return {}
  const value: unknown = JSON.parse(text)
  if (!isJsonObject(value)) {
    throw new Error('Tool call arguments must be a JSON object.')
  }
  return value
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(content: string | null | Array<ContentPart>): string {
  if (typeof content === 'string') return content
  return (content ?? [])
    .map((part) => (part.type === 'text' ? part.content : ''))
    .join('')
}

/**
 * TanStack content parts as pi user content. pi user messages take text and
 * base64 images only.
 *
 * @throws An error for any other part, such as a URL image or a file, so the
 * model never answers without it.
 */
function toPiContent(
  content: string | null | Array<ContentPart>,
): string | Array<TextContent | ImageContent> {
  if (typeof content === 'string' || content === null) return content ?? ''
  return content.map((part): TextContent | ImageContent => {
    if (part.type === 'text') return { type: 'text', text: part.content }
    if (part.type === 'image' && part.source.type === 'data') {
      return {
        type: 'image',
        data: part.source.value,
        mimeType: part.source.mimeType,
      }
    }
    throw new Error(
      `pi messages take text and base64 images only, not a ${part.type} part with a ${part.source.type} source.`,
    )
  })
}

function fromPiContent(
  content: string | Array<TextContent | ImageContent>,
): string | Array<ContentPart> {
  if (typeof content === 'string') return content
  return content.map(
    (part): ContentPart =>
      part.type === 'text'
        ? { type: 'text', content: part.text }
        : {
            type: 'image',
            source: { type: 'data', value: part.data, mimeType: part.mimeType },
          },
  )
}

type AssistantBlock = AssistantMessage['content'][number]

function thinkingBlock(
  thinking: NonNullable<ModelMessage['thinking']>[number],
): AssistantBlock {
  return {
    type: 'thinking',
    thinking: thinking.content,
    ...(thinking.signature !== undefined && {
      thinkingSignature: thinking.signature,
    }),
    ...(thinking.redacted && { redacted: true }),
  }
}

function toolCallBlock(call: ToolCall): AssistantBlock {
  const signature = stringField(call.metadata, 'thoughtSignature')
  return {
    type: 'toolCall',
    id: call.id,
    name: call.function.name,
    arguments: parseJsonObject(call.function.arguments),
    ...(signature !== undefined && { thoughtSignature: signature }),
  }
}

/** The pi content of a TanStack assistant message, in its `blockOrder`. */
function toPiAssistantContent(
  message: ModelMessage,
): AssistantMessage['content'] {
  const ordered = orderedAssistantBlocks(message)
  if (ordered) {
    return ordered.map((block) =>
      block.type === 'thinking'
        ? thinkingBlock(block.thinking)
        : block.type === 'text'
          ? { type: 'text', text: block.text }
          : toolCallBlock(block.toolCall),
    )
  }
  const text = textOf(message.content)
  return [
    ...(message.thinking ?? []).map(thinkingBlock),
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...(message.toolCalls ?? []).map(toolCallBlock),
  ]
}

/**
 * Convert TanStack `ModelMessage`s, such as `chat()` history, into pi
 * messages for `agentLoop` or `Agent`. `systemPrompts` become the leading pi
 * system message. System messages in `messages` are dropped, as in `chat()`,
 * so only the server sets the system prompt.
 *
 * A pi assistant message names the model that wrote it. Pass `model` (the
 * pi model fields) so pi providers can replay reasoning signatures from the
 * same model. Without it the fields are empty strings, and pi treats the
 * messages as from another model.
 *
 * @throws An error when a message has an unknown role, a tool message has no
 * matching tool call before it, a tool call has arguments that are not a JSON
 * object, or a user message has media other than base64 images.
 */
export function toPiMessages(
  messages: ReadonlyArray<ModelMessage>,
  {
    systemPrompts,
    model = { api: '', provider: '', model: '' },
  }: { systemPrompts?: ReadonlyArray<string>; model?: PiModelFields } = {},
): Array<Message> {
  const timestamp = Date.now()
  const toolNames = new Map<string, string>()
  const out: Array<Message> = []
  if (systemPrompts?.length) {
    out.push({ role: 'system', content: systemPrompts.join('\n\n'), timestamp })
  }
  for (const message of messages) {
    const at = message.createdAt?.getTime() ?? timestamp
    // AG-UI system and developer messages arrive with the role `system`.
    const role: string = message.role
    if (role === 'system') continue
    if (message.role === 'user') {
      out.push({
        role: 'user',
        content: toPiContent(message.content),
        timestamp: at,
      })
      continue
    }
    if (message.role === 'tool') {
      const toolName =
        message.toolCallId === undefined
          ? undefined
          : toolNames.get(message.toolCallId)
      if (message.toolCallId === undefined || toolName === undefined) {
        throw new Error(
          `Tool message ${message.toolCallId ?? '(no toolCallId)'} has no tool call before it.`,
        )
      }
      out.push({
        role: 'toolResult',
        toolCallId: message.toolCallId,
        toolName,
        content:
          message.error === undefined
            ? toPiToolContent(message.content)
            : [{ type: 'text', text: message.error }],
        isError: message.error !== undefined,
        timestamp: at,
      })
      continue
    }
    if (message.role !== 'assistant') {
      throw new Error(`A message has the unknown role ${role}.`)
    }
    for (const call of message.toolCalls ?? []) {
      toolNames.set(call.id, call.function.name)
    }
    out.push({
      role: 'assistant',
      content: toPiAssistantContent(message),
      ...model,
      usage: emptyUsage(),
      stopReason: message.toolCalls?.length ? 'toolUse' : 'stop',
      timestamp: at,
    })
  }
  return out
}

/**
 * pi tool result content as TanStack tool content: the text, or content
 * parts when there are images.
 */
export function fromPiToolContent(
  content: ToolResultMessage['content'],
): string | Array<ContentPart> {
  if (content.every((part) => part.type === 'text')) {
    return content.map((part) => part.text).join('')
  }
  return fromPiContent(content)
}

/**
 * TanStack tool content as pi tool result content. A string that holds a
 * JSON content-part array (the AG-UI wire form of a multimodal result) is
 * read as parts. Parts that pi cannot hold, such as a URL image, stay as
 * their JSON text, so the model still sees them.
 */
function toPiToolContent(
  content: string | null | Array<ContentPart>,
): Array<TextContent | ImageContent> {
  let value: unknown = content
  if (typeof content === 'string' && content.startsWith('[')) {
    try {
      value = JSON.parse(content)
    } catch {
      value = content
    }
  }
  if (Array.isArray(value) && value.every(isPiContentPart)) {
    const parts = toPiContent(value)
    return typeof parts === 'string' ? [{ type: 'text', text: parts }] : parts
  }
  return [
    {
      type: 'text',
      text: Array.isArray(content) ? JSON.stringify(content) : textOf(content),
    },
  ]
}

/** A text part or a base64 image part: the parts that pi content can hold. */
function isPiContentPart(value: unknown): value is ContentPart {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false
  }
  if (value.type === 'text') return 'content' in value
  const source: unknown = 'source' in value ? value.source : undefined
  return (
    value.type === 'image' &&
    typeof source === 'object' &&
    source !== null &&
    'type' in source &&
    source.type === 'data'
  )
}
