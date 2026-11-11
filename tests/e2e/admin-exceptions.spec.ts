import { test, expect } from './fixtures';
import type { Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { encode } from 'next-auth/jwt';
import { openDatabase } from '../../src/server/db';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';
import { emptyPersonalSchedule, GRADES, resolveDay, scheduleForGrade, type Schedule } from '../../src/domain/schedule';

async function choose(select: Locator, option: string) {
  await select.click();
  await select.page().getByRole('option', { name: option, exact: true }).click();
}

test('school exception grade choices persist and reach only the selected grades without replacing their bell times', async ({ page, context }) => {
  test.setTimeout(90_000);
  const ownerId = randomUUID();
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  const ninth = structuredClone(exampleSchedule);
  ninth.cycleDays = ninth.cycleDays.map(day => ({ ...day, slots: day.slots.map((slot, index) => index === 0 ? { ...slot, start: '08:20' } : slot) }));
  const original: Schedule = { ...structuredClone(exampleSchedule), gradeSchedules: { '9': ninth } };
  let schoolId: string;
  let schoolName: string;
  try {
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)')
      .run(ownerId, ownerId, 'browser-owner@example.com', 'Exception Owner', 'Exception Test Owner', new Date().toISOString());
    const school = new Service(db, 'browser-owner@example.com').createSchool(ownerId, {
      name: `Exception High ${randomUUID()}`, location: 'Boston, MA', schedule: original,
    });
    schoolId = school.id;
    schoolName = school.name;
  } finally { db.close(); }
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: ownerId, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true }]);

  const sheet = page.getByRole('dialog');
  const grades = sheet.getByRole('group', { name: 'Grades for this exception', exact: true });
  const publish = async () => {
    await sheet.getByRole('button', { name: 'Save school revision', exact: true }).click();
    await expect(sheet.getByRole('status').filter({ hasText: 'Published' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Save school revision', exact: true })).toBeDisabled();
  };
  const reopen = async () => {
    await page.reload();
    await page.getByRole('tab', { name: 'Schools', exact: true }).click();
    await page.getByRole('textbox', { name: 'Filter schools', exact: true }).fill(schoolName);
    await page.getByRole('button', { name: `Review ${schoolName}`, exact: true }).click();
    await sheet.getByRole('tab', { name: /^Exceptions/ }).click();
  };
  const addOn = async (date: string) => {
    await sheet.getByRole('button', { name: 'Add exception', exact: true }).click();
    await expect(grades.getByRole('button', { name: 'All grades', exact: true })).toHaveAttribute('aria-pressed', 'true');
    for (const grade of GRADES) await expect(grades.getByRole('button', { name: `Grade ${grade}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await sheet.getByLabel('Date', { exact: true }).fill(date);
    await sheet.getByLabel('Date', { exact: true }).press('Tab');
  };
  const readSchedule = () => {
    const connection = openDatabase(process.env.E2E_DATABASE_PATH!);
    try { return new Service(connection).school(schoolId).schedule; }
    finally { connection.close(); }
  };

  await page.goto('/admin');
  await reopen();
  await addOn('2026-09-17');
  await grades.getByRole('button', { name: 'Grade 11', exact: true }).click();
  await grades.getByRole('button', { name: 'Grade 12', exact: true }).click();
  await publish();
  await reopen();
  await sheet.getByRole('button', { name: 'Edit', exact: true }).click();
  for (const grade of GRADES) {
    await expect(grades.getByRole('button', { name: `Grade ${grade}`, exact: true })).toHaveAttribute('aria-pressed', grade === '9' || grade === '10' ? 'true' : 'false');
  }
  await expect(grades.getByRole('button', { name: 'All grades', exact: true })).toHaveAttribute('aria-pressed', 'false');
  let persisted = readSchedule();
  for (const grade of GRADES) {
    const personal = { ...emptyPersonalSchedule(), grade };
    expect(resolveDay(persisted, '2026-09-17', personal).closed).toBe(grade === '9' || grade === '10');
    expect(scheduleForGrade(persisted, grade).cycleDays).toEqual(scheduleForGrade(original, grade).cycleDays);
    expect(resolveDay(persisted, '2026-09-18', personal).periods[0].start).toBe(grade === '9' ? '08:20' : '08:00');
  }

  await addOn('2026-09-21');
  await sheet.getByRole('radio', { name: 'Special schedule', exact: true }).click();
  await sheet.getByRole('button', { name: 'Add period', exact: true }).click();
  await sheet.getByRole('textbox', { name: 'Slot 1 start', exact: true }).fill('9:30');
  await sheet.getByRole('textbox', { name: 'Slot 1 end', exact: true }).fill('10:30');
  await publish();
  await addOn('2026-09-22');
  await sheet.getByRole('radio', { name: 'Restart rotation', exact: true }).click();
  await choose(sheet.getByRole('combobox', { name: 'Rotation day on this date', exact: true }), 'Day 4');
  await publish();
  await reopen();
  await expect(sheet.getByRole('tab', { name: 'Exceptions · 3', exact: true })).toBeVisible();
  persisted = readSchedule();
  for (const grade of GRADES) {
    const personal = { ...emptyPersonalSchedule(), grade };
    expect(resolveDay(persisted, '2026-09-17', personal).closed).toBe(grade === '9' || grade === '10');
    const special = resolveDay(persisted, '2026-09-21', personal);
    expect(special.closed).toBe(false);
    expect(special.periods.map(period => [period.start, period.end])).toEqual([['09:30', '10:30']]);
    expect(resolveDay(persisted, '2026-09-22', personal).cycleDayId).toBe('day-4');
    expect(resolveDay(persisted, '2026-09-23', personal).cycleDayId).toBe('day-5');
    expect(scheduleForGrade(persisted, grade).cycleDays).toEqual(scheduleForGrade(original, grade).cycleDays);
  }

  await sheet.getByRole('tab', { name: 'Basics', exact: true }).click();
  await choose(sheet.getByRole('combobox', { name: 'School time zone', exact: true }), 'America/Chicago');
  await publish();
  await reopen();
  persisted = readSchedule();
  expect(persisted.timeZone).toBe('America/Chicago');
  for (const grade of GRADES) {
    const personal = { ...emptyPersonalSchedule(), grade };
    expect(scheduleForGrade(persisted, grade).timeZone).toBe(grade === '9' ? 'America/New_York' : 'America/Chicago');
    expect(scheduleForGrade(persisted, grade).cycleDays).toEqual(scheduleForGrade(original, grade).cycleDays);
    expect(resolveDay(persisted, '2026-09-17', personal).closed).toBe(grade === '9' || grade === '10');
    expect(resolveDay(persisted, '2026-09-21', personal).periods.map(period => [period.start, period.end])).toEqual([['09:30', '10:30']]);
    expect(resolveDay(persisted, '2026-09-22', personal).cycleDayId).toBe('day-4');
  }

  // Copy a rotation day's periods, then replace them with Grade 9's own Day 1 times after confirming.
  await addOn('2026-09-24');
  await sheet.getByRole('radio', { name: 'Special schedule', exact: true }).click();
  const copyFrom = sheet.getByRole('combobox', { name: 'Copy periods from', exact: true });
  await choose(copyFrom, `Day 2 · Grades 10, 11, 12 · ${exampleSchedule.cycleDays[1].slots.length} periods`);
  await expect(sheet.getByRole('combobox', { name: `Slot ${exampleSchedule.cycleDays[1].slots.length} period`, exact: true })).toBeVisible();
  await choose(copyFrom, `Day 1 · Grade 9 · ${ninth.cycleDays[0].slots.length} periods`);
  await sheet.getByRole('button', { name: 'Replace periods', exact: true }).click();
  await publish();
  persisted = readSchedule();
  for (const grade of GRADES) {
    const copied = resolveDay(persisted, '2026-09-24', { ...emptyPersonalSchedule(), grade });
    expect(copied.periods.map(period => [period.start, period.end])).toEqual(ninth.cycleDays[0].slots.map(slot => [slot.start, slot.end]));
  }
});

test('editing a school-default-only exception preserves its scope and rejects another default exception date', async ({ page, context }) => {
  test.setTimeout(90_000);
  const ownerId = randomUUID();
  const firstDate = '2026-09-17';
  const secondDate = '2026-09-18';
  const replacement: Schedule['exceptions'][number] = {
    date: firstDate, kind: 'replacement', advanceCycle: true,
    slots: [{ id: 'grade-nine-special', periodId: 'A', start: '10:00', end: '11:00' }],
  };
  const original: Schedule = {
    ...structuredClone(exampleSchedule),
    exceptions: [
      { date: firstDate, kind: 'closure', advanceCycle: false },
      { date: secondDate, kind: 'closure', advanceCycle: false },
    ],
    gradeSchedules: Object.fromEntries(GRADES.map(grade => [grade, {
      ...structuredClone(exampleSchedule), exceptions: grade === '9' ? [replacement] : [],
    }])),
  };
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  let schoolId: string;
  let schoolName: string;
  try {
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)')
      .run(ownerId, ownerId, 'browser-owner@example.com', 'Default Exception Owner', 'Default Exception Owner', new Date().toISOString());
    const school = new Service(db, 'browser-owner@example.com').createSchool(ownerId, {
      name: `Default Exception High ${randomUUID()}`, location: 'Boston, MA', schedule: original,
    });
    schoolId = school.id;
    schoolName = school.name;
  } finally { db.close(); }
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: ownerId, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true }]);
  const sheet = page.getByRole('dialog');
  const openDefault = async () => {
    await page.getByRole('tab', { name: 'Schools', exact: true }).click();
    await page.getByRole('textbox', { name: 'Filter schools', exact: true }).fill(schoolName);
    await page.getByRole('button', { name: `Review ${schoolName}`, exact: true }).click();
    await sheet.getByRole('tab', { name: /^Exceptions/ }).click();
    await sheet.getByRole('button', { name: `Remove exception on ${firstDate} for the school default`, exact: true })
      .locator('..').getByRole('button', { name: 'Edit', exact: true }).click();
  };
  const readSchedule = () => {
    const connection = openDatabase(process.env.E2E_DATABASE_PATH!);
    try { return new Service(connection).school(schoolId).schedule; }
    finally { connection.close(); }
  };
  await page.goto('/admin');
  await openDefault();
  const grades = sheet.getByRole('group', { name: 'Grades for this exception', exact: true });
  for (const grade of GRADES) await expect(grades.getByRole('button', { name: `Grade ${grade}`, exact: true })).toHaveAttribute('aria-pressed', 'false');
  const advance = sheet.getByRole('switch', { name: 'The rotation still advances past this date', exact: true });
  await expect(advance).not.toBeChecked();
  await advance.click();
  await sheet.getByRole('button', { name: 'Save school revision', exact: true }).click();
  await expect(sheet.getByRole('status').filter({ hasText: 'Published' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Save school revision', exact: true })).toBeDisabled();
  await page.reload();
  await openDefault();
  await expect(advance).toBeChecked();
  await expect(grades.getByRole('button', { name: 'All grades', exact: true })).toHaveAttribute('aria-pressed', 'false');
  for (const grade of GRADES) await expect(grades.getByRole('button', { name: `Grade ${grade}`, exact: true })).toHaveAttribute('aria-pressed', 'false');
  const persisted = readSchedule();
  expect([...persisted.exceptions].sort((left, right) => left.date.localeCompare(right.date)))
    .toEqual([{ date: firstDate, kind: 'closure', advanceCycle: true }, original.exceptions[1]]);
  for (const grade of GRADES) {
    expect(scheduleForGrade(persisted, grade)).toEqual(scheduleForGrade(original, grade));
    expect(resolveDay(persisted, firstDate, { ...emptyPersonalSchedule(), grade }).closed).toBe(false);
  }
  expect(resolveDay(persisted, firstDate, { ...emptyPersonalSchedule(), grade: '9' }).periods.map(period => [period.start, period.end]))
    .toEqual([['10:00', '11:00']]);

  const date = sheet.getByLabel('Date', { exact: true });
  await date.fill(secondDate);
  await expect(date).toHaveAttribute('aria-invalid', 'true');
  await expect(sheet.getByText('Another exception already uses this date.', { exact: true })).toBeVisible();
  await grades.getByRole('button', { name: 'All grades', exact: true }).focus();
  await expect(date).toHaveValue(firstDate);
  await expect(sheet.getByRole('button', { name: 'Save school revision', exact: true })).toBeDisabled();
  expect(readSchedule()).toEqual(persisted);
});
