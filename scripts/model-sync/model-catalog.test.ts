import { describe, expect, it } from 'vitest'
import {
  buildRecords,
  inputModalities,
  isChatModel,
  pricesFrom,
  reasoningFrom,
} from './model-catalog'
import type { RateCard } from '@modelschemas/client'
import type { SchemaModel } from './model-catalog'

const row = (fields: Partial<SchemaModel> = {}): SchemaModel => ({
  provider: 'p',
  rawId: 'm',
  displayName: null,
  activity: 'chat',
  deprecatedAt: null,
  aliases: null,
  contextWindow: null,
  maxOutput: null,
  modalities: { input: ['text'], output: ['text'] },
  capabilities: null,
  reasoning: null,
  requestMap: null,
  pricing: null,
  ...fields,
})

const card = (price: unknown, tables: RateCard['tables'] = {}): RateCard => ({
  inputs: {},
  tables,
  price,
  examples: [],
  source: { url: 'https://example.com', hash: '', extractedAt: '' },
})

const rate = (name: string) => ({
  if: [
    { '>': [{ var: name }, 0] },
    {
      '*': [{ var: name }, { lookup: { table: 'rate', keys: ['base', name] } }],
    },
    0,
  ],
})

describe('reasoningFrom', () => {
  it('is false for a model that does not reason', () => {
    expect(reasoningFrom(row())).toBe(false)
  })

  it("takes the source's level map when it has one", () => {
    expect(
      reasoningFrom(
        row({
          reasoning: {
            mode: 'effort',
            mandatory: true,
            efforts: ['instant', 'low', 'high'],
          },
          requestMap: {
            thinking: {
              on: {},
              off: null,
              levels: {
                off: null,
                minimal: null,
                low: 'low',
                medium: null,
                high: 'high',
                xhigh: null,
                max: null,
              },
            },
          },
        }),
      ),
    ).toEqual({ levels: { low: 'low', high: 'high' }, budget: false })
  })

  it('maps efforts to levels, none to off, and skips default', () => {
    expect(
      reasoningFrom(
        row({
          reasoning: {
            mode: 'effort',
            mandatory: false,
            efforts: ['none', 'default', 'HIGH'],
          },
        }),
      ),
    ).toEqual({ levels: { off: 'none', high: 'HIGH' }, budget: false })
  })

  it('throws on an effort it does not know', () => {
    expect(() =>
      reasoningFrom(
        row({
          reasoning: { mode: 'effort', mandatory: null, efforts: ['ultra'] },
        }),
      ),
    ).toThrow("unknown reasoning effort 'ultra'")
  })

  it('invents no levels for a budget model', () => {
    expect(
      reasoningFrom(row({ reasoning: { mode: 'budget', mandatory: false } })),
    ).toEqual({
      levels: {},
      budget: true,
    })
  })
})

describe('pricesFrom', () => {
  it('has no prices when the row has no price card', () => {
    expect(pricesFrom(row())).toBeUndefined()
  })

  it('reads each rate the card prices, and leaves the others undefined', () => {
    const prices = pricesFrom(
      row({
        pricing: card(
          {
            currency: [
              'CNY',
              {
                '+': ['input_tokens', 'output_tokens'].map((name) => ({
                  '*': [
                    { var: name },
                    {
                      lookup: {
                        table: 'rate',
                        keys: [
                          {
                            if: [
                              { '>': [{ var: 'input_tokens' }, 200000] },
                              '200000',
                              'base',
                            ],
                          },
                          name,
                        ],
                      },
                    },
                  ],
                })),
              },
            ],
          },
          {
            rate: {
              base: { input_tokens: 3e-6, output_tokens: 15e-6 },
              '200000': { input_tokens: 6e-6, output_tokens: 22.5e-6 },
            },
          },
        ),
      }),
    )
    expect(prices).toEqual({
      currency: 'CNY',
      input: 3,
      output: 15,
      tiers: [{ inputTokensAbove: 200000, input: 6, output: 22.5 }],
    })
  })

  it('throws on a price operator it does not know', () => {
    expect(() => pricesFrom(row({ pricing: card({ max: [1, 2] }) }))).toThrow(
      "Unknown price operator 'max'",
    )
  })

  it('throws on a price summary, which has no rate card', () => {
    expect(() =>
      pricesFrom(
        row({ pricing: { currency: 'USD', per: 'token', inputPerMillion: 3 } }),
      ),
    ).toThrow('a price summary, not a rate card')
  })

  it('prices the 1-hour cache write with its own rate', () => {
    expect(
      pricesFrom(
        row({
          pricing: card(
            {
              '+': [rate('cache_write_tokens'), rate('cache_write_1h_tokens')],
            },
            {
              rate: {
                base: {
                  cache_write_tokens: 3.75e-6,
                  cache_write_1h_tokens: 6e-6,
                },
              },
            },
          ),
        }),
      ),
    ).toEqual({ currency: 'USD', cacheWrite: 3.75, cacheWrite1h: 6 })
  })
})

describe('rows', () => {
  it('keeps current chat models that write text', () => {
    expect(isChatModel(row())).toBe(true)
    expect(isChatModel(row({ activity: 'embeddings' }))).toBe(false)
    expect(isChatModel(row({ deprecatedAt: 1 }))).toBe(false)
    expect(
      isChatModel(row({ modalities: { input: ['text'], output: ['image'] } })),
    ).toBe(false)
  })

  it('maps input kinds, and throws on an unknown one', () => {
    expect(
      inputModalities(row({ modalities: { input: ['text', 'pdf', 'file'] } })),
    ).toEqual(['text', 'document'])
    expect(inputModalities(row({ modalities: null }))).toBeUndefined()
    expect(() =>
      inputModalities(row({ modalities: { input: ['smell'] } })),
    ).toThrow("unknown input modality 'smell'")
  })

  it('gives an alias its own record, and throws on a repeated id', () => {
    expect(
      buildRecords([row({ rawId: 'b', aliases: ['a'] })]).map((r) => r.id),
    ).toEqual(['a', 'b'])
    expect(() => buildRecords([row(), row()])).toThrow(
      "Two rows have the id 'm'",
    )
  })
})
