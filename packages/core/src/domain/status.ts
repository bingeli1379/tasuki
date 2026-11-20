// Board order. Logical names are what config and code use; display names are for the UI.
export const ITEM_STATUSES: readonly string[] = [
  'refining',
  'ready-to-split',
  'splitting',
  'needs-answers',
  'split-review',
  'in-progress',
  'in-review',
  'ready-to-rework',
  'blocked',
  'done',
]

export const ITEM_STATUS_DISPLAY: Readonly<Record<string, string>> = {
  refining: 'Refining',
  'ready-to-split': 'Ready to Split',
  splitting: 'Splitting',
  'needs-answers': 'Needs Answers',
  'split-review': 'Split Review',
  'in-progress': 'In Progress',
  'in-review': 'In Review',
  'ready-to-rework': 'Ready to Rework',
  blocked: 'Blocked',
  done: 'Done',
}

// Task order, as the task state machine reads (state-machine.md).
export const TASK_STATUSES: readonly string[] = [
  'to-do',
  'in-progress',
  'in-review',
  'manual',
  'done',
]

export const TASK_STATUS_DISPLAY: Readonly<Record<string, string>> = {
  'to-do': 'To Do',
  'in-progress': 'In Progress',
  'in-review': 'In Review',
  manual: 'Manual',
  done: 'Done',
}
