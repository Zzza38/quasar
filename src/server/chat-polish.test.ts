import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { TRPCError } from '@trpc/server';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { CommunityService } from './community';
import { ChatService } from './chat';
import { GroupChatService } from './group-chat';
import { GlobalChatService, SchoolChatService } from './global-chat';
import { prepareChatImage, GIF_ERROR } from './chat-images';
import { appRouter } from './router';
import { CHAT, EDIT_WINDOW_MESSAGE, REACTIONS } from '@/domain/chat';
import { exampleSchedule } from '@/domain/example';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** The chat-polish beta's server side: a sender's own edit, mentions, search, GIFs that keep moving and the larger reaction set. */

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
  for (const id of [alice, bob, cara, owner]) service.join(id, { schoolId: school.id, choice: 'community', grade: '11' });
  const community = new CommunityService(service);
  const befriend = (a: string, b: string) => { community.request(a, b); community.respond(b, a, true); };
  befriend(alice, bob); befriend(alice, cara); befriend(bob, cara);
  const clock = { now: new Date() };
  const tick = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  const now = () => clock.now;
  const chat = new ChatService(service, now), groups = new GroupChatService(service, now), room = new GlobalChatService(service, now), schoolRoom = new SchoolChatService(service, now);
  const caller = (id: string | null) => appRouter.createCaller({ service, userId: id, authAt: Date.now() });
  return { db, service, community, user, owner, alice, bob, cara, dan, school, chat, groups, room, schoolRoom, caller, clock, tick };
}

function fails(fn: () => unknown, code: TRPCError['code'], message?: string) {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(TRPCError);
  expect((error as TRPCError).code).toBe(code);
  if (message !== undefined) expect((error as TRPCError).message).toBe(message);
}

describe('a sender edits their own message', () => {
  it('rewrites a one-to-one message inside the window and keeps the first text for both people', () => {
    const f = fixture();
    const sent = f.chat.send(f.alice, f.bob, randomUUID(), 'meet at 3').message;
    expect(sent.editedAt).toBeNull();
    f.tick(60_000);
    const edited = f.chat.editOwn(f.alice, f.bob, sent.id, 'meet at 4').message;
    expect(edited.body).toBe('meet at 4');
    expect(edited.editedBySender).toBe(true);
    expect(edited.editedFrom?.body).toBe('meet at 3');
    expect(edited.revision).toBeGreaterThan(sent.revision);
    const seen = f.chat.thread(f.bob, f.alice).messages[0]!;
    expect([seen.body, seen.editedBySender, seen.editedFrom?.body]).toEqual(['meet at 4', true, 'meet at 3']);
    // A second edit keeps the text as first sent, not the first edit.
    expect(f.chat.editOwn(f.alice, f.bob, sent.id, 'meet at 5').message.editedFrom?.body).toBe('meet at 3');
    // Saving the same text changes nothing.
    const revision = f.chat.thread(f.bob, f.alice).revision;
    f.chat.editOwn(f.alice, f.bob, sent.id, 'meet at 5');
    expect(f.chat.thread(f.bob, f.alice).revision).toBe(revision);
  });

  it('refuses someone else\'s message, a deleted one, an empty text and anything past the window', () => {
    const f = fixture();
    const sent = f.chat.send(f.alice, f.bob, randomUUID(), 'hello').message;
    fails(() => f.chat.editOwn(f.bob, f.alice, sent.id, 'hacked'), 'FORBIDDEN', 'You can only edit your own messages.');
    fails(() => f.chat.editOwn(f.alice, f.bob, sent.id, '   '), 'BAD_REQUEST', 'Write a message first.');
    f.tick(CHAT.editWindowMs + 1000);
    fails(() => f.chat.editOwn(f.alice, f.bob, sent.id, 'too late'), 'BAD_REQUEST', EDIT_WINDOW_MESSAGE);
    const gone = f.chat.send(f.alice, f.bob, randomUUID(), 'oops').message;
    f.chat.delete(f.alice, f.bob, gone.id);
    fails(() => f.chat.editOwn(f.alice, f.bob, gone.id, 'back'), 'NOT_FOUND');
    expect(f.chat.thread(f.bob, f.alice).messages.map(message => message.body)).toEqual(['hello', null]);
  });

  it('censors the new text, keeps the original for the owner only, and lets a retry of the first send through', () => {
    const f = fixture();
    const clientId = randomUUID();
    const sent = f.chat.send(f.alice, f.bob, clientId, 'first').message;
    const edited = f.chat.editOwn(f.alice, f.bob, sent.id, 'you nigger').message;
    expect(edited.body).not.toContain('nigger');
    expect(edited.original).toBeNull();
    // The lost-response retry of the original send must not fail because the stored text has since changed.
    expect(f.chat.send(f.alice, f.bob, clientId, 'first').message.seq).toBe(sent.seq);
  });

  it('works in a group for the sender only, and a report keeps what the message said before', () => {
    const f = fixture();
    const group = f.groups.create(f.alice, { name: 'Lab', memberIds: [f.bob, f.cara] });
    const sent = f.groups.send(f.bob, group.id, randomUUID(), 'cara is dumb').message;
    fails(() => f.groups.editOwn(f.alice, group.id, sent.id, 'nope'), 'FORBIDDEN');
    const edited = f.groups.editOwn(f.bob, group.id, sent.id, 'cara is great').message;
    expect([edited.body, edited.editedBySender, edited.editedFrom?.body]).toEqual(['cara is great', true, 'cara is dumb']);
    expect(f.groups.thread(f.cara, group.id).messages[0]!.editedFrom?.body).toBe('cara is dumb');
    f.groups.report(f.cara, group.id, { category: 'bullying', seq: sent.seq, block: false });
    const evidence = JSON.parse((f.db.prepare('SELECT evidence FROM reports').get() as { evidence: string }).evidence) as { body: string }[];
    expect(evidence[0]!.body).toBe('cara is great\n\n(Before the sender edited it: cara is dumb)');
  });

  it('works in the rooms as a plain "Edited", and leaves a moderator\'s edit alone', () => {
    const f = fixture();
    const sent = f.room.send(f.alice, randomUUID(), 'hi evryone').message;
    const edited = f.room.editOwn(f.alice, sent.id, 'hi everyone').message;
    expect([edited.body, edited.editedBySender, edited.moderatedBy, edited.reason]).toEqual(['hi everyone', true, null, '']);
    // Every member can read a member's own edit.
    expect(f.room.thread(f.bob).messages[0]!.editedFrom?.body).toBe('hi evryone');
    fails(() => f.room.editOwn(f.bob, sent.id, 'mine now'), 'FORBIDDEN');
    f.room.edit(f.owner, sent.id, 'hi', 'tidied');
    fails(() => f.room.editOwn(f.alice, sent.id, 'hi again'), 'FORBIDDEN', 'A moderator edited this message, so it can’t be changed.');
    const after = f.room.thread(f.bob).messages[0]!;
    expect([after.body, after.editedBySender, after.moderatedBy, after.reason]).toEqual(['hi', false, 'owner', 'tidied']);
    const school = f.schoolRoom.send(f.alice, f.school.id, randomUUID(), 'lunch?').message;
    expect(f.schoolRoom.editOwn(f.alice, f.school.id, school.id, 'lunch at 12?').message.editedBySender).toBe(true);
    fails(() => f.schoolRoom.editOwn(f.dan, f.school.id, school.id, 'x'), 'NOT_FOUND');
  });

  it('is reachable through the router for the signed-in account only', async () => {
    const f = fixture();
    const sent = f.chat.send(f.alice, f.bob, randomUUID(), 'hello').message;
    const result = await f.caller(f.alice).chat.editOwn({ accountId: f.alice, userId: f.bob, messageId: sent.id, body: 'hello there' });
    expect(result.message.body).toBe('hello there');
    await expect(f.caller(null).chat.editOwn({ accountId: f.alice, userId: f.bob, messageId: sent.id, body: 'x' })).rejects.toBeInstanceOf(TRPCError);
  });
});

describe('mentions', () => {
  it('stores the picked members the text really names, and tells each viewer whether it is them', () => {
    const f = fixture();
    const group = f.groups.create(f.alice, { name: 'Lab', memberIds: [f.bob, f.cara] });
    // Dan is not in the group; Cara is picked but not named in the text; Alice cannot mention herself.
    const sent = f.groups.send(f.alice, group.id, randomUUID(), 'hey @Bob look', undefined, undefined, [f.bob, f.cara, f.dan, f.alice]).message;
    expect(sent.mentions).toEqual([{ id: f.bob, name: 'Bob', me: false }]);
    expect(f.groups.thread(f.bob, group.id).messages[0]!.mentions).toEqual([{ id: f.bob, name: 'Bob', me: true }]);
    expect(f.groups.list(f.bob).find(row => row.id === group.id)!.mentioned).toBe(true);
    expect(f.groups.list(f.cara).find(row => row.id === group.id)!.mentioned).toBe(false);
    f.groups.read(f.bob, group.id, sent.seq);
    expect(f.groups.list(f.bob).find(row => row.id === group.id)!.mentioned).toBe(false);
  });

  it('does not match a longer name, drops a mention the edit removed, and never shows on a deleted message', () => {
    const f = fixture();
    const group = f.groups.create(f.alice, { name: 'Lab', memberIds: [f.bob, f.cara] });
    expect(f.groups.send(f.alice, group.id, randomUUID(), 'ask @Bobby', undefined, undefined, [f.bob]).message.mentions).toEqual([]);
    const sent = f.groups.send(f.alice, group.id, randomUUID(), '@Bob and @Cara, lunch?', undefined, undefined, [f.bob, f.cara]).message;
    expect(sent.mentions.map(mention => mention.name)).toEqual(['Bob', 'Cara']);
    expect(f.groups.editOwn(f.alice, group.id, sent.id, '@Cara, lunch?').message.mentions.map(mention => mention.name)).toEqual(['Cara']);
    f.groups.delete(f.alice, group.id, sent.id);
    expect(f.groups.thread(f.cara, group.id).messages.at(-1)!.mentions).toEqual([]);
  });

  it('reaches the rooms: anyone with names in Global, only schoolmates in a school room', () => {
    const f = fixture();
    const global = f.room.send(f.alice, randomUUID(), 'thanks @Dan and @Bob', undefined, undefined, [f.dan, f.bob]).message;
    expect(global.mentions.map(mention => mention.name).sort()).toEqual(['Bob', 'Dan']);
    expect(f.room.summary(f.dan).mentioned).toBe(true);
    expect(f.room.summary(f.cara).mentioned).toBe(false);
    // Dan is not at the school, so the school room cannot mention him.
    const school = f.schoolRoom.send(f.alice, f.school.id, randomUUID(), 'thanks @Dan and @Bob', undefined, undefined, [f.dan, f.bob]).message;
    expect(school.mentions.map(mention => mention.name)).toEqual(['Bob']);
    expect(f.schoolRoom.summary(f.bob)!.mentioned).toBe(true);
    // A block hides the message, and with it the mention.
    f.community.block(f.bob, f.alice, true);
    expect(f.room.summary(f.bob).mentioned).toBe(false);
  });
});

describe('search inside a conversation', () => {
  it('finds one-to-one messages newest first, ignoring case, deleted messages and LIKE wildcards', () => {
    const f = fixture();
    const send = (from: string, to: string, body: string) => { f.tick(4000); return f.chat.send(from, to, randomUUID(), body).message; };
    send(f.alice, f.bob, 'Bring the Lab report');
    send(f.bob, f.alice, 'which lab?');
    const gone = send(f.alice, f.bob, 'lab 3, deleted');
    send(f.alice, f.bob, '100% sure');
    f.chat.delete(f.alice, f.bob, gone.id);
    const found = f.chat.search(f.bob, f.alice, '  LAB ').results;
    expect(found.map(hit => [hit.preview, hit.fromMe, hit.senderName])).toEqual([['which lab?', true, 'Bob'], ['Bring the Lab report', false, 'Alice']]);
    expect(f.chat.search(f.bob, f.alice, 'l').results).toEqual([]);
    expect(f.chat.search(f.bob, f.alice, '%%').results).toEqual([]);
    expect(f.chat.search(f.bob, f.alice, '0%').results.map(hit => hit.preview)).toEqual(['100% sure']);
    // Cara is Alice's friend but has no part in this chat: her own search with Alice sees nothing of it.
    expect(f.chat.search(f.cara, f.alice, 'lab').results).toEqual([]);
    fails(() => f.chat.search(f.dan, f.alice, 'lab'), 'NOT_FOUND');
  });

  it('keeps to what a group member may see: since they joined, and not from someone they blocked', () => {
    const f = fixture();
    const group = f.groups.create(f.alice, { name: 'Lab', memberIds: [f.bob] });
    f.tick(4000); f.groups.send(f.alice, group.id, randomUUID(), 'secret plan one');
    f.tick(4000); f.groups.addMembers(f.alice, group.id, [f.cara]);
    f.tick(4000); f.groups.send(f.bob, group.id, randomUUID(), 'plan two');
    expect(f.groups.search(f.alice, group.id, 'plan').results.map(hit => hit.preview)).toEqual(['plan two', 'secret plan one']);
    expect(f.groups.search(f.cara, group.id, 'plan').results.map(hit => hit.preview)).toEqual(['plan two']);
    f.community.block(f.cara, f.bob, true);
    expect(f.groups.search(f.cara, group.id, 'plan').results).toEqual([]);
    fails(() => f.groups.search(f.dan, group.id, 'plan'), 'NOT_FOUND');
  });

  it('searches the rooms with the same visibility, and caps the list', () => {
    const f = fixture();
    for (let index = 0; index < CHAT.searchResults + 3; index += 1) {
      f.tick(4000);
      // A second sender shares the load, so the per-minute send limit never trips.
      f.db.prepare('INSERT INTO global_messages(id,sender_id,body,created_at,revision) VALUES(?,?,?,?,?)').run(randomUUID(), index % 2 ? f.alice : f.bob, `pizza ${index}`, f.clock.now.toISOString(), index + 1);
    }
    const found = f.room.search(f.cara, 'pizza').results;
    expect(found).toHaveLength(CHAT.searchResults);
    expect(found[0]!.preview).toBe(`pizza ${CHAT.searchResults + 2}`);
    f.community.block(f.cara, f.alice, true);
    expect(f.room.search(f.cara, 'pizza').results.every(hit => hit.senderName === 'Bob')).toBe(true);
    f.schoolRoom.send(f.alice, f.school.id, randomUUID(), 'pizza at school');
    expect(f.schoolRoom.search(f.bob, f.school.id, 'pizza').results.map(hit => hit.preview)).toEqual(['pizza at school']);
    fails(() => f.schoolRoom.search(f.dan, f.school.id, 'pizza'), 'NOT_FOUND');
  });
});

describe('the larger reaction set', () => {
  it('stores a reaction outside the first six in every kind of chat', () => {
    const f = fixture();
    expect(REACTIONS.length).toBeGreaterThan(6);
    const peer = f.chat.send(f.alice, f.bob, randomUUID(), 'hi').message;
    expect(f.chat.react(f.bob, f.alice, peer.seq, '🔥').message.reactions).toEqual([{ emoji: '🔥', count: 1, mine: true }]);
    const group = f.groups.create(f.alice, { name: 'Lab', memberIds: [f.bob] });
    const inGroup = f.groups.send(f.alice, group.id, randomUUID(), 'hi').message;
    expect(f.groups.react(f.bob, group.id, inGroup.seq, '💀').message.reactors.map(reactor => reactor.emoji)).toEqual(['💀']);
    const global = f.room.send(f.alice, randomUUID(), 'hi').message;
    expect(f.room.react(f.bob, global.seq, '🫡').message.reactions[0]!.emoji).toBe('🫡');
    const school = f.schoolRoom.send(f.alice, f.school.id, randomUUID(), 'hi').message;
    expect(f.schoolRoom.react(f.bob, f.school.id, school.seq, '🎉').message.reactions[0]!.emoji).toBe('🎉');
  });

  it('rebuilds reaction tables that still carry the six-emoji CHECK, keeping the rows in order', () => {
    const directory = mkdtempSync(join(tmpdir(), 'quasar-polish-'));
    try {
      const path = join(directory, 'test.sqlite');
      // Two real reactions, made through the service, so the rebuilt table's foreign keys hold.
      const first = openDatabase(path);
      const service = new Service(first, 'owner@example.com');
      const [bob, alice] = ['Bob', 'Alice'].map((name) => {
        const id = randomUUID();
        first.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, name, `${name} Fullname`, new Date().toISOString());
        return id;
      }) as [string, string];
      const school = service.createSchool(alice, { name: 'Community High', location: 'Boston, MA', schedule: exampleSchedule });
      for (const id of [alice, bob]) service.join(id, { schoolId: school.id, choice: 'community', grade: '11' });
      const community = new CommunityService(service);
      community.request(alice, bob); community.respond(bob, alice, true);
      const chat = new ChatService(service);
      const message = chat.send(alice, bob, randomUUID(), 'hi').message;
      chat.react(bob, alice, message.seq, '👍');
      chat.react(alice, bob, message.seq, '❤️');
      first.close();
      const raw = new Database(path);
      // Put the old table back around the same rows, as a database from before this change has it.
      raw.exec(`ALTER TABLE chat_reactions RENAME TO chat_reactions_new;
        CREATE TABLE chat_reactions (message_seq INTEGER NOT NULL REFERENCES chat_messages(seq) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          emoji TEXT NOT NULL CHECK(emoji IN ('❤️','👍','👎','😂','‼️','❓')), PRIMARY KEY(message_seq, user_id));
        INSERT INTO chat_reactions SELECT message_seq, user_id, emoji FROM chat_reactions_new ORDER BY rowid;
        DROP TABLE chat_reactions_new;`);
      expect(() => raw.prepare('UPDATE chat_reactions SET emoji=?').run('🔥')).toThrow();
      raw.close();
      const db = openDatabase(path); databases.push(db);
      expect(db.prepare('SELECT user_id FROM chat_reactions ORDER BY rowid').pluck().all()).toEqual([bob, alice]);
      db.prepare('UPDATE chat_reactions SET emoji=? WHERE user_id=?').run('🔥', bob);
      expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='chat_reactions'").get() as { sql: string }).sql).not.toContain('CHECK');
      expect((db.pragma('table_info(chat_messages)') as { name: string }[]).map(column => column.name)).toEqual(expect.arrayContaining(['edited_at', 'edited_from']));
    } finally { for (const db of databases.splice(0)) db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('animated GIFs', () => {
  /** A `frames`-frame GIF of solid colours, `side` px square. */
  async function gif(frames: number, side = 24): Promise<string> {
    const pixels = Buffer.alloc(side * side * frames * 3);
    for (let frame = 0; frame < frames; frame += 1) pixels.fill(frame % 2 ? 250 : 20, frame * side * side * 3, (frame + 1) * side * side * 3);
    const bytes = await sharp(pixels, { raw: { width: side, height: side * frames, channels: 3, pageHeight: side } }).gif({ delay: Array.from({ length: frames }, () => 80) }).toBuffer();
    return bytes.toString('base64');
  }

  it('keeps every frame, as an animated WebP', async () => {
    const stored = await prepareChatImage(await gif(4));
    const metadata = await sharp(Buffer.from(stored!, 'base64'), { animated: true }).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.pages).toBe(4);
  });

  it('shrinks a large one to the GIF side limit, and still flattens nothing', async () => {
    const stored = await prepareChatImage(await gif(3, 900));
    const metadata = await sharp(Buffer.from(stored!, 'base64'), { animated: true }).metadata();
    expect([metadata.pages, metadata.width]).toEqual([3, CHAT.gifMaxDimension]);
  });

  it('treats a one-frame GIF as a still image, and refuses junk with the fixed wording', async () => {
    const stored = await prepareChatImage(await gif(1));
    expect((await sharp(Buffer.from(stored!, 'base64'), { animated: true }).metadata()).pages ?? 1).toBe(1);
    await expect(prepareChatImage(Buffer.from('not an image').toString('base64'))).rejects.toMatchObject({ message: 'Choose a JPEG, PNG, WebP or GIF image up to 1 MB.' });
    expect(GIF_ERROR).toContain('GIF');
  });
});
