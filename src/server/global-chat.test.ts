import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { GlobalChatService, countUnreadGlobal, pruneGlobalChat } from './global-chat';
import { ChatService, countUnreadChats } from './chat';
import { CommunityService } from './community';
import { appRouter } from './router';
import { exampleSchedule } from '@/domain/example';

const DAY = 86_400_000;
const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });

function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  function user(email = `${randomUUID()}@example.com`, name = 'Student', names = true) {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, names ? name : '', names ? `${name} Fullname` : '', new Date().toISOString());
    return id;
  }
  const owner = user('owner@example.com', 'Owner');
  const alice = user(undefined, 'Alice'), bob = user(undefined, 'Bob'), newcomer = user(undefined, 'New', false);
  const school = service.createSchool(alice, { name: 'Community High', location: 'Boston, MA', schedule: exampleSchedule });
  service.join(bob, { schoolId: school.id, choice: 'community', grade: '11' });
  const clock = { now: new Date() };
  const tick = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  const room = new GlobalChatService(service, () => clock.now);
  const caller = (id: string | null) => appRouter.createCaller({ service, userId: id });
  const send = (from: string, body = 'hello', clientId = randomUUID()) => { tick(4000); return room.send(from, clientId, body).message; };
  return { db, service, user, owner, alice, bob, newcomer, room, caller, clock, tick, send };
}

function fails(fn: () => unknown, code: TRPCError['code'], message?: string) {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(TRPCError);
  expect((error as TRPCError).code).toBe(code);
  if (message !== undefined) expect((error as TRPCError).message).toBe(message);
}

describe('global chat', () => {
  it('is open to every member with names, across schools, and shows who said what', () => {
    const f = fixture();
    f.send(f.alice, 'hi everyone');
    f.send(f.owner, 'welcome');
    const seenByBob = f.room.thread(f.bob);
    expect(seenByBob.messages.map(m => [m.sender.displayName, m.body, m.fromMe])).toEqual([['Alice', 'hi everyone', false], ['Owner', 'welcome', false]]);
    expect(seenByBob.room).toEqual({ members: 3, canModerate: false });
    expect(f.room.thread(f.owner).room.canModerate).toBe(true);
    expect(f.room.thread(f.alice).messages[0]!.fromMe).toBe(true);
    fails(() => f.room.thread(f.newcomer), 'BAD_REQUEST');
    fails(() => f.room.send(f.newcomer, randomUUID(), 'hey'), 'BAD_REQUEST');
  });

  it('stores slurs censored but lets swearing through', () => {
    const f = fixture();
    expect(f.send(f.alice, 'you f4ggot').body).toBe('you ******');
    expect(f.db.prepare('SELECT body FROM global_messages').get()).toEqual({ body: 'you ******' });
    expect(f.send(f.alice, 'this homework is fucking bullshit').body).toBe('this homework is fucking bullshit');
  });

  it('keeps https links whole, and censors the list preview before cutting it', () => {
    const f = fixture();
    expect(f.send(f.alice, 'see https://en.wikipedia.org/wiki/Coon_Rapids,_Minnesota').body).toBe('see https://en.wikipedia.org/wiki/Coon_Rapids,_Minnesota');
    // The preview is plain text, so the slur-shaped segment shows as asterisks there.
    expect(f.room.summary(f.bob).lastMessage?.preview).toBe('see https://en.wikipedia.org/wiki/****_Rapids,_Minnesota');
    // A row stored before the filter existed, with the slur straddling the 120-character cut.
    f.db.prepare('UPDATE global_messages SET body=?').run(`${'x'.repeat(116)} retard`);
    expect(f.room.summary(f.bob).lastMessage?.preview).toBe(`${'x'.repeat(116)} ***`);
  });

  it('lets the sender delete their own message and nobody else’s; the owner deletes anyone’s', () => {
    const f = fixture();
    const fromAlice = f.send(f.alice, 'oops');
    const fromBob = f.send(f.bob, 'lol');
    fails(() => f.room.delete(f.bob, fromAlice.id), 'FORBIDDEN');
    expect(f.room.delete(f.alice, fromAlice.id)).toEqual({ deleted: true });
    expect(f.room.delete(f.owner, fromBob.id, 'no spam please')).toEqual({ deleted: true });
    const messages = f.room.thread(f.alice).messages;
    expect(messages.map(m => [m.body, m.deletedBy, m.reason])).toEqual([[null, 'sender', null], [null, 'owner', 'no spam please']]);
    expect(f.db.prepare("SELECT reason FROM global_messages WHERE id=?").get(fromAlice.id)).toEqual({ reason: null });
    expect(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='global.delete'").get()).toEqual({ n: 1 });
  });

  it('lets only the owner edit, keeps the filter on edits, marks the edit and audits it', async () => {
    const f = fixture();
    const message = f.send(f.bob, 'meet at 3');
    await expect(f.caller(f.alice).global.edit({ accountId: f.alice, messageId: message.id, body: 'meet at 4' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.room.edit(f.owner, message.id, 'you retard').message.body).toBe('you ******');
    const edited = f.room.edit(f.owner, message.id, 'meet at 4 (fixed by the owner)', 'wrong time').message;
    expect(edited.body).toBe('meet at 4 (fixed by the owner)');
    expect(edited.editedAt).toEqual(expect.any(String));
    expect(edited.reason).toBe('wrong time');
    expect(f.send(f.bob, 'untouched').reason).toBeNull();
    expect(edited.sender.displayName).toBe('Bob');
    expect(f.room.thread(f.bob).messages[0]).toMatchObject({ body: 'meet at 4 (fixed by the owner)', fromMe: true, editedAt: expect.any(String) });
    // Two edits so far: the censored one and the real one.
    expect(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='global.edit'").get()).toEqual({ n: 2 });
    f.room.delete(f.owner, message.id);
    fails(() => f.room.edit(f.owner, message.id, 'again'), 'NOT_FOUND');
  });

  it('polls by revision: edits and deletes arrive as changes', () => {
    const f = fixture();
    const first = f.send(f.alice, 'one');
    const { revision } = f.room.thread(f.bob);
    f.room.edit(f.owner, first.id, 'one!');
    const changes = f.room.thread(f.bob, { after: revision });
    expect(changes.reset).toBe(false);
    expect(changes.messages).toEqual([expect.objectContaining({ id: first.id, body: 'one!' })]);
    expect(f.room.thread(f.bob, { after: changes.revision }).messages).toEqual([]);
  });

  it('pages 50 at a time with hasEarlier', () => {
    const f = fixture();
    for (let index = 0; index < 60; index += 1) f.send(f.alice, `m${index}`);
    const latest = f.room.thread(f.bob);
    expect(latest.messages).toHaveLength(50);
    expect(latest.hasEarlier).toBe(true);
    const earlier = f.room.thread(f.bob, { before: latest.messages[0]!.seq });
    expect(earlier.messages.map(m => m.body)).toEqual(Array.from({ length: 10 }, (_, index) => `m${index}`));
    expect(earlier.hasEarlier).toBe(false);
  });

  it('counts unread for the list and the badge, respects mute, and marks read', () => {
    const f = fixture();
    f.send(f.alice, 'a');
    f.send(f.alice, 'b');
    expect(f.room.summary(f.bob)).toMatchObject({ unread: 2, muted: false, lastMessage: { senderName: 'Alice', preview: 'b', fromMe: false } });
    expect(countUnreadChats(f.db, f.bob)).toBe(1);
    expect(countUnreadGlobal(f.db, f.alice)).toBe(0);
    // Read and mute answer with the new badge count, so the client updates the badge at once.
    expect(f.room.mute(f.bob, true)).toEqual({ muted: true, unreadChats: 0, unreadAt: expect.any(String) });
    expect(countUnreadChats(f.db, f.bob)).toBe(0);
    expect(f.room.summary(f.bob).muted).toBe(true);
    expect(f.room.mute(f.bob, false)).toMatchObject({ muted: false, unreadChats: 1 });
    const last = f.room.thread(f.bob).messages.at(-1)!;
    expect(f.room.read(f.bob, last.seq)).toEqual({ unreadGlobal: 0, unreadChats: 0, unreadAt: expect.any(String) });
    expect(f.room.thread(f.bob).lastReadSeq).toBe(last.seq);
    // A private unread chat still counts on its own.
    const chat = new ChatService(f.service);
    f.db.prepare('INSERT INTO friendships(user_low,user_high,requester_id,status,created_at,responded_at) VALUES(?,?,?,?,?,?)').run(...[f.alice, f.bob].sort(), f.alice, 'accepted', new Date().toISOString(), new Date().toISOString());
    chat.send(f.alice, f.bob, randomUUID(), 'private');
    expect(countUnreadChats(f.db, f.bob)).toBe(1);
  });

  it('hides the room messages of members the viewer blocked, one way only', () => {
    const f = fixture();
    const fromBob = f.send(f.bob, 'from bob');
    f.send(f.owner, 'welcome');
    const { revision } = f.room.thread(f.alice);
    new CommunityService(f.service).block(f.alice, f.bob, true);
    const later = f.send(f.bob, 'bob again');
    // Alice sees neither Bob's old nor his new messages, in the thread, the list preview or the unread count.
    expect(f.room.thread(f.alice).messages.map(m => m.body)).toEqual(['welcome']);
    expect(f.room.summary(f.alice)).toMatchObject({ unread: 1, lastMessage: { senderName: 'Owner', preview: 'welcome' } });
    expect(countUnreadGlobal(f.db, f.alice)).toBe(1);
    // Edits and deletes of his messages do not reach her polls either.
    f.room.edit(f.owner, fromBob.id, 'edited');
    expect(f.room.thread(f.alice, { after: revision }).messages).toEqual([]);
    expect(f.room.thread(f.alice, { before: later.seq + 1 }).messages.map(m => m.body)).toEqual(['welcome']);
    // Bob's view of the room is unchanged, so it cannot be compared to discover the block.
    f.send(f.alice, 'from alice');
    expect(f.room.thread(f.bob).messages.map(m => m.body)).toEqual(['edited', 'welcome', 'bob again', 'from alice']);
    expect(f.room.summary(f.bob).lastMessage).toMatchObject({ senderName: 'Alice' });
    // Unblocking brings his messages back.
    new CommunityService(f.service).block(f.alice, f.bob, false);
    expect(f.room.thread(f.alice).messages.map(m => m.body)).toEqual(['edited', 'welcome', 'bob again', 'from alice']);
  });

  it('starts a newcomer’s read marker at the messages that existed when they joined', () => {
    const f = fixture();
    f.send(f.alice, 'old news');
    f.send(f.alice, 'older news');
    f.tick(1000);
    const late = f.user(undefined, 'Late');
    f.db.prepare('UPDATE users SET created_at=? WHERE id=?').run(f.clock.now.toISOString(), late);
    expect(countUnreadGlobal(f.db, late)).toBe(0);
    expect(f.room.summary(late).unread).toBe(0);
    expect(f.room.thread(late).lastReadSeq).toBe(2);
    f.room.mute(late, true); f.room.mute(late, false);
    expect(countUnreadGlobal(f.db, late)).toBe(0);
    f.send(f.alice, 'fresh');
    expect(countUnreadGlobal(f.db, late)).toBe(1);
    expect(f.room.thread(late).messages).toHaveLength(3);
  });

  it('applies the per-minute limit and messaging pauses', () => {
    const f = fixture();
    for (let index = 0; index < 20; index += 1) f.room.send(f.alice, randomUUID(), `spam ${index}`);
    fails(() => f.room.send(f.alice, randomUUID(), 'one more'), 'TOO_MANY_REQUESTS');
    new ChatService(f.service).pauseChat(f.owner, { userId: f.bob, days: 1, reason: 'cool off' });
    fails(() => f.room.send(f.bob, randomUUID(), 'hey'), 'FORBIDDEN');
    expect(f.room.thread(f.bob).pause).toEqual({ until: expect.any(String), reason: 'cool off', appealed: false });
  });

  it('shares the per-minute and per-day limits with one-to-one chat', () => {
    const f = fixture();
    const community = new CommunityService(f.service);
    f.service.join(f.alice, { schoolId: f.service.user(f.bob).schoolId!, choice: 'community', grade: '11' });
    community.request(f.alice, f.bob); community.respond(f.bob, f.alice, true);
    const chat = new ChatService(f.service, () => f.clock.now);
    for (let index = 0; index < 10; index += 1) chat.send(f.alice, f.bob, randomUUID(), `private ${index}`);
    for (let index = 0; index < 10; index += 1) f.room.send(f.alice, randomUUID(), `public ${index}`);
    fails(() => f.room.send(f.alice, randomUUID(), 'one more'), 'TOO_MANY_REQUESTS', 'You’re sending messages too fast. Wait a minute and try again.');
    fails(() => chat.send(f.alice, f.bob, randomUUID(), 'one more'), 'TOO_MANY_REQUESTS', 'You’re sending messages too fast. Wait a minute and try again.');
    f.tick(61_000);
    const seed = f.db.prepare('INSERT INTO global_messages(id,sender_id,body,created_at,revision) VALUES(?,?,?,?,1)');
    const earlier = new Date(f.clock.now.getTime() - 3600_000).toISOString();
    for (let index = 0; index < 480; index += 1) seed.run(randomUUID(), f.alice, 'seeded', earlier);
    fails(() => chat.send(f.alice, f.bob, randomUUID(), 'too many today'), 'TOO_MANY_REQUESTS', 'You reached today’s message limit. Try again tomorrow.');
    fails(() => f.room.send(f.alice, randomUUID(), 'too many today'), 'TOO_MANY_REQUESTS', 'You reached today’s message limit. Try again tomorrow.');
  });

  it('returns the stored message for a retried client ID', () => {
    const f = fixture();
    const id = randomUUID();
    const first = f.room.send(f.alice, id, 'once').message;
    expect(f.room.send(f.alice, id, 'once').message).toEqual(first);
    fails(() => f.room.send(f.alice, id, 'twice'), 'BAD_REQUEST');
  });

  it('refuses another member\'s message ID, so owner moderation always lands on the chosen message', () => {
    const f = fixture();
    const victim = f.send(f.alice, 'innocent message');
    fails(() => f.room.send(f.bob, victim.id, 'abusive message'), 'BAD_REQUEST', 'A retry ID cannot be reused for a different message.');
    const own = f.send(f.bob, 'abusive message');
    expect(own).toMatchObject({ body: 'abusive message', sender: { id: f.bob }, fromMe: true });
    f.room.delete(f.owner, own.id, 'abuse');
    const rows = f.db.prepare('SELECT sender_id, deleted_by FROM global_messages ORDER BY seq').all();
    expect(rows).toEqual([{ sender_id: f.alice, deleted_by: null }, { sender_id: f.bob, deleted_by: 'owner' }]);
  });

  it('re-keys message IDs that two senders shared before IDs were unique across the room', () => {
    const directory = mkdtempSync(join(tmpdir(), 'quasar-global-'));
    try {
      const path = join(directory, 'db.sqlite');
      let db = openDatabase(path);
      const user = (name: string) => { const id = randomUUID(); db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, name, name, new Date().toISOString()); return id; };
      const alice = user('Alice'), bob = user('Bob'), shared = randomUUID();
      db.exec('DROP INDEX global_messages_id');
      const insert = db.prepare('INSERT INTO global_messages(id,sender_id,body,created_at,revision) VALUES(?,?,?,?,1)');
      insert.run(shared, alice, 'first', new Date().toISOString());
      insert.run(shared, bob, 'copy', new Date().toISOString());
      db.close();
      db = openDatabase(path);
      const rows = db.prepare('SELECT id, sender_id FROM global_messages ORDER BY seq').all() as { id: string; sender_id: string }[];
      expect(rows[0]).toEqual({ id: shared, sender_id: alice });
      expect(rows[1].id).not.toBe(shared);
      expect(z.uuid().safeParse(rows[1].id).success).toBe(true);
      expect(() => db.prepare('INSERT INTO global_messages(id,sender_id,body,created_at,revision) VALUES(?,?,?,?,1)').run(shared, bob, 'again', new Date().toISOString())).toThrow(/UNIQUE/);
      db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('prunes old messages and deleted text', () => {
    const f = fixture();
    const old = f.send(f.alice, 'old');
    f.room.delete(f.alice, old.id);
    f.send(f.alice, 'fresh');
    pruneGlobalChat(f.db, new Date(f.clock.now.getTime() + 31 * DAY));
    expect(f.db.prepare('SELECT body FROM global_messages WHERE id=?').get(old.id)).toEqual({ body: '' });
    pruneGlobalChat(f.db, new Date(f.clock.now.getTime() + 181 * DAY));
    expect(f.db.prepare('SELECT count(*) n FROM global_messages').get()).toEqual({ n: 0 });
  });

  it('is account-scoped through the router', async () => {
    const f = fixture();
    await expect(f.caller(f.alice).global.send({ accountId: f.bob, clientId: randomUUID(), body: 'hi' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(f.caller(null).global.thread({ accountId: f.alice })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect((await f.caller(f.alice).chat.inbox({ accountId: f.alice })).global).toMatchObject({ unread: 0, muted: false });
    const result = await f.caller(f.alice).global.send({ accountId: f.alice, clientId: randomUUID(), body: 'hi' });
    expect(result.message.sender.displayName).toBe('Alice');
  });
});
