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

// Polling every 2 seconds keeps the Jira run short; the agent takes 10, longer than the board
// needs to read itself again and show it Running. An instance setting since D105.
setup('poll every 2 seconds', async ({ request }) => {
  const current = await request.get('/api/instance')
  expect(current.ok()).toBe(true)
  const { version } = (await current.json()) as { version?: number }
  const saved = await request.put('/api/instance', {
    data: {
      ...(version === undefined ? {} : { version }),
      instance: { poll: { intervalSeconds: 2 } },
    },
  })
  expect(saved.ok(), await saved.text()).toBe(true)
})
