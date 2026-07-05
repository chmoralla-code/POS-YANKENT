// Playwright config for YANKENT POS E2E tests.
// Boots the actual Electron app via `electron .` with a fresh smoke DB
// so each run starts from a clean, deterministic state.
const path = require('path');

const smokeDb = path.join(process.env.TEMP || '/tmp', 'yankent-e2e.sqlite');
const repoRoot = __dirname;

module.exports = {
  testDir: path.join(repoRoot, 'tests', 'e2e'),
  timeout: 120000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'electron',
      use: {
        env: {
          YANKENT_SMOKE: '1',
          YANKENT_E2E: '1',
          YANKENT_DB: smokeDb,
        },
      },
    },
  ],
};
