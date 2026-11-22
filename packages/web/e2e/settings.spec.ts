import { expect, test } from '@playwright/test'

// W4a (D91): a status added on the settings page is a column on the board once saved. Added
// after the others, so no other test's columns move.
test('a status added on the settings page shows on the board once saved', async ({ page }) => {
  const name = `Spec Check ${Date.now()}`
  await page.goto('/')
  await expect(page.getByRole('region', { name: /^Refining/ })).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('listitem', { name: 'Refining' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Add a status' }).click()
  const added = dialog.getByRole('listitem', { name: 'New status' })
  await added.getByLabel('Name').fill(name)
  const station = dialog.getByRole('listitem', { name })
  // The id follows the name until the status is saved.
  await expect(station.getByLabel('ID')).toHaveValue(name.toLowerCase().replaceAll(' ', '-'))
  // On Jira a status is one of the project's; KAN's Story type has Manual to spare.
  if (test.info().project.name === 'jira') {
    await station.getByLabel('Tracker status').click()
    await page.getByRole('option', { name: 'Manual' }).click()
  }
  await dialog.getByRole('button', { name: 'Save' }).click()

  await expect(dialog).toBeHidden()
  await expect(page.getByRole('region', { name: new RegExp(`^${name}`) })).toBeVisible()
})

test('an ID already taken is flagged as typed, and a new ID carries what points at it', async ({
  page,
}) => {
  const stamp = Date.now()
  const first = `Spec First ${stamp}`
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  const save = dialog.getByRole('button', { name: 'Save' })
  await dialog.getByRole('button', { name: 'Add a status' }).click()
  await dialog.getByRole('listitem', { name: 'New status' }).getByLabel('Name').fill(first)
  const station = dialog.getByRole('listitem', { name: first })
  await station.getByLabel('ID').fill('refining')
  await expect(station.getByText('Another status has this ID')).toBeVisible()
  await expect(save).toBeDisabled()
  await station.getByLabel('ID').fill(`spec-first-${stamp}`)
  await expect(station.getByText('Another status has this ID')).toBeHidden()
  await expect(save).toBeEnabled()

  // KAN's one spare status went to the test before; the rest needs stations of its own.
  if (test.info().project.name !== 'sqlite') {
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    return
  }
  const second = `Spec Second ${stamp}`
  await dialog.getByRole('button', { name: 'Add a status' }).click()
  await dialog.getByRole('listitem', { name: 'New status' }).getByLabel('Name').fill(second)
  await dialog.getByRole('listitem', { name: second }).getByLabel('Buttons').click()
  await page.getByRole('option', { name: first }).click()
  await page.keyboard.press('Escape')
  // Saved with the button still on the old ID, the server would refuse it.
  await station.getByLabel('ID').fill(`spec-renamed-${stamp}`)
  await save.click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('region', { name: new RegExp(`^${first}`) })).toBeVisible()
})
