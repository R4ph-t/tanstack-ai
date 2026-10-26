import {
  EventType,
  INTERRUPT_BINDING_VERSION,
  canonicalInterruptJson,
  convertMessagesToModelMessages,
  digestInterruptJson,
  hashSchemaInput,
  interruptItemError,
  withInterruptBinding,
  withTanstackMetadata,
} from '@tanstack/ai'
import type {
  Interrupt,
  InterruptSubmissionError,
  ModelMessage,
  RunAgentResumeItem,
  StreamChunk,
  UIMessage,
} from '@tanstack/ai'
import {
  agentLoop,
  agentLoopContinue,
  runToolCall,
} from '@earendil-works/pi-agent-core'
import type {
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AgentTurnDecision,
  StreamFn,
} from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai'
import { tanstackField, toPiMessages } from './messages'
import { fromPiAgentEvents } from './stream'
import type { PiClientTool } from './request'

/** The `chatParamsFromRequest(request)` fields that `runPiAgent` reads. */
export interface PiAgentRequest {
  threadId: string
  runId: string
  messages: Array<UIMessage | ModelMessage>
  /** The tools of the client, which run in the browser. */
  tools?: ReadonlyArray<PiClientTool>
  /** The answers to the interrupts of the paused run. */
  resume?: ReadonlyArray<RunAgentResumeItem>
  /** The paused run, with `resume`. */
  parentRunId?: string
}

/** Options for {@link runPiAgent}. */
export interface RunPiAgentOptions {
  /** The pi agent loop config: `model`, `convertToLlm` and the hooks. */
  config: AgentLoopConfig
  /** The model call, for example `models.streamSimple.bind(models)`. */
  streamFn: StreamFn
  /** The pi tools, which run on the server. */
  tools?: ReadonlyArray<AgentTool>
  /** The names of the pi tools that a person approves before they run. */
  needsApproval?: ReadonlyArray<string>
  /** The system prompts. The request cannot set them. */
  systemPrompts?: ReadonlyArray<string>
  signal?: AbortSignal
}

const DENIED = 'The user denied this tool call'
const UNANSWERED = 'This tool call has no result'

function isAssistant(
  message: AgentMessage | undefined,
): message is AssistantMessage {
  return (
    message !== undefined && 'role' in message && message.role === 'assistant'
  )
}

/** A pi tool for a client tool. It never runs on the server. */
function clientAgentTool(tool: PiClientTool): AgentTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.parameters),
    execute: () => {
      throw new Error(`${tool.name} runs on the client.`)
    },
  }
}

/** The approval interrupt for a pi tool call. The client has no copy of the tool. */
function approvalInterrupt(call: AgentToolCall, runId: string): Interrupt {
  const id = `approval_${call.id}`
  return withInterruptBinding(
    {
      id,
      reason: 'tool_call',
      message: `Approval required to run ${call.name}`,
      toolCallId: call.id,
      metadata: {
        kind: 'approval',
        toolName: call.name,
        input: call.arguments,
      },
    },
    {
      v: INTERRUPT_BINDING_VERSION,
      kind: 'generic',
      interruptId: id,
      interruptedRunId: runId,
      generation: 0,
    },
  )
}

/** The interrupt that `chat()` sends for a client tool call. */
function clientToolInterrupt(call: AgentToolCall, runId: string): Interrupt {
  const id = `client_tool_${call.id}`
  const responseSchema = {}
  return withInterruptBinding(
    {
      id,
      reason: 'tanstack:client_tool_execution',
      message: `Client tool ${call.name} is ready to run`,
      toolCallId: call.id,
      responseSchema,
      metadata: {
        kind: 'client_tool',
        toolName: call.name,
        input: call.arguments,
      },
    },
    {
      v: INTERRUPT_BINDING_VERSION,
      kind: 'client-tool-execution',
      interruptId: id,
      toolName: call.name,
      toolCallId: call.id,
      outputSchemaHash: hashSchemaInput(undefined),
      responseSchemaHash: digestInterruptJson(
        canonicalInterruptJson(responseSchema),
      ),
      interruptedRunId: runId,
      generation: 0,
    },
  )
}

function textResult(
  call: AgentToolCall,
  text: string,
  isError: boolean,
): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text }],
    isError,
    timestamp: Date.now(),
  }
}

/** The tool message that the TanStack client sends for an answered approval. */
function isApprovalPlaceholder(message: ToolResultMessage): boolean {
  const first = message.content[0]
  if (message.content.length !== 1 || first?.type !== 'text') return false
  try {
    const value: unknown = JSON.parse(first.text)
    return (
      typeof value === 'object' &&
      value !== null &&
      'approved' in value &&
      typeof value.approved === 'boolean'
    )
  } catch {
    return false
  }
}

/**
 * The result of a client tool answer, as `chat()` reads it. An
 * `output-error` answer must be `{ error: string }`. Otherwise it is invalid.
 */
function clientToolAnswer(
  entry: RunAgentResumeItem,
): { error: string } | { output: unknown } | undefined {
  const payload: unknown = entry.payload
  if (tanstackField(entry.metadata, 'state') !== 'output-error') {
    return { output: payload }
  }
  return typeof payload === 'object' &&
    payload !== null &&
    Object.keys(payload).length === 1 &&
    'error' in payload &&
    typeof payload.error === 'string'
    ? { error: payload.error }
    : undefined
}

/** The decision of an approval answer, as `chat()` reads it. */
function approvalAnswer(entry: RunAgentResumeItem): boolean | undefined {
  const payload: unknown = entry.payload
  if (typeof payload === 'boolean') return payload
  return typeof payload === 'object' &&
    payload !== null &&
    'approved' in payload &&
    typeof payload.approved === 'boolean'
    ? payload.approved
    : undefined
}

/**
 * Run a pi agent for a TanStack `useChat` request, as AG-UI events. Serve the
 * result with `toServerSentEventsResponse`.
 *
 * Pass the params of `chatParamsFromRequest(request)`. The history becomes pi
 * messages, and the last message is the prompt.
 *
 * Two kinds of tool call pause the run with an interrupt, as in `chat()`:
 *
 * - A pi tool named in `needsApproval`. `useChat` shows the approval, and the
 *   user answers with `resolveInterrupt({ approved })`. An approved call runs
 *   on the next request, with the pi `beforeToolCall` and `afterToolCall`
 *   hooks.
 * - A client tool (the `tools` of the request). `useChat` runs it and sends
 *   the output back.
 *
 * The next request carries the answers in `resume`. The loop then continues
 * from the tool results with `agentLoopContinue`.
 */
export function runPiAgent(
  request: PiAgentRequest,
  {
    config,
    streamFn,
    tools = [],
    needsApproval = [],
    systemPrompts,
    signal,
  }: RunPiAgentOptions,
): AsyncGenerator<StreamChunk> {
  const { threadId, runId } = request
  const serverNames = new Set(tools.map((tool) => tool.name))
  const clientTools = (request.tools ?? []).filter(
    (tool) => !serverNames.has(tool.name),
  )
  const clientNames = new Set(clientTools.map((tool) => tool.name))
  const allTools = [...tools, ...clientTools.map(clientAgentTool)]

  const interrupts = new Map<string, Interrupt>()
  const loopConfig: AgentLoopConfig = {
    ...config,
    beforeToolCall: async (context, hookSignal) => {
      const { toolCall } = context
      if (clientNames.has(toolCall.name)) {
        interrupts.set(toolCall.id, clientToolInterrupt(toolCall, runId))
        return { block: true, reason: 'Waiting for the client' }
      }
      if (needsApproval.includes(toolCall.name)) {
        interrupts.set(toolCall.id, approvalInterrupt(toolCall, runId))
        return { block: true, reason: 'Waiting for approval' }
      }
      return config.beforeToolCall?.(context, hookSignal)
    },
    // A paused call ends the run. The other calls of the batch still run.
    finishTurn: async (
      turn,
      turnSignal,
    ): Promise<AgentTurnDecision | undefined> => {
      const paused = turn.message.content.some(
        (block) => block.type === 'toolCall' && interrupts.has(block.id),
      )
      if (paused) return { action: 'end' }
      return (await config.finishTurn?.(turn, turnSignal)) ?? undefined
    },
  }

  async function* run(): AsyncGenerator<StreamChunk> {
    // In the generator, so a broken history becomes a RUN_ERROR event.
    const history: Array<AgentMessage> = toPiMessages(
      convertMessagesToModelMessages(request.messages),
      {
        ...(systemPrompts && { systemPrompts }),
        model: {
          api: config.model.api,
          provider: config.model.provider,
          model: config.model.id,
        },
      },
    )
    const resume = request.resume ?? []
    if (resume.length === 0) {
      const prompt = history.pop()
      yield* fromPiAgentEvents(
        agentLoop(
          prompt ? [prompt] : [],
          { messages: history, tools: allTools },
          loopConfig,
          signal,
          streamFn,
        ),
        { threadId, runId, interrupts },
      )
      return
    }

    // For an answered approval, the client sends a placeholder tool message
    // (`{ approved, ... }`). The answer in `resume` replaces it. A real result
    // stays, so a replayed answer cannot run the tool again.
    const resumed = new Set(
      resume.map((item) => item.interruptId.replace(/^approval_/, '')),
    )
    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i]
      if (
        message &&
        'role' in message &&
        message.role === 'toolResult' &&
        resumed.has(message.toolCallId) &&
        isApprovalPlaceholder(message)
      ) {
        history.splice(i, 1)
      }
    }

    // The resumed run answers the calls of the last assistant message that
    // have no result yet.
    const assistant = history.findLast(isAssistant)
    const answered = new Set(
      history.flatMap((message: AgentMessage) =>
        'role' in message && message.role === 'toolResult'
          ? [message.toolCallId]
          : [],
      ),
    )
    // Each answer kind fits one kind of tool, as in chat(): an approval runs
    // only a tool in `needsApproval`, and a client output answers only a
    // client tool. The history comes from the client, so any other pending
    // call gets an error result and never runs.
    const allCalls = (assistant?.content ?? []).flatMap((block) =>
      block.type === 'toolCall' ? [block] : [],
    )
    const calls = allCalls.filter((call) => !answered.has(call.id))
    const pendingId = (call: AgentToolCall) =>
      clientNames.has(call.name)
        ? `client_tool_${call.id}`
        : needsApproval.includes(call.name)
          ? `approval_${call.id}`
          : undefined
    const expected = new Set(calls.flatMap((call) => pendingId(call) ?? []))
    // The client also sends its tool outputs in the history, so an answer to
    // a call that has a result is known, and is not run again.
    const known = new Set(allCalls.flatMap((call) => pendingId(call) ?? []))
    const entries = new Map(resume.map((item) => [item.interruptId, item]))
    // As in chat(), every paused call needs exactly one known answer.
    const scope = {
      threadId,
      interruptedRunId: request.parentRunId ?? runId,
      generation: 0,
    }
    const errors: Array<InterruptSubmissionError> = [
      ...[...expected]
        .filter((id) => !entries.has(id))
        .map((id) =>
          interruptItemError(
            scope,
            id,
            'unknown-interrupt',
            `Missing resume entry for interrupt ${id}.`,
          ),
        ),
      ...[...entries.keys()]
        .filter((id) => !known.has(id))
        .map((id) =>
          interruptItemError(
            scope,
            id,
            'unknown-interrupt',
            `Interrupt ${id} is not pending.`,
          ),
        ),
      // An answer must have the shape of its kind, as in chat().
      ...[...entries.values()].flatMap((entry) => {
        const { interruptId: id } = entry
        if (!expected.has(id) || entry.status === 'cancelled') return []
        if (id.startsWith('client_tool_')) {
          return clientToolAnswer(entry)
            ? []
            : [
                interruptItemError(
                  scope,
                  id,
                  'invalid-tool-output',
                  `Client tool ${id} has an output-error answer without an error message.`,
                ),
              ]
        }
        return approvalAnswer(entry) === undefined
          ? [
              interruptItemError(
                scope,
                id,
                'invalid-payload',
                `Approval ${id} must be a boolean or decision envelope.`,
              ),
            ]
          : []
      }),
    ]
    if (errors.length > 0) {
      yield { type: EventType.RUN_STARTED, threadId, runId }
      yield withTanstackMetadata(
        {
          type: EventType.RUN_ERROR as const,
          threadId,
          runId,
          message: errors.map((error) => error.message).join(' '),
          code: errors[0]?.code ?? 'unknown-interrupt',
        },
        { runId, threadId, interruptErrors: errors },
      )
      return
    }

    const results: Array<ToolResultMessage> = []
    const denied = new Set<string>()
    for (const call of calls) {
      const isClient = clientNames.has(call.name)
      const id = pendingId(call)
      const answer = id === undefined ? undefined : entries.get(id)
      const clientAnswer =
        isClient && answer ? clientToolAnswer(answer) : undefined
      if (!assistant || !answer) {
        results.push(textResult(call, UNANSWERED, true))
      } else if (answer.status === 'cancelled') {
        denied.add(call.id)
        results.push(textResult(call, DENIED, true))
      } else if (clientAnswer) {
        results.push(
          'error' in clientAnswer
            ? textResult(call, clientAnswer.error, true)
            : textResult(
                call,
                typeof clientAnswer.output === 'string'
                  ? clientAnswer.output
                  : JSON.stringify(clientAnswer.output ?? null),
                false,
              ),
        )
      } else if (approvalAnswer(answer)) {
        const outcome = await runToolCall(call, {
          tools: allTools,
          assistantMessage: assistant,
          context: { messages: history, tools: allTools },
          ...(signal && { signal }),
          ...(config.beforeToolCall && {
            beforeToolCall: config.beforeToolCall,
          }),
          ...(config.afterToolCall && { afterToolCall: config.afterToolCall }),
        })
        results.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: outcome.result.content,
          ...(outcome.result.details !== undefined && {
            details: outcome.result.details,
          }),
          isError: outcome.isError,
          timestamp: Date.now(),
        })
      } else {
        denied.add(call.id)
        results.push(textResult(call, DENIED, true))
      }
    }
    history.push(...results)
    // A denial has the denied outcome, as in chat().
    for await (const event of fromPiAgentEvents(
      agentLoopContinue(
        { messages: history, tools: allTools },
        loopConfig,
        signal,
        streamFn,
      ),
      { threadId, runId, interrupts, results },
    )) {
      yield event.type === EventType.TOOL_CALL_RESULT &&
      denied.has(event.toolCallId)
        ? withTanstackMetadata(event, {
            state: 'output-error',
            toolResultOutcome: 'denied',
          })
        : event
    }
  }

  return run()
}
