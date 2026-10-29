import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { appRouter } from './router';
import { SetupGuideService, UNUSED_IMAGE_MS } from './setup-guides';
import { DEFAULT_GUIDE_SETS, type SetupGuide } from '@/domain/setup-guides';
import { exampleSchedule } from '@/domain/example';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  function user(email = `${randomUUID()}@example.com`) {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, 'Student', 'Student Fullname', new Date().toISOString());
    return id;
  }
  const owner = user('owner@example.com'), alice = user(), bob = user(), loner = user();
  const school = service.createSchool(alice, { name: 'Community High', location: 'Boston, MA', schedule: exampleSchedule });
  const other = service.createSchool(bob, { name: 'Other High', location: 'Boston, MA', schedule: exampleSchedule });
  service.join(alice, { schoolId: school.id, choice: 'community' });
  service.join(bob, { schoolId: other.id, choice: 'community' });
  const caller = (userId: string) => appRouter.createCaller({ service, userId, authAt: Date.now() });
  return { db, service, owner, alice, bob, loner, school, other, admin: caller(owner).admin, caller };
}

const guide = (text: string, image?: string): SetupGuide => ({ steps: [{ text, ...(image ? { image } : {}) }], note: '' });
const png = async () => (await sharp({ create: { width: 40, height: 20, channels: 3, background: '#336699' } }).png().toBuffer()).toString('base64');

const CALENDAR = DEFAULT_GUIDE_SETS.calendar.guides;

describe('setup guides', () => {
  it('gives every member the built-in guides and no platforms until support sets them', () => {
    const { service, alice, loner } = fixture();
    expect(service.workspace(alice).feedGuides).toEqual(DEFAULT_GUIDE_SETS.calendar);
    expect(service.workspace(loner).feedGuides).toEqual(DEFAULT_GUIDE_SETS.calendar);
  });

  it('shows a school its platforms, in a fixed order, and records the change', async () => {
    const { service, db, owner, alice, bob, school, admin } = fixture();
    expect(await admin.setGuidePlatforms({ accountId: owner, kind: 'calendar', schoolId: school.id, platforms: ['canvas', 'schoology', 'canvas'] })).toEqual(['schoology', 'canvas']);
    expect(service.workspace(alice).feedGuides.platforms).toEqual(['schoology', 'canvas']);
    expect(service.workspace(bob).feedGuides.platforms).toEqual([]);
    expect(service.school(school.id).feedPlatforms).toEqual(['schoology', 'canvas']);
    const row = db.prepare("SELECT detail FROM audit_log WHERE action='setupGuide.platforms'").get() as { detail: string };
    expect(JSON.parse(row.detail)).toEqual({ kind: 'calendar', from: [], to: ['schoology', 'canvas'] });
  });

  it('lets a school guide win over the shared one, which wins over the built-in one', async () => {
    const { service, owner, alice, bob, school, admin } = fixture();
    await admin.saveGuide({ accountId: owner, kind: 'calendar', schoolId: null, platform: 'schoology', guide: guide('Shared step') });
    await admin.saveGuide({ accountId: owner, kind: 'calendar', schoolId: school.id, platform: 'schoology', guide: { ...guide('Our step'), name: 'Schoology (FA)' } });
    expect(service.workspace(alice).feedGuides.guides.schoology).toEqual({ ...guide('Our step'), name: 'Schoology (FA)' });
    expect(service.workspace(bob).feedGuides.guides.schoology).toEqual(guide('Shared step'));
    expect(service.workspace(bob).feedGuides.guides.canvas).toEqual(CALENDAR.canvas);
    // Resetting the school's guide falls back to the shared one; resetting that falls back to the built-in one.
    await admin.saveGuide({ accountId: owner, kind: 'calendar', schoolId: school.id, platform: 'schoology', guide: null });
    expect(service.workspace(alice).feedGuides.guides.schoology).toEqual(guide('Shared step'));
    await admin.saveGuide({ accountId: owner, kind: 'calendar', schoolId: null, platform: 'schoology', guide: null });
    expect(service.workspace(alice).feedGuides.guides.schoology).toEqual(CALENDAR.schoology);
    const view = await admin.guides({ schoolId: school.id });
    expect(view.calendar.global.schoology).toBeNull();
    expect(view.calendar.school?.schoology).toBeNull();
  });

  it('refuses empty guides and screenshots that were never uploaded', async () => {
    const { owner, admin } = fixture();
    await expect(admin.saveGuide({ accountId: owner, kind: 'calendar', schoolId: null, platform: 'canvas', guide: { steps: [], note: '' } })).rejects.toThrow();
    await expect(admin.saveGuide({ accountId: owner, kind: 'calendar', schoolId: null, platform: 'canvas', guide: guide('   ') })).rejects.toThrow();
    await expect(admin.saveGuide({ accountId: owner, kind: 'calendar', schoolId: null, platform: 'canvas', guide: guide('Open Canvas', randomUUID()) })).rejects.toThrow(/screenshot/);
  });

  it('stores screenshots re-encoded and drops unused ones after a day', async () => {
    const { db, service, owner, admin } = fixture();
    const { id } = await admin.uploadGuideImage({ accountId: owner, data: await png() });
    const { id: unused } = await admin.uploadGuideImage({ accountId: owner, data: await png() });
    const images = new SetupGuideService(service);
    expect((await sharp(images.image(id)!).metadata()).format).toBe('webp');
    await expect(admin.uploadGuideImage({ accountId: owner, data: Buffer.from('not an image').toString('base64') })).rejects.toThrow(/image/);
    db.prepare('UPDATE feed_guide_images SET created_at=?').run(new Date(Date.now() - UNUSED_IMAGE_MS - 1000).toISOString());
    await admin.saveGuide({ accountId: owner, kind: 'calendar', schoolId: null, platform: 'canvas', guide: guide('Open Canvas', id) });
    expect(images.image(id)).not.toBeNull();
    expect(images.image(unused)).toBeNull();
  });

  it('keeps schedule guides apart from calendar guides, with their own platforms and extras', async () => {
    const { db, service, owner, alice, bob, school, admin } = fixture();
    expect(service.workspace(alice).scheduleGuides).toEqual(DEFAULT_GUIDE_SETS.schedule);
    expect(await admin.setGuidePlatforms({ accountId: owner, kind: 'schedule', schoolId: school.id, platforms: ['skyward', 'veracross'] })).toEqual(['veracross', 'skyward']);
    // A calendar platform is not a schedule platform, and the Veracross sync steps are not a tab to pick.
    await expect(admin.setGuidePlatforms({ accountId: owner, kind: 'schedule', schoolId: school.id, platforms: ['schoology'] })).rejects.toThrow();
    await expect(admin.setGuidePlatforms({ accountId: owner, kind: 'schedule', schoolId: school.id, platforms: ['veracross-sync'] })).rejects.toThrow();
    await expect(admin.saveGuide({ accountId: owner, kind: 'calendar', schoolId: null, platform: 'veracross', guide: guide('Nope') })).rejects.toThrow();
    // Both kinds have an "other"; saving one leaves the other alone.
    await admin.saveGuide({ accountId: owner, kind: 'schedule', schoolId: null, platform: 'other', guide: guide('Print it') });
    await admin.saveGuide({ accountId: owner, kind: 'schedule', schoolId: school.id, platform: 'veracross-sync', guide: guide('Our sync steps') });
    const mine = service.workspace(alice);
    expect(mine.scheduleGuides.platforms).toEqual(['veracross', 'skyward']);
    expect(mine.scheduleGuides.guides.other).toEqual(guide('Print it'));
    expect(mine.scheduleGuides.guides['veracross-sync']).toEqual(guide('Our sync steps'));
    expect(mine.feedGuides).toEqual(DEFAULT_GUIDE_SETS.calendar);
    expect(service.workspace(bob).scheduleGuides.guides['veracross-sync']).toEqual(DEFAULT_GUIDE_SETS.schedule.guides['veracross-sync']);
    expect(service.school(school.id)).toMatchObject({ feedPlatforms: [], schedulePlatforms: ['veracross', 'skyward'] });
    const view = await admin.guides({ schoolId: school.id });
    expect(view.schedule).toMatchObject({ platforms: ['veracross', 'skyward'], global: { other: guide('Print it'), veracross: null }, school: { 'veracross-sync': guide('Our sync steps') } });
    const row = db.prepare("SELECT detail FROM audit_log WHERE action='setupGuide.save' AND school_id=?").get(school.id) as { detail: string };
    expect(JSON.parse(row.detail)).toEqual({ kind: 'schedule', platform: 'veracross-sync', steps: 1 });
  });

  it('keeps a screenshot a schedule guide uses', async () => {
    const { db, service, owner, admin } = fixture();
    const { id } = await admin.uploadGuideImage({ accountId: owner, data: await png() });
    db.prepare('UPDATE feed_guide_images SET created_at=?').run(new Date(Date.now() - UNUSED_IMAGE_MS - 1000).toISOString());
    await admin.saveGuide({ accountId: owner, kind: 'schedule', schoolId: null, platform: 'aspen', guide: guide('Open Aspen', id) });
    await admin.saveGuide({ accountId: owner, kind: 'calendar', schoolId: null, platform: 'canvas', guide: guide('Open Canvas') });
    expect(new SetupGuideService(service).image(id)).not.toBeNull();
  });

  it('keeps the editing tools to the owner', async () => {
    const { alice, school, caller } = fixture();
    const student = caller(alice).admin;
    await expect(student.guides({ schoolId: null })).rejects.toThrow();
    await expect(student.saveGuide({ accountId: alice, kind: 'calendar', schoolId: null, platform: 'canvas', guide: guide('Hi') })).rejects.toThrow();
    await expect(student.setGuidePlatforms({ accountId: alice, kind: 'calendar', schoolId: school.id, platforms: ['canvas'] })).rejects.toThrow();
    await expect(student.uploadGuideImage({ accountId: alice, data: await png() })).rejects.toThrow();
  });
});
