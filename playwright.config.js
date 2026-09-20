import { defineConfig, devices } from '@playwright/test';

const port = 5173;
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;
const builtMode = process.env.PLAYWRIGHT_MODE === 'built';
const ciLike = Boolean(process.env.CI || process.env.PLAYWRIGHT_RELEASE);

export default defineConfig({
    testDir: './tests/e2e',
    timeout: 180_000,
    expect: { timeout: 15_000 },
    forbidOnly: ciLike,
    retries: ciLike ? 1 : 0,
    use: {
        baseURL,
        headless: true,
        actionTimeout: 15_000,
        navigationTimeout: 30_000,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            testIgnore: /webkit-smoke\.spec\.js/,
            use: { ...devices['Desktop Chrome'], browserName: 'chromium' },
        },
        {
            name: 'webkit',
            testMatch: /webkit-smoke\.spec\.js/,
            use: { ...devices['Desktop Safari'], browserName: 'webkit' },
        },
    ],
    webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
        command: builtMode
            ? `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`
            : `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
        url: baseURL,
        reuseExistingServer: !builtMode && !ciLike,
        timeout: 30_000,
    },
});
