import { spawnSync } from 'node:child_process'
import { expect, test } from '@playwright/test'

test('render create cleans up an aborted startup in the built package', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict'
        import { renderSandbox } from './packages/ai-sandbox-render/dist/esm/index.js'

        const controller = new AbortController()
        const reason = new Error('startup cancelled')
        const terminated = []
        const client = {
          create: async () => {
            controller.abort(reason)
            return { id: 'sbx-1' }
          },
          terminate: async (id) => {
            terminated.push(id)
          },
        }
        const result = renderSandbox({ client }).create({ signal: controller.signal })
        await assert.rejects(result, (error) => error === reason)
        assert.deepEqual(terminated, ['sbx-1'])
        console.log('create cancelled; sandbox terminated')
      `,
    ],
    {
      cwd: new URL('../../../', import.meta.url),
      encoding: 'utf8',
      timeout: 20_000,
    },
  )

  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('create cancelled; sandbox terminated')
})
