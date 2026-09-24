import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/server/db';
import { Service } from '../../src/server/service';
import { ChatService } from '../../src/server/chat';
import { CommunityService } from '../../src/server/community';
import { exampleSchedule } from '../../src/domain/example';

// Chat is polled (4 s threads, 10 s lists, 15 s badge), so each scenario gets room for several cycles.
test.describe.configure({ timeout: 180_000 });

const OWNER_EMAIL = 'browser-owner@example.com';
const SEND = '**/api/trpc/chat.send*';

type Name = 'alice' | 'bob' | 'cara';
type Seeded = Record<Name, string> & { owner: string; emails: Record<Name, string>; schoolId: string };

/**
 * Alice, Bob and Cara at one school, plus a fresh owner account. `friends` become accepted friendships;
 * `messages` go through ChatService.send with fresh client IDs, so seq, revision and last_message_at are real.
 */
function seed({ friends = [], messages = [] }: { friends?: Array<[Name, Name]>; messages?: Array<[Name, Name, string]> } = {}): Seeded {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const service = new Service(db, OWNER_EMAIL);
    const user = (name: string, email = `${randomUUID()}@example.com`) => {
      const id = randomUUID();
      db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, name, `${name} Fullname`, new Date().toISOString());
      return { id, email };
    };
    const alice = user('Alice'), bob = user('Bob'), cara = user('Cara'), owner = user('Owner', OWNER_EMAIL);
    const school = service.createSchool(alice.id, { name: `Chat High ${alice.id.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    for (const member of [alice, bob, cara, owner]) service.join(member.id, { schoolId: school.id, choice: 'community', grade: '10' });
    const ids: Record<Name, string> = { alice: alice.id, bob: bob.id, cara: cara.id };
    const now = new Date().toISOString();
    for (const [left, right] of friends) {
      const [low, high] = [ids[left], ids[right]].sort() as [string, string];
      db.prepare('INSERT INTO friendships(user_low,user_high,requester_id,status,created_at,responded_at) VALUES(?,?,?,?,?,?)').run(low, high, ids[left], 'accepted', now, now);
    }
    const chat = new ChatService(service);
    for (const [from, to, text] of messages) chat.send(ids[from], ids[to], randomUUID(), text);
    return { ...ids, owner: owner.id, emails: { alice: alice.email, bob: bob.email, cara: cara.email }, schoolId: school.id };
  } finally { db.close(); }
}

/** A message sent from outside the browser, as if the friend used their own phone. */
function sendAs(from: string, to: string, text: string) {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try { new ChatService(new Service(db, OWNER_EMAIL)).send(from, to, randomUUID(), text); }
  finally { db.close(); }
}

async function authenticate(context: BrowserContext, id: string) {
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
}

const contexts: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(contexts.splice(0).map((context) => context.close())); });

/** Each student gets their own browser profile, like separate devices. */
async function signedIn(browser: Browser, id: string): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  await authenticate(context, id);
  return context.newPage();
}
/** A phone: 390×844 with touch, so `(pointer: fine)` is false. */
async function phone(browser: Browser, id: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  contexts.push(context);
  await authenticate(context, id);
  return context.newPage();
}

/** Pick an option from a shadcn/ui Select by its visible label. */
async function choose(select: Locator, option: string) {
  await select.click();
  await select.page().getByRole('option', { name: option, exact: true }).click();
}

/**
 * The Messages nav link (top bar on phones, sidebar on desktop). Its badge is decorative; the count is the
 * link's accessible description ("1 unread chat"), and an empty description means no badge.
 */
const badge = (page: Page) => page.getByRole('link', { name: 'Messages', exact: true }).filter({ visible: true }).first();

/**
 * A closed row looks the same however the chat closed: the name, "Chat closed", a Report button and, for a
 * schoolmate, one reopen button ("Add friend", or "Unblock" when the viewer blocked them). Nothing reveals the other side's block.
 */
async function expectClosedRow(page: Page, name: string, reopen: 'Unblock' | 'Add friend' = 'Add friend') {
  const row = page.getByRole('list', { name: 'Chats', exact: true }).getByRole('listitem').filter({ hasText: name });
  await expect(row).toContainText('Chat closed', { timeout: 20_000 });
  await expect(row.getByRole('button')).toHaveCount(2);
  await expect(row.getByRole('button', { name: `Report ${name}` })).toBeVisible();
  await expect(row.getByRole('button', { name: reopen === 'Unblock' ? `Unblock ${name} and reopen the chat` : `Add ${name} as a friend` })).toBeVisible();
  await expect(row.getByRole('link')).toHaveCount(0);
  return row;
}

/** A friend request answered from outside the browser. */
function respondAs(from: string, to: string, accept: boolean) {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try { new CommunityService(new Service(db, OWNER_EMAIL)).respond(from, to, accept); }
  finally { db.close(); }
}

const notSent = (log: Locator) => log.getByText(/^Not sent\./);

test('friends chat, the badge counts unread chats, and deletion reaches both sides', async ({ browser }, testInfo) => {
  const f = seed({ friends: [['alice', 'bob'], ['bob', 'cara'], ['alice', 'cara']] });
  const bob = await phone(browser, f.bob);
  await bob.goto('/#today');
  await expect(bob.locator('.tabbar a')).toHaveCount(6);
  await expect(badge(bob)).toHaveAccessibleDescription('');

  const alice = await signedIn(browser, f.alice);
  await alice.goto('/#messages');
  await expect(alice.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible();
  const start = alice.getByRole('list', { name: 'Start a chat' });
  await expect(start).toContainText('Bob');
  await start.getByRole('button', { name: 'Open chat with Bob' }).click();
  await expect(alice.getByText('Only you and Bob can read this chat.')).toBeVisible();

  // Hold the send briefly so the pending state is observable; the request itself is untouched.
  await alice.route(SEND, async (route) => { await new Promise((resolve) => setTimeout(resolve, 1_500)); await route.continue(); });
  const aliceComposer = alice.getByRole('textbox', { name: 'Message Bob' });
  await aliceComposer.fill('Hi Bob');
  await aliceComposer.press('Enter');
  const aliceLog = alice.getByRole('log', { name: 'Messages with Bob' });
  // Unsent bubbles sit outside the live log (so a sent message is announced once), inside the thread.
  const aliceThread = alice.getByRole('region', { name: 'Chat with Bob' });
  await expect(aliceThread.getByText('Sending…')).toBeVisible();
  await expect(aliceLog.getByText('Hi Bob', { exact: true })).toBeVisible();
  await expect(aliceThread.getByText('Sending…')).toHaveCount(0, { timeout: 15_000 });
  await alice.unroute(SEND);
  await expect(aliceComposer).toHaveValue('');

  // Bob's badge counts chats, not messages, and arrives with the workspace poll.
  await expect(badge(bob)).toHaveAccessibleDescription('1 unread chat', { timeout: 20_000 });
  await badge(bob).click();
  await bob.getByRole('button', { name: 'Open chat with Alice' }).click();
  const bobLog = bob.getByRole('log', { name: 'Messages with Alice' });
  await expect(bobLog).toContainText('Hi Bob');
  await expect(bob.locator('.tabbar')).toBeHidden();
  const bobComposer = bob.getByRole('textbox', { name: 'Message Alice' });
  await expect(bobComposer).toBeInViewport();

  const hi = bobLog.getByRole('listitem').filter({ hasText: 'Hi Bob' });
  await hi.getByRole('button', { name: 'Message actions' }).click();
  await hi.getByRole('button', { name: 'Add as task' }).click();
  await expect(bob.getByRole('status').filter({ hasText: 'Added to Tasks.' })).toBeVisible();

  // On a touch screen Enter inserts a newline; the Send button sends.
  await bobComposer.fill('Hey');
  await bobComposer.press('Enter');
  await expect(bobComposer).toHaveValue(/\n/);
  await bob.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(bobLog.getByText('Hey', { exact: true })).toBeVisible();
  await expect(bobComposer).toHaveValue('');

  await expect(aliceLog.getByText('Hey', { exact: true })).toBeVisible({ timeout: 10_000 });

  const mine = aliceLog.getByRole('listitem').filter({ hasText: 'Hi Bob' });
  await mine.hover();
  await mine.getByRole('button', { name: 'Message actions' }).click();
  await mine.getByRole('button', { name: 'Delete message' }).click();
  const confirmDelete = alice.getByRole('dialog', { name: 'Delete for both of you?' });
  await confirmDelete.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(confirmDelete).toHaveCount(0);
  await expect(aliceLog.getByText('Message deleted')).toBeVisible();
  await expect(bobLog.getByText('Message deleted')).toBeVisible({ timeout: 10_000 });
  await expect(bobLog.getByText('Hi Bob', { exact: true })).toHaveCount(0);

  // Screenshots at 390×844 and desktop size, light and dark; no sideways scrolling on the phone.
  const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const scheme of ['light', 'dark'] as const) {
    await bob.emulateMedia({ colorScheme: scheme });
    await alice.emulateMedia({ colorScheme: scheme });
    await expect(bobLog).toBeVisible();
    await noOverflow(bob);
    await bob.screenshot({ path: testInfo.outputPath(`chat-thread-phone-${scheme}.png`) });
    await alice.screenshot({ path: testInfo.outputPath(`chat-thread-desktop-${scheme}.png`) });
  }
  await bob.getByRole('button', { name: 'Back to chats' }).click();
  await alice.goto('/#messages');
  await expect(bob.getByRole('list', { name: 'Chats' })).toBeVisible();
  await expect(alice.getByRole('list', { name: 'Chats' })).toBeVisible();
  for (const scheme of ['light', 'dark'] as const) {
    await bob.emulateMedia({ colorScheme: scheme });
    await alice.emulateMedia({ colorScheme: scheme });
    await expect(bob.locator('.tabbar')).toBeVisible();
    await noOverflow(bob);
    await bob.screenshot({ path: testInfo.outputPath(`chat-list-phone-${scheme}.png`), fullPage: true });
    await alice.screenshot({ path: testInfo.outputPath(`chat-list-desktop-${scheme}.png`), fullPage: true });
  }
  await bob.emulateMedia({ colorScheme: 'light' });

  // The task came from the message, and reading the chat cleared the badge.
  await bob.goto('/#tasks');
  await expect(bob.getByRole('button', { name: 'Edit Hi Bob' })).toBeVisible();
  await expect(badge(bob)).toHaveAccessibleDescription('');
});

test('global chat: everyone posts, slurs are blocked with a reason, the owner edits and removes with reasons, and the ICE line is a joke', async ({ browser }, testInfo) => {
  const f = seed();
  const alice = await signedIn(browser, f.alice);
  await alice.goto('/#messages');
  const groups = alice.getByRole('list', { name: 'Rooms' });
  await expect(groups.getByRole('button', { name: 'Open Global chat' })).toBeVisible();
  await groups.getByRole('button', { name: 'Open Global chat' }).click();
  await expect(alice.getByText('Everyone on Quasar can read and post here.')).toBeVisible();
  const aliceComposer = alice.getByRole('textbox', { name: 'Message everyone' });
  const aliceLog = alice.getByRole('log', { name: 'Global chat messages' });

  // Swearing passes; a slur (even obfuscated) disables Send and shows the reason.
  await aliceComposer.fill('this homework is bullshit');
  await aliceComposer.press('Enter');
  await expect(aliceLog.getByText('this homework is bullshit', { exact: true })).toBeVisible();
  await aliceComposer.fill('shut up r3tard');
  await expect(alice.getByRole('alert').filter({ hasText: 'That message has a slur in it' })).toBeVisible();
  await expect(alice.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await aliceComposer.fill('we learned about immigrants today');
  await aliceComposer.press('Enter');
  await expect(aliceLog.getByText('we learned about immigrants today', { exact: true })).toBeVisible();
  await expect(aliceLog.getByText(/Reporting to the ICE hotline… Just kidding/)).toBeVisible();

  // Bob (never a friend of Alice) reads the room with names, and the room counts as one unread chat.
  const bob = await phone(browser, f.bob);
  await bob.goto('/#today');
  await expect(badge(bob)).toHaveAccessibleDescription('1 unread chat', { timeout: 20_000 });
  await bob.goto('/#messages?room=global');
  const bobLog = bob.getByRole('log', { name: 'Global chat messages' });
  await expect(bobLog).toContainText('this homework is bullshit');
  await expect(bobLog.getByText('Alice', { exact: true }).first()).toBeVisible();
  await expect(bob.locator('.tabbar')).toBeHidden();
  const bobComposer = bob.getByRole('textbox', { name: 'Message everyone' });
  await bobComposer.fill('hi from bob');
  await bob.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(bobLog.getByText('hi from bob', { exact: true })).toBeVisible();
  await expect(aliceLog.getByText('hi from bob', { exact: true })).toBeVisible({ timeout: 10_000 });

  // Bob cannot edit or remove Alice's message; Alice can delete her own.
  const bobSeesAlice = bobLog.getByRole('listitem').filter({ hasText: 'this homework is bullshit' });
  await bobSeesAlice.getByRole('button', { name: 'Message actions' }).click();
  await expect(bobSeesAlice.getByRole('button', { name: 'Add as task' })).toBeVisible();
  await expect(bobSeesAlice.getByRole('button', { name: /Edit|Remove|Delete/ })).toHaveCount(0);

  // The owner edits Bob's message and removes Alice's, each with a reason everyone sees.
  const owner = await signedIn(browser, f.owner);
  await owner.goto('/#messages?room=global');
  const ownerLog = owner.getByRole('log', { name: 'Global chat messages' });
  await expect(owner.getByText('You moderate this room')).toBeVisible();
  const bobsMessage = ownerLog.getByRole('listitem').filter({ hasText: 'hi from bob' });
  await bobsMessage.hover();
  await bobsMessage.getByRole('button', { name: 'Message actions' }).click();
  await bobsMessage.getByRole('button', { name: 'Edit message' }).click();
  const edit = owner.getByRole('dialog', { name: 'Edit Bob’s message' });
  await edit.getByLabel('Message').fill('hi from bob (be nice)');
  await edit.getByLabel('Reason (optional, shown to everyone)').fill('tone');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toHaveCount(0);
  await expect(ownerLog.getByText('hi from bob (be nice)', { exact: true })).toBeVisible();
  await expect(ownerLog.getByText('Edited by the owner: tone')).toBeVisible();
  const alicesMessage = ownerLog.getByRole('listitem').filter({ hasText: 'this homework is bullshit' });
  await alicesMessage.hover();
  await alicesMessage.getByRole('button', { name: 'Message actions' }).click();
  await alicesMessage.getByRole('button', { name: 'Remove message' }).click();
  const remove = owner.getByRole('dialog', { name: 'Remove Alice’s message?' });
  await remove.getByLabel('Reason (optional, shown to everyone)').fill('keep it school-friendly');
  await remove.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(remove).toHaveCount(0);
  await expect(ownerLog.getByText('Removed by the owner: keep it school-friendly')).toBeVisible();

  // Both changes reach the others by polling, reason included.
  await expect(bobLog.getByText('hi from bob (be nice)', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(bobLog.getByText('Edited by the owner: tone')).toBeVisible();
  await expect(aliceLog.getByText('Removed by the owner: keep it school-friendly')).toBeVisible({ timeout: 10_000 });
  await expect(aliceLog.getByText('this homework is bullshit', { exact: true })).toHaveCount(0);

  for (const scheme of ['light', 'dark'] as const) {
    await bob.emulateMedia({ colorScheme: scheme });
    await owner.emulateMedia({ colorScheme: scheme });
    await bob.screenshot({ path: testInfo.outputPath(`global-chat-phone-${scheme}.png`) });
    await owner.screenshot({ path: testInfo.outputPath(`global-chat-desktop-${scheme}.png`) });
  }
});

test('a blocked chat can be reopened: unblock sends a request, and acceptance brings the history back', async ({ browser }) => {
  const f = seed({ friends: [['alice', 'bob']], messages: [['alice', 'bob', 'see you at practice']] });
  const bob = await signedIn(browser, f.bob);
  await bob.goto(`/#messages?with=${f.alice}`);
  await expect(bob.getByRole('log', { name: 'Messages with Alice' })).toContainText('see you at practice');
  await bob.getByRole('button', { name: 'Block', exact: true }).click();
  await bob.getByRole('dialog', { name: 'Block Alice?' }).getByRole('button', { name: 'Block', exact: true }).click();
  const row = await expectClosedRow(bob, 'Alice', 'Unblock');
  await row.getByRole('button', { name: 'Unblock Alice and reopen the chat' }).click();
  await expect(bob.getByRole('status').filter({ hasText: 'Alice is unblocked. Friend request sent. The chat reopens when Alice accepts.' })).toBeVisible();
  // Until Alice answers, the row stays closed and now offers a plain friend request.
  await expectClosedRow(bob, 'Alice', 'Add friend');
  respondAs(f.alice, f.bob, true);
  await expect(bob.getByRole('button', { name: 'Open chat with Alice' })).toBeVisible({ timeout: 20_000 });
  await bob.getByRole('button', { name: 'Open chat with Alice' }).click();
  await expect(bob.getByRole('log', { name: 'Messages with Alice' })).toContainText('see you at practice');
  await expect(bob.getByRole('textbox', { name: 'Message Alice' })).toBeVisible();
});

test('a failed send keeps the text and retries without duplicating', async ({ browser }) => {
  const f = seed({ friends: [['alice', 'bob']] });
  const page = await signedIn(browser, f.alice);
  await page.goto(`/#messages?with=${f.bob}`);
  const composer = page.getByRole('textbox', { name: 'Message Bob' });
  const log = page.getByRole('log', { name: 'Messages with Bob' });
  const thread = page.getByRole('region', { name: 'Chat with Bob' });
  await expect(composer).toBeEnabled();
  await expect(page.getByText('No messages yet.')).toBeVisible();

  // Network failure: one automatic retry, then "Not sent." with Retry; the text stays.
  await page.route(SEND, (route) => route.abort());
  await composer.fill('Math at 3?');
  await composer.press('Enter');
  const math = thread.getByRole('list', { name: 'Unsent messages' }).getByRole('listitem').filter({ hasText: 'Math at 3?' });
  await expect(notSent(math)).toBeVisible({ timeout: 20_000 });
  await expect(math.getByRole('button', { name: 'Discard' })).toBeVisible();
  await page.unroute(SEND);
  await math.getByRole('button', { name: 'Retry sending' }).click();
  await expect.poll(async () => (await thread.getByText('Sending…').count()) + (await notSent(thread).count()), { timeout: 15_000 }).toBe(0);
  await expect(log.getByText('Math at 3?', { exact: true })).toHaveCount(1);

  // Lost response: the server stores the message, the browser never sees the answer. The thread poll
  // (or the retry, which returns the stored row) reconciles it without pressing Retry.
  await page.route(SEND, async (route) => { await route.fetch(); await route.abort(); });
  await composer.fill('See you there');
  await composer.press('Enter');
  await expect(thread.getByText('See you there', { exact: true })).toBeVisible();
  await expect.poll(async () => (await thread.getByText('Sending…').count()) + (await notSent(thread).count()), { timeout: 15_000 }).toBe(0);
  await page.unroute(SEND);

  await page.reload();
  await expect(log.getByText('Math at 3?', { exact: true })).toHaveCount(1);
  await expect(log.getByText('See you there', { exact: true })).toHaveCount(1);
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try { expect((db.prepare('SELECT count(*) AS n FROM chat_messages WHERE sender_id=?').get(f.alice) as { n: number }).n).toBe(2); }
  finally { db.close(); }

  const bob = await signedIn(browser, f.bob);
  await bob.goto(`/#messages?with=${f.alice}`);
  const bobLog = bob.getByRole('log', { name: 'Messages with Alice' });
  await expect(bobLog.getByText('Math at 3?', { exact: true })).toHaveCount(1);
  await expect(bobLog.getByText('See you there', { exact: true })).toHaveCount(1);
});

test('offline shows the connect state and recovers', async ({ browser }) => {
  const f = seed({ friends: [['alice', 'bob'], ['alice', 'cara']], messages: [['cara', 'alice', 'Are you going to practice?']] });
  const page = await signedIn(browser, f.alice);
  const context = page.context();
  await page.goto(`/#messages?with=${f.bob}`);
  const composer = page.getByRole('textbox', { name: 'Message Bob' });
  const log = page.getByRole('log', { name: 'Messages with Bob' });
  const thread = page.getByRole('region', { name: 'Chat with Bob' });
  await expect(composer).toBeEnabled();
  await expect(badge(page)).toHaveAccessibleDescription('1 unread chat', { timeout: 20_000 });
  await composer.fill('Draft about lunch');

  await context.setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: 'You’re offline. Messages load when you reconnect.' })).toBeVisible();
  await expect(page.getByText('Schedule and task changes stay saved')).toHaveCount(0);
  await expect(composer).toBeDisabled();
  await expect(composer).toHaveAttribute('placeholder', 'Offline');
  await expect(composer).toHaveValue('Draft about lunch');
  await expect(badge(page)).toHaveAccessibleDescription('');

  sendAs(f.bob, f.alice, 'Bob wrote while you were offline');

  await context.setOffline(false);
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue('Draft about lunch');
  await expect(log.getByText('Bob wrote while you were offline', { exact: true })).toBeVisible({ timeout: 20_000 });

  // D5: nothing about chat is stored on the device.
  await composer.fill('ZX-DEVICE-7');
  await composer.press('Enter');
  await expect(log.getByText('ZX-DEVICE-7', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(thread.getByText('Sending…')).toHaveCount(0, { timeout: 15_000 });
  sendAs(f.bob, f.alice, 'ZX-DEVICE-8');
  await expect(log.getByText('ZX-DEVICE-8', { exact: true })).toBeVisible({ timeout: 20_000 });

  const markers = ['ZX-DEVICE-7', 'ZX-DEVICE-8', 'Draft about lunch', 'Bob wrote while you were offline'];
  const found = await page.evaluate(async (needles: string[]) => {
    const hits: string[] = [];
    const check = (where: string, text: string) => { for (const needle of needles) if (text.includes(needle)) hits.push(`${where}: ${needle}`); };
    const blobs: Array<{ where: string; blob: Blob }> = [];
    const flatten = (where: string, value: unknown): string => {
      try {
        return JSON.stringify(value, (_key, entry: unknown) => {
          if (entry instanceof Blob) { blobs.push({ where, blob: entry }); return '[blob]'; }
          if (entry instanceof ArrayBuffer || ArrayBuffer.isView(entry)) return new TextDecoder().decode(entry instanceof ArrayBuffer ? entry : new Uint8Array(entry.buffer));
          return entry;
        }) ?? String(value);
      } catch { return String(value); }
    };
    const request = <T,>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

    // Every record of every object store in every IndexedDB database (whatsnext-offline-v1 included).
    const names = (await indexedDB.databases()).map((info) => info.name).filter((name): name is string => Boolean(name));
    for (const name of names) {
      const db = await request(indexedDB.open(name));
      try {
        for (const store of Array.from(db.objectStoreNames)) {
          const tx = db.transaction(store, 'readonly');
          const objects = tx.objectStore(store);
          const [keys, values] = await Promise.all([request(objects.getAllKeys()), request(objects.getAll())]);
          check(`indexedDB ${name}/${store} keys`, flatten(`${name}/${store}`, keys));
          check(`indexedDB ${name}/${store}`, flatten(`${name}/${store}`, values));
        }
      } finally { db.close(); }
    }
    for (const [label, storage] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]] as const) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) ?? '';
        check(label, `${key}=${storage.getItem(key) ?? ''}`);
      }
    }
    if (typeof caches !== 'undefined') {
      for (const cacheName of await caches.keys()) {
        const cache = await caches.open(cacheName);
        for (const entry of await cache.keys()) {
          check(`cache ${cacheName} url`, entry.url);
          const response = await cache.match(entry);
          if (response) check(`cache ${cacheName} ${entry.url}`, await response.text());
        }
      }
    }
    for (const { where, blob } of blobs) check(`indexedDB blob ${where}`, await blob.text());
    return { hits, databases: names };
  }, markers);
  expect(found.hits).toEqual([]);
});

test('the harasser blocking first still leaves the victim a report path, and support sees only that chat', async ({ browser }) => {
  const threats = ['You think you are so smart', 'Everyone laughs at you', 'Watch out tomorrow'];
  const f = seed({
    friends: [['alice', 'bob'], ['bob', 'cara'], ['alice', 'cara']],
    messages: [...threats.map((text): [Name, Name, string] => ['bob', 'alice', text]), ['cara', 'alice', 'secret plans for the surprise party']],
  });

  // Bob blocks Alice first.
  const bob = await signedIn(browser, f.bob);
  await bob.goto(`/#messages?with=${f.alice}`);
  await expect(bob.getByRole('log', { name: 'Messages with Alice' })).toContainText('Watch out tomorrow');
  await bob.getByRole('button', { name: 'Block', exact: true }).click();
  await bob.getByRole('dialog', { name: 'Block Alice?' }).getByRole('button', { name: 'Block', exact: true }).click();
  await expect(bob.getByRole('status').filter({ hasText: 'Alice is blocked.' })).toBeVisible();
  await expectClosedRow(bob, 'Alice', 'Unblock');

  // Alice keeps a closed row with Report, and the report holds Bob's messages.
  const alice = await signedIn(browser, f.alice);
  await alice.goto('/#messages');
  const closed = await expectClosedRow(alice, 'Bob');
  await closed.getByRole('button', { name: 'Report Bob' }).click();
  const report = alice.getByRole('dialog', { name: 'Report Bob' });
  await expect(report.getByRole('button', { name: 'Send report' })).toBeDisabled();
  await report.getByRole('radiogroup', { name: 'What’s wrong?' }).getByRole('radio', { name: 'Someone may be in danger' }).click();
  await expect(report.getByText('If someone is in immediate danger, call 911. For crisis support, call or text 988.')).toBeVisible();
  await expect(report.getByRole('checkbox', { name: 'Also block Bob' })).toHaveCount(0);
  await report.getByRole('textbox', { name: 'Anything else? (optional)' }).fill('He keeps threatening me after class.');
  await report.getByRole('button', { name: 'Send report' }).click();
  await expect(report).toHaveCount(0);
  await expect(alice.getByRole('status').filter({ hasText: 'Report sent to support.' })).toBeVisible();

  // Support sees this chat's snapshot only.
  const owner = await signedIn(browser, f.owner);
  await owner.goto('/admin');
  await expect(owner.getByRole('heading', { name: 'Member reports' })).toBeVisible();
  const reportCards = owner.locator('[data-slot="card"]').filter({ has: owner.getByRole('heading', { name: 'Member reports' }) }).locator('ul > li');
  await expect(reportCards.first()).toContainText('Danger');
  const card = owner.getByRole('listitem').filter({ hasText: f.emails.bob });
  await expect(card.getByText('Chat', { exact: true })).toBeVisible();
  await expect(card.getByText('Danger', { exact: true })).toBeVisible();
  await expect(card).toContainText('1 report · 0 removals · 0 pauses');
  await expect(owner.getByText('secret plans')).toHaveCount(0);
  await card.getByRole('button', { name: 'Show messages (3)' }).click();
  const evidence = card.getByRole('list', { name: 'Reported messages' });
  for (const text of threats) await expect(evidence).toContainText(text);
  await expect(evidence.getByRole('listitem')).toHaveCount(3);
  await expect(owner.getByText('secret plans')).toHaveCount(0);
  expect(await owner.content()).not.toContain('secret plans');

  await card.getByRole('button', { name: 'Pause messaging' }).click();
  const pause = owner.getByRole('dialog', { name: 'Pause Bob’s messaging' });
  await choose(pause.getByRole('combobox', { name: 'Pause length' }), '7 days');
  await pause.getByRole('textbox', { name: 'Reason for the audit log' }).fill('Threats in chat, reported as danger.');
  await pause.getByRole('button', { name: 'Pause messaging' }).click();
  await expect(pause).toHaveCount(0);
  await expect(owner.getByRole('heading', { name: 'Paused members' })).toBeVisible();
  const paused = owner.locator('[data-slot="card"]').filter({ has: owner.getByRole('heading', { name: 'Paused members' }) });
  const bobPaused = paused.getByRole('listitem').filter({ hasText: f.emails.bob });
  await expect(bobPaused).toContainText('Bob · until');
  await expect(bobPaused).not.toContainText('until lifted');
  await expect(bobPaused.getByRole('button', { name: 'Lift pause' })).toBeVisible();
  expect(await owner.content()).not.toContain('secret plans');

  // Bob can still read, but cannot send, even to Cara.
  await bob.goto(`/#messages?with=${f.cara}`);
  await expect(bob.getByText(/^Support paused your messaging until [^.]+\.$/)).toBeVisible({ timeout: 20_000 });
  await expect(bob.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  await expect(bob.getByRole('textbox', { name: 'Message Cara' })).toHaveCount(0);
});

test('reporting a message with block closes the chat identically for both', async ({ browser }) => {
  const f = seed({ friends: [['alice', 'bob']], messages: [['bob', 'alice', 'You are so annoying'], ['bob', 'alice', 'Nobody wants you at lunch']] });
  const bob = await signedIn(browser, f.bob);
  await bob.goto(`/#messages?with=${f.alice}`);
  await expect(bob.getByRole('log', { name: 'Messages with Alice' })).toContainText('Nobody wants you at lunch');
  await expect(bob.getByRole('textbox', { name: 'Message Alice' })).toBeVisible();

  const alice = await signedIn(browser, f.alice);
  await alice.goto(`/#messages?with=${f.bob}`);
  const second = alice.getByRole('log', { name: 'Messages with Bob' }).getByRole('listitem').filter({ hasText: 'Nobody wants you at lunch' });
  await second.hover();
  await second.getByRole('button', { name: 'Message actions' }).click();
  await second.getByRole('button', { name: 'Report message' }).click();
  const report = alice.getByRole('dialog', { name: 'Report message' });
  await report.getByRole('radiogroup', { name: 'What’s wrong?' }).getByRole('radio', { name: 'Bullying or harassment' }).click();
  await expect(report.getByRole('checkbox', { name: 'Also block Bob' })).toBeChecked();
  await report.getByRole('button', { name: 'Send report' }).click();
  await expect(alice.getByRole('status').filter({ hasText: 'Report sent. Bob is blocked.' })).toBeVisible();
  await expectClosedRow(alice, 'Bob', 'Unblock');

  // Bob's open thread closes at the next poll, and his row matches the harasser-blocked case.
  await expect(bob.getByText('This chat is closed.')).toBeVisible({ timeout: 20_000 });
  await expect(bob.getByRole('textbox', { name: 'Message Alice' })).toHaveCount(0);
  await bob.getByRole('button', { name: 'All chats' }).click();
  await expectClosedRow(bob, 'Alice');

  const owner = await signedIn(browser, f.owner);
  await owner.goto('/admin');
  const card = owner.getByRole('listitem').filter({ hasText: f.emails.bob });
  await expect(card.getByText('Chat', { exact: true })).toBeVisible();
  await expect(card.getByText('Bullying', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: /^Show messages/ }).click();
  const evidence = card.getByRole('list', { name: 'Reported messages' });
  await expect(evidence.getByRole('listitem').filter({ hasText: 'Nobody wants you at lunch' })).toContainText('Reported message');
  await expect(evidence.getByRole('listitem').filter({ hasText: 'You are so annoying' })).not.toContainText('Reported message');
});
