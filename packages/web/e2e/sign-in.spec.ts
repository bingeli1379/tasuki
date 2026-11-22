import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const API = 'http://127.0.0.1:8790'

const mcpInitialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '0' },
  },
}

test('the first admin comes from the setup token, adds a member, and the member signs in', async ({
  page,
  request,
}) => {
  const setupToken = readFileSync(
    join(String(process.env['TASUKI_E2E_AUTH_DATA']), 'setup-token'),
    'utf8',
  ).trim()

  await page.goto('/')
  await expect(page.getByText('There is no admin yet')).toBeVisible()
  await page.getByLabel('Setup token').fill(setupToken)
  await page.getByLabel('Username').fill('eli')
  await page.getByLabel('Password', { exact: true }).fill('admin password')
  await page.getByLabel('Confirm password').fill('admin password')
  await page.getByRole('button', { name: 'Create the first admin' }).click()
  await expect(page.getByRole('region', { name: /^Refining/ })).toBeVisible()

  // A member, from the accounts page only an admin has.
  await page.getByRole('button', { name: 'Account' }).click()
  await page.getByRole('menuitem', { name: 'Accounts' }).click()
  const accounts = page.getByRole('dialog', { name: 'Accounts' })
  await accounts.getByRole('button', { name: 'Add account' }).click()
  // The form focuses its first field on its own; typing before that lands in the wrong one.
  await expect(accounts.getByLabel('Username')).toBeFocused()
  await accounts.getByLabel('Username').fill('amy')
  await accounts.getByLabel('Password', { exact: true }).fill('member password')
  await accounts.getByLabel('Confirm password').fill('member password')
  await accounts.getByRole('button', { name: 'Add account' }).click()
  await expect(accounts.getByRole('listitem', { name: 'amy' })).toContainText('Member')
  await page.keyboard.press('Escape')

  // A personal API token lets /mcp in until it is revoked.
  await page.getByRole('button', { name: 'Account' }).click()
  await page.getByRole('menuitem', { name: 'API tokens' }).click()
  const tokens = page.getByRole('dialog', { name: 'API tokens' })
  await tokens.getByLabel('Name').fill('laptop')
  await tokens.getByRole('button', { name: 'Create' }).click()
  const token = ((await tokens.locator('code').textContent()) ?? '').trim()
  const mcp = (bearer: string) =>
    request.post(`${API}/mcp`, {
      headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json, text/event-stream' },
      data: mcpInitialize,
    })
  expect((await mcp(token)).status()).toBe(200)
  await tokens.getByRole('button', { name: 'Revoke laptop' }).click()
  await expect(tokens.getByText('No tokens yet.')).toBeVisible()
  expect((await mcp(token)).status()).toBe(401)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Account' }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()

  await page.getByLabel('Username').fill('amy')
  await page.getByLabel('Password').fill('wrong password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText('wrong username or password')).toBeVisible()
  await page.getByLabel('Password').fill('member password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('region', { name: /^Refining/ })).toBeVisible()
  await page.getByRole('button', { name: 'Account' }).click()
  await expect(page.getByRole('menuitem', { name: 'API tokens' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Accounts' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // What a member writes carries their name.
  await page.getByRole('button', { name: 'New item' }).click()
  const create = page.getByRole('dialog', { name: 'New item' })
  await create.getByLabel('Title').fill('signed in')
  await create.getByRole('button', { name: 'Create' }).click()
  await page
    .getByRole('region', { name: /^Refining/ })
    .getByRole('button', { name: 'signed in' })
    .click()
  const detail = page.getByRole('dialog')
  await expect(detail.getByRole('heading', { name: 'signed in' })).toBeVisible()
  await detail.getByLabel('Add a comment').fill('mine')
  await detail.getByRole('button', { name: 'Comment' }).click()
  await expect(detail.getByRole('article', { name: 'Comment by amy' })).toContainText('mine')
})
