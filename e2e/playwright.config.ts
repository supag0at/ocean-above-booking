import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Drive the stack that is already running. Do not download browsers; Chromium is installed.
export default defineConfig({
  testDir: '.',
  timeout: 200_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // Outside the repo: root Prettier scans every file, and this task cannot edit .prettierignore.
  outputDir: join(tmpdir(), 'fb-t15-playwright'),
  preserveOutput: 'failures-only',
  use: {
    baseURL: 'http://127.0.0.1',
    locale: 'zh-CN',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    ...devices['Desktop Chrome'],
  },
});
