import { describe, expect, it } from 'vitest'
import { EventSchemas } from '@ag-ui/core/schemas'
import { agentLoop } from '@earendil-works/pi-agent-core'
import {
  Type,
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai'
import { EventType, convertMessagesToModelMessages } from '@tanstack/ai'
import { ChatClient } from '@tanstack/ai-client'
import { fromPiAgentEvents, toPiMessages } from '../src'
import type { AgentEvent, AgentTool } from '@earendil-works/pi-agent-core'
import type { Message } from '@earendil-works/pi-ai'
import type { ModelMessage } from '@tanstack/ai'

/** A pi agent loop with a faux model that calls `weather`, then answers. */
function piAgent(
  history: Array<Message>,
  weatherResult: { text: string; isError?: boolean } = { text: '{"temp":72}' },
) {
  const faux = createFauxCore({ tokenSize: { min: 100, max: 100 } })
  faux.setResponses([
    fauxAssistantMessage(
      [
        {
          type: 'thinking',
          thinking: 'Check the weather.',
          thinkingSignature: 'sig-1',
        },
        fauxText('Checking.'),
        {
          ...fauxToolCall('weather', { city: 'NYC' }, { id: 'c1' }),
          thoughtSignature: 'sig-call',
        },
      ],
      { stopReason: 'toolUse', responseId: 'resp-1' },
    ),
    fauxAssistantMessage('It is 72F.', { responseId: 'resp-2' }),
  ])
  const weather: AgentTool = {
    name: 'weather',
    label: 'Weather',
    description: 'Weather for a city',
    parameters: Type.Object({ city: Type.String() }),
    execute: () =>
      Promise.resolve({
        content: [{ type: 'text', text: weatherResult.text }],
        details: undefined,
        ...(weatherResult.isError && { isError: true }),
      }),
  }
  const prompt = history.at(-1)
  return agentLoop(
    prompt ? [prompt] : [],
    { messages: history.slice(0, -1), tools: [weather] },
    {
      model: faux.getModel(),
      convertToLlm: (messages) =>
        messages.filter((m): m is Message => 'role' in m),
    },
    undefined,
    (model, context, options) => faux.streamSimple(model, context, options),
  )
}

async function collect<T>(stream: AsyncIterable<T>): Promise<Array<T>> {
  const out: Array<T> = []
  for await (const item of stream) out.push(item)
  return out
}

describe('pi agent, TanStack client', () => {
  it('renders a pi run in useChat and sends the history back as pi messages', async () => {
    const sent: Array<Array<Message>> = []
    const client = new ChatClient({
      threadId: 'thread-1',
      connection: {
        async *connect(messages, _data, _signal, { threadId, runId }) {
          const history = toPiMessages(convertMessagesToModelMessages(messages))
          sent.push(history)
          yield* fromPiAgentEvents(piAgent(history), { threadId, runId })
        },
      },
    })

    await client.sendMessage('Weather in NYC?')

    // Each pi assistant message is one assistant message, as each model call
    // of chat() is.
    const [, first, second] = client.getMessages()
    expect(first).toMatchObject({
      role: 'assistant',
      metadata: { tanstack: { model: 'faux-1', responseId: 'resp-1' } },
      parts: [
        { type: 'thinking', content: 'Check the weather.', signature: 'sig-1' },
        { type: 'text', content: 'Checking.' },
        {
          type: 'tool-call',
          id: 'c1',
          name: 'weather',
          input: { city: 'NYC' },
          output: { temp: 72 },
          metadata: { thoughtSignature: 'sig-call' },
        },
        { type: 'tool-result', toolCallId: 'c1', content: '{"temp":72}' },
      ],
    })
    expect(second).toMatchObject({
      role: 'assistant',
      parts: [{ type: 'text', content: 'It is 72F.' }],
    })

    // The next turn sends pi the whole history, signatures included.
    await client.sendMessage('Thanks')
    const history = sent[1]!
    expect(history.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
      'user',
    ])
    expect(history[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'thinking', thinkingSignature: 'sig-1' },
        { type: 'text', text: 'Checking.' },
        {
          type: 'toolCall',
          id: 'c1',
          name: 'weather',
          arguments: { city: 'NYC' },
          thoughtSignature: 'sig-call',
        },
      ],
      stopReason: 'toolUse',
    })
    expect(history[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'weather',
      isError: false,
    })
  })

  it('ends each assistant message with a RUN_FINISHED, with usage', async () => {
    const events = await collect(
      fromPiAgentEvents(
        piAgent([{ role: 'user', content: 'Weather?', timestamp: 1 }]),
        { threadId: 't', runId: 'r' },
      ),
    )
    for (const event of events) EventSchemas.parse(event)
    const finished = events.filter((e) => e.type === EventType.RUN_FINISHED)
    expect(finished).toMatchObject([
      { finishReason: 'tool_calls', responseId: 'resp-1' },
      { finishReason: 'stop', responseId: 'resp-2' },
    ])
    expect(finished[0]).toMatchObject({
      usage: [{ provider: 'faux', model: 'faux-1' }],
    })
  })

  it('marks an error tool result and turns a failed model call into RUN_ERROR', async () => {
    const events = await collect(
      fromPiAgentEvents(
        piAgent([{ role: 'user', content: 'Weather?', timestamp: 1 }], {
          text: 'No such city',
          isError: true,
        }),
        { threadId: 't', runId: 'r' },
      ),
    )
    expect(
      events.find((e) => e.type === EventType.TOOL_CALL_RESULT),
    ).toMatchObject({
      content: 'No such city',
      metadata: { tanstack: { state: 'output-error' } },
    })

    async function* failing(): AsyncGenerator<AgentEvent> {
      yield { type: 'agent_start' }
      const message = fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'Overloaded',
      })
      yield { type: 'message_start', message }
      yield { type: 'message_end', message }
      yield { type: 'agent_end', messages: [message] }
    }
    const failed = await collect(
      fromPiAgentEvents(failing(), { threadId: 't', runId: 'r' }),
    )
    expect(failed.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ])
    expect(failed[1]).toMatchObject({ message: 'Overloaded' })
  })
})

describe('message history', () => {
  it('converts TanStack messages into pi messages', () => {
    const messages: Array<ModelMessage> = [
      {
        role: 'user',
        content: [
          { type: 'text', content: 'What is this?' },
          {
            type: 'image',
            source: { type: 'data', value: 'aGk=', mimeType: 'image/png' },
          },
        ],
      },
      {
        role: 'assistant',
        content: 'Looking.',
        thinking: [{ content: 'Hmm.', signature: 'sig' }],
        toolCalls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":"cat"}' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        content: 'Not found',
        error: 'Not found',
      },
    ]
    const pi = toPiMessages(messages, { systemPrompts: ['Be brief.'] })
    expect(pi[0]).toMatchObject({ role: 'system', content: 'Be brief.' })
    expect(pi[3]).toMatchObject({
      role: 'toolResult',
      toolName: 'lookup',
      isError: true,
    })
    expect(pi[1]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      ],
    })
    expect(pi[2]).toMatchObject({
      role: 'assistant',
      stopReason: 'toolUse',
      content: [
        { type: 'thinking', thinking: 'Hmm.', thinkingSignature: 'sig' },
        { type: 'text', text: 'Looking.' },
        { type: 'toolCall', id: 'c1', name: 'lookup', arguments: { q: 'cat' } },
      ],
    })
  })
})
