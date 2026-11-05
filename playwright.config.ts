import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 4173);

export default defineConfig({
  testDir: 'tests/browser',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: 'node scripts/serve.mjs',
    url: `http://localhost:${PORT}/package.json`,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT) },
  },
  projects: [
    {
      name: 'chromium',
      // Full Chromium: the default headless shell cannot present WebGPU canvases.
      use: { ...devices['Desktop Chrome'], channel: 'chromium', deviceScaleFactor: 2, launchOptions: { args: ['--enable-unsafe-webgpu'] } },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'], deviceScaleFactor: 2 } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    {
      // Native implementation, used as the conformance oracle.
      name: 'native',
      testMatch: /(conformance|gpu|perf|underglass|visual|wicg)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        deviceScaleFactor: 2,
        launchOptions: { args: ['--enable-blink-features=CanvasDrawElement', '--enable-unsafe-webgpu'] },
      },
    },
  ],
});
