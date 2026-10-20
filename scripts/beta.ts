import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { normalizeBetaCode } from '../src/domain/betas';
import { SHORT_MANUAL_CODE, betaRegistryPath, createBeta, editBeta, newBetaCode, readBetaRegistry, removeBeta, setBetaOpen, writeBetaRegistry, type BetaRegistry } from '../src/server/beta-registry';

/**
 * Creates and changes betas (README "Running a beta"). The beta list is betas.json beside the database (or BETAS_PATH),
 * never committed. For the live site, run this in the production checkout; the server picks changes up immediately.
 *
 *   npm run beta -- list
 *   npm run beta -- create <key> --name "Name" [--description "What to try"] [--max 20] [--code "MY-CODE"]
 *   npm run beta -- edit <key> [--name "…"] [--description "…"] [--max 20 | --max none]
 *   npm run beta -- pause <key>          (stop new joins; members stay in)
 *   npm run beta -- open <key>
 *   npm run beta -- new-code <key> [--code "MY-CODE"]   (generated unless --code is given; members stay in)
 *   npm run beta -- remove <key>         (ends the beta and retires its key)
 */

// Same configuration as the app and the worker, so DATABASE_PATH (and so the list's location) matches the server's.
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const USAGE = `Usage:
  npm run beta -- list
  npm run beta -- create <key> --name "Name" [--description "What to try"] [--max 20] [--code "MY-CODE"]
  npm run beta -- edit <key> [--name "Name"] [--description "Text"] [--max 20 | --max none]
  npm run beta -- pause <key>
  npm run beta -- open <key>
  npm run beta -- new-code <key> [--code "MY-CODE"]
  npm run beta -- remove <key>

Without --code, a code is generated. Keys are lowercase letters, numbers and dashes, like month-grid.`;

function maxMembers(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === 'none') return null;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new Error('--max is a whole number from 1 to 100000, or "none".');
  return limit;
}

function describe(registry: BetaRegistry, key: string): string {
  const beta = registry.betas.find(entry => entry.key === key)!;
  return `${beta.key}: ${beta.name}\n  code: ${beta.code}\n  ${beta.open ? 'open' : 'joining paused'}, ${beta.maxMembers === null ? 'no member limit' : `up to ${beta.maxMembers} members`}${beta.description ? `\n  ${beta.description}` : ''}`;
}

function main(): void {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { name: { type: 'string' }, description: { type: 'string' }, max: { type: 'string' }, code: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  const [command, key] = positionals;
  if (values.help || !command) { console.log(USAGE); return; }
  const path = betaRegistryPath();
  const registry = readBetaRegistry(path);
  if (command === 'list') {
    console.log(`Beta list: ${path}`);
    console.log(registry.betas.length ? registry.betas.map(beta => describe(registry, beta.key)).join('\n') : 'No betas.');
    if (registry.retired.length) console.log(`Retired keys: ${registry.retired.join(', ')}`);
    return;
  }
  if (!key) throw new Error(`"${command}" needs a beta key.\n\n${USAGE}`);
  let next: BetaRegistry;
  if (command === 'create') {
    if (!values.name) throw new Error('create needs --name, the name testers see in Account.');
    next = createBeta(registry, { key, name: values.name, description: values.description, maxMembers: maxMembers(values.max), code: values.code });
  } else if (command === 'edit') {
    next = editBeta(registry, key, { name: values.name, description: values.description, maxMembers: maxMembers(values.max) });
  } else if (command === 'pause' || command === 'open') {
    next = setBetaOpen(registry, key, command === 'open');
  } else if (command === 'new-code') {
    next = newBetaCode(registry, key, values.code);
  } else if (command === 'remove') {
    next = removeBeta(registry, key);
  } else {
    throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
  writeBetaRegistry(next, path);
  console.log(`Updated ${path}`);
  if (command === 'remove') { console.log(`Removed ${key}. Its key is retired; its members are out. Delete its <Beta>/useBeta code next.`); return; }
  console.log(describe(next, key));
  if (values.code && normalizeBetaCode(values.code).length < SHORT_MANUAL_CODE) console.warn(`Warning: codes shorter than ${SHORT_MANUAL_CODE} letters and numbers are easy to guess.`);
  if (command === 'create') console.log(`\nWrap the new code in <Beta id="${key}"> or useBeta('${key}') from src/components/betas.tsx. Testers join with the code in Account → Betas.`);
}

try { main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
