import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Db } from './db';
import { readEntity, writeEntity } from './entities';
import { parseICalendar, type FeedItem } from '@/domain/ical';
import { taskSchema, type Task } from '@/domain/task';
import { fetchFeed, normalizeFeedUrl } from './feed-fetch';

export const subscribeSchema=z.object({name:z.string().trim().min(1).max(100),url:z.string().max(4000),timeZone:z.string().max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'Choose a valid time zone')});
export interface FeedSubscription {id:string;name:string;timeZone:string;enabled:boolean;lastAttemptAt:string|null;lastSuccessAt:string|null;nextRefreshAt:string;lastError:string|null;itemCount:number}
interface FeedRow {id:string;owner_id:string;name:string;url_encrypted:string;url_hash:string;time_zone:string;enabled:number;etag:string|null;last_modified:string|null;cached_feed:string|null;last_attempt_at:string|null;last_success_at:string|null;next_refresh_at:string;last_error:string|null;failure_count:number;lease_token:string|null;lease_until:string|null}
type SourceFields=Pick<Task,'title'|'notes'|'dueDate'|'dueTime'>;
export interface ImportConflict {entityId:string;subscriptionId:string;fields:string[];incoming:SourceFields;version:number}
export function listSubscriptions(db:Db,owner:string):FeedSubscription[] {
  return (db.prepare(`SELECT s.*, (SELECT count(*) FROM calendar_items i JOIN entities e ON e.owner_id=s.owner_id AND e.id=i.entity_id WHERE i.subscription_id=s.id AND e.deleted=0) item_count FROM calendar_subscriptions s WHERE owner_id=? ORDER BY name`).all(owner) as (FeedRow&{item_count:number})[]).map(r=>({id:r.id,name:r.name,timeZone:r.time_zone,enabled:!!r.enabled,lastAttemptAt:r.last_attempt_at,lastSuccessAt:r.last_success_at,nextRefreshAt:r.next_refresh_at,lastError:r.last_error,itemCount:r.item_count}));
}
export function listImportConflicts(db:Db,owner:string):ImportConflict[] {
  return (db.prepare(`SELECT c.*,e.version FROM calendar_conflicts c JOIN entities e ON e.owner_id=c.owner_id AND e.id=c.entity_id WHERE c.owner_id=? AND e.deleted=0`).all(owner) as {entity_id:string;subscription_id:string;fields:string;incoming:string;version:number}[]).map(r=>({entityId:r.entity_id,subscriptionId:r.subscription_id,fields:JSON.parse(r.fields),incoming:JSON.parse(r.incoming),version:r.version}));
}
const FIELDS=['title','notes','dueDate','dueTime'] as const;
const keyOf=(item:FeedItem)=>JSON.stringify([item.uid,item.recurrenceId]);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const fail=(code:'NOT_FOUND'|'BAD_REQUEST'|'CONFLICT'|'TOO_MANY_REQUESTS',message:string):never=>{throw new TRPCError({code,message});};
const fieldsOf=(item:FeedItem):SourceFields=>({title:item.title,notes:item.notes,dueDate:item.dueDate,dueTime:item.dueTime});
function encryptionKey(secret:string) {if(secret.length<32)throw new Error('Calendar encryption is not configured.');return createHash('sha256').update('quasar-calendar-url\0'+secret).digest();}
function encrypt(value:string,secret:string) {const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',encryptionKey(secret),iv);const body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');}
function decrypt(value:string,secret:string) {const data=Buffer.from(value,'base64');const cipher=createDecipheriv('aes-256-gcm',encryptionKey(secret),data.subarray(0,12));cipher.setAuthTag(data.subarray(12,28));return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8');}

export class CalendarService {
  constructor(readonly db:Db,readonly options:{secret?:string;fetcher?:typeof fetchFeed;now?:()=>Date}={}){}
  private now(){return this.options.now?.()??new Date();}
  private secret(){return this.options.secret??process.env.NEXTAUTH_SECRET??'';}
  private find(owner:string,id:string):FeedRow {const row=this.db.prepare('SELECT * FROM calendar_subscriptions WHERE owner_id=? AND id=?').get(owner,id) as FeedRow|undefined;return row??fail('NOT_FOUND','Calendar feed not found.');}
  async subscribe(owner:string,raw:z.infer<typeof subscribeSchema>):Promise<FeedSubscription> {
    const input=subscribeSchema.parse(raw);
    let url:string;try{url=normalizeFeedUrl(input.url);}catch{return fail('BAD_REQUEST','Use an HTTPS iCalendar feed on a public host.');}
    const id=this.db.transaction(()=>{
      const existing=this.db.prepare('SELECT id FROM calendar_subscriptions WHERE owner_id=? AND url_hash=?').get(owner,hash(url)) as {id:string}|undefined;
      if(existing)return existing.id;
      const count=this.db.prepare('SELECT count(*) n FROM calendar_subscriptions WHERE owner_id=?').get(owner) as {n:number};
      if(count.n>=10)fail('TOO_MANY_REQUESTS','You can subscribe to up to 10 calendar feeds.');
      const id=randomUUID();
      this.db.prepare('INSERT INTO calendar_subscriptions(id,owner_id,name,url_encrypted,url_hash,time_zone,next_refresh_at) VALUES(?,?,?,?,?,?,?)').run(id,owner,input.name,encrypt(url,this.secret()),hash(url),input.timeZone,this.now().toISOString());
      return id;
    })();
    await this.refresh(owner,id);
    return listSubscriptions(this.db,owner).find(s=>s.id===id)!;
  }
  setEnabled(owner:string,id:string,enabled:boolean) {
    this.find(owner,id);
    this.db.prepare('UPDATE calendar_subscriptions SET enabled=?,next_refresh_at=?,lease_token=NULL,lease_until=NULL WHERE owner_id=? AND id=?').run(Number(enabled),this.now().toISOString(),owner,id);
  }
  remove(owner:string,id:string) {
    this.find(owner,id);
    this.db.transaction(()=>{
      const items=this.db.prepare('SELECT entity_id FROM calendar_items WHERE subscription_id=?').all(id) as {entity_id:string}[];
      for(const item of items){const entity=readEntity(this.db,owner,item.entity_id);if(entity&&!entity.deleted&&entity.data.imported){const data={...entity.data};delete data.imported;writeEntity(this.db,owner,{...entity,version:entity.version+1,data});}}
      this.db.prepare('DELETE FROM calendar_subscriptions WHERE owner_id=? AND id=?').run(owner,id);
    })();
  }
  resolve(owner:string,id:string,expectedVersion:number,choice:'local'|'source') {
    this.db.transaction(()=>{
      const row=this.db.prepare('SELECT * FROM calendar_conflicts WHERE owner_id=? AND entity_id=?').get(owner,id) as {fields:string;incoming:string}|undefined;
      const entity=readEntity(this.db,owner,id);
      if(!row||!entity||entity.deleted)fail('NOT_FOUND','This source conflict is no longer available.');
      if(entity!.version!==expectedVersion)fail('CONFLICT','The task changed. Refresh and review it before choosing.');
      if(choice==='source'){
        const data={...entity!.data};const incoming=JSON.parse(row!.incoming) as SourceFields;
        for(const field of JSON.parse(row!.fields) as (keyof SourceFields)[]) data[field]=incoming[field];
        const parsed=taskSchema.safeParse(data);if(!parsed.success)fail('BAD_REQUEST','Review the task due date and reminder before using the source change.');
        writeEntity(this.db,owner,{...entity!,version:entity!.version+1,data:parsed.data!});
      }
      this.db.prepare('DELETE FROM calendar_conflicts WHERE owner_id=? AND entity_id=?').run(owner,id);
    })();
  }
  async refresh(owner:string,id:string,scheduled=false):Promise<void> {
    const now=this.now(), token=randomUUID();
    const row=this.db.transaction(()=>{
      const row=this.find(owner,id);
      if(!row.enabled)return null;
      if(row.lease_until&&row.lease_until>now.toISOString())return null;
      if(scheduled&&row.next_refresh_at>now.toISOString())return null;
      // Prevent a button loop from hammering a remote school server.
      if(!scheduled&&row.last_attempt_at&&now.getTime()-Date.parse(row.last_attempt_at)<60_000)return null;
      this.db.prepare('UPDATE calendar_subscriptions SET lease_token=?,lease_until=?,last_attempt_at=? WHERE id=?').run(token,new Date(now.getTime()+120_000).toISOString(),now.toISOString(),id);
      return row;
    })();
    if(!row)return;
    try{
      const response=await(this.options.fetcher??fetchFeed)(decrypt(row.url_encrypted,this.secret()),{etag:row.etag??undefined,lastModified:row.last_modified??undefined});
      const today=Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(row.time_zone).toPlainDate();
      const windowStart=today.subtract({days:90}).toString(),windowEnd=today.add({days:365}).toString();
      const feedText=response.status===200?response.text:row.cached_feed;
      if(!feedText)throw new Error('Feed returned no cached content.');
      const items=parseICalendar(feedText,{timeZone:row.time_zone,windowStart,windowEnd});
      this.db.transaction(()=>{
        const active=this.db.prepare('SELECT lease_token,enabled FROM calendar_subscriptions WHERE id=? AND owner_id=?').get(id,owner) as {lease_token:string;enabled:number}|undefined;
        if(!active||!active.enabled||active.lease_token!==token)return;
        if(items)this.applyItems(owner,id,items,now.toISOString(),windowStart,windowEnd);
        this.db.prepare('UPDATE calendar_subscriptions SET etag=?,last_modified=?,cached_feed=?,last_success_at=?,next_refresh_at=?,last_error=NULL,failure_count=0,lease_token=NULL,lease_until=NULL WHERE id=?')
          .run(response.status===200?response.etag??null:row.etag,response.status===200?response.lastModified??null:row.last_modified,feedText,now.toISOString(),new Date(now.getTime()+30*60_000).toISOString(),id);
      })();
    }catch{
      // Feed URLs can contain private tokens; never surface a raw network exception.
      this.db.prepare('UPDATE calendar_subscriptions SET last_error=?,failure_count=failure_count+1,next_refresh_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?')
        .run('Could not refresh this feed. Check that its URL is a public HTTPS iCalendar feed. Your saved items are unchanged.',new Date(now.getTime()+Math.min(6*3600_000,5*60_000*2**Math.min(row.failure_count,7))).toISOString(),id,token);
    }
  }
  private applyItems(owner:string,subscriptionId:string,items:FeedItem[],stamp:string,windowStart:string,windowEnd:string) {
    const seen=new Set<string>();
    for(const source of items){
      const key=keyOf(source);seen.add(key);
      const existing=this.db.prepare('SELECT entity_id,source_data FROM calendar_items WHERE subscription_id=? AND item_key=?').get(subscriptionId,key) as {entity_id:string;source_data:string}|undefined;
      const entityId=existing?.entity_id??'ical_'+hash(subscriptionId+'\0'+key);
      const entity=readEntity(this.db,owner,entityId);
      const incoming=fieldsOf(source);
      const metadata={subscriptionId,uid:source.uid,recurrenceId:source.recurrenceId,startDate:source.startDate,startTime:source.startTime,endDate:source.endDate,endTime:source.endTime,timeZone:source.timeZone,allDay:source.allDay,sourceRemoved:source.cancelled,sourceUpdatedAt:stamp};
      if(!entity&&!source.cancelled){writeEntity(this.db,owner,{id:entityId,kind:'task',version:1,deleted:false,data:taskSchema.parse({...incoming,classId:null,completed:false,imported:metadata})});}
      else if(entity&&!entity.deleted){
        const previous=existing?fieldsOf(JSON.parse(existing.source_data) as FeedItem):incoming;
        const data={...entity.data};
        const pending=this.db.prepare('SELECT fields FROM calendar_conflicts WHERE owner_id=? AND entity_id=?').get(owner,entityId) as {fields:string}|undefined;
        const conflicts=new Set<keyof SourceFields>(pending?JSON.parse(pending.fields):[]);
        for(const field of FIELDS){
          if(data[field]===incoming[field])conflicts.delete(field);
          else if(incoming[field]!==previous[field]){
            if(data[field]===previous[field])data[field]=incoming[field];else conflicts.add(field);
          }
        }
        const oldMetadata=entity.data.imported as Task['imported'];
        data.imported={...metadata,sourceUpdatedAt:oldMetadata?.sourceUpdatedAt??stamp};
        if(JSON.stringify(data)!==JSON.stringify(entity.data))data.imported=metadata;
        if(conflicts.size)this.db.prepare('INSERT INTO calendar_conflicts VALUES(?,?,?,?,?) ON CONFLICT(owner_id,entity_id) DO UPDATE SET fields=excluded.fields,incoming=excluded.incoming').run(owner,entityId,subscriptionId,JSON.stringify([...conflicts]),JSON.stringify(incoming));
        else this.db.prepare('DELETE FROM calendar_conflicts WHERE owner_id=? AND entity_id=?').run(owner,entityId);
        if(JSON.stringify(data)!==JSON.stringify(entity.data))writeEntity(this.db,owner,{...entity,version:entity.version+1,data:taskSchema.parse(data)});
      }
      this.db.prepare('INSERT INTO calendar_items VALUES(?,?,?,?) ON CONFLICT(subscription_id,item_key) DO UPDATE SET source_data=excluded.source_data').run(subscriptionId,key,entityId,JSON.stringify(source));
    }
    const previous=this.db.prepare('SELECT * FROM calendar_items WHERE subscription_id=?').all(subscriptionId) as {item_key:string;entity_id:string;source_data:string}[];
    for(const item of previous){
      if(seen.has(item.item_key))continue;
      const source=JSON.parse(item.source_data) as FeedItem;
      if(source.startDate<windowStart||source.startDate>windowEnd)continue;
      const entity=readEntity(this.db,owner,item.entity_id);
      const imported=entity?.data.imported as Task['imported'];
      if(entity&&!entity.deleted&&imported&&!imported.sourceRemoved)writeEntity(this.db,owner,{...entity,version:entity.version+1,data:{...entity.data,imported:{...imported,sourceRemoved:true,sourceUpdatedAt:stamp}}});
    }
  }
  async refreshDue(limit=20):Promise<number> {
    const rows=this.db.prepare('SELECT id,owner_id FROM calendar_subscriptions WHERE enabled=1 AND next_refresh_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_refresh_at LIMIT ?').all(this.now().toISOString(),this.now().toISOString(),limit) as {id:string;owner_id:string}[];
    for(const row of rows)await this.refresh(row.owner_id,row.id,true);
    return rows.length;
  }
}
