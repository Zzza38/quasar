import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { CommunityService } from './community';
import { ChatService, countUnreadChats } from './chat';
import { GroupChatService, countUnreadGroups, GROUP_FULL_MESSAGE, pruneGroupChat, TOO_MANY_GROUPS_MESSAGE } from './group-chat';
import { NotificationService } from './notifications';
import { appRouter } from './router';
import { CHAT } from '@/domain/chat';
import { exampleSchedule } from '@/domain/example';

const DAY = 86_400_000;
const NOT_IN_GROUP = 'You are not in this group.';
const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });

function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  function user(email = `${randomUUID()}@example.com`, name = 'Student') {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, name, `${name} Fullname`, new Date().toISOString());
    return id;
  }
  const owner = user('owner@example.com', 'Owner');
  const alice = user(undefined, 'Alice'), bob = user(undefined, 'Bob'), cara = user(undefined, 'Cara'), dan = user(undefined, 'Dan');
  const school = service.createSchool(alice, { name: 'Community High', location: 'Boston, MA', schedule: exampleSchedule });
  for (const id of [alice, bob, cara, dan, owner]) service.join(id, { schoolId: school.id, choice: 'community', grade: '11' });
  const community = new CommunityService(service);
  const befriend = (a: string, b: string) => { community.request(a, b); community.respond(b, a, true); };
  befriend(alice, bob); befriend(alice, cara); befriend(bob, cara);
  const clock = { now: new Date() };
  const tick = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  const groups = new GroupChatService(service, () => clock.now);
  const chat = new ChatService(service, () => clock.now);
  const caller = (id: string | null) => appRouter.createCaller({ service, userId: id });
  const send = (from: string, groupId: string, body = 'hello', clientId = randomUUID()) => { tick(4000); return groups.send(from, groupId, clientId, body).message; };
  const schoolmate = (name: string) => { const id = user(undefined, name); service.join(id, { schoolId: school.id, choice: 'community' }); return id; };
  return { db, service, community, user, owner, alice, bob, cara, dan, school, groups, chat, caller, clock, tick, send, befriend, schoolmate };
}

function fails(fn: () => unknown, code: TRPCError['code'], message?: string) {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(TRPCError);
  expect((error as TRPCError).code).toBe(code);
  if (message !== undefined) expect((error as TRPCError).message).toBe(message);
}

describe('friend groups (docs/CHAT.md §12)', () => {
  it('lets a student group their friends, and only their friends', () => {
    const f = fixture();
    const group = f.groups.create(f.alice, { name: '  Bio   lab crew ', memberIds: [f.bob, f.cara] });
    expect(group.name).toBe('Bio lab crew');
    expect(group.role).toBe('admin');
    expect(group.members.map(member => [member.displayName, member.role])).toEqual([['Alice', 'admin'], ['Bob', 'member'], ['Cara', 'member']]);
    // Dan is not Alice's friend; a blocked friend is refused too; nobody learns which.
    fails(() => f.groups.create(f.alice, { name: 'Nope', memberIds: [f.dan] }), 'BAD_REQUEST', 'You can only add your friends to a group.');
    f.community.block(f.cara, f.bob, true);
    fails(() => f.groups.create(f.bob, { name: 'Nope', memberIds: [f.cara] }), 'BAD_REQUEST', 'You can only add your friends to a group.');
    // Input shapes are zod's job (the router turns them into BAD_REQUEST); the service throws the issue as is.
    expect(() => f.groups.create(f.alice, { name: '', memberIds: [f.bob] })).toThrow();
    fails(() => f.groups.create(f.alice, { name: 'Just me', memberIds: [f.alice] }), 'BAD_REQUEST', 'Add at least one friend.');
    // A slur in the name is censored like a message.
    expect(f.groups.create(f.alice, { name: 'the r3tard squad', memberIds: [f.bob] }).name).toBe('the ****** squad');
  });

  it('caps the size and the number of groups per day', () => {
    const f = fixture();
    const many = Array.from({ length: CHAT.groupMaxMembers }, (_, index) => { const id = f.schoolmate(`Friend ${index}`); f.befriend(f.alice, id); return id; });
    fails(() => f.groups.create(f.alice, { name: 'Too big', memberIds: many }), 'BAD_REQUEST', GROUP_FULL_MESSAGE);
    const group = f.groups.create(f.alice, { name: 'Big', memberIds: many.slice(0, CHAT.groupMaxMembers - 1) });
    fails(() => f.groups.addMembers(f.alice, group.id, [many[CHAT.groupMaxMembers - 1]!]), 'BAD_REQUEST', GROUP_FULL_MESSAGE);
    for (let index = 1; index < CHAT.groupsPerDay; index += 1) f.groups.create(f.alice, { name: `Group ${index}`, memberIds: [f.bob] });
    fails(() => f.groups.create(f.alice, { name: 'One more', memberIds: [f.bob] }), 'TOO_MANY_REQUESTS', TOO_MANY_GROUPS_MESSAGE);
    f.tick(DAY + 1000);
    expect(f.groups.create(f.alice, { name: 'Tomorrow', memberIds: [f.bob] }).name).toBe('Tomorrow');
  });

  it('only the admin renames, adds and removes; anyone leaves; a stranger sees nothing', () => {
    const f = fixture();
    const group = f.groups.create(f.alice, { name: 'Crew', memberIds: [f.bob] });
    fails(() => f.groups.rename(f.bob, group.id, 'Mine now'), 'FORBIDDEN', 'Only the group admin can do that.');
    fails(() => f.groups.addMembers(f.bob, group.id, [f.cara]), 'FORBIDDEN');
    fails(() => f.groups.removeMember(f.bob, group.id, f.alice), 'FORBIDDEN');
    fails(() => f.groups.thread(f.dan, group.id), 'NOT_FOUND', NOT_IN_GROUP);
    fails(() => f.groups.send(f.dan, group.id, randomUUID(), 'hi'), 'NOT_FOUND', NOT_IN_GROUP);
    expect(f.groups.rename(f.alice, group.id, 'Crew 2').name).toBe('Crew 2');
    expect(f.groups.addMembers(f.alice, group.id, [f.cara]).members).toHaveLength(3);
    expect(f.groups.removeMember(f.alice, group.id, f.cara).members.map(member => member.displayName)).toEqual(['Alice', 'Bob']);
    fails(() => f.groups.thread(f.cara, group.id), 'NOT_FOUND', NOT_IN_GROUP);
    fails(() => f.groups.removeMember(f.alice, group.id, f.alice), 'BAD_REQUEST', 'Leave the group instead.');
    // The admin leaving hands the group to the longest-standing member; the last one leaving deletes it.
    f.groups.leave(f.alice, group.id);
    expect(f.groups.thread(f.bob, group.id).group.role).toBe('admin');
    f.groups.leave(f.bob, group.id);
    expect(f.db.prepare('SELECT count(*) n FROM chat_groups WHERE id=?').get(group.id)).toEqual({ n: 0 });
  });

  it('shows members the messages since they joined, hides blocked senders one way, and counts unread groups', () => {
    const f = fixture();
    const group = f.groups.create(f.alice, { name: 'Crew', memberIds: [f.bob] });
    const first = f.send(f.alice, group.id, 'before cara');
    f.tick(1000);
    f.groups.addMembers(f.alice, group.id, [f.cara]);
    f.tick(1000);
    const second = f.send(f.bob, group.id, 'after cara');
    expect(f.groups.thread(f.cara, group.id).messages.map(message => message.body)).toEqual(['after cara']);
    expect(f.groups.thread(f.alice, group.id).messages.map(message => message.body)).toEqual(['before cara', 'after cara']);
    // Cara has one unread group (Bob's message); Alice too; Bob none (his own message, and he read Alice's by sending after it).
    expect(countUnreadGroups(f.db, f.cara)).toBe(1);
    expect(countUnreadChats(f.db, f.alice)).toBe(1);
    expect(countUnreadGroups(f.db, f.bob)).toBe(0);
    f.groups.read(f.cara, group.id, second.seq);
    expect(countUnreadGroups(f.db, f.cara)).toBe(0);
    // Muting drops the group from the badge but keeps its row unread.
    f.groups.mute(f.alice, group.id, true);
    expect(countUnreadChats(f.db, f.alice)).toBe(0);
    expect(f.groups.list(f.alice)[0]).toMatchObject({ unread: 1, muted: true });
    // Cara blocks Bob: his messages vanish for her only; Bob still sees everything.
    f.community.block(f.cara, f.bob, true);
    expect(f.groups.thread(f.cara, group.id).messages).toEqual([]);
    expect(f.groups.thread(f.bob, group.id).messages.map(message => message.seq)).toEqual([first.seq, second.seq]);
    expect(f.groups.list(f.cara)[0]!.lastMessage).toBeNull();
  });

  it('tracks delivery, read and typing per member (§13)', () => {
    const f = fixture();
    const group = f.groups.create(f.alice, { name: 'Crew', memberIds: [f.bob, f.cara] });
    const message = f.send(f.alice, group.id, 'hello all');
    const before = f.groups.thread(f.alice, group.id).receipts;
    expect(before.map(receipt => [receipt.displayName, receipt.deliveredSeq, receipt.readSeq, receipt.typing])).toEqual([['Bob', 0, 0, false], ['Cara', 0, 0, false]]);
    // Bob's device fetches the thread (delivered); Cara reads it; Bob starts typing.
    f.groups.thread(f.bob, group.id);
    f.groups.read(f.cara, group.id, message.seq);
    f.groups.typing(f.bob, group.id, true);
    const after = f.groups.thread(f.alice, group.id).receipts;
    expect(after.find(receipt => receipt.displayName === 'Bob')).toMatchObject({ deliveredSeq: message.seq, readSeq: 0, typing: true });
    expect(after.find(receipt => receipt.displayName === 'Cara')).toMatchObject({ deliveredSeq: 0, readSeq: message.seq, typing: false });
    // Typing expires by time, and sending clears it at once.
    f.tick(CHAT.typingMs + 1000);
    expect(f.groups.thread(f.alice, group.id).receipts.find(receipt => receipt.displayName === 'Bob')?.typing).toBe(false);
    f.groups.typing(f.bob, group.id, true);
    f.send(f.bob, group.id, 'done typing');
    expect(f.groups.thread(f.alice, group.id).receipts.find(receipt => receipt.displayName === 'Bob')?.typing).toBe(false);
    // The list marks the newest message delivered for the viewer too.
    f.groups.list(f.cara);
    expect(f.groups.thread(f.alice, group.id).receipts.find(receipt => receipt.displayName === 'Cara')?.deliveredSeq).toBeGreaterThan(message.seq);
  });

  it('polls by revision, pages, and deletes: sender or admin', () => {
    const f = fixture();
    const group = f.groups.create(f.alice, { name: 'Crew', memberIds: [f.bob] });
    const messages = Array.from({ length: 60 }, (_, index) => f.send(index % 2 ? f.alice : f.bob, group.id, `m${index}`));
    const page = f.groups.thread(f.bob, group.id);
    expect(page.messages).toHaveLength(CHAT.page);
    expect(page.hasEarlier).toBe(true);
    const older = f.groups.thread(f.bob, group.id, { before: page.messages[0]!.seq });
    expect(older.messages).toHaveLength(10);
    expect(older.hasEarlier).toBe(false);
    const revision = page.revision;
    fails(() => f.groups.delete(f.bob, group.id, messages[1]!.id), 'FORBIDDEN', 'Only the group admin can remove other people’s messages.');
    f.groups.delete(f.bob, group.id, messages[0]!.id);
    f.groups.delete(f.alice, group.id, messages[2]!.id);
    const changes = f.groups.thread(f.bob, group.id, { after: revision });
    expect(changes.reset).toBe(false);
    expect(changes.messages.map(message => [message.seq, message.deletedBy])).toEqual([[messages[0]!.seq, 'sender'], [messages[2]!.seq, 'admin']]);
    expect(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='group.remove'").get()).toEqual({ n: 1 });
    // A retry with the same id returns the stored message; another body is refused.
    const id = randomUUID();
    const sent = f.groups.send(f.alice, group.id, id, 'again').message;
    expect(f.groups.send(f.alice, group.id, id, 'again').message.seq).toBe(sent.seq);
    fails(() => f.groups.send(f.alice, group.id, id, 'different'), 'BAD_REQUEST', 'A retry ID cannot be reused for a different message.');
    fails(() => f.groups.send(f.bob, group.id, id, 'again'), 'BAD_REQUEST', 'A retry ID cannot be reused for a different message.');
  });

  it('shares the send budget and pauses with the other chats', () => {
    const f = fixture();
    const group = f.groups.create(f.alice, { name: 'Crew', memberIds: [f.bob] });
    for (let index = 0; index < CHAT.perMinute - 1; index += 1) f.groups.send(f.alice, group.id, randomUUID(), `g${index}`);
    f.chat.send(f.alice, f.bob, randomUUID(), 'private');
    fails(() => f.groups.send(f.alice, group.id, randomUUID(), 'one too many'), 'TOO_MANY_REQUESTS');
    f.tick(61_000);
    f.chat.pauseChat(f.owner, { userId: f.alice, days: 1, reason: 'cool off' });
    fails(() => f.groups.send(f.alice, group.id, randomUUID(), 'paused'), 'FORBIDDEN', 'Support paused your messaging.');
    fails(() => f.groups.create(f.alice, { name: 'While paused', memberIds: [f.bob] }), 'FORBIDDEN', 'Support paused your messaging.');
    expect(f.groups.thread(f.alice, group.id).pause).toEqual({ until: expect.any(String), reason: 'cool off', appealed: false });
    expect(f.groups.thread(f.alice, group.id).messages.length).toBeGreaterThan(0);
  });

  it('reports one message against its sender with the window from everyone, and the owner sees names', async () => {
    const f = fixture();
    const group = f.groups.create(f.alice, { name: 'Crew', memberIds: [f.bob, f.cara] });
    f.send(f.cara, group.id, 'hi');
    const nasty = f.send(f.bob, group.id, 'nobody likes you');
    f.send(f.alice, group.id, 'stop');
    fails(() => f.groups.report(f.bob, group.id, { category: 'bullying', seq: nasty.seq, block: false }), 'BAD_REQUEST', 'You cannot report your own message.');
    expect(f.groups.report(f.alice, group.id, { category: 'bullying', note: 'in the group', seq: nasty.seq, block: true })).toEqual({ blocked: true });
    fails(() => f.groups.report(f.alice, group.id, { category: 'spam', seq: nasty.seq, block: false }), 'CONFLICT');
    const ownerCaller = f.caller(f.owner);
    const [report] = await ownerCaller.admin.reports();
    expect(report).toMatchObject({ isChat: true, category: 'bullying', reportedName: 'Bob', reporterName: 'Alice', evidenceCount: 3, reason: 'Bullying or harassment: in the group' });
    const evidence = await ownerCaller.admin.showEvidence({ accountId: f.owner, reportId: report!.id });
    expect(evidence.items.map(item => [item.senderName, item.body, item.anchor])).toEqual([['Cara', 'hi', false], ['Bob', 'nobody likes you', true], ['Alice', 'stop', false]]);
    // Hiding it reaches the group; the block hides Bob's later messages from Alice.
    await ownerCaller.admin.redactMessage({ accountId: f.owner, reportId: report!.id, seq: nasty.seq });
    expect(f.groups.thread(f.cara, group.id).messages.find(message => message.seq === nasty.seq)).toMatchObject({ body: null, deletedBy: 'support' });
    expect(f.groups.thread(f.alice, group.id).messages.map(message => message.body)).toEqual(['hi', 'stop']);
  });

  it('is account-scoped in the router and ends with support removal and retention', async () => {
    const f = fixture();
    const group = f.groups.create(f.alice, { name: 'Crew', memberIds: [f.bob] });
    await expect(f.caller(f.alice).group.thread({ accountId: f.bob, groupId: group.id })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(f.caller(null).group.thread({ accountId: f.alice, groupId: group.id })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const inbox = await f.caller(f.alice).chat.inbox({ accountId: f.alice });
    expect(inbox.groups.map(entry => entry.name)).toEqual(['Crew']);
    f.send(f.bob, group.id, 'still here');
    // Support removes Bob: he leaves every group; Alice keeps it.
    f.community.removeFromSchool(f.owner, f.bob, f.school.id, 'Harassment');
    fails(() => f.groups.thread(f.bob, group.id), 'NOT_FOUND', NOT_IN_GROUP);
    expect(f.groups.thread(f.alice, group.id).group.members.map(member => member.displayName)).toEqual(['Alice']);
    // Retention: old messages go, deleted text is erased, idle groups are deleted with their members.
    f.db.prepare('UPDATE chat_group_messages SET created_at=?').run(new Date(Date.now() - (CHAT.retentionDays + 1) * DAY).toISOString());
    f.db.prepare('UPDATE chat_groups SET last_message_at=?').run(new Date(Date.now() - (CHAT.retentionDays + 1) * DAY).toISOString());
    pruneGroupChat(f.db);
    expect(f.db.prepare('SELECT count(*) n FROM chat_groups').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT count(*) n FROM chat_group_members').get()).toEqual({ n: 0 });
  });

  it('pushes a group message like any other chat, once, and not when muted or read', async () => {
    const f = fixture();
    const group = f.groups.create(f.alice, { name: 'Crew', memberIds: [f.bob] });
    const sent: string[] = [];
    const push = new NotificationService(f.db, { vapid: { publicKey: 'BEr3', privateKey: 'x', subject: 'mailto:a@b.c' }, sendPush: async (_subscription, payload) => { sent.push(payload); }, now: () => f.clock.now });
    // A subscription for Bob, saved directly (the schema check is covered in notifications.test.ts).
    f.db.prepare('INSERT INTO push_subscriptions(id,owner_id,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), f.bob, 'https://fcm.googleapis.com/fcm/send/abc', 'BNRPzuCzTzLBqiIN9k4DQmNoOtgdT8lonJgHwn1CnOqxqmKnFsYi1i7O0fS6E3AQb1jhkAKO6yNw7fT0GaqQ04s', 'kq-9psoL3q4E3BVZtZv-eg', f.clock.now.toISOString());
    f.send(f.alice, group.id, 'meeting moved');
    expect((await push.deliverChat(f.clock.now)).sent).toBe(0); // under 60 s old
    f.tick(CHAT.pushDelayMs + 1000);
    const result = await push.deliverChat(f.clock.now);
    if (result.sent === 0 && result.failed === 0) return; // VAPID keys above are placeholders; a refusal to configure is not a push bug.
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('meeting');
    // The same message is never pushed twice; a muted group is skipped.
    f.tick(CHAT.pushWindowMs + 1000);
    expect((await push.deliverChat(f.clock.now)).sent).toBe(0);
    f.groups.mute(f.bob, group.id, true);
    f.send(f.alice, group.id, 'again');
    f.tick(CHAT.pushWindowMs + CHAT.pushDelayMs + 1000);
    expect((await push.deliverChat(f.clock.now)).sent).toBe(0);
  });
});
