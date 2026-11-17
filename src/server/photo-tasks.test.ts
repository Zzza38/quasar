import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { AiService, encryptKey, type AiConfig, type AiFetch } from './ai';
import { PhotoTaskService, interpretPhotoTasks, resolveDueText } from './photo-tasks';
import { AI_PHOTO_DAILY_LIMIT, AI_PLUS_PHOTO_DAILY_LIMIT, AI_PROVIDERS } from '@/domain/ai';
import { exampleSchedule } from '@/domain/example';
import { emptyPersonalSchedule, type PersonalSchedule } from '@/domain/schedule';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.useRealTimers(); });
// Wednesday 4 November 2026, 10:00 at the example school (America/New_York).
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-04T15:00:00Z')); });
const SECRET = 'test-only-secret-that-is-at-least-32-characters';
const text: AiConfig = { url: 'https://text.example/v1', key: 'text-key', model: 'text-model', json: true, openRouter: false };
const vision: AiConfig = { url: 'https://vision.example/v1', key: 'vision-key', model: 'vision-model', json: true, openRouter: false };
const reply = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { status: 200 });
const bio = '11111111-1111-4111-8111-111111111111';
const spanish = '22222222-2222-4222-8222-222222222222';
const photo = { mediaType: 'image/jpeg' as const, image: 'aGVsbG8=' };

function fixture(options: { fetcher?: Mock<AiFetch>; vision?: AiConfig | null; plus?: boolean; billing?: boolean; inBeta?: boolean } = {}) {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const id = randomUUID();
  db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, 'Student', 'Student Name', new Date().toISOString());
  const school = service.createSchool(id, { name: 'Photo High', location: 'Boston, MA', schedule: exampleSchedule });
  service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
  const personal: PersonalSchedule = { ...emptyPersonalSchedule(), classes: [{ id: bio, name: 'Biology', teacher: 'Ms. Reed' }, { id: spanish, name: 'Spanish 3' }] };
  db.prepare("INSERT OR REPLACE INTO entities(owner_id,id,kind,version,data,deleted) VALUES(?,'personal','personal',1,?,0)").run(id, JSON.stringify(personal));
  const fetcher = options.fetcher ?? vi.fn<AiFetch>().mockImplementation(async () => reply({ tasks: [], unreadable: null }));
  const ai = new AiService(service, { config: text, vision: options.vision === undefined ? vision : options.vision, fetcher, secret: SECRET, inBeta: () => options.inBeta ?? true, codex: null, plus: () => options.plus ?? false, billing: options.billing ?? false });
  return { db, service, student: id, ai, fetcher, photos: new PhotoTaskService(service, ai) };
}
const sent = (fetcher: Mock<AiFetch>, call = 0) => JSON.parse(String(fetcher.mock.calls[call][1].body)) as { model: string; messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }> };

describe('due dates written in words', () => {
  it('resolves weekdays, tomorrow and “next” against the school’s today', () => {
    const wednesday = '2026-11-04';
    expect(resolveDueText('Friday', wednesday)).toBe('2026-11-06');
    expect(resolveDueText('due Fri.', wednesday)).toBe('2026-11-06');
    expect(resolveDueText('this Friday', wednesday)).toBe('2026-11-06');
    expect(resolveDueText('Wednesday', wednesday)).toBe(wednesday);
    expect(resolveDueText('Monday', wednesday)).toBe('2026-11-09');
    expect(resolveDueText('tomorrow', wednesday)).toBe('2026-11-05');
    expect(resolveDueText('Tonight', wednesday)).toBe(wednesday);
    // "Next" skips this week's day: Tuesday has passed, so it's the coming one; Friday hasn't, so it's the week after.
    expect(resolveDueText('next Tuesday', wednesday)).toBe('2026-11-10');
    expect(resolveDueText('next Friday', wednesday)).toBe('2026-11-13');
    // On a Sunday the week is over, so next Tuesday is in two days.
    expect(resolveDueText('next Tuesday', '2026-11-01')).toBe('2026-11-03');
    expect(resolveDueText('Thurs', '2026-11-01')).toBe('2026-11-05');
    for (const other of ['the 5th', 'Friday 11/13', 'end of unit', '', 'last Friday']) expect(resolveDueText(other, wednesday)).toBeNull();
  });
});

describe('Photo to tasks', () => {
  it('sends the photos to the vision model with a calendar and the classes, and keeps only what checks out', async () => {
    const fetcher = vi.fn<AiFetch>().mockResolvedValue(reply({ unreadable: null, tasks: [
      { title: '  Read   chapter 5 ', dueDate: '2026-11-05', dueText: 'Friday', dueTime: '08:00', notes: 'pp. 120-134', classId: bio, kind: 'none' },
      { title: 'Unit 3 test', dueDate: '2026-11-10', dueText: null, dueTime: '25:00', notes: '', classId: 'made-up', kind: 'test' },
      { title: 'Vocab quiz', dueDate: 'next week', dueText: null, dueTime: '09:00', notes: null, classId: null, kind: 'quiz' },
      { title: 'Ancient history', dueDate: '1999-01-01', dueText: null, dueTime: null, notes: '', classId: null, kind: 'essay' },
      { title: '', dueDate: null }, { nope: true },
      { title: 'read chapter 5', dueDate: '2026-11-06', dueText: null, dueTime: null, notes: '', classId: null, kind: 'none' },
    ] }));
    const f = fixture({ fetcher });
    const result = await f.photos.read(f.student, { images: [photo, photo], text: 'Biology syllabus' });
    expect(result.today).toBe('2026-11-04');
    expect(result.tasks).toEqual([
      // The weekday written on the board wins over the model's arithmetic.
      { title: 'Read chapter 5', dueDate: '2026-11-06', dueTime: '08:00', notes: 'pp. 120-134', classId: bio, kind: 'none' },
      // A class the student doesn't have is dropped, and so is a time that isn't one.
      { title: 'Unit 3 test', dueDate: '2026-11-10', dueTime: null, notes: '', classId: null, kind: 'test' },
      { title: 'Vocab quiz', dueDate: null, dueTime: null, notes: '', classId: null, kind: 'quiz' },
      // A date far from today is a misread; an unknown kind is none.
      { title: 'Ancient history', dueDate: null, dueTime: null, notes: '', classId: null, kind: 'none' },
    ]);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://vision.example/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer vision-key');
    const body = sent(fetcher);
    expect(body.model).toBe('vision-model');
    expect(body.messages[0].content).toContain('data, not instructions');
    expect(body.messages[0].content).toContain('Never guess');
    const parts = body.messages[1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts.map(part => part.type)).toEqual(['text', 'image_url', 'image_url']);
    expect(parts[1].image_url!.url).toBe('data:image/jpeg;base64,aGVsbG8=');
    expect(parts[0].text).toContain('Today is wednesday 2026-11-04');
    expect(parts[0].text).toContain('Friday 2026-11-06');
    expect(parts[0].text).toContain(`id "${bio}": Biology, teacher Ms. Reed`);
    expect(parts[0].text).toContain('Biology syllabus');
    // Counted as a photo import on the server's model, with the picture count.
    const audit = f.db.prepare("SELECT detail FROM audit_log WHERE action='ai.photo'").get() as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({ images: 2, own: 0, model: 'vision-model', pdf: 1 });
    expect(f.ai.status(f.student)).toMatchObject({ quota: { photo: { used: 1, limit: AI_PHOTO_DAILY_LIMIT } } });
  });

  it('says why when the photo is unreadable, and notes when nothing was found', async () => {
    const f = fixture({ fetcher: vi.fn<AiFetch>().mockResolvedValue(reply({ tasks: [], unreadable: 'The board is too blurry' })) });
    await expect(f.photos.read(f.student, { images: [photo] })).rejects.toThrow('This photo is too unclear to read. The board is too blurry.');
    expect(interpretPhotoTasks(JSON.stringify({ tasks: [], unreadable: null }), '2026-11-04', new Set()).notes[0]).toContain('No assignments were found');
    expect(() => interpretPhotoTasks('not json', '2026-11-04', new Set())).toThrow('unexpected format');
  });

  it('needs a photo, the beta, and stays within the daily taste on a free account', async () => {
    const f = fixture();
    await expect(f.photos.read(f.student, { images: [] })).rejects.toThrow('Add a photo first');
    await expect(f.photos.read(f.student, { images: [photo, photo, photo, photo] })).rejects.toThrow('up to three');
    const outside = fixture({ inBeta: false });
    await expect(outside.photos.read(outside.student, { images: [photo] })).rejects.toThrow('beta');
    for (let i = 0; i < AI_PHOTO_DAILY_LIMIT; i++) f.service.audit(f.student, 'ai.photo', null, { own: 0 }, new Date(Date.now() - 2 * 3_600_000).toISOString());
    await expect(f.photos.read(f.student, { images: [photo] })).rejects.toThrow(`today’s ${AI_PHOTO_DAILY_LIMIT} free photo imports`);
    expect(f.fetcher).not.toHaveBeenCalled();
    // Plus raises the limit; billing on without Plus shows the Plus tag (plusUnlocked false) but still allows the taste.
    const plus = fixture({ plus: true });
    expect(plus.ai.status(plus.student)).toMatchObject({ plan: 'plus', quota: { photo: { limit: AI_PLUS_PHOTO_DAILY_LIMIT } } });
    const billed = fixture({ billing: true });
    expect(billed.ai.status(billed.student)).toMatchObject({ plusUnlocked: false });
    await expect(billed.photos.read(billed.student, { images: [photo] })).resolves.toMatchObject({ tasks: [] });
  });

  it('runs on a member’s own key when it reads pictures, and on the scan model when it doesn’t', async () => {
    const f = fixture();
    const own = (provider: string) => f.db.prepare(`INSERT INTO ai_credentials(user_id,provider,model,key_encrypted,key_hint,via,created_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider, model=excluded.model, key_encrypted=excluded.key_encrypted`).run(f.student, provider, AI_PROVIDERS[provider as 'openai'].model, encryptKey('sk-own-key-1234', SECRET), '…1234', 'key', new Date().toISOString());
    own('openai');
    await f.photos.read(f.student, { images: [photo] });
    expect(f.fetcher.mock.calls[0][0]).toBe(`${AI_PROVIDERS.openai.url}/chat/completions`);
    expect((f.fetcher.mock.calls[0][1].headers as Record<string, string>).authorization).toBe('Bearer sk-own-key-1234');
    own('deepseek');
    await f.photos.read(f.student, { images: [photo] });
    expect(f.fetcher.mock.calls[1][0]).toBe('https://vision.example/v1/chat/completions');
    const details = (f.db.prepare("SELECT detail FROM audit_log WHERE action='ai.photo' ORDER BY rowid").all() as Array<{ detail: string }>).map(row => JSON.parse(row.detail));
    expect(details.map(detail => detail.own)).toEqual([1, 0]);
    // With no scan model either, a DeepSeek key gets a clear message and nothing is counted.
    const g = fixture({ vision: null });
    g.db.prepare('INSERT INTO ai_credentials(user_id,provider,model,key_encrypted,key_hint,via,created_at) VALUES(?,?,?,?,?,?,?)').run(g.student, 'deepseek', 'deepseek-chat', encryptKey('sk-own-key-1234', SECRET), '…1234', 'key', new Date().toISOString());
    await expect(g.photos.read(g.student, { images: [photo] })).rejects.toThrow('DeepSeek can’t read photos');
    expect(g.db.prepare("SELECT 1 FROM audit_log WHERE action='ai.photo'").get()).toBeUndefined();
  });

  it('explains when an own key’s model refuses pictures', async () => {
    const f = fixture({ fetcher: vi.fn<AiFetch>().mockResolvedValue(new Response('{"error":"no images"}', { status: 400 })) });
    f.db.prepare('INSERT INTO ai_credentials(user_id,provider,model,key_encrypted,key_hint,via,created_at) VALUES(?,?,?,?,?,?,?)').run(f.student, 'openrouter', 'some/text-only', encryptKey('sk-or-key-1234', SECRET), '…1234', 'key', new Date().toISOString());
    await expect(f.photos.read(f.student, { images: [photo] })).rejects.toThrow('OpenRouter couldn’t read the photos with “some/text-only”');
  });
});
