import { reactive } from 'vue'
import { describe, expect, it } from 'vite-plus/test'
import { toOptions, toValues, type OptionField } from './option-values'

const fields: OptionField[] = [
  { key: 'model', label: 'Model', type: 'text' },
  { key: 'allowedTools', label: 'Allowed tools', type: 'list' },
  { key: 'env.KEY', label: 'Key', type: 'secret' },
  { key: 'settings', label: 'Settings', type: 'json' },
]

describe('a plugin form as the page edits it (D111)', () => {
  it('reads options into one text per field and back', () => {
    const options = { model: 'haiku', allowedTools: ['Read', 'Bash(git:*)'], settings: { a: 1 } }
    const values = toValues(fields, options)
    expect(values).toEqual({
      model: 'haiku',
      allowedTools: 'Read\nBash(git:*)',
      'env.KEY': '',
      settings: '{\n  "a": 1\n}',
    })
    expect(toOptions(fields, values)).toEqual(options)
  })

  it('keeps what the form does not show, and drops what it shows and was emptied', () => {
    // As the page holds it: reactive.
    const kept = reactive({
      model: 'haiku',
      inheritSettings: true,
      env: { OTHER: 'x' },
      seconds: 10,
    })
    expect(toOptions(fields, { model: '', allowedTools: 'Read' }, kept)).toEqual({
      inheritSettings: true,
      env: { OTHER: 'x' },
      seconds: 10,
      allowedTools: ['Read'],
    })
  })

  it('names the field whose JSON does not parse', () => {
    expect(() => toOptions(fields, { settings: '{ nope' })).toThrow('Settings is not valid JSON')
  })
})
