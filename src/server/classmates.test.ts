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
  it('lists accepted friends with their class names and nothing for pending requests', () => {
    const db = openDatabase(':memory:'); databases.push(db);
    const service = new Service(db, 'owner@example.com');
    const add = (name: string) => { const id = randomUUID(); db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, name, `${name} P`, new Date().toISOString()); return id; };
    const me = add('Me'), evan = add('Evan'), maya = add('Maya');
    const school = service.createSchool(me, { name: 'Example High', location: 'Boston, MA', schedule: exampleSchedule });
    for (const id of [me, evan, maya]) service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
    const setClasses = (id: string, names: string[]) => service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(id, 'personal'), data: { grade: '9', classes: names.map((name, index) => ({ id: `c${index}`, name })), assignments: {}, cycleDayOverrides: [], dateOverrides: [], customSchedule: null } });
    setClasses(evan, ['Pre-AP Computer Science', 'Biology']);
    setClasses(maya, ['pre-ap computer science']);
    const community = new CommunityService(service);
    community.request(me, evan); community.respond(evan, me, true);
    community.request(me, maya);
    const summary = community.summary(me);
    expect(summary.classmates).toEqual([{ id: evan, displayName: 'Evan', classes: ['pre-ap computer science', 'biology'] }]);
    expect(classmatesFor({ community: summary }, 'Pre-AP Computer Science ')).toEqual(['Evan']);
    expect(classmatesFor({ community: summary }, 'Chemistry')).toEqual([]);
    community.respond(maya, me, true);
    expect(classmatesFor({ community: community.summary(me) }, 'Pre-AP Computer Science')).toEqual(['Evan', 'Maya']);
  });
  it('phrases the label naturally', () => {
    expect(withLabel([])).toBeNull();
    expect(withLabel(['Evan'])).toBe('With Evan');
    expect(withLabel(['Evan', 'Maya'])).toBe('With Evan and Maya');
    expect(withLabel(['Evan', 'Maya', 'Sam', 'Lee'])).toBe('With Evan, Maya and 2 more');
  });
});
