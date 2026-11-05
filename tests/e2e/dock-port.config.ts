import { resolve } from 'node:path';
import base from '../../playwright.config';
const port = 3151;
export default { ...base, testDir: __dirname, use: { ...base.use, baseURL: `http://localhost:${port}` },
  webServer: { ...base.webServer, cwd: resolve(__dirname, '../..'), command: `npx next start --hostname 127.0.0.1 --port ${port}`, url: `http://127.0.0.1:${port}/api/health`,
    env: { ...(base.webServer as { env: Record<string, string> }).env, NEXTAUTH_URL: `http://localhost:${port}` } } };
