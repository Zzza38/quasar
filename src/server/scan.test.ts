import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { DirectoryService } from './directory';
import { ScanService, scanConfig, scanInputSchema, MAX_SCAN_IMAGES, SCAN_DAILY_LIMIT, SCAN_HOURLY_LIMIT, type ScanFetch } from './scan';
import { exampleSchedule } from '@/domain/example';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const config = { url: 'https://vision.example/v1', key: 'secret', model: 'test-vision' };
const image = { mediaType: 'image/jpeg' as const, image: Buffer.from('photo').toString('base64') };
const photo = (text: string, mediaType: 'image/jpeg' | 'image/png' = 'image/jpeg') => ({ mediaType, image: Buffer.from(text).toString('base64') });
const answer = (rows: unknown[]) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rows }) } }] }), { status: 200 });

function fixture(fetcher: Mock<ScanFetch> = vi.fn<ScanFetch>().mockResolvedValue(answer([]))) {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  function user(email = `${randomUUID()}@example.com`) {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, 'Student', 'Student Name', new Date().toISOString());
    return id;
  }
  const student = user(), loner = user();
  const school = service.createSchool(student, { name: 'Scan High', location: 'Boston, MA', schedule: exampleSchedule });
  service.join(student, { schoolId: school.id, choice: 'community', grade: '9' });
  const directory = new DirectoryService(service);
  const algebra = directory.save(student, { schoolId: school.id, details: { name: 'Algebra II', teacher: 'Ms. Ortiz', room: '204', grades: ['9'] } });
  const senior = directory.save(student, { schoolId: school.id, details: { name: 'Calculus', teacher: 'Mr. Lee', room: '301', grades: ['12'] } });
  return { db, service, student, loner, school, algebra, senior, scan: new ScanService(service, config, fetcher), fetcher };
}
const firstPeriod = exampleSchedule.periods[0];

describe('timetable scanning', () => {
  it('is hidden until an API URL and model are configured', async () => {
    expect(scanConfig({})).toBeNull();
    expect(scanConfig({ SCAN_API_URL: 'https://api.example/v1/', SCAN_MODEL: 'm' })).toEqual({ url: 'https://api.example/v1', key: '', model: 'm' });
    expect(scanConfig({ SCAN_API_URL: 'https://api.example/v1/chat/completions', SCAN_MODEL: 'm' })).toMatchObject({ url: 'https://api.example/v1' });
    expect(scanConfig({ SCAN_API_URL: 'https://api.example/v1', SCAN_MODEL: 'm', SCAN_MODEL_REASONING: ' Low ' })).toMatchObject({ reasoning: 'low' });
    expect(() => scanConfig({ SCAN_API_URL: 'https://api.example/v1', SCAN_MODEL: 'm', SCAN_MODEL_REASONING: 'turbo' })).toThrow('SCAN_MODEL_REASONING');
    const f = fixture();
    expect(new ScanService(f.service, null).enabled()).toBe(false);
    expect(f.scan.enabled()).toBe(true);
    await expect(new ScanService(f.service, null).scan(f.student, image)).rejects.toThrow('not set up');
  });

  it('requires a school and validates the upload before spending a request', async () => {
    const f = fixture();
    await expect(f.scan.scan(f.loner, image)).rejects.toThrow('Join a school');
    await expect(f.scan.scan(f.student, { mediaType: 'image/gif' as never, image: image.image })).rejects.toThrow();
    await expect(f.scan.scan(f.student, { ...image, image: 'not base64!' })).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('sends the photo, the period IDs and only the grade-matched directory to the model', async () => {
    const f = fixture();
    await f.scan.scan(f.student, image);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = f.fetcher.mock.calls[0];
    expect(url).toBe('https://vision.example/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('test-vision');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.reasoning_effort).toBeUndefined();
    // Reasoning models reject a non-default temperature, so none is sent unless configured.
    expect('temperature' in body).toBe(false);
    const parts = body.messages[1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts[1].image_url?.url).toBe(`data:image/jpeg;base64,${image.image}`);
    expect(parts[0].text).toContain(`id "${firstPeriod.id}"`);
    expect(parts[0].text).toContain(`id "${f.algebra.id}"`);
    expect(parts[0].text).not.toContain(f.senior.id);
    expect(parts).toHaveLength(2);
  });

  it('sends every photo of a multi-photo scan as its own high-detail image part, in order', async () => {
    const f = fixture();
    const images = [photo('left half'), photo('right half', 'image/png'), photo('back')];
    await f.scan.scan(f.student, { images });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const parts = JSON.parse(f.fetcher.mock.calls[0][1].body as string).messages[1].content as Array<{ type: string; text?: string; image_url?: { url: string; detail: string } }>;
    expect(parts.map(part => part.type)).toEqual(['text', 'image_url', 'image_url', 'image_url']);
    expect(parts.slice(1).map(part => part.image_url)).toEqual(images.map(entry => ({ url: `data:${entry.mediaType};base64,${entry.image}`, detail: 'high' })));
    expect(parts[0].text).toContain('3 attached photos');
    expect(parts[0].text).toContain('parts of one timetable');
    expect(parts[0].text).toContain('merge them into one list of classes');
    const audit = f.db.prepare("SELECT detail FROM audit_log WHERE action='schedule.scan'").all() as Array<{ detail: string }>;
    expect(audit.map(row => JSON.parse(row.detail))).toEqual([{ model: 'test-vision', images: 3 }]);
  });

  it('accepts the legacy single-photo shape and rejects more than three photos or none', async () => {
    expect(scanInputSchema.parse({ ...image, accountId: 'ignored' })).toEqual({ images: [image] });
    expect(scanInputSchema.parse({ images: [image] })).toEqual({ images: [image] });
    const tooMany = scanInputSchema.safeParse({ images: Array.from({ length: MAX_SCAN_IMAGES + 1 }, (_, i) => photo(`page ${i}`)) });
    expect(tooMany.success).toBe(false);
    expect(tooMany.error?.issues[0].message).toBe('You can add up to three photos.');
    expect(scanInputSchema.safeParse({ images: [] }).success).toBe(false);
    expect(scanInputSchema.safeParse({ images: [{ ...image, image: 'x'.repeat(1_500_001) }] }).error?.issues[0].message).toContain('too large');
    expect(scanInputSchema.safeParse(null).success).toBe(false);

    const f = fixture();
    await expect(f.scan.scan(f.student, { images: Array.from({ length: MAX_SCAN_IMAGES + 1 }, () => image) })).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
    await f.scan.scan(f.student, image);
    const parts = JSON.parse(f.fetcher.mock.calls[0][1].body as string).messages[1].content as Array<{ type: string; text?: string }>;
    expect(parts.map(part => part.type)).toEqual(['text', 'image_url']);
    expect(parts[0].text).toContain('Read the attached timetable photo');
    expect(parts[0].text).not.toContain('merge');
  });

  it('passes the configured reasoning effort through', async () => {
    const f = fixture();
    const scan = new ScanService(f.service, { ...config, reasoning: 'low' }, f.fetcher);
    await scan.scan(f.student, image);
    const body = JSON.parse(f.fetcher.mock.calls[0][1].body as string);
    expect(body.reasoning_effort).toBe('low');
    expect('temperature' in body).toBe(false);
  });

  it('sends a temperature only when SCAN_MODEL_TEMPERATURE sets one', async () => {
    const env = { SCAN_API_URL: 'https://api.example/v1', SCAN_MODEL: 'm' };
    expect(scanConfig(env)).not.toHaveProperty('temperature');
    expect(scanConfig({ ...env, SCAN_MODEL_TEMPERATURE: ' ' })).not.toHaveProperty('temperature');
    expect(scanConfig({ ...env, SCAN_MODEL_TEMPERATURE: '0' })).toMatchObject({ temperature: 0 });
    expect(scanConfig({ ...env, SCAN_MODEL_TEMPERATURE: '0.2' })).toMatchObject({ temperature: 0.2 });
    expect(() => scanConfig({ ...env, SCAN_MODEL_TEMPERATURE: 'cold' })).toThrow('SCAN_MODEL_TEMPERATURE');
    expect(() => scanConfig({ ...env, SCAN_MODEL_TEMPERATURE: '3' })).toThrow('SCAN_MODEL_TEMPERATURE');
    const f = fixture();
    const scan = new ScanService(f.service, { ...config, temperature: 0 }, f.fetcher);
    await scan.scan(f.student, image);
    expect(JSON.parse(f.fetcher.mock.calls[0][1].body as string).temperature).toBe(0);
  });

  it('keeps only verified periods and directory matches, filling details from the directory', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(answer([
      { className: 'algebra ii', periodId: firstPeriod.id, directoryId: f.algebra.id, days: ['Mon', 'Wed'] },
      { className: 'Chemistry', teacher: 'Dr. Vance', periodLabel: exampleSchedule.periods[1].label, directoryId: 'bogus' },
      { className: 'History', periodId: 'no-such-period', periodLabel: 'Block Z' },
      { className: 'Chemistry', periodLabel: exampleSchedule.periods[1].label },
      { className: '' },
      'garbage',
    ]));
    const result = await f.scan.scan(f.student, image);
    expect(result.model).toBe('test-vision');
    expect(result.rows).toEqual([
      { name: 'Algebra II', teacher: 'Ms. Ortiz', room: '204', periodIds: [firstPeriod.id], periodLabel: undefined, directoryId: f.algebra.id, days: ['Mon', 'Wed'] },
      { name: 'Chemistry', teacher: 'Dr. Vance', room: undefined, periodIds: [exampleSchedule.periods[1].id], periodLabel: undefined, directoryId: undefined, days: [] },
      { name: 'History', teacher: undefined, room: undefined, periodIds: [], periodLabel: 'Block Z', directoryId: undefined, days: [] },
    ]);
    expect(result.notes).toEqual(['Skipped a line the scanner could not read.']);
  });

  it('keeps one row per class with every period it meets in', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(answer([
      { className: 'Band', periodIds: ['A', 'c', 'nope'], periodLabel: 'Various periods' },
      { className: 'Band', periodId: 'A' },
      { className: 'Choir', periodIds: [], periodLabel: 'Various periods' },
      { className: 'Art', periodIds: ['Lunch'] },
    ]));
    const { rows } = await f.scan.scan(f.student, image);
    expect(rows.map(row => [row.name, row.periodIds, row.periodLabel])).toEqual([
      ['Band', ['A', 'C'], undefined], ['Choir', [], 'Various periods'], ['Art', ['lunch'], undefined],
    ]);
  });

  it('merges a class seen twice, filling in the directory link, teacher, room and days the first sighting lacked', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(answer([
      { className: 'algebra ii', periodIds: [firstPeriod.id], teacher: null, room: null, directoryId: null, days: ['Mon'] },
      { className: 'Algebra II', periodIds: [exampleSchedule.periods[1].id], directoryId: f.algebra.id, days: ['Wed', 'Mon'] },
      { className: 'Chemistry', teacher: 'Dr. Vance', periodLabel: 'Block Z' },
      { className: 'chemistry', teacher: 'Mr. Other', room: '12', periodLabel: 'Block Y' },
    ]));
    const { rows } = await f.scan.scan(f.student, image);
    expect(rows).toEqual([
      { name: 'Algebra II', teacher: 'Ms. Ortiz', room: '204', periodIds: [firstPeriod.id, exampleSchedule.periods[1].id], periodLabel: undefined, directoryId: f.algebra.id, days: ['Mon', 'Wed'] },
      // The first sighting's teacher and period text stand; only the missing room is filled in.
      { name: 'Chemistry', teacher: 'Dr. Vance', room: '12', periodIds: [], periodLabel: 'Block Z', directoryId: undefined, days: [] },
    ]);
  });

  it('keeps classes named in other scripts apart and never matches a label on an empty key', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(answer([
      { className: '数学', periodId: 'A' }, { className: '物理', periodId: 'B' }, { className: 'Алгебра', periodId: 'C' },
      { className: 'Русский 1', periodId: 'D' }, { className: 'Химия 1', periodId: 'lunch' }, { className: 'АЛГЕБРА', periodId: 'A' },
    ]));
    const { rows } = await f.scan.scan(f.student, image);
    expect(rows.map(row => [row.name, row.periodIds])).toEqual([
      ['数学', ['A']], ['物理', ['B']], ['Алгебра', ['C', 'A']], ['Русский 1', ['D']], ['Химия 1', ['lunch']],
    ]);
    const starred = { ...exampleSchedule, periods: exampleSchedule.periods.map((period, index) => (index === 0 ? { ...period, label: '★' } : period)) };
    const body = JSON.stringify({ rows: [{ className: 'Art', periodLabel: '—' }, { className: 'Band', periodLabel: '*' }] });
    expect(f.scan.interpret(body, starred, []).rows.map(row => [row.name, row.periodIds, row.periodLabel])).toEqual([
      ['Art', [], '—'], ['Band', [], '*'],
    ]);
  });

  it('drops a directory ID whose class does not match the printed name', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(answer([
      { className: 'Chemistry', periodId: firstPeriod.id, directoryId: f.algebra.id },
      { periodId: exampleSchedule.periods[1].id, directoryId: f.algebra.id },
    ]));
    const { rows } = await f.scan.scan(f.student, image);
    expect(rows).toEqual([
      { name: 'Chemistry', teacher: undefined, room: undefined, periodIds: [firstPeriod.id], periodLabel: undefined, directoryId: undefined, days: [] },
      // With no printed name, the directory class names the row.
      { name: 'Algebra II', teacher: 'Ms. Ortiz', room: '204', periodIds: [exampleSchedule.periods[1].id], periodLabel: undefined, directoryId: f.algebra.id, days: [] },
    ]);
  });

  it('keeps a directory link for a shortened or reordered printed name, and shows the name as printed', async () => {
    const f = fixture();
    const spanish = new DirectoryService(f.service).save(f.student, { schoolId: f.school.id, details: { name: 'Spanish 2 Honors', teacher: 'Sra. Diaz', room: '110', grades: ['9'] } });
    f.fetcher.mockResolvedValue(answer([
      { className: 'Alg II', teacher: 'Ms. Ortiz', periodId: firstPeriod.id, directoryId: f.algebra.id },
      { className: 'Honors Spanish 2', periodId: exampleSchedule.periods[1].id, directoryId: spanish.id },
      // The same directory class under its full name on a second photo is still one row.
      { className: 'Algebra II', periodId: exampleSchedule.periods[2].id, directoryId: f.algebra.id, days: ['Fri'] },
    ]));
    const { rows } = await f.scan.scan(f.student, image);
    expect(rows).toEqual([
      { name: 'Alg II', teacher: 'Ms. Ortiz', room: '204', periodIds: [firstPeriod.id, exampleSchedule.periods[2].id], periodLabel: undefined, directoryId: f.algebra.id, days: ['Fri'] },
      { name: 'Spanish 2 Honors', teacher: 'Sra. Diaz', room: '110', periodIds: [exampleSchedule.periods[1].id], periodLabel: undefined, directoryId: spanish.id, days: [] },
    ]);
  });

  it('drops a directory link to a class whose name has a word the printed name lacks, so the two rows stay apart', async () => {
    const f = fixture();
    const art = new DirectoryService(f.service).save(f.student, { schoolId: f.school.id, details: { name: 'Art', teacher: 'Ms. Kahlo', room: 'A1', grades: ['9'] } });
    f.fetcher.mockResolvedValue(answer([
      { className: 'Art', periodId: 'A', directoryId: art.id },
      { className: 'Art History', periodId: 'B', directoryId: art.id },
    ]));
    const { rows } = await f.scan.scan(f.student, image);
    expect(rows).toEqual([
      { name: 'Art', teacher: 'Ms. Kahlo', room: 'A1', periodIds: ['A'], periodLabel: undefined, directoryId: art.id, days: [] },
      { name: 'Art History', teacher: undefined, room: undefined, periodIds: ['B'], periodLabel: undefined, directoryId: undefined, days: [] },
    ]);
  });

  it('keeps class names that differ only in a vowel sign apart', async () => {
    const f = fixture();
    const fort = new DirectoryService(f.service).save(f.student, { schoolId: f.school.id, details: { name: 'किला', grades: ['9'] } });
    f.fetcher.mockResolvedValue(answer([
      { className: 'किला', periodId: 'A' },
      { className: 'कोला', periodId: 'B', directoryId: fort.id },
    ]));
    const { rows } = await f.scan.scan(f.student, image);
    expect(rows.map(row => [row.name, row.periodIds, row.directoryId])).toEqual([['किला', ['A'], undefined], ['कोला', ['B'], undefined]]);
  });

  it('tolerates fenced JSON and reports unusable answers', async () => {
    const fenced = fixture(vi.fn<ScanFetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"rows":[{"className":"Art"}]}\n```' } }] }))));
    expect((await fenced.scan.scan(fenced.student, image)).rows.map(row => row.name)).toEqual(['Art']);
    const empty = fixture(vi.fn<ScanFetch>().mockResolvedValue(answer([])));
    expect((await empty.scan.scan(empty.student, image)).notes[0]).toContain('No classes were found');
    const prose = fixture(vi.fn<ScanFetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'I cannot help with that.' } }] }))));
    await expect(prose.scan.scan(prose.student, image)).rejects.toThrow('unexpected format');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const html = fixture(vi.fn<ScanFetch>().mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 200 })));
    await expect(html.scan.scan(html.student, image)).rejects.toThrow('having trouble');
    const errorBody = fixture(vi.fn<ScanFetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 200 })));
    await expect(errorBody.scan.scan(errorBody.student, image)).rejects.toThrow('having trouble');
    expect(error).toHaveBeenCalledWith('[scan] upstream returned an unreadable body');
    error.mockClear();
    const blank = fixture(vi.fn<ScanFetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }))));
    await expect(blank.scan.scan(blank.student, image)).rejects.toThrow('empty answer');
    expect(error).not.toHaveBeenCalled();
    const failing = fixture(vi.fn<ScanFetch>().mockResolvedValue(new Response('quota', { status: 402 })));
    await expect(failing.scan.scan(failing.student, image)).rejects.toThrow('having trouble');
    const offline = fixture(vi.fn<ScanFetch>().mockRejectedValue(new TypeError('fetch failed')));
    await expect(offline.scan.scan(offline.student, image)).rejects.toThrow('Could not reach');
    error.mockRestore();
  });

  it('reports a busy upstream and a scan that runs past the 90 second limit', async () => {
    const busy = fixture(vi.fn<ScanFetch>().mockResolvedValue(new Response('slow down', { status: 429 })));
    await expect(busy.scan.scan(busy.student, image)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS', message: 'The scanning service is busy. Try again in a minute.' });
    const aborted = (signal: AbortSignal | null | undefined) => new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // The model never answers.
      const stalled = fixture(vi.fn<ScanFetch>().mockImplementation((_, init) => aborted(init.signal)));
      const first = expect(stalled.scan.scan(stalled.student, image)).rejects.toMatchObject({ code: 'TIMEOUT', message: expect.stringContaining('took too long') });
      await vi.advanceTimersByTimeAsync(90_000);
      await first;
      // Headers arrive but the body is still streaming when the limit hits: still a timeout, not an unreadable answer.
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const streaming = fixture(vi.fn<ScanFetch>().mockImplementation(async (_, init) => ({ ok: true, status: 200, json: () => aborted(init.signal) }) as unknown as Response));
      const second = expect(streaming.scan.scan(streaming.student, image)).rejects.toMatchObject({ code: 'TIMEOUT', message: expect.stringContaining('took too long') });
      await vi.advanceTimersByTimeAsync(90_000);
      await second;
      // A timeout is not the upstream's fault, so it logs no unreadable-body line.
      expect(error).not.toHaveBeenCalled();
      error.mockRestore();
    } finally { vi.useRealTimers(); }
  });

  it('rate limits each account and counts attempts even when the model fails', async () => {
    const f = fixture(vi.fn<ScanFetch>().mockResolvedValue(new Response('boom', { status: 500 })));
    for (let i = 0; i < SCAN_HOURLY_LIMIT; i++) await expect(f.scan.scan(f.student, image)).rejects.toThrow('having trouble');
    await expect(f.scan.scan(f.student, image)).rejects.toThrow(`You can scan up to ${SCAN_HOURLY_LIMIT} timetables per hour. Try again later.`);
    expect(f.fetcher).toHaveBeenCalledTimes(SCAN_HOURLY_LIMIT);
  });

  it('counts a multi-photo scan once against the quota, and enforces the daily limit', async () => {
    const f = fixture(vi.fn<ScanFetch>().mockImplementation(async () => answer([])));
    const scans = { images: [photo('left'), photo('right')] };
    for (let i = 0; i < SCAN_HOURLY_LIMIT; i++) await f.scan.scan(f.student, scans);
    await expect(f.scan.scan(f.student, scans)).rejects.toThrow(`You can scan up to ${SCAN_HOURLY_LIMIT} timetables per hour.`);
    expect(f.fetcher).toHaveBeenCalledTimes(SCAN_HOURLY_LIMIT);
    // Age the hour's scans and top up the day so only the daily limit applies.
    const earlier = new Date(Date.now() - 2 * 3_600_000).toISOString();
    f.db.prepare("UPDATE audit_log SET created_at=? WHERE action='schedule.scan'").run(earlier);
    const insert = f.db.prepare('INSERT INTO audit_log(actor_id,action,school_id,detail,created_at) VALUES(?,?,?,?,?)');
    for (let i = SCAN_HOURLY_LIMIT; i < SCAN_DAILY_LIMIT; i++) insert.run(f.student, 'schedule.scan', f.school.id, '{}', earlier);
    await expect(f.scan.scan(f.student, scans)).rejects.toThrow(`You can scan up to ${SCAN_DAILY_LIMIT} timetables per day. Try again tomorrow.`);
  });
});
