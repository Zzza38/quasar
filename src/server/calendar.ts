import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { isBusy, type Db } from './db';
import { readEntity, writeEntity } from './entities';
import { feedTitle, parseICalendar, type FeedItem } from '@/domain/ical';
import { taskSchema, type Task } from '@/domain/task';
import { fetchFeed, normalizeFeedUrl } from './feed-fetch';

export const subscribeSchema=z.object({name:z.string().trim().min(1).max(100),url:z.string().max(4000),timeZone:z.string().max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'Choose a valid time zone')});
export interface FeedSubscription {id:string;name:string;timeZone:string;enabled:boolean;lastAttemptAt:string|null;lastSuccessAt:string|null;nextRefreshAt:string;lastError:string|null;itemCount:number}
interface FeedRow {id:string;owner_id:string;name:string;url_encrypted:string;url_hash:string;time_zone:string;enabled:number;etag:string|null;last_modified:string|null;cached_feed:string|null;last_attempt_at:string|null;last_success_at:string|null;next_refresh_at:string;last_error:string|null;failure_count:number;lease_token:string|null;lease_until:string|null}
type SourceFields=Pick<Task,'title'|'notes'|'dueDate'|'dueTime'>;
/**
 * A pending choice between local edits and source changes. `version` is the task's version and `revision` fingerprints
 * the conflict itself: a refresh can change the source values or add fields without touching the task, so resolve
 * checks both and never applies source values the student was not shown.
 */
export interface ImportConflict {entityId:string;subscriptionId:string;fields:string[];incoming:SourceFields;version:number;revision:string}
export function listSubscriptions(db:Db,owner:string):FeedSubscription[] {
  return (db.prepare(`SELECT s.*, (SELECT count(*) FROM calendar_items i JOIN entities e ON e.owner_id=s.owner_id AND e.id=i.entity_id WHERE i.subscription_id=s.id AND e.deleted=0) item_count FROM calendar_subscriptions s WHERE owner_id=? ORDER BY name`).all(owner) as (FeedRow&{item_count:number})[]).map(r=>({id:r.id,name:r.name,timeZone:r.time_zone,enabled:!!r.enabled,lastAttemptAt:r.last_attempt_at,lastSuccessAt:r.last_success_at,nextRefreshAt:r.next_refresh_at,lastError:r.last_error,itemCount:r.item_count}));
}
export function listImportConflicts(db:Db,owner:string):ImportConflict[] {
  return (db.prepare(`SELECT c.*,e.version FROM calendar_conflicts c JOIN entities e ON e.owner_id=c.owner_id AND e.id=c.entity_id WHERE c.owner_id=? AND e.deleted=0`).all(owner) as {entity_id:string;subscription_id:string;fields:string;incoming:string;version:number}[]).map(r=>({entityId:r.entity_id,subscriptionId:r.subscription_id,fields:choiceFields(r.fields),incoming:JSON.parse(r.incoming),version:r.version,revision:conflictRevision(r)}));
}
const conflictRevision=(row:{fields:string;incoming:string})=>createHash('sha256').update(row.fields+'\0'+row.incoming).digest('hex').slice(0,32);
/**
 * The fields a choice covers. Due date and time are one value, so either one brings the other: a row stored before
 * refresh paired them (a new source time on a task whose date was cleared) still shows and applies both.
 */
function choiceFields(stored:string):(keyof SourceFields)[] {
  const fields=JSON.parse(stored) as (keyof SourceFields)[];
  return fields.includes('dueDate')||fields.includes('dueTime')?[...new Set<keyof SourceFields>([...fields,'dueDate','dueTime'])]:fields;
}
const FIELDS=['title','notes','dueDate','dueTime'] as const;
/** What refresh did: fetched the feed (successfully or not), or why it skipped the fetch. */
export type RefreshOutcome='attempted'|'missing'|'paused'|'in-progress'|'not-due'|'throttled';
const keyOf=(item:FeedItem)=>JSON.stringify([item.uid,item.recurrenceId]);
/**
 * Same window rule as parseICalendar: the item's start-to-due span must overlap the window (a VTODO can start long
 * before it is due). Events are due on their start date, so for them this is the start date alone.
 */
const inWindow=(source:FeedItem,windowStart:string,windowEnd:string)=>{
  const due=source.dueDate??source.startDate;
  const [first,last]=source.startDate<due?[source.startDate,due]:[due,source.startDate];
  return last>=windowStart&&first<=windowEnd;
};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const fail=(code:'NOT_FOUND'|'BAD_REQUEST'|'CONFLICT'|'TOO_MANY_REQUESTS',message:string):never=>{throw new TRPCError({code,message});};
// feedTitle also normalizes source_data stored before titles were trimmed at parse time.
const fieldsOf=(item:FeedItem):SourceFields=>({title:feedTitle(item.title),notes:item.notes,dueDate:item.dueDate,dueTime:item.dueTime});
/** Thrown when a stored feed URL cannot be decrypted, which means NEXTAUTH_SECRET changed since it was saved. */
class FeedKeyError extends Error {}
// A missing or short secret is a server configuration problem, not a changed key: it must not become FeedKeyError.
const readUrl=(value:string,secret:string)=>{encryptionKey(secret);try{return decrypt(value,secret);}catch{throw new FeedKeyError();}};
const canDecrypt=(value:string,secret:string)=>{try{decrypt(value,secret);return true;}catch{return false;}};
/**
 * Fixed, URL-free failure reasons thrown by feed-fetch.ts and ical.ts that are safe and useful to show. Anything
 * else (raw network exceptions can quote the private URL, library errors can quote feed text) gets the generic message.
 * DNS outcomes stay generic too: "must resolve only to public internet addresses" appears only when the server's own
 * resolver (tailnet MagicDNS, split-horizon DNS) knows the name, so showing it would reveal which internal hosts exist.
 */
const SAFE_FEED_ERRORS=new Set(['Calendar exceeds the 2 MB limit.','The response is not a complete iCalendar feed.','Invalid calendar.','Invalid calendar date.',
  'Calendar contains too many entries.','Calendar entries require a valid UID.','Calendar recurrence expansion exceeds the safety limit.','Calendar expands to more than 2000 occurrences.',
  'Calendar contains duplicate UIDs.','Calendar RANGE recurrence overrides are not supported.','Calendar contains duplicate recurrence overrides.','Calendar item has no start or due date.',
  'Only daily, weekly, monthly and yearly calendar recurrences are supported.','Calendar recurrence is too complex.','Calendar period RDATE values are not supported.',
  'Calendar request timed out.','Calendar redirected too many times or without a destination.',
  'Calendar server must return uncompressed content.','Calendar redirect failed.']);
/** Per-account limits on adding new feeds (each triggers an immediate outbound fetch); removals never refund them. */
export const FEED_ADD_HOURLY_LIMIT=20;
export const FEED_ADD_DAILY_LIMIT=40;
export const GENERIC_REFRESH_ERROR='Could not refresh this feed. Check that its URL is a public HTTPS iCalendar feed. Your saved items are unchanged.';
export function refreshError(error:unknown):string {
  if(error instanceof FeedKeyError)return 'Could not refresh this feed because the server’s encryption key changed. Add the same calendar link again to reconnect it. Your saved items are unchanged.';
  const message=error instanceof Error?error.message:'';
  const safe=SAFE_FEED_ERRORS.has(message)||/^Calendar server returned HTTP \d{3}\.$/.test(message)||/^Invalid calendar [a-z-]{1,40}\.$/.test(message);
  return safe?`Could not refresh this feed. ${message} Your saved items are unchanged.`:GENERIC_REFRESH_ERROR;
}
function encryptionKey(secret:string) {if(secret.length<32)throw new TRPCError({code:'PRECONDITION_FAILED',message:'Calendar encryption is not configured.'});return createHash('sha256').update('quasar-calendar-url\0'+secret).digest();}
/**
 * The url_hash that finds an account's existing subscription to a link. It is keyed with a NEXTAUTH_SECRET-derived key
 * and includes the owner, so a database reader cannot test a leaked or well-known feed URL against the rows or tell
 * which accounts share a feed. Rows saved before it held an unkeyed sha256(url) without the prefix; the web server
 * rekeys an account's rows it can decrypt when that account loads its workspace (rekeyOnLoad), and subscribe still
 * matches the rest (feeds saved under an older secret). The `k1:` prefix tells the two kinds apart.
 */
function urlHash(owner:string,url:string,secret:string) {encryptionKey(secret);return 'k1:'+createHmac('sha256',createHash('sha256').update('quasar-calendar-url-hash\0'+secret).digest()).update(owner+'\0'+url).digest('hex');}
function encrypt(value:string,secret:string) {const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',encryptionKey(secret),iv);const body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');}
function decrypt(value:string,secret:string) {const data=Buffer.from(value,'base64');const cipher=createDecipheriv('aes-256-gcm',encryptionKey(secret),data.subarray(0,12));cipher.setAuthTag(data.subarray(12,28));return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8');}

export class CalendarService {
  constructor(readonly db:Db,readonly options:{secret?:string;fetcher?:typeof fetchFeed;now?:()=>Date}={}){}
  private now(){return this.options.now?.()??new Date();}
  private secret(){return this.options.secret??process.env.NEXTAUTH_SECRET??'';}
  private row(owner:string,id:string):FeedRow|undefined {return this.db.prepare('SELECT * FROM calendar_subscriptions WHERE owner_id=? AND id=?').get(owner,id) as FeedRow|undefined;}
  private find(owner:string,id:string):FeedRow {return this.row(owner,id)??fail('NOT_FOUND','Calendar feed not found.');}
  async subscribe(owner:string,raw:z.infer<typeof subscribeSchema>):Promise<FeedSubscription> {
    const input=subscribeSchema.parse(raw);
    let url:string;try{url=normalizeFeedUrl(input.url);}catch{return fail('BAD_REQUEST','Use an HTTPS iCalendar feed on a public host.');}
    const secret=this.secret(), keyed=urlHash(owner,url,secret);
    const byHash=()=>this.db.prepare('SELECT id,url_encrypted FROM calendar_subscriptions WHERE owner_id=? AND url_hash IN (?,?) ORDER BY url_hash=? DESC').get(owner,keyed,hash(url),keyed) as {id:string;url_encrypted:string}|undefined;
    const probe=byHash()?undefined:await this.probeOrphans(owner,url,input.timeZone);
    const id=this.db.transaction(()=>{
      const existing=byHash()??(probe?.id?this.orphans(owner).find(row=>row.id===probe.id):undefined);
      if(existing){
        // Same URL: same hash, or the old-secret feed that already holds this link's items. If NEXTAUTH_SECRET changed,
        // the stored copy is unreadable: re-encrypt it with the current key and refresh right away, so re-adding the
        // link reconnects the feed with its existing tasks. Either way, store the current keyed hash.
        if(!canDecrypt(existing.url_encrypted,secret))this.db.prepare('UPDATE calendar_subscriptions SET url_encrypted=?,url_hash=?,last_error=NULL,failure_count=0,last_attempt_at=NULL,next_refresh_at=? WHERE id=?').run(encrypt(url,secret),keyed,this.now().toISOString(),existing.id);
        else this.db.prepare('UPDATE calendar_subscriptions SET url_hash=? WHERE id=?').run(keyed,existing.id);
        return existing.id;
      }
      const count=this.db.prepare('SELECT count(*) n FROM calendar_subscriptions WHERE owner_id=?').get(owner) as {n:number};
      if(count.n>=10)fail('TOO_MANY_REQUESTS','You can subscribe to up to 10 calendar feeds.');
      const id=randomUUID();
      // A probe already counted (and fetched) this link as an addition.
      if(!probe)this.countAddition(owner,{subscriptionId:id});
      this.db.prepare('INSERT INTO calendar_subscriptions(id,owner_id,name,url_encrypted,url_hash,time_zone,next_refresh_at) VALUES(?,?,?,?,?,?,?)').run(id,owner,input.name,encrypt(url,secret),keyed,input.timeZone,this.now().toISOString());
      return id;
    }).immediate();
    await this.refresh(owner,id);
    return listSubscriptions(this.db,owner).find(s=>s.id===id)!;
  }
  /**
   * Every new feed is fetched at once, so cap additions over time too. The count lives in audit_log rather than on the
   * subscription rows, so removing feeds and adding new ones can't turn the server into an unlimited fetcher.
   */
  private countAddition(owner:string,detail:Record<string,unknown>) {
    const added=(since:number)=>(this.db.prepare("SELECT count(*) n FROM audit_log WHERE actor_id=? AND action='calendar.add' AND created_at > ?").get(owner,new Date(this.now().getTime()-since).toISOString()) as {n:number}).n;
    if(added(3_600_000)>=FEED_ADD_HOURLY_LIMIT)fail('TOO_MANY_REQUESTS',`You can add up to ${FEED_ADD_HOURLY_LIMIT} calendar feeds per hour. Try again later.`);
    if(added(86_400_000)>=FEED_ADD_DAILY_LIMIT)fail('TOO_MANY_REQUESTS',`You can add up to ${FEED_ADD_DAILY_LIMIT} calendar feeds per day. Try again tomorrow.`);
    this.db.prepare("INSERT INTO audit_log(actor_id,action,school_id,detail,created_at) VALUES(?,'calendar.add',NULL,?,?)").run(owner,JSON.stringify(detail),this.now().toISOString());
  }
  /** The owner's feeds saved under an older NEXTAUTH_SECRET with a keyed hash, which the same link can no longer match. */
  private orphans(owner:string) {
    return (this.db.prepare("SELECT id,url_encrypted FROM calendar_subscriptions WHERE owner_id=? AND url_hash LIKE 'k1:%'").all(owner) as {id:string;url_encrypted:string}[]).filter(row=>!canDecrypt(row.url_encrypted,this.secret()));
  }
  /**
   * When the owner has old-secret feeds, fetches the link once (counted as an addition, so it cannot become a free
   * fetcher) and returns the one old feed this link most likely is, if any. Undefined means no probe ran. Different
   * feeds often share UIDs (an event invited onto two calendars, an "all events" feed over a "sports" one), so a match
   * needs a strong overlap both ways: most of the old feed's in-window items must be in the fetched feed, and most of
   * the fetched UIDs among the old feed's. If more than one old feed qualifies, none is picked and the link becomes a
   * new feed, because rebinding the wrong one would mark its items removed.
   */
  private async probeOrphans(owner:string,url:string,timeZone:string):Promise<{id?:string}|undefined> {
    const orphans=this.orphans(owner);
    if(!orphans.length)return undefined;
    this.db.transaction(()=>this.countAddition(owner,{probe:true})).immediate();
    const today=Temporal.Instant.from(this.now().toISOString()).toZonedDateTimeISO(timeZone).toPlainDate();
    const windowStart=today.subtract({days:90}).toString(),windowEnd=today.add({days:365}).toString();
    let items:FeedItem[];
    try{
      const response=await(this.options.fetcher??fetchFeed)(url,{});
      if(response.status!==200)return {};
      items=parseICalendar(response.text,{timeZone,windowStart,windowEnd});
    }catch{return {};}
    const keys=new Set(items.map(keyOf)), uids=new Set(items.map(item=>item.uid));
    const matches=orphans.filter(orphan=>{
      const stored=this.db.prepare("SELECT i.item_key,i.source_data,json_extract(e.data,'$.imported.sourceRemoved') removed FROM calendar_items i LEFT JOIN entities e ON e.owner_id=? AND e.id=i.entity_id WHERE i.subscription_id=?").all(owner,orphan.id) as {item_key:string;source_data:string;removed:number|null}[];
      // Items the old feed already saw leave the source are not expected in it; items outside the window never are.
      const expected=stored.filter(row=>keys.has(row.item_key)||(!row.removed&&inWindow(JSON.parse(row.source_data) as FeedItem,windowStart,windowEnd)));
      const found=expected.filter(row=>keys.has(row.item_key)).length;
      const orphanUids=new Set(stored.map(row=>(JSON.parse(row.item_key) as [string,unknown])[0]));
      const shared=[...uids].filter(uid=>orphanUids.has(uid)).length;
      return found>0&&found*2>expected.length&&shared*2>uids.size;
    });
    return {id:matches.length===1?matches[0].id:undefined};
  }
  /** Replaces the unkeyed url_hash of an account's rows saved before keyed hashes, wherever the current secret can read the URL. */
  rekeyUrlHashes(owner:string) {
    const rows=this.db.prepare("SELECT id,owner_id,url_encrypted FROM calendar_subscriptions WHERE owner_id=? AND url_hash NOT LIKE 'k1:%'").all(owner) as {id:string;owner_id:string;url_encrypted:string}[];
    for(const row of rows){
      let url:string;try{url=decrypt(row.url_encrypted,this.secret());}catch{continue;}
      this.db.prepare("UPDATE calendar_subscriptions SET url_hash=? WHERE id=? AND url_hash NOT LIKE 'k1:%'").run(urlHash(row.owner_id,url,this.secret()),row.id);
    }
  }
  /**
   * Runs from the web server when an account loads its workspace, never from the worker. The worker runs from source,
   * so a restart between a source update and the web rebuild would otherwise rekey rows that the still-serving old
   * bundle finds only by their unkeyed hash, and re-adding a linked calendar there would duplicate it and its tasks.
   * A missing secret or a busy database only delays the rekey to the next load.
   */
  rekeyOnLoad(owner:string) {
    if(this.secret().length<32)return;
    if(!this.db.prepare("SELECT 1 FROM calendar_subscriptions WHERE owner_id=? AND url_hash NOT LIKE 'k1:%' LIMIT 1").get(owner))return;
    try{this.db.transaction(()=>this.rekeyUrlHashes(owner)).immediate();}catch(error){if(!isBusy(error))throw error;}
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
    }).immediate();
  }
  /**
   * Applies the student's choice. `revision` is the ImportConflict revision they were shown; clients built before it
   * existed omit it and get the version check alone.
   */
  resolve(owner:string,id:string,expectedVersion:number,choice:'local'|'source',revision?:string) {
    this.db.transaction(()=>{
      const row=this.db.prepare('SELECT * FROM calendar_conflicts WHERE owner_id=? AND entity_id=?').get(owner,id) as {fields:string;incoming:string}|undefined;
      const entity=readEntity(this.db,owner,id);
      if(!row||!entity||entity.deleted)fail('NOT_FOUND','This source conflict is no longer available.');
      if(entity!.version!==expectedVersion)fail('CONFLICT','The task changed. Refresh and review it before choosing.');
      if(revision!==undefined&&revision!==conflictRevision(row!))fail('CONFLICT','The calendar changed this item again. Refresh and review it before choosing.');
      if(choice==='source'){
        const data={...entity!.data};const incoming=JSON.parse(row!.incoming) as SourceFields;
        for(const field of choiceFields(row!.fields)) data[field]=incoming[field];
        const parsed=taskSchema.safeParse(data);if(!parsed.success)fail('BAD_REQUEST','Review the task due date and reminder before using the source change.');
        writeEntity(this.db,owner,{...entity!,version:entity!.version+1,data:parsed.data!});
      }
      this.db.prepare('DELETE FROM calendar_conflicts WHERE owner_id=? AND entity_id=?').run(owner,id);
    }).immediate();
  }
  /** The Refresh button: like refresh, but says why nothing happened instead of returning quietly. */
  async refreshNow(owner:string,id:string):Promise<void> {
    const outcome=await this.refresh(owner,id);
    if(outcome==='in-progress')fail('TOO_MANY_REQUESTS','This feed is refreshing right now. Check back in a minute.');
    if(outcome==='throttled')fail('TOO_MANY_REQUESTS','Quasar checked this feed less than a minute ago. Wait a minute, then refresh again.');
    if(outcome==='paused')fail('BAD_REQUEST','Resume this feed before refreshing it.');
  }
  /**
   * Fetches and applies one feed, or says why it was skipped. A manual refresh of a feed that does not exist throws
   * NOT_FOUND; a scheduled one skips it, because the worker's batch can outlive a feed the student just removed.
   */
  async refresh(owner:string,id:string,scheduled=false):Promise<RefreshOutcome> {
    // Without a usable secret no feed can be read: say so to the caller instead of storing a per-feed error.
    encryptionKey(this.secret());
    const now=this.now(), token=randomUUID();
    const lease=this.db.transaction(():FeedRow|Exclude<RefreshOutcome,'attempted'>=>{
      const row=scheduled?this.row(owner,id):this.find(owner,id);
      if(!row)return 'missing';
      if(!row.enabled)return 'paused';
      if(row.lease_until&&row.lease_until>now.toISOString())return 'in-progress';
      if(scheduled&&row.next_refresh_at>now.toISOString())return 'not-due';
      // Prevent a button loop from hammering a remote school server.
      if(!scheduled&&row.last_attempt_at&&now.getTime()-Date.parse(row.last_attempt_at)<60_000)return 'throttled';
      this.db.prepare('UPDATE calendar_subscriptions SET lease_token=?,lease_until=?,last_attempt_at=? WHERE id=?').run(token,new Date(now.getTime()+120_000).toISOString(),now.toISOString(),id);
      return row;
    }).immediate();
    if(typeof lease==='string')return lease;
    const row=lease;
    try{
      const response=await(this.options.fetcher??fetchFeed)(readUrl(row.url_encrypted,this.secret()),{etag:row.etag??undefined,lastModified:row.last_modified??undefined});
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
      }).immediate();
    }catch(error){
      if(isBusy(error)){
        // The other process held the database too long; the feed is fine. Release the lease and retry soon without a failure.
        try{this.db.prepare('UPDATE calendar_subscriptions SET next_refresh_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').run(new Date(now.getTime()+60_000).toISOString(),id,token);}catch{/* the lease expires on its own */}
        return 'attempted';
      }
      // Feed URLs can contain private tokens; never surface a raw network exception, only allow-listed reasons.
      this.db.prepare('UPDATE calendar_subscriptions SET last_error=?,failure_count=failure_count+1,next_refresh_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?')
        .run(refreshError(error),new Date(now.getTime()+Math.min(6*3600_000,5*60_000*2**Math.min(row.failure_count,7))).toISOString(),id,token);
    }
    return 'attempted';
  }
  private applyItems(owner:string,subscriptionId:string,items:FeedItem[],stamp:string,windowStart:string,windowEnd:string) {
    const seen=new Set<string>();
    for(const source of items){
      const key=keyOf(source);seen.add(key);
      if(source.legacyRecurrenceId)this.adoptLegacyOverride(owner,subscriptionId,key,source.uid,source.legacyRecurrenceId);
      const existing=this.db.prepare('SELECT entity_id,source_data FROM calendar_items WHERE subscription_id=? AND item_key=?').get(subscriptionId,key) as {entity_id:string;source_data:string}|undefined;
      const entityId=existing?.entity_id??'ical_'+hash(subscriptionId+'\0'+key);
      const entity=readEntity(this.db,owner,entityId);
      const incoming=fieldsOf(source);
      const metadata={subscriptionId,uid:source.uid,recurrenceId:source.recurrenceId,startDate:source.startDate,startTime:source.startTime,endDate:source.endDate,endTime:source.endTime,timeZone:source.timeZone,allDay:source.allDay,sourceRemoved:source.cancelled,sourceUpdatedAt:stamp,url:source.url??null};
      if(!entity&&!source.cancelled){
        // One item the task schema cannot hold must never block the rest of the feed; it is retried on the next refresh.
        const parsed=taskSchema.safeParse({...incoming,classId:null,completed:false,imported:metadata});
        if(!parsed.success)continue;
        writeEntity(this.db,owner,{id:entityId,kind:'task',version:1,deleted:false,data:parsed.data});
      }
      else if(entity&&!entity.deleted){
        const previous=existing?fieldsOf(JSON.parse(existing.source_data) as FeedItem):incoming;
        const data={...entity.data};
        const pending=this.db.prepare('SELECT fields FROM calendar_conflicts WHERE owner_id=? AND entity_id=?').get(owner,entityId) as {fields:string}|undefined;
        const conflicts=new Set<keyof SourceFields>(pending?JSON.parse(pending.fields):[]);
        const applied=new Set<keyof SourceFields>();
        for(const field of FIELDS){
          if(data[field]===incoming[field])conflicts.delete(field);
          else if(incoming[field]!==previous[field]){
            if(data[field]===previous[field]){data[field]=incoming[field];applied.add(field);}else conflicts.add(field);
          }
        }
        // Keep an applied source field only if the task stays valid; otherwise it becomes a choice.
        const conflict=(fields:Iterable<keyof SourceFields>)=>{for(const field of fields){if(applied.delete(field))data[field]=entity.data[field];if(data[field]!==incoming[field])conflicts.add(field);}};
        // Due date and time are one value: never apply half of it next to the other half's conflict,
        // which could leave a time without a date or point at a different moment.
        if(conflicts.has('dueDate')||conflicts.has('dueTime'))conflict(['dueDate','dueTime']);
        const stamped=()=>{
          const oldMetadata=entity.data.imported as Task['imported'];
          data.imported={...metadata,sourceUpdatedAt:oldMetadata?.sourceUpdatedAt??stamp};
          if(JSON.stringify(data)!==JSON.stringify(entity.data))data.imported=metadata;
          return taskSchema.safeParse(data);
        };
        let parsed=stamped();
        // A local edit can make an automatic source edit invalid (a cleared due date plus a new source time). Only the
        // due pair can do that, so it alone becomes a choice and other source-only changes (title, notes) still apply;
        // every applied field is reverted only if the task is somehow still invalid.
        if(!parsed.success&&(applied.has('dueDate')||applied.has('dueTime'))){conflict(['dueDate','dueTime']);parsed=stamped();}
        if(!parsed.success&&applied.size){conflict([...applied]);parsed=stamped();}
        if(conflicts.size)this.db.prepare('INSERT INTO calendar_conflicts VALUES(?,?,?,?,?) ON CONFLICT(owner_id,entity_id) DO UPDATE SET fields=excluded.fields,incoming=excluded.incoming').run(owner,entityId,subscriptionId,JSON.stringify([...conflicts]),JSON.stringify(incoming));
        else this.db.prepare('DELETE FROM calendar_conflicts WHERE owner_id=? AND entity_id=?').run(owner,entityId);
        // One unreadable task must never freeze the rest of the feed; retry it on the next refresh.
        if(!parsed.success)continue;
        if(JSON.stringify(data)!==JSON.stringify(entity.data))writeEntity(this.db,owner,{...entity,version:entity.version+1,data:parsed.data});
      }
      this.db.prepare('INSERT INTO calendar_items VALUES(?,?,?,?) ON CONFLICT(subscription_id,item_key) DO UPDATE SET source_data=excluded.source_data').run(subscriptionId,key,entityId,JSON.stringify(source));
    }
    const previous=this.db.prepare('SELECT * FROM calendar_items WHERE subscription_id=?').all(subscriptionId) as {item_key:string;entity_id:string;source_data:string}[];
    for(const item of previous){
      if(seen.has(item.item_key))continue;
      if(!inWindow(JSON.parse(item.source_data) as FeedItem,windowStart,windowEnd))continue;
      const entity=readEntity(this.db,owner,item.entity_id);
      const imported=entity?.data.imported as Task['imported'];
      if(entity&&!entity.deleted&&imported&&!imported.sourceRemoved)writeEntity(this.db,owner,{...entity,version:entity.version+1,data:{...entity.data,imported:{...imported,sourceRemoved:true,sourceUpdatedAt:stamp}}});
    }
  }
  /**
   * Imports before RECURRENCE-ID matching by instant stored an override written in another form (a UTC RECURRENCE-ID
   * next to a TZID DTSTART) under its own text, next to a duplicate task for the occurrence it moved. The override's
   * task holds the moved event and whatever the student did with it, so it takes over the matched key: a missing key
   * row is simply renamed, otherwise the two rows swap tasks and the duplicate, now under the old key, is marked
   * removed from the source by the removal pass. It runs once, because afterwards the old key's source data no longer
   * names that override. If the student deleted the override's task, the rows stay as they are.
   */
  private adoptLegacyOverride(owner:string,subscriptionId:string,key:string,uid:string,legacyRecurrenceId:string) {
    const legacyKey=JSON.stringify([uid,legacyRecurrenceId]);
    const row=(itemKey:string)=>this.db.prepare('SELECT entity_id,source_data FROM calendar_items WHERE subscription_id=? AND item_key=?').get(subscriptionId,itemKey) as {entity_id:string;source_data:string}|undefined;
    const legacy=row(legacyKey);
    if(!legacy||(JSON.parse(legacy.source_data) as FeedItem).recurrenceId!==legacyRecurrenceId)return;
    const current=row(key);
    if(!current){this.db.prepare('UPDATE calendar_items SET item_key=? WHERE subscription_id=? AND item_key=?').run(key,subscriptionId,legacyKey);return;}
    const entity=readEntity(this.db,owner,legacy.entity_id);
    if(!entity||entity.deleted)return;
    const swap=this.db.prepare('UPDATE calendar_items SET entity_id=?,source_data=? WHERE subscription_id=? AND item_key=?');
    swap.run(legacy.entity_id,legacy.source_data,subscriptionId,key);
    swap.run(current.entity_id,current.source_data,subscriptionId,legacyKey);
  }
  /**
   * The worker's calendar step: refreshes due feeds, oldest first, `concurrency` at a time, and stops starting new ones
   * once `budgetMs` has passed so reminders later in the same cycle are not held up (each fetch is capped at 10 s).
   * Feeds left over stay due and go first next cycle. Returns how many feeds it started.
   */
  async refreshDue(limit=500,{concurrency=5,budgetMs=20_000}:{concurrency?:number;budgetMs?:number}={}):Promise<number> {
    const rows=this.db.prepare('SELECT id,owner_id FROM calendar_subscriptions WHERE enabled=1 AND next_refresh_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_refresh_at LIMIT ?').all(this.now().toISOString(),this.now().toISOString(),limit) as {id:string;owner_id:string}[];
    // A worker started without NEXTAUTH_SECRET throws PRECONDITION_FAILED to its error log once per cycle and leaves
    // every feed untouched, rather than telling each student their encryption key changed.
    if(rows.length)encryptionKey(this.secret());
    const deadline=Date.now()+budgetMs;
    let next=0,failed=false,failure:unknown;
    const lane=async()=>{
      // The first round always starts, so a zero or exhausted budget still makes progress.
      while(next<rows.length&&(next<concurrency||Date.now()<deadline)){
        const row=rows[next++];
        // One failure (a busy database while leasing) must not abandon the other lanes' in-flight fetches.
        try{await this.refresh(row.owner_id,row.id,true);}catch(error){if(!failed){failed=true;failure=error;}}
      }
    };
    await Promise.all(Array.from({length:Math.max(1,Math.min(concurrency,rows.length))},lane));
    if(failed)throw failure;
    return next;
  }
}
