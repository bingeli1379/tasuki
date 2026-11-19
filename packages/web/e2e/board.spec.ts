import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const created: string[] = []

// The board may lag behind writes (D54), so reload until the card is listed. Each round waits
// for the board request itself: on Jira it takes about a second, one search per column.
const reloadUntilVisible = async (page: Page, card: Locator): Promise<void> => {
  await expect(async () => {
    await Promise.all([page.waitForResponse('**/api/board'), page.reload()])
    await expect(card).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 20_000 })
}

test.afterAll(async () => {
  if (test.info().project.name !== 'jira') return
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')
  for (const ref of created) {
    await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${ref}`, {
      method: 'DELETE',
      headers: { Authorization: `Basic ${auth}` },
    })
  }
})

test('a new item shows up in Refining and is still there after a reload', async ({ page }) => {
  const title = `e2e ${Date.now()}`
  await page.goto('/')
  const refining = page.getByRole('region', { name: /^Refining/ })
  await expect(refining).toBeVisible()

  await page.getByRole('button', { name: 'New item' }).click()
  const dialog = page.getByRole('dialog', { name: 'New item' })
  await dialog.getByLabel('Title').fill(title)
  await dialog.getByLabel('Body').fill('first line\nsecond line')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  const card = refining.getByRole('article', { name: title })
  await expect(card).toContainText('first line\nsecond line')
  const ref = (await card.getByText(/^[A-Z][A-Z0-9]*-\d+$/).textContent()) ?? ''
  expect(ref).not.toBe('')
  created.push(ref)

  await reloadUntilVisible(page, refining.getByRole('article', { name: title }))
})

const createThroughApi = async (request: APIRequestContext, title: string): Promise<string> => {
  const res = await request.post('/api/items', { data: { title, body: '' } })
  expect(res.ok()).toBe(true)
  const { ref } = (await res.json()) as { ref: string }
  created.push(ref)
  return ref
}

test('dragging an item to another column moves it, and it stays there', async ({
  page,
  request,
}) => {
  const title = `e2e drag ${Date.now()}`
  await createThroughApi(request, title)
  await page.goto('/')
  const refining = page.getByRole('region', { name: /^Refining/ })
  const readyToSplit = page.getByRole('region', { name: /^Ready to Split/ })
  await reloadUntilVisible(page, refining.getByRole('article', { name: title }))

  await refining.getByRole('article', { name: title }).dragTo(readyToSplit)
  await expect(readyToSplit.getByRole('article', { name: title })).toBeVisible()
  await expect(refining.getByRole('article', { name: title })).toHaveCount(0)

  await reloadUntilVisible(page, readyToSplit.getByRole('article', { name: title }))
})

test('moving an item someone else already moved says where it went', async ({ page, request }) => {
  const title = `e2e conflict ${Date.now()}`
  const ref = await createThroughApi(request, title)
  await page.goto('/')
  const refining = page.getByRole('region', { name: /^Refining/ })
  await reloadUntilVisible(page, refining.getByRole('article', { name: title }))

  // Someone else moves it while this page still shows it in Refining.
  const behind = await request.post(`/api/items/${ref}/transition`, {
    data: { from: 'refining', to: 'ready-to-split' },
  })
  expect(behind.ok()).toBe(true)

  await page.getByRole('button', { name: `Move ${title}` }).click()
  await page.getByRole('menuitem', { name: 'Done' }).click()

  // exact: the toast also renders a hidden copy for screen readers, prefixed "Notification".
  await expect(
    page.getByText(`${ref} was just moved by someone else`, { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('region', { name: /^Ready to Split/ }).getByRole('article', { name: title }),
  ).toBeVisible()
  await expect(
    page.getByRole('region', { name: /^Done/ }).getByRole('article', { name: title }),
  ).toHaveCount(0)
})
