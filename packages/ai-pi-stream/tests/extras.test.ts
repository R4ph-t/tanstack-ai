import { describe, expect, it } from 'vitest'
import { EventSchemas } from '@ag-ui/core/schemas'
import { EventType } from '@tanstack/ai'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { fromPiAgentEvents, toPiMessages } from '../src'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai'
import type { ModelMessage } from '@tanstack/ai'
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

describe('toPiMessages', () => {
  const screenshot: ModelMessage = {
    role: 'assistant',
    content: null,
    toolCalls: [
      {
        id: 'c1',
        type: 'function',
        function: { name: 'screenshot', arguments: '{}' },
      },
    ],
  }

  it('sends images in tool results to pi as image content', () => {
    const [, result] = toPiMessages([
      screenshot,
      {
        role: 'tool',
        toolCallId: 'c1',
        content: [
          { type: 'text', content: 'Here.' },
          {
            type: 'image',
            source: { type: 'data', value: 'aGk=', mimeType: 'image/png' },
          },
        ],
      },
    ])
    expect(result).toMatchObject({
      role: 'toolResult',
      toolName: 'screenshot',
      content: [{ type: 'text', text: 'Here.' }, image],
    })
    // pi cannot hold a URL image, so the model reads the parts as JSON text.
    const [, withUrl] = toPiMessages([
      screenshot,
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

  it('keeps the order of thinking, tool calls and text', () => {
    const [message] = toPiMessages([
      {
        role: 'assistant',
        content: 'Done.',
        thinking: [
          { content: 'first', signature: 's1' },
          { content: 'second', signature: 's2' },
        ],
        toolCalls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'look', arguments: '{}' },
          },
        ],
        blockOrder: [
          { type: 'thinking', index: 0 },
          { type: 'tool-call', id: 'c1' },
          { type: 'thinking', index: 1 },
          { type: 'text', length: 5 },
        ],
      },
    ])
    expect(message).toMatchObject({
      content: [
        { type: 'thinking', thinking: 'first', thinkingSignature: 's1' },
        { type: 'toolCall', id: 'c1', name: 'look', arguments: {} },
        { type: 'thinking', thinking: 'second', thinkingSignature: 's2' },
        { type: 'text', text: 'Done.' },
      ],
    })
  })
})
