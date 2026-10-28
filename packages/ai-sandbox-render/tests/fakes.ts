/**
 * A fake slice of the Render SDK's `SandboxesClient`. `exec` runs the command
 * in a local `bash` as its own process-group leader, as Render's exec shell is
 * (measured), so the handle's real wrapper and group kill are exercised. An
 * aborted stream only detaches, as on Render: the process keeps running.
 */
import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { vi } from 'vitest'
import type { SandboxExecEvent, SandboxesClient } from '@renderinc/sdk'

async function* localExec(
  command: string,
  signal?: AbortSignal,
): AsyncGenerator<SandboxExecEvent> {
  const child = spawn('bash', ['-c', command], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const queue: Array<SandboxExecEvent> = []
  let wake = (): void => {}
  const push = (event: SandboxExecEvent): void => {
    queue.push(event)
    wake()
  }
  child.stdout.on('data', (d) =>
    push({ type: 'output', stream: 'stdout', data: String(d) }),
  )
  child.stderr.on('data', (d) =>
    push({ type: 'output', stream: 'stderr', data: String(d) }),
  )
  child.on('close', (code, sig) =>
    push({
      type: 'exit',
      exit_code: code ?? 128 + (sig ? constants.signals[sig] : 0),
    }),
  )
  for (;;) {
    if (signal?.aborted) throw new Error('AbortError')
    const event = queue.shift()
    if (event === undefined) {
      await new Promise<void>((resolve) => {
        wake = resolve
        signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      continue
    }
    yield event
    if (event.type === 'exit') return
  }
}

export function fakeClient(files = new Map<string, Uint8Array>()): {
  /** The fake's `vi.fn` mocks, for driving and asserting. */
  client: Record<string, any>
  sdk: SandboxesClient
  files: Map<string, Uint8Array>
} {
  const client = {
    exec: vi.fn(
      (_id: string, command: string, _owner?: string, signal?: AbortSignal) =>
        Promise.resolve(localExec(command, signal)),
    ),
    upload: vi.fn((_id: string, path: string, data: string | Uint8Array) => {
      files.set(path, typeof data === 'string' ? Buffer.from(data) : data)
      return Promise.resolve()
    }),
    download: vi.fn((_id: string, path: string) => {
      const data = files.get(path)
      if (data === undefined) return Promise.reject(new Error('not found'))
      return Promise.resolve({
        data: Buffer.from(data),
        size: data.byteLength,
        contentType: path.endsWith('/')
          ? 'application/x-tar'
          : 'application/octet-stream',
      })
    }),
    terminate: vi.fn(() => Promise.resolve()),
    get: vi.fn(),
    create: vi.fn(),
    waitUntilRunning: vi.fn(() => Promise.resolve()),
    snapshots: {
      create: vi.fn(() => Promise.resolve({ id: 'snp-1' })),
    },
  }
  return { client, sdk: client as unknown as SandboxesClient, files }
}
