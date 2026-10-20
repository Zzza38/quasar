import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_BETA_REGISTRY, betaForCode, betaRegistryPath, createBeta, currentBetaRegistry, editBeta, newBetaCode, readBetaRegistry, removeBeta, setBetaOpen, writeBetaRegistry } from './beta-registry';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });
const tempPath = () => { const directory = mkdtempSync(join(tmpdir(), 'quasar-betas-')); directories.push(directory); return join(directory, 'betas.json'); };

describe('beta list', () => {
  it('lives beside the database unless BETAS_PATH says otherwise', () => {
    expect(betaRegistryPath({ DATABASE_PATH: '/srv/app/data/whatsnext.sqlite' })).toBe('/srv/app/data/betas.json');
    expect(betaRegistryPath({ DATABASE_PATH: '/srv/app/data/whatsnext.sqlite', BETAS_PATH: '/etc/quasar/betas.json' })).toBe('/etc/quasar/betas.json');
    expect(betaRegistryPath({})).toMatch(/\/data\/betas\.json$/);
  });

  it('creates betas with a generated or a manual code, and matches codes ignoring case, spaces and dashes', () => {
    let registry = createBeta(EMPTY_BETA_REGISTRY, { key: 'month-grid', name: 'Month grid', description: 'Try it.', maxMembers: 20 });
    registry = createBeta(registry, { key: 'quick-add', name: 'Quick add', code: 'Fun Times-26' });
    const [grid, quick] = registry.betas;
    expect(grid).toMatchObject({ key: 'month-grid', open: true, maxMembers: 20 });
    expect(grid.code).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
    expect(quick.code).toBe('Fun Times-26');
    expect(betaForCode(registry, grid.code.toLowerCase().replace('-', ' '))?.key).toBe('month-grid');
    expect(betaForCode(registry, 'funtimes26')?.key).toBe('quick-add');
    expect(betaForCode(registry, 'nope')).toBeUndefined();
  });

  it('refuses bad keys, untypeable or shared codes, duplicates and retired keys', () => {
    const registry = createBeta(EMPTY_BETA_REGISTRY, { key: 'month-grid', name: 'Month grid', code: 'GRID-2026' });
    expect(() => createBeta(registry, { key: 'Month Grid', name: 'X beta' })).toThrow();
    expect(() => createBeta(registry, { key: 'x-beta', name: 'X beta', code: 'abc' })).toThrow('4 to 64 letters and numbers');
    expect(() => createBeta(registry, { key: 'x-beta', name: 'X beta', code: 'g!rid' })).toThrow('4 to 64 letters and numbers');
    expect(() => createBeta(registry, { key: 'x-beta', name: 'X beta', code: 'grid 2026' })).toThrow('Beta "month-grid" already uses that code.');
    expect(() => createBeta(registry, { key: 'month-grid', name: 'Again' })).toThrow('already exists');
    const removed = removeBeta(registry, 'month-grid');
    expect(removed).toEqual({ betas: [], retired: ['month-grid'] });
    expect(() => createBeta(removed, { key: 'month-grid', name: 'Again' })).toThrow('belonged to a removed beta');
  });

  it('edits, pauses and swaps codes without touching other betas', () => {
    let registry = createBeta(EMPTY_BETA_REGISTRY, { key: 'month-grid', name: 'Month grid', code: 'GRID-2026', maxMembers: 5 });
    registry = createBeta(registry, { key: 'quick-add', name: 'Quick add' });
    registry = editBeta(registry, 'month-grid', { description: 'Now with weeks.', maxMembers: null });
    registry = setBetaOpen(registry, 'month-grid', false);
    expect(registry.betas[0]).toMatchObject({ name: 'Month grid', description: 'Now with weeks.', maxMembers: null, open: false, code: 'GRID-2026' });
    const generated = newBetaCode(registry, 'month-grid');
    expect(generated.betas[0].code).not.toBe('GRID-2026');
    expect(newBetaCode(registry, 'month-grid', 'NEW-CODE').betas[0].code).toBe('NEW-CODE');
    expect(() => newBetaCode(registry, 'quick-add', 'grid2026')).toThrow('already uses that code');
    expect(newBetaCode(registry, 'month-grid', 'grid 2026').betas[0].code).toBe('grid 2026');
    expect(generated.betas[1]).toEqual(registry.betas[1]);
    expect(() => setBetaOpen(registry, 'missing', true)).toThrow('There is no beta "missing"');
  });

  it('reads nothing from a missing file, rejects a malformed one, and writes it owner-only', () => {
    const path = tempPath();
    expect(readBetaRegistry(path)).toEqual(EMPTY_BETA_REGISTRY);
    writeBetaRegistry(createBeta(EMPTY_BETA_REGISTRY, { key: 'month-grid', name: 'Month grid' }), path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readBetaRegistry(path).betas.map(beta => beta.key)).toEqual(['month-grid']);
    writeFileSync(path, JSON.stringify({ betas: [{ key: 'a-b', name: 'A', description: '', open: true, maxMembers: null, code: 'ABCD' }, { key: 'a-b', name: 'Again', description: '', open: true, maxMembers: null, code: 'EFGH' }], retired: [] }));
    expect(() => readBetaRegistry(path)).toThrow('defined twice');
  });

  it('serves changes to the running server at once, and keeps the last good list through a bad edit', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const path = tempPath();
    expect(currentBetaRegistry(path)).toEqual(EMPTY_BETA_REGISTRY);
    const one = createBeta(EMPTY_BETA_REGISTRY, { key: 'month-grid', name: 'Month grid' });
    writeBetaRegistry(one, path);
    expect(currentBetaRegistry(path)).toEqual(one);
    const paused = setBetaOpen(one, 'month-grid', false);
    writeBetaRegistry(paused, path);
    expect(currentBetaRegistry(path)).toEqual(paused);
    writeFileSync(path, '{ not json');
    expect(currentBetaRegistry(path)).toEqual(paused);
    expect(console.error).toHaveBeenCalled();
  });
});
