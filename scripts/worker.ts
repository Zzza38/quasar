import { existsSync } from 'node:fs';
import { openDatabase } from '../src/server/db';
import { startJobs } from '../src/server/jobs';

// Match local Next.js configuration, while preserving environment variables
// supplied by systemd or Docker. Never log configuration values or feed URLs.
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const db = openDatabase();
const worker = startJobs(db, { onError: job => console.error(`Quasar ${job} background job failed; retrying next cycle.`) });
console.log('Quasar background worker started.');
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await worker.stop();
  db.close();
  console.log('Quasar background worker stopped.');
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
