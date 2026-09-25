import { existsSync } from 'node:fs';
import { openDatabase } from '../src/server/db';
import { errorSummary, startJobs } from '../src/server/jobs';

// Match local Next.js configuration, while preserving environment variables
// supplied by systemd or Docker. Never log configuration values or feed URLs.
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const db = openDatabase();
const worker = startJobs(db, {
  // Error name and code only (errorSummary): messages can quote feed URLs or push endpoints.
  onError: (job, error) => console.error(`Quasar ${job} background job failed (${errorSummary(error)}); retrying next cycle.`),
  // Counts only: provider responses can quote endpoints, so they never reach the log.
  onFailures: (job, failed) => console.error(`Quasar ${job} push step: ${failed} ${failed === 1 ? 'delivery' : 'deliveries'} failed.`),
});
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
