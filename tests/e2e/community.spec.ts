import { test, expect, hydrating } from './fixtures';
import { type Browser, type BrowserContext, type Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/server/db';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';

/** Two schoolmates at one school; the school is padded to the 10-member lock when `locked` is set. */
function seed(locked = false) {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const service = new Service(db, 'browser-owner@example.com');
    const user = (name: string, email = `${randomUUID()}@example.com`) => {
      const id = randomUUID();
      db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, name, `${name} Fullname`, new Date().toISOString());
      return id;
    };
    const alice = user('Alice'), bob = user('Bob');
    const school = service.createSchool(alice, { name: `Community High ${alice.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    service.join(alice, { schoolId: school.id, choice: 'community', grade: '10' });
    service.join(bob, { schoolId: school.id, choice: 'community', grade: '10' });
    db.prepare("UPDATE entities SET data=? WHERE owner_id=? AND id='personal'").run(JSON.stringify({ classes: [{ id: 'c1', name: 'Algebra II', room: '204', teacher: 'Ms. Rivera' }], assignments: { A: 'c1' }, cycleDayOverrides: [], dateOverrides: [], customSchedule: null, grade: '10' }), bob);
    if (locked) {
      for (let index = 0; index < 8; index += 1) service.join(user(`Member ${index}`), { schoolId: school.id, choice: 'community' });
      for (const id of [alice, bob]) db.prepare('INSERT INTO school_verifications(user_id,school_id,method,verified_at) VALUES(?,?,?,?)').run(id, school.id, 'support', new Date().toISOString());
    }
    return { alice, bob, school };
  } finally { db.close(); }
}
async function authenticate(context: BrowserContext, id: string) {
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
}
const contexts: BrowserContext[] = [];
// `browser` outlives each test, so these hand-made profiles (and their background syncs) must be closed here.
test.afterEach(async () => { await Promise.all(contexts.splice(0).map((context) => context.close())); });

/** Each student gets their own browser profile, like separate phones. */
async function signedIn(browser: Browser, id: string): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  await authenticate(context, id);
  return hydrating(await context.newPage());
}

test('friends share classes only after acceptance, and removal revokes access', async ({ browser }, testInfo) => {
  const f = seed();
  const page = await signedIn(browser, f.alice);
  await page.goto('/people');
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'School verification' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verify my school' })).toBeVisible();
  const bobRow = page.getByRole('list', { name: 'Schoolmates' }).getByRole('listitem').filter({ hasText: 'Bob' });
  await expect(bobRow).toContainText('Grade 10');
  await expect(bobRow).not.toContainText('Bob Fullname');
  await bobRow.getByRole('button', { name: 'Add friend' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Request sent to Bob.' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Sent friend requests' })).toContainText('Bob');
  await page.screenshot({ path: testInfo.outputPath('people-alice-requested.png'), fullPage: true });

  // Bob sees the request badge and accepts.
  const bob = await signedIn(browser, f.bob);
  await bob.goto('/');
  // The badge is decorative; the People link carries the count as its description.
  await expect(bob.getByRole('link', { name: 'People', exact: true }).filter({ visible: true }).first()).toHaveAccessibleDescription('1 friend request');
  await bob.goto('/people');
  const incoming = bob.getByRole('list', { name: 'Incoming friend requests' }).getByRole('listitem').filter({ hasText: 'Alice' });
  await incoming.getByRole('button', { name: 'Accept' }).click();
  await expect(bob.getByRole('status').filter({ hasText: 'You and Alice are now friends.' })).toBeVisible();
  await expect(bob.getByRole('list', { name: 'Friends' })).toContainText('Alice');

  // Alice can now see Bob's classes and his day.
  await page.reload();
  await page.getByRole('list', { name: 'Friends' }).getByRole('button', { name: 'See day' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Bob', exact: true })).toBeVisible();
  await expect(dialog).toContainText('Algebra II');
  await expect(dialog).toContainText('Ms. Rivera');
  await expect(dialog.getByRole('heading', { name: 'Bob’s day' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('people-friend-profile.png'), fullPage: true });
  // Cancel on the in-place confirmation leaves the friendship alone.
  await dialog.getByRole('button', { name: 'Remove friend' }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Remove Bob', exact: true })).toBeHidden();
  await expect(dialog).toContainText('Algebra II');
  await dialog.getByRole('button', { name: 'Remove friend' }).click();
  await dialog.getByRole('button', { name: 'Remove Bob', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Friend removed.' })).toBeVisible();
  await expect(dialog).not.toContainText('Algebra II');
  await expect(dialog).toContainText('shared between friends only');
});

test('blocking hides both members and reports reach support', async ({ browser }) => {
  const f = seed();
  const page = await signedIn(browser, f.alice);
  await page.goto('/people');
  await page.getByRole('list', { name: 'Schoolmates' }).getByRole('button', { name: 'Open Bob’s profile' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Report' }).click();
  await dialog.getByLabel('What happened?').fill('This account is pretending to be a teacher.');
  await dialog.getByRole('button', { name: 'Send report' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Report sent to support.' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Block', exact: true }).click();
  await dialog.getByRole('button', { name: 'Block Bob', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Unblock' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByRole('list', { name: 'Schoolmates' })).toHaveCount(0);
  await expect(page.getByText('Blocked (1)')).toBeVisible();
  const bob = await signedIn(browser, f.bob);
  await bob.goto('/people');
  await expect(bob.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
  await expect(bob.getByRole('list', { name: 'Schoolmates' })).toHaveCount(0);
  await expect(bob.getByText('Nobody else has joined yet')).toBeVisible();
});

test('verified members of a locked school propose and vote on schedule changes', async ({ browser }, testInfo) => {
  const f = seed(true);
  const page = await signedIn(browser, f.alice);
  await page.goto('/school');
  await expect(page.getByRole('heading', { name: 'Proposed changes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit shared schedule' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Propose a change' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('What changes and why?').fill('Rename period A to Block A to match the new bell schedule.');
  await expect(dialog.getByRole('button', { name: 'Open the vote' })).toBeDisabled();
  await dialog.getByRole('tab', { name: /^Periods/ }).click();
  await dialog.getByLabel('Period 1 name').fill('Block A');
  await expect(dialog.getByRole('button', { name: 'Open the vote' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Open the vote' }).click();
  await expect(dialog).toHaveCount(0);
  const card = page.getByRole('listitem').filter({ hasText: 'Rename period A to Block A' });
  await expect(card).toContainText('Voting open');
  await expect(card).toContainText('1 for · 0 against');
  await expect(card.getByRole('button', { name: 'For' })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('school-proposal-open.png'), fullPage: true });

  const bob = await signedIn(browser, f.bob);
  await bob.goto('/school');
  const bobCard = bob.getByRole('listitem').filter({ hasText: 'Rename period A to Block A' });
  await bobCard.getByRole('button', { name: 'See proposed schedule' }).click();
  await expect(bobCard).toContainText('Proposed');
  await bobCard.getByRole('button', { name: 'Against' }).click();
  await expect(bobCard).toContainText('1 for · 1 against');
  await bobCard.getByRole('button', { name: 'For' }).click();
  await expect(bobCard).toContainText('2 for · 0 against');
});
