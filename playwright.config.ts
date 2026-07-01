import { defineConfig, devices } from '@playwright/test'

/*
 * Real-browser e2e: runs against the BUILT single file (vite preview over dist/), i.e. the exact
 * artifact that ships - not the dev server. Four profiles: desktop Chrome, desktop Safari
 * (WebKit - Safari-only quirks like the replaceState quota and stricter clipboard permissions
 * have bitten before), phone (portrait, the <=640px grid), and a landscape phone (>640px +
 * coarse pointer, which exercises the pointer:coarse touch-sizing tier that used to fall
 * through to 16px desktop controls).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4173' },
  webServer: {
    command: 'npm run build && npm run preview',
    port: 4173,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'desktop-safari', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 800 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
    { name: 'phone-landscape', use: { ...devices['Pixel 7 landscape'] } },
  ],
})
