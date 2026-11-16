import { expect, test } from '@playwright/test'

const created: string[] = []

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
  const refining = page.locator('.column', {
    has: page.getByRole('heading', { name: /^Refining/ }),
  })
  await expect(refining).toBeVisible()

  await page.getByPlaceholder('Title').fill(title)
  await page.getByPlaceholder('Body').fill('first line\nsecond line')
  await page.getByRole('button', { name: 'New item' }).click()

  const card = refining.locator('.card', { hasText: title })
  await expect(card).toContainText('first line\nsecond line')
  const ref = (await card.locator('small').textContent()) ?? ''
  expect(ref).not.toBe('')
  created.push(ref)

  // The board may lag behind writes (D54), so reload until the item is listed.
  await expect(async () => {
    await page.reload()
    await expect(refining.locator('.card', { hasText: title })).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
})
