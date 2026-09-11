import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.E2E_DATABASE_PATH ||= join(mkdtempSync(join(tmpdir(),'whatsnext-browser-')), 'test.sqlite');
process.env.E2E_AUTH_SECRET ||= 'test-only-secret-which-is-never-used-in-production-123456789';
export default defineConfig({
  testDir: './tests/e2e', workers: 1, fullyParallel: false, timeout: 60_000,
  use: {
    baseURL: 'http://localhost:3100', trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {},
  },
  webServer: {
    command: 'npm start -- --port 3100', url: 'http://localhost:3100/api/health', reuseExistingServer: false,
    env: { DATABASE_PATH: process.env.E2E_DATABASE_PATH, NEXTAUTH_SECRET:process.env.E2E_AUTH_SECRET,
      NEXTAUTH_URL:'http://localhost:3100', OWNER_EMAIL:'browser-owner@example.com',
      GOOGLE_CLIENT_ID:'test-client', GOOGLE_CLIENT_SECRET:'test-client-secret' }
  }
});
