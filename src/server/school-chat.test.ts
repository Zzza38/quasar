import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRPCError } from '@trpc/server';
import webpush from 'web-push';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { GlobalChatService, SchoolChatService, countUnreadSchool, pruneGlobalChat, NOT_IN_SCHOOL } from './global-chat';
import { countUnreadChats } from './chat';
import { CommunityService } from './community';
import { NotificationService } from './notifications';
import { appRouter } from './router';
import { EMPTY_BETA_REGISTRY, createBeta, writeBetaRegistry } from './beta-registry';
import { SCHOOL_CHAT_BETA } from '@/domain/betas';
import { exampleSchedule } from '@/domain/example';

const DAY = 86_400_000;
const databases: Db[] = [];
let directory = '';
let previousPath: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'quasar-school-chat-'));
  previousPath = process.env.BETAS_PATH;
  process.env.BETAS_PATH = join(directory, 'betas.json');
  writeBetaRegistry(createBeta(EMPTY_BETA_REGISTRY, { key: SCHOOL_CHAT_BETA, name: 'School chat', description: '', code: 'SCHOOL-2026' }));
});
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  if (previousPath === undefined) delete process.env.BETAS_PATH; else process.env.BETAS_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const clock = { now: new Date('2026-09-15T16:00:00Z') };
  const tick = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  function user(email = `${randomUUID()}@example.com`, name = 'Student', beta = true) {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, name, `${name} Fullname`, new Date(0).toISOString());
    if (beta) db.prepare('INSERT INTO beta_members(beta_key,user_id,joined_at) VALUES(?,?,?)').run(SCHOOL_CHAT_BETA, id, clock.now.toISOString());
    return id;
  }
  const owner = user('owner@example.com', 'Owner');
  const alice = user(undefined, 'Alice'), bob = user(undefined, 'Bob'), outsider = user(undefined, 'Olive'), noBeta = user(undefined, 'Nina', false), homeless = user(undefined, 'Hal');
  const school = service.createSchool(alice, { name: 'Community High', location: 'Boston, MA', schedule: exampleSchedule });
  const other = service.createSchool(outsider, { name: 'Other Prep', location: 'Austin, TX', schedule: exampleSchedule });
  for (const id of [alice, owner, bob, noBeta]) service.join(id, { schoolId: school.id, choice: 'community', grade: '11' });
  service.join(outsider, { schoolId: other.id, choice: 'community', grade: '11' });
  const rooms = new SchoolChatService(service, () => clock.now);
  const global = new GlobalChatService(service, () => clock.now);
  const caller = (id: string | null) => appRouter.createCaller({ service, userId: id });
  const send = (from: string, body = 'hello', schoolId = school.id, clientId = randomUUID()) => { tick(4000); return rooms.send(from, schoolId, clientId, body).message; };
  return { db, service, user, owner, alice, bob, outsider, noBeta, homeless, school, other, rooms, global, caller, clock, tick, send };
}

function fails(fn: () => unknown, code: TRPCError['code'], message?: string) {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(TRPCError);
  expect((error as TRPCError).code).toBe(code);
  if (message !== undefined) expect((error as TRPCError).message).toBe(message);
}

describe('school chat', () => {
  it('is open to the school’s members in the beta, and to nobody else', () => {
    const f = fixture();
    f.send(f.alice, 'hi school');
    const seen = f.rooms.thread(f.bob, f.school.id);
    expect(seen.messages.map(m => [m.sender.displayName, m.body])).toEqual([['Alice', 'hi school']]);
    // Everyone at the school with names counts, in the beta or not.
    expect(seen.room).toEqual({ members: 4, canModerate: false });
    expect(seen.school).toEqual({ id: f.school.id, name: 'Community High' });
    // Another school's member, someone without a school, and a member outside the beta all get the same answer,
    // and so does asking for another school by id.
    fails(() => f.rooms.thread(f.outsider, f.school.id), 'NOT_FOUND', NOT_IN_SCHOOL);
    fails(() => f.rooms.thread(f.homeless, f.school.id), 'NOT_FOUND', NOT_IN_SCHOOL);
    fails(() => f.rooms.thread(f.noBeta, f.school.id), 'NOT_FOUND', NOT_IN_SCHOOL);
    fails(() => f.rooms.thread(f.alice, f.other.id), 'NOT_FOUND', NOT_IN_SCHOOL);
    fails(() => f.rooms.send(f.outsider, f.school.id, randomUUID(), 'let me in'), 'NOT_FOUND', NOT_IN_SCHOOL);
    expect(f.rooms.summary(f.noBeta)).toBeNull();
    expect(f.rooms.summary(f.homeless)).toBeNull();
    expect(f.rooms.summary(f.bob)).toMatchObject({ schoolId: f.school.id, schoolName: 'Community High', unread: 1, lastMessage: { senderName: 'Alice', preview: 'hi school' } });
  });

  it('keeps each school’s room and the global room apart', () => {
    const f = fixture();
    f.send(f.alice, 'community only');
    f.send(f.outsider, 'other only', f.other.id);
    f.tick(4000); f.global.send(f.bob, randomUUID(), 'to everyone');
    expect(f.rooms.thread(f.alice, f.school.id).messages.map(m => m.body)).toEqual(['community only']);
    expect(f.rooms.thread(f.outsider, f.other.id).messages.map(m => m.body)).toEqual(['other only']);
    expect(f.global.thread(f.alice).messages.map(m => m.body)).toEqual(['to everyone']);
    // Revisions are per room, so another school's traffic never shows up in this room's polls.
    const { revision } = f.rooms.thread(f.alice, f.school.id);
    f.send(f.outsider, 'more other', f.other.id);
    expect(f.rooms.thread(f.alice, f.school.id, { after: revision }).messages).toEqual([]);
  });

  it('lets the owner remove and edit with a reason, audited with the school', () => {
    const f = fixture();
    const message = f.send(f.alice, 'call me 555 0100');
    fails(() => f.rooms.delete(f.bob, f.school.id, message.id), 'FORBIDDEN');
    fails(() => f.rooms.edit(f.bob, f.school.id, message.id, 'nope'), 'FORBIDDEN');
    expect(f.rooms.thread(f.owner, f.school.id).room.canModerate).toBe(true);
    expect(f.rooms.edit(f.owner, f.school.id, message.id, 'call me', 'phone number').message).toMatchObject({ body: 'call me', reason: 'phone number' });
    expect(f.rooms.delete(f.owner, f.school.id, message.id, 'still personal').message).toMatchObject({ body: null, deletedBy: 'owner', reason: 'still personal' });
    const audits = f.db.prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'schoolChat.%' ORDER BY id").all() as { action: string; detail: string }[];
    expect(audits.map(row => [row.action, JSON.parse(row.detail).schoolId])).toEqual([['schoolChat.edit', f.school.id], ['schoolChat.delete', f.school.id]]);
    // A sender deletes their own; a message from another school's room is not found from this one.
    const mine = f.send(f.bob, 'oops');
    expect(f.rooms.delete(f.bob, f.school.id, mine.id).message.deletedBy).toBe('sender');
    const elsewhere = f.send(f.outsider, 'over here', f.other.id);
    fails(() => f.rooms.delete(f.owner, f.school.id, elsewhere.id), 'NOT_FOUND');
  });

  it('counts toward the badge only inside the beta, respects mute and marks read', () => {
    const f = fixture();
    f.send(f.alice, 'one');
    const last = f.send(f.alice, 'two');
    expect(countUnreadSchool(f.db, f.bob)).toBe(2);
    expect(countUnreadChats(f.db, f.bob)).toBe(1);
    expect(countUnreadSchool(f.db, f.noBeta)).toBe(0);
    expect(countUnreadChats(f.db, f.noBeta)).toBe(0);
    expect(f.rooms.mute(f.bob, f.school.id, true)).toMatchObject({ muted: true, unreadChats: 0 });
    expect(f.rooms.mute(f.bob, f.school.id, false)).toMatchObject({ muted: false, unreadChats: 1 });
    expect(f.rooms.read(f.bob, f.school.id, last.seq)).toMatchObject({ unreadSchool: 0, unreadChats: 0 });
    // The sender's own messages are read already.
    expect(countUnreadSchool(f.db, f.alice)).toBe(0);
  });

  it('follows the member’s current school, and a new school’s backlog arrives read', () => {
    const f = fixture();
    f.send(f.outsider, 'old news at other', f.other.id);
    f.send(f.alice, 'community news');
    f.service.join(f.bob, { schoolId: f.other.id, choice: 'community', grade: '11' });
    fails(() => f.rooms.thread(f.bob, f.school.id), 'NOT_FOUND', NOT_IN_SCHOOL);
    expect(f.rooms.summary(f.bob)).toMatchObject({ schoolId: f.other.id, unread: 0 });
    expect(f.rooms.thread(f.bob, f.other.id).messages.map(m => m.body)).toEqual(['old news at other']);
    f.send(f.outsider, 'welcome bob', f.other.id);
    expect(countUnreadSchool(f.db, f.bob)).toBe(1);
  });

  it('hides messages from members the viewer blocked, one way, and resets older polls', () => {
    const f = fixture();
    f.send(f.bob, 'from bob');
    f.send(f.owner, 'welcome');
    const { revision } = f.rooms.thread(f.alice, f.school.id);
    new CommunityService(f.service).block(f.alice, f.bob, true);
    f.send(f.bob, 'bob again');
    expect(f.rooms.thread(f.alice, f.school.id).messages.map(m => m.body)).toEqual(['welcome']);
    expect(f.rooms.thread(f.alice, f.school.id, { after: revision })).toMatchObject({ reset: true });
    expect(countUnreadSchool(f.db, f.alice)).toBe(1);
    expect(f.rooms.thread(f.bob, f.school.id).messages.map(m => m.body)).toEqual(['from bob', 'welcome', 'bob again']);
  });

  it('quotes and reacts within the room only', () => {
    const f = fixture();
    const target = f.send(f.alice, 'quote me');
    f.tick(4000);
    const reply = f.rooms.send(f.bob, f.school.id, randomUUID(), 'quoted', target.seq).message;
    expect(reply.replyTo).toMatchObject({ seq: target.seq, senderName: 'Alice', preview: 'quote me' });
    const elsewhere = f.send(f.outsider, 'not yours', f.other.id);
    fails(() => f.rooms.send(f.bob, f.school.id, randomUUID(), 'sneaky', elsewhere.seq), 'BAD_REQUEST');
    expect(f.rooms.react(f.bob, f.school.id, target.seq, '❤️').message.reactions).toEqual([{ emoji: '❤️', count: 1, mine: true }]);
    fails(() => f.rooms.react(f.bob, f.school.id, elsewhere.seq, '❤️'), 'NOT_FOUND');
  });

  it('shares the send budget with the global room and refuses reused IDs', () => {
    const f = fixture();
    for (let index = 0; index < 10; index += 1) f.global.send(f.alice, randomUUID(), `global ${index}`);
    for (let index = 0; index < 10; index += 1) f.rooms.send(f.alice, f.school.id, randomUUID(), `school ${index}`);
    fails(() => f.rooms.send(f.alice, f.school.id, randomUUID(), 'one more'), 'TOO_MANY_REQUESTS');
    f.tick(61_000);
    const id = randomUUID();
    const first = f.rooms.send(f.alice, f.school.id, id, 'once').message;
    expect(f.rooms.send(f.alice, f.school.id, id, 'once').message.seq).toBe(first.seq);
    fails(() => f.rooms.send(f.bob, f.school.id, id, 'once'), 'BAD_REQUEST');
  });

  it('prunes old messages and deleted text', () => {
    const f = fixture();
    const old = f.send(f.alice, 'ancient');
    const gone = f.send(f.alice, 'deleted');
    f.rooms.delete(f.alice, f.school.id, gone.id);
    f.db.prepare('UPDATE school_messages SET created_at=? WHERE seq=?').run(new Date(f.clock.now.getTime() - 181 * DAY).toISOString(), old.seq);
    f.db.prepare('UPDATE school_messages SET deleted_at=? WHERE seq=?').run(new Date(f.clock.now.getTime() - 31 * DAY).toISOString(), gone.seq);
    pruneGlobalChat(f.db, f.clock.now);
    expect(f.db.prepare('SELECT seq, body FROM school_messages').all()).toEqual([{ seq: gone.seq, body: '' }]);
  });

  it('is account-scoped through the router, and the inbox carries the school row', async () => {
    const f = fixture();
    await expect(f.caller(f.alice).schoolChat.send({ accountId: f.bob, schoolId: f.school.id, clientId: randomUUID(), body: 'hi' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const sent = await f.caller(f.alice).schoolChat.send({ accountId: f.alice, schoolId: f.school.id, clientId: randomUUID(), body: 'hi' });
    expect(sent.message.sender.displayName).toBe('Alice');
    expect((await f.caller(f.bob).chat.inbox({ accountId: f.bob })).school).toMatchObject({ schoolId: f.school.id, unread: 1 });
    expect((await f.caller(f.noBeta).chat.inbox({ accountId: f.noBeta })).school).toBeNull();
    await expect(f.caller(f.bob).schoolChat.edit({ accountId: f.bob, schoolId: f.school.id, messageId: sent.message.id, body: 'x', reason: '' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('school chat pushes', () => {
  const vapid = { ...webpush.generateVAPIDKeys(), subject: 'mailto:owner@example.com' };
  const subscription = (token: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${token}`, keys: { p256dh: vapid.publicKey, auth: Buffer.alloc(16, 1).toString('base64url') } });

  it('pushes members in the beta once, and nobody outside it', async () => {
    const f = fixture();
    const sendPush = vi.fn().mockResolvedValue({});
    const notifications = new NotificationService(f.db, { vapid, sendPush, now: () => f.clock.now });
    notifications.subscribe(f.bob, subscription('bob'));
    notifications.subscribe(f.noBeta, subscription('nina'));
    const message = f.send(f.alice, 'see you at lunch');
    f.tick(61_000);
    expect(await notifications.deliverChat(f.clock.now)).toEqual({ sent: 1, failed: 0 });
    expect(sendPush.mock.calls[0]![0].endpoint).toBe(subscription('bob').endpoint);
    expect(f.db.prepare('SELECT notified_seq FROM school_members WHERE school_id=? AND user_id=?').get(f.school.id, f.bob)).toEqual({ notified_seq: message.seq });
    f.tick(11 * 60_000);
    expect(await notifications.deliverChat(f.clock.now)).toEqual({ sent: 0, failed: 0 });
  });
});
