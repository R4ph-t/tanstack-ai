import { EventType, withTanstackMetadata } from '@tanstack/ai'
import type {
  Interrupt,
  RunFinishedEvent,
  SpecTokenUsage,
  StreamChunk,
  ToolCallResultEvent,
} from '@tanstack/ai'
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  AssistantMessage,
  AssistantMessageEvent,
  StopReason,
  ToolResultMessage,
} from '@earendil-works/pi-ai'
import { fromPiToolContent } from './messages'

type FinishReason = RunFinishedEvent['finishReason']

/** TanStack marks a redacted thinking block by this reasoning message id prefix. */
const REDACTED_PREFIX = 'redacted_thinking-'

function fromPiStopReason(reason: StopReason): FinishReason {
  if (reason === 'toolUse') return 'tool_calls'
  if (reason === 'length') return 'length'
  return 'stop'
}

function fromPiUsage(message: AssistantMessage): Array<SpecTokenUsage> {
  const { usage } = message
  return [
    {
      provider: message.provider,
      model: message.model,
      inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
      outputTokens: usage.output,
      totalTokens: usage.totalTokens,
      ...(usage.cacheRead > 0 && { cachedInputTokens: usage.cacheRead }),
      ...(usage.cacheWrite > 0 && { cacheWriteInputTokens: usage.cacheWrite }),
      ...(usage.reasoning !== undefined && {
        reasoningTokens: usage.reasoning,
      }),
    },
  ]
}

/** Options for {@link fromPiAgentEvents}. */
export interface FromPiAgentEventsOptions {
  threadId: string
  runId: string
  /**
   * The tool calls that the run paused, with the interrupt to send for each.
   * Their blocked pi tool results stay off the stream, and the turn ends
   * with an interrupt. `runPiAgent` fills it while the loop runs.
   */
  interrupts?: ReadonlyMap<string, Interrupt>
  /** Tool results to send first: the answers to a resumed run's interrupts. */
  results?: ReadonlyArray<ToolResultMessage>
  /**
   * Which app messages (`CustomAgentMessages`) that pi adds mid-run go to the
   * client as `pi.message` events. Mid-run user messages always go, and pi
   * system messages never do. Default: none.
   */
  forwardMessage?: (message: AgentMessage) => boolean
}

/** A pi tool result as the AG-UI tool result event. */
function toolResultEvent(
  message: ToolResultMessage,
  messageId: string,
): ToolCallResultEvent {
  const content = fromPiToolContent(message.content)
  const result: ToolCallResultEvent = {
    type: EventType.TOOL_CALL_RESULT,
    messageId,
    toolCallId: message.toolCallId,
    // The AG-UI wire form of a multimodal result is the JSON parts.
    content:
      typeof content !== 'string'
        ? JSON.stringify(content)
        : content ||
          (message.details === undefined
            ? ''
            : JSON.stringify(message.details)),
    role: 'tool',
  }
  return message.isError
    ? withTanstackMetadata(result, { state: 'output-error' })
    : result
}

/**
 * Convert pi agent events, from `agentLoop()` or `Agent.subscribe()`, into the
 * AG-UI events of `chat()`. Serve them with `toServerSentEventsResponse`, and
 * TanStack `useChat` reads the pi agent like a `chat()` route.
 *
 * Each pi assistant message ends with a `RUN_FINISHED`, as each model call
 * of `chat()` does. A tool-use message ends after its tool results. A tool
 * result becomes a `TOOL_CALL_RESULT`, an error tool result with the
 * `output-error` state. An assistant message that stopped with an error or an
 * abort becomes a `RUN_ERROR`.
 *
 * pi data that has no AG-UI event becomes a `CUSTOM` event:
 *
 * - `pi.tool-progress`: a partial tool result (`tool_execution_update`),
 *   with `toolCallId`, `toolName` and `partialResult`.
 * - `pi.message`: a user message that pi adds mid-run (steering or
 *   follow-up), or an app message that `forwardMessage` allows. pi system
 *   messages stay on the server.
 *
 * The cost of a model call is the TanStack usage `cost`.
 */
export async function* fromPiAgentEvents(
  events: AsyncIterable<AgentEvent>,
  {
    threadId,
    runId,
    interrupts = new Map(),
    results = [],
    forwardMessage = () => false,
  }: FromPiAgentEventsOptions,
): AsyncGenerator<StreamChunk> {
  let messageId = ''
  let count = 0
  let finished = false
  // The prompt comes before the first assistant message. The client sent it.
  let prompted = false
  // A tool-use message ends at turn_end, after its tool results, so a paused
  // call can end the run with an interrupt.
  let pending: AssistantMessage | undefined
  const argsSent = new Set<string>()
  const reasoningIds = new Map<number, string>()

  function reasoningId(
    index: number,
    block?: AssistantMessage['content'][number],
  ): string {
    const known = reasoningIds.get(index)
    if (known !== undefined) return known
    const redacted = block?.type === 'thinking' && block.redacted === true
    const id = `${redacted ? REDACTED_PREFIX : ''}${messageId}-reasoning-${index}`
    reasoningIds.set(index, id)
    return id
  }

  function finishedEvent(message: AssistantMessage): StreamChunk {
    const paused = message.content.flatMap((block) => {
      const interrupt =
        block.type === 'toolCall' ? interrupts.get(block.id) : undefined
      return interrupt ? [interrupt] : []
    })
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
      model: message.model,
      finishReason: fromPiStopReason(message.stopReason),
      ...(message.responseId !== undefined && {
        responseId: message.responseId,
      }),
      usage: fromPiUsage(message),
      ...(paused.length > 0 && {
        outcome: { type: 'interrupt', interrupts: paused },
      }),
    }
    const cost = message.usage.cost.total
    return cost > 0 ? withTanstackMetadata(event, { usage: { cost } }) : event
  }

  function* flush(): Generator<StreamChunk> {
    if (!pending) return
    const message = pending
    pending = undefined
    finished = true
    yield finishedEvent(message)
  }

  yield { type: EventType.RUN_STARTED, threadId, runId }
  for (const result of results) yield toolResultEvent(result, result.toolCallId)

  for await (const event of events) {
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- turn_start, tool_execution_start and _end carry nothing the messages do not.
    switch (event.type) {
      case 'message_start':
        if ('role' in event.message && event.message.role === 'assistant') {
          yield* flush()
          prompted = true
          messageId = `${runId}-${++count}`
          reasoningIds.clear()
        }
        break

      case 'message_update':
        yield* fromAssistantEvent(event.assistantMessageEvent)
        break

      case 'tool_execution_update':
        yield {
          type: EventType.CUSTOM,
          name: 'pi.tool-progress',
          value: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            partialResult: event.partialResult,
          },
        }
        break

      case 'message_end': {
        const message = event.message
        const role = 'role' in message ? message.role : undefined
        if (message.role === 'toolResult') {
          if (!interrupts.has(message.toolCallId)) {
            yield toolResultEvent(message, messageId)
          }
          break
        }
        if (message.role !== 'assistant') {
          // pi system messages hold the prompt and the tool definitions, so
          // they stay on the server. App messages need `forwardMessage`.
          if (
            prompted &&
            role !== 'system' &&
            (role === 'user' || forwardMessage(message))
          ) {
            yield {
              type: EventType.CUSTOM,
              name: 'pi.message',
              value: message,
            }
          }
          break
        }
        // A pi provider can set the signatures only on the final message.
        for (const [index, block] of message.content.entries()) {
          const encryptedValue =
            block.type === 'thinking'
              ? block.thinkingSignature
              : block.type === 'toolCall'
                ? block.thoughtSignature
                : undefined
          if (!encryptedValue) continue
          yield {
            type: EventType.REASONING_ENCRYPTED_VALUE,
            subtype: block.type === 'toolCall' ? 'tool-call' : 'message',
            entityId:
              block.type === 'toolCall' ? block.id : reasoningId(index, block),
            encryptedValue,
          }
        }
        if (
          message.stopReason === 'error' ||
          message.stopReason === 'aborted'
        ) {
          yield {
            type: EventType.RUN_ERROR,
            threadId,
            runId,
            message: message.errorMessage ?? message.stopReason,
            model: message.model,
          }
          return
        }
        if (message.stopReason === 'toolUse') {
          pending = message
          break
        }
        finished = true
        yield finishedEvent(message)
        break
      }

      case 'turn_end':
        yield* flush()
        break

      case 'agent_end':
        yield* flush()
        if (!finished) {
          yield {
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
            finishReason: 'stop',
          }
        }
        return
    }
  }
  yield* flush()

  function* fromAssistantEvent(
    event: AssistantMessageEvent,
  ): Generator<StreamChunk> {
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- start, done and error come again on message_start and message_end.
    switch (event.type) {
      case 'text_start':
        yield {
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: 'assistant',
        }
        break
      case 'text_delta':
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: event.delta,
        }
        break
      case 'text_end':
        yield { type: EventType.TEXT_MESSAGE_END, messageId }
        break

      case 'thinking_start':
        yield {
          type: EventType.REASONING_MESSAGE_START,
          messageId: reasoningId(
            event.contentIndex,
            event.partial.content[event.contentIndex],
          ),
          role: 'reasoning',
        }
        break
      case 'thinking_delta':
        yield {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: reasoningId(event.contentIndex),
          delta: event.delta,
        }
        break
      case 'thinking_end':
        yield {
          type: EventType.REASONING_MESSAGE_END,
          messageId: reasoningId(event.contentIndex),
        }
        break

      case 'toolcall_start': {
        const block = event.partial.content[event.contentIndex]
        if (block?.type !== 'toolCall') break
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId: block.id,
          toolCallName: block.name,
          parentMessageId: messageId,
          ...(block.thoughtSignature !== undefined && {
            metadata: { thoughtSignature: block.thoughtSignature },
          }),
        }
        break
      }
      case 'toolcall_delta': {
        const block = event.partial.content[event.contentIndex]
        if (block?.type !== 'toolCall' || event.delta === '') break
        argsSent.add(block.id)
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: block.id,
          delta: event.delta,
        }
        break
      }
      case 'toolcall_end': {
        const call = event.toolCall
        // A provider can send the whole arguments at the start, with no deltas.
        if (!argsSent.has(call.id)) {
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: call.id,
            delta: JSON.stringify(call.arguments),
          }
        }
        yield {
          type: EventType.TOOL_CALL_END,
          toolCallId: call.id,
          input: call.arguments,
        }
        break
      }
    }
  }
}
