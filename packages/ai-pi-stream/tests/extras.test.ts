import { describe, expect, it } from 'vitest'
import { EventSchemas } from '@ag-ui/core/schemas'
import { EventType, chat, toolDefinition } from '@tanstack/ai'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { z } from 'zod'
import {
  chatParamsFromPiRequest,
  chatParamsFromPiRequestBody,
  fromPiAgentEvents,
  fromPiMessages,
  toPiAgentEvents,
  toPiMessages,
} from '../src'
import { emptyUsage } from '../src/messages'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai'
import type { AnyTextAdapter, StreamChunk } from '@tanstack/ai'
import type { PiBridgeEvent } from '../src'

async function collect<T>(stream: AsyncIterable<T>): Promise<Array<T>> {
  const out: Array<T> = []
  for await (const item of stream) out.push(item)
  return out
}

async function* list<T>(items: Array<T>): AsyncGenerator<T> {
  yield* items
}

const image = { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' }

describe('pi agent to TanStack', () => {
  it('sends progress, mid-run messages, cost, images and redacted reasoning', async () => {
    const assistant: AssistantMessage = {
      ...fauxAssistantMessage(
        [
          {
            type: 'thinking',
            thinking: '',
            thinkingSignature: 'opaque',
            redacted: true,
          },
          { type: 'toolCall', id: 'c1', name: 'screenshot', arguments: {} },
        ],
        { stopReason: 'toolUse' },
      ),
    }
    assistant.usage.cost.total = 0.25
    const result: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'screenshot',
      content: [{ type: 'text', text: 'Here.' }, image],
      isError: false,
      timestamp: 1,
    }
    const steer = { role: 'user' as const, content: 'Faster.', timestamp: 2 }
    const secret = {
      role: 'system' as const,
      content: 'Secret rules.',
      timestamp: 3,
    }
    const events: Array<AgentEvent> = [
      { type: 'agent_start' },
      { type: 'turn_start' },
      {
        type: 'message_start',
        message: { role: 'user', content: 'Go', timestamp: 0 },
      },
      {
        type: 'message_end',
        message: { role: 'user', content: 'Go', timestamp: 0 },
      },
      { type: 'message_start', message: assistant },
      {
        type: 'message_update',
        message: assistant,
        assistantMessageEvent: {
          type: 'thinking_start',
          contentIndex: 0,
          partial: assistant,
        },
      },
      {
        type: 'message_update',
        message: assistant,
        assistantMessageEvent: {
          type: 'thinking_end',
          contentIndex: 0,
          content: '',
          partial: assistant,
        },
      },
      { type: 'message_end', message: assistant },
      {
        type: 'tool_execution_update',
        toolCallId: 'c1',
        toolName: 'screenshot',
        args: {},
        partialResult: { percent: 50 },
      },
      { type: 'message_start', message: result },
      { type: 'message_end', message: result },
      { type: 'message_start', message: steer },
      { type: 'message_end', message: steer },
      { type: 'message_end', message: secret },
      { type: 'turn_end', message: assistant, toolResults: [result] },
      { type: 'agent_end', messages: [assistant, result, steer] },
    ]

    const out = await collect(
      fromPiAgentEvents(list(events), { threadId: 't', runId: 'r' }),
    )
    for (const event of out) EventSchemas.parse(event)

    expect(
      out.find((e) => e.type === EventType.REASONING_MESSAGE_START),
    ).toMatchObject({
      messageId: expect.stringMatching(/^redacted_thinking-/),
    })
    expect(out.filter((e) => e.type === EventType.CUSTOM)).toMatchObject([
      {
        name: 'pi.tool-progress',
        value: { toolCallId: 'c1', partialResult: { percent: 50 } },
      },
      { name: 'pi.message', value: { role: 'user', content: 'Faster.' } },
    ])
    expect(
      out.find((e) => e.type === EventType.TOOL_CALL_RESULT),
    ).toMatchObject({
      content: JSON.stringify([
        { type: 'text', content: 'Here.' },
        {
          type: 'image',
          source: { type: 'data', value: 'aGk=', mimeType: 'image/png' },
        },
      ]),
    })
    expect(out.find((e) => e.type === EventType.RUN_FINISHED)).toMatchObject({
      finishReason: 'tool_calls',
      metadata: { tanstack: { usage: { cost: 0.25 } } },
    })
    // The prompt is not sent back, and pi system messages stay on the server.
    expect(JSON.stringify(out)).not.toContain('"Go"')
    expect(JSON.stringify(out)).not.toContain('Secret rules.')
  })
})

/** A text adapter that plays one list of events per model call. */
function scriptedAdapter(steps: Array<Array<StreamChunk>>): AnyTextAdapter {
  let calls = 0
  return {
    kind: 'text',
    name: 'scripted',
    model: 'scripted-1',
    '~types': {
      providerOptions: {},
      inputModalities: ['text'],
      messageMetadataByModality: {},
      toolCapabilities: [],
      toolCallMetadata: undefined,
      systemPromptMetadata: undefined,
    },
    async *chatStream(options) {
      const step = steps[calls++]
      if (!step) throw new Error('No more steps')
      yield {
        type: EventType.RUN_STARTED,
        runId: options.runId ?? 'run',
        threadId: options.threadId ?? 't',
      }
      yield* step
    },
    structuredOutput: () => Promise.resolve({ data: {}, rawText: '{}' }),
  }
}

describe('TanStack to pi client', () => {
  it('sends state, activity and custom events as tanstack-event messages, with cost and redacted reasoning', async () => {
    const events: Array<StreamChunk> = [
      { type: EventType.RUN_STARTED, threadId: 't', runId: 'r' },
      { type: EventType.STATE_SNAPSHOT, snapshot: { step: 1 } },
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: 'a1',
        activityType: 'search',
        content: { hits: 3 },
      },
      { type: EventType.CUSTOM, name: 'progress', value: { step: 1 } },
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: 'redacted_thinking-1',
        role: 'reasoning',
      },
      {
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: 'message',
        entityId: 'redacted_thinking-1',
        encryptedValue: 'opaque',
      },
      {
        type: EventType.REASONING_MESSAGE_END,
        messageId: 'redacted_thinking-1',
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: 't',
        runId: 'r',
        finishReason: 'stop',
        usage: {
          promptTokens: 1,
          completionTokens: 2,
          totalTokens: 3,
          cost: 0.5,
        },
      },
    ]
    const out = await collect(toPiAgentEvents(list(events)))

    const custom = out.flatMap((e) =>
      e.type === 'message_end' &&
      'role' in e.message &&
      e.message.role === 'tanstack-event'
        ? [e.message.event.type]
        : [],
    )
    expect(custom).toEqual([
      EventType.STATE_SNAPSHOT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.CUSTOM,
    ])
    const end = out.at(-1)
    if (end?.type !== 'agent_end') throw new Error('No agent_end')
    expect(end.messages).toMatchObject([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinkingSignature: 'opaque', redacted: true },
        ],
        usage: { totalTokens: 3, cost: { total: 0.5 } },
      },
    ])
  })

  it('sends a multimodal tool result to pi as text and image content', async () => {
    const shot = toolDefinition({
      name: 'screenshot',
      description: 'Take a screenshot',
      inputSchema: z.object({}),
    }).server(() => [
      { type: 'text' as const, content: 'Here.' },
      {
        type: 'image' as const,
        source: { type: 'data' as const, value: 'aGk=', mimeType: 'image/png' },
      },
    ])
    const adapter = scriptedAdapter([
      [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: 'c1',
          toolCallName: 'screenshot',
          parentMessageId: 'm1',
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: 'c1', delta: '{}' },
        { type: EventType.TOOL_CALL_END, toolCallId: 'c1', input: {} },
        {
          type: EventType.RUN_FINISHED,
          threadId: 't',
          runId: 'r',
          finishReason: 'tool_calls',
        },
      ],
      [
        {
          type: EventType.RUN_FINISHED,
          threadId: 't',
          runId: 'r',
          finishReason: 'stop',
        },
      ],
    ])
    const out: Array<PiBridgeEvent> = await collect(
      toPiAgentEvents(
        chat({
          adapter,
          threadId: 't',
          messages: [{ role: 'user', content: 'Show me' }],
          tools: [shot],
        }),
      ),
    )
    const execution = out.find((e) => e.type === 'tool_execution_end')
    expect(execution).toMatchObject({
      result: { content: [{ type: 'text', text: 'Here.' }, image] },
    })
  })

  it('runs a client tool of the pi client, and chat() reads its result from the history', async () => {
    const adapter = scriptedAdapter([
      [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: 'loc-1',
          toolCallName: 'getLocation',
          parentMessageId: 'm1',
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: 'loc-1', delta: '{}' },
        { type: EventType.TOOL_CALL_END, toolCallId: 'loc-1', input: {} },
        {
          type: EventType.RUN_FINISHED,
          threadId: 't',
          runId: 'r',
          finishReason: 'tool_calls',
        },
      ],
      [
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: 'm2',
          role: 'assistant',
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: 'm2',
          delta: 'Sydney it is.',
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: 'm2' },
        {
          type: EventType.RUN_FINISHED,
          threadId: 't',
          runId: 'r',
          finishReason: 'stop',
        },
      ],
    ])
    const tools = [
      {
        name: 'getLocation',
        description: 'Get the location of the user',
        parameters: { type: 'object', properties: {} },
      },
    ]
    const user = { role: 'user' as const, content: 'Where am I?', timestamp: 1 }

    const first = await collect(
      toPiAgentEvents(
        chat({
          adapter,
          ...chatParamsFromPiRequestBody({
            threadId: 't',
            messages: [user],
            tools,
          }),
        }),
      ),
    )
    const end = first.at(-1)
    if (end?.type !== 'agent_end') throw new Error('No agent_end')
    expect(end.messages).toMatchObject([
      {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'loc-1', name: 'getLocation' }],
      },
    ])
    // A tanstack-interrupt names the client tool call. It is no approval.
    const paused = first.flatMap((e) =>
      e.type === 'message_end' &&
      'role' in e.message &&
      e.message.role === 'tanstack-interrupt'
        ? e.message.interrupts
        : [],
    )
    expect(paused).toMatchObject([
      { toolCallId: 'loc-1', metadata: { kind: 'client_tool' } },
    ])
    expect(
      paused.filter((interrupt) => interrupt.metadata?.kind === 'approval'),
    ).toEqual([])

    // The pi client runs the tool and posts the result in the history.
    const result: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: 'loc-1',
      toolName: 'getLocation',
      content: [{ type: 'text', text: 'Sydney' }],
      isError: false,
      timestamp: 2,
    }
    const second = await collect(
      toPiAgentEvents(
        chat({
          adapter,
          ...chatParamsFromPiRequestBody({
            threadId: 't',
            messages: [user, ...end.messages, result],
            tools,
          }),
        }),
      ),
    )
    const text = second.flatMap((e) =>
      e.type === 'message_update' &&
      e.assistantMessageEvent.type === 'text_delta'
        ? [e.assistantMessageEvent.delta]
        : [],
    )
    expect(text.join('')).toBe('Sydney it is.')
  })

  it('round-trips images in tool results through the history', () => {
    const history = fromPiMessages([
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'c1', name: 'screenshot', arguments: {} },
        ],
        api: '',
        provider: '',
        model: '',
        usage: emptyUsage(),
        stopReason: 'toolUse',
        timestamp: 1,
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'screenshot',
        content: [{ type: 'text', text: 'Here.' }, image],
        isError: false,
        timestamp: 1,
      },
    ])
    expect(history.messages[1]).toMatchObject({
      role: 'tool',
      content: [{ type: 'text', content: 'Here.' }, { type: 'image' }],
    })
    expect(toPiMessages(history.messages)[1]).toMatchObject({
      role: 'toolResult',
      toolName: 'screenshot',
      content: [{ type: 'text', text: 'Here.' }, image],
    })
    // pi cannot hold a URL image, so the model reads the parts as JSON text.
    const [, withUrl] = toPiMessages([
      ...history.messages.slice(0, 1),
      {
        role: 'tool',
        toolCallId: 'c1',
        content: [
          {
            type: 'image',
            source: { type: 'url', value: 'https://example.com/a.png' },
          },
        ],
      },
    ])
    expect(JSON.stringify(withUrl)).toContain('https://example.com/a.png')
  })

  it('rejects a broken history', () => {
    const call = (args: string) => ({
      role: 'assistant' as const,
      content: null,
      toolCalls: [
        {
          id: 'c1',
          type: 'function' as const,
          function: { name: 'screenshot', arguments: args },
        },
      ],
    })
    expect(() => toPiMessages([call('{not json')])).toThrow()
    expect(() => toPiMessages([call('[1]')])).toThrow(/JSON object/)
    expect(toPiMessages([call('')])[0]).toMatchObject({
      content: [{ type: 'toolCall', arguments: {} }],
    })
    expect(() =>
      toPiMessages([{ role: 'tool', toolCallId: 'c9', content: 'x' }]),
    ).toThrow(/no tool call/)
    expect(() =>
      toPiMessages([
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'url', value: 'https://example.com/a.png' },
            },
          ],
        },
      ]),
    ).toThrow(/base64 images only/)
  })

  it('keeps the order of thinking, tool calls and text both ways', () => {
    const assistant: AssistantMessage = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'first', thinkingSignature: 's1' },
        { type: 'toolCall', id: 'c1', name: 'look', arguments: {} },
        { type: 'thinking', thinking: 'second', thinkingSignature: 's2' },
        { type: 'text', text: 'Done.' },
      ],
      api: '',
      provider: '',
      model: '',
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp: 1,
    }
    const { messages } = fromPiMessages([assistant])
    expect(messages[0]?.blockOrder).toEqual([
      { type: 'thinking', index: 0 },
      { type: 'tool-call', id: 'c1' },
      { type: 'thinking', index: 1 },
      { type: 'text', length: 5 },
    ])
    expect(toPiMessages(messages)[0]).toMatchObject({
      content: assistant.content,
    })
  })

  it('reads the replay of a paused call as the answer to the history, not a new message', async () => {
    const out = await collect(
      toPiAgentEvents(
        list<StreamChunk>([
          // chat() replays the paused call, then the model answers.
          {
            type: EventType.TOOL_CALL_START,
            toolCallId: 'c1',
            toolCallName: 'look',
          },
          { type: EventType.TOOL_CALL_ARGS, toolCallId: 'c1', delta: '{}' },
          { type: EventType.TOOL_CALL_END, toolCallId: 'c1' },
          {
            type: EventType.TOOL_CALL_RESULT,
            messageId: 'm0',
            toolCallId: 'c1',
            content: 'seen',
          },
          { type: EventType.RUN_STARTED, threadId: 't', runId: 'r' },
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId: 'm1',
            role: 'assistant',
          },
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: 'm1',
            delta: 'Hi',
          },
          { type: EventType.TEXT_MESSAGE_END, messageId: 'm1' },
          {
            type: EventType.RUN_FINISHED,
            threadId: 't',
            runId: 'r',
            finishReason: 'stop',
          },
        ]),
        {
          messages: [
            { role: 'user', content: 'Look' },
            {
              role: 'assistant',
              content: null,
              toolCalls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'look', arguments: '{}' },
                },
              ],
            },
          ],
        },
      ),
    )
    const end = out.at(-1)
    if (end?.type !== 'agent_end') throw new Error('No agent_end')
    expect(end.messages).toMatchObject([
      { role: 'toolResult', toolCallId: 'c1', toolName: 'look' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    ])
    // Without the history, the result has no tool call to answer.
    await expect(
      collect(
        toPiAgentEvents(
          list<StreamChunk>([
            {
              type: EventType.TOOL_CALL_RESULT,
              messageId: 'm0',
              toolCallId: 'c1',
              content: 'seen',
            },
          ]),
        ),
      ),
    ).rejects.toThrow(/Pass the chat\(\) messages/)
  })

  it('keeps the stream going when the streamed tool arguments are not JSON', async () => {
    const out = await collect(
      toPiAgentEvents(
        list<StreamChunk>([
          { type: EventType.RUN_STARTED, threadId: 't', runId: 'r' },
          {
            type: EventType.TOOL_CALL_START,
            toolCallId: 'c1',
            toolCallName: 'look',
          },
          { type: EventType.TOOL_CALL_ARGS, toolCallId: 'c1', delta: '{bad' },
          { type: EventType.TOOL_CALL_END, toolCallId: 'c1' },
          {
            type: EventType.RUN_FINISHED,
            threadId: 't',
            runId: 'r',
            metadata: { tanstack: { finishReason: 'length' } },
          },
        ]),
      ),
    )
    const end = out.at(-1)
    if (end?.type !== 'agent_end') throw new Error('No agent_end')
    expect(end.messages).toMatchObject([
      {
        role: 'assistant',
        stopReason: 'length',
        content: [{ type: 'toolCall', id: 'c1', arguments: {} }],
      },
    ])
  })
})

describe('pi client request', () => {
  const user = { role: 'user', content: 'Hi', timestamp: 1 }

  it('keeps the tanstack messages and rejects other roles', () => {
    expect(
      chatParamsFromPiRequestBody({
        threadId: 't',
        messages: [
          user,
          {
            role: 'tanstack-interrupt',
            runId: 'r1',
            interrupts: [],
            timestamp: 1,
          },
        ],
        resume: [{ interruptId: 'a', status: 'resolved', payload: true }],
      }),
    ).toMatchObject({ messages: [{ role: 'user' }], parentRunId: 'r1' })
    // A TanStack tool message is not a pi message, so it is not dropped.
    expect(() =>
      chatParamsFromPiRequestBody({
        threadId: 't',
        messages: [user, { role: 'tool', toolCallId: 'c1', content: 'x' }],
      }),
    ).toThrow(/pi `messages`/)
  })

  it.each([
    ['tools', { tools: [{ name: 'x' }] }],
    ['resume', { resume: [{ interruptId: 'a', status: 'done' }] }],
    ['parentRunId', { parentRunId: 1 }],
    [
      'a tool result without isError',
      {
        messages: [
          user,
          { role: 'toolResult', toolCallId: 'c1', content: [], timestamp: 1 },
        ],
      },
    ],
    [
      'tool call arguments that are not an object',
      {
        messages: [
          user,
          {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'c1', name: 'x', arguments: [1] },
            ],
          },
        ],
      },
    ],
  ])('rejects bad %s', (_, extra) => {
    expect(() =>
      chatParamsFromPiRequestBody({
        threadId: 't',
        messages: [user],
        ...extra,
      }),
    ).toThrow()
  })

  it('answers a bad body with a 400 and keeps the details on cause', async () => {
    const failure: unknown = await chatParamsFromPiRequest(
      new Request('http://test/api/chat', {
        method: 'POST',
        body: JSON.stringify({ threadId: 't' }),
      }),
    ).catch((error: unknown) => error)
    if (!(failure instanceof Response)) throw new Error('Expected a Response')
    expect(failure.status).toBe(400)
    expect(await failure.text()).toBe('Invalid pi chat request body.')
    expect(failure).toMatchObject({ cause: expect.any(Error) })
  })
})
