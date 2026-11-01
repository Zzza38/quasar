import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { CommunityService } from './community';
import { ChatService, pruneChat } from './chat';
import { GlobalChatService, pruneGlobalChat } from './global-chat';
import { GroupChatService } from './group-chat';
import { readChatImage } from './chat-images';
import { SupportService } from './support';
import { grantStaffRole } from './staff';
import { censorBody, censorBodyMasks, revealableText } from '@/domain/chat';
import { canSeeEdited, canSeeRemoved } from '@/domain/staff';
import { exampleSchedule } from '@/domain/example';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const DAY = 86_400_000;

function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com', '');
  function user(email: string, name: string) {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, `sub-${id}`, email, name, `${name} Fullname`, new Date().toISOString());
    return id;
  }
  const owner = user('owner@example.com', 'Owner');
  const admin = user('admin@example.com', 'Admin');
  const moderator = user('mod@example.com', 'Mod');
  const helper = user('helper@example.com', 'Helper');
  const alice = user('alice@example.com', 'Alice'), bob = user('bob@example.com', 'Bob');
  grantStaffRole(service, 'admin@example.com', 'administrator');
  grantStaffRole(service, 'mod@example.com', 'moderator');
  grantStaffRole(service, 'helper@example.com', 'support');
  const school = service.createSchool(alice, { name: 'Community High', location: 'Boston, MA', schedule: exampleSchedule });
  for (const id of [alice, bob, admin, moderator, helper, owner]) service.join(id, { schoolId: school.id, choice: 'community', grade: '10' });
  const community = new CommunityService(service);
  const befriend = (a: string, b: string) => { community.request(a, b); community.respond(b, a, true); };
  const room = new GlobalChatService(service);
  const seen = (viewer: string, id: string) => room.thread(viewer).messages.find(message => message.id === id)!;
  return { db, service, owner, admin, moderator, helper, alice, bob, befriend, room, seen };
}

describe('censor masks', () => {
  it('censors exactly as censorBody does and says what each run of asterisks hid', () => {
    for (const text of ['you f4ggot', 'n**igg**er then', 'hey ni\ngga dude', 'see https://en.wikipedia.org/wiki/Coon_Rapids and f4ggot', 'no slurs here, damn']) {
      expect(censorBodyMasks(text).body).toBe(censorBody(text));
    }
    expect(censorBodyMasks('you f4ggot and n**igg**er')).toEqual({ body: 'you ****** and ******', masks: [{ at: 4, stars: 6, original: 'f4ggot' }, { at: 15, stars: 6, original: 'n**igg**er' }] });
    expect(censorBodyMasks('hey ni\ngga dude').masks).toEqual([{ at: 4, stars: 5, original: 'ni\ngga' }]);
    // The markers stand where the asterisks were, so markdown around them still parses.
    expect(revealableText('**you** f4ggot')).toEqual({ text: '**you** 0', masks: [{ at: 8, stars: 6, original: 'f4ggot' }] });
  });

  it('ranks removals and edits: higher tiers read lower ones, members read only member edits', () => {
    expect(canSeeRemoved('moderator', null)).toBe(true);
    expect(canSeeRemoved('moderator', 'moderator')).toBe(true);
    expect(canSeeRemoved('moderator', 'administrator')).toBe(false);
    expect(canSeeRemoved('administrator', 'owner')).toBe(false);
    expect(canSeeRemoved('owner', 'owner')).toBe(true);
    expect(canSeeRemoved(null, null)).toBe(false);
    expect(canSeeRemoved('support', null)).toBe(false);
    expect(canSeeEdited(null, null)).toBe(true);
    expect(canSeeEdited('support', 'moderator')).toBe(false);
    expect(canSeeEdited('moderator', 'moderator')).toBe(true);
  });
});

describe('what each tier reads', () => {
  it('stores the text as sent, sends members only the censored body, and gives the owner the original', () => {
    const f = fixture();
    const sent = f.room.send(f.alice, randomUUID(), 'you f4ggot').message;
    expect(f.db.prepare('SELECT body, original FROM global_messages WHERE id=?').get(sent.id)).toEqual({ body: 'you ******', original: 'you f4ggot' });
    for (const viewer of [f.alice, f.bob, f.moderator, f.admin, f.helper]) expect(f.seen(viewer, sent.id)).toMatchObject({ body: 'you ******', original: null });
    expect(f.seen(f.owner, sent.id)).toMatchObject({ body: 'you ******', original: 'you f4ggot' });
    // Clean text keeps no copy.
    const clean = f.room.send(f.alice, randomUUID(), 'hello').message;
    expect(f.db.prepare('SELECT original FROM global_messages WHERE id=?').get(clean.id)).toEqual({ original: null });
    expect(f.seen(f.owner, clean.id).original).toBeNull();
  });

  it('shows removed Global messages to moderators and up when the remover is at their tier or below', () => {
    const f = fixture();
    const byAuthor = f.room.send(f.alice, randomUUID(), 'oops wrong chat').message;
    const byMod = f.room.send(f.alice, randomUUID(), 'spam one').message;
    const byAdmin = f.room.send(f.bob, randomUUID(), 'spam two').message;
    const byOwner = f.room.send(f.bob, randomUUID(), 'spam three f4ggot').message;
    f.room.delete(f.alice, byAuthor.id);
    f.room.delete(f.moderator, byMod.id, 'Spam');
    f.room.delete(f.admin, byAdmin.id, 'Spam');
    f.room.delete(f.owner, byOwner.id, 'Slur');
    const reads = (viewer: string) => [byAuthor, byMod, byAdmin, byOwner].map(message => f.seen(viewer, message.id).removed?.body ?? null);
    expect(reads(f.bob)).toEqual([null, null, null, null]);
    expect(reads(f.alice)).toEqual([null, null, null, null]);
    expect(reads(f.helper)).toEqual([null, null, null, null]);
    expect(reads(f.moderator)).toEqual(['oops wrong chat', 'spam one', null, null]);
    expect(reads(f.admin)).toEqual(['oops wrong chat', 'spam one', 'spam two', null]);
    expect(reads(f.owner)).toEqual(['oops wrong chat', 'spam one', 'spam two', 'spam three ******']);
    // The body is gone for everyone else, and only the owner gets the uncensored copy.
    expect(f.seen(f.owner, byOwner.id)).toMatchObject({ body: null, deletedBy: 'owner', moderatedBy: 'owner', removed: { body: 'spam three ******', original: 'spam three f4ggot', image: null } });
    expect(f.seen(f.admin, byMod.id).removed).toEqual({ body: 'spam one', original: null, image: null });
  });

  it('ranks a staff member deleting their own message at their tier', () => {
    const f = fixture();
    const own = f.room.send(f.admin, randomUUID(), 'admin typo').message;
    f.room.delete(f.admin, own.id);
    expect(f.seen(f.moderator, own.id).removed).toBeNull();
    expect(f.seen(f.owner, own.id).removed?.body).toBe('admin typo');
  });

  it('keeps the text from before a Global edit for the editor’s tier and up, at the highest tier that edited', () => {
    const f = fixture();
    const sent = f.room.send(f.alice, randomUUID(), 'call me at 555 0100 f4ggot').message;
    f.room.edit(f.moderator, sent.id, 'call me', 'Phone number');
    expect(f.db.prepare('SELECT edited_from, edited_rank FROM global_messages WHERE id=?').get(sent.id)).toEqual({ edited_from: 'call me at 555 0100 f4ggot', edited_rank: 'moderator' });
    expect(f.seen(f.bob, sent.id).editedFrom).toBeNull();
    expect(f.seen(f.helper, sent.id).editedFrom).toBeNull();
    expect(f.seen(f.moderator, sent.id).editedFrom).toEqual({ body: 'call me at 555 0100 ******', original: null });
    expect(f.seen(f.owner, sent.id).editedFrom).toEqual({ body: 'call me at 555 0100 ******', original: 'call me at 555 0100 f4ggot' });
    // An administrator edits again: the sender's text stays, and now only administrators and up read it.
    f.room.edit(f.admin, sent.id, 'hi', 'Cleanup');
    f.room.edit(f.moderator, sent.id, 'hi there', 'Typo');
    expect(f.db.prepare('SELECT edited_from, edited_rank FROM global_messages WHERE id=?').get(sent.id)).toEqual({ edited_from: 'call me at 555 0100 f4ggot', edited_rank: 'administrator' });
    expect(f.seen(f.moderator, sent.id).editedFrom).toBeNull();
    expect(f.seen(f.admin, sent.id).editedFrom?.body).toBe('call me at 555 0100 ******');
    // The note still names who edited last.
    expect(f.seen(f.bob, sent.id)).toMatchObject({ body: 'hi there', moderatedBy: 'administrator' });
  });

  it('serves a removed photo only to viewers who may read the removal', () => {
    const f = fixture();
    const sent = f.room.send(f.alice, randomUUID(), 'look', undefined, 'YWJj').message;
    f.room.delete(f.admin, sent.id, 'Not here');
    expect(readChatImage(f.service, f.bob, 'global', sent.seq)).toBeNull();
    expect(readChatImage(f.service, f.moderator, 'global', sent.seq)).toBeNull();
    expect(readChatImage(f.service, f.admin, 'global', sent.seq)?.toString()).toBe('abc');
    expect(f.seen(f.admin, sent.id).removed).toEqual({ body: 'look', original: null, image: `/api/chat/images/global/${sent.seq}` });
  });

  it('applies the same rules in one-to-one and group chats', () => {
    const f = fixture();
    f.befriend(f.alice, f.moderator); f.befriend(f.alice, f.bob); f.befriend(f.alice, f.owner);
    const chat = new ChatService(f.service);
    const toMod = chat.send(f.alice, f.moderator, randomUUID(), 'never mind f4ggot').message;
    chat.delete(f.alice, f.moderator, toMod.id);
    const modView = chat.thread(f.moderator, f.alice).messages.find(message => message.id === toMod.id)!;
    expect(modView).toMatchObject({ body: null, deletedBy: 'sender', original: null, removed: { body: 'never mind ******', original: null } });
    const toBob = chat.send(f.alice, f.bob, randomUUID(), 'never mind').message;
    chat.delete(f.alice, f.bob, toBob.id);
    expect(chat.thread(f.bob, f.alice).messages.find(message => message.id === toBob.id)!.removed).toBeNull();
    const toOwner = chat.send(f.alice, f.owner, randomUUID(), 'hey f4ggot').message;
    expect(chat.thread(f.owner, f.alice).messages.find(message => message.id === toOwner.id)!.original).toBe('hey f4ggot');
    expect(chat.thread(f.alice, f.owner).messages.find(message => message.id === toOwner.id)!.original).toBeNull();

    const groups = new GroupChatService(f.service);
    const group = groups.create(f.alice, { name: 'Study', memberIds: [f.bob, f.moderator] });
    const fromBob = groups.send(f.bob, group.id, randomUUID(), 'off topic').message;
    groups.delete(f.alice, group.id, fromBob.id);
    const read = (viewer: string) => groups.thread(viewer, group.id).messages.find(message => message.id === fromBob.id)!;
    expect(read(f.moderator)).toMatchObject({ deletedBy: 'admin', removed: { body: 'off topic' } });
    expect(read(f.bob).removed).toBeNull();
    expect(f.db.prepare('SELECT deleted_rank FROM chat_group_messages WHERE id=?').get(fromBob.id)).toEqual({ deleted_rank: 'member' });
  });

  it('ranks a reported message staff hid at the hider’s tier', () => {
    const f = fixture();
    f.befriend(f.alice, f.bob); f.befriend(f.alice, f.moderator);
    const chat = new ChatService(f.service);
    const mean = chat.send(f.alice, f.bob, randomUUID(), 'you are the worst').message;
    chat.report(f.bob, f.alice, { category: 'bullying', seq: mean.seq, block: false });
    const report = f.db.prepare('SELECT id FROM reports WHERE reported_id=?').get(f.alice) as { id: string };
    chat.redactMessage(f.admin, report.id, mean.seq);
    expect(f.db.prepare('SELECT deleted_by, deleted_rank FROM chat_messages WHERE id=?').get(mean.id)).toEqual({ deleted_by: 'support', deleted_rank: 'administrator' });
    expect(chat.thread(f.bob, f.alice).messages.find(message => message.id === mean.id)).toMatchObject({ deletedBy: 'support', removed: null });
    // A second hide keeps the first rank.
    chat.redactMessage(f.moderator, report.id, mean.seq);
    expect(f.db.prepare('SELECT deleted_rank FROM chat_messages WHERE id=?').get(mean.id)).toEqual({ deleted_rank: 'administrator' });
  });

  it('applies the tiers to removed posts in a member’s record, where support reads none', () => {
    const f = fixture();
    const own = f.room.send(f.alice, randomUUID(), 'my own delete').message;
    const byAdmin = f.room.send(f.alice, randomUUID(), 'admin took this').message;
    f.room.delete(f.alice, own.id);
    f.room.delete(f.admin, byAdmin.id, 'No');
    const posts = (viewer: string) => new SupportService(f.service).view(viewer, { userId: f.alice, reason: 'Checking her posts' }).globalMessages
      .map(post => ({ body: post.body, textHidden: post.textHidden }));
    expect(posts(f.helper)).toEqual([{ body: '', textHidden: true }, { body: '', textHidden: true }]);
    expect(posts(f.admin)).toEqual([{ body: 'admin took this', textHidden: false }, { body: 'my own delete', textHidden: false }]);
    expect(posts(f.owner)).toEqual([{ body: 'admin took this', textHidden: false }, { body: 'my own delete', textHidden: false }]);
  });

  it('clears the kept copies with the deleted text after retention', () => {
    const f = fixture();
    f.befriend(f.alice, f.bob);
    const sent = f.room.send(f.alice, randomUUID(), 'you f4ggot').message;
    f.room.edit(f.moderator, sent.id, 'you', 'Slur');
    f.room.delete(f.alice, sent.id);
    const chat = new ChatService(f.service);
    const dm = chat.send(f.alice, f.bob, randomUUID(), 'you f4ggot').message;
    chat.delete(f.alice, f.bob, dm.id);
    const later = new Date(Date.now() + 31 * DAY);
    pruneGlobalChat(f.db, later); pruneChat(f.db, later);
    expect(f.db.prepare('SELECT body, original, edited_from FROM global_messages WHERE id=?').get(sent.id)).toEqual({ body: '', original: null, edited_from: null });
    expect(f.db.prepare('SELECT body, original FROM chat_messages WHERE id=?').get(dm.id)).toEqual({ body: '', original: null });
    expect(f.seen(f.owner, sent.id).removed).toBeNull();
  });
});
