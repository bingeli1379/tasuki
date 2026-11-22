import { expect, test as setup } from '@playwright/test'

// The engine under test starts on the default flow from an empty store; the stations and
// rules the board tests need are saved the way the settings page saves them (D91).
setup('save the flow the board tests need', async ({ request }, info) => {
  const current = await request.get('/api/flow')
  expect(current.ok()).toBe(true)
  const { version } = (await current.json()) as { version?: number }
  const saved = await request.put('/api/flow', {
    data: { ...(version === undefined ? {} : { version }), flow: info.project.metadata['flow'] },
  })
  expect(saved.ok(), await saved.text()).toBe(true)
})
