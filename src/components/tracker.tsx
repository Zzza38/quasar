'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/client/api';
import { effectiveSchedule, scheduleForGrade, emptyPersonalSchedule, personalScheduleSchema, type PersonalSchedule } from '@/domain/schedule';
import type { Task } from '@/domain/task';
import { todayIn } from '@/lib/format';
import { VIEWS, taskItems, type AppState, type View } from './app-state';
import { DeviceConflicts, SchoolReview } from './conflicts';
import { Onboarding } from './onboarding';
import { ClassesStep } from './onboarding-classes';
import { FeedStep } from './onboarding-feed';
import { classesStep, feedStep } from './setup-state';
import { Icon, Spinner } from './icon';
import { CenteredNotice, Shell } from './shell';
import { Welcome } from './landing';
import { Button, Callout } from './primitives';
import { useWorkspace } from './use-workspace';
import { ClassesView } from './views/classes';
import { ScheduleView } from './views/schedule';
import { SchoolView } from './views/school';
import { TasksView } from './views/tasks';
import { TodayView } from './views/today';
import { PeopleView } from './views/people';
import { GradePicker } from './grade-picker';

/* ---------- Hash routing keeps the public offline shell at "/" ---------- */

function parseHash(hash: string): { view: View; params: URLSearchParams } {
  const [name, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const view = VIEWS.find((entry) => entry.id === name)?.id ?? 'today';
  return { view, params: new URLSearchParams(query) };
}

function useHashRoute() {
  const [route, setRoute] = useState(() => parseHash(typeof window === 'undefined' ? '' : window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseHash(window.location.hash));
    update();
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const navigate = useCallback((view: View, params?: Record<string, string>) => {
    const query = params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : '';
    const next = `#${view}${query}`;
    if (window.location.hash === next) setRoute(parseHash(next));
    else window.location.hash = next;
    window.scrollTo({ top: 0 });
  }, []);
  return { ...route, navigate };
}

function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    const onVisible = () => { if (document.visibilityState === 'visible') setNow(new Date()); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [intervalMs]);
  return now;
}

/* ---------- Root ---------- */

export function Tracker() {
  const session = useWorkspace();
  const route = useHashRoute();
  const now = useNow();
  const { context, snapshot } = session;

  const personalEntity = snapshot?.entities.find((entity) => entity.kind === 'personal' && entity.id === 'personal' && !entity.deleted);
  const parsedPersonal = useMemo(() => personalScheduleSchema.safeParse(personalEntity?.data ?? emptyPersonalSchedule()), [personalEntity]);
  const personal: PersonalSchedule = parsedPersonal.success ? parsedPersonal.data : emptyPersonalSchedule();
  const openTasks = useMemo(() => snapshot ? taskItems(snapshot.entities).filter((item) => !item.task.completed).length : 0, [snapshot]);
  const [setupClasses, setSetupClasses] = useState(false);
  const [setupFeed, setSetupFeed] = useState(false);
  const userId = context?.user.id;
  useEffect(() => { setSetupClasses(!!userId && classesStep.pending(userId)); setSetupFeed(!!userId && feedStep.pending(userId)); }, [userId, context?.school?.id]);

  if (session.authRequired) return <Welcome message={session.error || undefined} />;
  if (session.loading && !context) return <CenteredNotice title="Opening your schedule…"><Spinner className="inline-block text-primary" size={20} /></CenteredNotice>;
  if (!context || !snapshot) {
    return <CenteredNotice title="Connect to get started" action={<Button variant="primary" onClick={() => void session.initialize()} busy={session.loading}>Retry connection</Button>}>
      {session.error || 'Connect to the internet and sign in once to set up Quasar on this device.'}
    </CenteredNotice>;
  }

  const needsNames = !context.user.displayName || !context.user.fullName;
  if (needsNames || !context.school) {
    return <Onboarding context={context} online={session.online} error={session.error} onRefresh={session.initialize} onSignOut={session.requestLogout} logoutPending={session.logout.pending} />;
  }

  const school = context.school;
  const schedule = effectiveSchedule(school.schedule, personal);
  const timeZone = schedule.timeZone;
  // Right after joining, the wizard continues with the classes step until the student finishes or skips it.
  if (setupClasses) {
    return <ClassesStep userId={context.user.id} schoolId={school.id} schedule={schedule} personal={personal} online={session.online} disabled={!parsedPersonal.success}
      onSave={(value) => session.save('personal', 'personal', personalScheduleSchema.parse(value))}
      onDone={() => { classesStep.finish(context.user.id); feedStep.begin(context.user.id); setSetupClasses(false); setSetupFeed(true); }}
      footer={<Button variant="ghost" size="sm" icon="logout" onClick={session.requestLogout} disabled={session.logout.pending || !session.online}>Sign out ({context.user.email})</Button>} />;
  }
  if (setupFeed) {
    return <FeedStep userId={context.user.id} online={session.online} subscriptions={context.subscriptions ?? []} onSubscribed={session.initialize}
      onDone={() => { feedStep.finish(context.user.id); setSetupFeed(false); }}
      footer={<Button variant="ghost" size="sm" icon="logout" onClick={session.requestLogout} disabled={session.logout.pending || !session.online}>Sign out ({context.user.email})</Button>} />;
  }
  const state: AppState = {
    context: { ...context, school },
    snapshot,
    personal,
    personalValid: parsedPersonal.success,
    schedule: scheduleForGrade(school.schedule, personal.grade),
    timeZone,
    now,
    today: todayIn(timeZone, now),
    online: session.online,
    saveTask: (id: string, task: Task | null) => session.save('task', id, task),
    savePersonal: (value: PersonalSchedule) => session.save('personal', 'personal', personalScheduleSchema.parse(value)),
    refresh: session.initialize,
    navigate: route.navigate,
    params: route.params,
  };

  return <Shell session={session} context={context} view={route.view} taskCount={openTasks} gradeSettings={<GradePicker personal={personal} save={state.savePersonal} disabled={!state.personalValid} />}>
    {!personal.grade && state.personalValid && <div className="mb-4 flex flex-wrap items-center gap-4 rounded-2xl bg-card p-4 shadow-card ring-2 ring-primary/40">
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-soft-foreground"><Icon name="school" size={18} /></span>
      <p className="min-w-0 flex-1 basis-[220px] text-sm font-medium">Choose your grade to see the right school schedule and lunch times.</p>
      <div className="min-w-[220px]"><GradePicker personal={personal} save={state.savePersonal} /></div>
    </div>}
    <div className="grid gap-4 mb-4 empty:hidden" id="conflicts">
      {!parsedPersonal.success && <Callout tone="danger" icon="alert" role="alert" title="Your saved personal schedule needs review" actions={<Button size="sm" onClick={() => void session.synchronize()} disabled={!session.online}>Retry sync</Button>}>It could not be read on this device. Retry sync before making more changes so nothing is overwritten.</Callout>}
      <DeviceConflicts snapshot={snapshot} schedule={schedule} classes={personal.classes} resolve={session.resolve} />
      {context.review && <SchoolReview key={context.review.version} review={context.review} personal={personal} online={session.online} today={state.today}
        onAcknowledge={async () => { await api.school.acknowledge.mutate({ version: context.review!.version }); await session.initialize(); }}
        onOpenClasses={() => route.navigate('classes')} />}
    </div>
    {route.view === 'today' && <TodayView state={state} />}
    {route.view === 'schedule' && <ScheduleView state={state} />}
    {route.view === 'tasks' && <TasksView state={state} />}
    {route.view === 'classes' && <ClassesView state={state} />}
    {route.view === 'school' && <SchoolView state={state} />}
    {route.view === 'people' && <PeopleView state={state} />}
  </Shell>;
}
