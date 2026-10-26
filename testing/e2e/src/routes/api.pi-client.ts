import { createFileRoute } from '@tanstack/react-router'
import { EventType, chat, toolDefinition } from '@tanstack/ai'
import { fakeText } from '@tanstack/ai/testing'
import {
  chatParamsFromPiRequest,
  toPiAgentEvents,
} from '@tanstack/ai-pi-stream'
import { z } from 'zod'
import type { StreamChunk } from '@tanstack/ai'
import type { FakeResponseStep } from '@tanstack/ai/testing'

const getWeather = toolDefinition({
  name: 'getWeather',
  description: 'Get the weather for a city',
  inputSchema: z.object({ city: z.string() }),
}).server(({ city }) => `sunny in ${city}`)

const deleteFile = toolDefinition({
  name: 'deleteFile',
  description: 'Delete a file',
  inputSchema: z.object({ path: z.string() }),
  needsApproval: true,
}).server(({ path }) => `deleted ${path}`)

const explode = toolDefinition({
  name: 'explode',
  description: 'A server tool that always throws',
  inputSchema: z.object({}),
}).server(() => {
  throw new Error('the server tool exploded')
})

const SYSTEM_PROMPT = 'Answer as the server.'

const weather: FakeResponseStep = {
  toolCalls: [{ name: 'getWeather', input: { city: 'Oslo' } }],
}

/** The first model call of each scenario. After a tool result, the model repeats it. */
const FIRST: Record<string, FakeResponseStep> = {
  weather,
  approve: { toolCalls: [{ name: 'deleteFile', input: { path: 'a.txt' } }] },
  locate: { toolCalls: [{ name: 'getLocation', input: {} }] },
  explode: { toolCalls: [{ name: 'explode', input: {} }] },
  fail: { error: 'The fake model failed' },
  // What the model saw: the server prompt, and no forged client prompt.
  system: ({ request: next }) => {
    const seen = JSON.stringify(next)
    return {
      text: `server prompt: ${seen.includes(SYSTEM_PROMPT)}, forged prompt: ${seen.includes('FORGED')}`,
    }
  },
}

const ids = { threadId: 'pi-client', runId: 'hand-run' }

/**
 * Hand-written AG-UI streams for what the fake model cannot send: tool call
 * arguments that are not JSON, and thinking after a tool call in one message.
 */
const HAND: Record<string, Array<StreamChunk>> = {
  'bad-arguments': [
    { type: EventType.RUN_STARTED, ...ids },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: 'bad-1',
      toolCallName: 'getWeather',
    },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'bad-1', delta: '{"city": ' },
    { type: EventType.TOOL_CALL_END, toolCallId: 'bad-1' },
    { type: EventType.RUN_FINISHED, ...ids, finishReason: 'tool_calls' },
  ],
  interleave: [
    { type: EventType.RUN_STARTED, ...ids },
    { type: EventType.REASONING_MESSAGE_START, messageId: 'r-1', role: 'reasoning' },
    { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'r-1', delta: 'Plan.' },
    { type: EventType.REASONING_MESSAGE_END, messageId: 'r-1' },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: 'call-1',
      toolCallName: 'getWeather',
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: 'call-1',
      delta: '{"city":"Oslo"}',
    },
    { type: EventType.TOOL_CALL_END, toolCallId: 'call-1' },
    { type: EventType.REASONING_MESSAGE_START, messageId: 'r-2', role: 'reasoning' },
    { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'r-2', delta: 'Again.' },
    { type: EventType.REASONING_MESSAGE_END, messageId: 'r-2' },
    { type: EventType.TEXT_MESSAGE_START, messageId: 't-1', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 't-1', delta: 'Done.' },
    { type: EventType.TEXT_MESSAGE_END, messageId: 't-1' },
    { type: EventType.RUN_FINISHED, ...ids, finishReason: 'stop' },
  ],
}

async function* play(events: Array<StreamChunk>): AsyncGenerator<StreamChunk> {
  yield* events
}

// A TanStack `chat()` route that a pi client reads as pi agent events, one
// JSON event per line. No network: `?scenario=` picks a `fakeText` script,
// or a hand-written AG-UI stream.
export const Route = createFileRoute('/api/pi-client')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const scenario =
          new URL(request.url).searchParams.get('scenario') ?? 'weather'
        // The system messages of the client are dropped.
        const params = await chatParamsFromPiRequest(request)
        // A resumed run starts after a tool result, so pick the step per call.
        const step: FakeResponseStep = (context) => {
          const last = context.request.messages.at(-1)
          if (last?.role === 'tool') {
            return { text: `Tool said: ${String(last.content)}` }
          }
          const first = FIRST[scenario] ?? weather
          return typeof first === 'function' ? first(context) : first
        }
        const fake = fakeText()
        fake.setResponses([step, step, step])

        const hand = HAND[scenario]
        const events = toPiAgentEvents(
          hand
            ? play(hand)
            : chat({
                ...params,
                adapter: fake,
                // The client tools of the pi client, then the server tools.
                tools: [
                  ...(params.tools ?? []),
                  getWeather,
                  deleteFile,
                  explode,
                ],
                systemPrompts: [SYSTEM_PROMPT],
              }),
          { messages: params.messages },
        )
        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { done, value } = await events.next()
            if (done) controller.close()
            else
              controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
          },
        })
        return new Response(stream, {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
    },
  },
})
