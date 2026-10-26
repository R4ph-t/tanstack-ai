import { createFileRoute } from '@tanstack/react-router'
import {
  Type,
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai'
import { chatParamsFromRequest, toServerSentEventsResponse } from '@tanstack/ai'
import { runPiAgent } from '@tanstack/ai-pi-stream'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { TranscriptContext } from '@earendil-works/pi-ai'

const cityParams = Type.Object({ city: Type.String() })
const pathParams = Type.Object({ path: Type.String() })

const getWeather: AgentTool<typeof cityParams> = {
  name: 'getWeather',
  label: 'Weather',
  description: 'Get the weather for a city',
  parameters: cityParams,
  execute: (_id, { city }) =>
    Promise.resolve({
      content: [{ type: 'text', text: `sunny in ${city}` }],
      details: undefined,
    }),
}

const deleteFile: AgentTool<typeof pathParams> = {
  name: 'deleteFile',
  label: 'Delete',
  description: 'Delete a file',
  parameters: pathParams,
  execute: (_id, { path }) =>
    Promise.resolve({
      content: [{ type: 'text', text: `deleted ${path}` }],
      details: undefined,
    }),
}

const explode: AgentTool<typeof pathParams> = {
  name: 'explode',
  label: 'Explode',
  description: 'A server tool that always throws',
  parameters: pathParams,
  execute: () => {
    throw new Error('the server tool exploded')
  },
}

const SYSTEM_PROMPT = 'Answer as the server.'

/** The first word of the first user message picks the scenario. */
function scenarioOf(context: TranscriptContext): string {
  const user = context.messages.find((message) => message.role === 'user')
  const text =
    typeof user?.content === 'string'
      ? user.content
      : (user?.content.find((block) => block.type === 'text')?.text ?? '')
  return text.split(' ')[0]?.toLowerCase() ?? ''
}

/** The tool results after the last assistant message. */
function lastResults(context: TranscriptContext): Array<string> {
  const results: Array<string> = []
  for (const message of [...context.messages].reverse()) {
    if (message.role === 'assistant') break
    if (message.role !== 'toolResult') continue
    const first = message.content[0]
    results.unshift(first?.type === 'text' ? first.text : '')
  }
  return results
}

// One answer per model call. With tool results, the model repeats them.
// Otherwise the first word of the prompt picks the scenario.
function answer(context: TranscriptContext) {
  const results = lastResults(context)
  const scenario = scenarioOf(context)
  if (results.length > 0) {
    const text = `Tool said: ${results.join(', ')}`
    return scenario === 'think'
      ? fauxAssistantMessage([fauxThinking('Now answer.'), fauxText(text)])
      : fauxAssistantMessage(text)
  }
  const call = (name: string, args: Record<string, string>, id = 'call-1') =>
    fauxToolCall(name, args, { id })
  const toolUse = { stopReason: 'toolUse' as const }
  switch (scenario) {
    case 'delete':
      return fauxAssistantMessage(
        call('deleteFile', { path: 'a.txt' }),
        toolUse,
      )
    case 'both':
      return fauxAssistantMessage(
        [
          call('deleteFile', { path: 'a.txt' }),
          call('getWeather', { city: 'Oslo' }, 'call-2'),
        ],
        toolUse,
      )
    case 'locate':
      return fauxAssistantMessage(call('getLocation', {}), toolUse)
    case 'explode':
      return fauxAssistantMessage(call('explode', { path: 'a.txt' }), toolUse)
    case 'think':
      return fauxAssistantMessage(
        [
          fauxThinking('Check the weather.'),
          call('getWeather', { city: 'Oslo' }),
        ],
        toolUse,
      )
    case 'fail':
      return fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'The faux model failed',
      })
    case 'system': {
      // What the model saw: the server prompt, and no forged client prompt.
      const seen = JSON.stringify(context)
      return fauxAssistantMessage(
        `server prompt: ${seen.includes(SYSTEM_PROMPT)}, forged prompt: ${seen.includes('FORGED')}`,
      )
    }
    default:
      return fauxAssistantMessage(call('getWeather', { city: 'Oslo' }), toolUse)
  }
}

// A pi agent that TanStack `useChat` reads. No network: pi's faux model plays
// the scenario that the first word of the prompt names (see `answer`).
export const Route = createFileRoute('/api/pi-agent')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const params = await chatParamsFromRequest(request)
        const faux = createFauxCore({})
        faux.setResponses([answer, answer, answer])

        return toServerSentEventsResponse(
          runPiAgent(params, {
            config: {
              model: faux.getModel(),
              convertToLlm: (piMessages) => piMessages,
            },
            streamFn: (model, context, options) =>
              faux.streamSimple(model, context, options),
            tools: [getWeather, deleteFile, explode],
            needsApproval: ['deleteFile'],
            systemPrompts: [SYSTEM_PROMPT],
            signal: request.signal,
          }),
        )
      },
    },
  },
})
