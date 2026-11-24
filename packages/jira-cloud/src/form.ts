import type { OptionChoice, OptionsForm } from '@tasuki/core'
import { createFetch } from './client'

interface JiraType {
  id: string
  name: string
  subtask: boolean
  hierarchyLevel?: number
}

function filled(options: unknown, key: string): string {
  const v = (options as Record<string, unknown> | undefined)?.[key]
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`fill in ${key} first`)
  return v.trim()
}

// Every Jira value the engine needs is an id, looked up here so nobody copies them out of
// Jira by hand (D50).
async function lookUp(options: unknown): Promise<Record<string, OptionChoice[]>> {
  const project = filled(options, 'project').toUpperCase()
  const get = createFetch({
    baseUrl: filled(options, 'baseUrl').replace(/\/+$/, ''),
    email: filled(options, 'email'),
    apiToken: filled(options, 'apiToken'),
  })
  const types = (
    (await (await get(`/project/${encodeURIComponent(project)}`)).json()) as {
      issueTypes: JiraType[]
    }
  ).issueTypes
  const links = (
    (await (await get('/issueLinkType')).json()) as {
      issueLinkTypes: { id: string; name: string }[]
    }
  ).issueLinkTypes
  const choice = (t: { id: string; name: string }): OptionChoice => ({
    value: t.id,
    label: `${t.name} (${t.id})`,
  })
  return {
    // Epics sit above the standard level and are not where work items go.
    'issueTypes.item': types.filter((t) => !t.subtask && (t.hierarchyLevel ?? 0) === 0).map(choice),
    'issueTypes.task': types.filter((t) => t.subtask).map(choice),
    // Blocks first: it is the one that means "blocks" unless the site renamed it.
    dependencyLinkType: [
      ...links.filter((l) => l.name === 'Blocks'),
      ...links.filter((l) => l.name !== 'Blocks'),
    ].map(choice),
  }
}

export const JIRA_FORM: OptionsForm = {
  fields: [
    {
      key: 'baseUrl',
      label: 'Jira URL',
      type: 'text',
      required: true,
      placeholder: 'https://<site>.atlassian.net',
    },
    { key: 'email', label: 'Email', type: 'text', required: true },
    { key: 'apiToken', label: 'API token', type: 'secret', required: true },
    { key: 'project', label: 'Project key', type: 'text', required: true, placeholder: 'KAN' },
    { key: 'issueTypes.item', label: 'Issue type for items', type: 'select', required: true },
    {
      key: 'issueTypes.task',
      label: 'Sub-task type for tasks',
      type: 'select',
      required: true,
    },
    {
      key: 'dependencyLinkType',
      label: 'Link type that means blocks',
      type: 'select',
      required: true,
    },
  ],
  choices: lookUp,
}
