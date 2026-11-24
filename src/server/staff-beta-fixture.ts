import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { BetaService } from './betas';
import { createBeta, EMPTY_BETA_REGISTRY, writeBetaRegistry } from './beta-registry';
import type { Service } from './service';

export function useStaffBetaFixture() {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'quasar-role-test-'));
    vi.stubEnv('BETAS_PATH', join(directory, 'betas.json'));
    writeBetaRegistry(createBeta(EMPTY_BETA_REGISTRY, { key: 'staff-roles', name: 'Staff roles', public: true }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });
}

export function joinStaffBeta(service: Service, id: string) {
  new BetaService(service).enroll(id, { key: 'staff-roles' });
}
