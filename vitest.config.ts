import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  // compile .svelte imports (the TopBar component tests); hot reload off under the test runner
  plugins: [svelte({ hot: false })],
  // pick svelte's browser build - the SSR build has no onMount/lifecycle in happy-dom
  resolve: { conditions: ['browser'] },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
  },
})
