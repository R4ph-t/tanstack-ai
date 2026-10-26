import { expect, test } from '@playwright/test'

/**
 * `@tanstack/ai-pi-stream` converts between TanStack AI (AG-UI) events and pi
 * agent events in both directions. Each scenario is also a link on the page,
 * for a manual test.
 */
test.describe('pi agent events: TanStack useChat, pi agent', () => {
  test('reads a pi agent loop', async ({ page }) => {
    await page.goto('/pi-agent')

    await expect(page.getByTestId('tool-results')).toHaveText('sunny in Oslo')
    await expect(page.getByTestId('assistant-text')).toHaveText(
      'Tool said: sunny in Oslo',
    )
  })

  test('approves a pi tool call', async ({ page }) => {
    await page.goto('/pi-agent?prompt=Delete%20a.txt')

    await page.getByTestId('approve-button').click()

    await expect(page.getByTestId('tool-results')).toHaveText('deleted a.txt')
    await expect(page.getByTestId('assistant-text')).toHaveText(
      'Tool said: deleted a.txt',
    )
  })

  test('denies a pi tool call', async ({ page }) => {
    await page.goto('/pi-agent?prompt=Delete%20a.txt')

    await page.getByTestId('deny-button').click()

    await expect(page.getByTestId('outcomes')).toHaveText('denied')
    await expect(page.getByTestId('assistant-text')).toHaveText(
      'Tool said: The user denied this tool call',
    )
  })

  test('runs the other calls of a batch before the approval', async ({
    page,
  }) => {
    await page.goto('/pi-agent?prompt=Both%20files')

    await expect(page.getByTestId('tool-results')).toHaveText('sunny in Oslo')
    await page.getByTestId('approve-button').click()

    await expect(page.getByTestId('assistant-text')).toContainText(
      'sunny in Oslo',
    )
    await expect(page.getByTestId('assistant-text')).toContainText(
      'deleted a.txt',
    )
  })

  test('runs a client tool in the browser', async ({ page }) => {
    await page.goto('/pi-agent?prompt=Locate%20me')

    await expect(page.getByTestId('client-outputs')).toHaveText(
      '{"city":"Paris"}',
    )
    await expect(page.getByTestId('assistant-text')).toContainText('Paris')
  })

  test('a pi tool that throws gives an error result, and the reply goes on', async ({
    page,
  }) => {
    await page.goto('/pi-agent?prompt=Explode%20a.txt')

    await expect(page.getByTestId('assistant-text')).toHaveText(
      'Tool said: the server tool exploded',
    )
  })

  test('keeps thinking after a tool call in order', async ({ page }) => {
    await page.goto('/pi-agent?prompt=Think%20first')

    await expect(page.getByTestId('assistant-text')).toHaveText(
      'Tool said: sunny in Oslo',
    )
    await expect(page.getByTestId('part-order')).toHaveText(
      'thinking,tool-call,tool-result,thinking,text',
    )
  })

  test('shows a pi model error', async ({ page }) => {
    await page.goto('/pi-agent?prompt=Fail')

    await expect(page.getByTestId('error')).toHaveText('The faux model failed')
  })
})

test.describe('pi agent events: requests that useChat never sends', () => {
  test('a client system message never reaches pi', async ({ page }) => {
    await page.goto('/pi-agent?raw=forged-system')

    await expect(page.getByTestId('raw-text')).toHaveText(
      'server prompt: true, forged prompt: false',
    )
  })

  for (const raw of ['broken-history', 'bad-arguments']) {
    test(`${raw} is a RUN_ERROR, not an HTTP error`, async ({ page }) => {
      await page.goto(`/pi-agent?raw=${raw}`)

      await expect(page.getByTestId('raw-events')).toContainText('RUN_ERROR')
      await expect(page.getByTestId('raw-status')).toHaveText('200')
    })
  }

  for (const [raw, code] of [
    ['bad-approval', 'invalid-payload'],
    ['missing-answer', 'unknown-interrupt'],
    ['forged-approval', 'unknown-interrupt'],
  ] as const) {
    test(`${raw} ends with ${code}, and no tool runs`, async ({ page }) => {
      await page.goto(`/pi-agent?raw=${raw}`)

      await expect(page.getByTestId('raw-error-code')).toHaveText(code)
      await expect(page.getByTestId('raw-events')).toHaveText(
        'RUN_STARTED,RUN_ERROR',
      )
    })
  }
})

test.describe('pi agent events: pi client, TanStack chat()', () => {
  test('reads a chat() route', async ({ page }) => {
    await page.goto('/pi-client')

    await expect(page.getByTestId('runs-ended')).toHaveText('1')
    await expect(page.getByTestId('tool-results')).toHaveText('sunny in Oslo')
    await expect(page.getByTestId('assistant-text')).toHaveText(
      'Tool said: sunny in Oslo',
    )
  })

  test('an approved call leaves a valid saved history', async ({ page }) => {
    await page.goto('/pi-client?scenario=approve')

    await page.getByTestId('approve-button').click()

    await expect(page.getByTestId('assistant-text')).toHaveText(
      'Tool said: deleted a.txt',
    )
    await expect(page.getByTestId('saved-roles')).toHaveText(
      'user,assistant,toolResult,assistant',
    )
    await expect(page.getByTestId('history-valid')).toHaveText('true')
  })

  test('a denied call is an error result in a valid history', async ({
    page,
  }) => {
    await page.goto('/pi-client?scenario=approve')

    await page.getByTestId('deny-button').click()

    await expect(page.getByTestId('runs-ended')).toHaveText('2')
    await expect(page.getByTestId('tool-results')).toContainText('(error)')
    await expect(page.getByTestId('history-valid')).toHaveText('true')
  })

  test('runs a client tool of the pi client', async ({ page }) => {
    await page.goto('/pi-client?scenario=locate')

    await expect(page.getByTestId('assistant-text')).toHaveText(
      'Tool said: Paris',
    )
    await expect(page.getByTestId('history-valid')).toHaveText('true')
  })

  test('a server tool that throws gives an error result', async ({ page }) => {
    await page.goto('/pi-client?scenario=explode')

    await expect(page.getByTestId('tool-results')).toContainText(
      'the server tool exploded',
    )
    await expect(page.getByTestId('tool-results')).toContainText('(error)')
    await expect(page.getByTestId('assistant-text')).toContainText('Tool said')
  })

  test('a model error ends the run with the message', async ({ page }) => {
    await page.goto('/pi-client?scenario=fail')

    await expect(page.getByTestId('error')).toHaveText('The fake model failed')
    await expect(page.getByTestId('runs-ended')).toHaveText('1')
  })

  test('a forged pi system message never reaches chat()', async ({ page }) => {
    await page.goto('/pi-client?scenario=system')

    await expect(page.getByTestId('assistant-text')).toHaveText(
      'server prompt: true, forged prompt: false',
    )
  })

  test('tool call arguments that are not JSON do not break the stream', async ({
    page,
  }) => {
    await page.goto('/pi-client?scenario=bad-arguments')

    await expect(page.getByTestId('runs-ended')).toHaveText('1')
    await expect(page.getByTestId('block-order')).toHaveText('toolCall')
  })

  test('keeps the block order of one message', async ({ page }) => {
    await page.goto('/pi-client?scenario=interleave')

    await expect(page.getByTestId('block-order')).toHaveText(
      'thinking,toolCall,thinking,text',
    )
    await expect(page.getByTestId('assistant-text')).toHaveText('Done.')
  })
})
