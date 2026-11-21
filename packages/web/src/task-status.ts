// One colour per task status, so a glance tells done from waiting on a person.
export const TASK_COLOR: Readonly<
  Record<string, 'neutral' | 'info' | 'primary' | 'warning' | 'success'>
> = {
  'to-do': 'neutral',
  'in-progress': 'info',
  'in-review': 'primary',
  manual: 'warning',
  done: 'success',
}
