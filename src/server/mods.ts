import { z } from 'zod';
import { DEFAULT_MOD_OVERRIDES, MOD_IDS, MOD_OVERRIDE_STATES, type ModId, type ModOverrides, type ModOverrideState } from '@/domain/mods';
import type { Service } from './service';

export const modOverrideSchema = z.object({ mod: z.enum(MOD_IDS), state: z.enum(MOD_OVERRIDE_STATES) });

/** Global policy only. Public readers never receive the owner or audit metadata. */
export function readModOverrides(service: Service): ModOverrides {
  const overrides = { ...DEFAULT_MOD_OVERRIDES };
  const rows = service.db.prepare('SELECT mod, state FROM mod_overrides').all() as { mod: ModId; state: ModOverrideState }[];
  for (const row of rows) overrides[row.mod] = row.state;
  return overrides;
}

export function setModOverride(service: Service, actorId: string, raw: z.infer<typeof modOverrideSchema>): ModOverrides {
  service.admin(actorId);
  const input = modOverrideSchema.parse(raw);
  return service.db.transaction(() => {
    const previous = readModOverrides(service)[input.mod];
    service.db.prepare(`INSERT INTO mod_overrides(mod,state,updated_at,updated_by) VALUES(?,?,?,?)
      ON CONFLICT(mod) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
      .run(input.mod, input.state, new Date().toISOString(), actorId);
    service.audit(actorId, 'admin.modOverride', null, { mod: input.mod, from: previous, to: input.state });
    return readModOverrides(service);
  }).immediate();
}
