import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { CommunityService } from './community';
import { exampleSchedule } from '@/domain/example';
import { classmatesFor, withLabel } from '@/lib/classmates';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });

describe('classmates on the timetable', () => {
  it('tags a period only when an accepted friend has the same class in the same period', () => {
    const db = openDatabase(':memory:'); databases.push(db);
    const service = new Service(db, 'owner@example.com');
    const add = (name: string) => { const id = randomUUID(); db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, name, `${name} P`, new Date().toISOString()); return id; };
    const me = add('Me'), evan = add('Evan'), maya = add('Maya');
    const school = service.createSchool(me, { name: 'Example High', location: 'Boston, MA', schedule: exampleSchedule });
    for (const id of [me, evan, maya]) service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
    const setClasses = (id: string, byPeriod: Record<string, string>) => {
      const names = [...new Set(Object.values(byPeriod))];
      const classes = names.map((name, index) => ({ id: `c${index}`, name }));
      const assignments = Object.fromEntries(Object.entries(byPeriod).map(([periodId, name]) => [periodId, classes.find(cls => cls.name === name)!.id]));
      service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(id, 'personal'), data: { grade: '9', classes, assignments, cycleDayOverrides: [], dateOverrides: [], customSchedule: null } });
    };
    setClasses(evan, { A: 'Pre-AP Computer Science', B: 'Biology' });
    setClasses(maya, { B: 'pre-ap computer science' });
    const community = new CommunityService(service);
    community.request(me, evan); community.respond(evan, me, true);
    community.request(me, maya);
    const summary = community.summary(me);
    expect(summary.classmates).toEqual([{ id: evan, displayName: 'Evan', classes: [{ periodId: 'A', name: 'pre-ap computer science' }, { periodId: 'B', name: 'biology' }] }]);
    const cs = { id: 'x', name: 'Pre-AP Computer Science ' };
    expect(classmatesFor({ community: summary }, { periodId: 'A', class: cs })).toEqual(['Evan']);
    // Same class name in a different period is not a shared class.
    expect(classmatesFor({ community: summary }, { periodId: 'B', class: cs })).toEqual([]);
    expect(classmatesFor({ community: summary }, { periodId: 'A', class: { id: 'y', name: 'Chemistry' } })).toEqual([]);
    expect(classmatesFor({ community: summary }, { periodId: 'A' })).toEqual([]);
    community.respond(maya, me, true);
    // Maya takes the same class but in period B, so only Evan shares period A with me.
    expect(classmatesFor({ community: community.summary(me) }, { periodId: 'A', class: cs })).toEqual(['Evan']);
    expect(classmatesFor({ community: community.summary(me) }, { periodId: 'B', class: cs })).toEqual(['Maya']);
  });
  it('phrases the label naturally', () => {
    expect(withLabel([])).toBeNull();
    expect(withLabel(['Evan'])).toBe('With Evan');
    expect(withLabel(['Evan', 'Maya'])).toBe('With Evan and Maya');
    expect(withLabel(['Evan', 'Maya', 'Sam', 'Lee'])).toBe('With Evan, Maya and 2 more');
  });
});
