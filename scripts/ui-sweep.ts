/**
 * Screenshot sweep of the production build. Seeds a rich fixture, starts `next start` on port 3120,
 * and captures every main screen for phone/desktop x light/dark into /tmp/quasar-shots/.
 * Run: node --import tsx scripts/ui-sweep.ts   (requires an existing `npm run build`)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { hydrating } from '../tests/e2e/fixtures';
import { encode } from 'next-auth/jwt';
import { openDatabase } from '../src/server/db';
import { Service } from '../src/server/service';
import { CommunityService } from '../src/server/community';
import { ProposalService } from '../src/server/proposals';
import { ChatService } from '../src/server/chat';
import { exampleSchedule } from '../src/domain/example';

const PORT = 3120;
const BASE = `http://localhost:${PORT}`;
const OUT = '/tmp/quasar-shots';
const DB_PATH = '/tmp/quasar-sweep.sqlite';
const SECRET = 'test-only-secret-which-is-never-used-in-production-123456789';
const OWNER_EMAIL = 'browser-owner@example.com';
const NOW = new Date('2026-09-17T12:51:37Z');
const PAST = '2026-09-10T15:00:00.000Z';

// `next start` fills every key that is still undefined from .env.local, so production-only keys are blanked here
// (an empty value counts as defined) to keep the real scan provider and VAPID keys out of the sweep server.
Object.assign(process.env, {
  DATABASE_PATH: DB_PATH, NEXTAUTH_SECRET: SECRET, NEXTAUTH_URL: BASE, OWNER_EMAIL,
  GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-client-secret',
  SCAN_API_URL: '', SCAN_API_KEY: '', SCAN_MODEL: '', SCAN_MODEL_REASONING: '', SCAN_MODEL_TEMPERATURE: '',
  VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '',
});

type Fixture = { maya: string; bob: string; owner: string; newbies: string[]; schoolName: string; checklistTitle: string; chatThread: string; chatReadSeq: number };

function seed(): Fixture {
  for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
  const db = openDatabase(DB_PATH);
  try {
    const service = new Service(db, OWNER_EMAIL);
    const community = new CommunityService(service);
    const user = (display: string, full: string, email = `${randomUUID()}@example.com`) => {
      const id = randomUUID();
      db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, display, full, PAST);
      return id;
    };
    const maya = user('Maya', 'Maya Patel');
    const bob = user('Bob', 'Bob Nakamura');
    const chen = user('Chen', 'Chen Wei');
    const dana = user('Dana', 'Dana Brooks');
    const eli = user('Eli', 'Eli Blocked');
    const owner = user('Owner', 'Quasar Owner', OWNER_EMAIL);
    const schoolName = 'Lincoln High School';
    const school = service.createSchool(maya, { name: schoolName, location: 'Boston, MA', schedule: exampleSchedule });
    for (const [id, grade] of [[maya, '10'], [bob, '10'], [chen, '10'], [dana, '11'], [eli, '10'], [owner, '12']] as const)
      service.join(id, { schoolId: school.id, choice: 'community', grade });
    const padding = ['Jordan', 'Priya', 'Sam', 'Tariq'].map((name) => user(name, `${name} Member`));
    for (const id of padding) service.join(id, { schoolId: school.id, choice: 'community', grade: '10' });
    const insertVerification = db.prepare('INSERT INTO school_verifications(user_id,school_id,method,verified_at) VALUES(?,?,?,?)');
    for (const id of [maya, bob, chen, dana, owner, ...padding]) insertVerification.run(id, school.id, 'support', PAST);

    // Maya: six classes, four placed on the A-D periods of the example schedule (it only has four class periods).
    const setPersonal = (id: string, data: unknown) => db.prepare("UPDATE entities SET data=? WHERE owner_id=? AND id='personal'").run(JSON.stringify(data), id);
    setPersonal(maya, {
      classes: [
        { id: 'alg2', name: 'Algebra II', room: '204', teacher: 'Ms. Rivera', color: '#2563eb' },
        { id: 'chem', name: 'Chemistry', room: 'Lab 3', teacher: 'Dr. Okafor', color: '#16a34a' },
        { id: 'eng10', name: 'English 10', room: '112', teacher: 'Mr. Hale', color: '#db2777' },
        { id: 'ushist', name: 'US History', room: '305', teacher: 'Mrs. Lin', color: '#d97706' },
        { id: 'spanish', name: 'Spanish III', room: '221', teacher: 'Sra. Ortiz', color: '#7c3aed' },
        { id: 'art', name: 'Studio Art', room: 'Art Room', teacher: 'Ms. Kim', color: '#0891b2' },
      ],
      assignments: { A: 'alg2', B: 'chem', C: 'eng10', D: 'ushist' },
      cycleDayOverrides: [], dateOverrides: [], customSchedule: null, grade: '10',
    });
    setPersonal(bob, { classes: [{ id: 'c1', name: 'Algebra II', room: '204', teacher: 'Ms. Rivera' }, { id: 'c2', name: 'Physics', room: 'Lab 1', teacher: 'Mr. Grant' }], assignments: { A: 'c1', B: 'c2' }, cycleDayOverrides: [], dateOverrides: [], customSchedule: null, grade: '10' });

    const task = (id: string, data: Record<string, unknown>) => {
      const result = service.sync(maya, { mutationId: randomUUID(), id, kind: 'task', base: null,
        data: { dueDate: null, dueTime: null, classId: null, notes: '', completed: false, ...data } } as never);
      if (result.status !== 'applied') throw new Error(`Task ${id} was not applied: ${JSON.stringify(result)}`);
    };
    const checklistTitle = 'Chemistry lab report';
    task('t-overdue', { title: 'Spanish vocab quiz corrections', dueDate: '2026-09-15', classId: 'spanish' });
    task('t-today', { title: 'Algebra II problem set 3.2', dueDate: '2026-09-17', dueTime: '15:30', classId: 'alg2', notes: 'Odd problems 1-29.' });
    task('t-tomorrow', { title: 'Read chapters 4-5 of The Great Gatsby', dueDate: '2026-09-18', classId: 'eng10' });
    task('t-nextweek', { title: 'US History essay outline', dueDate: '2026-09-23', dueTime: '08:00', classId: 'ushist' });
    task('t-nodate', { title: 'Pick a sketchbook theme', classId: 'art' });
    task('t-checklist', { title: checklistTitle, dueDate: '2026-09-19', classId: 'chem', priority: 'high', notes: 'Titration lab. Include error analysis.',
      subtasks: [{ id: randomUUID(), title: 'Record data tables', completed: true }, { id: randomUUID(), title: 'Write analysis', completed: false }, { id: randomUUID(), title: 'Draw titration curve', completed: false }] });
    task('t-done', { title: 'Return signed syllabus', dueDate: '2026-09-16', completed: true });
    task('t-weekly', { title: 'Weekly Spanish journal', dueDate: '2026-09-21', classId: 'spanish', recurrence: { frequency: 'weekly', interval: 1, until: null } });

    // Community: Bob is a friend, Chen asked Maya, Maya asked Dana, Maya blocked Eli.
    community.request(maya, bob); community.respond(bob, maya, true);
    community.request(chen, maya);
    community.request(maya, dana);
    community.block(maya, eli, true);
    db.prepare('UPDATE friendships SET created_at=?, responded_at=CASE WHEN responded_at IS NULL THEN NULL ELSE ? END').run(PAST, PAST);
    db.prepare('UPDATE blocks SET created_at=?').run(PAST);

    // Bob proposes a schedule change; one padding member agrees.
    const proposed = structuredClone(exampleSchedule);
    proposed.periods = proposed.periods.map((period) => period.id === 'A' ? { ...period, label: 'Block A' } : period);
    const current = service.school(school.id);
    const proposal = new ProposalService(service).create(bob, { schoolId: school.id, baseVersion: current.version, schedule: proposed,
      summary: 'Rename period A to Block A so it matches the new bell schedule posted in the main office.' });
    new ProposalService(service).vote(padding[0], { proposalId: proposal.id, vote: 'for' });
    db.prepare('UPDATE schedule_proposals SET created_at=?').run('2026-09-16T14:00:00.000Z');
    db.prepare('UPDATE proposal_votes SET created_at=?').run('2026-09-16T14:30:00.000Z');

    // Chat (phase 4). Bob and Maya talk across two days; Priya's chat is muted with one unread; Sam is a
    // friend with no messages yet; Tariq's chat closed (unfriended) after Maya reported it.
    const [priya, sam, tariq] = [padding[1], padding[2], padding[3]];
    for (const friend of [priya, sam, tariq]) { community.request(maya, friend); community.respond(friend, maya, true); }
    let clock = new Date('2026-09-16T20:05:00Z');
    const chat = new ChatService(service, () => clock);
    const say = (from: string, to: string, text: string, at: string) => { clock = new Date(at); return chat.send(from, to, randomUUID(), text).message; };
    say(bob, maya, 'Did you finish the chem pre-lab?', '2026-09-16T20:05:00Z');
    say(maya, bob, 'Almost. Question 4 is confusing', '2026-09-16T20:07:00Z');
    say(maya, bob, 'Is it asking for moles or grams?', '2026-09-16T20:07:30Z');
    say(bob, maya, 'Grams. Ms. Okafor said so in class', '2026-09-16T20:09:00Z');
    const oops = say(maya, bob, 'ok thanks!! 🙏', '2026-09-16T20:10:00Z');
    clock = new Date('2026-09-16T20:11:00Z'); chat.delete(maya, bob, oops.id);
    const readUpTo = say(maya, bob, 'Thanks, that helps', '2026-09-16T20:11:30Z');
    say(bob, maya, 'Study group for the Algebra II quiz tomorrow before first period? Library, 7:15. Bring the review sheet from https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit so we can split up the problems.', '2026-09-17T12:30:00Z');
    say(bob, maya, 'Also can you send me the notes from US History?', '2026-09-17T12:31:00Z');
    say(priya, maya, 'Are you going to the game Friday?', '2026-09-17T11:10:00Z');
    clock = new Date('2026-09-17T11:11:00Z'); chat.mute(maya, priya, true);
    say(tariq, maya, 'Why did you not answer me', '2026-09-15T21:00:00Z');
    say(tariq, maya, 'Answer me now', '2026-09-15T21:02:00Z');
    clock = new Date('2026-09-15T21:05:00Z');
    chat.report(maya, tariq, { category: 'danger', note: 'He keeps messaging me late at night.', block: false });
    community.remove(maya, tariq);
    const bobThread = db.prepare('SELECT thread_id FROM chat_messages WHERE seq=?').get(readUpTo.seq) as { thread_id: string };

    // One onboarding user per viewport/theme combination, since completing the names step persists them.
    const newbies = Array.from({ length: 4 }, () => user('', ''));
    return { maya, bob, owner, newbies, schoolName, checklistTitle, chatThread: bobThread.thread_id, chatReadSeq: readUpTo.seq };
  } finally { db.close(); }
}

/**
 * A sweep server orphaned by a killed run (SIGKILL cannot be caught) would otherwise answer the health check
 * for the new one, serving its old, already-deleted database. Checked before seed() deletes that database.
 */
function assertPortFree(): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => reject(error.code === 'EADDRINUSE'
      ? new Error(`Port ${PORT} is already in use, probably by a sweep server an earlier run left behind. Stop it (for example \`fuser -k ${PORT}/tcp\`) and run again.`)
      : error));
    probe.listen(PORT, '127.0.0.1', () => probe.close(() => resolve()));
  });
}

async function waitForHealth(server: ChildProcess) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Server exited early (${server.exitCode ?? server.signalCode}); see ${OUT}/server.log`);
    let healthy = false;
    try { healthy = (await fetch(`${BASE}/api/health`)).ok; } catch { /* not up yet */ }
    // Only the server spawned by this run counts: a healthy answer after it died came from something else.
    if (healthy && server.exitCode === null && server.signalCode === null) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Server did not become healthy within 90s');
}

const manifest: string[] = [];
const failures: string[] = [];

type Variant = { device: 'phone' | 'desktop'; theme: 'light' | 'dark' };

async function newContext(browser: Browser, variant: Variant, userId: string | null) {
  const context = await browser.newContext({
    ...(variant.device === 'phone' ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 900 } }),
    colorScheme: variant.theme, timezoneId: 'America/New_York', locale: 'en-US', reducedMotion: 'reduce',
  });
  await context.addInitScript((appearance) => { try { localStorage.setItem('quasar.appearance', appearance); } catch { /* ignore */ } }, variant.theme);
  if (userId) {
    const token = await encode({ secret: SECRET, token: { userId }, maxAge: 3600 });
    await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
  }
  return context;
}

async function newPage(context: BrowserContext) {
  const page = hydrating(await context.newPage());
  await page.clock.setFixedTime(NOW);
  return page;
}

async function settle(page: Page, ms = 700) {
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
  await page.waitForTimeout(ms);
}

async function shot(page: Page, screen: string, variant: Variant, what: string, fullPage = true) {
  const path = `${OUT}/${screen}-${variant.device}-${variant.theme}.png`;
  await settle(page);
  // Flag pages wider than the device. Mobile emulation widens the layout viewport to fit overflowing
  // content, so compare against the configured viewport rather than innerWidth.
  const expected = page.viewportSize()?.width ?? 0;
  const overflow = await page.evaluate((width) => {
    const actual = Math.max(window.innerWidth, document.documentElement.scrollWidth);
    if (actual <= width) return null;
    const offenders = [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((element) => element.getBoundingClientRect().right > width + 1 && element.getClientRects().length > 0)
      .slice(0, 5)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 80)} right=${Math.round(element.getBoundingClientRect().right)}`);
    return { actual, width, offenders };
  }, expected);
  if (overflow) console.warn('OVERFLOW', screen, variant.device, variant.theme, JSON.stringify(overflow));
  await page.screenshot({ path, fullPage, animations: 'disabled' });
  manifest.push(`${path} — ${what}${fullPage ? '' : ' (viewport capture; dialog overlay)'}`);
  console.log('captured', path);
}

async function attempt(screen: string, variant: Variant, fn: () => Promise<void>) {
  try { await fn(); }
  catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    failures.push(`${screen}-${variant.device}-${variant.theme}: ${message}`);
    console.warn('FAILED', screen, variant, message);
  }
}

async function openAccount(page: Page) {
  const account = page.getByRole('button', { name: 'Account', exact: true });
  if (await account.isVisible().catch(() => false)) await account.click();
  else await page.getByRole('button', { name: /Maya|Owner/ }).and(page.locator('[aria-haspopup="dialog"]')).first().click();
  await page.getByRole('dialog').waitFor();
}

async function sweep(browser: Browser, fixture: Fixture, variant: Variant, newbie: string) {
  // Unauthenticated landing.
  {
    const context = await newContext(browser, variant, null);
    const page = await newPage(context);
    await attempt('signin', variant, async () => {
      await page.goto(BASE + '/');
      await page.getByRole('button', { name: 'Continue with Google' }).waitFor();
      await shot(page, 'signin', variant, 'Signed-out landing page with Continue with Google');
    });
    await context.close();
  }

  // Maya, the main student.
  const context = await newContext(browser, variant, fixture.maya);
  const page = await newPage(context);
  const go = async (view: string, heading: RegExp | string) => {
    await page.goto(`${BASE}/${view === 'today' ? '' : view}`);
    await page.getByRole('heading', { name: heading, exact: typeof heading === 'string' }).first().waitFor({ timeout: 20_000 });
  };
  await attempt('today', variant, async () => { await go('today', /Maya/); await shot(page, 'today', variant, 'Today view for Maya at 8:51 AM Thursday, period A in progress, tasks due'); });
  await attempt('schedule', variant, async () => { await go('schedule', 'Schedule'); await shot(page, 'schedule', variant, 'Schedule view, today selected in the week strip, timeline and rotation'); });
  await attempt('schedule-day', variant, async () => {
    await go('schedule', 'Schedule');
    const monday = page.locator('[aria-label="Week"] button[aria-pressed]').filter({ hasText: /^Mon/ }).first();
    await monday.click();
    await page.locator('[aria-label="Week"] button[aria-pressed="true"]').filter({ hasText: /^Mon/ }).waitFor();
    await shot(page, 'schedule-day', variant, 'Schedule view after tapping Monday in the week strip');
  });
  await attempt('tasks', variant, async () => { await go('tasks', 'Tasks'); await shot(page, 'tasks', variant, 'Tasks list: overdue, today, tomorrow, later, no date, completed'); });
  await attempt('tasks-edit', variant, async () => {
    await go('tasks', 'Tasks');
    await page.getByRole('button', { name: `Edit ${fixture.checklistTitle}` }).first().click();
    await page.getByRole('dialog').waitFor();
    await shot(page, 'tasks-edit', variant, 'Task edit dialog for the high-priority checklist task (1 of 3 done)', false);
  });
  await attempt('classes', variant, async () => { await go('classes', 'Classes'); await shot(page, 'classes', variant, 'Classes view: six classes with colors, rooms, teachers, and the timetable'); });
  await attempt('classes-edit', variant, async () => {
    await go('classes', 'Classes');
    await page.getByRole('button', { name: 'Edit Algebra II' }).first().click();
    await page.getByRole('dialog').waitFor();
    await shot(page, 'classes-edit', variant, 'Class edit dialog for Algebra II', false);
  });
  await attempt('school', variant, async () => { await go('school', fixture.schoolName); await shot(page, 'school', variant, 'School view for Lincoln High School (locked, 10+ members)'); });
  await attempt('school-proposal', variant, async () => {
    await go('school', fixture.schoolName);
    const heading = page.getByRole('heading', { name: 'Proposed changes' });
    await heading.waitFor();
    const toggle = page.getByRole('button', { name: 'See proposed schedule' }).first();
    await toggle.click();
    await page.getByRole('button', { name: 'Hide proposed schedule' }).first().waitFor();
    await heading.scrollIntoViewIfNeeded();
    await shot(page, 'school-proposal', variant, 'School view with Bob’s open proposal expanded to show the proposed schedule');
  });
  await attempt('people', variant, async () => { await go('people', 'People'); await shot(page, 'people', variant, 'People view: incoming request from Chen, sent request to Dana, friend Bob, schoolmates, blocked (1)'); });
  await attempt('people-profile', variant, async () => {
    await go('people', 'People');
    await page.getByRole('button', { name: 'Open Bob’s profile' }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').getByRole('heading', { name: 'Bob', exact: true }).waitFor();
    await shot(page, 'people-profile', variant, 'Bob’s profile dialog (friend, shares Algebra II in period A)', false);
  });
  // Each variant starts with Bob's two newest messages unread (the previous variant's visit read them).
  const unreadBob = () => {
    const db = openDatabase(DB_PATH);
    try { db.prepare('UPDATE chat_members SET last_read_seq=? WHERE thread_id=? AND user_id=?').run(fixture.chatReadSeq, fixture.chatThread, fixture.maya); }
    finally { db.close(); }
  };
  await attempt('messages', variant, async () => {
    unreadBob();
    await go('messages', 'Messages');
    await page.getByRole('list', { name: 'Chats' }).getByRole('button', { name: 'Open chat with Bob' }).waitFor({ timeout: 20_000 });
    await shot(page, 'messages', variant, 'Messages list: Bob (2 unread), Priya (muted, 1 unread), Tariq (chat closed), Sam under Friends');
  });
  await attempt('messages-thread', variant, async () => {
    unreadBob();
    await page.goto(`${BASE}/messages?with=${fixture.bob}`);
    await page.getByRole('log', { name: 'Messages with Bob' }).getByText('notes from US History', { exact: false }).waitFor({ timeout: 20_000 });
    await shot(page, 'messages-thread', variant, 'Thread with Bob: yesterday and today, a deleted message, a link, the New messages divider', false);
    await attempt('messages-actions', variant, async () => {
      const item = page.getByRole('log', { name: 'Messages with Bob' }).getByRole('listitem').filter({ hasText: 'Grams. Ms. Okafor' });
      // Not a bubble tap on the phone: an earlier full-page screenshot resets Chromium's touch emulation,
      // so (pointer: fine) matches and the tap handler (correctly, for a mouse) ignores it.
      await item.hover();
      await item.getByRole('button', { name: 'Message actions' }).click();
      await item.getByRole('button', { name: 'Add as task' }).waitFor();
      await page.getByRole('textbox', { name: 'Message Bob' }).fill('Sure, sending them tonight');
      await shot(page, 'messages-actions', variant, 'Thread with the message actions row open and a draft in the composer', false);
    });
    await attempt('messages-report', variant, async () => {
      await page.getByRole('button', { name: 'Report', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Report Bob' });
      await dialog.getByRole('radio', { name: 'Someone may be in danger' }).click();
      await dialog.getByText('call or text 988', { exact: false }).waitFor();
      await shot(page, 'messages-report', variant, 'Report Bob dialog with Danger chosen and the 911/988 callout', false);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
    });
  });
  await attempt('account', variant, async () => {
    await go('today', /Maya/);
    await openAccount(page);
    await shot(page, 'account', variant, 'Account sheet opened from the avatar/account button', false);
    await attempt('account-theme', variant, async () => {
      const accent = page.getByRole('dialog').getByRole('radiogroup', { name: 'Accent color' });
      await accent.scrollIntoViewIfNeeded();
      await shot(page, 'account-theme', variant, 'Account sheet scrolled to the theme picker (appearance + accent)', false);
    });
  });
  await context.close();

  // Onboarding with a fresh user who has no names yet.
  {
    const ctx = await newContext(browser, variant, newbie);
    const p = await newPage(ctx);
    await attempt('onboarding-names', variant, async () => {
      await p.goto(BASE + '/');
      await p.getByLabel('Display name').waitFor({ timeout: 20_000 });
      await shot(p, 'onboarding-names', variant, 'Onboarding step 1: display name and full name (empty)');
      await attempt('onboarding-school', variant, async () => {
        await p.getByLabel('Display name').fill('Newbie');
        await p.getByLabel('Full name').fill('Newbie Student');
        await p.getByRole('button', { name: /Continue/ }).click();
        await p.getByRole('heading', { name: 'Find your school' }).waitFor({ timeout: 20_000 });
        await shot(p, 'onboarding-school', variant, 'Onboarding step 2: Find your school search');
        await attempt('onboarding-choice', variant, async () => {
          await p.getByLabel('School name or location').fill('Lincoln');
          await p.getByRole('button', { name: fixture.schoolName }).first().click();
          await p.getByRole('heading', { name: 'Which schedule should Quasar follow?' }).waitFor({ timeout: 20_000 });
          await shot(p, 'onboarding-choice', variant, 'Onboarding: schedule choice for Lincoln High School (grade + community/personal)');
        });
      });
    });
    await ctx.close();
  }

  // Help page (signed in as Maya) and owner admin.
  {
    const ctx = await newContext(browser, variant, fixture.maya);
    const p = await newPage(ctx);
    await attempt('help', variant, async () => {
      await p.goto(BASE + '/help');
      await p.getByRole('heading').first().waitFor({ timeout: 20_000 });
      await shot(p, 'help', variant, 'Help page (/help)');
    });
    await ctx.close();
  }
  {
    const ctx = await newContext(browser, variant, fixture.owner);
    const p = await newPage(ctx);
    await attempt('admin', variant, async () => {
      await p.goto(BASE + '/admin');
      await p.getByRole('heading', { name: 'Support' }).waitFor({ timeout: 20_000 });
      await p.getByRole('row').filter({ hasText: fixture.schoolName }).first().waitFor();
      await shot(p, 'admin', variant, 'Owner /admin support page (schools table, requests, proposals, reports)');
      await attempt('admin-review', variant, async () => {
        await p.getByRole('button', { name: `Review ${fixture.schoolName}` }).first().click();
        await p.getByRole('dialog').waitFor();
        await shot(p, 'admin-review', variant, 'Admin review sheet for Lincoln High School', false);
      });
    });
    await ctx.close();
  }
}

async function main() {
  if (!existsSync('.next/BUILD_ID')) throw new Error('No production build in .next. Run npm run build first.');
  mkdirSync(OUT, { recursive: true });
  await assertPortFree();
  const fixture = seed();
  // Loopback only (not `npm start`, which binds 0.0.0.0): SECRET is public, so the server must not be reachable from the LAN.
  const server = spawn('npx', ['next', 'start', '--hostname', '127.0.0.1', '--port', String(PORT)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let serverLog = '';
  server.stdout?.on('data', (chunk) => { serverLog += chunk; });
  server.stderr?.on('data', (chunk) => { serverLog += chunk; });
  const stop = () => { try { if (server.pid) process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ } };
  // The server runs in its own process group, so it outlives this script unless stopped explicitly.
  process.on('exit', stop);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) process.on(signal, () => { stop(); process.exit(code); });
  let browser: Browser | null = null;
  try {
    await waitForHealth(server);
    browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});
    const variants: Variant[] = [{ device: 'phone', theme: 'light' }, { device: 'phone', theme: 'dark' }, { device: 'desktop', theme: 'light' }, { device: 'desktop', theme: 'dark' }];
    // SWEEP_VARIANTS=phone-light,desktop-dark limits the run to those variants.
    const only = process.env.SWEEP_VARIANTS?.split(',').map((entry) => entry.trim()).filter(Boolean);
    for (const [index, variant] of variants.entries()) {
      if (only?.length && !only.includes(`${variant.device}-${variant.theme}`)) continue;
      await sweep(browser, fixture, variant, fixture.newbies[index]);
    }
  } finally {
    await browser?.close().catch(() => undefined);
    stop();
    writeFileSync(`${OUT}/server.log`, serverLog);
  }
  const text = [...manifest, '', 'NOT CAPTURED:', ...(failures.length ? failures : ['(none)'])].join('\n');
  writeFileSync(`${OUT}/MANIFEST.txt`, text + '\n');
  console.log('\n' + text);
  // Screens that were not captured fail the run, so a caller does not mistake a partial sweep for a complete one.
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
