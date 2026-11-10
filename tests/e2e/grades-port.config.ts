import { resolve } from 'node:path';
import base from '../../playwright.config';
// The grades spec on a spare port, for a machine where another checkout's suite holds 3100.
const port = 3152;
export default { ...base, testDir: __dirname, testMatch: 'grades.spec.ts', use: { ...base.use, baseURL: `http://localhost:${port}` },
  webServer: { ...base.webServer, cwd: resolve(__dirname, '../..'), command: `npx next start --hostname 127.0.0.1 --port ${port}`, url: `http://127.0.0.1:${port}/api/health`,
    env: { ...(base.webServer as { env: Record<string, string> }).env, NEXTAUTH_URL: `http://localhost:${port}` } } };
