import { defineConfig } from 'vitest/config'

// In the app, electron-vite turns a `?modulePath` import into the path of a separately
// bundled file (used to start worker threads). In tests it resolves to the source file.
const MODULE_PATH = '?modulePath'
const VIRTUAL = '\0damon-module-path:'

export default defineConfig({
  plugins: [{
    name: 'damon:module-path-in-tests',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.endsWith(MODULE_PATH)) return null
      const found = await this.resolve(source.slice(0, -MODULE_PATH.length), importer, { skipSelf: true })
      return found ? VIRTUAL + found.id : null
    },
    load(id) {
      return id.startsWith(VIRTUAL) ? `export default ${JSON.stringify(id.slice(VIRTUAL.length))}` : null
    }
  }],
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    passWithNoTests: true
  }
})
