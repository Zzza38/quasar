import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { appRouter } from './router';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const userId = randomUUID();
  db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(userId, userId, 'student@example.com', 'Student', 'Student Name', new Date().toISOString());
  return { db, userId, caller: appRouter.createCaller({ userId, service: new Service(db, 'owner@example.com') }) };
}

describe('calendar router account binding', () => {
  it('rejects every mutation from an outdated account before accessing a feed', async () => {
    const { caller, db } = fixture();
    const accountId = randomUUID(), id = randomUUID();
    const requests = [
      caller.calendar.subscribe({ accountId, name: 'School', url: 'https://example.com/calendar.ics', timeZone: 'UTC' }),
      caller.calendar.refresh({ accountId, id }),
      caller.calendar.remove({ accountId, id }),
      caller.calendar.setEnabled({ accountId, id, enabled: false }),
      caller.calendar.resolve({ accountId, entityId: id, expectedVersion: 1, choice: 'source' }),
    ];
    for (const request of requests) await expect(request).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(db.prepare('SELECT count(*) AS count FROM calendar_subscriptions').get()).toEqual({ count: 0 });
  });
  it('returns calendar metadata with workspace and authenticates read access', async () => {
    const { caller, db } = fixture();
    expect(await caller.calendar.list()).toEqual([]);
    expect(await caller.workspace()).toMatchObject({ subscriptions: [], importConflicts: [] });
    const anonymous = appRouter.createCaller({ userId: null, service: new Service(db, 'owner@example.com') });
    await expect(anonymous.calendar.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
