import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { DirectoryService } from './directory';
import { ScanService, scanConfig, SCAN_HOURLY_LIMIT, type ScanFetch } from './scan';
import { exampleSchedule } from '@/domain/example';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const config = { url: 'https://vision.example/v1', key: 'secret', model: 'test-vision' };
const image = { mediaType: 'image/jpeg' as const, image: Buffer.from('photo').toString('base64') };
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
    const parts = body.messages[1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts[1].image_url?.url).toBe(`data:image/jpeg;base64,${image.image}`);
    expect(parts[0].text).toContain(`id "${firstPeriod.id}"`);
    expect(parts[0].text).toContain(`id "${f.algebra.id}"`);
    expect(parts[0].text).not.toContain(f.senior.id);
  });

  it('passes the configured reasoning effort through', async () => {
    const f = fixture();
    const scan = new ScanService(f.service, { ...config, reasoning: 'low' }, f.fetcher);
    await scan.scan(f.student, image);
    expect(JSON.parse(f.fetcher.mock.calls[0][1].body as string).reasoning_effort).toBe('low');
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
      { name: 'Algebra II', teacher: 'Ms. Ortiz', room: '204', periodId: firstPeriod.id, periodLabel: undefined, directoryId: f.algebra.id, days: ['Mon', 'Wed'] },
      { name: 'Chemistry', teacher: 'Dr. Vance', room: undefined, periodId: exampleSchedule.periods[1].id, periodLabel: undefined, directoryId: undefined, days: [] },
      { name: 'History', teacher: undefined, room: undefined, periodId: undefined, periodLabel: 'Block Z', directoryId: undefined, days: [] },
    ]);
    expect(result.notes).toEqual(['Skipped a line the scanner could not read.']);
  });

  it('splits a class that meets in several periods into one row per period', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(answer([
      { className: 'Band', periodIds: ['A', 'c', 'nope'], periodLabel: 'Various periods' },
      { className: 'Band', periodId: 'A' },
      { className: 'Choir', periodIds: [], periodLabel: 'Various periods' },
      { className: 'Art', periodIds: ['Lunch'] },
    ]));
    const { rows } = await f.scan.scan(f.student, image);
    expect(rows.map(row => [row.name, row.periodId, row.periodLabel])).toEqual([
      ['Band', 'A', undefined], ['Band', 'C', undefined], ['Choir', undefined, 'Various periods'], ['Art', 'lunch', undefined],
    ]);
  });

  it('tolerates fenced JSON and reports unusable answers', async () => {
    const fenced = fixture(vi.fn<ScanFetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"rows":[{"className":"Art"}]}\n```' } }] }))));
    expect((await fenced.scan.scan(fenced.student, image)).rows.map(row => row.name)).toEqual(['Art']);
    const empty = fixture(vi.fn<ScanFetch>().mockResolvedValue(answer([])));
    expect((await empty.scan.scan(empty.student, image)).notes[0]).toContain('No classes were found');
    const prose = fixture(vi.fn<ScanFetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'I cannot help with that.' } }] }))));
    await expect(prose.scan.scan(prose.student, image)).rejects.toThrow('unexpected format');
    const failing = fixture(vi.fn<ScanFetch>().mockResolvedValue(new Response('quota', { status: 402 })));
    await expect(failing.scan.scan(failing.student, image)).rejects.toThrow('HTTP 402');
    const offline = fixture(vi.fn<ScanFetch>().mockRejectedValue(new TypeError('fetch failed')));
    await expect(offline.scan.scan(offline.student, image)).rejects.toThrow('Could not reach');
  });

  it('rate limits each account and counts attempts even when the model fails', async () => {
    const f = fixture(vi.fn<ScanFetch>().mockResolvedValue(new Response('boom', { status: 500 })));
    for (let i = 0; i < SCAN_HOURLY_LIMIT; i++) await expect(f.scan.scan(f.student, image)).rejects.toThrow('HTTP 500');
    await expect(f.scan.scan(f.student, image)).rejects.toThrow('per hour');
    expect(f.fetcher).toHaveBeenCalledTimes(SCAN_HOURLY_LIMIT);
  });
});
