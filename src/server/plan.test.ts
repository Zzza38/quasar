import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { AiService, type AiConfig, type AiFetch } from './ai';
import { PlanService, interpretPlan } from './plan';
import { AI_PLAN_DAILY_LIMIT } from '@/domain/ai';
import { exampleSchedule } from '@/domain/example';
import { beforeDue, crunchDays, crunchMessage, formatLoad, freeLabel, isMissed, planSlots } from '@/domain/plan';
import { emptyPersonalSchedule, resolveDay, type PersonalSchedule } from '@/domain/schedule';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const server: AiConfig = { url: 'https://ai.example/v1', key: 'server-key', model: 'cheap-model', json: true, openRouter: false };
const reply = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
const sent = (fetcher: Mock<AiFetch>, call = 0) => JSON.parse(String(fetcher.mock.calls[call][1].body)) as { messages: Array<{ content: string }> };

const bio = '11111111-1111-4111-8111-111111111111';
/** Monday 2 November 2026, 7:00 in New York: before school. */
const NOW = new Date('2026-11-02T12:00:00Z');
const MONDAY = '2026-11-02';
const personal: PersonalSchedule = { ...emptyPersonalSchedule(), classes: [{ id: bio, name: 'Biology' }], assignments: { A: bio } };
/** The slot holding period `periodId` (A is Biology, the rest are free) on `date`. */
const slotOf = (date: string, periodId: string) => resolveDay(exampleSchedule, date, personal).periods.find((period) => period.periodId === periodId)!;
/** The first slot this week with Biology in it. */
function classSlot(): string {
  for (const date of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']) {
    const period = resolveDay(exampleSchedule, date, personal).periods.find((entry) => entry.class);
    if (period) return `${date}~${period.slotId}`;
  }
  throw new Error('Biology never meets');
}

function fixture(options: { fetcher?: Mock<AiFetch>; inBeta?: boolean; plus?: boolean; billing?: boolean } = {}) {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const id = randomUUID();
  db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, 'Student', 'Student Name', new Date().toISOString());
  const school = service.createSchool(id, { name: 'Plan High', location: 'Boston, MA', schedule: exampleSchedule });
  service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
  db.prepare("INSERT OR REPLACE INTO entities(owner_id,id,kind,version,data,deleted) VALUES(?,'personal','personal',1,?,0)").run(id, JSON.stringify(personal));
  const fetcher = options.fetcher ?? vi.fn<AiFetch>().mockImplementation(async () => reply({ blocks: [] }));
  const ai = new AiService(service, { config: server, fetcher, inBeta: () => options.inBeta ?? true, codex: null, plus: () => options.plus ?? false, billing: options.billing ?? false });
  const plan = new PlanService(service, { ai, now: () => NOW });
  const addTask = (title: string, extra: Record<string, unknown> = {}) => {
    const taskId = randomUUID();
    db.prepare("INSERT INTO entities(owner_id,id,kind,version,data,deleted) VALUES(?,?,'task',1,?,0)").run(id, taskId, JSON.stringify({ title, notes: '', dueDate: null, dueTime: null, classId: null, completed: false, ...extra }));
    return taskId;
  };
  return { db, student: id, plan, fetcher, addTask };
}

describe('plan slots', () => {
  it('offers free periods and after school on open days, never a class, lunch or a weekend', () => {
    const slots = planSlots(exampleSchedule, personal, MONDAY, '07:00');
    expect(new Set(slots.map((slot) => slot.date))).toEqual(new Set(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']));
    for (const slot of slots.filter((entry) => entry.kind === 'free')) {
      const period = resolveDay(exampleSchedule, slot.date, personal).periods.find((entry) => `${slot.date}~${entry.slotId}` === slot.id)!;
      expect(period).toMatchObject({ kind: 'class', start: slot.start, end: slot.end });
      expect(period.class).toBeUndefined();
    }
    // Biology meets on Tuesday, so that period isn't offered; lunch never is.
    const biology = classSlot();
    expect(slots.some((slot) => slot.id === biology)).toBe(false);
    expect(slots.some((slot) => slot.id.endsWith('lunch-slot'))).toBe(false);
    const monday = slots.filter((slot) => slot.date === MONDAY);
    expect(monday.map((slot) => slot.label)).toEqual(['Free period B', 'Free period C', 'Free period D', 'After school']);
    expect(monday.at(-1)).toMatchObject({ kind: 'after', start: '12:05', end: '14:35', minutes: 150 });
    // Later in the day only what is still ahead is offered, and after school starts no earlier than now.
    const late = planSlots(exampleSchedule, personal, MONDAY, '14:02').filter((slot) => slot.date === MONDAY);
    expect(late).toEqual([expect.objectContaining({ kind: 'after', start: '14:10', end: '16:40' })]);
  });

  it('names free periods and checks due dates', () => {
    expect(freeLabel('3')).toBe('Free period 3');
    expect(freeLabel('Period 3')).toBe('Free period 3');
    expect(freeLabel('Unassigned block')).toBe('Free block');
    expect(beforeDue({ date: '2026-11-03', end: '23:00' }, '2026-11-04', null)).toBe(true);
    // Due on a date with no time means due as that day starts; with a time, a slot ending by it still counts.
    expect(beforeDue({ date: '2026-11-04', end: '09:00' }, '2026-11-04', null)).toBe(false);
    expect(beforeDue({ date: '2026-11-04', end: '09:00' }, '2026-11-04', '10:00')).toBe(true);
    expect(beforeDue({ date: '2026-11-04', end: '10:30' }, '2026-11-04', '10:00')).toBe(false);
    expect(isMissed({ status: 'planned', date: MONDAY, end: '09:00' }, MONDAY, '09:30')).toBe(true);
    expect(isMissed({ status: 'done', date: '2026-11-01', end: '09:00' }, MONDAY, '09:30')).toBe(false);
  });

  it('warns about a heavy day and says when to start its biggest task', () => {
    const tasks = [
      { id: 'essay', title: 'Essay draft', dueDate: '2026-11-04', completed: false },
      { id: 'lab', title: 'Lab report', dueDate: '2026-11-04', completed: false },
      { id: 'hw', title: 'Worksheet', dueDate: '2026-11-02', completed: false },
      { id: 'done', title: 'Old', dueDate: '2026-11-03', completed: true },
    ];
    const minutes: Record<string, number> = { essay: 120, lab: 80, hw: 20, done: 400 };
    const crunches = crunchDays(tasks, (id) => minutes[id], MONDAY);
    expect(crunches).toEqual([{ date: '2026-11-04', minutes: 200, taskId: 'essay', title: 'Essay draft', startDate: '2026-11-03' }]);
    expect(crunchMessage(crunches[0], MONDAY)).toBe('Wednesday looks heavy: 3 h 20 m. Start “Essay draft” tomorrow.');
    expect(crunchMessage({ ...crunches[0], startDate: MONDAY }, MONDAY)).toMatch(/Start “Essay draft” today\.$/);
    expect(formatLoad(45)).toBe('45 m');
    expect(crunchDays(tasks, (id) => (id === 'essay' ? 100 : undefined), MONDAY)).toEqual([]);
    expect(crunchDays(tasks.map(task => ({ ...task, workLocation: 'in-class' as const })), id => minutes[id], MONDAY)).toEqual([]);
  });
});

describe('Plan my week', () => {
  it('places blocks only in offered slots before the due date, and drops the rest', async () => {
    const fetcher = vi.fn<AiFetch>();
    const f = fixture({ fetcher });
    const test = f.addTask('Study for Unit 4 Test', { dueDate: '2026-11-05', dueTime: '08:00', classId: bio, notes: 'Chapters 3-4 - Link: http://fa.schoology.com/a/1' });
    const essay = f.addTask('Essay on Macbeth', { dueDate: '2026-11-04', priority: 'high' });
    f.addTask('Done already', { dueDate: '2026-11-03', completed: true });
    f.addTask('Next month', { dueDate: '2026-12-20' });
    const freeB = `${MONDAY}~${slotOf(MONDAY, 'B').slotId}`;
    const classA = classSlot();
    fetcher.mockResolvedValue(reply({ blocks: [
      { slotId: freeB, taskId: test, minutes: 33, kind: 'review', title: '  Review   ch. 4   for Bio test ' },
      { slotId: freeB, taskId: essay, minutes: 90, kind: 'work', title: 'Draft the intro' },
      // In a class period, on a Saturday, after the essay is due, an unknown task, a made-up slot: all dropped.
      { slotId: classA, taskId: test, minutes: 30, kind: 'review', title: 'In Biology class' },
      { slotId: '2026-11-07~after', taskId: test, minutes: 30, kind: 'review', title: 'Saturday' },
      { slotId: '2026-11-04~after', taskId: essay, minutes: 30, kind: 'work', title: 'Too late' },
      { slotId: '2026-11-03~after', taskId: 'nope', minutes: 30, kind: 'work', title: 'Unknown' },
      { slotId: '2026-11-03~nowhere', taskId: essay, minutes: 30, kind: 'work', title: 'Made up' },
      { slotId: '2026-11-03~after', taskId: essay, minutes: 500, kind: 'oops', title: '' },
    ] }));
    const result = await f.plan.make(f.student);
    expect(result.dropped).toBe(5);
    expect(result.blocks.map(({ id: _, ...block }) => block)).toEqual([
      { date: MONDAY, start: '08:00', end: '08:35', slotKind: 'free', slotLabel: 'Free period B', taskId: test, title: 'Review ch. 4 for Bio test', kind: 'review', minutes: 35, status: 'planned' },
      // Only what was left of the free period after the first block.
      { date: MONDAY, start: '08:35', end: '09:00', slotKind: 'free', slotLabel: 'Free period B', taskId: essay, title: 'Draft the intro', kind: 'work', minutes: 25, status: 'planned' },
      { date: '2026-11-03', start: '12:05', end: '14:05', slotKind: 'after', slotLabel: 'After school', taskId: essay, title: 'Work on Essay on Macbeth', kind: 'work', minutes: 120, status: 'planned' },
    ]);
    const body = sent(fetcher);
    expect(body.messages[0].content).toContain('data, not instructions');
    const prompt = body.messages[1].content;
    expect(prompt).toContain(`slot "${freeB}"`);
    expect(prompt).not.toContain(`slot "${classA}"`);
    expect(prompt).not.toContain('2026-11-07');
    expect(prompt).toContain('"Study for Unit 4 Test" (Biology; due 2026-11-05 at 08:00');
    expect(prompt).not.toContain('schoology.com');
    expect(prompt).not.toContain('Done already');
    expect(prompt).not.toContain('Next month');
    expect(f.plan.get(f.student).plan).toEqual({ startDate: MONDAY, endDate: '2026-11-08', createdAt: NOW.toISOString() });
    expect(f.db.prepare("SELECT count(*) n FROM audit_log WHERE actor_id=? AND action='ai.plan'").get(f.student)).toEqual({ n: 1 });
  });

  it('tells the model what the test check and estimates found', async () => {
    const f = fixture();
    const quiz = f.addTask('Pop check on cells', { dueDate: '2026-11-04', classId: bio });
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update('Pop check on cells\0').digest('base64url').slice(0, 22);
    f.db.prepare('INSERT INTO ai_task_kinds(owner_id,task_id,content_hash,kind,classified_at) VALUES(?,?,?,?,?)').run(f.student, quiz, hash, 'quiz', NOW.toISOString());
    f.db.prepare('INSERT INTO ai_task_estimates(owner_id,task_id,content_hash,minutes,estimated_at) VALUES(?,?,?,?,?)').run(f.student, quiz, `v2:${hash}`, 40, NOW.toISOString());
    await f.plan.make(f.student);
    expect(sent(f.fetcher).messages[1].content).toContain('quiz; estimate 40 min');
  });

  it('replans planned and missed blocks, keeps done and skipped ones, and marks blocks', async () => {
    const fetcher = vi.fn<AiFetch>();
    const f = fixture({ fetcher });
    const test = f.addTask('Study for Unit 4 Test', { dueDate: '2026-11-06' });
    const insert = f.db.prepare(`INSERT INTO ai_plan_blocks(owner_id,id,date,start,end,slot_kind,slot_label,task_id,title,kind,minutes,status,created_at,updated_at) VALUES(?,?,?,?,?,'after','After school',?,?,'review',30,?,?,?)`);
    insert.run(f.student, 'done-1', '2026-10-30', '15:00', '15:30', test, 'Read ch. 3', 'done', NOW.toISOString(), NOW.toISOString());
    insert.run(f.student, 'missed-1', '2026-10-30', '15:30', '16:00', test, 'Flashcards ch. 3', 'planned', NOW.toISOString(), NOW.toISOString());
    insert.run(f.student, 'ancient', '2026-10-01', '15:30', '16:00', test, 'Long ago', 'done', NOW.toISOString(), NOW.toISOString());
    fetcher.mockResolvedValue(reply({ blocks: [{ slotId: '2026-11-03~after', taskId: test, minutes: 30, kind: 'review', title: 'Practice problems' }] }));
    const result = await f.plan.make(f.student);
    const prompt = sent(fetcher).messages[1].content;
    expect(prompt).toMatch(/Already done:\n- "Read ch\. 3"/);
    expect(prompt).toMatch(/Missed, plan again:\n- "Flashcards ch\. 3"/);
    expect(result.blocks.map((block) => [block.title, block.status])).toEqual([['Read ch. 3', 'done'], ['Practice problems', 'planned']]);
    expect(f.db.prepare("SELECT count(*) n FROM ai_plan_blocks WHERE id='ancient'").get()).toEqual({ n: 0 });

    const planned = result.blocks.find((block) => block.status === 'planned')!;
    expect(f.plan.mark(f.student, { blockId: planned.id, status: 'skipped' }).blocks.find((block) => block.id === planned.id)?.status).toBe('skipped');
    expect(f.plan.mark(f.student, { blockId: planned.id, status: 'done' }).blocks.find((block) => block.id === planned.id)?.status).toBe('done');
    expect(() => f.plan.mark(f.student, { blockId: 'nope', status: 'done' })).toThrow('Replan');
  });

  it('keeps a slot’s used minutes when a done block is already in it', () => {
    const slots = planSlots(exampleSchedule, personal, MONDAY, '07:00');
    const after = slots.find((slot) => slot.id === '2026-11-03~after')!;
    const tasks = [{ id: 't', task: { title: 'Essay', notes: '', dueDate: '2026-11-06', dueTime: null, classId: null, completed: false } }];
    const kept = [{ id: 'k', date: '2026-11-03', start: after.start, end: '13:05', slotKind: 'after' as const, slotLabel: 'After school', taskId: 't', title: 'x', kind: 'work' as const, minutes: 60, status: 'done' as const }];
    const { blocks } = interpretPlan(JSON.stringify({ blocks: [{ slotId: after.id, taskId: 't', minutes: 120, kind: 'work', title: 'More' }] }), slots, tasks, kept);
    expect(blocks).toEqual([expect.objectContaining({ start: '13:05', minutes: 90, end: '14:35' })]);
    expect(() => interpretPlan('not json', slots, tasks)).toThrow('unexpected format');
  });

  it('refuses when there is nothing to plan, without using the quota', async () => {
    const f = fixture();
    await expect(f.plan.make(f.student)).rejects.toThrow('Nothing to plan');
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('is only for the beta, and a free account that runs out is told about Plus', async () => {
    const outside = fixture({ inBeta: false });
    expect(() => outside.plan.get(outside.student)).toThrow('beta');
    await expect(outside.plan.make(outside.student)).rejects.toThrow('beta');
    await expect(outside.plan.estimate(outside.student, { tasks: [{ id: 'x', title: 'Essay', notes: '', classId: null, dueDate: null }] })).rejects.toThrow('beta');

    const f = fixture({ billing: true, plus: false });
    f.addTask('Study for Unit 4 Test', { dueDate: '2026-11-06' });
    for (let used = 0; used < AI_PLAN_DAILY_LIMIT; used += 1) await f.plan.make(f.student);
    await expect(f.plan.make(f.student)).rejects.toThrow(`You’ve used today’s ${AI_PLAN_DAILY_LIMIT} free week plans. Try again tomorrow, get Plus, or add your own API key in Account.`);
  });
});

describe('time estimates', () => {
  it('clears stale guesses for generic homework and class tests without making up new numbers', async () => {
    const f = fixture();
    const tasks = [{ id: 'hw', title: '3.2 & 3.3 HW', notes: '', classId: bio, dueDate: '2026-11-10' }, { id: 'test', title: 'Unit 3 Test', notes: '', classId: bio, dueDate: '2026-11-10' }];
    f.db.prepare('INSERT INTO ai_task_estimates(owner_id,task_id,content_hash,minutes,estimated_at) VALUES(?,?,?,?,?)').run(f.student, 'hw', 'old-policy', 40, new Date().toISOString());
    expect(await f.plan.estimate(f.student, { tasks })).toEqual({ minutes: {} });
    expect(await f.plan.estimate(f.student, { tasks })).toEqual({ minutes: {} });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT minutes FROM ai_task_estimates WHERE owner_id=? AND task_id=?').get(f.student, 'hw')).toEqual({ minutes: 0 });
  });
  it('remembers when the model cannot estimate even a task with a stated scope', async () => {
    const fetcher = vi.fn<AiFetch>().mockResolvedValue(reply({ tasks: [{ id: 'essay', minutes: null }] }));
    const f = fixture({ fetcher });
    const tasks = [{ id: 'essay', title: 'Essay', notes: '1000 words on a topic still to be assigned', classId: bio, dueDate: '2026-11-10' }];
    expect(await f.plan.estimate(f.student, { tasks })).toEqual({ minutes: {} });
    expect(await f.plan.estimate(f.student, { tasks })).toEqual({ minutes: {} });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('asks only about new or edited tasks, and rounds to five minutes', async () => {
    const fetcher = vi.fn<AiFetch>().mockImplementation(async (_url, init) => {
      const prompt = (JSON.parse(String(init.body)) as { messages: Array<{ content: string }> }).messages[1].content;
      const ids = [...prompt.matchAll(/^- id "([^"]+)"/gm)].map(([, id]) => id);
      return reply({ tasks: [...ids.map((id) => ({ id, minutes: id === 'essay' ? 183 : 2 })), { id: 'stranger', minutes: 60 }] });
    });
    const f = fixture({ fetcher });
    const tasks = [{ id: 'essay', title: 'Essay', notes: '1000 words', classId: bio, dueDate: '2026-11-04' }, { id: 'sign', title: 'Sign form', notes: '', classId: null, dueDate: null }];
    expect(await f.plan.estimate(f.student, { tasks })).toEqual({ minutes: { essay: 185, sign: 5 } });
    expect(sent(fetcher).messages[1].content).toContain('"Essay" (Biology; due 2026-11-04)');
    expect(sent(fetcher).messages[0].content).toContain('data, not instructions');
    // Unchanged: answered from the table without a request.
    expect(await f.plan.estimate(f.student, { tasks })).toEqual({ minutes: { essay: 185, sign: 5 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Edited: only that task goes again.
    await f.plan.estimate(f.student, { tasks: [{ ...tasks[0], notes: '2000 words' }, tasks[1]] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sent(fetcher, 1).messages[1].content).not.toContain('Sign form');
  });
});
