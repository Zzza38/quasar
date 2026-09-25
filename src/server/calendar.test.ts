import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from './db';
import { CalendarService, FEED_ADD_DAILY_LIMIT, FEED_ADD_HOURLY_LIMIT, GENERIC_REFRESH_ERROR, listImportConflicts, listSubscriptions, type FeedSubscription } from './calendar';
import { readEntity, writeEntity } from './entities';
import { Service } from './service';
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
  it('imports an event ending after 2199 and unsticks one an older build stored with that end date',async()=>{
    const f=fixture();
    f.fetcher.mockResolvedValue({status:200,text:calendar(event('Read chapter 1',['DTEND;VALUE=DATE:23000101'])),etag:'v1'});
    const subscription=await f.subscribe();
    const [task]=f.entities();
    expect(task.data).toMatchObject({title:'Read chapter 1',imported:{startDate:'2026-09-12',endDate:null}});
    // What an older build stored: the end date its schema still accepted, which taskSchema now rejects.
    const stored=f.edit(task,{imported:{...(task.data.imported as object),endDate:'2300-01-01'}});
    f.fetcher.mockResolvedValue({status:200,text:calendar(event('Read chapter 2',['DTEND;VALUE=DATE:23000101'])),etag:'v2'});
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    const [refreshed]=f.entities();
    expect(refreshed.version).toBe(stored.version+1);
    expect(refreshed.data).toMatchObject({title:'Read chapter 2',imported:{endDate:null}});
  });
  it('imports VTODOs with a start before 1900 or a due date after 2199, and relinks or keeps tasks the date repair changed',async()=>{
    const f=fixture();
    const todos=(title:string)=>calendar(
      ['BEGIN:VTODO','UID:ancient','DTSTART;VALUE=DATE:18500101','DUE;VALUE=DATE:20260920',`SUMMARY:${title}`,'END:VTODO'].join('\r\n'),
      ['BEGIN:VTODO','UID:someday','DTSTART;VALUE=DATE:20260912','DUE;VALUE=DATE:45010101','SUMMARY:Someday','END:VTODO'].join('\r\n'));
    f.fetcher.mockResolvedValue({status:200,text:todos('Ancient'),etag:'v1'});
    const subscription=await f.subscribe();
    const byTitle=(title:string)=>f.entities().find(entity=>entity.data.title===title)!;
    expect(byTitle('Ancient').data).toMatchObject({dueDate:'2026-09-20',imported:{startDate:'2026-09-20',endDate:'2026-09-20'}});
    expect(byTitle('Someday').data).toMatchObject({dueDate:null,dueTime:null,imported:{startDate:'2026-09-12',endDate:null}});
    // What repairTaskDates leaves of the copies an older build stored: the 1850 start dropped the calendar link, and
    // the 4501 due date and end were cleared. The source data kept the old dates.
    const unlinked=f.edit(byTitle('Ancient'),{imported:null});
    f.db.prepare("UPDATE calendar_items SET source_data=json_set(source_data,'$.startDate','1850-01-01') WHERE item_key=?").run(JSON.stringify(['ancient',null]));
    f.db.prepare("UPDATE calendar_items SET source_data=json_set(source_data,'$.dueDate','4501-01-01','$.endDate','4501-01-01') WHERE item_key=?").run(JSON.stringify(['someday',null]));
    f.fetcher.mockResolvedValue({status:200,text:todos('Ancient, revised'),etag:'v2'});
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    const relinked=byTitle('Ancient, revised');
    expect(relinked.id).toBe(unlinked.id);
    expect(relinked.data).toMatchObject({imported:{uid:'ancient',startDate:'2026-09-20'}});
    expect(byTitle('Someday').data).toMatchObject({dueDate:null,imported:{endDate:null}});
    expect(listImportConflicts(f.db,f.owner)).toEqual([]);
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
  it('turns a source time on a task whose date was cleared into a choice without freezing the feed',async()=>{
    const f=fixture();
    const item=(uid:string,title:string,start:string)=>['BEGIN:VEVENT',`UID:${uid}`,start,`SUMMARY:${title}`,'END:VEVENT'].join('\r\n');
    f.fetcher.mockResolvedValue({status:200,text:calendar(item('a','A','DTSTART;VALUE=DATE:20260912'),item('b','B1','DTSTART;VALUE=DATE:20260913'))});
    const subscription=await f.subscribe();
    const a=f.entities().find(entity=>entity.data.title==='A')!;
    f.edit(a,{dueDate:null,dueTime:null});
    f.fetcher.mockResolvedValue({status:200,text:calendar(item('a','A','DTSTART;TZID=America/New_York:20260912T100000'),item('b','B2','DTSTART;VALUE=DATE:20260913'))});
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    expect(listSubscriptions(f.db,f.owner)[0].lastError).toBeNull();
    expect(f.entities().map(entity=>entity.data.title).sort()).toEqual(['A','B2']);
    expect(readEntity(f.db,f.owner,a.id)!.data).toMatchObject({dueDate:null,dueTime:null});
    const conflict=listImportConflicts(f.db,f.owner)[0];
    expect(conflict.entityId).toBe(a.id);
    expect([...conflict.fields].sort()).toEqual(['dueDate','dueTime']);
    f.service.resolve(f.owner,conflict.entityId,conflict.version,'source');
    expect(readEntity(f.db,f.owner,a.id)!.data).toMatchObject({dueDate:'2026-09-12',dueTime:'10:00'});
  });
  it('still applies a source-only rename when the same refresh adds a time to a task whose date was cleared',async()=>{
    const f=fixture();
    const item=(title:string,start:string)=>['BEGIN:VEVENT','UID:essay',start,`SUMMARY:${title}`,'END:VEVENT'].join('\r\n');
    f.fetcher.mockResolvedValue({status:200,text:calendar(item('Essay','DTSTART;VALUE=DATE:20260912'))});
    const subscription=await f.subscribe();
    const essay=f.entities()[0];
    f.edit(essay,{dueDate:null,dueTime:null});
    f.fetcher.mockResolvedValue({status:200,text:calendar(item('Essay v2','DTSTART;TZID=America/New_York:20260912T100000'))});
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    // The student never edited the title, so the rename is not a choice; only the due date and time are.
    expect(readEntity(f.db,f.owner,essay.id)!.data).toMatchObject({title:'Essay v2',dueDate:null,dueTime:null});
    expect([...listImportConflicts(f.db,f.owner)[0].fields].sort()).toEqual(['dueDate','dueTime']);
  });
  it('refuses a stale choice after a refresh changed the source values without touching the task',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    f.edit(f.entities()[0],{title:'My reading plan'});
    f.fetcher.mockResolvedValue({status:200,text:calendar(event('Source A'))});
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    const seen=listImportConflicts(f.db,f.owner)[0];
    f.fetcher.mockResolvedValue({status:200,text:calendar(event('Source B'))});
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    const current=listImportConflicts(f.db,f.owner)[0];
    expect(current).toMatchObject({version:seen.version,incoming:{title:'Source B'}});
    expect(current.revision).not.toBe(seen.revision);
    for(const choice of ['source','local'] as const)expect(()=>f.service.resolve(f.owner,seen.entityId,seen.version,choice,seen.revision)).toThrow('changed this item again');
    expect(f.entities()[0].data.title).toBe('My reading plan');
    f.service.resolve(f.owner,current.entityId,current.version,'source',current.revision);
    expect(f.entities()[0].data.title).toBe('Source B');
  });
  it('applies a due date and time together for a conflict stored with only one of them',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    const task=f.edit(f.entities()[0],{dueDate:null,dueTime:null});
    f.fetcher.mockResolvedValue({status:200,text:calendar(event('Read chapter 1').replace('DTSTART;VALUE=DATE:20260912','DTSTART;TZID=America/New_York:20260912T100000'))});
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    // A row recorded before refresh paired the two fields.
    f.db.prepare('UPDATE calendar_conflicts SET fields=? WHERE entity_id=?').run(JSON.stringify(['dueTime']),task.id);
    const conflict=listImportConflicts(f.db,f.owner)[0];
    expect([...conflict.fields].sort()).toEqual(['dueDate','dueTime']);
    f.service.resolve(f.owner,conflict.entityId,conflict.version,'source',conflict.revision);
    expect(readEntity(f.db,f.owner,task.id)!.data).toMatchObject({dueDate:'2026-09-12',dueTime:'10:00'});
    expect(listImportConflicts(f.db,f.owner)).toEqual([]);
  });
  it('marks a removed VTODO that started before the window but is due inside it',async()=>{
    const f=fixture();
    f.fetcher.mockResolvedValue({status:200,text:calendar(['BEGIN:VTODO','UID:project','DTSTART;VALUE=DATE:20260501','DUE;VALUE=DATE:20260920','SUMMARY:Term project','END:VTODO'].join('\r\n'))});
    const subscription=await f.subscribe();
    expect(f.entities()).toHaveLength(1);
    expect(f.entities()[0].data).toMatchObject({title:'Term project',dueDate:'2026-09-20'});
    f.fetcher.mockResolvedValue({status:200,text:calendar()});
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    expect(f.entities()[0].data).toMatchObject({imported:{sourceRemoved:true}});
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
  it('does not record a busy database as a feed failure',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'quasar-busy-'));
    const web=openDatabase(join(dir,'quasar.sqlite')), worker=openDatabase(join(dir,'quasar.sqlite'));
    try{
      const owner=randomUUID();
      web.prepare('INSERT INTO users(id,google_sub,email,created_at) VALUES(?,?,?,?)').run(owner,owner,`${owner}@example.com`,'2026-09-11T00:00:00Z');
      let now=new Date('2026-09-11T12:00:00Z');
      const fetcher=vi.fn<typeof fetchFeed>().mockResolvedValue({status:200,text:calendar(event()),etag:'v1'});
      const service=new CalendarService(worker,{secret:'test-only-secret-that-is-at-least-32-characters',fetcher,now:()=>now});
      const subscription=await service.subscribe(owner,{name:'Homework',url:'https://school.example/calendar.ics',timeZone:'America/New_York'});
      // The web process holds the write lock while the worker applies the feed, longer than the worker's busy_timeout.
      worker.pragma('busy_timeout = 0');
      fetcher.mockImplementation(async()=>{web.prepare('BEGIN IMMEDIATE').run();return {status:200,text:calendar(event('Read chapter 2')),etag:'v2'};});
      now=new Date(now.getTime()+61_000);
      await service.refresh(owner,subscription.id);
      web.prepare('COMMIT').run();
      expect(listSubscriptions(worker,owner)[0]).toMatchObject({lastError:null});
      expect((worker.prepare('SELECT failure_count n FROM calendar_subscriptions WHERE id=?').get(subscription.id) as {n:number}).n).toBe(0);
      // Releasing the lease was busy too here, so it lapses on its own; the next refresh applies the feed.
      fetcher.mockResolvedValue({status:200,text:calendar(event('Read chapter 2')),etag:'v2'});
      now=new Date(now.getTime()+121_000);
      await service.refresh(owner,subscription.id);
      const title=(worker.prepare("SELECT data FROM entities WHERE owner_id=? AND kind='task'").get(owner) as {data:string}).data;
      expect(JSON.parse(title)).toMatchObject({title:'Read chapter 2'});
    }finally{web.close();worker.close();rmSync(dir,{recursive:true,force:true});}
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
  it('keeps refreshing the rest of a scheduled batch when a feed is removed before its turn',async()=>{
    const f=fixture();
    const urls=['https://school.example/a.ics','https://school.example/b.ics','https://school.example/c.ics'];
    const feeds:FeedSubscription[]=[];
    for(const [index,url] of urls.entries())feeds.push(await f.service.subscribe(f.owner,{name:`Feed ${index}`,url,timeZone:'America/New_York'}));
    f.advance(30*60_000);
    let removed:string|null=null;
    f.fetcher.mockImplementation(async(url)=>{
      // While the first feed downloads, the student removes one that is still waiting in the batch.
      if(!removed){const waiting=feeds.find(feed=>urls[feeds.indexOf(feed)]!==url)!;removed=waiting.id;f.service.remove(f.owner,waiting.id);}
      return {status:200,text:calendar(event()),etag:'v2'};
    });
    await expect(f.service.refreshDue()).resolves.toBe(3);
    expect(f.fetcher).toHaveBeenCalledTimes(3+2);
    const left=listSubscriptions(f.db,f.owner);
    expect(left.map(feed=>feed.id).sort()).toEqual(feeds.map(feed=>feed.id).filter(id=>id!==removed).sort());
    for(const feed of left)expect(Date.parse(feed.lastSuccessAt!)).toBeGreaterThan(Date.parse('2026-09-11T12:00:00Z'));
    // A manual refresh of a feed that is gone still says so.
    await expect(f.service.refresh(f.owner,removed!)).rejects.toThrow('not found');
  });
  it('refreshes a scheduled batch several feeds at a time and stops starting new ones when the time budget is spent',async()=>{
    const f=fixture();
    for(const name of ['a','b','c'])await f.service.subscribe(f.owner,{name,url:`https://school.example/${name}.ics`,timeZone:'America/New_York'});
    f.advance(30*60_000);
    const waiting:(()=>void)[]=[];
    f.fetcher.mockImplementation(()=>new Promise(resolve=>{waiting.push(()=>resolve({status:200,text:calendar(event()),etag:'v2'}));}));
    const batch=f.service.refreshDue(500,{concurrency:2});
    await vi.waitFor(()=>expect(waiting).toHaveLength(2));
    waiting.shift()!();
    await vi.waitFor(()=>expect(waiting).toHaveLength(2));
    for(const finish of waiting.splice(0))finish();
    await expect(batch).resolves.toBe(3);
    f.advance(30*60_000);
    f.fetcher.mockResolvedValue({status:200,text:calendar(event()),etag:'v3'});
    // Out of time: only the first round starts; the rest stay due for the next cycle.
    await expect(f.service.refreshDue(500,{concurrency:1,budgetMs:0})).resolves.toBe(1);
    await expect(f.service.refreshDue(500,{concurrency:5,budgetMs:0})).resolves.toBe(2);
  });
  it('tells a manual refresh why nothing was fetched instead of returning quietly',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    // subscribe just fetched the feed, so an immediate refresh is throttled.
    await expect(f.service.refreshNow(f.owner,subscription.id)).rejects.toMatchObject({code:'TOO_MANY_REQUESTS',message:expect.stringMatching(/less than a minute ago/)});
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    // Adding the same link again still succeeds; it only skips the fetch.
    await expect(f.subscribe()).resolves.toMatchObject({id:subscription.id});
    let finish!: (value:Awaited<ReturnType<typeof fetchFeed>>)=>void;
    f.fetcher.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    f.advance();const running=f.service.refreshNow(f.owner,subscription.id);
    await expect(f.service.refreshNow(f.owner,subscription.id)).rejects.toMatchObject({code:'TOO_MANY_REQUESTS',message:expect.stringMatching(/refreshing right now/)});
    finish({status:200,text:calendar(event('Read chapter 2'))});await running;
    expect(f.entities()[0].data.title).toBe('Read chapter 2');
    f.service.setEnabled(f.owner,subscription.id,false);f.advance();
    await expect(f.service.refreshNow(f.owner,subscription.id)).rejects.toMatchObject({code:'BAD_REQUEST'});
    f.service.setEnabled(f.owner,subscription.id,true);
    f.fetcher.mockResolvedValue({status:200,text:calendar(event('Read chapter 3'))});
    await expect(f.service.refreshNow(f.owner,subscription.id)).resolves.toBeUndefined();
    expect(f.entities()[0].data.title).toBe('Read chapter 3');
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
  it('limits new feeds per hour and per day, and removing feeds does not refund the limit',async()=>{
    const f=fixture();
    let n=0;
    const addAndRemove=async()=>{const s=await f.service.subscribe(f.owner,{name:'Feed',url:`https://school.example/calendar-${n++}.ics`,timeZone:'America/New_York'});f.service.remove(f.owner,s.id);};
    for(let i=0;i<FEED_ADD_HOURLY_LIMIT;i++)await addAndRemove();
    await expect(addAndRemove()).rejects.toMatchObject({code:'TOO_MANY_REQUESTS'});
    expect(f.fetcher).toHaveBeenCalledTimes(FEED_ADD_HOURLY_LIMIT);
    expect(listSubscriptions(f.db,f.owner)).toEqual([]);
    // Another account has its own budget.
    expect((await f.service.subscribe(f.other,{name:'Feed',url:'https://school.example/other.ics',timeZone:'America/New_York'})).lastError).toBeNull();
    for(let i=FEED_ADD_HOURLY_LIMIT;i<FEED_ADD_DAILY_LIMIT;i++){if(i%FEED_ADD_HOURLY_LIMIT===0)f.advance(3_600_000);await addAndRemove();}
    f.advance(3_600_000);
    await expect(addAndRemove()).rejects.toMatchObject({code:'TOO_MANY_REQUESTS',message:expect.stringContaining('per day')});
    f.advance(24*3_600_000);
    await addAndRemove();
  });
  it('imports a whitespace-only title as untitled without failing the rest of the feed',async()=>{
    const f=fixture();
    const item=(uid:string,title:string)=>['BEGIN:VEVENT',`UID:${uid}`,'DTSTART;VALUE=DATE:20260912',`SUMMARY:${title}`,'END:VEVENT'].join('\r\n');
    f.fetcher.mockResolvedValue({status:200,text:calendar(item('a','Essay'),item('b','  '),['BEGIN:VEVENT','UID:c','DTSTART;VALUE=DATE:20260913',`URL:https://a.example/${'é'.repeat(1000)}`,'SUMMARY:Linked','END:VEVENT'].join('\r\n'))});
    await f.subscribe();
    expect(listSubscriptions(f.db,f.owner)[0]).toMatchObject({lastError:null,itemCount:3});
    expect(f.entities().map(entity=>entity.data.title).sort()).toEqual(['Essay','Linked','Untitled calendar item']);
  });
  it('follows a source rename of a title with trailing spaces instead of recording a false conflict',async()=>{
    const f=fixture();
    f.fetcher.mockResolvedValue({status:200,text:calendar(event('Essay '))});
    const subscription=await f.subscribe();
    // A row saved before titles were trimmed at parse time still compares against the trimmed task title.
    f.db.prepare("UPDATE calendar_items SET source_data=json_set(source_data,'$.title','Essay ')").run();
    for(const title of ['Essay 2 ','Essay 3 ']){
      f.fetcher.mockResolvedValue({status:200,text:calendar(event(title))});
      f.advance(); await f.service.refresh(f.owner,subscription.id);
      expect(listImportConflicts(f.db,f.owner)).toEqual([]);
      expect(f.entities()[0].data.title).toBe(title.trim());
    }
  });
  it('shows fixed, URL-free failure reasons and keeps the generic message for anything else',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    f.fetcher.mockRejectedValue(new Error('Calendar server returned HTTP 404.'));
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    expect(listSubscriptions(f.db,f.owner)[0].lastError).toBe('Could not refresh this feed. Calendar server returned HTTP 404. Your saved items are unchanged.');
    f.fetcher.mockResolvedValue({status:200,text:calendar(event('Daily',['RRULE:FREQ=HOURLY']))});
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    expect(listSubscriptions(f.db,f.owner)[0].lastError).toMatch(/Only daily, weekly, monthly and yearly/);
    f.fetcher.mockRejectedValue(new Error('Calendar server returned HTTP 404 for https://school.example?private=secret-token.'));
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    expect(listSubscriptions(f.db,f.owner)[0].lastError).toBe(GENERIC_REFRESH_ERROR);
  });
  it('keeps DNS answers out of the stored error, so it cannot tell which internal host names exist',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    f.fetcher.mockRejectedValue(new Error('Calendar host must resolve only to public internet addresses.'));
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    const privateHost=listSubscriptions(f.db,f.owner)[0].lastError;
    f.fetcher.mockRejectedValue(new Error('getaddrinfo ENOTFOUND intranet.example'));
    f.advance(); await f.service.refresh(f.owner,subscription.id);
    expect(privateHost).toBe(GENERIC_REFRESH_ERROR);
    expect(listSubscriptions(f.db,f.owner)[0].lastError).toBe(privateHost);
  });
  it('reports a missing NEXTAUTH_SECRET to the caller instead of telling students their key changed',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    const before=f.db.prepare('SELECT * FROM calendar_subscriptions').get();
    const unconfigured=new CalendarService(f.db,{secret:'',fetcher:f.fetcher,now:()=>new Date('2026-09-11T13:00:00Z')});
    await expect(unconfigured.refreshDue()).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
    await expect(unconfigured.refresh(f.owner,subscription.id)).rejects.toThrow('Calendar encryption is not configured.');
    // No feed was leased, fetched or given a stored error.
    expect(f.db.prepare('SELECT * FROM calendar_subscriptions').get()).toEqual(before);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(listSubscriptions(f.db,f.owner)[0].lastError).toBeNull();
  });
  it('moves a task stored under an override\'s old RECURRENCE-ID text to the occurrence it replaces',async()=>{
    const f=fixture();
    const master=['BEGIN:VEVENT','UID:zoned','DTSTART;TZID=America/New_York:20261026T090000','RRULE:FREQ=WEEKLY;COUNT=3','SUMMARY:Class','END:VEVENT'].join('\r\n');
    const moved=['BEGIN:VEVENT','UID:zoned','RECURRENCE-ID:20261102T140000Z','DTSTART:20261102T160000Z','SUMMARY:Moved','END:VEVENT'].join('\r\n');
    f.fetcher.mockResolvedValue({status:200,text:calendar(master)});
    const subscription=await f.subscribe();
    const occurrence=(recurrenceId:string)=>f.entities().find(e=>(e.data.imported as {recurrenceId:string}).recurrenceId===recurrenceId)!;
    const duplicate=occurrence('2026-11-02T09:00:00');
    // What earlier imports stored for the override: its own row and task under the UTC text, next to the duplicate
    // occurrence. The student completed the moved one.
    const key=JSON.stringify(['zoned','2026-11-02T09:00:00']), legacyKey=JSON.stringify(['zoned','2026-11-02T14:00:00Z']);
    const itemRow=(itemKey:string)=>f.db.prepare('SELECT entity_id,source_data FROM calendar_items WHERE subscription_id=? AND item_key=?').get(subscription.id,itemKey) as {entity_id:string;source_data:string}|undefined;
    const source={...JSON.parse(itemRow(key)!.source_data),recurrenceId:'2026-11-02T14:00:00Z',title:'Moved',startTime:'11:00',dueTime:'11:00'};
    const imported={...(duplicate.data.imported as object),recurrenceId:'2026-11-02T14:00:00Z',startTime:'11:00'};
    writeEntity(f.db,f.owner,{...duplicate,id:'ical_legacy',version:1,data:{...duplicate.data,title:'Moved',dueTime:'11:00',completed:true,imported}});
    f.db.prepare('INSERT INTO calendar_items VALUES(?,?,?,?)').run(subscription.id,legacyKey,'ical_legacy',JSON.stringify(source));
    f.fetcher.mockResolvedValue({status:200,text:calendar(master,moved)});
    for(let refresh=0;refresh<2;refresh++){
      f.advance(); await f.service.refresh(f.owner,subscription.id);
      expect(readEntity(f.db,f.owner,'ical_legacy')!.data).toMatchObject({title:'Moved',dueTime:'11:00',completed:true,imported:{recurrenceId:'2026-11-02T09:00:00',sourceRemoved:false}});
      expect(readEntity(f.db,f.owner,duplicate.id)!.data).toMatchObject({title:'Class',imported:{sourceRemoved:true}});
      expect(itemRow(key)!.entity_id).toBe('ical_legacy');
      expect(f.entities()).toHaveLength(4);
      expect(listImportConflicts(f.db,f.owner)).toEqual([]);
    }
  });
  it('reconnects a feed saved under an old secret when the same link is added again, without duplicating tasks',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    const completed=f.edit(f.entities()[0],{completed:true});
    const rotated=new CalendarService(f.db,{secret:'a-different-secret-that-is-also-32-characters',fetcher:f.fetcher,now:()=>new Date('2026-09-11T12:05:00Z')});
    await rotated.refresh(f.owner,subscription.id);
    expect(listSubscriptions(f.db,f.owner)[0].lastError).toMatch(/encryption key changed/);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    // The keyed url_hash was made with the old secret, so the link is matched by fetching it once and finding the
    // old feed that holds its items; then the reconnected feed refreshes.
    const again=await rotated.subscribe(f.owner,{name:'Homework',url:'https://school.example/calendar.ics?private=secret-token',timeZone:'America/New_York'});
    expect(again).toMatchObject({id:subscription.id,lastError:null});
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(f.fetcher.mock.calls[1][0]).toBe('https://school.example/calendar.ics?private=secret-token');
    expect(f.fetcher.mock.calls[2][0]).toBe('https://school.example/calendar.ics?private=secret-token');
    expect(f.entities()).toEqual([completed]);
    expect(listSubscriptions(f.db,f.owner)).toHaveLength(1);
    // The reconnected row now carries the hash for the current secret, so adding the link again needs no fetch.
    expect((await rotated.subscribe(f.owner,{name:'Homework',url:'https://school.example/calendar.ics?private=secret-token',timeZone:'America/New_York'})).id).toBe(subscription.id);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it('adds a different link as a new feed after a secret change, counting its probe fetch as one addition',async()=>{
    const f=fixture(), subscription=await f.subscribe();
    const rotated=new CalendarService(f.db,{secret:'a-different-secret-that-is-also-32-characters',fetcher:f.fetcher,now:()=>new Date('2026-09-11T12:05:00Z')});
    f.fetcher.mockResolvedValue({status:200,text:calendar(event().replace('UID:assignment-1','UID:other-1'))});
    const added=await rotated.subscribe(f.owner,{name:'Clubs',url:'https://school.example/clubs.ics',timeZone:'America/New_York'});
    expect(added.id).not.toBe(subscription.id);
    expect(listSubscriptions(f.db,f.owner)).toHaveLength(2);
    expect(f.db.prepare("SELECT count(*) n FROM audit_log WHERE actor_id=? AND action='calendar.add'").get(f.owner)).toEqual({n:2});
  });
  it('adds a different link that shares only one UID with an old-secret feed as a new feed, leaving the old feed to its own link',async()=>{
    const f=fixture(), url='https://school.example/calendar.ics?private=secret-token';
    const uid=(id:string)=>event(`Item ${id}`).replace('UID:assignment-1',`UID:${id}`);
    const homework=calendar(event(),uid('assignment-2'),uid('assignment-3'));
    f.fetcher.mockResolvedValue({status:200,text:homework});
    const subscription=await f.subscribe();
    expect(f.entities()).toHaveLength(3);
    const rotated=new CalendarService(f.db,{secret:'a-different-secret-that-is-also-32-characters',fetcher:f.fetcher,now:()=>new Date('2026-09-11T12:05:00Z')});
    // Another calendar that the same event was invited onto: one shared UID among otherwise different items.
    f.fetcher.mockResolvedValue({status:200,text:calendar(event(),uid('club-1'),uid('club-2'),uid('club-3'))});
    const clubs=await rotated.subscribe(f.owner,{name:'Clubs',url:'https://school.example/clubs.ics',timeZone:'America/New_York'});
    expect(clubs.id).not.toBe(subscription.id);
    expect(listSubscriptions(f.db,f.owner).find(s=>s.id===subscription.id)).toMatchObject({name:'Homework',lastError:null});
    expect(f.entities().filter(e=>(e.data.imported as {subscriptionId:string}).subscriptionId===subscription.id).every(e=>!(e.data.imported as {sourceRemoved:boolean}).sourceRemoved)).toBe(true);
    // The real link still finds its old feed, with no duplicate tasks.
    f.fetcher.mockResolvedValue({status:200,text:homework});
    expect((await rotated.subscribe(f.owner,{name:'Homework',url,timeZone:'America/New_York'})).id).toBe(subscription.id);
    expect(listSubscriptions(f.db,f.owner)).toHaveLength(2);
    expect(f.entities()).toHaveLength(7);
  });
  it('keys the stored URL hash with the secret and the owner, and rekeys hashes saved before that',async()=>{
    const f=fixture(), url='https://school.example/calendar.ics?private=secret-token';
    const subscription=await f.subscribe();
    await f.service.subscribe(f.other,{name:'Homework',url,timeZone:'America/New_York'});
    const hashes=()=>(f.db.prepare('SELECT owner_id,url_hash FROM calendar_subscriptions').all() as {owner_id:string;url_hash:string}[]);
    const unkeyed=createHash('sha256').update(url).digest('hex');
    const [mine,theirs]=[f.owner,f.other].map(owner=>hashes().find(row=>row.owner_id===owner)!.url_hash);
    expect(mine).toMatch(/^k1:[0-9a-f]{64}$/);
    expect(mine).not.toContain(unkeyed);
    expect(theirs).not.toBe(mine);
    // A row saved before keyed hashes. The worker never rekeys it: it runs from source and can restart ahead of the
    // web bundle, which finds such rows only by their unkeyed hash.
    f.db.prepare('UPDATE calendar_subscriptions SET url_hash=? WHERE owner_id=?').run(unkeyed,f.owner);
    await f.service.refreshDue();
    expect(hashes().find(row=>row.owner_id===f.owner)!.url_hash).toBe(unkeyed);
    // The web server rekeys the account's own rows when it loads the workspace, and leaves other accounts' rows alone.
    f.db.prepare('UPDATE calendar_subscriptions SET url_hash=? WHERE owner_id=?').run(unkeyed,f.other);
    f.service.rekeyOnLoad(f.owner);
    expect(hashes().find(row=>row.owner_id===f.owner)!.url_hash).toBe(mine);
    expect(hashes().find(row=>row.owner_id===f.other)!.url_hash).toBe(unkeyed);
    f.service.rekeyOnLoad(f.other);
    expect(hashes().find(row=>row.owner_id===f.other)!.url_hash).toBe(theirs);
    const previousSecret=process.env.NEXTAUTH_SECRET;
    process.env.NEXTAUTH_SECRET='test-only-secret-that-is-at-least-32-characters';
    try {
      f.db.prepare('UPDATE calendar_subscriptions SET url_hash=? WHERE owner_id=?').run(unkeyed,f.owner);
      expect(new Service(f.db).workspace(f.owner).subscriptions).toHaveLength(1);
      expect(hashes().find(row=>row.owner_id===f.owner)!.url_hash).toBe(mine);
    } finally { if(previousSecret===undefined)delete process.env.NEXTAUTH_SECRET;else process.env.NEXTAUTH_SECRET=previousSecret; }
    // Until then, adding the same link still finds it, and rekeys it.
    f.db.prepare('UPDATE calendar_subscriptions SET url_hash=? WHERE owner_id=?').run(unkeyed,f.owner);
    expect((await f.subscribe()).id).toBe(subscription.id);
    expect(hashes().find(row=>row.owner_id===f.owner)!.url_hash).toBe(mine);
  });
  it('reconnects a feed with an unkeyed hash saved under an old secret by its hash alone',async()=>{
    const f=fixture(), subscription=await f.subscribe(), url='https://school.example/calendar.ics?private=secret-token';
    f.db.prepare('UPDATE calendar_subscriptions SET url_hash=? WHERE id=?').run(createHash('sha256').update(url).digest('hex'),subscription.id);
    const rotated=new CalendarService(f.db,{secret:'a-different-secret-that-is-also-32-characters',fetcher:f.fetcher,now:()=>new Date('2026-09-11T12:05:00Z')});
    await rotated.refreshDue(); await rotated.refresh(f.owner,subscription.id);
    expect(listSubscriptions(f.db,f.owner)[0].lastError).toMatch(/encryption key changed/);
    expect((await rotated.subscribe(f.owner,{name:'Homework',url,timeZone:'America/New_York'})).id).toBe(subscription.id);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect((f.db.prepare('SELECT url_hash FROM calendar_subscriptions WHERE id=?').get(subscription.id) as {url_hash:string}).url_hash).toMatch(/^k1:/);
  });
});
