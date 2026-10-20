import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { betaKeySchema, normalizeBetaCode } from '@/domain/betas';

/**
 * The betas that exist (README "Running a beta"): betas.json beside the database, or BETAS_PATH. The file is never
 * committed (it holds the join codes in plain text) and is only changed with `npm run beta` (scripts/beta.ts), never
 * from /admin. The server re-reads it whenever it changes, so a new or paused beta takes effect without a restart.
 */

/** Generated codes read XXXXX-XXXXX from an alphabet without 0/O or 1/I/L. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const MANUAL_CODE_PATTERN = /^[A-Z0-9]{4,64}$/;
/** Manual codes shorter than this work, but the command warns: a short code is easy to guess. */
export const SHORT_MANUAL_CODE = 8;

export const betaDefinitionSchema = z.object({
  key: betaKeySchema,
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500),
  /** False stops new members joining; members already in stay in. */
  open: z.boolean(),
  maxMembers: z.number().int().min(1).max(100_000).nullable(),
  /** As shown to testers. Matching ignores case, spaces and dashes. */
  code: z.string().refine(code => MANUAL_CODE_PATTERN.test(normalizeBetaCode(code)), 'A code is 4 to 64 letters and numbers.'),
}).strict();
export const betaRegistrySchema = z.object({
  betas: z.array(betaDefinitionSchema),
  /** Keys of removed betas. They are never reused, so old memberships can't switch a new beta on. */
  retired: z.array(betaKeySchema),
}).strict().superRefine((registry, context) => {
  const keys = registry.betas.map(beta => beta.key);
  for (const key of new Set(keys.filter((key, index) => keys.indexOf(key) !== index))) context.addIssue({ code: 'custom', message: `Beta "${key}" is defined twice.` });
  for (const key of registry.retired.filter(key => keys.includes(key))) context.addIssue({ code: 'custom', message: `Beta "${key}" is both defined and retired.` });
  const codes = registry.betas.map(beta => normalizeBetaCode(beta.code));
  for (const [index, code] of codes.entries()) if (codes.indexOf(code) !== index) context.addIssue({ code: 'custom', message: `Betas "${keys[codes.indexOf(code)]}" and "${keys[index]}" have the same code.` });
});
export type BetaDefinition = z.infer<typeof betaDefinitionSchema>;
export type BetaRegistry = z.infer<typeof betaRegistrySchema>;
export const EMPTY_BETA_REGISTRY: BetaRegistry = { betas: [], retired: [] };

/** Where the betas live: BETAS_PATH, or betas.json in the database's directory (data/ locally, the volume in Docker). */
export function betaRegistryPath(env: Record<string, string | undefined> = process.env): string {
  return resolve(env.BETAS_PATH || join(dirname(env.DATABASE_PATH || './data/quasar.sqlite'), 'betas.json'));
}

/** The file's betas; none when it doesn't exist yet. Throws a readable Error when it is malformed. */
export function readBetaRegistry(path = betaRegistryPath()): BetaRegistry {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_BETA_REGISTRY; throw error; }
  const parsed = betaRegistrySchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${path} is not a valid beta list: ${parsed.error.issues.map(issue => issue.message).join(' ')}`);
  return parsed.data;
}

/** Writes the file whole (temp file, then rename), so the server never reads half of it. Owner-only, like the database. */
export function writeBetaRegistry(registry: BetaRegistry, path = betaRegistryPath()): void {
  const valid = betaRegistrySchema.parse(registry);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

let cached: { path: string; ino: number; mtimeMs: number; size: number; registry: BetaRegistry } | null = null;
/**
 * The server's view of the file, re-read when it changes (writeBetaRegistry replaces the file, so its inode changes too). A malformed file keeps the last
 * good list (and is logged), so a bad hand edit can't switch every beta off.
 */
export function currentBetaRegistry(path = betaRegistryPath()): BetaRegistry {
  let stat: { ino: number; mtimeMs: number; size: number };
  try { stat = statSync(path); } catch { return EMPTY_BETA_REGISTRY; }
  if (cached && cached.path === path && cached.ino === stat.ino && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.registry;
  try {
    const registry = readBetaRegistry(path);
    cached = { path, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, registry };
    return registry;
  } catch (error) {
    console.error(`Beta list not reloaded: ${error instanceof Error ? error.message : 'unreadable'}`);
    return cached?.path === path ? cached.registry : EMPTY_BETA_REGISTRY;
  }
}

export function generateBetaCode(): string {
  const chars = [...randomBytes(10)].map(byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

/** The beta this code opens, open or not. */
export function betaForCode(registry: BetaRegistry, code: string): BetaDefinition | undefined {
  const typed = normalizeBetaCode(code);
  return registry.betas.find(beta => normalizeBetaCode(beta.code) === typed);
}

/* ---------- Edits made by `npm run beta` (scripts/beta.ts). Each returns the new list or throws a readable Error. ---------- */

function find(registry: BetaRegistry, key: string): BetaDefinition {
  const beta = registry.betas.find(entry => entry.key === key);
  if (!beta) throw new Error(`There is no beta "${key}". Run \`npm run beta -- list\` to see them.`);
  return beta;
}
function replace(registry: BetaRegistry, key: string, change: (beta: BetaDefinition) => BetaDefinition): BetaRegistry {
  find(registry, key);
  return betaRegistrySchema.parse({ ...registry, betas: registry.betas.map(beta => beta.key === key ? change(beta) : beta) });
}
function checkedCode(registry: BetaRegistry, code: string, exceptKey?: string): string {
  const trimmed = code.trim();
  if (!MANUAL_CODE_PATTERN.test(normalizeBetaCode(trimmed))) throw new Error('A code is 4 to 64 letters and numbers. Spaces and dashes are allowed and ignored.');
  const holder = registry.betas.find(beta => beta.key !== exceptKey && normalizeBetaCode(beta.code) === normalizeBetaCode(trimmed));
  if (holder) throw new Error(`Beta "${holder.key}" already uses that code.`);
  return trimmed;
}

/** A new beta, open, with the given code or a generated one. */
export function createBeta(registry: BetaRegistry, input: { key: string; name: string; description?: string; maxMembers?: number | null; code?: string }): BetaRegistry {
  const key = betaKeySchema.parse(input.key);
  if (registry.betas.some(beta => beta.key === key)) throw new Error(`Beta "${key}" already exists.`);
  if (registry.retired.includes(key)) throw new Error(`"${key}" belonged to a removed beta. Pick a new key so its old members don't get this one.`);
  const beta = betaDefinitionSchema.parse({ key, name: input.name, description: input.description ?? '', open: true, maxMembers: input.maxMembers ?? null,
    code: input.code === undefined ? generateBetaCode() : checkedCode(registry, input.code) });
  return betaRegistrySchema.parse({ ...registry, betas: [...registry.betas, beta] });
}
export function editBeta(registry: BetaRegistry, key: string, details: { name?: string; description?: string; maxMembers?: number | null }): BetaRegistry {
  return replace(registry, key, beta => betaDefinitionSchema.parse({ ...beta, ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) }));
}
export function setBetaOpen(registry: BetaRegistry, key: string, open: boolean): BetaRegistry {
  return replace(registry, key, beta => ({ ...beta, open }));
}
/** A new code, given or generated. The old code stops working; members stay in. */
export function newBetaCode(registry: BetaRegistry, key: string, code?: string): BetaRegistry {
  return replace(registry, key, beta => ({ ...beta, code: code === undefined ? generateBetaCode() : checkedCode(registry, code, key) }));
}
/** Ends a beta: removes it and retires its key. Memberships of a retired key are ignored. */
export function removeBeta(registry: BetaRegistry, key: string): BetaRegistry {
  find(registry, key);
  return betaRegistrySchema.parse({ betas: registry.betas.filter(beta => beta.key !== key), retired: [...registry.retired, key] });
}
