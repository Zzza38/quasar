import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { CommunityService } from './community';
import { ChatService } from './chat';
import { GroupChatService } from './group-chat';
import { GlobalChatService } from './global-chat';
import { exampleSchedule } from '@/domain/example';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(kind: 'peer' | 'group' | 'global') {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const user = (name: string) => {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, id, `${name.toLowerCase()}@example.com`, name, `${name} Student`, new Date().toISOString());
    return id;
  };
  const alice = user('Alice'), bob = user('Bob'), cara = user('Cara'), owner = user('Owner');
  const school = service.createSchool(alice, { name: 'Community High', location: 'Boston, MA', schedule: exampleSchedule });
  for (const id of [alice, bob, cara]) service.join(id, { schoolId: school.id, choice: 'community' });
  const community = new CommunityService(service);
  for (const id of [bob, cara]) { community.request(alice, id); community.respond(id, alice, true); }
  let now = Date.now();
  const clock = () => new Date(now);
  const peer = new ChatService(service, clock), groups = new GroupChatService(service, clock), room = new GlobalChatService(service, clock);
  const group = groups.create(alice, { name: 'Crew', memberIds: [bob] });
  const other = (viewer: string) => viewer === alice ? bob : alice;
  const send = (viewer: string, body: string, replyTo?: number, id: string = randomUUID()) => {
    now += 1000;
    return (kind === 'peer' ? peer.send(viewer, other(viewer), id, body, replyTo)
      : kind === 'group' ? groups.send(viewer, group.id, id, body, replyTo) : room.send(viewer, id, body, replyTo)).message;
  };
  const thread = (viewer: string, cursor: { after?: number; before?: number } = {}) => kind === 'peer' ? peer.thread(viewer, other(viewer), cursor)
    : kind === 'group' ? groups.thread(viewer, group.id, cursor) : room.thread(viewer, cursor);
  const react = (viewer: string, seq: number) => (kind === 'peer' ? peer.react(viewer, other(viewer), seq, '👍')
    : kind === 'group' ? groups.react(viewer, group.id, seq, '👍') : room.react(viewer, seq, '👍')).message;
  const remove = (viewer: string, id: string) => kind === 'peer' ? peer.delete(viewer, other(viewer), id)
    : kind === 'group' ? groups.delete(viewer, group.id, id) : room.delete(viewer, id);
  return { db, service, alice, bob, cara, owner, community, peer, groups, room, group, send, thread, react, remove,
    tick: () => { now += 1000; }, table: kind === 'peer' ? 'chat_messages' : kind === 'group' ? 'chat_group_messages' : 'global_messages' };
}

it.each(['peer', 'group', 'global'] as const)('%s returns the stored per-message revision on every read and mutation, including deletion retries', kind => {
  const f = fixture(kind);
  const sent = f.send(f.alice, 'original');
  expect(sent.revision).toBeTypeOf('number');
  const initial = f.thread(f.alice);
  f.send(f.bob, 'newer row');
  expect(f.thread(f.alice).messages.find(m => m.seq === sent.seq)?.revision).toBe(sent.revision);
  expect(f.thread(f.alice, { before: sent.seq + 1 }).messages[0]?.revision).toBe(sent.revision);
  const reacted = f.react(f.bob, sent.seq);
  expect(reacted.revision).toBeGreaterThan(sent.revision);
  expect(f.thread(f.alice, { after: initial.revision }).messages.find(m => m.seq === sent.seq)?.revision).toBe(reacted.revision);
  expect(f.send(f.alice, 'original', undefined, sent.id).revision).toBe(reacted.revision);
  if (kind === 'global') {
    const edited = f.room.edit(f.owner, sent.id, 'edited').message;
    expect(edited.revision).toBeGreaterThan(reacted.revision);
    expect(f.thread(f.alice).messages.find(m => m.seq === sent.seq)?.revision).toBe(edited.revision);
  }
  const beforeDelete = f.thread(f.alice).revision;
  const removed = f.remove(f.alice, sent.id);
  expect(removed.message).toMatchObject({ seq: sent.seq, body: null, revision: expect.any(Number) });
  expect(removed.message.revision).toBeGreaterThan(beforeDelete);
  expect(f.remove(f.alice, sent.id).message).toEqual(removed.message);
  expect(f.thread(f.alice, { after: beforeDelete }).messages.find(m => m.seq === sent.seq)).toEqual(removed.message);
  expect(f.db.prepare(`SELECT revision FROM ${f.table} WHERE seq=?`).get(sent.seq)).toEqual({ revision: removed.message.revision });
});

it.each(['peer', 'group', 'global'] as const)('%s removes quote identity and ownership for deleted and retained-out targets', kind => {
  const f = fixture(kind);
  const target = f.send(f.alice, 'private target');
  const quote = f.send(f.bob, 'quote', target.seq);
  expect(f.thread(f.alice).messages.find(m => m.seq === quote.seq)?.replyTo?.fromMe).toBe(true);
  f.remove(f.alice, target.id);
  const unavailable = { seq: target.seq, senderName: '', fromMe: false, preview: null };
  for (const viewer of [f.alice, f.bob]) expect(f.thread(viewer).messages.find(m => m.seq === quote.seq)?.replyTo).toEqual(unavailable);
  expect(f.react(f.alice, quote.seq).replyTo).toEqual(unavailable);
  expect(f.send(f.bob, 'quote', target.seq, quote.id).replyTo).toEqual(unavailable);
  f.db.prepare(`DELETE FROM ${f.table} WHERE seq=?`).run(target.seq);
  expect(f.thread(f.alice).messages.find(m => m.seq === quote.seq)?.replyTo).toEqual(unavailable);
});

it('removes a former member identity from a quote visible to a newly added group member', () => {
  const f = fixture('group');
  const target = f.send(f.bob, 'before Cara joined');
  f.groups.leave(f.bob, f.group.id);
  f.tick();
  f.groups.addMembers(f.alice, f.group.id, [f.cara]);
  const quote = f.send(f.alice, 'after Cara joined', target.seq);
  expect(f.thread(f.cara).messages.find(m => m.seq === quote.seq)?.replyTo)
    .toEqual({ seq: target.seq, senderName: '', fromMe: false, preview: null });
});

it.each(['group', 'global'] as const)('%s replaces every tab window after viewer block and unblock, without changing other viewers visibility', kind => {
  const f = fixture(kind);
  const target = f.send(f.bob, 'blocked text');
  const quote = f.send(f.alice, 'a reply', target.seq);
  const before = f.thread(f.alice);
  const otherBefore = f.thread(f.bob);
  f.community.block(f.alice, f.bob, true);
  const page = f.thread(f.alice, { after: before.revision });
  expect(page.reset).toBe(true);
  expect(page.messages.some(m => m.seq === target.seq)).toBe(false);
  expect(page.messages.find(m => m.seq === quote.seq)?.replyTo)
    .toEqual({ seq: target.seq, preview: null, senderName: '', fromMe: false });
  expect(page.messages.find(m => m.seq === quote.seq)!.revision).toBeGreaterThan(quote.revision);
  // A second tab with the same old cursor must also reset. A poll cannot consume the threshold.
  expect(f.thread(f.alice, { after: before.revision })).toEqual(page);
  const freshService = kind === 'global' ? new GlobalChatService(f.service) : new GroupChatService(f.service);
  const freshPage = freshService instanceof GlobalChatService ? freshService.thread(f.alice, { after: before.revision })
    : freshService.thread(f.alice, f.group.id, { after: before.revision });
  expect(freshPage.reset).toBe(true);
  expect(f.thread(f.alice, { after: page.revision })).toMatchObject({ reset: false, messages: [] });
  const other = f.thread(f.bob, { after: otherBefore.revision });
  expect(other.reset).toBe(false);
  expect(other.messages.find(m => m.seq === quote.seq)?.replyTo?.preview).toBe('blocked text');
  f.community.block(f.alice, f.bob, true);
  expect(f.thread(f.alice, { after: page.revision })).toMatchObject({ reset: false, messages: [] });
  f.community.block(f.alice, f.bob, false);
  const restored = f.thread(f.alice, { after: page.revision });
  expect(restored.reset).toBe(true);
  expect(restored.messages.some(m => m.seq === target.seq)).toBe(true);
  expect(restored.messages.find(m => m.seq === quote.seq)?.replyTo?.preview).toBe('blocked text');
  expect(f.thread(f.alice, { after: restored.revision })).toMatchObject({ reset: false, messages: [] });
});

it.each(['peer', 'group'] as const)('%s removes quote identity after support hides the target', kind => {
  const f = fixture(kind);
  const target = f.send(f.alice, 'reported target');
  const quote = f.send(f.bob, 'quote', target.seq);
  const before = f.thread(f.alice).revision;
  if (kind === 'peer') f.peer.report(f.bob, f.alice, { category: 'bullying', seq: target.seq, block: false });
  else f.groups.report(f.bob, f.group.id, { category: 'bullying', seq: target.seq, block: false });
  const report = f.db.prepare('SELECT id FROM reports WHERE reported_id=?').get(f.alice) as { id: string };
  f.peer.redactMessage(f.owner, report.id, target.seq);
  expect(f.thread(f.alice, { after: before }).messages.find(m => m.seq === quote.seq)?.replyTo)
    .toEqual({ seq: target.seq, senderName: '', fromMe: false, preview: null });
});
