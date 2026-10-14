import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { DEFAULT_MOD_OVERRIDES, MOD_IDS, MOD_OVERRIDE_STATES, type ModId, type ModOverrides, type ModOverrideState } from '@/domain/mods';
import type { Service } from './service';

export const modOverrideSchema = z.object({ userId: z.uuid(), mod: z.enum(MOD_IDS), state: z.enum(MOD_OVERRIDE_STATES) });

/** Account policy only. Readers never receive the owner or audit metadata. */
export function readModOverrides(service: Service, userId: string | null): ModOverrides {
  const overrides = { ...DEFAULT_MOD_OVERRIDES };
  if (!userId) return overrides;
  const rows = service.db.prepare('SELECT mod, state FROM user_mod_overrides WHERE user_id=?').all(userId) as { mod: ModId; state: ModOverrideState }[];
  for (const row of rows) overrides[row.mod] = row.state;
  return overrides;
}

export function setModOverride(service: Service, actorId: string, raw: z.infer<typeof modOverrideSchema>): ModOverrides {
  service.admin(actorId);
  const input = modOverrideSchema.parse(raw);
  assertModTarget(service, input.userId);
  return service.db.transaction(() => {
    const previous = readModOverrides(service, input.userId)[input.mod];
    service.db.prepare(`INSERT INTO user_mod_overrides(user_id,mod,state,updated_at,updated_by) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id,mod) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
      .run(input.userId, input.mod, input.state, new Date().toISOString(), actorId);
    service.audit(actorId, 'admin.modOverride', null, { userId: input.userId, mod: input.mod, from: previous, to: input.state });
    return readModOverrides(service, input.userId);
  }).immediate();
}

export function assertModTarget(service: Service, userId: string): void {
  if (!service.db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found.' });
  }
}
