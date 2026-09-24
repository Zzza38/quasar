import {describe,it,expect,vi} from 'vitest';
import {startJobs} from './jobs';
import type {Db} from './db';

const idle=()=>({deliverChat:vi.fn().mockResolvedValue({sent:0,failed:0}),prune:vi.fn()});

describe('background jobs',()=>{
  it('runs sequentially without overlap and stops gracefully during an active refresh',async()=>{
    vi.useFakeTimers();
    let finish!:()=>void;
    const refreshDue=vi.fn().mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
    const deliverDue=vi.fn().mockResolvedValue({sent:0,failed:0});const {deliverChat,prune}=idle();
    try {
      const worker=startJobs({} as Db,{}, {calendar:{refreshDue},notifications:{deliverDue,deliverChat},chat:{prune}});
      await vi.advanceTimersByTimeAsync(180_000);
      expect(refreshDue).toHaveBeenCalledTimes(1);expect(deliverDue).not.toHaveBeenCalled();
      const stop=worker.stop();finish();await stop;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(refreshDue).toHaveBeenCalledTimes(1);expect(deliverDue).not.toHaveBeenCalled();
      expect(deliverChat).not.toHaveBeenCalled();expect(prune).not.toHaveBeenCalled();
    } finally {vi.useRealTimers();}
  });
  it('continues notifications after refresh errors and retries on the next cycle',async()=>{
    vi.useFakeTimers();
    const refreshDue=vi.fn().mockRejectedValue(new Error('sensitive feed URL'));
    const deliverDue=vi.fn().mockResolvedValue({sent:1,failed:0});const onError=vi.fn();const {deliverChat,prune}=idle();
    try {
      const worker=startJobs({} as Db,{onError}, {calendar:{refreshDue},notifications:{deliverDue,deliverChat},chat:{prune}});
      await vi.advanceTimersByTimeAsync(0);
      expect(deliverDue).toHaveBeenCalledTimes(1);expect(onError).toHaveBeenCalledWith('calendar');
      expect(deliverChat).toHaveBeenCalledTimes(1);expect(prune).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);expect(refreshDue).toHaveBeenCalledTimes(2);expect(deliverDue).toHaveBeenCalledTimes(2);
      await worker.stop();await vi.advanceTimersByTimeAsync(60_000);expect(refreshDue).toHaveBeenCalledTimes(2);
    } finally {vi.useRealTimers();}
  });
  it('runs refresh, reminders, chat pushes and chat retention in order within one cycle, with no overlap',async()=>{
    vi.useFakeTimers();
    const order:string[]=[];let active=0;let overlapped=false;
    const step=(name:string,ms:number)=>vi.fn().mockImplementation(async()=>{
      order.push(`${name}:start`);if(active++)overlapped=true;
      await new Promise(resolve=>setTimeout(resolve,ms));
      active--;order.push(`${name}:end`);return {sent:0,failed:0};
    });
    const refreshDue=step('refreshDue',5_000),deliverDue=step('deliverDue',5_000),deliverChat=step('deliverChat',90_000);
    const prune=vi.fn().mockImplementation((now:Date)=>{expect(now).toBeInstanceOf(Date);if(active)overlapped=true;order.push('prune');});
    try {
      const worker=startJobs({} as Db,{intervalMs:1_000}, {calendar:{refreshDue},notifications:{deliverDue,deliverChat},chat:{prune}});
      await vi.advanceTimersByTimeAsync(100_000);
      expect(order).toEqual(['refreshDue:start','refreshDue:end','deliverDue:start','deliverDue:end','deliverChat:start','deliverChat:end','prune']);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(refreshDue).toHaveBeenCalledTimes(2);expect(deliverChat).toHaveBeenCalledTimes(1);
      const stop=worker.stop();await vi.advanceTimersByTimeAsync(10_000);await stop;
      expect(overlapped).toBe(false);
    } finally {vi.useRealTimers();}
  });
  it('reports a failing chat push step as chat, still prunes, and retries on the next cycle',async()=>{
    vi.useFakeTimers();
    const refreshDue=vi.fn().mockResolvedValue(undefined);const deliverDue=vi.fn().mockResolvedValue({sent:0,failed:0});
    const deliverChat=vi.fn().mockRejectedValueOnce(new Error('ZX-SECRET-42 message text')).mockResolvedValue({sent:1,failed:0});
    const prune=vi.fn();const onError=vi.fn();
    try {
      const worker=startJobs({} as Db,{onError}, {calendar:{refreshDue},notifications:{deliverDue,deliverChat},chat:{prune}});
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).toHaveBeenCalledTimes(1);expect(onError).toHaveBeenCalledWith('chat');expect(prune).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deliverChat).toHaveBeenCalledTimes(2);expect(prune).toHaveBeenCalledTimes(2);expect(onError).toHaveBeenCalledTimes(1);
      await worker.stop();
    } finally {vi.useRealTimers();}
  });
  it('reports a failing chat prune as chat and keeps the loop running',async()=>{
    vi.useFakeTimers();
    const refreshDue=vi.fn().mockResolvedValue(undefined);const deliverDue=vi.fn().mockResolvedValue({sent:0,failed:0});
    const {deliverChat}=idle();const prune=vi.fn().mockImplementationOnce(()=>{throw new Error('database is locked');});const onError=vi.fn();
    try {
      const worker=startJobs({} as Db,{onError}, {calendar:{refreshDue},notifications:{deliverDue,deliverChat},chat:{prune}});
      await vi.advanceTimersByTimeAsync(0);expect(onError).toHaveBeenCalledWith('chat');
      await vi.advanceTimersByTimeAsync(60_000);expect(refreshDue).toHaveBeenCalledTimes(2);expect(prune).toHaveBeenCalledTimes(2);
      await worker.stop();
    } finally {vi.useRealTimers();}
  });
});
