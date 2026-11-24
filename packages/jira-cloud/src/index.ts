import { API_VERSION, definePlugin, type Plugin } from '@tasuki/core'
import { createClient, createFetch } from './client'
import { JIRA_FORM } from './form'
import { parseOptions } from './options'
import { createJiraTracker } from './tracker'

const plugin: Plugin = definePlugin({
  name: '@tasuki/jira-cloud',
  apiVersion: API_VERSION,
  tracker: (ctx, raw) => {
    const options = parseOptions(raw)
    const jiraFetch = createFetch(options)
    return createJiraTracker(ctx, options, createClient(jiraFetch), jiraFetch)
  },
  forms: { tracker: JIRA_FORM },
})

export default plugin
