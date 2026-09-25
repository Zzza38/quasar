import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { openDatabase, type Db } from './db';
import { AVATAR_MAX_BYTES, Service, imageBytesMatch } from './service';
import { avatarUrl, usableGooglePicture } from './avatars';
import { ChatService } from './chat';
import { CommunityService } from './community';
import { appRouter } from './router';
import { exampleSchedule } from '@/domain/example';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });

function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  function user(email = `${randomUUID()}@example.com`, name = 'Student', picture = '') {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,google_picture,created_at) VALUES(?,?,?,?,?,?,?)').run(id, id, email, name, `${name} Fullname`, picture, new Date().toISOString());
    return id;
  }
  const owner = user('owner@example.com', 'Owner');
  const alice = user(undefined, 'Alice', 'https://lh3.googleusercontent.com/a/photo=s96-c'), bob = user(undefined, 'Bob');
  const school = service.createSchool(alice, { name: 'Community High', location: 'Boston, MA', schedule: exampleSchedule });
  for (const id of [alice, bob, owner]) service.join(id, { schoolId: school.id, choice: 'community', grade: '10' });
  const community = new CommunityService(service);
  const chat = new ChatService(service);
  const caller = (id: string | null) => appRouter.createCaller({ service, userId: id });
  return { db, service, owner, alice, bob, school, community, chat, caller };
}

function fails(fn: () => unknown, code: TRPCError['code'], message?: string) {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(TRPCError);
  expect((error as TRPCError).code).toBe(code);
  if (message !== undefined) expect((error as TRPCError).message).toBe(message);
}

/** A 1×1 JPEG, PNG and WebP: the smallest bytes each format's sniffer accepts. */
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('profile pictures (docs/CHAT.md §13)', () => {
  it('shows the Google picture by default, an upload over it, and initials on request', () => {
    const f = fixture();
    expect(f.service.user(f.alice)).toMatchObject({ avatar: 'https://lh3.googleusercontent.com/a/photo=s96-c', avatarSource: 'google', hasGooglePicture: true });
    expect(f.service.user(f.bob)).toMatchObject({ avatar: null, avatarSource: 'none', hasGooglePicture: false });
    const uploaded = f.service.setAvatar(f.alice, { mime: 'image/jpeg', data: JPEG.toString('base64') });
    expect(uploaded).toMatchObject({ avatar: `/api/avatars/${f.alice}?v=1`, avatarSource: 'upload' });
    expect(f.service.avatarImage(f.alice)).toMatchObject({ mime: 'image/jpeg', version: 1 });
    expect(f.service.avatarImage(f.alice)!.bytes.equals(JPEG)).toBe(true);
    // A second upload gets a new URL, so a cached picture never shows the old one.
    expect(f.service.setAvatar(f.alice, { mime: 'image/png', data: PNG.toString('base64') }).avatar).toBe(`/api/avatars/${f.alice}?v=2`);
    expect(f.service.clearAvatar(f.alice, 'none')).toMatchObject({ avatar: null, avatarSource: 'none', hasGooglePicture: true });
    expect(f.service.avatarImage(f.alice)).toBeNull();
    expect(f.service.clearAvatar(f.alice, 'google')).toMatchObject({ avatar: 'https://lh3.googleusercontent.com/a/photo=s96-c', avatarSource: 'google' });
  });

  it('refuses anything that is not a small image', () => {
    const f = fixture();
    fails(() => f.service.setAvatar(f.alice, { mime: 'image/jpeg', data: PNG.toString('base64') }), 'BAD_REQUEST', 'Choose an image file.');
    fails(() => f.service.setAvatar(f.alice, { mime: 'image/png', data: Buffer.from('<svg onload=alert(1)>').toString('base64') }), 'BAD_REQUEST', 'Choose an image file.');
    // Oversized uploads never reach the sniffer: the input schema (zod, BAD_REQUEST through the router) stops them.
    expect(() => f.service.setAvatar(f.alice, { mime: 'image/jpeg', data: Buffer.concat([JPEG, Buffer.alloc(AVATAR_MAX_BYTES)]).toString('base64') })).toThrow();
    expect(imageBytesMatch(JPEG, 'image/jpeg')).toBe(true);
    expect(imageBytesMatch(PNG, 'image/jpeg')).toBe(false);
    expect(usableGooglePicture('http://lh3.googleusercontent.com/x')).toBe(false);
    expect(usableGooglePicture('https://evil.example/googleusercontent.com')).toBe(false);
    expect(avatarUrl({ id: 'u', google_picture: 'https://lh3.googleusercontent.com/x', avatar_version: 0, avatar_hidden: 1 })).toBeNull();
  });

  it('reaches every place a member is shown', async () => {
    const f = fixture();
    f.community.request(f.alice, f.bob); f.community.respond(f.bob, f.alice, true);
    f.chat.send(f.alice, f.bob, randomUUID(), 'hi');
    const google = 'https://lh3.googleusercontent.com/a/photo=s96-c';
    expect(f.chat.thread(f.bob, f.alice).peer.avatar).toBe(google);
    expect(f.chat.thread(f.bob, f.alice).receipts[0]).toMatchObject({ displayName: 'Alice', avatar: google });
    const row = f.chat.inbox(f.bob).rows[0];
    expect(row && row.state === 'open' ? row.peer.avatar : null).toBe(google);
    expect(f.community.friends(f.bob).friends[0]!.avatar).toBe(google);
    expect(f.community.profile(f.bob, f.alice).avatar).toBe(google);
    expect((await f.caller(f.bob).global.send({ accountId: f.bob, clientId: randomUUID(), body: 'room' })).message.sender.avatar).toBeNull();
    expect((await f.caller(f.alice).global.send({ accountId: f.alice, clientId: randomUUID(), body: 'room' })).message.sender.avatar).toBe(google);
  });
});

describe('sanctions the student sees and appeals (docs/CHAT.md §14)', () => {
  it('shows the pause with its reason, takes one appeal, and lifting the pause answers it', () => {
    const f = fixture();
    expect(f.service.sanctions(f.bob)).toEqual({ bans: [], pause: null });
    fails(() => f.service.appeal(f.bob, { kind: 'pause', message: 'I was not even paused' }), 'BAD_REQUEST', 'Your messaging is not paused.');
    f.chat.pauseChat(f.owner, { userId: f.bob, days: 7, reason: 'Threats in chat' });
    expect(f.service.sanctions(f.bob).pause).toEqual({ until: expect.any(String), reason: 'Threats in chat', appealed: false });
    expect(f.service.workspace(f.bob).sanctions.pause?.reason).toBe('Threats in chat');
    f.service.appeal(f.bob, { kind: 'pause', message: 'That was a joke between friends, we are fine now.' });
    expect(f.service.sanctions(f.bob).pause?.appealed).toBe(true);
    expect(f.chat.inbox(f.bob).pause?.appealed).toBe(true);
    fails(() => f.service.appeal(f.bob, { kind: 'pause', message: 'Please please please' }), 'CONFLICT', 'You already sent an appeal. Support will review it.');
    const [request] = f.service.requests(f.owner);
    expect(request).toMatchObject({ kind: 'appeal:pause', displayName: 'Bob', message: 'That was a joke between friends, we are fine now.' });
    f.chat.liftChatPause(f.owner, f.bob);
    expect(f.service.requests(f.owner)).toEqual([]);
    expect(f.service.sanctions(f.bob).pause).toBeNull();
  });

  it('shows a removal with its reason, takes an appeal per school, and the owner can lift it', async () => {
    const f = fixture();
    f.community.removeFromSchool(f.owner, f.bob, f.school.id, 'Repeated harassment');
    expect(f.service.sanctions(f.bob).bans).toEqual([{ schoolId: f.school.id, schoolName: 'Community High', reason: 'Repeated harassment', createdAt: expect.any(String), appealed: false }]);
    fails(() => f.service.join(f.bob, { schoolId: f.school.id, choice: 'community' }), 'FORBIDDEN', 'Support removed you from this school. You can read the reason and appeal on the school step.');
    fails(() => f.service.appeal(f.bob, { kind: 'ban', schoolId: randomUUID(), message: 'Not this school though' }), 'BAD_REQUEST', 'You were not removed from that school.');
    f.service.appeal(f.bob, { kind: 'ban', schoolId: f.school.id, message: 'I have apologised and it will not happen again.' });
    expect(f.service.sanctions(f.bob).bans[0]!.appealed).toBe(true);
    const owner = f.caller(f.owner);
    expect(await owner.admin.bans()).toEqual([expect.objectContaining({ userId: f.bob, displayName: 'Bob', schoolName: 'Community High', reason: 'Repeated harassment', appealed: true })]);
    expect((await owner.admin.requests())[0]).toMatchObject({ kind: 'appeal:ban', schoolName: 'Community High', userId: f.bob });
    await expect(f.caller(f.bob).admin.liftBan({ accountId: f.bob, userId: f.bob, schoolId: f.school.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await owner.admin.liftBan({ accountId: f.owner, userId: f.bob, schoolId: f.school.id });
    expect(f.service.sanctions(f.bob).bans).toEqual([]);
    expect(await owner.admin.requests()).toEqual([]);
    expect(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='member.restore'").get()).toEqual({ n: 1 });
    f.service.join(f.bob, { schoolId: f.school.id, choice: 'community' });
    expect(f.service.user(f.bob).schoolId).toBe(f.school.id);
    await expect(owner.admin.liftBan({ accountId: f.owner, userId: f.bob, schoolId: f.school.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('binds appeals and pictures to the signed-in account', async () => {
    const f = fixture();
    await expect(f.caller(f.alice).support.appeal({ accountId: f.bob, kind: 'pause', message: 'not my account at all' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(f.caller(f.alice).avatar.clear({ accountId: f.bob, source: 'none' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(f.caller(null).avatar.upload({ accountId: f.alice, mime: 'image/png', data: PNG.toString('base64') })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
