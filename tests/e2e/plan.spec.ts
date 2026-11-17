import { test, expect, hydrating } from './fixtures';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { openDatabase } from '../../src/server/db';
import { createBeta, readBetaRegistry, writeBetaRegistry } from '../../src/server/beta-registry';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';
import { AI_BETA } from '../../src/domain/ai';

/** Stands in for the server's text model, like ai.spec.ts: it answers by what the system prompt asks for. */
const MOCK_PORT = Number(new URL(process.env.AI_API_URL ?? 'http://127.0.0.1:3198/v1').port);
let mock: Server;
const requests: Array<{ system: string; prompt: string }> = [];
const biology = randomUUID(), english = randomUUID();
const ZONE = exampleSchedule.timeZone;
/** The school's date `offset` days from now, and its time now. */
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: ZONE });
const nowMinutes = () => { const [hours, minutes] = new Date().toLocaleTimeString('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' }).split(':').map(Number); return hours * 60 + minutes; };
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });

/** Tests and quizzes get two 30-minute reviews, essays two 45-minute sessions, in the first slots before they're due. */
function planAnswer(prompt: string) {
  const slots = [...prompt.matchAll(/^- slot "([^"]+)": .*\((\d+) min\)$/gm)].map(([, id, minutes]) => ({ id, date: id.split('~')[0], room: Number(minutes) }));
  const tasks = [...prompt.matchAll(/^- id "([^"]+)": "(.*?)" \(.*?due (\d{4}-\d\d-\d\d)/gm)].map(([, id, title, due]) => ({ id, title, due }));
  const blocks: Array<{ slotId: string; taskId: string; minutes: number; kind: string; title: string }> = [];
  for (const task of tasks) {
    const review = /test|quiz/i.test(task.title), essay = /essay/i.test(task.title);
    if (!review && !essay) continue;
    const minutes = review ? 30 : 45;
    let left = 2;
    for (const slot of slots) {
      if (!left || slot.date >= task.due || slot.room < minutes || blocks.some((block) => block.slotId === slot.id && block.taskId === task.id)) continue;
      slot.room -= minutes; left -= 1;
      blocks.push({ slotId: slot.id, taskId: task.id, minutes, kind: review ? 'review' : 'work', title: review ? `Review for ${task.title}` : `Draft ${task.title}` });
    }
  }
  // A block in Biology class, which the server never offered: it must be dropped.
  if (tasks[0]) blocks.push({ slotId: `${day(0)}~p1`, taskId: tasks[0].id, minutes: 30, kind: 'review', title: 'In Biology class' });
  return { blocks };
}

test.beforeAll(async () => {
  mock = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: Array<{ content: string }> };
      const [system, prompt] = [body.messages[0].content, body.messages[1].content];
      requests.push({ system, prompt });
      const ids = [...prompt.matchAll(/^- id "([^"]+)": "(.*?)"/gm)].map(([, id, title]) => ({ id, title }));
      const answer = system.includes('"blocks"') ? planAnswer(prompt)
        : system.includes('"minutes"') ? { tasks: ids.map(({ id, title }) => ({ id, minutes: /essay/i.test(title) ? 140 : /lab report/i.test(title) ? 60 : /test/i.test(title) ? 90 : 20 })) }
        : system.includes('"groups"') ? { groups: [] }
        : system.includes('"kind"') ? { tasks: ids.map(({ id, title }) => ({ id, kind: /\btest\b/i.test(title) ? 'test' : 'none' })) }
        : { tasks: [] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  });
  await new Promise<void>(resolve => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
});
test.afterAll(async () => { await new Promise<void>(resolve => mock.close(() => resolve())); });

/**
 * A member in the ai-tasks beta with Biology in period A. Today gets two periods of its own a little after now (Biology,
 * then a free period B), so there is a free period left today wherever the clock is; null when it's too late for that.
 */
function seed() {
  const listPath = join(dirname(process.env.E2E_DATABASE_PATH!), 'betas.json');
  const registry = readBetaRegistry(listPath);
  if (!registry.betas.some(beta => beta.key === AI_BETA)) writeBetaRegistry(createBeta(registry, { key: AI_BETA, name: 'AI tasks', code: 'AI-TASKS-E2E' }), listPath);
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, 'Ada', 'Ada Tester', new Date().toISOString());
    const service = new Service(db, 'browser-owner@example.com');
    const school = service.createSchool(id, { name: `Plan High ${id.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
    const start = Math.ceil((nowMinutes() + 10) / 5) * 5;
    const freeToday = start + 85 <= 23 * 60 ? { start: hhmm(start + 45), end: hhmm(start + 85) } : null;
    const base = service.entity(id, 'personal')!;
    service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base, data: { ...base.data,
      classes: [{ id: biology, name: 'Biology' }, { id: english, name: 'English' }], assignments: { A: biology },
      dateOverrides: freeToday ? [{ date: day(0), closed: false, slots: [{ id: 'p1', periodId: 'A', start: hhmm(start), end: hhmm(start + 40) }, { id: 'p2', periodId: 'B', ...freeToday }] }] : [] } });
    const task = (title: string, dueDate: string, extra: Record<string, unknown> = {}) => {
      const taskId = randomUUID();
      service.sync(id, { mutationId: randomUUID(), id: taskId, kind: 'task', base: null, data: { title, dueDate, dueTime: null, classId: null, notes: '', completed: false, priority: 'normal', ...extra } });
      return taskId;
    };
    // Wednesday-ish (three days on) is heavy: the essay and the lab report are due together.
    const test = task('Study for Unit 4 Test', day(4), { classId: biology, dueTime: '08:00' });
    const essay = task('Essay on Macbeth', day(3), { classId: english, priority: 'high', notes: 'Write 1000 words.' });
    task('Lab report', day(3), { classId: biology, notes: 'Write 500 words.' });
    task('Vocab worksheet', day(1));
    db.prepare('INSERT INTO beta_members(beta_key,user_id,joined_at) VALUES(?,?,?)').run(AI_BETA, id, new Date().toISOString());
    return { id, test, essay, freeToday };
  } finally { db.close(); }
}

const contexts: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(contexts.splice(0).map((context) => context.close())); });
async function signedIn(browser: Browser, id: string, width = 390): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
  contexts.push(context);
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
  return hydrating(await context.newPage());
}
const blocks = (userId: string) => {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try { return db.prepare('SELECT id, date, start, slot_label, task_id, title, status FROM ai_plan_blocks WHERE owner_id=? ORDER BY date, start').all(userId) as Array<{ id: string; date: string; start: string; slot_label: string; task_id: string; title: string; status: string }>; }
  finally { db.close(); }
};
const shoot = async (page: Page, name: string) => {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: test.info().outputPath(`${name}-dark.png`), fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
};
const fitsWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('ai-tasks beta: Plan my week puts study blocks in free periods, and a heavy day gets a warning', async ({ browser }) => {
  test.setTimeout(150_000);
  const f = seed();
  const page = await signedIn(browser, f.id);
  await page.goto('/');
  const plan = page.getByRole('region', { name: 'Study plan' });
  await expect(plan.getByText('Study blocks for your tests and big work')).toBeVisible();

  // Estimates come in on their own; the essay and the lab report are due the same day.
  const heavy = page.getByRole('status', { name: 'Heavy days' });
  await expect(heavy.getByText('Workload ahead', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(heavy.getByText('~3 h 20 m', { exact: true })).toBeVisible();
  await heavy.getByRole('button', { expanded: false }).first().click();
  await expect(heavy.getByRole('button', { name: /^Essay on Macbeth/ })).toBeVisible();

  // Billing isn't set up here, so the button carries no Plus tag.
  await plan.getByRole('button', { name: 'Plan my week', exact: true }).click();
  await expect.poll(() => blocks(f.id).length, { timeout: 20_000 }).toBeGreaterThan(0);
  const stored = blocks(f.id);
  // The block the mock put in Biology class was dropped; nothing is on or after its task's due day.
  expect(stored.some((block) => block.title === 'In Biology class')).toBe(false);
  expect(stored.filter((block) => block.task_id === f.test).every((block) => block.date < day(4))).toBe(true);
  expect(stored.filter((block) => block.task_id === f.essay).every((block) => block.date < day(3))).toBe(true);
  const prompt = requests.find((request) => request.system.includes('"blocks"'))!.prompt;
  expect(prompt).not.toContain(`slot "${day(0)}~p1"`);
  expect(prompt).toMatch(/estimate 140 min/);

  if (f.freeToday) {
    const today = plan.getByRole('list', { name: 'Today’s study blocks' });
    await expect(today.getByText('Review for Study for Unit 4 Test').first()).toBeVisible();
    await expect(today.getByText(/^Free period B · /)).toBeVisible();
  } else {
    await expect(plan.getByText(/^Nothing planned for today\. Next: /)).toBeVisible();
  }
  expect(await fitsWidth(page)).toBe(true);
  await shoot(page, 'plan-today');

  // The week, with done and skip.
  await plan.getByRole('button', { name: 'Week' }).click();
  const sheet = page.getByRole('dialog', { name: 'Your week' });
  await expect(sheet.getByText('Draft Essay on Macbeth').first()).toBeVisible();
  await expect(sheet.getByText('For Essay on Macbeth').first()).toBeVisible();
  const first = blocks(f.id)[0];
  await sheet.getByRole('checkbox', { name: `Mark ${first.title} done` }).first().click();
  await expect.poll(() => blocks(f.id).find((block) => block.id === first.id)?.status).toBe('done');
  const second = blocks(f.id).find((block) => block.status === 'planned')!;
  await sheet.getByRole('button', { name: `Skip ${second.title}` }).first().click();
  await expect.poll(() => blocks(f.id).find((block) => block.id === second.id)?.status).toBe('skipped');
  await expect(sheet.getByText(/ · Skipped$/)).toBeVisible();
  await shoot(page, 'plan-week-sheet');
  await sheet.getByRole('button', { name: 'Done', exact: true }).click();

  // A block whose time has passed is offered for replanning; replanning keeps the done and skipped ones.
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try { db.prepare("UPDATE ai_plan_blocks SET date=? WHERE owner_id=? AND status='planned' AND id=(SELECT id FROM ai_plan_blocks WHERE owner_id=? AND status='planned' ORDER BY date, start LIMIT 1)").run(day(-1), f.id, f.id); }
  finally { db.close(); }
  await page.reload();
  await expect(plan.getByText('1 study block was missed.')).toBeVisible();
  await plan.getByRole('button', { name: 'Replan' }).click();
  await expect(plan.getByText('1 study block was missed.')).toHaveCount(0);
  const after = blocks(f.id);
  expect(after.filter((block) => block.status === 'done').map((block) => block.id)).toEqual([first.id]);
  expect(after.filter((block) => block.status === 'skipped').map((block) => block.id)).toEqual([second.id]);
  expect(after.some((block) => block.date === day(-1) && block.status === 'planned')).toBe(false);
  expect(requests.filter((request) => request.system.includes('"blocks"')).at(-1)!.prompt).toContain('Missed, plan again:');

  // Tasks: the minutes chip on each row and the same warning.
  await page.goto('/tasks');
  await expect(page.getByRole('status', { name: 'Heavy days' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Essay on Macbeth' }).getByText('~2 h 20 min')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Lab report' }).getByText('~1 h', { exact: true })).toBeVisible();
  // A task with no notes has too little detail to estimate, so its row carries no minutes chip.
  await expect(page.getByRole('listitem').filter({ hasText: 'Vocab worksheet' }).getByText(/^~\d/)).toHaveCount(0);
  expect(await fitsWidth(page)).toBe(true);
  await shoot(page, 'plan-tasks');
});

test('ai-tasks beta: the plan fits a 360 px phone, and members outside the beta see none of it', async ({ browser }) => {
  test.setTimeout(90_000);
  const f = seed();
  const page = await signedIn(browser, f.id, 360);
  await page.goto('/');
  const plan = page.getByRole('region', { name: 'Study plan' });
  await plan.getByRole('button', { name: 'Plan my week', exact: true }).click();
  await expect(plan.getByRole('button', { name: 'Week' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('status', { name: 'Heavy days' })).toBeVisible({ timeout: 20_000 });
  expect(await fitsWidth(page)).toBe(true);
  await shoot(page, 'plan-today-360');
  await plan.getByRole('button', { name: 'Week' }).click();
  await expect(page.getByRole('dialog', { name: 'Your week' })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  await shoot(page, 'plan-week-360');

  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try { db.prepare('DELETE FROM beta_members WHERE user_id=?').run(f.id); } finally { db.close(); }
  const outside = await signedIn(browser, f.id);
  await outside.goto('/');
  await expect(outside.getByRole('region', { name: /Do now/ })).toBeVisible();
  await expect(outside.getByRole('region', { name: 'Study plan' })).toHaveCount(0);
  await expect(outside.getByRole('status', { name: 'Heavy days' })).toHaveCount(0);
  await outside.goto('/tasks');
  await expect(outside.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  await expect(outside.getByText(/~\d/)).toHaveCount(0);
});
