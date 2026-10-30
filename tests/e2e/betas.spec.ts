import { test, expect, hydrating } from './fixtures';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { openDatabase } from '../../src/server/db';
import { createBeta, readBetaRegistry, writeBetaRegistry } from '../../src/server/beta-registry';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';

const OWNER_EMAIL = 'browser-owner@example.com';

/** An owner and a member who already joined a school, so the member lands on the app rather than onboarding. */
function seed() {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const service = new Service(db, OWNER_EMAIL);
    const user = (name: string, email: string) => {
      const id = randomUUID();
      db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, name, `${name} Tester`, new Date().toISOString());
      return id;
    };
    const owner = user('Owner', OWNER_EMAIL), member = user('Bea', `${randomUUID()}@example.com`);
    const school = service.createSchool(member, { name: `Beta High ${member.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    service.join(member, { schoolId: school.id, choice: 'community', grade: '10' });
    return { owner, member };
  } finally { db.close(); }
}

const contexts: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(contexts.splice(0).map((context) => context.close())); });
async function signedIn(browser: Browser, id: string, phone = false): Promise<Page> {
  const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : {});
  contexts.push(context);
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
  return hydrating(await context.newPage());
}

test('betas: one from the beta list shows its code to the owner; a member joins with it, sends feedback with diagnostics, and leaves without it', async ({ browser }) => {
  test.setTimeout(120_000);
  const f = seed();
  const key = `e2e-${f.member.slice(0, 8)}`;
  const name = `Month grid ${f.member.slice(0, 4)}`;
  const theCode = `GRID-${f.member.slice(0, 4)}`;
  // What `npm run beta -- create` writes. The list sits beside the test database, and the server reads it per request.
  const listPath = join(dirname(process.env.E2E_DATABASE_PATH!), 'betas.json');
  writeBetaRegistry(createBeta(readBetaRegistry(listPath), { key, name, description: 'Try the month view in Schedule.', code: theCode }), listPath);

  // The owner sees the beta and its code, with no way to create or edit one.
  const owner = await signedIn(browser, f.owner);
  await owner.goto('/admin');
  await owner.getByRole('tab', { name: 'Betas', exact: true }).click();
  const ownerRow = owner.getByRole('listitem').filter({ hasText: name });
  await expect(ownerRow.getByText(theCode, { exact: true })).toBeVisible();
  await expect(owner.getByRole('button', { name: 'New beta' })).toHaveCount(0);

  // The member types a wrong code, then the right one in another case and spacing.
  const member = await signedIn(browser, f.member, true);
  await member.goto('/');
  await member.getByRole('button', { name: 'Account', exact: true }).click();
  const account = member.getByRole('dialog', { name: 'Account', exact: true });
  const code = account.getByRole('textbox', { name: 'Beta code' });
  await code.fill('NOPE-1234');
  await account.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(account.getByRole('alert').filter({ hasText: 'That code doesn’t match an open beta' })).toBeVisible();
  await code.fill(theCode.toLowerCase().replace('-', ' '));
  await account.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(account.getByRole('status').filter({ hasText: `You’re in ${name}.` })).toBeVisible();
  const mine = account.getByRole('list', { name: 'Your betas' });
  await expect(mine.getByText(name)).toBeVisible();
  await expect(mine.getByText('Try the month view in Schedule.')).toBeVisible();

  // Feedback shows what it attaches before it is sent.
  await mine.getByRole('button', { name: 'Send feedback' }).click();
  const feedback = member.getByRole('dialog', { name: `Feedback on ${name}` });
  await feedback.getByText('Sent with your feedback').click();
  await expect(feedback.getByText('390×844', { exact: false })).toBeVisible();
  await expect(feedback.getByText(key, { exact: true })).toBeVisible();
  await feedback.getByRole('textbox', { name: 'Your feedback' }).fill('Week three overlaps the header on my phone.');
  await feedback.getByRole('button', { name: 'Send feedback' }).click();
  await expect(feedback.getByText('Sent. Thanks for testing.')).toBeVisible();
  await feedback.getByRole('button', { name: 'Done' }).click();

  // The owner sees it in the inbox with its diagnostics, and the member in the beta.
  await owner.reload();
  const report = owner.getByRole('listitem').filter({ hasText: 'Week three overlaps the header' });
  await expect(report.getByText(`Beta feedback: ${key}`)).toBeVisible();
  await report.getByText('Diagnostics').click();
  await expect(report.getByText('390×844', { exact: false })).toBeVisible();
  await owner.getByRole('tab', { name: 'Betas', exact: true }).click();
  await expect(ownerRow.getByText('1 member')).toBeVisible();
  await expect(ownerRow.getByText('1 open report')).toBeVisible();

  // Leaving is one tap, no code.
  await mine.getByRole('button', { name: `Leave ${name}` }).click();
  await expect(mine).toHaveCount(0);

  // Rejoin, then `?beta=off` leaves every beta before the page renders and drops itself from the address.
  await code.fill(theCode);
  await account.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(mine.getByText(name)).toBeVisible();
  await member.goto('/schedule?beta=off');
  await expect(member).toHaveURL(/\/schedule$/);
  await member.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(account.getByRole('textbox', { name: 'Beta code' })).toBeVisible();
  await expect(account.getByRole('list', { name: 'Your betas' })).toHaveCount(0);
});

test('betas screen: a member in the betas-screen beta opens Betas as a popup from Account and joins a public beta with a tap', async ({ browser }) => {
  test.setTimeout(120_000);
  const f = seed();
  const listPath = join(dirname(process.env.E2E_DATABASE_PATH!), 'betas.json');
  const screenCode = `SCREEN-${f.member.slice(0, 4)}`;
  const openName = `Quick add ${f.member.slice(0, 4)}`;
  let list = readBetaRegistry(listPath);
  // The screen's own beta is private, so its code gets the member in first.
  if (!list.betas.some((beta) => beta.key === 'betas-screen')) list = createBeta(list, { key: 'betas-screen', name: 'Betas screen', code: screenCode });
  const screen = list.betas.find((beta) => beta.key === 'betas-screen')!;
  list = createBeta(list, { key: `open-${f.member.slice(0, 8)}`, name: openName, description: 'Add tasks faster.', public: true });
  writeBetaRegistry(list, listPath);

  const member = await signedIn(browser, f.member, true);
  await member.goto('/');
  await member.getByRole('button', { name: 'Account', exact: true }).click();
  const account = member.getByRole('dialog', { name: 'Account', exact: true });
  // Before joining, Betas is the inline block, and public betas are not listed there.
  await expect(account.getByText(openName)).toHaveCount(0);
  await account.getByRole('textbox', { name: 'Beta code' }).fill(screen.code!);
  await account.getByRole('button', { name: 'Join', exact: true }).click();

  // Now Account has a single Betas row that opens the popup.
  await expect(account.getByRole('textbox', { name: 'Beta code' })).toHaveCount(0);
  await account.getByRole('button', { name: /^Betas/ }).click();
  const popup = member.getByRole('dialog', { name: 'Betas', exact: true });
  await expect(popup.getByRole('list', { name: 'Your betas' }).getByText('Betas screen')).toBeVisible();
  const offered = popup.getByRole('list', { name: 'Betas you can join' });
  await expect(offered.getByText('Add tasks faster.')).toBeVisible();
  await offered.getByRole('button', { name: `Join ${openName}` }).click();
  await expect(popup.getByRole('status').filter({ hasText: `You’re in ${openName}.` })).toBeVisible();
  await expect(popup.getByRole('list', { name: 'Your betas' }).getByText(openName)).toBeVisible();
  await expect(popup.getByRole('list', { name: 'Betas you can join' })).toHaveCount(0);

  // Leaving puts it back on offer, with no code.
  await popup.getByRole('button', { name: `Leave ${openName}` }).click();
  await expect(offered.getByRole('button', { name: `Join ${openName}` })).toBeVisible();
  await expect(popup.getByRole('textbox', { name: 'Beta code' })).toBeVisible();
  await popup.getByRole('button', { name: 'Done' }).click();
  await expect(popup).toHaveCount(0);
});
