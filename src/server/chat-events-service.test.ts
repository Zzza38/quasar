import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { CommunityService } from './community';
import { ChatService } from './chat';
import { GroupChatService } from './group-chat';
import { GlobalChatService } from './global-chat';
import * as events from './chat-events';
import { exampleSchedule } from '@/domain/example';

const databases: Db[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const user = (name: string) => {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, id, `${name}@example.com`, name, `${name} Student`, new Date().toISOString());
    return id;
  };
  const alice = user('alice'), bob = user('bob'), cara = user('cara'), owner = user('owner');
  const school = service.createSchool(alice, { name: 'Community High', location: 'Boston, MA', schedule: exampleSchedule });
  for (const id of [alice, bob, cara]) service.join(id, { schoolId: school.id, choice: 'community' });
  const community = new CommunityService(service);
  for (const id of [bob, cara]) { community.request(alice, id); community.respond(id, alice, true); }
  const chat = new ChatService(service), groups = new GroupChatService(service), room = new GlobalChatService(service);
  const group = groups.create(alice, { name: 'Crew', memberIds: [bob, cara] });
  const peerMessage = chat.send(alice, bob, randomUUID(), 'private peer text').message;
  const groupMessage = groups.send(alice, group.id, randomUUID(), 'private group text').message;
  const globalMessage = room.send(alice, randomUUID(), 'private global text').message;
  const notify = vi.spyOn(events, 'notifyChat').mockImplementation(() => {
    expect(db.inTransaction).toBe(false);
  });
  return { db, alice, bob, cara, owner, chat, groups, room, group, peerMessage, groupMessage, globalMessage, notify };
}

it.each(['send', 'delete', 'react', 'typing', 'read'] as const)('peer %s wakes the other member with the actor as key, after commit', method => {
  const f = fixture();
  let actor = f.alice, recipient = f.bob;
  if (method === 'send') f.chat.send(actor, recipient, randomUUID(), 'another private text');
  if (method === 'delete') f.chat.delete(actor, recipient, f.peerMessage.id);
  if (method === 'react') f.chat.react(actor, recipient, f.peerMessage.seq, '👍');
  if (method === 'typing') f.chat.typing(actor, recipient, true);
  if (method === 'read') { actor = f.bob; recipient = f.alice; f.chat.read(actor, recipient, f.peerMessage.seq); }
  expect(f.notify).toHaveBeenCalledExactlyOnceWith([recipient], { kind: 'peer', key: actor });
});

it.each(['send', 'delete', 'react', 'typing', 'read'] as const)('group %s wakes current members after commit, excluding the reader for receipts', method => {
  const f = fixture();
  f.groups.leave(f.cara, f.group.id);
  if (method === 'send') f.groups.send(f.alice, f.group.id, randomUUID(), 'another private text');
  if (method === 'delete') f.groups.delete(f.alice, f.group.id, f.groupMessage.id);
  if (method === 'react') f.groups.react(f.alice, f.group.id, f.groupMessage.seq, '👍');
  if (method === 'typing') f.groups.typing(f.alice, f.group.id, true);
  if (method === 'read') f.groups.read(f.bob, f.group.id, f.groupMessage.seq);
  expect(f.notify).toHaveBeenCalledTimes(1);
  const [ids, event] = f.notify.mock.calls[0];
  expect(ids.sort()).toEqual((method === 'read' ? [f.alice] : [f.alice, f.bob]).sort());
  expect(event).toEqual({ kind: 'group', key: f.group.id });
});

it.each(['send', 'delete', 'edit', 'react'] as const)('global %s broadcasts after commit with no text', method => {
  const f = fixture();
  if (method === 'send') f.room.send(f.alice, randomUUID(), 'another private text');
  if (method === 'delete') f.room.delete(f.alice, f.globalMessage.id);
  if (method === 'edit') f.room.edit(f.owner, f.globalMessage.id, 'replacement private text', 'a reason');
  if (method === 'react') f.room.react(f.bob, f.globalMessage.seq, '👍');
  expect(f.notify).toHaveBeenCalledExactlyOnceWith([], { kind: 'global', key: 'global' });
});

it('keeps mute, unchanged receipts and global read changes silent', () => {
  const f = fixture();
  f.chat.mute(f.alice, f.bob, true);
  f.groups.mute(f.alice, f.group.id, true);
  f.room.mute(f.alice, true);
  f.room.read(f.bob, f.globalMessage.seq);
  f.chat.read(f.alice, f.bob, f.peerMessage.seq);
  f.groups.read(f.alice, f.group.id, f.groupMessage.seq);
  expect(f.notify).not.toHaveBeenCalled();
  f.chat.read(f.bob, f.alice, f.peerMessage.seq);
  f.groups.read(f.bob, f.group.id, f.groupMessage.seq);
  f.notify.mockClear();
  f.chat.read(f.bob, f.alice, f.peerMessage.seq);
  f.groups.read(f.bob, f.group.id, f.groupMessage.seq);
  expect(f.notify).not.toHaveBeenCalled();
});

it('does not notify for rejected mutations', () => {
  const f = fixture();
  expect(() => f.chat.delete(f.bob, f.alice, f.peerMessage.id)).toThrow();
  expect(() => f.groups.delete(f.bob, f.group.id, f.groupMessage.id)).toThrow();
  expect(() => f.room.edit(f.bob, f.globalMessage.id, 'unauthorized')).toThrow();
  expect(f.notify).not.toHaveBeenCalled();
});

it.each(['peer', 'group'] as const)('support redaction wakes both sides of a %s conversation after commit', kind => {
  const f = fixture();
  const message = kind === 'peer' ? f.peerMessage : f.groupMessage;
  if (kind === 'peer') f.chat.report(f.bob, f.alice, { category: 'bullying', seq: message.seq, block: false });
  else f.groups.report(f.bob, f.group.id, { category: 'bullying', seq: message.seq, block: false });
  const report = f.db.prepare('SELECT id FROM reports WHERE reported_id=?').get(f.alice) as { id: string };
  f.chat.redactMessage(f.owner, report.id, message.seq);
  if (kind === 'peer') {
    expect(f.notify).toHaveBeenCalledTimes(2);
    expect(f.notify).toHaveBeenCalledWith([f.alice], { kind: 'peer', key: f.bob });
    expect(f.notify).toHaveBeenCalledWith([f.bob], { kind: 'peer', key: f.alice });
  } else {
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.notify.mock.calls[0][0].sort()).toEqual([f.alice, f.bob, f.cara].sort());
    expect(f.notify.mock.calls[0][1]).toEqual({ kind: 'group', key: f.group.id });
  }
});
