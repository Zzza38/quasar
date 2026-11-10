'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { AI_BETA } from '@/domain/ai';
import type { Task } from '@/domain/task';
import { cn } from '@/lib/utils';
import { AiPhotoStrip, PlusTag, quotaLine, useAiPhotos, useAiStatus } from './ai-photos';
import { useBeta, useBetaAccount } from './betas';
import { isAssessment } from './focus-lists';
import { Icon } from './icon';
import { Button, Callout, ChoiceGroup, ChoiceItem, Eyebrow, Field, Hint, Modal, Segmented, Spacer, Textarea } from './primitives';

/**
 * Study sets (Quasar AI Plus, ai-tasks beta; src/server/study.ts): in the sheet of a test or quiz task, "Make a study
 * set" turns the task's notes, pasted text and photos of a study guide into flashcards and a practice quiz, kept on
 * the server per task. The study view flips cards (tap, Space or Enter), marks them "got it" or "again" (buttons,
 * arrow keys or a swipe), shuffles, and runs the quiz with a score at the end.
 */
export type StudySet = RouterOutput['study']['create'];
type Card = StudySet['cards'][number];
type Question = StudySet['quiz'][number];
const DISCLAIMER = 'Made by AI from your material. Check anything that looks off.';
/** How far a finger has to travel sideways on a card to count as a swipe, in CSS pixels. */
const SWIPE_PX = 60;
const STUDY_TEXT_MAX = 20_000;

export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) { const other = Math.floor(random() * (index + 1)); [copy[index], copy[other]] = [copy[other], copy[index]]; }
  return copy;
}

/** A round of cards: `queue` is what's left, front first. "Got it" takes the card out; "Again" sends it to the back. */
export type Deck = { queue: string[]; known: string[] };
export function startDeck(cards: Card[], known: string[]): Deck {
  const left = cards.filter(card => !known.includes(card.id)).map(card => card.id);
  return { queue: left.length ? left : cards.map(card => card.id), known: left.length ? known.filter(id => cards.some(card => card.id === id)) : [] };
}
export function markCard(deck: Deck, gotIt: boolean): Deck {
  const [current, ...rest] = deck.queue;
  if (current === undefined) return deck;
  return gotIt ? { queue: rest, known: deck.known.includes(current) ? deck.known : [...deck.known, current] } : { queue: [...rest, current], known: deck.known.filter(id => id !== current) };
}

/** The block in a task's sheet: shown for tasks that look like a test or quiz, or that already have a set. */
export function StudySetBlock({ taskId, task }: { taskId: string | null; task: Task }) {
  const beta = useBeta(AI_BETA);
  const account = useBetaAccount();
  const { status, reload: reloadStatus } = useAiStatus(beta && !!taskId);
  const [loaded, setLoaded] = useState<{ set: StudySet | null; kind: 'test' | 'quiz' | 'none' | null } | null>(null);
  const [mode, setMode] = useState<'build' | 'study' | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const accountId = account?.accountId;
  useEffect(() => {
    if (!beta || !taskId || !accountId) return;
    let cancelled = false;
    api.study.get.query({ accountId, taskId }).then(result => { if (!cancelled) setLoaded(result as typeof loaded); }, () => { if (!cancelled) setLoaded({ set: null, kind: null }); });
    return () => { cancelled = true; };
  }, [beta, taskId, accountId]);
  if (!beta || !account || !taskId || !loaded || (status?.beta && !status.available && !loaded.set)) return null;
  const set = loaded.set;
  if (!set && !(loaded.kind === 'test' || loaded.kind === 'quiz' || isAssessment(task.title))) return null;
  const remove = async () => {
    setPending(true); setError('');
    try { await api.study.remove.mutate({ accountId: account.accountId, taskId }); setLoaded({ ...loaded, set: null }); setDeleting(false); }
    catch (err) { setError(errorMessage(err)); }
    finally { setPending(false); }
  };
  return <section className="grid gap-2 rounded-2xl bg-muted/60 p-4 ring-1 ring-inset ring-foreground/[0.04]" aria-labelledby="study-set-heading">
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="grid min-w-0 gap-1">
        <h3 id="study-set-heading"><Eyebrow>Study set</Eyebrow></h3>
        <Hint>{set ? `${set.cards.length} flashcards${set.quiz.length ? ` · ${set.quiz.length} quiz questions` : ''}${set.progress.lastScore ? ` · last quiz ${set.progress.lastScore.right}/${set.progress.lastScore.total}` : ''}`
          : 'Flashcards and a practice quiz from your notes or a photo of the study guide.'}</Hint>
      </div>
      <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-1">
        {set ? <>
          <Button size="sm" variant="ghost" icon="refresh" disabled={!account.online || pending} onClick={() => setMode('build')}>Remake</Button>
          <Button size="sm" variant="ghost" icon="trash" disabled={!account.online || pending} onClick={() => setDeleting(true)}>Delete</Button>
          <Button size="sm" variant="primary" icon="book" onClick={() => setMode('study')}>Study</Button>
        </> : <Button size="sm" variant="primary" icon="sparkle" disabled={!account.online} onClick={() => setMode('build')}>Make a study set<PlusTag status={status} /></Button>}
      </div>
    </div>
    {deleting && set && <Callout tone="warning" icon="alert" role="alert" title="Delete this study set?" actions={<>
      <Button size="sm" variant="danger" busy={pending} onClick={() => void remove()}>Delete set</Button>
      <Button size="sm" autoFocus disabled={pending} onClick={() => setDeleting(false)}>Keep it</Button>
    </>}>The cards, the quiz and your progress go. You can make a new one any time.</Callout>}
    {error && <Hint tone="danger" role="alert">{error}</Hint>}
    {mode === 'build' && <StudyBuilder accountId={account.accountId} taskId={taskId} title={task.title} hasNotes={!!task.notes.trim()} previous={set} status={status} online={account.online}
      onClose={() => setMode(null)} onMade={(next) => { setLoaded({ ...loaded, set: next }); setMode('study'); void reloadStatus(); }} />}
    {mode === 'study' && set && <StudyView accountId={account.accountId} set={set} title={task.title} onClose={() => setMode(null)} onProgress={(progress) => setLoaded(current => current?.set ? { ...current, set: { ...current.set, progress } } : current)} />}
  </section>;
}

function StudyBuilder({ accountId, taskId, title, hasNotes, previous, status, online, onClose, onMade }: {
  accountId: string; taskId: string; title: string; hasNotes: boolean; previous: StudySet | null; status: ReturnType<typeof useAiStatus>['status']; online: boolean; onClose: () => void; onMade: (set: StudySet) => void;
}) {
  const picker = useAiPhotos('your study guide or notes');
  const [text, setText] = useState(previous?.material ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const empty = !hasNotes && !text.trim() && picker.photos.length === 0;
  const make = async () => {
    setPending(true); setError('');
    try { onMade(await api.study.create.mutate({ accountId, taskId, text, images: picker.images, ...(picker.pdfText ? { pdfText: picker.pdfText } : {}) })); }
    catch (err) { setError(errorMessage(err)); setPending(false); }
  };
  return <Modal open onClose={onClose} busy={pending} dirty={text !== (previous?.material ?? '') || picker.photos.length > 0} title={previous ? 'Remake the study set' : 'Make a study set'}
    description={`For “${title}”. ${quotaLine(status, 'study', 'study sets')}`}
    footer={<><Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button><Spacer />
      <Button variant="primary" icon="sparkle" busy={pending} disabled={!online || empty || picker.preparing} onClick={() => void make()}>{pending ? 'Making cards…' : previous ? 'Remake set' : 'Make set'}</Button></>}>
    {picker.inputs}
    <Hint>{hasNotes ? 'The task’s notes are used. Add more below if you have it.' : 'Paste your notes or the study guide, or add a photo of it.'}{previous ? ' Remaking replaces the cards and resets your progress.' : ''}</Hint>
    <Field label="Notes or study guide (optional)" htmlFor="study-text">
      <Textarea id="study-text" rows={6} maxLength={STUDY_TEXT_MAX} value={text} disabled={pending} placeholder="Vocabulary, key ideas, what the test covers…" onChange={event => setText(event.target.value)} />
    </Field>
    <div className="grid gap-1.5"><Eyebrow>Photos (optional)</Eyebrow><AiPhotoStrip picker={picker} disabled={pending} what="the study material" /></div>
    <Hint>Photos go to the AI to make this set and aren’t stored. Your pasted text is kept with the set so you can remake it.</Hint>
    {pending && <div className="flex items-center gap-2.5 text-sm text-muted-foreground" role="status"><Icon name="spinner" className="animate-spin" />Making flashcards and a quiz. This can take a minute.</div>}
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}

function StudyView({ accountId, set, title, onClose, onProgress }: { accountId: string; set: StudySet; title: string; onClose: () => void; onProgress: (progress: StudySet['progress']) => void }) {
  const [tab, setTab] = useState<'cards' | 'quiz'>('cards');
  return <Modal open onClose={onClose} wide title={`Study: ${title}`} description={DISCLAIMER} footer={<><Spacer /><Button variant="primary" onClick={onClose}>Done</Button></>}>
    {set.quiz.length > 0 && <Segmented label="Study mode" value={tab} onChange={setTab} options={[{ value: 'cards', label: `Flashcards · ${set.cards.length}` }, { value: 'quiz', label: `Quiz · ${set.quiz.length}` }]} />}
    {tab === 'cards' ? <Flashcards accountId={accountId} set={set} onProgress={onProgress} /> : <Quiz accountId={accountId} set={set} onProgress={onProgress} />}
  </Modal>;
}

function Flashcards({ accountId, set, onProgress }: { accountId: string; set: StudySet; onProgress: (progress: StudySet['progress']) => void }) {
  const [deck, setDeck] = useState<Deck>(() => startDeck(set.cards, set.progress.known));
  const [flipped, setFlipped] = useState(false);
  const swipe = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  /** Set when a pointer-up ended a swipe, so the click that follows doesn't also flip the card. */
  const swiped = useRef(false);
  const [drag, setDrag] = useState(0);
  const cards = new Map(set.cards.map(card => [card.id, card]));
  const card = deck.queue[0] ? cards.get(deck.queue[0]) : undefined;
  const save = useCallback((known: string[]) => {
    api.study.progress.mutate({ accountId, taskId: set.taskId, known }).then(onProgress, () => {});
  }, [accountId, set.taskId, onProgress]);
  const mark = (gotIt: boolean) => {
    if (!card) return;
    const next = markCard(deck, gotIt);
    setDeck(next); setFlipped(false);
    if (next.known.length !== deck.known.length) save(next.known);
  };
  const restart = () => { setDeck({ queue: shuffle(set.cards.map(entry => entry.id)), known: [] }); setFlipped(false); save([]); };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowRight') { event.preventDefault(); mark(true); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); mark(false); }
  };
  const down = (event: PointerEvent<HTMLElement>) => { event.currentTarget.setPointerCapture(event.pointerId); swipe.current = { x: event.clientX, y: event.clientY, moved: false }; };
  const move = (event: PointerEvent) => {
    const start = swipe.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(event.clientY - start.y)) { start.moved = true; setDrag(dx); }
  };
  const up = (event: PointerEvent) => {
    const start = swipe.current;
    swipe.current = null; setDrag(0);
    swiped.current = !!start?.moved;
    if (!start?.moved) return;
    const dx = event.clientX - start.x;
    if (Math.abs(dx) >= SWIPE_PX) mark(dx > 0);
  };
  const total = set.cards.length;
  if (!card) return <div className="grid justify-items-center gap-3 rounded-3xl bg-muted/60 px-5 py-10 text-center ring-1 ring-inset ring-foreground/[0.04]" role="status">
    <Icon name="checkCircle" size={28} className="text-success" />
    <strong className="text-base">You got all {total} cards.</strong>
    <Hint>Go again in a different order, or try the quiz.</Hint>
    <Button icon="refresh" onClick={restart}>Start over</Button>
  </div>;
  return <div className="grid gap-3" onKeyDown={onKey}>
    <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
      <span role="status" className="tabular-nums">{deck.known.length} of {total} got it · {deck.queue.length} to go</span><Spacer />
      <Button size="sm" variant="ghost" icon="refresh" onClick={() => { setDeck(current => ({ ...current, queue: shuffle(current.queue) })); setFlipped(false); }}>Shuffle</Button>
    </div>
    <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true"><div className="h-full rounded-full bg-primary/70 transition-[width]" style={{ width: `${(deck.known.length / total) * 100}%` }} /></div>
    <div className="[perspective:1200px]">
      <button type="button" aria-label={`${flipped ? 'Answer' : 'Card'}: ${flipped ? card.back : card.front}. ${flipped ? 'Tap to see the front.' : 'Tap to see the answer.'}`} aria-pressed={flipped}
        onClick={() => { if (swiped.current) { swiped.current = false; return; } setFlipped(value => !value); }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { swipe.current = null; setDrag(0); }}
        style={drag ? { transform: `translateX(${drag}px) rotate(${drag / 30}deg)` } : undefined}
        className="relative grid w-full touch-pan-y select-none rounded-3xl outline-none transition-transform duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
        <span className={cn('grid w-full transition-transform duration-500 [grid-area:1/1] [transform-style:preserve-3d] motion-reduce:transition-none', flipped && '[transform:rotateY(180deg)]')}>
          <span aria-hidden="true" className="grid min-h-[220px] place-items-center rounded-3xl bg-card px-6 py-8 text-center shadow-card ring-1 ring-foreground/[0.08] [backface-visibility:hidden] [grid-area:1/1] sm:min-h-[260px]">
            <span className="grid gap-3"><span className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Front</span><span className="text-[19px] font-semibold leading-snug text-balance sm:text-[22px]">{card.front}</span></span>
          </span>
          <span aria-hidden="true" className="grid min-h-[220px] place-items-center rounded-3xl bg-muted px-6 py-8 text-center ring-1 ring-foreground/[0.08] [backface-visibility:hidden] [grid-area:1/1] [transform:rotateY(180deg)] sm:min-h-[260px]">
            <span className="grid gap-3"><span className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Answer</span><span className="text-[16px] leading-relaxed text-pretty sm:text-[18px]">{card.back}</span></span>
          </span>
        </span>
      </button>
    </div>
    <div className="grid grid-cols-2 gap-2">
      <Button icon="arrowLeft" onClick={() => mark(false)}>Again</Button>
      <Button variant="primary" iconRight="check" onClick={() => mark(true)}>Got it</Button>
    </div>
    <Hint className="text-center"><span className="pointer-coarse:hidden">Space flips the card · → got it · ← again</span><span className="hidden pointer-coarse:inline">Tap to flip · swipe right for got it, left for again</span></Hint>
  </div>;
}

/** The quiz's state: the order questions are asked in, what was picked for each, and where the student is. */
type QuizRun = { order: string[]; picked: Record<string, number>; at: number };

function Quiz({ accountId, set, onProgress }: { accountId: string; set: StudySet; onProgress: (progress: StudySet['progress']) => void }) {
  const [run, setRun] = useState<QuizRun>(() => ({ order: set.quiz.map(question => question.id), picked: {}, at: 0 }));
  const questions = new Map(set.quiz.map(question => [question.id, question]));
  const total = run.order.length;
  const finished = run.at >= total;
  const right = run.order.filter(id => run.picked[id] === questions.get(id)!.answer).length;
  const saved = useRef(false);
  useEffect(() => {
    if (!finished || saved.current) return;
    saved.current = true;
    api.study.progress.mutate({ accountId, taskId: set.taskId, known: set.progress.known, score: { right, total } }).then(onProgress, () => {});
  }, [finished, right, total, accountId, set.taskId, set.progress.known, onProgress]);
  const again = () => { saved.current = false; setRun({ order: shuffle(set.quiz.map(question => question.id)), picked: {}, at: 0 }); };
  if (finished) {
    const missed = run.order.map(id => questions.get(id)!).filter(question => run.picked[question.id] !== question.answer);
    return <div className="grid gap-3">
      <div className="grid justify-items-center gap-2 rounded-3xl bg-muted/60 px-5 py-8 text-center ring-1 ring-inset ring-foreground/[0.04]" role="status">
        <strong className="text-[28px] font-bold tabular-nums leading-none">{right}/{total}</strong>
        <span className="text-sm text-muted-foreground">{right === total ? 'Every one right.' : `You got ${right} of ${total} right.`}</span>
        <Button icon="refresh" onClick={again}>Try again</Button>
      </div>
      {missed.length > 0 && <ul className="grid gap-2" aria-label="Questions to review">{missed.map(question => <li key={question.id} className="grid gap-1 rounded-2xl bg-card px-3.5 py-3 ring-1 ring-foreground/[0.08]">
        <span className="text-[14px] font-semibold leading-snug">{question.question}</span>
        <span className="text-[13px]"><span className="text-muted-foreground">Answer: </span><strong>{question.choices[question.answer]}</strong></span>
        {question.explanation && <Hint>{question.explanation}</Hint>}
      </li>)}</ul>}
    </div>;
  }
  const question = questions.get(run.order[run.at])!;
  const picked = run.picked[question.id];
  return <QuizQuestion key={question.id} question={question} number={run.at + 1} total={total} picked={picked}
    onPick={(choice) => setRun(current => ({ ...current, picked: { ...current.picked, [question.id]: choice } }))}
    onNext={() => setRun(current => ({ ...current, at: current.at + 1 }))} last={run.at === total - 1} />;
}

function QuizQuestion({ question, number, total, picked, onPick, onNext, last }: { question: Question; number: number; total: number; picked: number | undefined; onPick: (choice: number) => void; onNext: () => void; last: boolean }) {
  const answered = picked !== undefined;
  const correct = picked === question.answer;
  return <div className="grid gap-3">
    <div className="text-[12px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Question {number} of {total}</div>
    <p id={`quiz-${question.id}`} className="text-[17px] font-semibold leading-snug text-pretty">{question.question}</p>
    <ChoiceGroup label={question.question} value={answered ? String(picked) : null} disabled={answered} onChange={(value) => onPick(Number(value))} className="grid gap-2">
      {question.choices.map((choice, index) => {
        const state = !answered ? 'idle' : index === question.answer ? 'right' : index === picked ? 'wrong' : 'other';
        return <ChoiceItem key={index} value={String(index)} className={cn('flex items-start gap-3 rounded-2xl px-4 py-3 text-left text-[14.5px] ring-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default',
          state === 'idle' && 'bg-card ring-foreground/[0.08] hover:bg-muted',
          state === 'right' && 'bg-success-soft text-foreground ring-success/40',
          state === 'wrong' && 'bg-destructive/10 text-foreground ring-destructive/35',
          state === 'other' && 'bg-card text-muted-foreground ring-foreground/[0.06]')}>
          <span className={cn('mt-px grid size-5 shrink-0 place-items-center rounded-full border-2 text-[11px] font-bold', state === 'right' ? 'border-success bg-success text-white' : state === 'wrong' ? 'border-destructive bg-destructive text-white' : 'border-control-border')}>
            {state === 'right' ? <Icon name="check" size={12} strokeWidth={3} /> : state === 'wrong' ? <Icon name="x" size={12} strokeWidth={3} /> : null}
          </span>
          <span className="min-w-0">{choice}</span>
        </ChoiceItem>;
      })}
    </ChoiceGroup>
    {answered && <div className="grid gap-1 rounded-2xl bg-muted/60 px-4 py-3 ring-1 ring-inset ring-foreground/[0.04]" role="status">
      <strong className={cn('text-sm', correct ? 'text-success' : 'text-destructive')}>{correct ? 'Right.' : `Not quite. It’s “${question.choices[question.answer]}”.`}</strong>
      {question.explanation && <span className="text-[13.5px] leading-relaxed text-foreground/85">{question.explanation}</span>}
    </div>}
    <div className="flex"><Spacer /><Button variant="primary" iconRight={last ? undefined : 'arrowRight'} disabled={!answered} onClick={onNext}>{last ? 'See score' : 'Next question'}</Button></div>
  </div>;
}
