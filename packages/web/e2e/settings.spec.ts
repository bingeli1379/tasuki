import { expect, test } from '@playwright/test'

// W4a (D91): a status added on the settings page is a column on the board once saved. Added
// after the others, so no other test's columns move.
test('a status added on the settings page shows on the board once saved', async ({ page }) => {
  const name = `Spec Check ${Date.now()}`
  await page.goto('/')
  await expect(page.getByRole('region', { name: /^Refining/ })).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('menuitem', { name: 'Workflow' }).click()
  const dialog = page.getByRole('dialog', { name: 'Workflow' })
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
  await page.getByRole('menuitem', { name: 'Workflow' }).click()
  const dialog = page.getByRole('dialog', { name: 'Workflow' })
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

// W4b (D94): a save shows in the history with what it changed, and an older version restored
// into the form saves as a new one. A prompt, since the fake runner never reads it.
test('the history shows what a save changed, and restoring saves the older one again', async ({
  page,
}) => {
  const prompt = `Spec prompt ${Date.now()}`
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('menuitem', { name: 'Workflow' }).click()
  const dialog = page.getByRole('dialog', { name: 'Workflow' })
  const rule = dialog.getByRole('region', { name: 'Rules' }).getByRole('listitem').first()
  const id = await rule.getByLabel('Name').inputValue()
  await rule.getByLabel('Prompt').fill(prompt)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('menuitem', { name: 'Workflow' }).click()
  await dialog.getByRole('button', { name: 'History' }).click()
  const newest = dialog.getByRole('region', { name: 'History' }).getByRole('listitem').first()
  await expect(newest.getByText('In use')).toBeVisible()
  await newest.getByText(`Rule ${id} prompt changed`).click()
  await expect(newest.getByText(prompt)).toBeVisible()
  const label = await newest.getAttribute('aria-label')
  const version = Number(label?.replace('Version ', ''))

  await dialog
    .getByRole('listitem', { name: `Version ${version - 1}` })
    .getByRole('button', { name: 'Restore' })
    .click()
  await expect(dialog.getByText(`Version ${version - 1} is in the form`)).toBeVisible()
  await expect(rule.getByLabel('Prompt')).not.toHaveValue(prompt)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('menuitem', { name: 'Workflow' }).click()
  await dialog.getByRole('button', { name: 'History' }).click()
  const restored = dialog.getByRole('listitem', { name: `Version ${version + 1}` })
  await expect(restored.getByText('In use')).toBeVisible()
  await expect(restored.getByText(`Rule ${id} prompt changed`)).toBeVisible()
})

// W6a (D105): what the instance runs on is edited on the General page, saved in the store and
// followed at once. Put back as it was, since every other test polls on it.
test('the General page saves the poll interval and shows it again', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('menuitem', { name: 'General' }).click()
  const dialog = page.getByRole('dialog', { name: 'General' })
  const poll = dialog.getByLabel('Poll every (seconds)')
  const before = await poll.inputValue()
  await poll.fill('3')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()

  await page.reload()
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('menuitem', { name: 'General' }).click()
  await expect(poll).toHaveValue('3')
  await poll.fill(before)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
})
