import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRPCError } from '@trpc/server';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { CommunityService } from './community';
import { ChatService, pruneChat, type InboxRow } from './chat';
import { appRouter } from './router';
import { logTrpcError } from './trpc-log';
import { exampleSchedule } from '@/domain/example';

const DAY = 86_400_000;
const CLOSED = 'This chat is closed.';
const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); vi.restoreAllMocks(); });

function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  function user(email = `${randomUUID()}@example.com`, name = 'Student') {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, name, `${name} Fullname`, new Date().toISOString());
    return id;
  }
  const owner = user('owner@example.com', 'Owner');
  const alice = user('alice@students.example.org', 'Alice'), bob = user('bob@gmail.com', 'Bob'), outsider = user(undefined, 'Outsider');
  const cara = user('cara@example.com', 'Cara');
  const school = service.createSchool(alice, { name: 'Community High', location: 'Boston, MA', schedule: exampleSchedule });
  const other = service.createSchool(outsider, { name: 'Other High', location: 'Boston, MA', schedule: exampleSchedule });
  service.join(alice, { schoolId: school.id, choice: 'community', grade: '10' });
  service.join(bob, { schoolId: school.id, choice: 'community', grade: '11' });
  service.join(cara, { schoolId: school.id, choice: 'community', grade: '11' });
  service.join(outsider, { schoolId: other.id, choice: 'community' });
  const community = new CommunityService(service);
  const clock = { now: new Date() };
  const tick = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  const chat = new ChatService(service, () => clock.now);
  // A session from a Google sign-in just now, so owner tools accept it (recentSignIn in src/lib/admin-session.ts).
  const caller = (id: string | null) => appRouter.createCaller({ service, userId: id, authAt: Date.now() });
  const befriend = (a: string, b: string) => { community.request(a, b); community.respond(b, a, true); };
  const schoolmate = (name: string) => { const id = user(undefined, name); service.join(id, { schoolId: school.id, choice: 'community' }); return id; };
  /** Sends through ChatService with the test clock, stepping 4 s so the per-minute limit never interferes. */
  const send = (from: string, to: string, body = 'hello', clientId = randomUUID()) => { tick(4000); return chat.send(from, to, clientId, body).message; };
  const inboxRow = (viewer: string, otherId: string): InboxRow | undefined => chat.inbox(viewer).rows.find(row => (row.state === 'open' ? row.peer.id : row.userId) === otherId);
  const auditCount = (action: string) => (db.prepare('SELECT count(*) n FROM audit_log WHERE action=?').get(action) as { n: number }).n;
  return { db, service, community, user, owner, alice, bob, cara, outsider, school, other, caller, clock, tick, chat, befriend, schoolmate, send, inboxRow, auditCount };
}

function fails(fn: () => unknown, code: TRPCError['code'], message?: string) {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(TRPCError);
  expect((error as TRPCError).code).toBe(code);
  if (message !== undefined) expect((error as TRPCError).message).toBe(message);
}
function caught(fn: () => unknown): TRPCError {
  try { fn(); } catch (error) { return error as TRPCError; }
  throw new Error('expected a failure');
}

describe('1. scope', () => {
  it('lets accepted friends chat and closes the chat for everyone else', async () => {
    const f = fixture();
    f.befriend(f.alice, f.bob);
    const sent = await f.caller(f.alice).chat.send({ accountId: f.alice, userId: f.bob, clientId: randomUUID(), body: 'Hi Bob' });
    expect(sent.message).toMatchObject({ body: 'Hi Bob', fromMe: true, deletedBy: null });
    const thread = await f.caller(f.bob).chat.thread({ accountId: f.bob, userId: f.alice });
    expect(thread.messages.map(message => [message.body, message.fromMe])).toEqual([['Hi Bob', false]]);

    const dan = f.schoolmate('Dan');
    f.community.request(f.alice, f.cara); // pending only
    for (const other of [f.cara, dan, f.outsider]) {
      const alice = f.caller(f.alice);
      await expect(alice.chat.thread({ accountId: f.alice, userId: other })).rejects.toMatchObject({ code: 'NOT_FOUND', message: CLOSED });
      await expect(alice.chat.send({ accountId: f.alice, userId: other, clientId: randomUUID(), body: 'hi' })).rejects.toMatchObject({ code: 'NOT_FOUND', message: CLOSED });
      await expect(alice.chat.read({ accountId: f.alice, userId: other, seq: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND', message: CLOSED });
      await expect(alice.chat.mute({ accountId: f.alice, userId: other, muted: true })).rejects.toMatchObject({ code: 'NOT_FOUND', message: CLOSED });
    }
    await expect(f.caller(f.alice).chat.send({ accountId: f.alice, userId: f.alice, clientId: randomUUID(), body: 'me' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'You cannot message yourself.' });
    fails(() => f.chat.thread(f.alice, f.alice), 'BAD_REQUEST', 'You cannot message yourself.');

    // Chats follow the friendship across a school change, and the chip reflects the current school.
    f.db.prepare('INSERT INTO school_verifications(user_id,school_id,method,verified_at) VALUES(?,?,?,?)').run(f.bob, f.other.id, 'support', 'now');
    expect(f.chat.thread(f.alice, f.bob).peer.verified).toBe(false);
    f.service.join(f.bob, { schoolId: f.other.id, choice: 'community' });
    expect(f.chat.thread(f.alice, f.bob).peer).toMatchObject({ verified: true, fullName: null });
    expect(f.send(f.bob, f.alice, 'still here').body).toBe('still here');

    // The owner has no special chat reads.
    await expect(f.caller(f.owner).chat.thread({ accountId: f.owner, userId: f.bob })).rejects.toMatchObject({ code: 'NOT_FOUND', message: CLOSED });
    await expect(f.caller(f.owner).chat.thread({ accountId: f.owner, userId: f.alice })).rejects.toMatchObject({ code: 'NOT_FOUND', message: CLOSED });
  });
});

describe('2. idempotent send', () => {
  it('stores one row per (sender, clientId) and never charges a retry', () => {
    const f = fixture();
    f.befriend(f.alice, f.bob); f.befriend(f.alice, f.cara);
    const id = randomUUID();
    const first = f.chat.send(f.alice, f.bob, id, 'hello there');
    const again = f.chat.send(f.alice, f.bob, id, '  hello there ');
    expect(again.message.seq).toBe(first.message.seq);
    expect((f.db.prepare('SELECT count(*) n FROM chat_messages WHERE sender_id=?').get(f.alice) as { n: number }).n).toBe(1);
    fails(() => f.chat.send(f.alice, f.bob, id, 'something else'), 'BAD_REQUEST', 'A retry ID cannot be reused for a different message.');
    fails(() => f.chat.send(f.alice, f.cara, id, 'hello there'), 'BAD_REQUEST', 'A retry ID cannot be reused for a different message.');
    // Another sender may use the same client ID.
    expect(f.chat.send(f.bob, f.alice, id, 'hello there').message.seq).not.toBe(first.message.seq);

    // Use up the per-minute limit: the retry still returns the stored message.
    for (let index = 1; index < 20; index++) f.chat.send(f.alice, f.bob, randomUUID(), `message ${index}`);
    fails(() => f.chat.send(f.alice, f.bob, randomUUID(), 'one too many'), 'TOO_MANY_REQUESTS');
    expect(f.chat.send(f.alice, f.bob, id, 'hello there').message.seq).toBe(first.message.seq);
    // And after a pause starts.
    f.chat.pauseChat(f.owner, { userId: f.alice, days: 1, reason: 'Testing the pause' });
    expect(f.chat.send(f.alice, f.bob, id, 'hello there').message.seq).toBe(first.message.seq);
    fails(() => f.chat.send(f.alice, f.bob, randomUUID(), 'new'), 'FORBIDDEN', 'Support paused your messaging.');

    // A retry of a message deleted since returns it as deleted.
    const bobId = randomUUID();
    f.send(f.bob, f.alice, 'oops', bobId);
    f.chat.delete(f.bob, f.alice, bobId);
    expect(f.chat.send(f.bob, f.alice, bobId, 'oops').message).toMatchObject({ id: bobId, body: null, deletedBy: 'sender' });
  });
});

describe('3. body rules and no echo', () => {
  it('rejects empty and long bodies and strips spoofing characters', () => {
    const f = fixture();
    f.befriend(f.alice, f.bob);
    fails(() => f.chat.send(f.alice, f.bob, randomUUID(), '   \n\t  '), 'BAD_REQUEST', 'Write a message first.');
    fails(() => f.chat.send(f.alice, f.bob, randomUUID(), '​‌﻿'), 'BAD_REQUEST', 'Write a message first.');
    fails(() => f.chat.send(f.alice, f.bob, randomUUID(), 'x'.repeat(1001)), 'BAD_REQUEST', 'Messages can be up to 1,000 characters.');
    expect(f.send(f.alice, f.bob, 'a‮b\u0007c\r\nd\n\n\n\ne⁦').body).toBe('abc\nd\n\ne');
  });
  it('never puts message text in an error message or the logged line', async () => {
    const f = fixture();
    f.befriend(f.alice, f.bob);
    const marker = 'ZX-SECRET-42';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reused = randomUUID();
    await f.caller(f.alice).chat.send({ accountId: f.alice, userId: f.bob, clientId: reused, body: 'first' });
    const bodies = [`${marker} ${'x'.repeat(1000)}`, `${'y'.repeat(999)} ${marker}`];
    const errors: TRPCError[] = [];
    for (const body of bodies) {
      errors.push(caught(() => f.chat.send(f.alice, f.bob, randomUUID(), body)));
      errors.push(await f.caller(f.alice).chat.send({ accountId: f.alice, userId: f.bob, clientId: randomUUID(), body }).then(() => { throw new Error('expected a failure'); }, (error: TRPCError) => error));
    }
    errors.push(await f.caller(f.alice).chat.send({ accountId: f.alice, userId: f.bob, clientId: reused, body: marker }).then(() => { throw new Error('expected a failure'); }, (error: TRPCError) => error));
    // A 5,000-character body fails zod's max(4000) before the service runs.
    const tooLong = await f.caller(f.alice).chat.send({ accountId: f.alice, userId: f.bob, clientId: randomUUID(), body: `${marker}${'z'.repeat(5000)}` }).then(() => { throw new Error('expected a failure'); }, (error: TRPCError) => error);
    expect(tooLong.code).toBe('BAD_REQUEST');
    errors.push(tooLong);
    for (const error of errors) {
      expect(error).toBeInstanceOf(TRPCError);
      expect(error.message).not.toContain(marker);
      log.mockClear();
      logTrpcError({ path: 'chat.send', error });
      expect(log).toHaveBeenCalledTimes(1);
      const line = log.mock.calls.map(call => call.join(' ')).join('\n');
      expect(line).toContain('chat.send');
      expect(line).not.toContain(marker);
    }
  });
});

describe('4. rate limits', () => {
  it('allows 20 a minute, 500 a day and 20 new chats a day', () => {
    const f = fixture();
    f.befriend(f.alice, f.bob);
    for (let index = 0; index < 20; index++) f.chat.send(f.alice, f.bob, randomUUID(), `burst ${index}`);
    fails(() => f.chat.send(f.alice, f.bob, randomUUID(), 'burst 21'), 'TOO_MANY_REQUESTS', 'You’re sending messages too fast. Wait a minute and try again.');
    f.tick(61_000);
    f.chat.send(f.alice, f.bob, randomUUID(), 'after a minute');

    const thread = f.db.prepare('SELECT id FROM chat_threads').get() as { id: string };
    const seed = f.db.prepare('INSERT INTO chat_messages(id,thread_id,sender_id,body,created_at,revision) VALUES(?,?,?,?,?,1)');
    const earlier = new Date(f.clock.now.getTime() - 2 * 3600_000).toISOString();
    for (let index = 0; index < 480; index++) seed.run(randomUUID(), thread.id, f.alice, 'seeded', earlier);
    fails(() => f.chat.send(f.alice, f.bob, randomUUID(), 'too many today'), 'TOO_MANY_REQUESTS', 'You reached today’s message limit. Try again tomorrow.');
    f.tick(DAY);
    f.chat.send(f.alice, f.bob, randomUUID(), 'next day');
  });
  it('stops a 21st new conversation in 24 hours but not a message in an existing chat', () => {
    const f = fixture();
    const sprayer = f.schoolmate('Sprayer');
    const friends = Array.from({ length: 21 }, (_, index) => { const id = f.schoolmate(`Friend ${index}`); f.befriend(sprayer, id); return id; });
    for (const friend of friends.slice(0, 20)) f.send(sprayer, friend, 'hey');
    f.tick(4000);
    fails(() => f.chat.send(sprayer, friends[20]!, randomUUID(), 'hey'), 'TOO_MANY_REQUESTS', 'You started 20 new chats today. Try again tomorrow.');
    expect(f.send(sprayer, friends[0]!, 'a 21st message in an existing chat').body).toBeTruthy();
    // Replying in a chat someone else started is also a first message for the replier.
    f.tick(DAY);
    expect(f.send(sprayer, friends[20]!, 'hey').body).toBe('hey');
  });
});

describe('5. revocation', () => {
  it('ends access at once on unfriend, block and support removal', async () => {
    const f = fixture();
    f.befriend(f.alice, f.bob);
    f.send(f.bob, f.alice, 'first');
    f.send(f.alice, f.bob, 'second');
    f.send(f.bob, f.alice, 'third');
    expect(f.service.workspace(f.alice).community.unreadChats).toBe(1);

    // (a) Unfriend.
    await f.caller(f.alice).community.remove({ accountId: f.alice, userId: f.bob });
    for (const [viewer, other] of [[f.alice, f.bob], [f.bob, f.alice]] as const) {
      fails(() => f.chat.thread(viewer, other), 'NOT_FOUND', CLOSED);
      fails(() => f.chat.send(viewer, other, randomUUID(), 'hi'), 'NOT_FOUND', CLOSED);
      expect(f.chat.inbox(viewer).rows.filter(row => row.state === 'open')).toEqual([]);
    }
    expect(f.service.workspace(f.alice).community.unreadChats).toBe(0);
    expect(f.chat.inbox(f.alice).unreadChats).toBe(0);

    // (b) Friends again: the history comes back.
    f.befriend(f.alice, f.bob);
    expect(f.chat.thread(f.alice, f.bob).messages.map(message => message.body)).toEqual(['first', 'second', 'third']);

    // (c) A block in either direction, and unblocking does not reopen the chat.
    for (const [blocker, blocked] of [[f.alice, f.bob], [f.bob, f.alice]] as const) {
      f.community.block(blocker, blocked, true);
      fails(() => f.chat.thread(f.alice, f.bob), 'NOT_FOUND', CLOSED);
      fails(() => f.chat.thread(f.bob, f.alice), 'NOT_FOUND', CLOSED);
      f.community.block(blocker, blocked, false);
      fails(() => f.chat.thread(f.alice, f.bob), 'NOT_FOUND', CLOSED);
      fails(() => f.chat.send(f.bob, f.alice, randomUUID(), 'hi'), 'NOT_FOUND', CLOSED);
      f.befriend(f.alice, f.bob);
      expect(f.chat.thread(f.alice, f.bob).messages).toHaveLength(3);
    }

    // (d) Support removal closes every chat of bob's and resolves chat reports against him.
    f.befriend(f.bob, f.cara);
    f.send(f.bob, f.cara, 'hi cara');
    f.chat.report(f.alice, f.bob, { category: 'bullying', block: false });
    f.community.removeFromSchool(f.owner, f.bob, f.school.id, 'Harassment');
    fails(() => f.chat.thread(f.alice, f.bob), 'NOT_FOUND', CLOSED);
    fails(() => f.chat.thread(f.cara, f.bob), 'NOT_FOUND', CLOSED);
    fails(() => f.chat.send(f.bob, f.cara, randomUUID(), 'hi'), 'NOT_FOUND', CLOSED);
    expect(f.db.prepare('SELECT outcome FROM reports WHERE reported_id=? AND thread_id IS NOT NULL').all(f.bob)).toEqual([{ outcome: 'removed' }]);
  });
});

describe('5b. slur filter', () => {
  it('stores slurs censored in one-to-one chat too, and lets swearing through', () => {
    const f = fixture();
    f.befriend(f.alice, f.bob);
    expect(f.send(f.alice, f.bob, 'you f4ggot').body).toBe('you ******');
    expect(f.db.prepare('SELECT body FROM chat_messages').get()).toEqual({ body: 'you ******' });
    expect(f.send(f.alice, f.bob, 'this test is bullshit').body).toBe('this test is bullshit');
  });

  it('keeps https links whole, so a slur-shaped path segment or host label does not break the link', () => {
    const f = fixture();
    f.befriend(f.alice, f.bob);
    expect(f.send(f.alice, f.bob, 'read https://en.wikipedia.org/wiki/Coon_Rapids,_Minnesota you f4ggot').body)
      .toBe('read https://en.wikipedia.org/wiki/Coon_Rapids,_Minnesota you ******');
    expect(f.send(f.alice, f.bob, 'https://www.paki.example.com/w0p/').body).toBe('https://www.paki.example.com/w0p/');
    // Not a link (http, or credentials), so censored like any other text.
    expect(f.send(f.alice, f.bob, 'http://example.com/coon').body).toBe('http://example.com/****');
  });

  it('censors the list preview before cutting it, so a stored slur split at 120 characters never shows', () => {
    const f = fixture();
    f.befriend(f.alice, f.bob);
    f.send(f.alice, f.bob, 'placeholder');
    // A row stored before the filter existed: the slur straddles the 120-character cut.
    f.db.prepare('UPDATE chat_messages SET body=?').run(`${'x'.repeat(116)} retard`);
    expect(f.inboxRow(f.bob, f.alice)).toMatchObject({ lastMessage: { preview: `${'x'.repeat(116)} ***` } });
  });
});

describe('6b. reopening a closed chat', () => {
  it('lifts the viewer’s block and sends a request; acceptance brings the history back', () => {
    const f = fixture();
    f.befriend(f.alice, f.cara);
    f.send(f.cara, f.alice, 'before the block');
    f.community.block(f.alice, f.cara, true);
    expect(f.inboxRow(f.alice, f.cara)).toMatchObject({ state: 'closed', reopen: 'unblock' });
    expect(f.chat.reopen(f.alice, f.cara)).toEqual({ unblocked: true, friendState: 'requested' });
    expect(f.db.prepare('SELECT count(*) n FROM blocks WHERE blocker_id=?').get(f.alice)).toEqual({ n: 0 });
    // Still closed until Cara accepts; the row now offers a plain friend request, and a repeat is harmless.
    expect(f.inboxRow(f.alice, f.cara)).toMatchObject({ state: 'closed', reopen: 'friend' });
    expect(f.chat.reopen(f.alice, f.cara)).toEqual({ unblocked: false, friendState: 'requested' });
    f.community.respond(f.cara, f.alice, true);
    expect(f.chat.thread(f.alice, f.cara).messages.map(m => m.body)).toEqual(['before the block']);
    expect(f.inboxRow(f.alice, f.cara)).toMatchObject({ state: 'open' });
  });

  it('accepts the other person’s waiting request at once, and refuses across schools or through their block', () => {
    const f = fixture();
    f.befriend(f.alice, f.bob);
    f.send(f.alice, f.bob, 'hi');
    f.community.remove(f.bob, f.alice);
    f.community.request(f.bob, f.alice);
    expect(f.chat.reopen(f.alice, f.bob)).toEqual({ unblocked: false, friendState: 'friends' });
    expect(f.inboxRow(f.alice, f.bob)).toMatchObject({ state: 'open' });
    // Cara blocked Alice: Alice's row offers a request (nothing reveals the block), and the request gets the phase-3 refusal.
    f.befriend(f.alice, f.cara);
    f.send(f.alice, f.cara, 'hey');
    f.community.block(f.cara, f.alice, true);
    expect(f.inboxRow(f.alice, f.cara)).toMatchObject({ state: 'closed', reopen: 'friend' });
    fails(() => f.chat.reopen(f.alice, f.cara), 'NOT_FOUND', 'This member is not available.');
    // A former friend from another school cannot be re-added, so the row has no reopen option.
    f.db.prepare('UPDATE users SET school_id=? WHERE id=?').run(f.other.id, f.bob);
    f.community.remove(f.alice, f.bob);
    expect(f.inboxRow(f.alice, f.bob)).toMatchObject({ state: 'closed', reopen: null });
    fails(() => f.chat.reopen(f.alice, f.bob), 'NOT_FOUND');
  });
});

describe('6. closed rows', () => {
  it('shows the same report-only row after an unfriend or a block, for 30 days', () => {
    const f = fixture();
    f.befriend(f.alice, f.bob); f.befriend(f.alice, f.cara);
    f.send(f.bob, f.alice, 'from bob');
    f.send(f.cara, f.alice, 'from cara');
    f.community.remove(f.alice, f.bob);
    f.community.block(f.alice, f.cara, true);
    const unfriended = f.inboxRow(f.alice, f.bob)!, blocked = f.inboxRow(f.alice, f.cara)!;
    expect(unfriended).toEqual({ state: 'closed', userId: f.bob, displayName: 'Bob', lastAt: expect.any(String), reopen: 'friend' });
    expect(blocked).toEqual({ state: 'closed', userId: f.cara, displayName: 'Cara', lastAt: expect.any(String), reopen: 'unblock' });
    expect(Object.keys(unfriended).sort()).toEqual(Object.keys(blocked).sort());
    // Both sides see a closed row, and the blocked person's row looks the same as the unfriended one.
    const bobSide = f.inboxRow(f.bob, f.alice)!, caraSide = f.inboxRow(f.cara, f.alice)!;
    expect(bobSide).toEqual({ state: 'closed', userId: f.alice, displayName: 'Alice', lastAt: expect.any(String), reopen: 'friend' });
    expect(caraSide).toEqual({ ...bobSide, lastAt: expect.any(String) });
    expect(JSON.stringify(f.chat.inbox(f.alice))).not.toMatch(/from bob|from cara/);

    f.tick(31 * DAY);
    expect(f.inboxRow(f.alice, f.bob)).toBeUndefined();
    expect(f.inboxRow(f.alice, f.cara)).toBeUndefined();
    expect(f.inboxRow(f.cara, f.alice)).toBeUndefined();
  });
  it('lets the victim report after the harasser blocks first', async () => {
    const f = fixture();
    f.befriend(f.alice, f.bob);
    for (const body of ['you are a loser', 'nobody likes you', 'watch out']) f.send(f.bob, f.alice, body);
    f.community.block(f.bob, f.alice, true);
    expect(f.inboxRow(f.alice, f.bob)).toMatchObject({ state: 'closed' });
    expect(await f.caller(f.alice).chat.report({ accountId: f.alice, userId: f.bob, category: 'bullying', block: false })).toEqual({ blocked: false });
    const report = f.db.prepare('SELECT id FROM reports WHERE reporter_id=?').get(f.alice) as { id: string };
    const evidence = f.chat.showEvidence(f.owner, report.id);
    expect(evidence.items.map(item => [item.senderName, item.body])).toEqual([['Bob', 'you are a loser'], ['Bob', 'nobody likes you'], ['Bob', 'watch out']]);
  });
});

describe('7. unread and read', () => {
  it('counts chats, only moves forward, and leaves muted rows out of the badge', () => {
    const f = fixture();
    f.befriend(f.alice, f.bob); f.befriend(f.alice, f.cara);
    const [one, two, three] = [f.send(f.bob, f.alice, '1'), f.send(f.bob, f.alice, '2'), f.send(f.bob, f.alice, '3')];
    const fromCara = f.send(f.cara, f.alice, 'c');
    expect(f.chat.unreadChats(f.alice).unreadChats).toBe(2);
    expect(f.service.workspace(f.alice).community.unreadChats).toBe(2);
    expect(f.chat.inbox(f.alice).unreadChats).toBe(2);

    expect(f.chat.read(f.alice, f.bob, two!.seq).unreadChats).toBe(2);
    expect(f.inboxRow(f.alice, f.bob)).toMatchObject({ state: 'open', unread: 1 });
    expect(f.chat.read(f.alice, f.bob, three!.seq)).toEqual({ unreadChats: 1, unreadAt: expect.any(String) });
    // Lower seq is ignored; a seq past the end is capped.
    f.chat.read(f.alice, f.bob, one!.seq);
    expect(f.chat.thread(f.alice, f.bob).lastReadSeq).toBe(three!.seq);
    f.chat.read(f.alice, f.cara, 999_999);
    expect(f.chat.thread(f.alice, f.cara).lastReadSeq).toBe(fromCara.seq);
    expect(f.chat.unreadChats(f.alice).unreadChats).toBe(0);

    // Own messages and deleted messages never count.
    f.send(f.alice, f.bob, 'mine');
    const gone = randomUUID();
    f.send(f.cara, f.alice, 'deleted soon', gone);
    f.chat.delete(f.cara, f.alice, gone);
    expect(f.chat.unreadChats(f.alice).unreadChats).toBe(0);
    expect(f.inboxRow(f.alice, f.cara)).toMatchObject({ unread: 0 });

    // Muted: out of the badge, but the row keeps its count.
    f.send(f.bob, f.alice, 'new');
    expect(f.chat.unreadChats(f.alice).unreadChats).toBe(1);
    // The answer carries the new badge count, so the client updates the badge at once.
    expect(f.chat.mute(f.alice, f.bob, true)).toEqual({ muted: true, unreadChats: 0, unreadAt: expect.any(String) });
    expect(f.chat.unreadChats(f.alice).unreadChats).toBe(0);
    expect(f.inboxRow(f.alice, f.bob)).toMatchObject({ unread: 1, muted: true });
  });
});

describe('8. delete and cursors', () => {
  it('lets only the sender delete, and delivers the deletion through the revision cursor', async () => {
    const f = fixture();
    f.befriend(f.alice, f.bob);
    const id = randomUUID();
    const sent = await f.caller(f.alice).chat.send({ accountId: f.alice, userId: f.bob, clientId: id, body: 'regret' });
    expect(Object.keys(sent)).toEqual(['message']);
    expect(sent.message).not.toHaveProperty('revision');
    fails(() => f.chat.delete(f.bob, f.alice, id), 'NOT_FOUND', CLOSED);
    const before = f.chat.thread(f.bob, f.alice).revision;
    expect(f.chat.delete(f.alice, f.bob, id)).toEqual({ deleted: true });
    expect(f.chat.delete(f.alice, f.bob, id)).toEqual({ deleted: true });
    for (const [viewer, other] of [[f.alice, f.bob], [f.bob, f.alice]] as const) {
      expect(f.chat.thread(viewer, other).messages[0]).toMatchObject({ id, body: null, deletedBy: 'sender' });
    }
    const changes = f.chat.thread(f.bob, f.alice, { after: before });
    expect(changes).toMatchObject({ reset: false, revision: before + 1 });
    expect(changes.messages).toEqual([expect.objectContaining({ id, body: null, deletedBy: 'sender' })]);
  });
  it('pages backwards, and resets on too many changes or a stale cursor', () => {
    const f = fixture();
    f.befriend(f.alice, f.bob); f.befriend(f.alice, f.cara);
    for (let index = 0; index < 210; index++) f.send(index % 2 ? f.bob : f.alice, index % 2 ? f.alice : f.bob, `m${index}`);
    let page = f.chat.thread(f.alice, f.bob);
    expect(page.messages).toHaveLength(50);
    expect(page.messages.at(-1)?.body).toBe('m209');
    expect(page.hasEarlier).toBe(true);
    const seen = [...page.messages];
    while (page.hasEarlier) {
      page = f.chat.thread(f.alice, f.bob, { before: page.messages[0]!.seq });
      seen.unshift(...page.messages);
    }
    expect(page.messages).toHaveLength(10);
    expect(seen.map(message => message.body)).toEqual(Array.from({ length: 210 }, (_, index) => `m${index}`));

    const reset = f.chat.thread(f.alice, f.bob, { after: 0 });
    expect(reset).toMatchObject({ reset: true, revision: 210 });
    expect(reset.messages).toHaveLength(50);
    expect(f.chat.thread(f.alice, f.bob, { after: 20 })).toMatchObject({ reset: false });
    expect(f.chat.thread(f.alice, f.bob, { after: 20 }).messages).toHaveLength(190);
    expect(f.chat.thread(f.alice, f.bob, { after: 211 })).toMatchObject({ reset: true, revision: 210 });
    expect(f.chat.thread(f.alice, f.cara)).toMatchObject({ messages: [], revision: 0, reset: false });
    expect(f.chat.thread(f.alice, f.cara, { after: 5 })).toMatchObject({ messages: [], revision: 0, reset: true });
  });
});

describe('9. reports', () => {
  function reported() {
    const f = fixture();
    f.befriend(f.alice, f.bob);
    const ids: string[] = [];
    for (let index = 0; index < 40; index++) { const id = randomUUID(); ids.push(id); f.send(index % 2 ? f.bob : f.alice, index % 2 ? f.alice : f.bob, `m${index}`, id); }
    const evidence = (reportId: string) => JSON.parse((f.db.prepare('SELECT evidence FROM reports WHERE id=?').get(reportId) as { evidence: string }).evidence) as { seq: number; body: string; fromReported: boolean; deletedBy: string | null; anchor: boolean }[];
    const latestReport = () => (f.db.prepare('SELECT * FROM reports ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as { id: string; reason: string; category: string; thread_id: string });
    return { ...f, ids, evidence, latestReport };
  }
  it('freezes the latest 30 messages from both people, with deleted text but not erased text', () => {
    const f = reported();
    f.chat.delete(f.bob, f.alice, f.ids[37]!);
    f.db.prepare("UPDATE chat_messages SET body='' WHERE id=?").run(f.ids[38]!);
    f.chat.report(f.alice, f.bob, { category: 'bullying', note: 'He keeps doing this', block: false });
    const report = f.latestReport();
    expect(report).toMatchObject({ category: 'bullying', reason: 'Bullying or harassment: He keeps doing this' });
    const items = f.evidence(report.id);
    expect(items).toHaveLength(30);
    expect(items.map(item => item.body)).toEqual([...Array.from({ length: 29 }, (_, index) => `m${index + 9}`).filter(body => body !== 'm38'), 'm39']);
    expect(items.find(item => item.body === 'm37')).toMatchObject({ deletedBy: 'sender', fromReported: true });
    expect(new Set(items.map(item => item.fromReported))).toEqual(new Set([true, false]));
    expect(items.every(item => !item.anchor)).toBe(true);
    // A later deletion does not change the snapshot.
    const frozen = (f.db.prepare('SELECT evidence FROM reports WHERE id=?').get(report.id) as { evidence: string }).evidence;
    f.chat.delete(f.bob, f.alice, f.ids[39]!);
    expect((f.db.prepare('SELECT evidence FROM reports WHERE id=?').get(report.id) as { evidence: string }).evidence).toBe(frozen);
    // One open report per thread.
    fails(() => f.chat.report(f.alice, f.bob, { category: 'other', block: false }), 'CONFLICT', 'You already reported this chat. Support will review it.');
  });
  it('anchors a message report on the other person’s message', () => {
    const f = reported();
    const anchor = f.chat.thread(f.alice, f.bob).messages.find(message => message.body === 'm21')!;
    const mine = f.chat.thread(f.alice, f.bob).messages.find(message => message.body === 'm20')!;
    fails(() => f.chat.report(f.alice, f.bob, { category: 'spam', seq: mine.seq, block: false }), 'BAD_REQUEST', 'You cannot report your own message.');
    fails(() => f.chat.report(f.alice, f.bob, { category: 'spam', seq: 999_999, block: false }), 'NOT_FOUND', CLOSED);
    f.chat.report(f.alice, f.bob, { category: 'spam', seq: anchor.seq, block: false });
    const items = f.evidence(f.latestReport().id);
    expect(items.map(item => item.body)).toEqual(Array.from({ length: 30 }, (_, index) => `m${index + 6}`));
    expect(items.filter(item => item.anchor).map(item => item.body)).toEqual(['m21']);
    expect(items.findIndex(item => item.anchor)).toBe(15);
  });
  it('counts toward the ten-report cap, can block in the same call, and sorts danger first', () => {
    const f = reported();
    f.befriend(f.cara, f.bob); f.befriend(f.alice, f.cara);
    f.send(f.bob, f.cara, 'hi cara');
    f.send(f.cara, f.alice, 'hi alice');
    f.chat.report(f.alice, f.bob, { category: 'bullying', block: false });
    for (let index = 0; index < 9; index++) f.community.report(f.alice, { userId: f.user(undefined, `R${index}`), reason: 'A reason long enough' });
    fails(() => f.chat.report(f.alice, f.cara, { category: 'other', block: false }), 'TOO_MANY_REQUESTS', 'You already have ten open reports. Wait for support to review them.');

    expect(f.chat.report(f.cara, f.bob, { category: 'danger', note: '', block: true })).toEqual({ blocked: true });
    expect(f.db.prepare('SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?').get(f.cara, f.bob)).toBeTruthy();
    expect(f.community.areFriends(f.cara, f.bob)).toBe(false);
    expect(f.latestReport()).toMatchObject({ category: 'danger', reason: 'Someone may be in danger' });
    const reports = f.community.reports(f.owner);
    expect(reports[0]).toMatchObject({ category: 'danger', isChat: true, reporterName: 'Cara', evidenceCount: 1 });
    expect(reports.find(report => report.category === 'bullying')).toMatchObject({ isChat: true, evidenceCount: 30 });
    expect(reports.filter(report => !report.isChat).every(report => report.category === null && report.evidenceCount === 0)).toBe(true);
    // After danger, oldest first.
    const rest = reports.slice(1).map(report => report.createdAt);
    expect(rest).toEqual([...rest].sort());
  });
  it('refuses an empty snapshot and rolls back the report when the block fails', () => {
    const f = fixture();
    f.befriend(f.alice, f.bob);
    f.chat.mute(f.alice, f.bob, true);
    fails(() => f.chat.report(f.alice, f.bob, { category: 'other', block: false }), 'BAD_REQUEST', 'This chat has no messages to report.');
    expect((f.db.prepare('SELECT count(*) n FROM reports').get() as { n: number }).n).toBe(0);

    f.send(f.bob, f.alice, 'hello');
    const original = CommunityService.prototype.block;
    vi.spyOn(CommunityService.prototype, 'block').mockImplementation(function (this: CommunityService, viewerId: string, otherId: string, blocked: boolean) {
      original.call(this, viewerId, otherId, blocked);
      throw new Error('disk full');
    });
    expect(() => f.chat.report(f.alice, f.bob, { category: 'other', block: true })).toThrow('disk full');
    expect((f.db.prepare('SELECT count(*) n FROM reports').get() as { n: number }).n).toBe(0);
    expect(f.db.prepare('SELECT 1 FROM blocks').get()).toBeUndefined();
    expect(f.community.areFriends(f.alice, f.bob)).toBe(true);
  });
});

describe('10. what the owner can see', () => {
  it('pins the admin procedure list', () => {
    expect(Object.keys(appRouter._def.procedures).filter(key => key.startsWith('admin.')).sort()).toEqual([
      'schools', 'update', 'requests', 'resolveRequest', 'verificationRequests', 'decideVerification', 'reports', 'resolveReport',
      'removeMember', 'proposals', 'decideProposal', 'showEvidence', 'redactMessage', 'pauseChat', 'liftChatPause', 'chatPauses',
      'security', 'renameSchool', 'auditLog', 'users.search', 'users.view', 'users.updateAccount', 'users.suspend', 'users.signOut', 'users.removeBrowsers',
      'users.moveSchool', 'users.setVerified', 'users.unban', 'users.savePersonal', 'users.saveTask', 'users.deleteTask', 'users.feed',
      'users.removeFriendship', 'users.deleteGlobal', 'users.editGlobal',
    ].map(name => `admin.${name}`).sort());
  });
  it('shows chat text only through an audited report snapshot', async () => {
    const f = fixture();
    f.befriend(f.alice, f.bob); f.befriend(f.alice, f.cara);
    f.send(f.bob, f.alice, 'ZX-REPORTED-1 mean words');
    const kept = f.send(f.alice, f.bob, 'please stop');
    f.send(f.alice, f.cara, 'ZX-PRIVATE-9 secret plans');
    f.send(f.cara, f.alice, 'ZX-PRIVATE-9 reply');
    await f.caller(f.alice).chat.report({ accountId: f.alice, userId: f.bob, category: 'bullying', note: 'mean', block: false });
    const owner = f.caller(f.owner);
    const ownerId = f.owner;
    const reports = await owner.admin.reports();
    expect(JSON.stringify(reports)).not.toContain('ZX-REPORTED-1');
    expect(reports[0]).toMatchObject({ isChat: true, category: 'bullying', evidenceCount: 2, history: { reports: 1, removals: 0, pauses: 0 }, pause: null });
    const reportId = reports[0]!.id;

    await expect(f.caller(f.alice).admin.showEvidence({ accountId: f.alice, reportId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller(f.alice).admin.chatPauses()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller(f.alice).admin.pauseChat({ accountId: f.alice, userId: f.bob, days: 1, reason: 'nope' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller(f.alice).admin.redactMessage({ accountId: f.alice, reportId, seq: kept.seq })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.auditCount('reports.view')).toBe(0);

    const evidence = await owner.admin.showEvidence({ accountId: ownerId, reportId });
    expect(evidence.items.map(item => [item.senderName, item.fromReported, item.body])).toEqual([['Bob', true, 'ZX-REPORTED-1 mean words'], ['Alice', false, 'please stop']]);
    expect(f.auditCount('reports.view')).toBe(1);
    expect(JSON.parse((f.db.prepare("SELECT detail FROM audit_log WHERE action='reports.view'").get() as { detail: string }).detail)).toEqual({ reportId });

    // The unreported alice-cara chat appears in no admin output, the user console's records of all three included:
    // they carry each chat's counts and times, never its text.
    const records = await Promise.all([f.alice, f.bob, f.cara].map(userId => owner.admin.users.view({ accountId: ownerId, userId, reason: 'Reviewing a report' })));
    expect(records[0]!.chats).toEqual(expect.arrayContaining([expect.objectContaining({ userId: f.cara, sent: 1, received: 1 })]));
    const outputs = await Promise.all([owner.admin.schools(), owner.admin.requests(), owner.admin.verificationRequests(), owner.admin.reports(), owner.admin.proposals(), owner.admin.chatPauses(),
      owner.admin.users.search({ query: '' }), owner.admin.auditLog({})]);
    expect(JSON.stringify([...outputs, ...records, evidence])).not.toContain('ZX-PRIVATE-9');
    expect(JSON.stringify(records)).not.toContain('ZX-REPORTED-1');

    // Hide message.
    await expect(owner.admin.showEvidence({ accountId: ownerId, reportId: randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'This report has no messages.' });
    const unrelated = f.chat.thread(f.alice, f.cara).messages[0]!.seq;
    await expect(owner.admin.redactMessage({ accountId: ownerId, reportId, seq: unrelated })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'This message is not in this report.' });
    await owner.admin.redactMessage({ accountId: ownerId, reportId, seq: kept.seq });
    expect(f.chat.thread(f.alice, f.bob).messages.find(message => message.seq === kept.seq)).toMatchObject({ body: null, deletedBy: 'support' });
    expect(f.chat.thread(f.bob, f.alice).messages.find(message => message.seq === kept.seq)).toMatchObject({ body: null, deletedBy: 'support' });
    expect((await owner.admin.showEvidence({ accountId: ownerId, reportId })).items.find(item => item.seq === kept.seq)).toMatchObject({ deletedBy: 'support', body: 'please stop' });
    expect(f.chat.thread(f.alice, f.cara).messages.every(message => message.deletedBy === null)).toBe(true);

    // Every owner action is audited, and the history line counts from the audit log.
    await owner.admin.pauseChat({ accountId: ownerId, userId: f.bob, days: 7, reason: 'Harassment' });
    expect(await owner.admin.chatPauses()).toEqual([expect.objectContaining({ userId: f.bob, displayName: 'Bob', reason: 'Harassment', until: expect.any(String) })]);
    await owner.admin.liftChatPause({ accountId: ownerId, userId: f.bob });
    expect(await owner.admin.chatPauses()).toEqual([]);
    await expect(owner.admin.pauseChat({ accountId: ownerId, userId: randomUUID(), days: null, reason: 'Nobody' })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Member not found.' });
    expect([f.auditCount('reports.view'), f.auditCount('chat.redact'), f.auditCount('chat.pause'), f.auditCount('chat.resume')]).toEqual([2, 1, 1, 1]);
    f.community.report(f.cara, { userId: f.bob, reason: 'Bob was mean to Alice' });
    await owner.admin.removeMember({ userId: f.bob, schoolId: f.school.id, reason: 'Harassment' });
    f.service.join(f.bob, { schoolId: f.other.id, choice: 'community' });
    f.community.report(f.outsider, { userId: f.bob, reason: 'Same thing here again' });
    await owner.admin.pauseChat({ accountId: ownerId, userId: f.bob, days: null, reason: 'Again' });
    f.community.report(f.outsider, { userId: f.cara, reason: 'Unrelated report here' });
    f.db.prepare('INSERT INTO reports(id,reporter_id,reported_id,school_id,reason,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), f.cara, f.bob, null, 'Seeded open report', new Date().toISOString());
    const bobRow = (await owner.admin.reports()).find(report => report.reportedId === f.bob)!;
    expect(bobRow).toMatchObject({ isChat: false, history: { reports: 4, removals: 1, pauses: 2 }, pause: { until: null } });
  });
});

describe('11. pause', () => {
  it('stops sending only, is visible to the student, and expires by time', () => {
    const f = fixture();
    f.befriend(f.alice, f.bob); f.befriend(f.bob, f.cara);
    f.send(f.alice, f.bob, 'hi bob');
    f.send(f.bob, f.alice, 'hi alice');
    f.chat.report(f.alice, f.bob, { category: 'bullying', block: false });
    f.chat.pauseChat(f.owner, { userId: f.bob, days: 7, reason: 'Harassment' });
    expect(f.db.prepare('SELECT outcome FROM reports WHERE reported_id=?').all(f.bob)).toEqual([{ outcome: 'paused' }]);
    fails(() => f.chat.send(f.bob, f.alice, randomUUID(), 'still here'), 'FORBIDDEN', 'Support paused your messaging.');
    const until = new Date(f.clock.now.getTime() + 7 * DAY).toISOString();
    expect(f.chat.inbox(f.bob).pause).toEqual({ until });
    expect(f.chat.thread(f.bob, f.alice).pause).toEqual({ until });
    expect(f.chat.mute(f.bob, f.alice, true)).toMatchObject({ muted: true });
    expect(f.chat.report(f.bob, f.alice, { category: 'other', block: false })).toEqual({ blocked: false });
    f.community.block(f.bob, f.cara, true);
    expect(f.send(f.alice, f.bob, 'friends can still write').body).toBe('friends can still write');
    f.tick(7 * DAY + 1000);
    expect(f.chat.inbox(f.bob).pause).toBeNull();
    expect(f.send(f.bob, f.alice, 'back').body).toBe('back');

    f.chat.pauseChat(f.owner, { userId: f.bob, days: null, reason: 'Again' });
    f.tick(100 * DAY);
    expect(f.chat.thread(f.bob, f.alice).pause).toEqual({ until: null });
    fails(() => f.chat.send(f.bob, f.alice, randomUUID(), 'no'), 'FORBIDDEN', 'Support paused your messaging.');
    f.chat.liftChatPause(f.owner, f.bob);
    expect(f.send(f.bob, f.alice, 'lifted').body).toBe('lifted');
  });
});

describe('12. account binding', () => {
  it('rejects a call made for another account', async () => {
    const f = fixture();
    f.befriend(f.alice, f.bob);
    f.send(f.bob, f.alice, 'hello');
    f.chat.report(f.alice, f.bob, { category: 'other', block: false });
    const reportId = (f.db.prepare('SELECT id FROM reports').get() as { id: string }).id;
    await expect(f.caller(f.alice).chat.send({ accountId: f.bob, userId: f.bob, clientId: randomUUID(), body: 'hi' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(f.caller(f.alice).chat.inbox({ accountId: f.bob })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(f.caller(null).chat.inbox({ accountId: f.alice })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(f.caller(f.owner).admin.showEvidence({ accountId: f.alice, reportId })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(f.auditCount('reports.view')).toBe(0);
    expect((await f.caller(f.alice).chat.inbox({ accountId: f.alice })).unreadChats).toBe(1);
  });
});

describe('13. retention', () => {
  it('prunes old messages, erased text, old evidence, idle threads and chat delivery rows', () => {
    const f = fixture();
    f.befriend(f.alice, f.bob); f.befriend(f.alice, f.cara);
    const now = new Date(f.clock.now.getTime() + 200 * DAY);
    const at = (daysAgo: number) => { f.clock.now = new Date(now.getTime() - daysAgo * DAY); };
    at(181); const old = f.send(f.alice, f.bob, 'ancient');
    at(181); f.send(f.alice, f.cara, 'idle thread');
    at(40); const erased = randomUUID(); f.send(f.alice, f.bob, 'delete me', erased);
    at(31); f.chat.delete(f.alice, f.bob, erased);
    at(35); const recent = randomUUID(); f.send(f.alice, f.bob, 'delete me later', recent);
    at(29); f.chat.delete(f.alice, f.bob, recent);
    at(1); f.send(f.bob, f.alice, 'fresh');
    f.chat.report(f.alice, f.bob, { category: 'other', block: false });
    f.db.prepare('UPDATE reports SET resolved_at=?, outcome=? WHERE reporter_id=?').run(new Date(now.getTime() - 181 * DAY).toISOString(), 'dismissed', f.alice);
    f.db.prepare('INSERT INTO push_subscriptions(id,owner_id,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?,?)').run('sub', f.alice, 'https://fcm.googleapis.com/x', 'p', 'a', now.toISOString());
    const delivery = f.db.prepare('INSERT INTO notification_deliveries(owner_id,entity_id,subscription_id,reminder_at,status,updated_at) VALUES(?,?,?,?,?,?)');
    delivery.run(f.alice, 'chat:messages', 'sub', 'w1', 'sent', new Date(now.getTime() - 3 * DAY).toISOString());
    delivery.run(f.alice, 'chat:messages', 'sub', 'w2', 'sent', new Date(now.getTime() - DAY).toISOString());
    delivery.run(f.alice, 'task-1', 'sub', 'r1', 'sent', new Date(now.getTime() - 3 * DAY).toISOString());
    const caraThread = (f.db.prepare('SELECT t.id FROM chat_threads t JOIN chat_members m ON m.thread_id=t.id WHERE m.user_id=?').all(f.cara) as { id: string }[])[0]!.id;

    pruneChat(f.db, now);
    expect(f.db.prepare('SELECT 1 FROM chat_messages WHERE seq=?').get(old.seq)).toBeUndefined();
    const bodies = Object.fromEntries((f.db.prepare('SELECT id, body FROM chat_messages').all() as { id: string; body: string }[]).map(row => [row.id, row.body]));
    expect(bodies[erased]).toBe('');
    expect(bodies[recent]).toBe('delete me later');
    expect(f.db.prepare('SELECT evidence FROM reports').get()).toEqual({ evidence: null });
    expect(f.db.prepare('SELECT 1 FROM chat_threads WHERE id=?').get(caraThread)).toBeUndefined();
    expect(f.db.prepare('SELECT count(*) n FROM chat_members WHERE thread_id=?').get(caraThread)).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT reminder_at FROM notification_deliveries ORDER BY reminder_at').all()).toEqual([{ reminder_at: 'r1' }, { reminder_at: 'w2' }]);
  });
});

describe('14. reserved names', () => {
  it('rejects new names that mention Quasar or support, and keeps stored ones', async () => {
    const f = fixture();
    const alice = f.caller(f.alice);
    // Cyrillic and Greek lookalikes, digit swaps, accents, spaced-out letters and joined reserved words are caught too.
    for (const displayName of ['Quasar Support', 's.u.p.p.o.r.t', 'Admin Team', 'Quasar-Official', 'ＳＴＡＦＦ',
      '\u0405u\u0440\u0440ort', 'Qu\u0430sar', '\u0405taff', 'Supp0rt', 'Suppórt', 'S u p p o r t', 'QuasarSupport', 'Admin!']) {
      await expect(alice.profile.save({ accountId: f.alice, displayName, fullName: 'Alice Fullname' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Choose a display name that doesn’t mention Quasar or support.' });
    }
    for (const displayName of ['Stafford', 'Badminton Bob', 'Staff0rd', 'Jo 5', 'Zoë 👨\u200D👩\u200D👧']) expect((await alice.profile.save({ accountId: f.alice, displayName, fullName: 'Alice Fullname' })).displayName).toBe(displayName);
    // Bidi overrides and zero-width characters are removed, so a name cannot read backwards or render blank.
    expect((await alice.profile.save({ accountId: f.alice, displayName: '\u202Etroppus', fullName: 'Alice\u200B Fullname\u00AD' }))).toMatchObject({ displayName: 'troppus', fullName: 'Alice Fullname' });
    for (const displayName of ['\u200B', '\u200B\u202E\u2060', '...']) {
      await expect(alice.profile.save({ accountId: f.alice, displayName, fullName: 'Alice Fullname' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    await expect(alice.profile.save({ accountId: f.alice, displayName: 'Alice', fullName: '\u200B\u200B' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    f.db.prepare('UPDATE users SET display_name=? WHERE id=?').run('Support', f.bob);
    expect((await f.caller(f.bob).profile.save({ accountId: f.bob, displayName: 'Support', fullName: 'Bob New Fullname' })).fullName).toBe('Bob New Fullname');
  });
});

describe('15. migration', () => {
  it('can open the same file twice and adds the chat columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quasar-chat-'));
    try {
      const path = join(dir, 'test.sqlite');
      openDatabase(path).close();
      const db = openDatabase(path); databases.push(db);
      expect(db.prepare('SELECT version FROM schema_migrations WHERE version=6').get()).toEqual({ version: 6 });
      const columns = (table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map(column => column.name);
      expect(columns('reports')).toEqual(expect.arrayContaining(['thread_id', 'evidence', 'category']));
      expect(columns('users')).toContain('chat_push');
      for (const table of ['chat_threads', 'chat_members', 'chat_messages', 'chat_pauses']) expect(columns(table).length).toBeGreaterThan(0);
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
