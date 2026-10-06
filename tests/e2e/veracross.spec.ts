import { test, expect } from './fixtures';
import { type BrowserContext } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { openDatabase } from '../../src/server/db';
import { Service } from '../../src/server/service';
import { ScheduleFeedService } from '../../src/server/schedule-feed';
import { exampleSchedule } from '../../src/domain/example';
import { resolveDay } from '../../src/domain/schedule';

const TITLES: Record<string, string> = { A: 'Algebra II', B: 'English 10', C: 'Biology', D: 'US History' };

/** A Veracross-style class schedule around today: one VEVENT per meeting, room in LOCATION. */
function classSchedule() {
  const today = Temporal.Now.plainDateISO('America/New_York');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Veracross//Calendar//EN'];
  for (let date = today.subtract({ days: 21 }); Temporal.PlainDate.compare(date, today.add({ days: 21 })) <= 0; date = date.add({ days: 1 })) {
    for (const period of resolveDay(exampleSchedule, date.toString()).periods) {
      if (!TITLES[period.periodId]) continue;
      const stamp = (time: string) => `${date.toString().replaceAll('-', '')}T${time.replace(':', '')}00`;
      lines.push('BEGIN:VEVENT', `UID:${date}-${period.periodId}@veracross`, `DTSTART;TZID=America/New_York:${stamp(period.start)}`, `DTEND;TZID=America/New_York:${stamp(period.end)}`,
        `SUMMARY:${TITLES[period.periodId]}`, `LOCATION:Room ${period.periodId}1`, 'END:VEVENT');
    }
  }
  return [...lines, 'END:VCALENDAR'].join('\r\n');
}

/**
 * The browser cannot reach a real Veracross portal, and the server only fetches public HTTPS hosts, so the link is
 * connected here with the same service and a stand-in fetcher. Its saved URL is unreachable, so Sync now fails.
 */
async function seed(connect: boolean) {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, id, `${id}@example.com`, 'Browser Student', 'Browser Test Student', new Date().toISOString());
    const service = new Service(db, 'browser-owner@example.com');
    const school = service.createSchool(id, { name: `Veracross High ${id.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
    if (connect) {
      const feeds = new ScheduleFeedService(db, { secret: process.env.E2E_AUTH_SECRET!, fetcher: async () => ({ status: 200, text: classSchedule() }) });
      await feeds.connect(id, { source: 'veracross', url: 'https://veracross.invalid/subscribe/class-schedule.ics?t=private' });
      db.prepare('UPDATE schedule_feeds SET last_attempt_at=? WHERE owner_id=?').run(new Date(Date.now() - 120_000).toISOString(), id);
    }
    return id;
  } finally { db.close(); }
}

async function authenticate(context: BrowserContext, id: string) {
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
}

test('Connect Veracross explains where the link is and refuses a link it cannot use', async ({ page, context }) => {
  await authenticate(context, await seed(false));
  await page.goto('/classes');
  await page.getByRole('button', { name: 'Connect Veracross' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Connect Veracross' })).toBeVisible();
  await expect(dialog.getByText('Calendar Subscriptions', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Find my classes' })).toBeDisabled();
  await dialog.getByLabel('Class Schedule link').fill('http://portals.veracross.com/school/calendar.ics');
  await dialog.getByRole('button', { name: 'Find my classes' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Paste the whole subscription link');
  await expect(page.getByText('Synced from Veracross')).toHaveCount(0);
});

test('a connected class schedule fills the blocks and can be synced and disconnected', async ({ page, context }) => {
  await authenticate(context, await seed(true));
  await page.goto('/classes');
  const classes = page.getByRole('list', { name: 'Your classes' });
  for (const name of Object.values(TITLES)) await expect(classes.getByText(name, { exact: true })).toBeVisible();
  await expect(classes.getByText('Room C1')).toBeVisible();
  await expect(page.getByText('Synced from Veracross')).toBeVisible();
  await expect(page.getByText('4 classes in 4 blocks.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Veracross' })).toHaveCount(0);

  // The saved link cannot be reached from here, so the sync fails and says so without touching the classes.
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Could not read this link' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Sync failed')).toBeVisible();
  await expect(classes.getByText('Biology', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('alert').filter({ hasText: 'Disconnect Veracross?' }).getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByText('Synced from Veracross')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect Veracross' })).toBeVisible();
  await expect(classes.getByText('Biology', { exact: true })).toBeVisible();
});

test('the review step lists each class with its block and sends only the ticked ones', async ({ page, context }) => {
  await authenticate(context, await seed(false));
  // The server cannot reach a stand-in Veracross host, so the preview answer is supplied here; connect still goes to it.
  const rows = Object.entries(TITLES).map(([periodId, name]) => ({ key: name.toLowerCase(), name, room: `Room ${periodId}1`, meetings: 12, periodIds: [periodId], included: true, existing: false, replaces: [], kept: [] }));
  await page.route('**/api/trpc/scheduleFeed.preview**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ result: { data: { rows, unsettledPeriodIds: [], unmatched: 0 } } }]) }));
  let sent: Record<string, unknown> | null = null;
  await page.route('**/api/trpc/scheduleFeed.connect**', route => { sent = (Object.values(route.request().postDataJSON() as Record<string, unknown>)[0] ?? null) as Record<string, unknown>; return route.continue(); });
  await page.goto('/classes');
  await page.getByRole('button', { name: 'Connect Veracross' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Class Schedule link').fill('https://veracross.invalid/subscribe/class-schedule.ics');
  await dialog.getByRole('button', { name: 'Find my classes' }).click();
  await expect(dialog.getByRole('heading', { name: 'Check your classes' })).toBeVisible();
  const list = dialog.getByRole('list', { name: 'Classes from Veracross' });
  await expect(list.getByRole('listitem')).toHaveCount(4);
  await expect(list.getByRole('listitem').filter({ hasText: 'Biology' })).toContainText('Room C1');
  await list.getByRole('checkbox', { name: 'US History' }).click();
  await dialog.getByRole('button', { name: 'Add 3 classes' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not read this link');
  expect(sent).toMatchObject({ choices: { 'algebra ii': true, 'english 10': true, biology: true, 'us history': false } });
});
