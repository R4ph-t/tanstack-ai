<div align="center">
  <picture>
    <source
      media="(prefers-color-scheme: dark)"
      srcset="https://tanstack.com/api/readme/ai.png?theme=dark"
    />
    <source
      media="(prefers-color-scheme: light)"
      srcset="https://tanstack.com/api/readme/ai.png"
    />
    <img
      src="https://tanstack.com/api/readme/ai.png"
      alt="TanStack AI"
      width="900"
    />
  </picture>
</div>

<br />

# @tanstack/ai-pi-stream

Put TanStack AI `useChat` in front of a pi agent. The pi agent runs on your server, and `useChat` renders its run in the browser.

Some pi features change shape or are dropped on the way. See the [compatibility table](https://tanstack.com/ai/latest/docs/migration/pi-compatibility).

## Installation

```bash
pnpm add @tanstack/ai-pi-stream @tanstack/ai @earendil-works/pi-agent-core @earendil-works/pi-ai
```

## Usage

```ts
import { createModels } from '@earendil-works/pi-ai'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { chatParamsFromRequest, toServerSentEventsResponse } from '@tanstack/ai'
import { runPiAgent } from '@tanstack/ai-pi-stream'

const models = createModels()
models.setProvider(anthropicProvider())

export async function POST(request: Request) {
  const model = models.getModel('anthropic', 'claude-fable-5-1')
  if (!model) throw new Error('Model not found')

  return toServerSentEventsResponse(
    runPiAgent(await chatParamsFromRequest(request), {
      config: { model, convertToLlm: (piMessages) => piMessages },
      streamFn: models.streamSimple.bind(models),
      tools: [],
      systemPrompts: ['Be helpful.'],
    }),
  )
}
```

Pass your pi `AgentTool`s in `tools`. A pi tool in `needsApproval` pauses for a `useChat` approval. The client tools of `useChat` run in the browser. The system prompts come from the server, and the request cannot set them.

## API

| Export                                           | What it does                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| `runPiAgent(params, options)`                    | A pi agent for a `useChat` request, with approvals and client tools |
| `fromPiAgentEvents(events, { threadId, runId })` | pi agent events to AG-UI events, for a hand-run `agentLoop()`       |
| `toPiMessages(messages, options)`                | TanStack message history to pi messages                             |

## Docs

- [TanStack useChat with a pi agent](https://tanstack.com/ai/latest/docs/migration/pi-agent-tanstack-client)
- [pi bridge compatibility](https://tanstack.com/ai/latest/docs/migration/pi-compatibility)
