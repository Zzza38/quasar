import { test, expect, hydrating } from './fixtures';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { openDatabase } from '../../src/server/db';
import { createBeta, readBetaRegistry, writeBetaRegistry } from '../../src/server/beta-registry';
import { encrypt } from '../../src/server/calendar';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';
import { SCHOOLOGY_BETA } from '../../src/domain/schoology';

/**
 * Classes → Grades in a browser, against a stand-in for Schoology's API (playwright.config.ts points
 * SCHOOLOGY_API_URL here). The gradebook is made up: no student's grades are in this file.
 */
const MOCK_PORT = 3197;
/** Refresh rereads Schoology only when the last read is this old (GRADEBOOK_FORCE_MS, plus a margin). */
const REFRESH_GAP_MS = 10_500;
let mock: Server;
/** What the stand-in does with grade reads, and how many it has answered. */
const school = { grades: 'ok' as 'ok' | 'down' | 'refused', reads: 0, approved: false };
const fromToday = (offset: number) => { const date = new Date(); date.setDate(date.getDate() + offset); return date.toLocaleDateString('en-CA'); };

type Work = [id: number, title: string, category: number, earned: number | null, max: number, due: number, exception?: number];
const CLASSES: { id: number; title: string; categories: [id: number, title: string, weight: number][]; work: Work[] }[] = [
  { id: 11, title: 'AP Biology', categories: [[1, 'Tests', 50], [2, 'Labs', 30], [3, 'Homework', 20]], work: [
    [101, 'Unit 1 Test', 1, 92, 100, -50], [102, 'Unit 2 Test', 1, 88, 100, -30], [103, 'Unit 3 Test', 1, 94, 100, -10], [104, 'Unit 4 Test: Cell energy', 1, null, 100, 4],
    [201, 'Osmosis lab', 2, 38, 40, -45], [202, 'Photosynthesis lab', 2, 37, 40, -24], [203, 'Enzyme lab report', 2, null, 40, 2],
    [301, 'HW 1', 3, 10, 10, -60], [302, 'HW 2', 3, 9, 10, -53], [303, 'HW 3', 3, 10, 10, -46], [304, 'HW 4', 3, 10, 10, -35], [305, 'HW 5', 3, 8, 10, -21], [306, 'HW 6', 3, 10, 10, -7],
    [307, 'HW 7: Cellular respiration', 3, null, 10, 1] ] },
  { id: 12, title: 'Precalculus', categories: [[1, 'Tests', 60], [2, 'Quizzes', 25], [3, 'Homework', 15]], work: [
    [401, 'Test 1: Functions', 1, 84, 100, -47], [402, 'Test 2: Polynomials', 1, 87, 100, -19], [403, 'Unit 3 Test: Trig', 1, null, 100, 10],
    [411, 'Quiz 1', 2, 18, 20, -59], [412, 'Quiz 2', 2, 19, 20, -41], [413, 'Quiz 5: Unit circle', 2, null, 20, 3],
    [421, 'Problem set 6', 3, 9, 10, -26], [422, 'Problem set 7', 3, null, 10, -14, 3], [423, 'Problem set 9', 3, null, 10, 1] ] },
  { id: 13, title: 'Studio Art', categories: [[1, 'Portfolio', 100]], work: [[501, 'Portfolio check 1', 1, null, 50, 6]] },
];
/** The grades Schoology would report for a class: points per category, categories weighted, missing work as zero. */
function reported(cls: (typeof CLASSES)[number]) {
  const categories = cls.categories.map(([id, , weight]) => {
    const counted = cls.work.filter(work => work[2] === id && (work[3] !== null || work[6] === 3));
    const max = counted.reduce((sum, work) => sum + work[4], 0);
    return { id, weight, grade: max ? Math.round(10000 * counted.reduce((sum, work) => sum + (work[3] ?? 0), 0) / max) / 100 : null };
  });
  const live = categories.filter(category => category.grade !== null);
  const total = live.reduce((sum, category) => sum + category.weight, 0);
  return { categories, grade: total ? Math.round(100 * live.reduce((sum, category) => sum + category.weight * category.grade!, 0) / total) / 100 : null };
}
const gradesBody = () => ({ section: CLASSES.map(cls => {
  const { categories, grade } = reported(cls);
  return { section_id: cls.id, period: [{ period_id: 'p1', assignment: cls.work.map(([id, , category, earned, max, , exception]) => ({ assignment_id: id, grade: earned, max_points: max, exception: exception ?? 0, pending: 0, category_id: category })) }],
    final_grade: grade === null ? [] : [{ period_id: 'p1', grade, weight: 100, grading_category: categories.filter(category => category.grade !== null).map(category => ({ category_id: category.id, grade: category.grade })) }, { period_id: 'final', grade }],
    grading_category: cls.categories.map(([id, title, weight]) => ({ id, title, weight })) };
}) });

test.beforeAll(async () => {
  mock = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://mock').pathname.replace('/v1/', '');
    const send = (status: number, body: unknown, type = 'application/json') => { res.statusCode = status; res.setHeader('content-type', type); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    const assignments = /^sections\/(\d+)\/assignments$/.exec(path);
    if (path === 'oauth/request_token') return send(200, 'oauth_token=req-token&oauth_token_secret=req-secret', 'text/plain');
    if (path === 'oauth/access_token') return school.approved ? send(200, 'oauth_token=acc-token&oauth_token_secret=acc-secret', 'text/plain') : send(401, 'not approved', 'text/plain');
    if (path === 'users/me') { res.statusCode = 303; res.setHeader('location', `http://127.0.0.1:${MOCK_PORT}/v1/users/4242`); return res.end(); }
    if (path === 'users/4242') return send(200, { uid: 4242, name_display: 'Jordan Rivera' });
    if (path === 'users/4242/grades') {
      school.reads++;
      return school.grades === 'down' ? send(500, {}) : school.grades === 'refused' ? send(401, {}) : send(200, gradesBody());
    }
    if (path === 'users/4242/sections') return send(200, { section: CLASSES.map(cls => ({ id: String(cls.id), course_title: cls.title, section_title: '' })) });
    if (assignments) return send(200, { assignment: (CLASSES.find(cls => String(cls.id) === assignments[1])?.work ?? []).map(([id, title, , , , due]) => ({ id, title, due: `${fromToday(due)} 23:59:00`, allow_dropbox: '0' })) });
    return send(404, {});
  });
  await new Promise<void>(resolve => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
});
test.afterAll(async () => { await new Promise<void>(resolve => mock.close(() => resolve())); });
test.beforeEach(() => { school.grades = 'ok'; school.approved = false; });

/** A student with three classes on their timetable. `beta` joins the Schoology beta; `connected` also links a Schoology account. */
function seed(options: { beta: boolean; connected: boolean }) {
  const listPath = join(dirname(process.env.E2E_DATABASE_PATH!), 'betas.json');
  const registry = readBetaRegistry(listPath);
  if (!registry.betas.some(beta => beta.key === SCHOOLOGY_BETA)) writeBetaRegistry(createBeta(registry, { key: SCHOOLOGY_BETA, name: 'Schoology grades', public: true }), listPath);
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, 'Jordan', 'Jordan Rivera', new Date().toISOString());
    const service = new Service(db, 'browser-owner@example.com');
    const created = service.createSchool(id, { name: `Grades High ${id.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    service.join(id, { schoolId: created.id, choice: 'community', grade: '10' });
    const base = service.entity(id, 'personal')!;
    service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base, data: { ...base.data,
      classes: [{ id: randomUUID(), name: 'AP Biology', room: '214', teacher: 'Ms. Okafor', color: '#16a34a' }, { id: randomUUID(), name: 'Precalculus', room: '118', teacher: 'Mr. Lindqvist', color: '#4f46e5' }, { id: randomUUID(), name: 'Studio Art', teacher: 'Mr. Chen', color: '#e11d48' }] } });
    if (options.beta) db.prepare('INSERT INTO beta_members(beta_key,user_id,joined_at) VALUES(?,?,?)').run(SCHOOLOGY_BETA, id, new Date().toISOString());
    // Imports and turn-in checks are off: this spec is about grades, and the stand-in has no dropboxes.
    if (options.connected) db.prepare('INSERT INTO schoology_connections(user_id,token_encrypted,schoology_uid,name,connected_at,import_assignments,auto_complete) VALUES(?,?,?,?,?,0,0)')
      .run(id, encrypt(JSON.stringify({ token: 'acc-token', secret: 'acc-secret' }), process.env.E2E_AUTH_SECRET!), '4242', 'Jordan Rivera', new Date().toISOString());
    return id;
  } finally { db.close(); }
}
function goalRow(userId: string, sectionId: string) {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const row = db.prepare('SELECT goal, plan FROM schoology_grade_goals WHERE user_id=? AND section_id=?').get(userId, sectionId) as { goal: string | null; plan: string | null } | undefined;
    return row ? { goal: row.goal ? JSON.parse(row.goal) as unknown : null, plan: row.plan ? JSON.parse(row.plan) as unknown : null } : null;
  } finally { db.close(); }
}

const contexts: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(contexts.splice(0).map((context) => context.close())); });
async function signedIn(browser: Browser, id: string, phone = false, dark = false): Promise<Page> {
  const context = await browser.newContext({ ...(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1440, height: 900 } }), colorScheme: dark ? 'dark' : 'light' });
  contexts.push(context);
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
  return hydrating(await context.newPage());
}
async function choose(select: Locator, option: string) {
  await select.click();
  await select.page().getByRole('option', { name: option, exact: true }).click();
}
/** Screenshots for review go to GRADES_SHOTS when it is set; they only ever show the made-up gradebook above. */
async function shot(page: Page, name: string) {
  if (!process.env.GRADES_SHOTS) return;
  mkdirSync(process.env.GRADES_SHOTS, { recursive: true });
  await page.screenshot({ path: join(process.env.GRADES_SHOTS, `${name}.png`), fullPage: true });
}
const cards = (page: Page) => page.getByRole('list', { name: 'Grades by class' });
/** The app's own alerts; Next keeps an empty route announcer with the same role. */
const alerts = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

test('schoology-connect beta: grades, a saved custom goal, and what-ifs on a wide screen', async ({ browser }) => {
  test.setTimeout(120_000);
  const id = seed({ beta: true, connected: true });
  const page = await signedIn(browser, id, false, true);
  await page.goto('/classes');
  // Grades is a tab of Classes, not a new place in the navigation.
  await page.getByRole('radio', { name: 'Grades', exact: true }).click();
  await expect(page).toHaveURL(/\/classes\?tab=grades$/);
  const biology = cards(page).getByRole('listitem').filter({ hasText: 'AP Biology' });
  await expect(biology).toContainText('92.79%');
  await expect(biology).toContainText('Room 214 · Ms. Okafor');
  // Before any goal is saved the plan holds the letter the student has.
  await expect(biology).toContainText(/To stay at A-, get \d+\/100 or better on Unit 4 Test: Cell energy/);
  await expect(biology.getByRole('img')).toHaveAttribute('aria-label', 'Now 92.79%, goal 90.0%');
  await expect(cards(page).getByRole('listitem').filter({ hasText: 'Precalculus' })).toContainText('1 missing');
  await expect(cards(page).getByRole('listitem').filter({ hasText: 'Studio Art' })).toContainText('No grade yet');
  await expect(page.getByText(/Schoology, checked Today/)).toBeVisible();
  expect(goalRow(id, '11')).toBeNull();
  await shot(page, '1-desktop-overview');

  // A letter goal from the card.
  await choose(page.getByRole('combobox', { name: 'Goal for AP Biology' }), 'A · 93%');
  await expect.poll(() => goalRow(id, '11')).toEqual({ goal: { kind: 'letter', letter: 'A' }, plan: null });
  await expect(biology).toContainText(/To reach A, get \d+\/100 or better on Unit 4 Test: Cell energy/);
  await expect(page.getByText('0 of 1 goal met').filter({ visible: true })).toBeVisible();

  // The class: switcher rail, gradebook, goal and what-if.
  await page.getByRole('button', { name: 'Open AP Biology grades' }).click();
  await expect(page).toHaveURL(/tab=grades&class=11/);
  const rail = page.getByRole('navigation', { name: 'Classes with grades' });
  const detail = page.getByRole('region', { name: 'AP Biology grades' });
  await expect(rail.getByRole('button', { name: /AP Biology/ })).toHaveAttribute('aria-current', 'true');
  await expect(rail.getByRole('button', { name: /AP Biology/ })).toContainText('A · 0.2 to go');
  await expect(rail.getByRole('button', { name: /Precalculus/ })).toContainText('No goal set');
  await expect(detail.getByRole('list', { name: 'Categories' })).toContainText('Tests');
  await expect(detail.getByRole('list', { name: 'Coming up' }).getByRole('listitem')).toHaveCount(3);
  await expect(detail.getByRole('list', { name: 'Graded' }).getByRole('listitem')).toHaveCount(6);
  await detail.getByRole('button', { name: 'Show all 11' }).click();
  await expect(detail.getByRole('list', { name: 'Graded' }).getByRole('listitem')).toHaveCount(11);
  await shot(page, '2-desktop-detail');

  // A custom percentage with a decimal, saved for this student and class.
  const goal = detail.getByRole('region', { name: 'Goal' });
  await choose(goal.getByRole('combobox', { name: 'Goal type' }), 'Custom percentage');
  const percent = goal.getByRole('textbox', { name: 'Target percentage' });
  await expect(percent).toHaveValue('93');
  await percent.fill('94.5');
  await expect.poll(() => goalRow(id, '11')).toEqual({ goal: { kind: 'percent', percent: 94.5 }, plan: null });
  await expect(goal.getByRole('img')).toHaveAttribute('aria-label', 'Now 92.79%, goal 94.5%');
  await expect(goal).toContainText('Custom · 94.5%');
  const [typeBox, percentBox] = await Promise.all([goal.getByRole('combobox', { name: 'Goal type' }).boundingBox(), percent.boundingBox()]);
  expect(typeBox!.x + typeBox!.width).toBeLessThanOrEqual(percentBox!.x);
  await expect(goal.getByRole('status').filter({ hasText: '94.5%' })).toContainText('94.5% is out of reach on Unit 4 Test: Cell energy alone');
  await expect(rail.getByRole('button', { name: /AP Biology/ })).toContainText('94.5% · 1.7 to go');
  // Something that isn't a percent is refused on the spot and never reaches the server.
  await percent.fill('140');
  await expect(goal.getByRole('alert')).toHaveText('Type a number from 0 to 100.');
  await percent.fill('94.5');
  await expect(goal.getByRole('alert')).toHaveCount(0);
  await shot(page, '3-desktop-custom-goal');

  // What-ifs: typed scores move the dashed marker and re-plan around the same goal. Nothing is saved or sent.
  await detail.getByRole('textbox', { name: 'Score for HW 7: Cellular respiration' }).fill('10');
  await detail.getByRole('textbox', { name: 'Score for Enzyme lab report' }).fill('40');
  const whatIf = detail.getByRole('region', { name: 'What if' });
  await expect(whatIf).toContainText('Your Schoology grade is still 92.79%. Nothing here is sent to Schoology.');
  await expect(goal.getByRole('img')).toHaveAttribute('aria-label', /^Now 92\.79%, goal 94\.5%, what if 93\.\d+%$/);
  await expect(goal).toContainText(/With those scores, you’d need \d+\/100 or better on Unit 4 Test: Cell energy to reach 94\.5%/);
  await detail.getByRole('textbox', { name: 'Score for Unit 4 Test: Cell energy' }).fill('100');
  await expect(whatIf).toContainText('Reaches your goal of 94.5%');
  await expect(goal).toContainText(/With these scores you’d finish at 9\d\.\d+%, enough for 94\.5%\./);
  await shot(page, '4-desktop-whatif');
  await whatIf.getByRole('button', { name: 'Clear' }).click();
  await expect(detail.getByRole('textbox', { name: 'Score for Enzyme lab report' })).toHaveValue('');
  await expect(whatIf).toContainText('Type a score next to anything coming up');

  // Plan around a different assignment; that choice is saved with the goal.
  await choose(goal.getByRole('combobox', { name: 'Plan around' }), 'Enzyme lab report');
  await expect.poll(() => goalRow(id, '11')).toEqual({ goal: { kind: 'percent', percent: 94.5 }, plan: { kind: 'item', id: '203' } });
  await expect(goal).toContainText('94.5% is out of reach on Enzyme lab report alone');

  // Another class from the rail: missing work is called out, and its goal is its own.
  await rail.getByRole('button', { name: /Precalculus/ }).click();
  const precalc = page.getByRole('region', { name: 'Precalculus grades' });
  await expect(precalc.getByRole('note')).toContainText('Problem set 7 is missing. Schoology counts it as 0.');
  await expect(precalc.getByRole('region', { name: 'Goal' })).toContainText('This starts at the letter you have now.');
  expect(goalRow(id, '12')).toBeNull();

  // The goal survives a reload, and the gradebook came from one read of Schoology's grades the whole time.
  const readsBefore = school.reads;
  await page.reload();
  await page.getByRole('navigation', { name: 'Classes with grades' }).getByRole('button', { name: /AP Biology/ }).click();
  await expect(page.getByRole('region', { name: 'AP Biology grades' }).getByRole('textbox', { name: 'Target percentage' })).toHaveValue('94.5');
  await expect(page.getByRole('region', { name: 'AP Biology grades' }).getByRole('combobox', { name: 'Plan around' })).toContainText('Enzyme lab report');
  expect(school.reads).toBe(readsBefore);

  // Back to every class; settings are one step away and still hold the import switches.
  await page.getByRole('button', { name: 'All classes' }).click();
  await expect(cards(page).getByRole('listitem')).toHaveCount(3);
  await expect(page.getByText('0 of 1 goal met').filter({ visible: true })).toBeVisible();
  await page.getByRole('button', { name: 'Schoology settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Schoology settings' });
  await expect(settings).toContainText('Connected as Jordan Rivera');
  await expect(settings.getByRole('switch', { name: 'Add Schoology assignments to Tasks' })).not.toBeChecked();
  await expect(settings.getByRole('switch', { name: 'Check off tasks you turn in on Schoology' })).not.toBeChecked();
  await expect(settings.getByRole('button', { name: 'Disconnect Schoology' })).toBeVisible();
  await settings.getByRole('button', { name: 'Close' }).click();
  // The timetable tab is where it always was.
  await page.getByRole('radio', { name: 'Timetable', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Your classes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add class' })).toBeVisible();
});

test('schoology-connect beta: the same class on a phone, in a sheet with a class switcher', async ({ browser }) => {
  test.setTimeout(90_000);
  const id = seed({ beta: true, connected: true });
  const page = await signedIn(browser, id, true);
  await page.goto('/classes?tab=grades');
  await expect(cards(page).getByRole('listitem')).toHaveCount(3);
  await expect(cards(page).getByRole('listitem').filter({ hasText: 'Precalculus' })).toContainText(/To stay at B-, get \d+\/100 or better on Unit 3 Test: Trig/);
  await noOverflow(page);
  await shot(page, '5-mobile-overview');

  await page.getByRole('button', { name: 'Open Precalculus grades' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: 'Precalculus' })).toBeVisible();
  await expect(sheet.getByRole('note')).toContainText('Problem set 7 is missing');
  const goal = sheet.getByRole('region', { name: 'Goal' });
  await choose(goal.getByRole('combobox', { name: 'Goal type' }), 'Custom percentage');
  await goal.getByRole('textbox', { name: 'Target percentage' }).fill('87.25');
  await expect.poll(() => goalRow(id, '12')).toEqual({ goal: { kind: 'percent', percent: 87.25 }, plan: null });
  await expect(goal.getByRole('img')).toHaveAttribute('aria-label', /goal 87\.25%$/);
  await shot(page, '6-mobile-custom-goal');

  // Typed scores keep their result in view at the bottom of the sheet.
  await sheet.getByRole('textbox', { name: 'Score for Quiz 5: Unit circle' }).fill('18');
  await sheet.getByRole('textbox', { name: 'Score for Problem set 9' }).fill('10');
  const bar = sheet.getByRole('status', { name: 'What if' });
  await expect(bar).toContainText(/short of 87\.25%|Reaches your goal of 87\.25%/);
  await expect(bar).toBeInViewport();
  await shot(page, '7-mobile-whatif');
  await bar.getByRole('button', { name: 'Clear' }).click();
  await expect(bar).toHaveCount(0);

  // The switcher moves between classes without leaving the sheet.
  await sheet.getByRole('group', { name: 'Switch class' }).getByRole('button', { name: 'AP Biology' }).click();
  await expect(sheet.getByRole('heading', { name: 'AP Biology' })).toBeVisible();
  await expect(sheet.getByRole('group', { name: 'Switch class' }).getByRole('button', { name: 'AP Biology' })).toHaveAttribute('aria-pressed', 'true');
  await sheet.getByRole('group', { name: 'Switch class' }).getByRole('button', { name: 'Studio Art' }).click();
  await expect(sheet).toContainText('Schoology shows no grade here yet. You can set a goal once a grade lands.');
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/\/classes\?tab=grades$/);
  await noOverflow(page);
});

test('schoology-connect beta: connecting, the finish-connecting recovery, errors, and a refused connection', async ({ browser }) => {
  test.setTimeout(120_000);
  const id = seed({ beta: true, connected: false });
  const page = await signedIn(browser, id);
  // Schoology's approval page: blank the first time (as some students have seen), then a normal return.
  let blank = true;
  await page.route('https://app.schoology.com/oauth/authorize**', route => blank
    ? route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body></body></html>' })
    : route.fulfill({ status: 302, headers: { location: `${origin}/classes?schoology=return&oauth_token=req-token` } }));
  await page.goto('/classes?tab=grades');
  const origin = new URL(page.url()).origin;
  await expect(page.getByRole('heading', { name: 'See your grades here' })).toBeVisible();
  await shot(page, '8-desktop-unconnected');
  await page.getByRole('button', { name: 'Connect Schoology', exact: true }).click();
  await page.waitForURL(/app\.schoology\.com\/oauth\/authorize\?oauth_token=req-token&return_url=localhost/);

  // Came back by hand from the blank page: "Finish connecting" is offered. Schoology hasn't approved yet, so it says so and keeps the offer.
  await page.goto('/classes?tab=grades');
  await page.getByRole('button', { name: 'Finish connecting' }).click();
  await expect(alerts(page)).toContainText('Make sure you approved Quasar, then try Finish connecting again.');
  school.approved = true;
  await page.getByRole('button', { name: 'Finish connecting' }).click();
  await expect(cards(page).getByRole('listitem')).toHaveCount(3);
  await expect(alerts(page)).toHaveCount(0);

  // Disconnect from settings, then the ordinary round trip through Schoology's return address.
  await page.getByRole('button', { name: 'Schoology settings' }).click();
  await page.getByRole('dialog', { name: 'Schoology settings' }).getByRole('button', { name: 'Disconnect Schoology' }).click();
  await page.getByRole('dialog', { name: 'Schoology settings' }).getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('heading', { name: 'See your grades here' })).toBeVisible();
  blank = false;
  await page.getByRole('button', { name: 'Connect Schoology', exact: true }).click();
  await expect(cards(page).getByRole('listitem')).toHaveCount(3);
  await expect(page).toHaveURL(/\/classes\?tab=grades$/);

  // Schoology is down: the last grades stay on screen with the error, and Try again recovers.
  school.grades = 'down';
  await page.waitForTimeout(REFRESH_GAP_MS);
  await page.getByRole('button', { name: 'Refresh grades' }).click();
  await expect(alerts(page)).toContainText('Schoology didn’t answer. Try again in a minute. Showing the grades from the last check.');
  await expect(cards(page).getByRole('listitem')).toHaveCount(3);
  school.grades = 'ok';
  const recovered = page.waitForResponse(response => response.url().includes('/api/trpc/schoology.gradebook') && response.request().method() === 'POST');
  await alerts(page).getByRole('button', { name: 'Try again' }).click();
  expect((await recovered).ok()).toBe(true);
  await expect(page.getByRole('button', { name: 'Refresh grades' })).toBeEnabled();
  await expect(alerts(page)).toHaveCount(0);

  // Schoology refuses the saved token: the connection is dropped and the student is asked to connect again.
  school.grades = 'refused';
  await page.waitForTimeout(REFRESH_GAP_MS);
  await page.getByRole('button', { name: 'Refresh grades' }).click();
  await expect(alerts(page)).toContainText('Schoology no longer lets Quasar in. Connect it again.');
  await expect(page.getByRole('heading', { name: 'See your grades here' })).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
});

test('outside the schoology-connect beta Classes has no Grades tab, and joining the public beta adds it', async ({ browser }) => {
  const id = seed({ beta: false, connected: false });
  const page = await signedIn(browser, id, true);
  await page.goto('/classes?tab=grades');
  await expect(page.getByRole('list', { name: 'Your classes' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Grades', exact: true })).toHaveCount(0);
  await expect(page.getByText('See your grades here')).toHaveCount(0);
  // The server refuses the gradebook too, whatever the page shows.
  const refused = await page.evaluate(async (accountId) => {
    const response = await fetch('/api/trpc/schoology.gradebook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId }) });
    return { status: response.status, body: await response.text() };
  }, id);
  expect(refused.status).toBe(403);
  expect(refused.body).toContain('Join it in Account');

  // A public beta is joined with a tap in Account → Betas, no code.
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('dialog', { name: 'Account', exact: true }).getByRole('button', { name: /^Betas/ }).click();
  const betas = page.getByRole('dialog', { name: 'Betas', exact: true });
  await expect(betas).toContainText('Schoology grades');
  await betas.getByRole('button', { name: 'Join Schoology grades' }).click();
  await expect.poll(() => { const db = openDatabase(process.env.E2E_DATABASE_PATH!); try { return db.prepare('SELECT count(*) n FROM beta_members WHERE beta_key=? AND user_id=?').get(SCHOOLOGY_BETA, id); } finally { db.close(); } }).toEqual({ n: 1 });
  await page.goto('/classes?tab=grades');
  await expect(page.getByRole('radio', { name: 'Grades', exact: true })).toBeChecked();
  await expect(page.getByRole('heading', { name: 'See your grades here' })).toBeVisible();
});
