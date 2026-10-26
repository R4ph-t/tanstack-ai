/**
 * The modelschemas client for the model sync scripts. `MODELSCHEMAS_API_KEY`
 * raises the rate limit. This file has no relative imports, so a script that
 * runs with plain `node` can import it.
 */

import { createModelschemasClient } from '@modelschemas/client'

export function createSyncClient(options?: {
  apiKey?: string
  fetch?: typeof globalThis.fetch
}): ReturnType<typeof createModelschemasClient> {
  const apiKey = options?.apiKey ?? process.env.MODELSCHEMAS_API_KEY
  return createModelschemasClient({
    baseUrl: 'https://modelschemas.com',
    ...(apiKey ? { apiKey } : {}),
    ...(options?.fetch ? { fetch: options.fetch } : {}),
  })
}
