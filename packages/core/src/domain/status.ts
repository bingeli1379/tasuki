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
