import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { AiService, CodexError, aiConfig, decryptKey, interpretSort, ownerCodexConfig, type AiConfig, type AiFetch, type CodexConfig, type CodexRun } from './ai';
import { AI_BREAKDOWN_DAILY_LIMIT, AI_HOURLY_LIMIT, AI_PROVIDERS, AI_SORT_DAILY_LIMIT } from '@/domain/ai';
import { exampleSchedule } from '@/domain/example';
import { emptyPersonalSchedule, type PersonalSchedule } from '@/domain/schedule';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const SECRET = 'test-only-secret-that-is-at-least-32-characters';
const server: AiConfig = { url: 'https://ai.example/v1', key: 'server-key', model: 'cheap-model', json: true, openRouter: false };
const reply = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { status: 200 });

const bio = '11111111-1111-4111-8111-111111111111';
const spanish = '22222222-2222-4222-8222-222222222222';

function fixture(options: { config?: AiConfig | null; inBeta?: boolean; fetcher?: Mock<AiFetch>; owner?: boolean; codex?: CodexConfig | null; runCodex?: Mock<CodexRun> } = {}) {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const id = randomUUID();
  db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, options.owner ? 'owner@example.com' : `${id}@example.com`, 'Student', 'Student Name', new Date().toISOString());
  const school = service.createSchool(id, { name: 'AI High', location: 'Boston, MA', schedule: exampleSchedule });
  service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
  const personal: PersonalSchedule = { ...emptyPersonalSchedule(), classes: [{ id: bio, name: 'Biology', teacher: 'Ms. Reed' }, { id: spanish, name: 'Spanish 3' }], assignments: { [exampleSchedule.periods[0].id]: bio } };
  db.prepare("INSERT OR REPLACE INTO entities(owner_id,id,kind,version,data,deleted) VALUES(?,'personal','personal',1,?,0)").run(id, JSON.stringify(personal));
  const fetcher = options.fetcher ?? vi.fn<AiFetch>().mockResolvedValue(reply({ tasks: [] }));
  const ai = new AiService(service, { config: options.config === undefined ? server : options.config, fetcher, secret: SECRET, inBeta: () => options.inBeta ?? true, origin: 'https://quasar.example', codex: options.codex ?? null, runCodex: options.runCodex });
  return { db, service, student: id, ai, fetcher };
}
const task = (id: string, title: string, extra: Partial<{ notes: string; dueDate: string | null; dueTime: string | null; classId: string | null }> = {}) =>
  ({ id, title, notes: extra.notes ?? '', dueDate: extra.dueDate ?? null, dueTime: extra.dueTime ?? null, classId: extra.classId ?? null, priority: null });
const sentBody = (fetcher: Mock<AiFetch>, call = 0) => JSON.parse(String(fetcher.mock.calls[call][1].body)) as { model: string; messages: Array<{ role: string; content: string }>; response_format?: unknown };

describe('AI task helpers', () => {
  it('uses AI_* settings first and falls back to the scan model', () => {
    expect(aiConfig({})).toBeNull();
    expect(aiConfig({ AI_API_URL: 'https://a.example/v1/chat/completions', AI_MODEL: 'm', AI_API_KEY: 'k', SCAN_API_URL: 'https://s.example/v1', SCAN_MODEL: 's' }))
      .toEqual({ url: 'https://a.example/v1', key: 'k', model: 'm', json: true, openRouter: false });
    // The scan's OpenRouter routing variant is left off; the request asks for the cheapest provider instead.
    expect(aiConfig({ SCAN_API_URL: 'https://openrouter.ai/api/v1', SCAN_MODEL: '~openai/gpt-luna-latest', SCAN_MODEL_REASONING: 'low' }))
      .toMatchObject({ model: '~openai/gpt-luna-latest', reasoning: 'low', openRouter: true });
    expect(() => aiConfig({ AI_API_URL: 'https://a.example/v1', AI_MODEL: 'm', AI_MODEL_REASONING: 'turbo' })).toThrow('AI_MODEL_REASONING');
  });

  it('is only for members of the ai-tasks beta', async () => {
    const f = fixture({ inBeta: false });
    expect(f.ai.status(f.student)).toEqual({ beta: false });
    await expect(f.ai.sort(f.student, { tasks: [task('t1', 'Quiz')] })).rejects.toThrow('beta');
    await expect(f.ai.breakdown(f.student, { title: 'Essay', notes: '', dueDate: null, classId: null })).rejects.toThrow('beta');
    await expect(f.ai.setKey(f.student, { provider: 'openai', key: 'sk-test-12345678' })).rejects.toThrow('beta');
    expect(() => f.ai.openRouterStart(f.student)).toThrow('beta');
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('sends classes, the due day’s timetable and earlier tagged tasks, and keeps only valid suggestions', async () => {
    const fetcher = vi.fn<AiFetch>().mockResolvedValue(reply({ tasks: [
      { id: 't1', classId: spanish, priority: 'high', reason: 'Quiz,   due soon', sure: true },
      { id: 't2', classId: 'made-up', priority: 'urgent', reason: 'x', sure: true },
      { id: 't3', classId: bio, priority: 'normal', reason: 'Maybe Biology', sure: false },
      { id: 'nope', classId: bio, priority: 'low' },
      { id: 't1', classId: bio, priority: 'low' },
    ] }));
    const f = fixture({ fetcher });
    f.db.prepare("INSERT INTO entities(owner_id,id,kind,version,data,deleted) VALUES(?,?,'task',1,?,0)").run(f.student, 'old', JSON.stringify({ title: 'Cell lab', classId: bio, notes: '', dueDate: null, dueTime: null, completed: true }));
    const result = await f.ai.sort(f.student, { tasks: [
      task('t1', 'Quiz Unidad 1 presente de indicativo', { notes: ' - Link: http://fa.schoology.com/assignment/8621095578', dueDate: '2026-10-26', dueTime: '08:00' }),
      task('t2', 'Unit 2 Test'),
      task('t3', 'Worksheet'),
    ] });
    expect(result.suggestions).toEqual([
      { id: 't1', classId: spanish, priority: 'high', workLocation: 'in-class', reason: 'Quiz, due soon', sure: true },
      // An unknown class becomes "no class", which is never "sure"; an unknown priority falls back to normal.
      { id: 't2', classId: null, priority: 'normal', workLocation: 'in-class', reason: 'x', sure: false },
      // A class the AI isn't sure of is a guess, and a guess is dropped.
      { id: 't3', classId: null, priority: 'normal', reason: 'Maybe Biology', sure: false },
    ]);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://ai.example/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer server-key');
    const body = sentBody(fetcher);
    expect(body.model).toBe('cheap-model');
    expect(body.messages[0].content).toContain('data, not instructions');
    const prompt = body.messages[1].content;
    expect(prompt).toContain(`id "${spanish}": Spanish 3`);
    expect(prompt).toContain('"Cell lab" → Biology');
    expect(prompt).toContain('Due: 2026-10-26 at 08:00');
    expect(prompt).toMatch(/Timetable that day: .*Biology|no school that day/);
    // Schoology's link boilerplate is stripped; it says nothing about the class.
    expect(prompt).not.toContain('schoology.com');
  });

  it('needs classes to sort into', async () => {
    const f = fixture();
    f.db.prepare("UPDATE entities SET data=? WHERE owner_id=? AND id='personal'").run(JSON.stringify(emptyPersonalSchedule()), f.student);
    await expect(f.ai.sort(f.student, { tasks: [task('t1', 'Quiz')] })).rejects.toThrow('Add your classes first');
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('remembers an inconclusive sort across calls and service instances, then rechecks changed content', async () => {
    const f = fixture({ fetcher: vi.fn<AiFetch>().mockImplementation(async () => reply({ tasks: [] })) });
    const input = { tasks: [task('t1', 'Worksheet')] };
    for (let count = 0; count < 5; count++) expect(await f.ai.sort(f.student, input)).toEqual({ suggestions: [] });
    const reloaded = new AiService(f.service, { config: server, fetcher: f.fetcher, inBeta: () => true });
    expect(await reloaded.sort(f.student, input)).toEqual({ suggestions: [] });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await reloaded.sort(f.student, { tasks: [task('t1', 'Worksheet', { notes: 'Complete 10 questions at home' })] });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it('limits the server’s model per day and per hour, before sending', async () => {
    const f = fixture();
    for (let i = 0; i < AI_SORT_DAILY_LIMIT; i++) f.service.audit(f.student, 'ai.sort', null, { own: 0 }, new Date(Date.now() - 2 * 3_600_000).toISOString());
    await expect(f.ai.sort(f.student, { tasks: [task('t1', 'Quiz')] })).rejects.toThrow(`today’s ${AI_SORT_DAILY_LIMIT} free sorts`);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.ai.status(f.student)).toMatchObject({ beta: true, available: true, own: null, quota: { sort: { used: AI_SORT_DAILY_LIMIT, limit: AI_SORT_DAILY_LIMIT }, breakdown: { used: 0, limit: AI_BREAKDOWN_DAILY_LIMIT } } });
    const g = fixture();
    for (let i = 0; i < AI_HOURLY_LIMIT; i++) g.service.audit(g.student, 'ai.breakdown', null, { own: 1 });
    await expect(g.ai.breakdown(g.student, { title: 'Essay', notes: '', dueDate: null, classId: null })).rejects.toThrow('an hour');
  });

  it('checks a pasted key, stores it encrypted, and then runs on it without the daily quota', async () => {
    const fetcher = vi.fn<AiFetch>().mockResolvedValueOnce(reply({ ok: true })).mockResolvedValue(reply({ steps: ['  Read pages 41-45 ', 'Answer Q1-Q10', '', 3] }));
    const f = fixture({ fetcher, config: null });
    expect(f.ai.status(f.student)).toMatchObject({ beta: true, available: false, server: false });
    const status = await f.ai.setKey(f.student, { provider: 'deepseek', key: 'sk-secret-abcd1234' });
    expect(fetcher.mock.calls[0][0]).toBe(`${AI_PROVIDERS.deepseek.url}/chat/completions`);
    expect(status).toMatchObject({ available: true, own: { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-chat', hint: '…1234', via: 'key' } });
    expect(JSON.stringify(status)).not.toContain('sk-secret');
    const row = f.db.prepare('SELECT key_encrypted FROM ai_credentials WHERE user_id=?').get(f.student) as { key_encrypted: string };
    expect(row.key_encrypted).not.toContain('sk-secret');
    expect(decryptKey(row.key_encrypted, SECRET)).toBe('sk-secret-abcd1234');
    for (let i = 0; i < AI_BREAKDOWN_DAILY_LIMIT; i++) f.service.audit(f.student, 'ai.breakdown', null, { own: 0 }, new Date(Date.now() - 2 * 3_600_000).toISOString());
    const { steps } = await f.ai.breakdown(f.student, { title: 'Sleigh Elf HW', notes: 'Elf: Beg-m.41', dueDate: '2026-10-26', classId: bio });
    expect(steps).toEqual(['Read pages 41-45', 'Answer Q1-Q10']);
    const [url, init] = fetcher.mock.calls[1];
    expect(url).toBe(`${AI_PROVIDERS.deepseek.url}/chat/completions`);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-secret-abcd1234');
    expect(sentBody(fetcher, 1).messages[1].content).toContain('Class: Biology');
    expect(f.ai.removeKey(f.student)).toMatchObject({ available: false, own: null });
  });

  it('explains a refused key and does not save it', async () => {
    const f = fixture({ fetcher: vi.fn<AiFetch>().mockResolvedValue(new Response('{"error":"bad key"}', { status: 401 })) });
    await expect(f.ai.setKey(f.student, { provider: 'anthropic', key: 'sk-ant-wrong-key' })).rejects.toThrow('Anthropic refused your API key');
    expect(f.db.prepare('SELECT 1 FROM ai_credentials').get()).toBeUndefined();
    // Anthropic's and Google's compatible endpoints get no response_format.
    expect(sentBody(f.fetcher).response_format).toBeUndefined();
    await expect(f.ai.setKey(f.student, { provider: 'openai', key: 'has a space in it' })).rejects.toThrow();
    await expect(f.ai.setKey(f.student, { provider: 'evil' as never, key: 'sk-12345678' })).rejects.toThrow();
  });

  it('asks for the key again when the server secret changed', async () => {
    const f = fixture({ fetcher: vi.fn<AiFetch>().mockResolvedValue(reply({ ok: true })) });
    await f.ai.setKey(f.student, { provider: 'openai', key: 'sk-test-12345678' });
    const rotated = new AiService(f.service, { config: server, fetcher: f.fetcher, secret: `${SECRET}-rotated`, inBeta: () => true });
    await expect(rotated.breakdown(f.student, { title: 'Essay', notes: '', dueDate: null, classId: null })).rejects.toThrow('Add it again in Account');
  });

  it('connects OpenRouter with a server-kept PKCE verifier and state', async () => {
    const fetcher = vi.fn<AiFetch>().mockResolvedValue(new Response(JSON.stringify({ key: 'sk-or-v1-issuedkey9876' }), { status: 200 }));
    const f = fixture({ fetcher });
    const { url } = f.ai.openRouterStart(f.student);
    const params = new URL(url).searchParams;
    expect(url.startsWith('https://openrouter.ai/auth?')).toBe(true);
    expect(params.get('callback_url')).toBe('https://quasar.example/tasks');
    expect(params.get('code_challenge_method')).toBe('S256');
    await expect(f.ai.openRouterFinish(f.student, { code: 'abc', state: 'wrong' })).rejects.toThrow('expired');
    // A wrong state also spends the started connection.
    await expect(f.ai.openRouterFinish(f.student, { code: 'abc', state: params.get('state')! })).rejects.toThrow('expired');
    expect(fetcher).not.toHaveBeenCalled();
    const again = new URL(f.ai.openRouterStart(f.student).url).searchParams;
    const status = await f.ai.openRouterFinish(f.student, { code: 'the-code', state: again.get('state')! });
    const [exchange, init] = fetcher.mock.calls[0];
    expect(exchange).toBe('https://openrouter.ai/api/v1/auth/keys');
    const body = JSON.parse(String(init.body)) as { code: string; code_verifier: string; code_challenge_method: string };
    expect(body).toMatchObject({ code: 'the-code', code_challenge_method: 'S256' });
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(again.get('code_challenge'));
    expect(status).toMatchObject({ own: { provider: 'openrouter', via: 'openrouter', hint: '…9876' } });
  });

  it('turns provider trouble into 503s with a plain message', async () => {
    const f = fixture({ fetcher: vi.fn<AiFetch>().mockResolvedValue(new Response('<html>', { status: 500 })) });
    await expect(f.ai.breakdown(f.student, { title: 'Essay', notes: '', dueDate: null, classId: null })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(() => interpretSort('not json', [task('t1', 'Quiz')], emptyPersonalSchedule())).toThrow('unexpected format');
  });

  it('reads work-location labels independently of class confidence and rejects invented labels', () => {
    const results = interpretSort(JSON.stringify({ tasks: [
      { id: 't1', classId: null, priority: 'normal', workLocation: 'in-class', sure: false },
      { id: 't2', classId: null, priority: 'normal', workLocation: 'out-of-class', sure: false },
      { id: 't3', classId: null, priority: 'normal', workLocation: 'wherever', sure: false },
    ] }), [task('t1', 'In Class Writing'), task('t2', 'Finish the lab notebook'), task('t3', 'Worksheet')], emptyPersonalSchedule());
    expect(results[0]).toMatchObject({ workLocation: 'in-class', classId: null });
    expect(results[1]).toMatchObject({ workLocation: 'out-of-class' });
    expect(results[2]).not.toHaveProperty('workLocation');
  });

  it('runs the owner, and only the owner, on the ChatGPT plan through Codex', async () => {
    expect(ownerCodexConfig({})).toBeNull();
    expect(ownerCodexConfig({ AI_OWNER_CODEX_HOME: '/home/q/.config/quasar-codex' })).toMatchObject({ home: '/home/q/.config/quasar-codex', model: 'gpt-6-luna', reasoning: 'low' });
    const codex: CodexConfig = { home: '/tmp/codex-home', bin: 'codex', model: 'gpt-6-luna', reasoning: 'low' };
    const runCodex = vi.fn<CodexRun>().mockResolvedValue(JSON.stringify({ tasks: [{ id: 't1', classId: spanish, priority: 'high', reason: 'Quiz', sure: true }] }));
    const owner = fixture({ owner: true, codex, runCodex });
    expect(owner.ai.status(owner.student)).toMatchObject({ available: true, chatgpt: true, own: null });
    // The owner's daily free quota is used up, but the ChatGPT plan isn't counted against it.
    for (let i = 0; i < AI_SORT_DAILY_LIMIT; i++) owner.service.audit(owner.student, 'ai.sort', null, { own: 0 }, new Date(Date.now() - 2 * 3_600_000).toISOString());
    const result = await owner.ai.sort(owner.student, { tasks: [task('t1', 'Quiz Unidad 1')] });
    expect(result.suggestions).toEqual([{ id: 't1', classId: spanish, priority: 'high', workLocation: 'in-class', reason: 'Quiz', sure: true }]);
    expect(owner.fetcher).not.toHaveBeenCalled();
    const [config, prompt, schema, deadline] = runCodex.mock.calls[0];
    expect(config).toBe(codex);
    expect(prompt).toContain('data, not instructions');
    expect(prompt).toContain(`id "${spanish}": Spanish 3`);
    expect(schema).toMatchObject({ required: ['tasks'] });
    expect(deadline).toBeLessThanOrEqual(100_000);

    // Anyone else in the beta keeps the server's model, even with Codex configured.
    const member = fixture({ codex, runCodex: vi.fn<CodexRun>() });
    expect(member.ai.status(member.student)).toMatchObject({ chatgpt: false });
    await member.ai.sort(member.student, { tasks: [task('t1', 'Quiz')] });
    expect(member.fetcher).toHaveBeenCalledTimes(1);
  });

  it('says how to sign in again when the Codex login has expired', async () => {
    const codex: CodexConfig = { home: '/tmp/codex-home', bin: 'codex', model: 'gpt-6-luna', reasoning: 'low' };
    const f = fixture({ owner: true, codex, runCodex: vi.fn<CodexRun>().mockRejectedValue(new CodexError('auth', 'refresh token expired')) });
    await expect(f.ai.breakdown(f.student, { title: 'Essay', notes: '', dueDate: null, classId: null })).rejects.toThrow('codex login --device-auth');
    const g = fixture({ owner: true, codex, runCodex: vi.fn<CodexRun>().mockRejectedValue(new CodexError('limit', 'usage limit')) });
    await expect(g.ai.breakdown(g.student, { title: 'Essay', notes: '', dueDate: null, classId: null })).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('classifies tests and quizzes once per task content, checking only new or edited tasks', async () => {
    const fetcher = vi.fn<AiFetch>()
      .mockResolvedValueOnce(reply({ tasks: [{ id: 'a', kind: 'quiz' }, { id: 'b', kind: 'none' }, { id: 'zzz', kind: 'test' }, { id: 'c', kind: 'exam' }] }))
      .mockResolvedValueOnce(reply({ tasks: [{ id: 'b', kind: 'test' }] }));
    const f = fixture({ fetcher });
    const tasks = [{ id: 'a', title: 'Vocab check', notes: '', classId: spanish }, { id: 'b', title: 'Unit 2 review', notes: '', classId: null }, { id: 'c', title: 'Ch. 4', notes: '', classId: bio }];
    // An answer about a task that wasn't sent is ignored; an unknown kind counts as none.
    expect(await f.ai.assessments(f.student, { tasks })).toEqual({ kinds: { a: 'quiz', b: 'none', c: 'none' } });
    const prompt = sentBody(fetcher).messages[1].content;
    expect(prompt).toContain('Class: Spanish 3');
    expect(sentBody(fetcher).messages[0].content).toContain('data, not instructions');
    // Nothing changed: no request at all.
    expect(await f.ai.assessments(f.student, { tasks })).toEqual({ kinds: { a: 'quiz', b: 'none', c: 'none' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // An edited title is checked again, alone.
    expect(await f.ai.assessments(f.student, { tasks: [tasks[0], { ...tasks[1], title: 'Unit 2 Test' }, tasks[2]] })).toEqual({ kinds: { a: 'quiz', b: 'test', c: 'none' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sentBody(fetcher, 1).messages[1].content).toContain('Unit 2 Test');
    expect(sentBody(fetcher, 1).messages[1].content).not.toContain('Vocab check');
  });
});
