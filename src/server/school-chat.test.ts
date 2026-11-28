import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import webpush from 'web-push';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { GlobalChatService, SchoolChatService, countUnreadSchool, pruneGlobalChat, NOT_IN_SCHOOL } from './global-chat';
import { readChatImage } from './chat-images';
import { GroupChatService } from './group-chat';
import { ChatService, countUnreadChats } from './chat';
import { CommunityService } from './community';
import { NotificationService } from './notifications';
import { appRouter } from './router';
import { exampleSchedule } from '@/domain/example';
import { grantStaffRole } from './staff';

const DAY = 86_400_000;
const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });

function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const clock = { now: new Date('2026-09-15T16:00:00Z') };
  const tick = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  function user(email = `${randomUUID()}@example.com`, name = 'Student') {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, name, `${name} Fullname`, new Date(0).toISOString());
    return id;
  }
  const owner = user('owner@example.com', 'Owner');
  const alice = user(undefined, 'Alice'), bob = user(undefined, 'Bob'), outsider = user(undefined, 'Olive'), nina = user(undefined, 'Nina'), homeless = user(undefined, 'Hal');
  const school = service.createSchool(alice, { name: 'Community High', location: 'Boston, MA', schedule: exampleSchedule });
  const other = service.createSchool(outsider, { name: 'Other Prep', location: 'Austin, TX', schedule: exampleSchedule });
  for (const id of [alice, owner, bob, nina]) service.join(id, { schoolId: school.id, choice: 'community', grade: '11' });
  service.join(outsider, { schoolId: other.id, choice: 'community', grade: '11' });
  const rooms = new SchoolChatService(service, () => clock.now);
  const global = new GlobalChatService(service, () => clock.now);
  const caller = (id: string | null) => appRouter.createCaller({ service, userId: id });
  const send = (from: string, body = 'hello', schoolId = school.id, clientId = randomUUID()) => { tick(4000); return rooms.send(from, schoolId, clientId, body).message; };
  return { db, service, user, owner, alice, bob, outsider, nina, homeless, school, other, rooms, global, caller, clock, tick, send };
}

function fails(fn: () => unknown, code: TRPCError['code'], message?: string) {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(TRPCError);
  expect((error as TRPCError).code).toBe(code);
  if (message !== undefined) expect((error as TRPCError).message).toBe(message);
}

describe('school chat', () => {
  it('is open to the school’s members, and to nobody else', () => {
    const f = fixture();
    f.send(f.alice, 'hi school');
    const seen = f.rooms.thread(f.bob, f.school.id);
    expect(seen.messages.map(m => [m.sender.displayName, m.body])).toEqual([['Alice', 'hi school']]);
    // Everyone at the school with names counts.
    expect(seen.room).toEqual({ members: 4, canModerate: false, moderator: null });
    expect(seen.school).toEqual({ id: f.school.id, name: 'Community High' });
    // Another school's member and someone without a school get the same answer,
    // and so does asking for another school by id.
    fails(() => f.rooms.thread(f.outsider, f.school.id), 'NOT_FOUND', NOT_IN_SCHOOL);
    fails(() => f.rooms.thread(f.homeless, f.school.id), 'NOT_FOUND', NOT_IN_SCHOOL);
    expect(f.rooms.thread(f.nina, f.school.id).messages.map(m => m.body)).toEqual(['hi school']);
    fails(() => f.rooms.thread(f.alice, f.other.id), 'NOT_FOUND', NOT_IN_SCHOOL);
    fails(() => f.rooms.send(f.outsider, f.school.id, randomUUID(), 'let me in'), 'NOT_FOUND', NOT_IN_SCHOOL);
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
    const audits = f.db.prepare("SELECT action, school_id, detail FROM audit_log WHERE action LIKE 'schoolChat.%' ORDER BY id").all() as { action: string; school_id: string; detail: string }[];
    expect(audits.map(row => row.school_id)).toEqual([f.school.id, f.school.id]);
    expect(audits.map(row => [row.action, JSON.parse(row.detail).schoolId])).toEqual([['schoolChat.edit', f.school.id], ['schoolChat.delete', f.school.id]]);
    // A sender deletes their own; a message from another school's room is not found from this one.
    const mine = f.send(f.bob, 'oops');
    expect(f.rooms.delete(f.bob, f.school.id, mine.id).message.deletedBy).toBe('sender');
    const elsewhere = f.send(f.outsider, 'over here', f.other.id);
    fails(() => f.rooms.delete(f.owner, f.school.id, elsewhere.id), 'NOT_FOUND');
  });

  it('lets a staff moderator at the school moderate it, recording their rank, and keeps the owner’s uncensored text', () => {
    const f = fixture();
    const mod = f.user('mod@example.com', 'Mod');
    f.service.join(mod, { schoolId: f.school.id, choice: 'community', grade: '11' });
    grantStaffRole(f.service, 'mod@example.com', 'moderator');
    expect(f.rooms.thread(mod, f.school.id).room).toMatchObject({ canModerate: true, moderator: 'moderator' });
    const message = f.send(f.alice, 'you f4ggot');
    expect(message.body).toBe('you ******');
    expect(f.rooms.thread(f.owner, f.school.id).messages[0]!.original).toBe('you f4ggot');
    expect(f.rooms.thread(f.bob, f.school.id).messages[0]!.original).toBeNull();
    expect(f.rooms.delete(mod, f.school.id, message.id, 'slur').message).toMatchObject({ deletedBy: 'owner', moderatedBy: 'moderator', reason: 'slur' });
    expect(f.rooms.summary(f.bob)!.lastMessage).toMatchObject({ preview: null, moderatedBy: 'moderator' });
  });

  describe('delegated room moderation', () => {

    it.each(['school-manager', 'chat-moderation'] as const)('lets a school-scoped %s moderate and read removed messages only in the assigned room', async role => {
      const f = fixture();
      const manager = f.nina;
      const schoolMessage = f.send(f.alice, 'local post');
      fails(() => f.rooms.delete(manager, f.school.id, schoolMessage.id), 'FORBIDDEN');
      grantStaffRole(f.service, manager, role, undefined, 'school');
      expect(f.rooms.thread(manager, f.school.id).room).toMatchObject({ canModerate: true, moderator: role });
      await f.caller(manager).schoolChat.edit({ accountId: manager, schoolId: f.school.id, messageId: schoolMessage.id, body: 'local', reason: 'Personal information' });
      const removed = f.rooms.delete(manager, f.school.id, schoolMessage.id, 'Spam').message;
      expect(removed).toMatchObject({ moderatedBy: role, removed: { body: 'local' } });

      f.tick(4000);
      const globalPost = f.global.send(f.bob, randomUUID(), 'global post').message;
      fails(() => f.global.delete(manager, globalPost.id), 'FORBIDDEN');
      f.global.delete(f.bob, globalPost.id);
      expect(f.global.thread(manager).messages[0]!.removed).toBeNull();

      f.service.join(manager, { schoolId: f.other.id, choice: 'community', grade: '11' });
      const elsewhere = f.send(f.outsider, 'other school', f.other.id);
      fails(() => f.rooms.delete(manager, f.other.id, elsewhere.id), 'FORBIDDEN');
      fails(() => f.rooms.thread(manager, f.school.id), 'NOT_FOUND');
    });

    it('ends platform powers as soon as a chat moderator is reassigned to a school', async () => {
      const f = fixture();
      const moderator = f.nina;
      grantStaffRole(f.service, moderator, 'chat-moderation');
      const community = new CommunityService(f.service);
      community.request(f.alice, moderator);
      community.respond(moderator, f.alice, true);
      community.request(f.alice, f.bob);
      community.respond(f.bob, f.alice, true);
      const chat = new ChatService(f.service);
      const direct = chat.send(f.alice, moderator, randomUUID(), 'withdrawn direct message').message;
      chat.delete(f.alice, moderator, direct.id);
      const groups = new GroupChatService(f.service);
      const group = groups.create(f.alice, { name: 'Biology', memberIds: [moderator, f.bob] });
      const post = groups.send(f.bob, group.id, randomUUID(), 'group post').message;
      groups.report(f.alice, group.id, { seq: post.seq, category: 'bullying', block: false });
      const [report] = community.reports(moderator);
      groups.delete(f.bob, group.id, post.id);
      expect(chat.thread(moderator, f.alice).messages[0]!.removed?.body).toBe('withdrawn direct message');
      expect(groups.thread(moderator, group.id).messages[0]!.removed?.body).toBe('group post');
      const global = f.global.send(f.bob, randomUUID(), 'photo', undefined, 'YQ==').message;
      f.global.delete(f.bob, global.id);
      expect(readChatImage(f.service, moderator, 'global', global.seq)).toEqual(Buffer.from('a'));

      grantStaffRole(f.service, moderator, 'chat-moderation', undefined, 'school');
      const caller = appRouter.createCaller({ service: f.service, userId: moderator, authAt: Date.now() });
      const denied = { code: 'FORBIDDEN' };
      expect(chat.thread(moderator, f.alice).messages[0]!.removed).toBeNull();
      expect(groups.thread(moderator, group.id).messages[0]!.removed).toBeNull();
      expect(readChatImage(f.service, moderator, 'global', global.seq)).toBeNull();
      expect(f.global.thread(moderator).room.canModerate).toBe(false);
      await expect(caller.global.edit({ accountId: moderator, messageId: global.id, body: 'new', reason: '' })).rejects.toMatchObject(denied);
      await expect(caller.group.delete({ accountId: moderator, groupId: group.id, messageId: post.id })).rejects.toMatchObject(denied);
      await expect(caller.admin.reports()).rejects.toMatchObject(denied);
      await expect(caller.admin.showEvidence({ accountId: moderator, reportId: report!.id })).rejects.toMatchObject(denied);
      await expect(caller.admin.redactMessage({ accountId: moderator, reportId: report!.id, seq: post.seq })).rejects.toMatchObject(denied);
      await expect(caller.admin.pauseChat({ accountId: moderator, userId: f.bob, days: 1, reason: 'Pause' })).rejects.toMatchObject(denied);
      await expect(caller.admin.liftChatPause({ accountId: moderator, userId: f.bob })).rejects.toMatchObject(denied);
      await expect(caller.admin.chatPauses()).rejects.toMatchObject(denied);
    });

    it('separates chat cases and local profile reports, including actions taken by case ID', () => {
      const f = fixture();
      const manager = f.nina;
      const chatMod = f.user('chat-mod@example.com', 'Chat Mod');
      grantStaffRole(f.service, manager, 'school-manager');
      grantStaffRole(f.service, chatMod, 'chat-moderation');
      const post = f.global.send(f.alice, randomUUID(), 'spam').message;
      expect(f.global.delete(chatMod, post.id, 'Spam').message).toMatchObject({ moderatedBy: 'chat-moderation', removed: { body: 'spam' } });
      expect(f.global.thread(manager).messages[0]!.removed).toBeNull();
      const community = new CommunityService(f.service);
      community.report(f.alice, { userId: f.bob, reason: 'A problem with their profile' });
      community.request(f.alice, f.bob);
      community.respond(f.bob, f.alice, true);
      const chat = new ChatService(f.service);
      const direct = chat.send(f.bob, f.alice, randomUUID(), 'spam message').message;
      chat.report(f.alice, f.bob, { category: 'bullying', seq: direct.seq, block: false });

      const profileReport = community.reports(manager);
      const chatReport = community.reports(chatMod);
      expect(profileReport.map(row => row.isChat)).toEqual([false]);
      expect(chatReport.map(row => row.isChat)).toEqual([true]);
      const profileId = profileReport[0]!.id, chatId = chatReport[0]!.id;
      fails(() => community.resolveReport(chatMod, profileId, 'dismissed'), 'FORBIDDEN');
      fails(() => community.resolveReport(manager, chatId, 'dismissed'), 'FORBIDDEN');
      fails(() => chat.showEvidence(manager, chatId), 'FORBIDDEN');
      fails(() => chat.redactMessage(manager, chatId, direct.seq), 'FORBIDDEN');
      expect(chat.showEvidence(chatMod, chatId).items[0]!.body).toBe('spam message');
      chat.redactMessage(chatMod, chatId, direct.seq);
      chat.pauseChat(chatMod, { userId: f.bob, days: 1, reason: 'Repeated spam' });
      expect(community.reports(chatMod)).toEqual([]);
      expect(community.reports(manager)).toMatchObject([{ id: profileId, pause: null }]);
      f.service.join(f.alice, { schoolId: f.other.id, choice: 'community', grade: '11' });
      expect(community.reports(manager)).toEqual([]);
      fails(() => community.resolveReport(manager, profileId, 'dismissed'), 'FORBIDDEN');
    });
  });

  it('counts toward the badge for the school’s members, respects mute and marks read', () => {
    const f = fixture();
    f.send(f.alice, 'one');
    const last = f.send(f.alice, 'two');
    expect(countUnreadSchool(f.db, f.bob)).toBe(2);
    expect(countUnreadChats(f.db, f.bob)).toBe(1);
    expect(countUnreadSchool(f.db, f.nina)).toBe(2);
    expect(countUnreadSchool(f.db, f.outsider)).toBe(0);
    expect(countUnreadChats(f.db, f.outsider)).toBe(0);
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
    expect((await f.caller(f.homeless).chat.inbox({ accountId: f.homeless })).school).toBeNull();
    await expect(f.caller(f.bob).schoolChat.edit({ accountId: f.bob, schoolId: f.school.id, messageId: sent.message.id, body: 'x', reason: '' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('school chat pushes', () => {
  const vapid = { ...webpush.generateVAPIDKeys(), subject: 'mailto:owner@example.com' };
  const subscription = (token: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${token}`, keys: { p256dh: vapid.publicKey, auth: Buffer.alloc(16, 1).toString('base64url') } });

  it('pushes the school’s members once, and nobody at another school', async () => {
    const f = fixture();
    const sendPush = vi.fn().mockResolvedValue({});
    const notifications = new NotificationService(f.db, { vapid, sendPush, now: () => f.clock.now });
    notifications.subscribe(f.bob, subscription('bob'));
    notifications.subscribe(f.outsider, subscription('olive'));
    const message = f.send(f.alice, 'see you at lunch');
    f.tick(61_000);
    expect(await notifications.deliverChat(f.clock.now)).toEqual({ sent: 1, failed: 0 });
    expect(sendPush.mock.calls[0]![0].endpoint).toBe(subscription('bob').endpoint);
    expect(f.db.prepare('SELECT notified_seq FROM school_members WHERE school_id=? AND user_id=?').get(f.school.id, f.bob)).toEqual({ notified_seq: message.seq });
    f.tick(11 * 60_000);
    expect(await notifications.deliverChat(f.clock.now)).toEqual({ sent: 0, failed: 0 });
  });
});
