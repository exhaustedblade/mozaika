/**
 * Browser tests of the viewer (Ф0-6б): the pages draw their scenes, the
 * benchmark measures, the shader computes what its twin does. They run on
 * the built preview (pnpm build first), one at a time: the benchmark must
 * not share the processor with another test. In CI the graphics card is
 * software (SwiftShader), so frame rates there are only a guide.
 *
 *   pnpm --filter @mozaika/viewer e2e
 *
 * Where Playwright's own Chromium is not installed, name another one:
 * PLAYWRIGHT_CHROMIUM=/path/to/chrome.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM;

export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  outputDir: 'results/playwright',
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${String(PORT)}/`,
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      // A software graphics card is allowed in CI, where there is no other.
      args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
      ...(executablePath === undefined ? {} : { executablePath }),
    },
  },
  webServer: {
    command: `pnpm exec vite preview --port ${String(PORT)} --strictPort`,
    cwd: '..',
    url: `http://localhost:${String(PORT)}/`,
    reuseExistingServer: process.env.CI === undefined,
  },
});
