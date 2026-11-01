import { test, expect, hydrating } from './fixtures';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { openDatabase } from '../../src/server/db';
import { createBeta, readBetaRegistry, writeBetaRegistry } from '../../src/server/beta-registry';
import { ChatService } from '../../src/server/chat';
import { CommunityService } from '../../src/server/community';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';
import { PHONE_DOCK_BETA } from '../../src/components/phone-dock';

/** A student in the phone-dock beta with one friend who sent an unread message, and one pending friend request. */
function seed() {
  const listPath = join(dirname(process.env.E2E_DATABASE_PATH!), 'betas.json');
  const registry = readBetaRegistry(listPath);
  if (!registry.betas.some((beta) => beta.key === PHONE_DOCK_BETA)) writeBetaRegistry(createBeta(registry, { key: PHONE_DOCK_BETA, name: 'Phone dock', code: 'DOCK-0001' }), listPath);
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const service = new Service(db, 'browser-owner@example.com');
    const user = (name: string) => {
      const id = randomUUID();
      db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${randomUUID()}@example.com`, name, `${name} Tester`, new Date().toISOString());
      return id;
    };
    const me = user('Dee'), maya = user('Maya'), rory = user('Rory');
    const school = service.createSchool(me, { name: `Dock High ${me.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    for (const id of [me, maya, rory]) service.join(id, { schoolId: school.id, choice: 'community', grade: '10' });
    const community = new CommunityService(service);
    community.request(me, maya); community.respond(maya, me, true);
    community.request(rory, me);
    new ChatService(service).send(maya, me, randomUUID(), 'are you doing the lab writeup tonight');
    db.prepare('INSERT INTO beta_members(beta_key,user_id,joined_at) VALUES(?,?,?)').run(PHONE_DOCK_BETA, me, new Date().toISOString());
    return { me };
  } finally { db.close(); }
}

const contexts: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(contexts.splice(0).map((context) => context.close())); });
async function phone(browser: Browser, id: string, width = 390): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'dark' });
  contexts.push(context);
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
  return hydrating(await context.newPage());
}

test('phone dock beta: Home sits in the middle, People holds chats and friends, Classes holds the school', async ({ browser }) => {
  test.setTimeout(120_000);
  const { me } = seed();
  const page = await phone(browser, me);
  await page.goto('/');
  const dock = page.getByRole('navigation', { name: 'Main' });
  for (const [index, name] of ['Schedule', 'Tasks', 'Today', 'Classes', 'People'].entries()) await expect(dock.getByRole('link').nth(index)).toHaveAccessibleName(name);
  await expect(dock.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
  // The corner link is gone; the People tab counts the unread chat and the friend request.
  await expect(page.getByRole('banner').getByRole('link', { name: 'Messages' })).toHaveCount(0);
  const people = dock.getByRole('link', { name: 'People' });
  await expect(people).toHaveAccessibleDescription('1 unread chat, 1 friend request');
  if (process.env.DOCK_SHOTS) await page.screenshot({ path: `${process.env.DOCK_SHOTS}/today-390.png` });

  // Unread chats open People on Chats.
  await people.click();
  await expect(page).toHaveURL(/\/messages$/);
  const peopleSwitch = page.getByRole('radiogroup', { name: 'Chats or friends' });
  await expect(peopleSwitch.getByRole('radio', { name: /Chats/ })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Open chat with Maya' })).toBeVisible();
  if (process.env.DOCK_SHOTS) await page.screenshot({ path: `${process.env.DOCK_SHOTS}/chats-390.png` });
  await peopleSwitch.getByRole('radio', { name: /Friends/ }).click();
  await expect(page).toHaveURL(/\/people$/);
  await expect(people).toHaveAttribute('aria-current', 'page');
  if (process.env.DOCK_SHOTS) await page.screenshot({ path: `${process.env.DOCK_SHOTS}/friends-390.png` });

  // Classes opens My classes, switches to School, and reopens School next time.
  const classes = dock.getByRole('link', { name: 'Classes' });
  await classes.click();
  await expect(page).toHaveURL(/\/classes$/);
  const classesSwitch = page.getByRole('radiogroup', { name: 'Your classes or your school' });
  await classesSwitch.getByRole('radio', { name: 'School' }).click();
  await expect(page).toHaveURL(/\/school$/);
  await expect(classes).toHaveAttribute('aria-current', 'page');
  if (process.env.DOCK_SHOTS) await page.screenshot({ path: `${process.env.DOCK_SHOTS}/school-390.png` });
  await dock.getByRole('link', { name: 'Today' }).click();
  await expect(page).toHaveURL(/:3[0-9]+\/$/);
  await classes.click();
  await expect(page).toHaveURL(/\/school$/);

  // A chat thread hides the dock and the switch, as before.
  await people.click();
  await page.getByRole('button', { name: 'Open chat with Maya' }).click();
  await expect(dock).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: 'Chats or friends' })).toHaveCount(0);

  if (process.env.DOCK_SHOTS) for (const width of [360, 402]) {
    const narrow = await phone(browser, me, width);
    await narrow.goto('/');
    await narrow.screenshot({ path: `${process.env.DOCK_SHOTS}/today-${width}.png` });
    await narrow.goto('/#messages');
    await narrow.getByRole('radiogroup', { name: 'Chats or friends' }).waitFor();
    await narrow.screenshot({ path: `${process.env.DOCK_SHOTS}/chats-${width}.png` });
  }
});
