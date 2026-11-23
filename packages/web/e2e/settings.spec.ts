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

// W6b (D105, D106): the Tracker page shows the tracker in use with its own form; a token is
// never sent back, and saving with it left blank keeps the one in use, so the board still
// reads the tracker after.
test('the Tracker page shows the tracker in use and never its token', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('menuitem', { name: 'Tracker' }).click()
  const dialog = page.getByRole('dialog', { name: 'Tracker' })
  if (test.info().project.name === 'jira') {
    await expect(dialog.getByText('Jira Cloud')).toBeVisible()
    const token = dialog.getByLabel('API token')
    await expect(token).toHaveValue('')
    await expect(token).toHaveAttribute('placeholder', 'Set; leave blank to keep it')
    await expect(dialog.getByLabel('Project key')).toHaveValue(/\S/)
  } else {
    await expect(dialog.getByText('sqlite, kept by tasuki')).toBeVisible()
    await expect(dialog.getByLabel('Ref prefix')).toBeVisible()
  }
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await page.reload()
  await expect(page.getByRole('region', { name: /^Refining/ })).toBeVisible()
  await expect(page.getByText(/not matched to the tracker yet/)).toHaveCount(0)
})

// W7 (D107, D110): the Agents page lists the agents rules pick from, each with its runner's own
// form. A claude agent added in auto keeps its permissions and never shows its token again;
// the fake one the board tests run on stays as it was.
test('the Agents page adds a claude agent in auto and never shows its token', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('menuitem', { name: 'Agents' }).click()
  const dialog = page.getByRole('dialog', { name: 'Agents' })
  await expect(dialog.getByRole('button', { name: 'fake', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Add agent' }).click()
  await dialog.getByLabel('Name', { exact: true }).fill('claude-auto')
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await dialog.getByLabel('Permissions').click()
  await page.getByRole('option', { name: /^Auto/ }).click()
  await dialog.getByLabel('Sign-in').click()
  await page.getByRole('option', { name: 'A token from claude setup-token' }).click()
  await dialog.getByLabel('OAuth token').fill('sk-ant-oat-e2e')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved: the next Run uses it')).toBeVisible()

  await page.reload()
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('menuitem', { name: 'Agents' }).click()
  await dialog.getByRole('button', { name: 'claude-auto' }).click()
  await expect(dialog.getByLabel('Permissions')).toContainText('Auto')
  const token = dialog.getByLabel('OAuth token')
  await expect(token).toHaveValue('')
  await expect(token).toHaveAttribute('placeholder', 'Set; leave blank to keep it')
  // Taken off again, so the board tests keep running on the fake one alone.
  await dialog.getByRole('button', { name: 'Remove claude-auto' }).click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved: the next Run uses it').last()).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'claude-auto' })).toHaveCount(0)
})
