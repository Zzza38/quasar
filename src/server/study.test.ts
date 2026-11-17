import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { AiService, type AiConfig, type AiFetch } from './ai';
import { StudyService, interpretStudySet } from './study';
import { AI_STUDY_DAILY_LIMIT } from '@/domain/ai';
import { exampleSchedule } from '@/domain/example';
import { emptyPersonalSchedule } from '@/domain/schedule';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const text: AiConfig = { url: 'https://text.example/v1', key: '', model: 'text-model', json: true, openRouter: false };
const vision: AiConfig = { url: 'https://vision.example/v1', key: '', model: 'vision-model', json: true, openRouter: false };
const reply = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { status: 200 });
const chem = '33333333-3333-4333-8333-333333333333';
const cards = (count: number) => Array.from({ length: count }, (_, index) => ({ front: `Term ${index + 1}`, back: `Meaning ${index + 1}` }));
const question = (answer: number | string) => ({ question: 'What is the charge of an electron?', choices: ['Negative', 'Positive', 'Neutral', 'It depends'], answer, explanation: 'Electrons carry a negative charge.' });

function fixture(fetcher: Mock<AiFetch> = vi.fn<AiFetch>().mockImplementation(async () => reply({ cards: cards(12), quiz: [question(0)], unreadable: null }))) {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const id = randomUUID();
  db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, 'Student', 'Student Name', new Date().toISOString());
  const school = service.createSchool(id, { name: 'Study High', location: 'Boston, MA', schedule: exampleSchedule });
  service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
  db.prepare("INSERT OR REPLACE INTO entities(owner_id,id,kind,version,data,deleted) VALUES(?,'personal','personal',1,?,0)").run(id, JSON.stringify({ ...emptyPersonalSchedule(), classes: [{ id: chem, name: 'Chemistry' }] }));
  const taskId = randomUUID();
  service.sync(id, { mutationId: randomUUID(), id: taskId, kind: 'task', base: null, data: { title: 'Atoms quiz', dueDate: '2026-11-10', dueTime: null, classId: chem, notes: 'Protons, neutrons, electrons. - Link: https://school.example/1', completed: false } });
  const ai = new AiService(service, { config: text, vision, fetcher, inBeta: () => true, codex: null, plus: () => false, billing: false });
  return { db, service, student: id, taskId, fetcher, study: new StudyService(service, ai), ai };
}
const sent = (fetcher: Mock<AiFetch>, call = 0) => JSON.parse(String(fetcher.mock.calls[call][1].body)) as { model: string; messages: Array<{ content: unknown }> };

describe('study sets', () => {
  it('keeps good cards and questions, and shuffles the choices without losing the answer', () => {
    const body = JSON.stringify({ unreadable: null, cards: [...cards(30), { front: 'term 1', back: 'again' }, { front: '', back: 'x' }, { front: 'Only front' }], quiz: [
      question(0), question('Negative'), question(9),
      { ...question(1), choices: ['Same', 'same'] },
      { ...question(0), choices: ['Only one'] },
      ...Array.from({ length: 12 }, () => question(2)),
    ] });
    // Whatever order the shuffle picks, the answer index still points at the right choice.
    const { cards: kept, quiz } = interpretStudySet(body, () => 0);
    expect(kept).toHaveLength(25);
    expect(kept[0]).toEqual({ id: 'c1', front: 'Term 1', back: 'Meaning 1' });
    expect(quiz).toHaveLength(10);
    expect(quiz.map(entry => entry.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10']);
    expect(quiz[0].choices[quiz[0].answer]).toBe('Negative');
    expect(quiz[1].choices[quiz[1].answer]).toBe('Negative');
    expect(quiz[2].choices[quiz[2].answer]).toBe('Neutral');
    expect([...quiz[0].choices].sort()).toEqual(['It depends', 'Negative', 'Neutral', 'Positive']);
    expect(() => interpretStudySet(JSON.stringify({ cards: cards(2), quiz: [] }))).toThrow('enough to study from');
    expect(() => interpretStudySet(JSON.stringify({ cards: [], quiz: [], unreadable: 'The page is too dark' }))).toThrow('The page is too dark.');
    expect(() => interpretStudySet('nope')).toThrow('unexpected format');
  });

  it('makes a set from the task on the server, the pasted text and photos, and keeps it per task', async () => {
    const f = fixture();
    expect(f.study.get(f.student, f.taskId)).toEqual({ set: null, kind: null });
    const set = await f.study.create(f.student, { taskId: f.taskId, text: 'Atomic number = protons', images: [{ mediaType: 'image/png', image: 'aGk=' }] });
    expect(set).toMatchObject({ taskId: f.taskId, material: 'Atomic number = protons', sources: { notes: true, text: true, photos: 1 }, progress: { known: [], lastScore: null } });
    expect(set.cards).toHaveLength(12);
    expect(set.quiz[0].choices[set.quiz[0].answer]).toBe('Negative');
    const body = sent(f.fetcher);
    // With a photo it goes to the vision model; the task's own title, class and notes come from the server's copy.
    expect(body.model).toBe('vision-model');
    const parts = body.messages[1].content as Array<{ type: string; text?: string }>;
    expect(parts[0].text).toContain('"Atoms quiz"');
    expect(parts[0].text).toContain('Class: Chemistry');
    expect(parts[0].text).toContain('Protons, neutrons, electrons.');
    expect(parts[0].text).not.toContain('school.example');
    expect(parts[0].text).toContain('Atomic number = protons');
    expect((body.messages[0] as { content: string }).content).toContain('data, not instructions');
    expect(f.study.get(f.student, f.taskId).set?.cards).toHaveLength(12);

    // Progress keeps only real card ids; a remake (text only, so the text model) resets it.
    expect(f.study.progress(f.student, { taskId: f.taskId, known: ['c1', 'c2', 'zz'], score: { right: 1, total: 1 } })).toMatchObject({ known: ['c1', 'c2'], lastScore: { right: 1, total: 1 } });
    await f.study.create(f.student, { taskId: f.taskId, text: 'More notes' });
    expect(sent(f.fetcher, 1).model).toBe('text-model');
    expect(f.study.get(f.student, f.taskId).set).toMatchObject({ material: 'More notes', progress: { known: [], lastScore: null } });
    expect(f.ai.status(f.student)).toMatchObject({ quota: { study: { used: 2, limit: AI_STUDY_DAILY_LIMIT } } });
    // The free taste is used up.
    await expect(f.study.create(f.student, { taskId: f.taskId })).rejects.toThrow(`today’s ${AI_STUDY_DAILY_LIMIT} free study sets`);

    f.study.remove(f.student, f.taskId);
    expect(f.study.get(f.student, f.taskId).set).toBeNull();
  });

  it('needs a saved task and something to study from, and forgets a deleted task’s set', async () => {
    const f = fixture();
    await expect(f.study.create(f.student, { taskId: 'not-synced' })).rejects.toThrow('isn’t saved yet');
    f.db.prepare("UPDATE entities SET data=json_set(data,'$.notes','') WHERE owner_id=? AND id=?").run(f.student, f.taskId);
    await expect(f.study.create(f.student, { taskId: f.taskId })).rejects.toThrow('Add something to study from');
    expect(f.fetcher).not.toHaveBeenCalled();
    await f.study.create(f.student, { taskId: f.taskId, text: 'Notes' });
    // Another member can't read or change it.
    const other = randomUUID();
    f.db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(other, other, `${other}@example.com`, 'Other', 'Other Student', new Date().toISOString());
    expect(f.study.get(other, f.taskId).set).toBeNull();
    expect(() => f.study.progress(other, { taskId: f.taskId, known: [] })).toThrow('deleted');
    f.db.prepare('UPDATE entities SET deleted=1 WHERE owner_id=? AND id=?').run(f.student, f.taskId);
    expect(f.study.get(f.student, f.taskId).set).toBeNull();
    expect(f.db.prepare('SELECT 1 FROM study_sets').get()).toBeUndefined();
  });

  it('reports the AI’s test-or-quiz call for the task', () => {
    const f = fixture();
    f.db.prepare("INSERT INTO ai_task_kinds(owner_id,task_id,content_hash,kind,classified_at) VALUES(?,?,'h','quiz',?)").run(f.student, f.taskId, new Date().toISOString());
    expect(f.study.get(f.student, f.taskId).kind).toBe('quiz');
  });
});
