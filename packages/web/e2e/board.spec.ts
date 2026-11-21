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

// A test that times out has lost its own request context by the time its finally runs, and
// a pause left on would fail every test after it.
test.afterEach(async ({ request }) => {
  await request.post('/api/engine/resume')
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

  // Moving without dragging is in the item's More menu.
  await refining.getByRole('button', { name: title, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Move to' }).click()
  await page.getByRole('menuitem', { name: 'Done' }).click()

  // exact: the toast also renders a hidden copy for screen readers, prefixed "Notification".
  await expect(
    page.getByText(`${ref} was just moved by someone else`, { exact: true }),
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
  await expect(
    page.getByRole('region', { name: /^Needs Answers/ }).getByRole('article', { name: title }),
  ).toBeVisible()
  await expect(
    page.getByRole('region', { name: /^Done/ }).getByRole('article', { name: title }),
  ).toHaveCount(0)
})

// The board is too wide to drag from Refining to Ready to Rework in one viewport, so this
// takes the item's More menu; a drop asks with the same words from the board.
test('moving to Ready to Rework asks what to rework, and cancelling leaves the card', async ({
  page,
  request,
}) => {
  const title = `e2e rework ask ${Date.now()}`
  await createThroughApi(request, title)
  await page.goto('/')
  const refining = page.getByRole('region', { name: /^Refining/ })
  await reloadUntilVisible(page, refining.getByRole('article', { name: title }))

  await refining.getByRole('button', { name: title, exact: true }).click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Move to' }).click()
  await page.getByRole('menuitem', { name: 'Ready to Rework' }).click()
  await expect(detail.getByRole('button', { name: 'Send back for rework' })).toBeDisabled()
  await detail.getByRole('button', { name: 'Cancel' }).click()
  await expect(detail.getByRole('button', { name: 'Send back for rework' })).toHaveCount(0)
  await detail.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(refining.getByRole('article', { name: title })).toBeVisible()
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

  // An image the body still shows is not deleted; a file nothing shows is, after asking.
  await dialog.getByRole('button', { name: 'Delete dot.png', exact: true }).click()
  await dialog.getByRole('button', { name: 'Delete dot.png for good' }).click()
  await expect(dialog.getByText(/body still shows dot\.png/)).toBeVisible({ timeout: 20_000 })
  await expect(dialog.getByRole('link', { name: 'dot.png' })).toBeVisible()
  await dialog.getByLabel('Attach a file').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('notes'),
  })
  await expect(dialog.getByRole('link', { name: 'notes.txt' })).toBeVisible({ timeout: 20_000 })
  await dialog.getByRole('button', { name: 'Delete notes.txt', exact: true }).click()
  await dialog.getByRole('button', { name: 'Delete notes.txt for good' }).click()
  await expect(dialog.getByRole('link', { name: 'notes.txt' })).toHaveCount(0, { timeout: 20_000 })
  await expect(dialog.getByRole('article', { name: /^Comment by / }).last()).toContainText(
    'Deleted attachment notes.txt.',
  )
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
  await expect(dialog.getByRole('listitem', { name: 'Task Build' })).toContainText(
    /Waits for [A-Z]+-\d+ Prepare/,
  )
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
  // Each move the agent made left its reason on the task (D67).
  await dialog.getByRole('listitem', { name: 'Task Build' }).getByRole('button').click()
  const task = page.getByRole('dialog').last()
  await expect(task.getByRole('article', { name: 'Comment by Engine' })).toHaveCount(3)
  await expect(task.getByRole('article', { name: 'Comment by Engine' }).last()).toContainText(
    'The agent moved it from in-review to done.',
  )
  await task.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await dialog.getByRole('button', { name: 'Accept' }).click()
  await expect(dialog).toBeHidden()
  await reloadUntilVisible(
    page,
    page.getByRole('region', { name: /^Done/ }).getByRole('article', { name: title }),
  )
})

test('tasks are fixed by hand in split review, and a task done by hand counts', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const title = `e2e fix tasks ${Date.now()}`
  const ref = await createThroughApi(request, title)
  const move = await request.post(`/api/items/${ref}/transition`, {
    data: { from: 'refining', to: 'ready-to-split' },
  })
  expect(move.ok()).toBe(true)
  await page.goto('/')
  const review = page.getByRole('region', { name: /^Split Review/ })
  await expect(review.getByRole('article', { name: title })).toBeVisible({ timeout: 60_000 })
  await expect(review.getByRole('article', { name: title }).getByText('Running')).toHaveCount(0)

  await review.getByRole('button', { name: title, exact: true }).click()
  const dialog = page.getByRole('dialog').first()
  const task = page.getByRole('dialog').last()
  await expect(dialog.getByRole('listitem', { name: /^Task / })).toHaveCount(2)

  // Drop the first task: the second one no longer waits for it.
  await dialog.getByRole('listitem', { name: 'Task Prepare' }).getByRole('button').click()
  await task.getByRole('button', { name: 'Delete task' }).click()
  await task.getByRole('button', { name: 'Delete for good' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(dialog.getByRole('listitem', { name: /^Task / })).toHaveCount(1)
  await expect(dialog.getByRole('listitem', { name: 'Task Build' })).not.toContainText('Waits for')

  // Rename the other, then do it by hand.
  await dialog.getByRole('listitem', { name: 'Task Build' }).getByRole('button').click()
  await task.getByRole('button', { name: 'Edit' }).click()
  await task.getByLabel('Title').fill('Build by hand')
  await task.getByRole('button', { name: 'Save' }).click()
  await expect(task.getByRole('heading', { name: 'Build by hand' })).toBeVisible()
  await task.getByRole('button', { name: 'Take over' }).click()
  await expect(task.getByRole('button', { name: 'Hand back' })).toBeVisible()
  await task.getByLabel('Add a comment').fill('Doing this one myself.')
  await task.getByRole('button', { name: 'Comment' }).click()
  // Taking it over left its own line too (D74).
  await expect(
    task
      .getByRole('article', { name: /^Comment by / })
      .filter({ hasText: 'Doing this one myself.' }),
  ).toBeVisible()
  await expect(
    task
      .getByRole('article', { name: /^Comment by / })
      .filter({ hasText: 'Moved from to-do to manual.' }),
  ).toBeVisible()
  await task.getByRole('button', { name: 'Mark done' }).click()
  await expect(task.getByRole('button', { name: 'Hand back' })).toHaveCount(0)
  await task.getByRole('button', { name: 'Close' }).click()
  await expect(dialog.getByRole('listitem', { name: 'Task Build by hand' })).toContainText('Done')

  // Nothing is left for the agent, so execute succeeds at once.
  await dialog.getByRole('button', { name: 'Approve' }).click()
  await expect(dialog).toBeHidden()
  const inReview = page.getByRole('region', { name: /^In Review/ })
  await expect(inReview.getByRole('article', { name: title })).toContainText('1/1 tasks', {
    timeout: 60_000,
  })
})

test('a blocked item carries on once its manual task is done, and finished work goes back for rework', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000)
  const title = `e2e rework ${Date.now()} [fake:manual]`
  const ref = await createThroughApi(request, title)
  const move = await request.post(`/api/items/${ref}/transition`, {
    data: { from: 'refining', to: 'ready-to-split' },
  })
  expect(move.ok()).toBe(true)
  await page.goto('/')
  const card = (column: RegExp) =>
    page.getByRole('region', { name: column }).getByRole('article', { name: title })
  const open = async (column: RegExp) => {
    await expect(card(column)).toBeVisible({ timeout: 90_000 })
    await expect(card(column).getByText('Running')).toHaveCount(0, { timeout: 30_000 })
    await page
      .getByRole('region', { name: column })
      .getByRole('button', { name: title, exact: true })
      .click()
  }
  const dialog = page.getByRole('dialog').first()
  const task = page.getByRole('dialog').last()

  await open(/^Split Review/)
  await dialog.getByRole('button', { name: 'Approve' }).click()
  await expect(dialog).toBeHidden()

  // Execute does Prepare and stops at the manual Build.
  await open(/^Blocked/)
  await dialog.getByRole('listitem', { name: 'Task Build' }).getByRole('button').click()
  await task.getByRole('button', { name: 'Mark done' }).click()
  await expect(task.getByRole('button', { name: 'Mark done' })).toHaveCount(0)
  await task.getByRole('button', { name: 'Close' }).click()
  await dialog.getByRole('button', { name: 'Close' }).click()

  // Nothing manual is left, so the engine picks it up again and finishes.
  await open(/^In Review/)
  await expect(dialog.getByRole('article', { name: 'Comment by Engine' })).toContainText([
    'No task is manual any more. Moved back to in-progress for rule execute to carry on.',
  ])
  await dialog.getByRole('button', { name: 'Rework' }).click()
  await expect(dialog.getByRole('button', { name: 'Send back for rework' })).toBeDisabled()
  await dialog.getByLabel('What to rework').fill('Build is missing the error page.')
  await dialog.getByRole('button', { name: 'Send back for rework' }).click()
  // A comment and a move: on Jira that is several calls.
  await expect(dialog).toBeHidden({ timeout: 30_000 })

  // The rework agent makes a new task from the feedback; the done ones stay done.
  await open(/^Split Review/)
  await expect(dialog.getByRole('listitem', { name: /^Task / })).toHaveCount(3)
  await dialog.getByRole('listitem', { name: 'Task Rework' }).getByRole('button').click()
  await expect(task).toContainText('Build is missing the error page.')
  await task.getByRole('button', { name: 'Close' }).click()
  await dialog.getByRole('button', { name: 'Approve' }).click()
  await expect(dialog).toBeHidden()
  await expect(card(/^In Review/)).toContainText('3/3 tasks', { timeout: 90_000 })
})

test('Stop ends a running agent and holds the item; released, it starts over', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const title = `e2e stop ${Date.now()} [fake:hang]`
  const ref = await createThroughApi(request, title)
  const moved = await request.post(`/api/items/${ref}/transition`, {
    data: { from: 'refining', to: 'ready-to-split' },
  })
  expect(moved.ok()).toBe(true)
  await page.goto('/')
  const splitting = page.getByRole('region', { name: /^Splitting/ })
  const card = splitting.getByRole('article', { name: title })
  await expect(card.getByText('Running')).toBeVisible({ timeout: 60_000 })

  await splitting.getByRole('button', { name: title, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Stop' }).click()
  await expect(dialog.getByText('On hold', { exact: true })).toBeVisible()
  // The detail follows the Run until the engine has ended it.
  await expect(dialog.getByRole('listitem', { name: 'Run split attempt 1' })).toContainText(
    'cancelled',
    { timeout: 30_000 },
  )
  await dialog.getByRole('button', { name: 'Close' }).click()
  // While a dialog is open the board is hidden from the accessibility tree, and any check on
  // a card would pass on finding no card at all.
  await expect(dialog).toBeHidden()

  // Nothing moved: the card stays in Splitting, on hold, with no agent on it.
  await expect(card.getByText('Running')).toHaveCount(0, { timeout: 30_000 })
  await expect(card.getByText('On hold', { exact: true })).toBeVisible()
  await splitting.getByRole('button', { name: title, exact: true }).click()
  await expect(dialog.getByRole('listitem', { name: 'Run split attempt 1' })).toContainText(
    'cancelled',
  )
  await expect(dialog.getByRole('article', { name: 'Comment by Engine' }).last()).toContainText(
    'Rule split, attempt 1: cancelled, a person pressed Stop. The engine moved nothing.',
  )

  await dialog.getByRole('button', { name: 'Release' }).click()
  await expect(dialog.getByRole('button', { name: 'Hold' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
  // Back to Ready to Split and claimed again: a fresh Run hangs like the first.
  await expect(card.getByText('On hold', { exact: true })).toHaveCount(0, { timeout: 30_000 })
  await expect(card.getByText('Running')).toBeVisible({ timeout: 60_000 })

  // Leaves no hanging agent behind for the tests after this one.
  expect((await request.post(`/api/items/${ref}/stop`)).ok()).toBe(true)
})

// Last: the pause holds back every test on this engine.
test('a paused engine starts nothing; resumed, it picks the waiting item up', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  await page.goto('/')
  await page.getByRole('button', { name: 'Pause' }).click()
  await page.getByRole('menuitem', { name: 'Pause', exact: true }).click()
  await expect(page.getByText('The engine is paused')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()

  const title = `e2e pause ${Date.now()}`
  const ref = await createThroughApi(request, title)
  const moved = await request.post(`/api/items/${ref}/transition`, {
    data: { from: 'refining', to: 'ready-to-split' },
  })
  expect(moved.ok()).toBe(true)
  const waiting = page
    .getByRole('region', { name: /^Ready to Split/ })
    .getByRole('article', { name: title })
  await reloadUntilVisible(page, waiting)
  await expect(page.getByText('The engine is paused')).toBeVisible()
  // Several rounds of the 2-second poll go by without a Run.
  await page.waitForTimeout(8_000)
  await expect(waiting).toBeVisible()
  await expect(waiting.getByText('Running')).toHaveCount(0)

  await page.getByRole('button', { name: 'Resume' }).click()
  await expect(page.getByText('The engine is paused')).toHaveCount(0)
  await expect(
    page.getByRole('region', { name: /^Split Review/ }).getByRole('article', { name: title }),
  ).toBeVisible({ timeout: 90_000 })
})
