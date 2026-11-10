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

/** Stands in for the server's text model; the config points AI_API_URL here. */
const MOCK_PORT = Number(new URL(process.env.AI_API_URL ?? 'http://127.0.0.1:3198/v1').port);
let mock: Server;
const requests: Array<{ model: string; system: string; prompt: string }> = [];
const spanish = randomUUID(), biology = randomUUID();
/** A date `offset` days from today: fixed dates in seeds turn into "tomorrow" as the calendar catches up. */
const fromToday = (offset: number) => { const date = new Date(); date.setDate(date.getDate() + offset); return date.toLocaleDateString('en-CA'); };
/** "Mystery" tasks are skipped the first time the model sees them, so auto-sort leaves one for the manual sheet. */
const seen = new Set<string>();

test.beforeAll(async () => {
  mock = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw) as { model: string; messages: Array<{ content: string }> };
      const [system, prompt] = [body.messages[0].content, body.messages[1].content];
      requests.push({ model: body.model, system, prompt });
      const ids = [...prompt.matchAll(/^- id "([^"]+)": "(.*)"$/gm)].map(([, id, title]) => ({ id, title }));
      // Duplicates: the same title once case and punctuation are ignored is sure; two "Essay" tasks are a maybe.
      const listed = [...prompt.matchAll(/^- id "([^"]+)"(?: NEW)?: "(.*?)" \(/gm)].map(([, id, title]) => ({ id, title, key: title.toLowerCase().replace(/[^a-z0-9]/g, '') }));
      const answer = system.includes('"groups"')
        ? { groups: [...Object.values(Object.groupBy(listed, (entry) => entry.key)).filter((group) => group!.length > 1).map((group) => ({ ids: group!.map((entry) => entry.id), reason: 'Same homework', sure: true })),
          ...(listed.filter((entry) => entry.title.startsWith('Essay')).length > 1 ? [{ ids: listed.filter((entry) => entry.title.startsWith('Essay')).map((entry) => entry.id), reason: 'Maybe the same essay', sure: false }] : [])] }
        : system.includes('"kind"')
        ? { tasks: ids.map(({ id, title }) => ({ id, kind: /quiz|prueba|pop check/i.test(title) ? 'quiz' : /\btest\b/i.test(title) ? 'test' : 'none' })) }
        : system.includes('"steps"')
        ? { steps: ['Review the vocabulary list', 'Practice present-tense endings', 'Take the practice quiz'] }
        : { tasks: ids.filter(({ id, title }) => { const first = !seen.has(id); seen.add(id); return !(title.startsWith('Mystery') && first); }).map(({ id, title }) => title.startsWith('Quiz')
          ? { id, classId: spanish, priority: 'high', workLocation: 'in-class', reason: 'Spanish quiz', sure: true }
          : { id, classId: biology, priority: 'normal', workLocation: 'out-of-class', reason: 'Lab', sure: false }) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  });
  await new Promise<void>(resolve => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
});
test.afterAll(async () => { await new Promise<void>(resolve => mock.close(() => resolve())); });

/** A member in the ai-tasks beta with two classes and two imported-looking tasks that have no class or priority. */
function seed() {
  const listPath = join(dirname(process.env.E2E_DATABASE_PATH!), 'betas.json');
  const registry = readBetaRegistry(listPath);
  if (!registry.betas.some(beta => beta.key === AI_BETA)) writeBetaRegistry(createBeta(registry, { key: AI_BETA, name: 'AI tasks', code: 'AI-TASKS-E2E' }), listPath);
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, 'Ada', 'Ada Tester', new Date().toISOString());
    const service = new Service(db, 'browser-owner@example.com');
    const school = service.createSchool(id, { name: `AI High ${id.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
    const base = service.entity(id, 'personal')!;
    service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base,
      data: { ...base.data, classes: [{ id: spanish, name: 'Spanish 2' }, { id: biology, name: 'Biology' }], assignments: { [exampleSchedule.periods[0].id]: biology } } });
    const task = (title: string, extra: Record<string, unknown> = {}) => {
      const taskId = randomUUID();
      service.sync(id, { mutationId: randomUUID(), id: taskId, kind: 'task', base: null, data: { title, dueDate: fromToday(40), dueTime: '08:00', classId: null, notes: ' - Link: http://fa.schoology.com/assignment/1', completed: false, ...extra } });
      return taskId;
    };
    const quiz = task('Quiz Unidad 1 presente de indicativo'), lab = task('Lab 2'), mystery = task('Mystery worksheet');
    task('Already sorted', { priority: 'normal', workLocation: 'out-of-class' });
    task('Extra credit puzzle', { priority: 'low', workLocation: 'out-of-class' });
    db.prepare('INSERT INTO beta_members(beta_key,user_id,joined_at) VALUES(?,?,?)').run(AI_BETA, id, new Date().toISOString());
    return { id, quiz, lab, mystery };
  } finally { db.close(); }
}

const contexts: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(contexts.splice(0).map((context) => context.close())); });
async function signedIn(browser: Browser, id: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  contexts.push(context);
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
  return hydrating(await context.newPage());
}

test('ai-tasks beta: new tasks are sorted automatically, unclear labels are reviewed directly, and Break it down fills the checklist', async ({ browser }) => {
  test.setTimeout(120_000);
  const f = seed();
  const page = await signedIn(browser, f.id);
  const stored = (taskId: string) => {
    const db = openDatabase(process.env.E2E_DATABASE_PATH!);
    try { return JSON.parse((db.prepare('SELECT data FROM entities WHERE owner_id=? AND id=?').get(f.id, taskId) as { data: string }).data) as { classId: string | null; priority?: string }; }
    finally { db.close(); }
  };
  await page.goto('/tasks');

  // Auto-sort applies every priority, but a class only when the AI is sure.
  await expect.poll(() => stored(f.quiz), { timeout: 20_000 }).toMatchObject({ classId: spanish, priority: 'high' });
  await expect.poll(() => stored(f.lab)).toMatchObject({ classId: null, priority: 'normal' });
  await expect(page.getByRole('listitem').filter({ hasText: 'Lab 2' }).getByText('Normal priority')).toBeVisible();

  // An inconclusive answer opens the task editor instead of asking the same AI question again.
  await expect(page.getByText('1 task needs your label')).toBeVisible();
  await page.getByRole('button', { name: 'Review task', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await review.getByRole('combobox', { name: 'Work happens' }).click();
  await page.getByRole('option', { name: 'Out of class', exact: true }).click();
  await review.getByRole('combobox', { name: 'Priority' }).click();
  await page.getByRole('option', { name: 'High', exact: true }).click();
  await review.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => stored(f.mystery)).toMatchObject({ classId: null, priority: 'high', workLocation: 'out-of-class' });

  // A task added in the app is sorted a moment later, with no button.
  await page.getByLabel('New task').fill('Quiz on chapter 4');
  await page.getByLabel('New task').press('Enter');
  const added = page.getByRole('listitem').filter({ hasText: 'Quiz on chapter 4' });
  await expect(added.getByText('High priority')).toBeVisible({ timeout: 20_000 });
  await expect(added.getByText('Spanish 2')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('auto-sorted.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: test.info().outputPath('auto-sorted-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });

  // What reached the model: the classes, the due day's timetable hint, and no Schoology link boilerplate.
  const sort = requests.find(request => request.prompt.includes('Tasks to sort'))!;
  expect(sort.model).toBe('mock-text');
  expect(sort.prompt).toContain(`id "${spanish}": Spanish 2`);
  expect(sort.prompt).not.toContain('schoology.com');
  expect(sort.prompt).not.toContain('Already sorted');

  // The applied task carries the class and priority; Break it down adds steps to its checklist.
  await page.goto(`/tasks?edit=${f.quiz}`);
  const edit = page.getByRole('dialog', { name: 'Edit task' });
  await expect(edit.getByRole('combobox', { name: 'Class' })).toHaveText(/Spanish 2/);
  await expect(edit.getByRole('combobox', { name: 'Priority' })).toHaveText(/High/);
  await edit.getByRole('button', { name: 'Break it down' }).click();
  await expect(edit.getByRole('textbox', { name: 'Checklist item 3' })).toHaveValue('Take the practice quiz');
  await page.screenshot({ path: test.info().outputPath('breakdown.png') });
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toHaveCount(0);

  // Account shows what AI runs on and offers an own key, without ever showing one.
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  const account = page.getByRole('dialog', { name: 'Account', exact: true });
  await expect(account.getByText('Quasar’s AI')).toBeVisible();
  await expect(account.getByText(/of 20 sorts and 29 of 30 breakdowns left/)).toBeVisible();
  await account.getByRole('button', { name: 'Use an API key' }).click();
  const keyDialog = page.getByRole('dialog', { name: 'Use your own API key' });
  await expect(keyDialog.getByRole('link', { name: /Get a key from OpenAI/ })).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
  await page.screenshot({ path: test.info().outputPath('account-key.png') });
  await keyDialog.getByRole('button', { name: 'Cancel' }).click();
});

test('ai-tasks beta: members outside it see none of it', async ({ browser }) => {
  const f = seed();
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try { db.prepare('DELETE FROM beta_members WHERE user_id=?').run(f.id); } finally { db.close(); }
  const page = await signedIn(browser, f.id);
  // Do now is for everyone, on Today; the AI test list is not.
  await page.goto('/');
  await expect(page.getByRole('region', { name: /Do now/ })).toBeVisible();
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  await expect(page.getByText('no priority yet')).toHaveCount(0);
  await expect(page.getByRole('region', { name: /Upcoming tests and quizzes/ })).toHaveCount(0);
  // Merging by hand is for everyone too; the AI's duplicate check is not.
  await page.getByRole('button', { name: 'Duplicates' }).click();
  const sheet = page.getByRole('dialog', { name: 'Duplicates' });
  await expect(sheet.getByRole('heading', { name: 'Merge tasks yourself' })).toBeVisible();
  await expect(sheet.getByRole('heading', { name: 'Found by AI' })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Done' }).click();
  await page.goto(`/tasks?edit=${f.quiz}`);
  await expect(page.getByRole('dialog', { name: 'Edit task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Break it down' })).toHaveCount(0);
});

test('ai-tasks beta: Do now is on Today, Upcoming tests and quizzes on Tasks', async ({ browser }) => {
  test.setTimeout(90_000);
  const f = seed();
  const day = fromToday;
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const service = new Service(db, 'browser-owner@example.com');
    const add = (title: string, dueDate: string, extra: Record<string, unknown> = {}) => service.sync(f.id, { mutationId: randomUUID(), id: randomUUID(), kind: 'task', base: null,
      data: { title, dueDate, dueTime: null, classId: null, notes: '', completed: false, priority: 'normal', ...extra } });
    // The seeded tasks are far off; these give each list something to show.
    add('Finish lab write-up', day(-1), { classId: biology });
    add('Vocabulario capítulo 3', day(0), { classId: spanish });
    add('Gas Law Quiz', day(1), { classId: biology, priority: 'high' });
    add('Unit 2 Test', day(6), { classId: biology, priority: 'high' });
    add('Prueba de vocabulario', day(9), { classId: spanish, priority: 'high' });
    add('Unit 1 Retest (optional)', day(2), { priority: 'low' });
    // No test word in the title: only the AI knows it's a quiz.
    add('Pop check on cells', day(3), { classId: biology });
  } finally { db.close(); }
  const page = await signedIn(browser, f.id);
  await page.goto('/');
  const doNowSection = page.getByRole('region', { name: /Do now/ });
  await expect(doNowSection.getByText('Finish lab write-up')).toBeVisible();
  await expect(doNowSection.getByText('Overdue', { exact: true })).toBeVisible();
  await expect(doNowSection.getByText('Gas Law Quiz')).toBeVisible();
  await expect(doNowSection.getByText('Unit 2 Test')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('today-do-now.png'), fullPage: true });
  await page.goto('/tasks');
  await expect(page.getByRole('region', { name: /Do now/ })).toHaveCount(0);
  const tests = page.getByRole('region', { name: /Upcoming tests and quizzes/ });
  await expect(tests.getByText('Unit 2 Test')).toBeVisible();
  await expect(tests.getByText('Prueba de vocabulario')).toBeVisible();
  await expect(tests.getByText(/^Quiz · Tomorrow · /)).toBeVisible();
  await expect(tests.getByText('Unit 1 Retest (optional)')).toHaveCount(0);
  await expect(tests.getByText('Pop check on cells')).toBeVisible();
  await expect(tests.getByText(/^Quiz · In 3 days · /)).toBeVisible();
  await expect(tests.getByText('Checking your tasks with AI…')).toHaveCount(0);
  expect(requests.some((request) => request.system.includes('"kind"') && request.prompt.includes('Pop check on cells'))).toBe(true);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: test.info().outputPath('focus-phone.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: test.info().outputPath('focus-desktop.png') });
  // A filter hides the summary.
  await page.getByRole('group', { name: 'Filter by class' }).getByRole('button', { name: 'Biology' }).click();
  await expect(page.getByRole('region', { name: /Upcoming tests and quizzes/ })).toHaveCount(0);
});

test('ai-tasks beta: the AI merges a sure duplicate, keeps a maybe for review, and every merge can be undone', async ({ browser }) => {
  test.setTimeout(90_000);
  const f = seed();
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const service = new Service(db, 'browser-owner@example.com');
    const add = (title: string, extra: Record<string, unknown> = {}) => service.sync(f.id, { mutationId: randomUUID(), id: randomUUID(), kind: 'task', base: null,
      data: { title, dueDate: fromToday(5), dueTime: null, classId: null, notes: '', completed: false, priority: 'normal', ...extra } });
    add('Chapter 5 Homework');
    add('chapter 5 homework!', { classId: biology, notes: 'Odd problems only' });
    add('Essay draft'); add('Essay', { dueDate: fromToday(6) });
  } finally { db.close(); }
  const page = await signedIn(browser, f.id);
  await page.goto('/tasks');
  await expect(page.getByText('AI merged a duplicate of')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('possible duplicate it wasn’t sure enough to merge')).toBeVisible();
  // One copy is left, with the class and notes from the other.
  await expect(page.getByRole('button', { name: /^Edit chapter 5 homework/i })).toHaveCount(1);
  await page.getByRole('status').filter({ hasText: 'AI merged' }).getByRole('button', { name: 'Review', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Duplicates' });
  const history = sheet.getByRole('list', { name: 'Merge history' });
  await expect(history.getByText('AI automatically merged 2 tasks', { exact: true })).toBeVisible();
  await expect(history.getByText('Kept', { exact: true })).toBeVisible();
  await expect(history.getByText('Removed duplicate', { exact: true })).toBeVisible();
  await expect(history.getByText('Why AI merged them', { exact: true })).toBeVisible();
  await expect(history.getByText('Same homework', { exact: true })).toBeVisible();
  await history.getByRole('button', { name: 'View full details', exact: true }).click();
  await expect(history.getByRole('region', { name: 'Current kept task' })).toContainText('Odd problems only');
  await expect(history.getByRole('region', { name: 'Original kept copy' })).toBeVisible();
  await expect(history.getByRole('region', { name: 'Original removed copy' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('duplicates-history.png') });
  await history.getByRole('button', { name: /^Undo/ }).click();
  await expect(sheet.getByText('Put back 1 task.')).toBeVisible();
  await expect(history.getByText(/Undone$/)).toBeVisible();

  // The maybe waits under Find until the student decides.
  await sheet.getByRole('radio', { name: 'Find' }).click();
  const found = sheet.getByRole('list', { name: 'Possible duplicates' });
  await expect(found.getByText('Maybe the same essay')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('duplicates-find.png') });
  await found.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(sheet.getByText(/^Merged into “Essay/)).toBeVisible();
  await expect(found).toHaveCount(0);

  // By hand: pick two tasks, see what moves over, merge.
  await sheet.getByRole('textbox', { name: 'Search tasks' }).fill('chapter 5');
  const pick = sheet.getByRole('list', { name: 'Tasks to merge' });
  for (const box of await pick.getByRole('checkbox').all()) await box.click();
  // The copy with the class and notes is picked to keep, so nothing has to move; keeping the bare one copies them over.
  await expect(sheet.getByText('The other task is deleted.', { exact: true })).toBeVisible();
  await sheet.getByRole('combobox', { name: 'Keep' }).click();
  await page.getByRole('option', { name: 'Chapter 5 Homework', exact: true }).click();
  await expect(sheet.getByText('The other task is deleted. Copied over: class and notes.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Merge 2 tasks' }).click();
  await expect(sheet.getByText(/^Merged into/)).toBeVisible();
  await expect(sheet.getByRole('radio', { name: 'History · 3' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: /^Edit chapter 5 homework/i })).toHaveCount(1);
});
