import { test, expect, hydrating } from './fixtures';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { openDatabase } from '../../src/server/db';
import { Service } from '../../src/server/service';
import { BetaService } from '../../src/server/betas';
import { createBeta, readBetaRegistry, writeBetaRegistry } from '../../src/server/beta-registry';
import { SCHEDULE_FOLLOWING_BETA } from '../../src/domain/betas';
import { exampleSchedule } from '../../src/domain/example';
import { cycleDaySlots, diffCycleDaySlots, personalScheduleSchema } from '../../src/domain/schedule';

const BETA_CODE = 'SCHOOL-FOLLOWING-E2E';
const BETA_NAME = 'School schedule following';

function database<T>(run: (db: ReturnType<typeof openDatabase>, service: Service) => T): T {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  const previousBetasPath = process.env.BETAS_PATH;
  process.env.BETAS_PATH = join(dirname(process.env.E2E_DATABASE_PATH!), 'betas.json');
  try { return run(db, new Service(db, 'browser-owner@example.com')); }
  finally {
    db.close();
    if (previousBetasPath === undefined) delete process.env.BETAS_PATH;
    else process.env.BETAS_PATH = previousBetasPath;
  }
}

function prepareBeta(service: Service) {
  // Synthetic registry beside the throwaway database, matching the documented CLI's file format.
  const listPath = join(dirname(process.env.E2E_DATABASE_PATH!), 'betas.json');
  const registry = readBetaRegistry(listPath);
  if (!registry.betas.some(beta => beta.key === SCHEDULE_FOLLOWING_BETA)) {
    writeBetaRegistry(createBeta(registry, { key: SCHEDULE_FOLLOWING_BETA, name: BETA_NAME, description: 'Try personal bell-time changes while following school corrections.', code: BETA_CODE }), listPath);
  }
  return new BetaService(service, () => readBetaRegistry(listPath));
}

function seed(locked = false, enroll = true, schedule = exampleSchedule) {
  return database((db, service) => {
    const betas = prepareBeta(service);
    const members = Array.from({ length: locked ? 10 : 1 }, (_, index) => {
      const id = randomUUID();
      db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, id, `${id}@example.com`, `Follower ${index}`, `Follower Student ${index}`, new Date().toISOString());
      return id;
    });
    const school = service.createSchool(members[0], { name: `Following High ${members[0].slice(0, 6)}`, location: 'Boston, MA', schedule });
    for (const id of members) {
      service.join(id, { schoolId: school.id, choice: 'community', grade: '10' });
      if (enroll) betas.join(id, { code: BETA_CODE });
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
const saved = (page: Page) => page.getByRole('status').filter({ hasText: /^Saved$/ }).first();
async function choose(select: Locator, option: string) {
  await select.click();
  await select.page().getByRole('option', { name: option, exact: true }).click();
}

async function editFirstTime(page: Page, start = '8:05 am') {
  const unlock = page.getByRole('button', { name: 'Unlock bell times', exact: true });
  if (await unlock.isVisible()) await unlock.click();
  await expect(page.getByRole('button', { name: 'Lock bell times', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit times for Day 1', exact: true }).click();
  await page.getByLabel('Slot 1 start', { exact: true }).fill(start);
  await page.getByRole('button', { name: 'Save times', exact: true }).click();
  await expect(page.getByText('Who needs this time change?', { exact: true })).toBeVisible();
}

test('beta bell times start locked while class placement works, and relocking survives reload', async ({ page, context, browser }) => {
  const f = seed(true, false);
  database((_db, service) => new BetaService(service).join(f.id, { code: BETA_CODE }));
  await authenticate(context, f.id);
  await page.goto('/classes');
  const unlock = page.getByRole('button', { name: 'Unlock bell times', exact: true });
  const editTimes = page.getByRole('button', { name: 'Edit times for Day 1', exact: true });
  const day = page.getByRole('group', { name: 'Day 1 time canvas', exact: true });
  const resize = day.getByRole('button', { name: 'Resize Day 1 A end', exact: true });
  await expect(unlock).toBeVisible();
  await expect(editTimes).toBeDisabled();
  await expect(resize).toBeDisabled();

  await page.getByRole('button', { name: 'Add class', exact: true }).click();
  const classForm = page.getByRole('dialog', { name: 'Add a class', exact: true });
  await classForm.getByLabel('Class name').fill('Biology');
  await classForm.getByRole('button', { name: 'Add class', exact: true }).click();
  await expect(classForm).toHaveCount(0);
  await page.getByRole('button', { name: 'Place Biology', exact: true }).click();
  await day.getByRole('button', { name: 'Day 1, 8:00–9:00 AM: A', exact: true }).click();
  await expect(day.getByRole('button', { name: 'Day 1, 8:00–9:00 AM: Biology', exact: true })).toBeVisible();
  await expect.poll(() => personal(f.id).assignments).toEqual({ A: 'Biology' });
  expect(personal(f.id).cycleDayOverrides).toEqual([]);
  await expect(unlock).toBeVisible();

  await unlock.click();
  await expect(editTimes).toBeEnabled();
  await expect(resize).toBeEnabled();
  await resize.press('ArrowUp');
  await expect(page.getByText('Who needs this time change?', { exact: true })).toBeVisible();
  expect(personal(f.id).cycleDayOverrides).toEqual([]);
  await page.getByRole('button', { name: 'Only for me', exact: true }).click();
  await expect.poll(() => personal(f.id).cycleDayOverrides[0]?.slotChanges?.first?.end).toBe('08:55');
  await expect(day.getByRole('button', { name: 'Day 1, 8:00–8:55 AM: Biology', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Lock bell times', exact: true }).click();
  await expect(editTimes).toBeDisabled();
  await expect(resize).toBeDisabled();
  const lockedPersonal = personal(f.id);
  await page.reload();
  await expect(unlock).toBeVisible();
  await expect(editTimes).toBeDisabled();
  await expect(resize).toBeDisabled();
  await page.getByRole('button', { name: 'Place Biology', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Place in Day 1 at 1:00 PM', exact: true })).toBeDisabled();
  expect(personal(f.id)).toEqual(lockedPersonal);

  const nonmemberContext = await browser.newContext();
  try {
    await authenticate(nonmemberContext, f.members[1]);
    const nonmember = hydrating(await nonmemberContext.newPage());
    await nonmember.goto('/classes');
    await expect(nonmember.getByRole('button', { name: 'Edit times for Day 1', exact: true })).toBeEnabled();
    await expect(nonmember.getByRole('button', { name: 'Unlock bell times', exact: true })).toHaveCount(0);
    await expect(nonmember.getByRole('button', { name: 'Lock bell times', exact: true })).toHaveCount(0);
  } finally { await nonmemberContext.close(); }
});

test('the schedule beta is opt-in per account and leaving preserves saved classes and bell times', async ({ page, context, browser }) => {
  test.setTimeout(120_000);
  const f = seed(true, false);
  await authenticate(context, f.id);
  await page.goto('/classes');
  const addDay = page.getByRole('button', { name: 'Add rotation day', exact: true });
  await expect(addDay).toBeVisible();
  await expect(page.getByLabel('Day 1 name', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add class', exact: true }).click();
  const classForm = page.getByRole('dialog', { name: 'Add a class', exact: true });
  await classForm.getByLabel('Class name').fill('Biology');
  await classForm.getByRole('button', { name: 'Add class', exact: true }).click();
  await expect(classForm).toHaveCount(0);
  const day = page.getByRole('group', { name: 'Day 1 time canvas', exact: true });
  await page.getByRole('button', { name: 'Place Biology', exact: true }).click();
  await day.getByRole('button', { name: 'Day 1, 8:00–9:00 AM: A', exact: true }).click();
  await expect(saved(page)).toBeVisible();

  await page.getByRole('button', { name: /^Follower 0 / }).click();
  const account = page.getByRole('dialog', { name: 'Account', exact: true });
  await account.getByRole('textbox', { name: 'Beta code', exact: true }).fill(BETA_CODE);
  await account.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(account.getByRole('list', { name: 'Your betas' })).toContainText(BETA_NAME);
  await account.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(addDay).toHaveCount(0);
  await expect(page.getByLabel('Day 1 name', { exact: true })).toHaveCount(0);

  // A schoolmate sees the original UI even though someone at the same school joined the beta.
  const schoolmateContext = await browser.newContext();
  try {
    await authenticate(schoolmateContext, f.members[1]);
    const schoolmate = hydrating(await schoolmateContext.newPage());
    await schoolmate.goto('/classes');
    await expect(schoolmate.getByRole('button', { name: 'Add rotation day', exact: true })).toBeVisible();
    await expect(schoolmate.getByLabel('Day 1 name', { exact: true })).toBeVisible();
  } finally { await schoolmateContext.close(); }

  await editFirstTime(page);
  await page.getByRole('button', { name: 'Only for me', exact: true }).click();
  await expect.poll(() => personal(f.id).cycleDayOverrides[0]?.slotChanges?.first?.start).toBe('08:05');
  const savedPersonal = personal(f.id);
  expect(savedPersonal.classes).toEqual([expect.objectContaining({ name: 'Biology' })]);
  expect(savedPersonal.assignments).toEqual({ A: 'Biology' });
  expect(savedPersonal.customSchedule).toBeNull();
  const expectLegacyTimetablePreserved = () => {
    const current = personal(f.id);
    expect(current.classes).toEqual(savedPersonal.classes);
    expect(current.assignments).toEqual(savedPersonal.assignments);
    expect(current.dateOverrides).toEqual(savedPersonal.dateOverrides);
    expect(current.grade).toBe(savedPersonal.grade);
    expect(current.customSchedule).toBeNull();
    expect(current.cycleDayOverrides).toHaveLength(1);
    expect(current.cycleDayOverrides[0].slots).toBeDefined();
    expect(current.cycleDayOverrides[0].slotChanges).toBeUndefined();
    for (const rotationDay of f.school.schedule.cycleDays) {
      expect(cycleDaySlots(rotationDay, current)).toEqual(cycleDaySlots(rotationDay, savedPersonal));
    }
  };

  await page.getByRole('button', { name: /^Follower 0 / }).click();
  await account.getByRole('button', { name: `Leave ${BETA_NAME}`, exact: true }).click();
  await expect(account.getByRole('list', { name: 'Your betas' })).toHaveCount(0);
  await account.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(addDay).toBeVisible();
  await expect(page.getByLabel('Day 1 name', { exact: true })).toBeVisible();
  await expect(day.getByRole('button', { name: 'Day 1, 8:05–9:00 AM: Biology', exact: true })).toBeVisible();
  expectLegacyTimetablePreserved();
  await page.reload();
  await expect(addDay).toBeVisible();
  await expect(day.getByRole('button', { name: 'Day 1, 8:05–9:00 AM: Biology', exact: true })).toBeVisible();

  await page.getByRole('button', { name: /^Follower 0 / }).click();
  await account.getByRole('textbox', { name: 'Beta code', exact: true }).fill(BETA_CODE);
  await account.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(account.getByRole('list', { name: 'Your betas' })).toContainText(BETA_NAME);
  await page.goto('/classes?beta=off');
  await expect(page).toHaveURL(/\/classes$/);
  await expect(addDay).toBeVisible();
  await expect(day.getByRole('button', { name: 'Day 1, 8:05–9:00 AM: Biology', exact: true })).toBeVisible();
  expect(database((_db, service) => new BetaService(service).joined(f.id))).toEqual([]);
  expectLegacyTimetablePreserved();
});

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
  adjustPeer(f.members[3]);
  database((_db, service) => new BetaService(service).leave(f.members[3], SCHEDULE_FOLLOWING_BETA));
  const [suggestionResponse] = await Promise.all([
    page.waitForResponse(response => response.url().includes('scheduleSignals.list') && response.ok()),
    page.goto('/school'),
  ]);
  const replies = await suggestionResponse.json() as { result?: { data?: { signals?: unknown[] } } }[];
  expect(replies.find(reply => reply.result?.data?.signals)?.result?.data?.signals).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Proposed changes', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Schedule suggestions', exact: true })).toHaveCount(0);
  database((_db, service) => new BetaService(service).join(f.members[3], { code: BETA_CODE }));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Schedule suggestions', exact: true })).toBeVisible();
  await expect(page.getByText('3 classmates moved this block. Propose it?', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review proposal', exact: true }).click();
  const proposal = page.getByRole('dialog', { name: 'Propose a schedule change', exact: true });
  await expect(proposal.getByLabel('What changes and why?')).toHaveValue('Change A on Day 1 to 08:05 to 09:00 for grade 10.');
  await expect(proposal.getByRole('button', { name: 'Open the vote', exact: true })).toBeEnabled();
  expect(proposals(f.school.id)).toEqual([]);
});

test('bell corrections keep the selected grade and preserve a canceled personal editor draft', async ({ page, context }) => {
  const junior = structuredClone(exampleSchedule);
  junior.cycleDays[0].label = 'Junior day';
  junior.cycleDays[0].slots[0].end = '08:50';
  const fixture = seed(false, true, { ...exampleSchedule, gradeSchedules: { '11': junior } });
  await authenticate(context, fixture.id);
  await page.goto('/school');
  await page.getByRole('radiogroup', { name: 'Your grade', exact: true }).getByRole('radio', { name: 'Grade 11', exact: true }).click();
  await expect(saved(page)).toBeVisible();
  await page.goto('/classes?bell=open');
  await page.getByRole('button', { name: "The school's time is wrong", exact: true }).click();
  const shared = page.getByRole('dialog', { name: 'Edit the shared schedule', exact: true });
  await shared.getByRole('tab', { name: /Days ·/ }).click();
  await expect(shared.getByLabel('Day 1 name', { exact: true })).toHaveValue('Junior day');
  await shared.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('dialog', { name: 'Change bell times', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await choose(page.getByLabel('Adjust a rotation day', { exact: true }), 'Junior day');
  const adjustment = page.getByRole('dialog', { name: 'Adjust Junior day', exact: true });
  await adjustment.getByRole('switch', { name: 'Use my own periods on Junior day', exact: true }).click();
  await adjustment.getByLabel('Slot 1 end', { exact: true }).fill('08:45 AM');
  await adjustment.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: "The school's time is wrong", exact: true }).click();
  await shared.getByRole('tab', { name: /Days ·/ }).click();
  await expect(shared.getByLabel('Day 1 name', { exact: true })).toHaveValue('Junior day');
  await shared.getByRole('button', { name: 'Edit times for Junior day', exact: true }).click();
  await expect(shared.getByLabel('Slot 1 end', { exact: true })).toHaveValue('8:45');
  await shared.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('dialog', { name: 'Change bell times', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(adjustment.getByLabel('Slot 1 end', { exact: true })).toHaveValue('8:45');
  await adjustment.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Only for me', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Change bell times', exact: true })).toHaveCount(0);
  await expect(adjustment).toHaveCount(0);
  await expect.poll(() => {
    const db = openDatabase(process.env.E2E_DATABASE_PATH!);
    try {
      const personal = personalScheduleSchema.parse(new Service(db).workspace(fixture.id).entities.find(entry => entry.kind === 'personal')!.data);
      return cycleDaySlots(junior.cycleDays[0], personal)[0].end;
    } finally { db.close(); }
  }).toBe('08:45');
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const service = new Service(db);
    const personal = personalScheduleSchema.parse(service.workspace(fixture.id).entities.find(entry => entry.kind === 'personal')!.data);
    expect(personal.customSchedule).toBeNull();
    expect(cycleDaySlots(junior.cycleDays[0], personal)[0].end).toBe('08:45');
    expect(service.school(fixture.school.id).schedule.gradeSchedules?.['11']?.cycleDays[0].slots[0].end).toBe('08:50');
    expect(service.school(fixture.school.id).schedule.cycleDays[0].slots[0].end).toBe('09:00');
  } finally { db.close(); }
});
