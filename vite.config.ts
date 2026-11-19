import { defineConfig } from 'vite-plus'

export default defineConfig({
  run: {
    cache: { scripts: true },
  },
  fmt: {
    semi: false,
    singleQuote: true,
    ignorePatterns: ['docs/', 'CLAUDE.md', 'pnpm-lock.yaml'],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  staged: {
    '*': 'vp check --fix',
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    passWithNoTests: true,
  },
})
