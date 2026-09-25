import { describe, expect, it } from 'vitest';
import { latestLoad } from './onboarding';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('school pick loading', () => {
  it('opens the school once its schedule loads', async () => {
    const opened: string[] = [];
    await latestLoad().run(async () => 'Lincoln High', (school) => opened.push(school), () => undefined);
    expect(opened).toEqual(['Lincoln High']);
  });

  it('drops a slow pick after the student moved on to add a school', async () => {
    const loads = latestLoad();
    const slow = deferred<string>();
    const opened: string[] = [];
    const errors: unknown[] = [];
    const pick = loads.run(() => slow.promise, (school) => opened.push(school), (error) => errors.push(error));
    loads.cancel();
    slow.resolve('Lincoln High');
    await pick;
    expect(opened).toEqual([]);
    const failed = deferred<string>();
    const retry = loads.run(() => failed.promise, (school) => opened.push(school), (error) => errors.push(error));
    loads.cancel();
    failed.reject(new Error('Network down'));
    await retry;
    expect(errors).toEqual([]);
  });

  it('keeps only the newest of two picks, whichever answers first', async () => {
    const loads = latestLoad();
    const first = deferred<string>();
    const second = deferred<string>();
    const opened: string[] = [];
    const older = loads.run(() => first.promise, (school) => opened.push(school), () => undefined);
    const newer = loads.run(() => second.promise, (school) => opened.push(school), () => undefined);
    second.resolve('Roosevelt');
    first.resolve('Lincoln High');
    await Promise.all([older, newer]);
    expect(opened).toEqual(['Roosevelt']);
  });

  it('reports a failure of the current pick', async () => {
    const errors: unknown[] = [];
    await latestLoad().run(() => Promise.reject(new Error('Not found')), () => undefined, (error) => errors.push(error));
    expect(errors).toHaveLength(1);
  });
});
