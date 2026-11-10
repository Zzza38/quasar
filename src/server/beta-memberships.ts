import type { Db } from './db';
import type { BetaRegistry } from './beta-registry';

/** Delete ended memberships for every account. An unavailable registry is not evidence that a beta ended. */
export function removeRetiredBetaMemberships(db: Db, registry: BetaRegistry): number {
  if (!registry.retired.length) return 0;
  return db.prepare('DELETE FROM beta_members WHERE beta_key IN (SELECT value FROM json_each(?))')
    .run(JSON.stringify(registry.retired)).changes;
}
