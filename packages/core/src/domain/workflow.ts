import { TASK_STATUS_DISPLAY } from './status'

// A station is one item status as the person lists it. Board order is list order.
export interface Station {
  id: string
  name: string
  // Set when the station waits for a person. Whether the engine handles it comes from the
  // rules, never from here: a station marked for the engine with no rule on it would lie.
  handledBy?: 'person'
  // What a person can conclude here: button label -> the station the item goes to.
  outcomes: Readonly<Record<string, string>>
}

// The stations code has a use for, by what it uses them for rather than by name.
export interface Roles {
  // New items start here.
  entry: string
  // Where the board ends.
  done: string
  // Where a rule's failed and max_attempts go unless it says otherwise.
  failure: string
  // The only station where a person may edit and delete tasks (D70).
  taskReview?: string
  // Moving an item here asks what to rework first (D75).
  rework?: string
}

export interface Workflow {
  statuses: readonly Station[]
  roles: Roles
}

export const DEFAULT_WORKFLOW: Workflow = {
  statuses: [
    { id: 'refining', name: 'Refining', outcomes: {} },
    { id: 'ready-to-split', name: 'Ready to Split', outcomes: {} },
    { id: 'splitting', name: 'Splitting', outcomes: {} },
    { id: 'needs-answers', name: 'Needs Answers', handledBy: 'person', outcomes: {} },
    {
      id: 'split-review',
      name: 'Split Review',
      handledBy: 'person',
      outcomes: { '→ Refining': 'refining', '→ In Progress': 'in-progress' },
    },
    { id: 'in-progress', name: 'In Progress', outcomes: {} },
    {
      id: 'in-review',
      name: 'In Review',
      handledBy: 'person',
      outcomes: { '→ Ready to Rework': 'ready-to-rework', '→ Done': 'done' },
    },
    { id: 'ready-to-rework', name: 'Ready to Rework', outcomes: {} },
    // Auto-resume moves it on once a person has done the manual tasks.
    { id: 'blocked', name: 'Blocked', handledBy: 'person', outcomes: {} },
    { id: 'done', name: 'Done', outcomes: {} },
  ],
  roles: {
    entry: 'refining',
    done: 'done',
    failure: 'blocked',
    taskReview: 'split-review',
    rework: 'ready-to-rework',
  },
}

// How a status reads in a comment: its display name in bold, so a status never blends into
// the sentence around it (D82). Comments live in the tracker, so this is markdown Jira shows
// too.
export type StatusNames = (status: string) => string

export const itemStatusNames =
  (workflow: Workflow): StatusNames =>
  (status) =>
    `**${workflow.statuses.find((s) => s.id === status)?.name ?? status}**`

export const taskStatusName: StatusNames = (status) =>
  `**${TASK_STATUS_DISPLAY[status] ?? status}**`
