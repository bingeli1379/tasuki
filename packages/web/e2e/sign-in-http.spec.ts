import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const signIn = async (page: import('@playwright/test').Page, username: string) => {
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill('company password')
  await page.getByRole('button', { name: 'Sign in' }).click()
}
const signOut = async (page: import('@playwright/test').Page) => {
  await page.getByRole('button', { name: 'Account' }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
}

test('the setup link makes the first admin, who adds people by pasting usernames, and removes one', async ({
  page,
}) => {
  const setupToken = readFileSync(
    join(String(process.env['TASUKI_E2E_AUTH_HTTP_DATA']), 'setup-token'),
    'utf8',
  ).trim()

  // The link the start-up log prints fills the token in and leaves the address bar.
  await page.goto(`/?setup=${encodeURIComponent(setupToken)}`)
  await expect(page.getByLabel('Setup token')).toHaveValue(setupToken)
  expect(page.url()).not.toContain('setup=')
  await page.getByLabel('Username').fill('eli')
  await page.getByLabel('Password').fill('company password')
  await page.getByRole('button', { name: 'Become the first admin' }).click()
  await expect(page.getByRole('region', { name: /^Refining/ })).toBeVisible()
  await signOut(page)

  // The company knows amy, but nobody has added her.
  await signIn(page, 'amy')
  await expect(page.getByText('wrong username or password')).toBeVisible()

  await signIn(page, 'eli')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('menuitem', { name: 'Accounts' }).click()
  const accounts = page.getByRole('dialog', { name: 'Accounts' })
  await accounts.getByRole('button', { name: 'Add people' }).click()
  await expect(accounts.getByLabel('Usernames')).toBeFocused()
  await accounts.getByLabel('Usernames').fill('amy\nbob\neli\n')
  await accounts.getByRole('button', { name: 'Add people' }).click()
  // exact: the toast also renders a hidden copy for screen readers, prefixed "Notification".
  await expect(
    page.getByText('Already here, left as they were: eli', { exact: true }),
  ).toBeVisible()
  const amy = accounts.getByRole('listitem', { name: 'amy' })
  await expect(amy).toContainText('Not signed in yet')
  await accounts.getByLabel('Find someone').fill('bo')
  await expect(accounts.getByRole('listitem')).toHaveCount(1)
  await accounts.getByRole('button', { name: 'Delete bob' }).click()
  // Asked under bob's own row, wherever the list was scrolled to.
  await accounts
    .getByRole('listitem', { name: 'bob' })
    .getByRole('button', { name: 'Delete for good' })
    .click()
  await expect(accounts.getByRole('listitem')).toHaveCount(0)
  await accounts.getByLabel('Find someone').fill('')
  await amy.getByRole('combobox').click()
  await page.getByRole('option', { name: 'Maintainer' }).click()
  await expect(amy).toContainText('Maintainer')
  await page.keyboard.press('Escape')
  await signOut(page)

  // Added now, she gets in, under the name the company gives her.
  await signIn(page, 'amy')
  await expect(page.getByRole('region', { name: /^Refining/ })).toBeVisible()
  await page.getByRole('button', { name: 'Account' }).click()
  await expect(page.getByRole('menu').getByText('Amy Lin')).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Accounts' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Change password' })).toHaveCount(0)
})
