import {describe,it,expect,vi} from 'vitest';
import {startJobs} from './jobs';
import type {Db} from './db';

describe('background jobs',()=>{
  it('runs sequentially without overlap and stops gracefully during an active refresh',async()=>{
    vi.useFakeTimers();
    let finish!:()=>void;
    const refreshDue=vi.fn().mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
    const deliverDue=vi.fn().mockResolvedValue({sent:0,failed:0});
    try {
      const worker=startJobs({} as Db,{}, {calendar:{refreshDue},notifications:{deliverDue}});
      await vi.advanceTimersByTimeAsync(180_000);
      expect(refreshDue).toHaveBeenCalledTimes(1);expect(deliverDue).not.toHaveBeenCalled();
      const stop=worker.stop();finish();await stop;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(refreshDue).toHaveBeenCalledTimes(1);expect(deliverDue).not.toHaveBeenCalled();
    } finally {vi.useRealTimers();}
  });
  it('continues notifications after refresh errors and retries on the next cycle',async()=>{
    vi.useFakeTimers();
    const refreshDue=vi.fn().mockRejectedValue(new Error('sensitive feed URL'));
    const deliverDue=vi.fn().mockResolvedValue({sent:1,failed:0});const onError=vi.fn();
    try {
      const worker=startJobs({} as Db,{onError}, {calendar:{refreshDue},notifications:{deliverDue}});
      await vi.advanceTimersByTimeAsync(0);
      expect(deliverDue).toHaveBeenCalledTimes(1);expect(onError).toHaveBeenCalledWith('calendar');
      await vi.advanceTimersByTimeAsync(60_000);expect(refreshDue).toHaveBeenCalledTimes(2);expect(deliverDue).toHaveBeenCalledTimes(2);
      await worker.stop();await vi.advanceTimersByTimeAsync(60_000);expect(refreshDue).toHaveBeenCalledTimes(2);
    } finally {vi.useRealTimers();}
  });
});
