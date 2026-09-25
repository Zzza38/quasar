import {describe,it,expect,vi} from 'vitest';
import {errorSummary,startJobs} from './jobs';
import type {Db} from './db';

const idle=()=>({deliverChat:vi.fn().mockResolvedValue({sent:0,failed:0}),deliverSupport:vi.fn().mockResolvedValue({sent:0,failed:0}),prune:vi.fn()});

describe('background jobs',()=>{
  it('runs sequentially without overlap and stops gracefully during an active refresh',async()=>{
    vi.useFakeTimers();
    let finish!:()=>void;
    const refreshDue=vi.fn().mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
    const deliverDue=vi.fn().mockResolvedValue({sent:0,failed:0});const {deliverChat,deliverSupport,prune}=idle();
    try {
      const worker=startJobs({} as Db,{}, {calendar:{refreshDue},notifications:{deliverDue,deliverChat,deliverSupport},chat:{prune}});
      await vi.advanceTimersByTimeAsync(180_000);
      expect(refreshDue).toHaveBeenCalledTimes(1);expect(deliverDue).not.toHaveBeenCalled();
      const stop=worker.stop();finish();await stop;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(refreshDue).toHaveBeenCalledTimes(1);expect(deliverDue).not.toHaveBeenCalled();
      expect(deliverChat).not.toHaveBeenCalled();expect(deliverSupport).not.toHaveBeenCalled();expect(prune).not.toHaveBeenCalled();
    } finally {vi.useRealTimers();}
  });
  it('continues notifications after refresh errors and retries on the next cycle',async()=>{
    vi.useFakeTimers();
    const refreshDue=vi.fn().mockRejectedValue(new Error('sensitive feed URL'));
    const deliverDue=vi.fn().mockResolvedValue({sent:1,failed:0});const onError=vi.fn();const {deliverChat,deliverSupport,prune}=idle();
    try {
      const worker=startJobs({} as Db,{onError}, {calendar:{refreshDue},notifications:{deliverDue,deliverChat,deliverSupport},chat:{prune}});
      await vi.advanceTimersByTimeAsync(0);
      expect(deliverDue).toHaveBeenCalledTimes(1);expect(onError).toHaveBeenCalledWith('calendar',expect.any(Error));
      expect(deliverChat).toHaveBeenCalledTimes(1);expect(deliverSupport).toHaveBeenCalledTimes(1);expect(prune).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);expect(refreshDue).toHaveBeenCalledTimes(2);expect(deliverDue).toHaveBeenCalledTimes(2);
      await worker.stop();await vi.advanceTimersByTimeAsync(60_000);expect(refreshDue).toHaveBeenCalledTimes(2);
    } finally {vi.useRealTimers();}
  });
  it('runs refresh, reminders, chat pushes, support pushes and chat retention in order within one cycle, with no overlap',async()=>{
    vi.useFakeTimers();
    const order:string[]=[];let active=0;let overlapped=false;
    const step=(name:string,ms:number)=>vi.fn().mockImplementation(async()=>{
      order.push(`${name}:start`);if(active++)overlapped=true;
      await new Promise(resolve=>setTimeout(resolve,ms));
      active--;order.push(`${name}:end`);return {sent:0,failed:0};
    });
    const refreshDue=step('refreshDue',5_000),deliverDue=step('deliverDue',5_000),deliverChat=step('deliverChat',90_000),deliverSupport=step('deliverSupport',5_000);
    const prune=vi.fn().mockImplementation((now:Date)=>{expect(now).toBeInstanceOf(Date);if(active)overlapped=true;order.push('prune');});
    try {
      const worker=startJobs({} as Db,{intervalMs:1_000}, {calendar:{refreshDue},notifications:{deliverDue,deliverChat,deliverSupport},chat:{prune}});
      await vi.advanceTimersByTimeAsync(105_000);
      expect(order).toEqual(['refreshDue:start','refreshDue:end','deliverDue:start','deliverDue:end','deliverChat:start','deliverChat:end','deliverSupport:start','deliverSupport:end','prune']);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(refreshDue).toHaveBeenCalledTimes(2);expect(deliverChat).toHaveBeenCalledTimes(1);expect(deliverSupport).toHaveBeenCalledTimes(1);
      const stop=worker.stop();await vi.advanceTimersByTimeAsync(10_000);await stop;
      expect(overlapped).toBe(false);
    } finally {vi.useRealTimers();}
  });
  it('reports a failing chat push step as chat, still prunes, and retries on the next cycle',async()=>{
    vi.useFakeTimers();
    const refreshDue=vi.fn().mockResolvedValue(undefined);const deliverDue=vi.fn().mockResolvedValue({sent:0,failed:0});
    const deliverChat=vi.fn().mockRejectedValueOnce(new Error('ZX-SECRET-42 message text')).mockResolvedValue({sent:1,failed:0});
    const {deliverSupport}=idle();const prune=vi.fn();const onError=vi.fn();
    try {
      const worker=startJobs({} as Db,{onError}, {calendar:{refreshDue},notifications:{deliverDue,deliverChat,deliverSupport},chat:{prune}});
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).toHaveBeenCalledTimes(1);expect(onError).toHaveBeenCalledWith('chat',expect.any(Error));expect(deliverSupport).toHaveBeenCalledTimes(1);expect(prune).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deliverChat).toHaveBeenCalledTimes(2);expect(prune).toHaveBeenCalledTimes(2);expect(onError).toHaveBeenCalledTimes(1);
      await worker.stop();
    } finally {vi.useRealTimers();}
  });
  it('reports a failing chat prune as chat and keeps the loop running',async()=>{
    vi.useFakeTimers();
    const refreshDue=vi.fn().mockResolvedValue(undefined);const deliverDue=vi.fn().mockResolvedValue({sent:0,failed:0});
    const {deliverChat,deliverSupport}=idle();const prune=vi.fn().mockImplementationOnce(()=>{throw new Error('database is locked');});const onError=vi.fn();
    try {
      const worker=startJobs({} as Db,{onError}, {calendar:{refreshDue},notifications:{deliverDue,deliverChat,deliverSupport},chat:{prune}});
      await vi.advanceTimersByTimeAsync(0);expect(onError).toHaveBeenCalledWith('chat',expect.any(Error));
      await vi.advanceTimersByTimeAsync(60_000);expect(refreshDue).toHaveBeenCalledTimes(2);expect(prune).toHaveBeenCalledTimes(2);
      await worker.stop();
    } finally {vi.useRealTimers();}
  });
  it('reports a failing support push step as support, still prunes, and retries on the next cycle',async()=>{
    vi.useFakeTimers();
    const refreshDue=vi.fn().mockResolvedValue(undefined);const deliverDue=vi.fn().mockResolvedValue({sent:0,failed:0});
    const {deliverChat}=idle();const deliverSupport=vi.fn().mockRejectedValueOnce(new Error('private request text')).mockResolvedValue({sent:1,failed:0});
    const prune=vi.fn();const onError=vi.fn();
    try {
      const worker=startJobs({} as Db,{onError}, {calendar:{refreshDue},notifications:{deliverDue,deliverChat,deliverSupport},chat:{prune}});
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).toHaveBeenCalledTimes(1);expect(onError).toHaveBeenCalledWith('support',expect.any(Error));expect(prune).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deliverSupport).toHaveBeenCalledTimes(2);expect(prune).toHaveBeenCalledTimes(2);expect(onError).toHaveBeenCalledTimes(1);
      await worker.stop();
    } finally {vi.useRealTimers();}
  });
  it('reports non-zero failed push counts per step, with no provider text, and stays quiet when nothing failed',async()=>{
    vi.useFakeTimers();
    const refreshDue=vi.fn().mockResolvedValue(undefined);
    const deliverDue=vi.fn().mockResolvedValueOnce({sent:0,failed:3}).mockResolvedValue({sent:1,failed:0});
    const deliverChat=vi.fn().mockResolvedValue({sent:0,failed:0});const deliverSupport=vi.fn().mockResolvedValueOnce({sent:1,failed:1}).mockResolvedValue({sent:0,failed:0});
    const prune=vi.fn();const onError=vi.fn();const onFailures=vi.fn();
    try {
      const worker=startJobs({} as Db,{onError,onFailures}, {calendar:{refreshDue},notifications:{deliverDue,deliverChat,deliverSupport},chat:{prune}});
      await vi.advanceTimersByTimeAsync(0);
      expect(onFailures.mock.calls).toEqual([['notifications',3],['support',1]]);expect(onError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onFailures).toHaveBeenCalledTimes(2);expect(prune).toHaveBeenCalledTimes(2);
      await worker.stop();
    } finally {vi.useRealTimers();}
  });
  it('passes the thrown error to onError, and summarises it by name and code without the message',async()=>{
    vi.useFakeTimers();
    const busy=Object.assign(new Error('database is locked at https://feeds.example/private-token'),{code:'SQLITE_BUSY'});
    const refreshDue=vi.fn().mockRejectedValueOnce(busy).mockResolvedValue(undefined);const deliverDue=vi.fn().mockResolvedValue({sent:0,failed:0});
    const {deliverChat,deliverSupport,prune}=idle();const onError=vi.fn();
    try {
      const worker=startJobs({} as Db,{onError}, {calendar:{refreshDue},notifications:{deliverDue,deliverChat,deliverSupport},chat:{prune}});
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).toHaveBeenCalledWith('calendar',busy);
      await worker.stop();
    } finally {vi.useRealTimers();}
    expect(errorSummary(busy)).toBe('Error, code SQLITE_BUSY');
    expect(errorSummary(busy)).not.toContain('private-token');
    class WebPushError extends Error {statusCode=410;override name='WebPushError';}
    expect(errorSummary(new WebPushError('gone: https://push.example/endpoint'))).toBe('WebPushError, status 410');
    expect(errorSummary(Object.assign(new TypeError('x'),{code:'bad code with https://x'}))).toBe('TypeError');
    expect(errorSummary('https://feeds.example/private-token')).toBe('non-error value');
  });
});
