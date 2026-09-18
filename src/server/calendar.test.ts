import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { CalendarService, listImportConflicts, listSubscriptions } from './calendar';
import { readEntity, writeEntity } from './entities';
import type { fetchFeed } from './feed-fetch';
import type { Entity } from '@/domain/sync';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const calendar = (...events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Quasar tests//EN', ...events, 'END:VCALENDAR'].join('\r\n');
const event = (title='Read chapter 1', extras: string[] = []) => ['BEGIN:VEVENT','UID:assignment-1','DTSTART;VALUE=DATE:20260912',`SUMMARY:${title}`,'DESCRIPTION:Read carefully',...extras,'END:VEVENT'].join('\r\n');
function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const user = () => { const id=randomUUID(); db.prepare('INSERT INTO users(id,google_sub,email,created_at) VALUES(?,?,?,?)').run(id,id,`${id}@example.com`,'2026-09-11T00:00:00Z');return id; };
  const owner=user(), other=user();
  let now=new Date('2026-09-11T12:00:00Z');
  const fetcher=vi.fn<typeof fetchFeed>().mockResolvedValue({status:200,text:calendar(event()),etag:'v1'});
  const service=new CalendarService(db,{secret:'test-only-secret-that-is-at-least-32-characters',fetcher,now:()=>now});
  const advance=(milliseconds=61_000)=>{now=new Date(now.getTime()+milliseconds);};
  const subscribe=()=>service.subscribe(owner,{name:'Homework',url:'https://school.example/calendar.ics?private=secret-token',timeZone:'America/New_York'});
  const entities=()=> (db.prepare('SELECT id FROM entities WHERE owner_id=?').all(owner) as {id:string}[]).map(({id})=>readEntity(db,owner,id)!);
  const edit=(entity:Entity,data:Record<string,unknown>,deleted=false)=>{writeEntity(db,owner,{...entity,version:entity.version+1,data:{...entity.data,...data},deleted});return readEntity(db,owner,entity.id)!;};
  return {db,owner,other,service,fetcher,advance,subscribe,entities,edit};
}

describe('calendar subscriptions',()=>{
  it('stores the event link on the imported task and follows source changes',async()=>{
    const f=fixture();
    f.fetcher.mockResolvedValue({status:200,text:calendar(event('Read chapter 1',['URL:https://classroom.example/a/1'])),etag:'v1'});
    const subscription=await f.subscribe();
    expect(f.entities()[0].data).toMatchObject({imported:{url:'https://classroom.example/a/1'}});
    f.fetcher.mockResolvedValue({status:200,text:calendar(event('Read chapter 1',['URL:https://classroom.example/a/2'])),etag:'v2'});
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    expect(f.entities()[0].data).toMatchObject({imported:{url:'https://classroom.example/a/2'}});
    f.fetcher.mockResolvedValue({status:200,text:calendar(event()),etag:'v3'});
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    expect((f.entities()[0].data as {imported:{url:string|null}}).imported.url).toBeNull();
  });
  it('deduplicates subscription URLs, encrypts credentials, and isolates owners',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    expect((await f.subscribe()).id).toBe(subscription.id);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const row=f.db.prepare('SELECT url_encrypted FROM calendar_subscriptions WHERE id=?').get(subscription.id) as {url_encrypted:string};
    expect(row.url_encrypted).not.toContain('secret-token');
    expect(JSON.stringify(subscription)).not.toContain('secret-token');
    expect(listSubscriptions(f.db,f.other)).toEqual([]);
    expect(()=>f.service.remove(f.other,subscription.id)).toThrow('not found');
    expect(()=>f.service.setEnabled(f.other,subscription.id,false)).toThrow('not found');
    await expect(f.service.refresh(f.other,subscription.id)).rejects.toThrow('not found');
    expect(f.fetcher.mock.calls[0][0]).toBe('https://school.example/calendar.ics?private=secret-token');
  });
  it('keeps revisions and completion stable across repeated successful refreshes',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    const completed=f.edit(f.entities()[0],{completed:true,priority:'high'});
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    expect(f.entities()).toEqual([completed]);
    expect(listImportConflicts(f.db,f.owner)).toEqual([]);
    expect(listSubscriptions(f.db,f.owner)[0]).toMatchObject({itemCount:1,lastError:null});
  });
  it('applies source edits while retaining personal completion and priority',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    f.edit(f.entities()[0],{completed:true,priority:'high'});
    f.fetcher.mockResolvedValue({status:200,text:calendar(event('Read chapter 2'))});
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    expect(f.entities()[0].data).toMatchObject({title:'Read chapter 2',completed:true,priority:'high'});
    expect(listImportConflicts(f.db,f.owner)).toEqual([]);
  });
  it('retains concurrent edits for explicit version-checked conflict resolution',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    f.edit(f.entities()[0],{title:'My reading plan',completed:true});
    f.fetcher.mockResolvedValue({status:200,text:calendar(event('Teacher changed assignment'))});
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    const conflict=listImportConflicts(f.db,f.owner)[0];
    expect(conflict).toMatchObject({fields:['title'],incoming:{title:'Teacher changed assignment'}});
    expect(f.entities()[0].data.title).toBe('My reading plan');
    expect(listImportConflicts(f.db,f.other)).toEqual([]);
    expect(()=>f.service.resolve(f.owner,conflict.entityId,conflict.version-1,'source')).toThrow('changed');
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    expect(listImportConflicts(f.db,f.owner)).toHaveLength(1);
    f.service.resolve(f.owner,conflict.entityId,conflict.version,'source');
    expect(f.entities()[0].data).toMatchObject({title:'Teacher changed assignment',completed:true});
    expect(listImportConflicts(f.db,f.owner)).toEqual([]);
  });
  it('remembers keep-local decisions until a subsequent source edit',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    f.edit(f.entities()[0],{title:'Personal title'});
    f.fetcher.mockResolvedValue({status:200,text:calendar(event('Source title'))});
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    const c=listImportConflicts(f.db,f.owner)[0];
    f.service.resolve(f.owner,c.entityId,c.version,'local');
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    expect(listImportConflicts(f.db,f.owner)).toEqual([]);
    expect(f.entities()[0].data.title).toBe('Personal title');
    f.fetcher.mockResolvedValue({status:200,text:calendar(event('New source title'))});
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    expect(listImportConflicts(f.db,f.owner)).toHaveLength(1);
  });
  it('retains saved tasks on fetch or parse failure without leaking URL secrets',async()=>{
    const f=fixture(), subscription=await f.subscribe(), before=f.entities();
    f.fetcher.mockRejectedValue(new Error('failed https://school.example?private=secret-token'));
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    expect(f.entities()).toEqual(before);
    expect(listSubscriptions(f.db,f.owner)[0].lastError).toMatch(/saved items are unchanged/);
    expect(JSON.stringify(listSubscriptions(f.db,f.owner))).not.toContain('secret-token');
    f.fetcher.mockResolvedValue({status:200,text:'not a calendar'});
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    expect(f.entities()).toEqual(before);
    expect(listSubscriptions(f.db,f.owner)[0].lastError).toBeTruthy();
  });
  it('retains cancelled or missing source items, restores them on return, and detaches on unsubscribe',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    f.edit(f.entities()[0],{completed:true});
    for(const text of [calendar(event('Read chapter 1',['STATUS:CANCELLED'])),calendar()]) {
      f.fetcher.mockResolvedValue({status:200,text});f.advance();await f.service.refresh(f.owner,subscription.id);
      expect(f.entities()[0].data).toMatchObject({completed:true,imported:{sourceRemoved:true}});
    }
    f.fetcher.mockResolvedValue({status:200,text:calendar(event())});f.advance();await f.service.refresh(f.owner,subscription.id);
    expect(f.entities()[0].data).toMatchObject({completed:true,imported:{sourceRemoved:false}});
    f.service.remove(f.owner,subscription.id);
    expect(f.entities()[0].data).toMatchObject({title:'Read chapter 1',completed:true});
    expect(f.entities()[0].data.imported).toBeUndefined();
    expect(listSubscriptions(f.db,f.owner)).toEqual([]);
  });
  it('marks a removed source item without deleting the completed task',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    f.edit(f.entities()[0],{completed:true});
    f.fetcher.mockResolvedValue({status:200,text:calendar()});f.advance();
    await f.service.refresh(f.owner,subscription.id);
    expect(f.entities()).toHaveLength(1);
    expect(f.entities()[0]).toMatchObject({deleted:false,data:{completed:true,imported:{sourceRemoved:true}}});
  });
  it('rejects an entire malformed refresh without partially applying valid items',async()=>{
    const f=fixture(), subscription=await f.subscribe(), before=f.entities();
    f.fetcher.mockResolvedValue({status:200,text:calendar(event('Should not apply'),'BEGIN:VEVENT\r\nUID:broken\r\nSUMMARY:No date\r\nEND:VEVENT')});
    f.advance();await f.service.refresh(f.owner,subscription.id);
    expect(f.entities()).toEqual(before);
    expect(listSubscriptions(f.db,f.owner)[0].lastError).toBeTruthy();
  });
  it('does not resurrect a locally deleted imported task',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    const deleted=f.edit(f.entities()[0],{},true);
    f.fetcher.mockResolvedValue({status:200,text:calendar(event('Updated deleted assignment'))});
    f.advance();await f.service.refresh(f.owner,subscription.id);
    expect(f.entities()).toEqual([deleted]);
    expect(listSubscriptions(f.db,f.owner)[0].itemCount).toBe(0);
  });
  it('discards an in-flight refresh after the subscription is paused',async()=>{
    const f=fixture(), subscription=await f.subscribe(), before=f.entities();
    let finish!: (value:Awaited<ReturnType<typeof fetchFeed>>)=>void;
    f.fetcher.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    f.advance();const refresh=f.service.refresh(f.owner,subscription.id);
    f.service.setEnabled(f.owner,subscription.id,false);
    finish({status:200,text:calendar(event('Stale refresh'))});await refresh;
    expect(f.entities()).toEqual(before);
    expect(listSubscriptions(f.db,f.owner)[0].enabled).toBe(false);
  });
  it('does not recreate a subscription removed during an in-flight refresh',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    let finish!: (value:Awaited<ReturnType<typeof fetchFeed>>)=>void;
    f.fetcher.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    f.advance();const refresh=f.service.refresh(f.owner,subscription.id);
    f.service.remove(f.owner,subscription.id);
    finish({status:200,text:calendar(event('Stale refresh'))});await refresh;
    expect(listSubscriptions(f.db,f.owner)).toEqual([]);
    expect(f.entities()[0].data.title).toBe('Read chapter 1');
    expect(f.entities()[0].data.imported).toBeUndefined();
  });
  it('refreshes on the scheduled interval, honors pauses and backs off failed requests',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    expect(await f.service.refreshDue()).toBe(0);
    f.advance(30*60_000);
    f.fetcher.mockRejectedValue(new Error('offline'));
    expect(await f.service.refreshDue()).toBe(1);
    expect(await f.service.refreshDue()).toBe(0);
    f.advance(5*60_000);
    expect(await f.service.refreshDue()).toBe(1);
    f.advance(5*60_000);
    expect(await f.service.refreshDue()).toBe(0);
    f.service.setEnabled(f.owner,subscription.id,false);
    f.advance(24*3600_000);
    expect(await f.service.refreshDue()).toBe(0);
    expect(f.entities()).toHaveLength(1);
  });
  it('expands the rolling recurrence window even when the source returns 304',async()=>{
    const f=fixture();
    f.fetcher.mockResolvedValue({status:200,text:calendar(event('Daily work',['RRULE:FREQ=DAILY'])),etag:'unchanged'});
    const subscription=await f.subscribe();
    const initial=f.entities().length;
    f.fetcher.mockResolvedValue({status:304});f.advance(24*3600_000);
    await f.service.refresh(f.owner,subscription.id);
    expect(f.entities()).toHaveLength(initial+1);
    expect(f.fetcher.mock.calls[1][1]).toMatchObject({etag:'unchanged'});
    expect(listSubscriptions(f.db,f.owner)[0].lastError).toBeNull();
  });
});
