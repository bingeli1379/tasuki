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
    // The example is a standalone package with its own install; scripts/verify-plugin-example.ts checks it.
    ignorePatterns: ['examples/'],
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
