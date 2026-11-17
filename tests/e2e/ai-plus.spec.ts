import { test, expect, hydrating } from './fixtures';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { openDatabase } from '../../src/server/db';
import { createBeta, readBetaRegistry, writeBetaRegistry } from '../../src/server/beta-registry';
import { Service } from '../../src/server/service';
import { resolveDueText } from '../../src/server/photo-tasks';
import { exampleSchedule } from '../../src/domain/example';
import { AI_BETA } from '../../src/domain/ai';

/**
 * Photo to tasks and study sets (Quasar AI Plus, ai-tasks beta) against a mocked AI: photo requests go to the scan
 * model (SCAN_API_URL), text-only ones to the text model (AI_API_URL), so one handler listens on both.
 */
const TEXT_PORT = Number(new URL(process.env.AI_API_URL ?? 'http://127.0.0.1:3198/v1').port);
const VISION_PORT = Number(new URL(process.env.SCAN_API_URL ?? 'http://127.0.0.1:3199/v1').port);
const servers: Server[] = [];
const requests: Array<{ port: number; model: string; system: string; prompt: string; images: number }> = [];
const spanish = randomUUID(), biology = randomUUID();
/** The school's today (the example school is in New York), which due words are resolved against. */
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: exampleSchedule.timeZone });
const day = (offset: number) => { const date = new Date(`${today()}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };
const LAB_DATE = day(3);

function answer(system: string, prompt: string): unknown {
  if (system.includes('list the work they need to do')) {
    const bio = prompt.match(/id "([^"]+)": Biology/)?.[1] ?? null;
    return { unreadable: null, tasks: [
      { title: 'Read chapter 5', dueDate: null, dueText: 'Friday', dueTime: null, notes: 'Pages 120-134, take notes on mitosis', classId: bio, kind: 'none' },
      { title: 'Unit 3 test', dueDate: null, dueText: 'next Tuesday', dueTime: '08:15', notes: 'Chapters 7-9', classId: null, kind: 'test' },
      { title: 'Lab 2', dueDate: LAB_DATE, dueText: null, dueTime: null, notes: '', classId: bio, kind: 'none' },
    ] };
  }
  if (system.includes('study material')) return { unreadable: null,
    cards: Array.from({ length: 12 }, (_, index) => ({ front: index === 0 ? 'What does the mitochondria make?' : `Organelle ${index + 1}`, back: index === 0 ? 'ATP, the cell’s energy, through cellular respiration.' : `What organelle ${index + 1} does` })),
    quiz: Array.from({ length: 5 }, (_, index) => ({ question: index === 0 ? 'Which organelle makes ATP?' : `Question ${index + 1}?`, choices: [index === 0 ? 'Mitochondria' : `Right ${index + 1}`, 'Nucleus', 'Ribosome', 'Golgi body'], answer: 0, explanation: index === 0 ? 'Mitochondria run cellular respiration, which makes ATP.' : `Because ${index + 1}.` })) };
  if (system.includes('"groups"')) return { groups: [] };
  if (system.includes('"kind"')) return { tasks: [...prompt.matchAll(/^- id "([^"]+)": "(.*)"$/gm)].map(([, id, title]) => ({ id, kind: /quiz/i.test(title) ? 'quiz' : /\btest\b/i.test(title) ? 'test' : 'none' })) };
  return { tasks: [] };
}

test.beforeAll(async () => {
  for (const port of [TEXT_PORT, VISION_PORT]) {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw) as { model: string; messages: Array<{ content: string | Array<{ type: string; text?: string }> }> };
        const system = String(body.messages[0].content);
        const user = body.messages[1].content;
        const prompt = typeof user === 'string' ? user : user.filter(part => part.type === 'text').map(part => part.text).join('\n');
        requests.push({ port, model: body.model, system, prompt, images: typeof user === 'string' ? 0 : user.filter(part => part.type === 'image_url').length });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer(system, prompt)) } }] }));
      });
    });
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    servers.push(server);
  }
});
test.afterAll(async () => { await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

function seed() {
  const listPath = join(dirname(process.env.E2E_DATABASE_PATH!), 'betas.json');
  const registry = readBetaRegistry(listPath);
  if (!registry.betas.some(beta => beta.key === AI_BETA)) writeBetaRegistry(createBeta(registry, { key: AI_BETA, name: 'AI tasks', code: 'AI-TASKS-E2E' }), listPath);
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, 'Ada', 'Ada Tester', new Date().toISOString());
    const service = new Service(db, 'browser-owner@example.com');
    const school = service.createSchool(id, { name: `Plus High ${id.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
    const base = service.entity(id, 'personal')!;
    service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base, data: { ...base.data, classes: [{ id: spanish, name: 'Spanish 2' }, { id: biology, name: 'Biology', teacher: 'Ms. Reed' }] } });
    const task = (title: string, extra: Record<string, unknown> = {}) => {
      const taskId = randomUUID();
      service.sync(id, { mutationId: randomUUID(), id: taskId, kind: 'task', base: null, data: { title, dueDate: LAB_DATE, dueTime: null, classId: null, notes: '', completed: false, priority: 'normal', ...extra } });
      return taskId;
    };
    task('Lab 2', { classId: biology });
    const quiz = task('Unit 4 quiz: cells', { classId: biology, dueDate: day(5), notes: 'Organelles: mitochondria (ATP), nucleus (DNA), ribosomes (proteins).' });
    db.prepare('INSERT INTO beta_members(beta_key,user_id,joined_at) VALUES(?,?,?)').run(AI_BETA, id, new Date().toISOString());
    return { id, quiz };
  } finally { db.close(); }
}

const contexts: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())); });
async function signedIn(browser: Browser, id: string, width = 390): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
  contexts.push(context);
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
  return hydrating(await context.newPage());
}
async function choose(select: Locator, option: string) {
  await select.click();
  await select.page().getByRole('option', { name: option, exact: true }).click();
}
async function shots(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(150);
  await page.screenshot({ path: test.info().outputPath(`${name}-dark.png`) });
  await page.emulateMedia({ colorScheme: 'light' });
}
/** A whiteboard-ish picture, so the thumbnails in the screenshots look like something. */
const board = () => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="#f4f4f0"/>
  <text x="80" y="200" font-size="64" font-family="sans-serif" fill="#1f3a93">Biology HW</text><text x="80" y="330" font-size="52" font-family="sans-serif" fill="#222">Read ch. 5 - Friday</text>
  <text x="80" y="450" font-size="52" font-family="sans-serif" fill="#222">Unit 3 TEST next Tues</text><text x="80" y="570" font-size="52" font-family="sans-serif" fill="#222">Lab 2</text></svg>`)).png().toBuffer();
const stored = (owner: string) => {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try { return (db.prepare("SELECT data FROM entities WHERE owner_id=? AND kind='task' AND deleted=0").all(owner) as Array<{ data: string }>).map(row => JSON.parse(row.data) as Record<string, unknown>); }
  finally { db.close(); }
};

test('Photo to tasks: read a photo, review every row, and save through the task queue', async ({ browser }) => {
  test.setTimeout(240_000);
  const f = seed();
  const page = await signedIn(browser, f.id);
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'From a photo' }).click();
  const sheet = page.getByRole('dialog', { name: 'Tasks from a photo' });
  await expect(sheet.getByText(/of 3 free photo imports left today/)).toBeVisible();
  await sheet.locator('input[type=file]:not([capture])').setInputFiles({ name: 'board.png', mimeType: 'image/png', buffer: await board() });
  await expect(sheet.getByRole('img', { name: 'Photo 1' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Read tasks' }).click();
  const rows = sheet.getByRole('list', { name: 'Tasks read from the photo' }).getByRole('listitem');
  await expect(rows).toHaveCount(3);

  // "Friday" and "next Tuesday" are worked out against the school's today; the class is only the one the photo named.
  await expect(rows.nth(0).getByLabel('Due')).toHaveValue(resolveDueText('Friday', today())!);
  await expect(rows.nth(0).getByRole('combobox', { name: 'Class' })).toHaveText(/Biology/);
  await expect(rows.nth(1).getByLabel('Due')).toHaveValue(resolveDueText('next Tuesday', today())!);
  await expect(rows.nth(1).getByRole('combobox', { name: 'Class' })).toHaveText(/No class/);
  await expect(rows.nth(1).getByText('Test', { exact: true })).toBeVisible();
  // Lab 2 is already a task on that day, so it's flagged and left unticked.
  await expect(rows.nth(2).getByText('Already in your tasks')).toBeVisible();
  await expect(rows.nth(2).getByRole('checkbox')).not.toBeChecked();
  await expect(sheet.getByRole('button', { name: 'Add 2 tasks' })).toBeVisible();
  await shots(page, 'photo-review');

  // Edit before saving: a clearer title and the class the photo didn't name.
  await rows.nth(1).getByRole('textbox', { name: 'Task 2 title' }).fill('Unit 3 test (ch. 7-9)');
  await choose(rows.nth(1).getByRole('combobox', { name: 'Class' }), 'Spanish 2');
  await sheet.getByRole('button', { name: 'Add 2 tasks' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Edit Read chapter 5/ })).toBeVisible();
  await expect.poll(() => stored(f.id).filter(task => task.title === 'Read chapter 5' || task.title === 'Unit 3 test (ch. 7-9)').length, { timeout: 15_000 }).toBe(2);
  const saved = stored(f.id);
  expect(saved.find(task => task.title === 'Read chapter 5')).toMatchObject({ classId: biology, dueDate: resolveDueText('Friday', today()), notes: 'Pages 120-134, take notes on mitosis', priority: 'normal' });
  expect(saved.find(task => task.title === 'Unit 3 test (ch. 7-9)')).toMatchObject({ classId: spanish, dueDate: resolveDueText('next Tuesday', today()), dueTime: '08:15', priority: 'high' });
  expect(saved.filter(task => task.title === 'Lab 2')).toHaveLength(1);
  // The photo went to the vision model with the classes and a calendar.
  const read = requests.find(request => request.system.includes('list the work they need to do'))!;
  expect(read).toMatchObject({ port: VISION_PORT, model: 'mock-vision', images: 1 });
  expect(read.prompt).toContain(`id "${biology}": Biology, teacher Ms. Reed`);
  await shots(page, 'photo-saved');
});

test('Photo to tasks fits a 360 px phone', async ({ browser }) => {
  const f = seed();
  const page = await signedIn(browser, f.id, 360);
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'From a photo' }).click();
  const sheet = page.getByRole('dialog', { name: 'Tasks from a photo' });
  await sheet.locator('input[type=file]:not([capture])').setInputFiles({ name: 'board.png', mimeType: 'image/png', buffer: await board() });
  await sheet.getByRole('button', { name: 'Read tasks' }).click();
  await expect(sheet.getByRole('list', { name: 'Tasks read from the photo' }).getByRole('listitem')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await shots(page, 'photo-review-360');
});

test('Study sets: make one for a quiz, flip and mark cards, take the quiz, then delete it', async ({ browser }) => {
  test.setTimeout(240_000);
  const f = seed();
  const page = await signedIn(browser, f.id);
  await page.goto(`/tasks?edit=${f.quiz}`);
  const edit = page.getByRole('dialog', { name: 'Edit task' });
  const block = edit.getByRole('region', { name: 'Study set' });
  await block.getByRole('button', { name: 'Make a study set' }).click();
  const builder = page.getByRole('dialog', { name: 'Make a study set' });
  await expect(builder.getByText(/of 2 free study sets left today/)).toBeVisible();
  await builder.getByRole('textbox', { name: 'Notes or study guide (optional)' }).fill('Golgi body packages proteins. Cell membrane controls what enters.');
  await shots(page, 'study-builder');
  await builder.getByRole('button', { name: 'Make set' }).click();

  const study = page.getByRole('dialog', { name: 'Study: Unit 4 quiz: cells' });
  await expect(study.getByText('Made by AI from your material. Check anything that looks off.')).toBeVisible();
  const card = study.getByRole('button', { name: /^(Card|Answer): / });
  await expect(card).toHaveAccessibleName(/^Card: What does the mitochondria make\?/);
  await shots(page, 'study-card');
  // Tap flips, Space flips back, the arrow keys mark.
  await card.click();
  await expect(card).toHaveAccessibleName(/^Answer: ATP/);
  await page.waitForTimeout(600);
  await shots(page, 'study-card-back');
  await card.press('Space');
  await expect(card).toHaveAccessibleName(/^Card: /);
  await card.press('ArrowRight');
  await expect(study.getByText('1 of 12 got it · 11 to go')).toBeVisible();
  await study.getByRole('button', { name: 'Again' }).click();
  await expect(study.getByText('1 of 12 got it · 11 to go')).toBeVisible();
  // A swipe to the right is "got it".
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(study.getByText('2 of 12 got it · 10 to go')).toBeVisible();
  await expect(card).toHaveAccessibleName(/^Card: /);
  await study.getByRole('button', { name: 'Shuffle' }).click();
  await expect(study.getByText('2 of 12 got it · 10 to go')).toBeVisible();

  // The quiz: one right, one wrong, the rest right.
  await study.getByRole('radio', { name: 'Quiz · 5' }).click();
  await expect(study.getByText('Question 1 of 5')).toBeVisible();
  await study.getByRole('radio', { name: 'Mitochondria' }).click();
  await expect(study.getByRole('status').filter({ hasText: 'Right.' })).toContainText('cellular respiration');
  await shots(page, 'study-quiz');
  await study.getByRole('button', { name: 'Next question' }).click();
  await study.getByRole('radio', { name: 'Nucleus' }).click();
  await expect(study.getByText('Not quite. It’s “Right 2”.')).toBeVisible();
  for (let number = 2; number < 5; number += 1) {
    await study.getByRole('button', { name: 'Next question' }).click();
    await study.getByRole('radio', { name: `Right ${number + 1}` }).click();
  }
  await study.getByRole('button', { name: 'See score' }).click();
  await expect(study.getByText('4/5')).toBeVisible();
  await expect(study.getByRole('list', { name: 'Questions to review' })).toContainText('Question 2?');
  await shots(page, 'study-score');
  await study.getByRole('button', { name: 'Done' }).click();
  await expect(study).toHaveCount(0);
  await expect(block.getByText('12 flashcards · 5 quiz questions · last quiz 4/5')).toBeVisible();

  // Saved on the server per task, with the "got it" cards (card 2 went to the back, so the swipe marked card 3).
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const row = db.prepare('SELECT progress, material FROM study_sets WHERE owner_id=? AND task_id=?').get(f.id, f.quiz) as { progress: string; material: string };
    expect(JSON.parse(row.progress)).toMatchObject({ known: ['c1', 'c3'], lastScore: { right: 4, total: 5 } });
    expect(row.material).toContain('Golgi body');
  } finally { db.close(); }
  const made = requests.find(request => request.system.includes('study material'))!;
  expect(made).toMatchObject({ port: TEXT_PORT, model: 'mock-text', images: 0 });
  expect(made.prompt).toContain('mitochondria (ATP)');
  expect(made.prompt).toContain('Golgi body');

  await block.getByRole('button', { name: 'Delete' }).click();
  await block.getByRole('button', { name: 'Delete set' }).click();
  await expect(block.getByRole('button', { name: 'Make a study set' })).toBeVisible();
});

test('Study sets and photo import are only in the ai-tasks beta', async ({ browser }) => {
  const f = seed();
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try { db.prepare('DELETE FROM beta_members WHERE user_id=?').run(f.id); } finally { db.close(); }
  const page = await signedIn(browser, f.id);
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'From a photo' })).toHaveCount(0);
  await page.goto(`/tasks?edit=${f.quiz}`);
  await expect(page.getByRole('dialog', { name: 'Edit task' })).toBeVisible();
  await expect(page.getByText('Study set')).toHaveCount(0);
});
