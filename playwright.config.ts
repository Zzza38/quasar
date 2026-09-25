import { defineConfig } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
if (!process.env.E2E_DATABASE_PATH) {
  // A throwaway database per run. Only the process that created the directory removes it, when it exits (after the
  // web server has stopped); workers inherit the path and leave it alone. Set E2E_KEEP_DATABASE=1 to keep it for debugging.
  const directory = mkdtempSync(join(tmpdir(), 'quasar-browser-'));
  process.env.E2E_DATABASE_PATH = join(directory, 'test.sqlite');
  process.on('exit', () => { if (!process.env.E2E_KEEP_DATABASE) rmSync(directory, { recursive: true, force: true }); });
}
process.env.E2E_AUTH_SECRET ||= 'test-only-secret-which-is-never-used-in-production-123456789';
export default defineConfig({
  testDir: './tests/e2e', workers: 1, fullyParallel: false, timeout: 60_000,
  // A committed test.only would otherwise run alone in CI and still pass.
  forbidOnly: !!process.env.CI,
  // Sync round-trips (save, session check, upload, refresh) can exceed 5 s on a busy host; the app shows saving states meanwhile.
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://localhost:3100', trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {},
  },
  webServer: {
    // Loopback only (not `npm start`, which binds 0.0.0.0): the session secret below is public, so the server must not be reachable from the LAN.
    command: 'npx next start --hostname 127.0.0.1 --port 3100', url: 'http://127.0.0.1:3100/api/health', reuseExistingServer: false,
    // `next start` fills every key that is still undefined from .env.local, so production-only keys are blanked here to keep them out of the test server.
    env: { DATABASE_PATH: process.env.E2E_DATABASE_PATH, NEXTAUTH_SECRET:process.env.E2E_AUTH_SECRET,
      NEXTAUTH_URL:'http://localhost:3100', OWNER_EMAIL:'browser-owner@example.com', OWNER_GOOGLE_SUB:'',
      GOOGLE_CLIENT_ID:'test-client', GOOGLE_CLIENT_SECRET:'test-client-secret',
      SCAN_API_URL:'http://127.0.0.1:3199/v1', SCAN_MODEL:'mock-vision', SCAN_API_KEY:'', SCAN_MODEL_REASONING:'', SCAN_MODEL_TEMPERATURE:'',
      VAPID_PUBLIC_KEY:'', VAPID_PRIVATE_KEY:'', VAPID_SUBJECT:'' }
  }
});
