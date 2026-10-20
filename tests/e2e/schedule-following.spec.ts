import { test, expect, hydrating } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/server/db';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';
import { diffCycleDaySlots, personalScheduleSchema } from '../../src/domain/schedule';

function database<T>(run: (db: ReturnType<typeof openDatabase>, service: Service) => T): T {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try { return run(db, new Service(db, 'browser-owner@example.com')); }
  finally { db.close(); }
}

function seed(locked = false) {
  return database((db, service) => {
    const members = Array.from({ length: locked ? 10 : 1 }, (_, index) => {
      const id = randomUUID();
      db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, id, `${id}@example.com`, `Follower ${index}`, `Follower Student ${index}`, new Date().toISOString());
      return id;
    });
    const school = service.createSchool(members[0], { name: `Following High ${members[0].slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    for (const id of members) {
      service.join(id, { schoolId: school.id, choice: 'community', grade: '10' });
      if (locked) db.prepare('INSERT INTO school_verifications(user_id,school_id,method,verified_at) VALUES(?,?,?,?)')
        .run(id, school.id, 'support', new Date().toISOString());
    }
    return { id: members[0], members, school };
  });
}

async function authenticate(context: BrowserContext, id: string) {
  // The documented fixture issues a regular encrypted session, without bypassing application authorization.
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
}

const personal = (id: string) => database((_db, service) => personalScheduleSchema.parse(service.entity(id, 'personal')!.data));
const school = (id: string) => database((_db, service) => service.school(id));
const proposals = (schoolId: string) => database((db) => db.prepare('SELECT schedule,summary,status FROM schedule_proposals WHERE school_id=?').all(schoolId) as { schedule: string; summary: string; status: string }[]);

async function editFirstTime(page: Page, start = '8:05 am') {
  await page.getByRole('button', { name: 'Edit times for Day 1', exact: true }).click();
  await page.getByLabel('Slot 1 start', { exact: true }).fill(start);
  await page.getByRole('button', { name: 'Save times', exact: true }).click();
  await expect(page.getByText('Who needs this time change?', { exact: true })).toBeVisible();
}

test('school followers choose before saving times, and adopted changes follow school updates again', async ({ page, context }) => {
  const f = seed();
  await authenticate(context, f.id);
  await page.goto('/classes');
  await expect(page.getByRole('group', { name: 'Day 1 time canvas', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add rotation day', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Remove Day \d+$/ })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /^Day \d+ name$/ })).toHaveCount(0);
  const before = personal(f.id);
  await editFirstTime(page);
  expect(personal(f.id)).toEqual(before);
  expect(school(f.school.id).schedule).toEqual(f.school.schedule);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText('Who needs this time change?', { exact: true })).toHaveCount(0);
  await page.reload();
  expect(personal(f.id)).toEqual(before);
  await expect(page.getByRole('group', { name: 'Day 1 time canvas', exact: true }).getByRole('button', { name: 'Day 1, 8:00–9:00 AM: A', exact: true })).toBeVisible();

  await editFirstTime(page);
  await page.getByRole('button', { name: 'Only for me', exact: true }).click();
  await expect.poll(() => personal(f.id).cycleDayOverrides).toEqual([
    { cycleDayId: 'day-1', slotChanges: { first: { start: '08:05', base: exampleSchedule.cycleDays[0].slots[0] } } },
  ]);
  expect(personal(f.id).customSchedule).toBeNull();
  expect(school(f.school.id).schedule).toEqual(f.school.schedule);
  await page.reload();
  await expect(page.getByRole('group', { name: 'Day 1 time canvas', exact: true }).getByRole('button', { name: 'Day 1, 8:05–9:00 AM: A', exact: true })).toBeVisible();

  // Publish the same correction plus an unrelated block change through the normal service.
  database((_db, service) => {
    const next = structuredClone(f.school.schedule);
    next.cycleDays[0].slots[0].start = '08:05';
    next.cycleDays[0].slots[1].start = '09:15';
    service.updateSchool(f.id, { schoolId: f.school.id, expectedVersion: f.school.version, schedule: next });
  });
  expect(personal(f.id).cycleDayOverrides).toEqual([]);
  await page.reload();
  const day = page.getByRole('group', { name: 'Day 1 time canvas', exact: true });
  await expect(day.getByRole('button', { name: 'Day 1, 8:05–9:00 AM: A', exact: true })).toBeVisible();
  await expect(day.getByRole('button', { name: 'Day 1, 9:15–10:10 AM: B', exact: true })).toBeVisible();
  expect(personal(f.id).customSchedule).toBeNull();
});

test('a locked school time correction opens a prefilled proposal and uses verified member voting', async ({ page, context, browser }) => {
  const f = seed(true);
  await authenticate(context, f.id);
  await page.goto('/classes');
  const before = personal(f.id);
  await editFirstTime(page);
  await page.getByRole('button', { name: "The school's time is wrong", exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Propose a schedule change', exact: true });
  await expect(dialog).toBeVisible();
  // A prefilled schedule makes a summary sufficient to submit. No editor changes are required.
  await dialog.getByLabel('What changes and why?').fill('Day 1 starts at 8:05 according to the corrected school bell schedule.');
  await expect(dialog.getByRole('button', { name: 'Open the vote', exact: true })).toBeEnabled();
  expect(proposals(f.school.id)).toEqual([]);
  expect(personal(f.id)).toEqual(before);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(proposals(f.school.id)).toEqual([]);
  expect(personal(f.id)).toEqual(before);
  expect(school(f.school.id).version).toBe(f.school.version);

  await page.getByRole('button', { name: "The school's time is wrong", exact: true }).click();
  const summary = 'Correct Day 1 first period to start at 8:05 as printed by the school.';
  await dialog.getByLabel('What changes and why?').fill(summary);
  await dialog.getByRole('button', { name: 'Open the vote', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => proposals(f.school.id).length).toBe(1);
  const draft = JSON.parse(proposals(f.school.id)[0].schedule);
  expect(draft.gradeSchedules['10'].cycleDays[0].slots[0].start).toBe('08:05');
  expect(personal(f.id)).toEqual(before);
  expect(school(f.school.id).version).toBe(f.school.version);
  await page.goto('/school');
  const card = page.getByRole('listitem').filter({ hasText: summary });
  await expect(card).toContainText('Voting open');
  await expect(card).toContainText('1 for · 0 against');
  await expect(card.getByRole('button', { name: 'For', exact: true })).toHaveAttribute('aria-pressed', 'true');

  const voterContext = await browser.newContext();
  try {
    await authenticate(voterContext, f.members[1]);
    const voter = hydrating(await voterContext.newPage());
    await voter.goto('/school');
    const voterCard = voter.getByRole('listitem').filter({ hasText: summary });
    await voterCard.getByRole('button', { name: 'Against', exact: true }).click();
    await expect(voterCard).toContainText('1 for · 1 against');
    await voterCard.getByRole('button', { name: 'For', exact: true }).click();
    await expect(voterCard).toContainText('2 for · 0 against');
  } finally { await voterContext.close(); }
});

test('private schedules require the advanced warning and suggestions need three other classmates', async ({ page, context }) => {
  const f = seed(true);
  await authenticate(context, f.id);
  await page.goto('/classes');
  const advanced = page.getByRole('button', { name: 'Advanced schedule settings', exact: true });
  await expect(advanced).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Build a private schedule', exact: true })).toHaveCount(0);
  await advanced.click();
  await page.getByRole('button', { name: 'Build a private schedule', exact: true }).click();
  const warning = page.getByRole('dialog', { name: 'Build a private schedule?', exact: true });
  await expect(warning).toContainText('Future school corrections will no longer reach your timetable.');
  await expect(warning.getByRole('button', { name: 'Continue to private schedule', exact: true })).toBeVisible();
  await warning.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(personal(f.id).customSchedule).toBeNull();

  const adjustPeer = (id: string) => database((db, service) => {
    const next = personalScheduleSchema.parse(service.entity(id, 'personal')!.data);
    const day = exampleSchedule.cycleDays[0];
    next.cycleDayOverrides = [diffCycleDaySlots(day, day.slots.map(slot => slot.id === 'first' ? { ...slot, start: '08:05' } : slot))!];
    db.prepare("UPDATE entities SET data=?,version=version+1 WHERE owner_id=? AND id='personal'").run(JSON.stringify(next), id);
  });
  adjustPeer(f.members[1]);
  adjustPeer(f.members[2]);
  const [suggestionResponse] = await Promise.all([
    page.waitForResponse(response => response.url().includes('scheduleSignals.list') && response.ok()),
    page.goto('/school'),
  ]);
  const replies = await suggestionResponse.json() as { result?: { data?: { signals?: unknown[] } } }[];
  expect(replies.find(reply => reply.result?.data?.signals)?.result?.data?.signals).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Proposed changes', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Schedule suggestions', exact: true })).toHaveCount(0);
  adjustPeer(f.members[3]);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Schedule suggestions', exact: true })).toBeVisible();
  await expect(page.getByText('3 classmates moved this block. Propose it?', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review proposal', exact: true }).click();
  const proposal = page.getByRole('dialog', { name: 'Propose a schedule change', exact: true });
  await expect(proposal.getByLabel('What changes and why?')).toHaveValue('Change A on Day 1 to 08:05 to 09:00 for grade 10.');
  await expect(proposal.getByRole('button', { name: 'Open the vote', exact: true })).toBeEnabled();
  expect(proposals(f.school.id)).toEqual([]);
});
