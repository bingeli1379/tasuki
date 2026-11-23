import { expect, test as setup, type APIRequestContext } from '@playwright/test'

// Saves one settings document the way its page does: from the version in use.
async function save(request: APIRequestContext, path: string, body: object): Promise<void> {
  const current = await request.get(path)
  expect(current.ok()).toBe(true)
  const { version } = (await current.json()) as { version?: number }
  const saved = await request.put(path, {
    data: { ...(version === undefined ? {} : { version }), ...body },
  })
  expect(saved.ok(), await saved.text()).toBe(true)
}

// The engine under test starts on sqlite, the default flow and the default instance settings
// from an empty store; what the board tests need is saved the way the gear's pages save it
// (D91, D105). In this order: the poll first, so the tracker's check for another engine
// waits three 2-second rounds, not three 30-second ones; the tracker and the agents before the
// flow, whose keys are the tracker's statuses and whose rules pick the agents.
setup('save the settings the board tests need', async ({ request }, info) => {
  // Polling every 2 seconds keeps the Jira run short; the agent takes 10, longer than the
  // board needs to read itself again and show it Running.
  await save(request, '/api/instance', { instance: { poll: { intervalSeconds: 2 } } })
  const tracker = info.project.metadata['tracker'] as object | undefined
  if (tracker !== undefined) await save(request, '/api/tracker', tracker)
  await save(request, '/api/agents', { agents: info.project.metadata['agents'] })
  await save(request, '/api/flow', { flow: info.project.metadata['flow'] })
})
