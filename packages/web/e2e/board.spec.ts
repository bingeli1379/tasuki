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
    await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${ref}?deleteSubtasks=true`, {
      method: 'DELETE',
      headers: { Authorization: `Basic ${auth}` },
    })
  }
})

test('a new item shows up in Refining and is still there after a reload', async ({
  page,
  request,
}) => {
  const title = `e2e ${Date.now()}`
  await page.goto('/')
  const refining = page.getByRole('region', { name: /^Refining/ })
  await expect(refining).toBeVisible()

  await page.getByRole('button', { name: 'New item' }).click()
  const dialog = page.getByRole('dialog', { name: 'New item' })
  await dialog.getByLabel('Title').fill(title)
  // The same editor as in the item detail, so formatting is markdown from the start.
  const editor = dialog.getByLabel('Body')
  // Anywhere in the box, not only its first line, puts the cursor in the editor.
  await editor.click({ position: { x: 20, y: 140 } })
  await expect(editor).toBeFocused()
  await page.keyboard.type('first line')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('second line ')
  await dialog.getByRole('button', { name: 'Bold' }).click()
  await expect(editor).toBeFocused()
  await page.keyboard.type('loud')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  const card = refining.getByRole('article', { name: title })
  await expect(card).toContainText('first line\nsecond line')
  const ref = (await card.getByText(/^[A-Z][A-Z0-9]*-\d+$/).textContent()) ?? ''
  expect(ref).not.toBe('')
  created.push(ref)
  const stored = (await (await request.get(`/api/items/${ref}`)).json()) as {
    item: { body: string }
  }
  expect(stored.item.body).toBe('first line\nsecond line **loud**')

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
  // Not Ready to Split: a rule watches it, and the engine would take the item away.
  const needsAnswers = page.getByRole('region', { name: /^Needs Answers/ })
  await reloadUntilVisible(page, refining.getByRole('article', { name: title }))

  await refining.getByRole('article', { name: title }).dragTo(needsAnswers)
  await expect(needsAnswers.getByRole('article', { name: title })).toBeVisible()
  await expect(refining.getByRole('article', { name: title })).toHaveCount(0)

  await reloadUntilVisible(page, needsAnswers.getByRole('article', { name: title }))
})

test('moving an item someone else already moved says where it went', async ({ page, request }) => {
  const title = `e2e conflict ${Date.now()}`
  const ref = await createThroughApi(request, title)
  await page.goto('/')
  const refining = page.getByRole('region', { name: /^Refining/ })
  await reloadUntilVisible(page, refining.getByRole('article', { name: title }))

  // Someone else moves it while this page still shows it in Refining.
  const behind = await request.post(`/api/items/${ref}/transition`, {
    data: { from: 'refining', to: 'needs-answers' },
  })
  expect(behind.ok()).toBe(true)

  await page.getByRole('button', { name: `Move ${title}` }).click()
  await page.getByRole('menuitem', { name: 'Done' }).click()

  // exact: the toast also renders a hidden copy for screen readers, prefixed "Notification".
  await expect(
    page.getByText(`${ref} was just moved by someone else`, { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('region', { name: /^Needs Answers/ }).getByRole('article', { name: title }),
  ).toBeVisible()
  await expect(
    page.getByRole('region', { name: /^Done/ }).getByRole('article', { name: title }),
  ).toHaveCount(0)
})

test('open an item, edit it in markdown with an image, comment, and find it all after a reload', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  const title = `e2e detail ${Date.now()}`
  await createThroughApi(request, title)
  await page.goto('/')
  const refining = page.getByRole('region', { name: /^Refining/ })
  await reloadUntilVisible(page, refining.getByRole('article', { name: title }))

  // Anywhere on the card opens it, not only the title.
  await refining.getByRole('article', { name: title }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: title })).toBeVisible()

  await dialog.getByLabel('Attach a file').setInputFiles({
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      'base64',
    ),
  })
  await expect(dialog.getByRole('link', { name: 'dot.png' })).toBeVisible()

  await dialog.getByRole('button', { name: 'Edit' }).click()
  const editor = dialog.getByLabel('Body')
  // A toolbar button hands focus back to the editor a frame later; wait before typing on.
  const bold = async (): Promise<void> => {
    await dialog.getByRole('button', { name: 'Bold' }).click()
    await expect(editor).toBeFocused()
  }
  await editor.click()
  await page.keyboard.type('Needs ')
  await bold()
  await page.keyboard.type('care')
  await bold()
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('second line')
  await page.keyboard.press('Enter')
  await dialog.getByRole('button', { name: 'Insert dot.png' }).click()
  await dialog.getByRole('button', { name: 'Save' }).click()

  const image = dialog.locator('.markdown img')
  // On Jira a save is several round trips (re-read, image media id, write, read back).
  await expect(dialog.getByRole('button', { name: 'Edit' })).toBeVisible({ timeout: 20_000 })
  await expect(dialog.locator('.markdown strong')).toHaveText('care')
  await expect(dialog.locator('.markdown br')).toHaveCount(1)
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)

  await dialog.getByLabel('Add a comment').fill('Looks _fine_')
  await dialog.getByRole('button', { name: 'Comment' }).click()
  // The author is "You" on sqlite and the Jira account's name on Jira.
  await expect(dialog.getByRole('article', { name: /^Comment by / })).toContainText('Looks fine')

  await page.reload()
  await reloadUntilVisible(page, refining.getByRole('article', { name: title }))
  await refining.getByRole('button', { name: title, exact: true }).click()
  await expect(dialog.locator('.markdown strong')).toHaveText('care')
  await expect(dialog.locator('.markdown img')).toBeVisible()
  await expect(dialog.locator('.markdown em')).toHaveText('fine')
})

test('an item dragged to Ready to Split is split, approved, executed, and accepted', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const title = `e2e split ${Date.now()}`
  await createThroughApi(request, title)
  await page.goto('/')
  const refining = page.getByRole('region', { name: /^Refining/ })
  await reloadUntilVisible(page, refining.getByRole('article', { name: title }))

  await refining
    .getByRole('article', { name: title })
    .dragTo(page.getByRole('region', { name: /^Ready to Split/ }))

  // The board reads itself again on its own; nobody reloads from here on.
  const splitting = page.getByRole('region', { name: /^Splitting/ })
  const card = splitting.getByRole('article', { name: title })
  await expect(card).toBeVisible({ timeout: 60_000 })
  await expect(card.getByText('Running')).toBeVisible()

  const review = page.getByRole('region', { name: /^Split Review/ })
  await expect(review.getByRole('article', { name: title })).toBeVisible({ timeout: 60_000 })
  await expect(review.getByRole('article', { name: title }).getByText('Running')).toHaveCount(0)

  await review.getByRole('button', { name: title, exact: true }).click()
  const dialog = page.getByRole('dialog')
  const run = dialog.getByRole('listitem', { name: 'Run split attempt 1' })
  await expect(run).toContainText('succeeded')
  await expect(dialog.getByRole('article', { name: 'Comment by Engine' })).toContainText(
    'Rule split, attempt 1: succeeded, moved to split-review.',
  )

  // The fake runner made two tasks, the second waiting for the first.
  await expect(dialog.getByRole('listitem', { name: /^Task / })).toHaveCount(2)
  await expect(dialog.getByRole('listitem', { name: 'Task Prepare' })).toContainText('To Do')
  await expect(dialog.getByRole('listitem', { name: 'Task Build' })).toContainText('after Prepare')
  await dialog.getByRole('button', { name: 'Approve' }).click()
  await expect(dialog).toBeHidden()

  // Rule execute picks it up where it is and walks both tasks to done.
  const inProgress = page.getByRole('region', { name: /^In Progress/ })
  await expect(inProgress.getByRole('article', { name: title }).getByText('Running')).toBeVisible({
    timeout: 60_000,
  })
  const inReview = page.getByRole('region', { name: /^In Review/ })
  await expect(inReview.getByRole('article', { name: title })).toContainText('2/2 tasks', {
    timeout: 60_000,
  })

  await inReview.getByRole('button', { name: title, exact: true }).click()
  await expect(dialog.getByRole('listitem', { name: 'Run execute attempt 1' })).toContainText(
    'succeeded',
  )
  await expect(dialog.getByRole('listitem', { name: 'Task Build' })).toContainText('Done')
  await dialog.getByRole('button', { name: 'Accept' }).click()
  await expect(dialog).toBeHidden()
  await reloadUntilVisible(
    page,
    page.getByRole('region', { name: /^Done/ }).getByRole('article', { name: title }),
  )
})
