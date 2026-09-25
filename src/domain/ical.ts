import ICAL from 'ical.js';
import { Temporal } from '@js-temporal/polyfill';
import { FIRST_DATE, LAST_DATE } from './schedule';

export type FeedItem = { uid:string; recurrenceId:string|null; title:string; notes:string; startDate:string; startTime:string|null; endDate:string|null; endTime:string|null; dueDate:string|null; dueTime:string|null; timeZone:string; allDay:boolean; cancelled:boolean; url:string|null;
  /**
   * Set on an override whose RECURRENCE-ID text differs from the occurrence it was matched to (a UTC RECURRENCE-ID
   * next to a TZID DTSTART): that text, which is how imports before instant matching keyed the override, so a refresh
   * can move the override's existing task to recurrenceId instead of marking it removed.
   */
  legacyRecurrenceId?:string };
export type ParseCalendarOptions = {timeZone:string;windowStart?:string;windowEnd?:string};
const MAX_ITEMS = 2000;
const MAX_STEPS = 50_000;
const MAX_TIMES_PER_DAY = 24;
const value = (c:ICAL.Component, name:string) => c.getFirstPropertyValue(name);
/** Only web links are surfaced; other schemes (mailto, javascript, file) are dropped rather than rendered as buttons. */
export function webLink(raw:unknown):string|null {
  if(typeof raw !== 'string') return null;
  const text = raw.trim(); if(!text || text.length > 2000) return null;
  // The length check applies to the normalized href too: percent-encoding can make it much longer than the raw text.
  try { const url = new URL(text); return (url.protocol === 'http:' || url.protocol === 'https:') && url.href.length <= 2000 ? url.href : null; } catch { return null; }
}
/**
 * A feed item's task title, normalized exactly as the task stores it (trimmed, at most 300 characters), so a
 * whitespace-only SUMMARY falls back to a placeholder and a trailing space never looks like a local edit.
 */
export function feedTitle(raw:unknown):string {
  return String(raw ?? '').trim().slice(0,300).trim() || 'Untitled calendar item';
}
const time = (c:ICAL.Component, name:string):ICAL.Time|null => {
  const v = value(c,name); if(v == null) return null;
  if(!(v instanceof ICAL.Time)) throw new Error(`Invalid calendar ${name}.`);
  return v;
};
const plainDate = (t:ICAL.Time) => `${String(t.year).padStart(4,'0')}-${String(t.month).padStart(2,'0')}-${String(t.day).padStart(2,'0')}`;
/** The instant a date-time names: UTC, a zone defined in the feed, its TZID parameter, or else the chosen zone for floating times. */
function instantOf(t:ICAL.Time, property:ICAL.Property|null, zone:string):Temporal.Instant {
  const date = plainDate(t);
  const clock = `${String(t.hour).padStart(2,'0')}:${String(t.minute).padStart(2,'0')}:${String(t.second).padStart(2,'0')}`;
  const tzid = property?.getParameter('tzid');
  if(t.zone.tzid === 'UTC') return Temporal.Instant.from(`${date}T${clock}Z`);
  if(t.zone.tzid !== 'floating' && t.zone.component) return Temporal.Instant.fromEpochMilliseconds(t.toUnixTime()*1000);
  return Temporal.PlainDateTime.from(`${date}T${clock}`).toZonedDateTime(typeof tzid === 'string' ? tzid : zone).toInstant();
}
function local(t:ICAL.Time, property:ICAL.Property|null, zone:string) {
  const date = plainDate(t);
  Temporal.PlainDate.from(date);
  if(t.isDate) return {date,time:null};
  const converted = instantOf(t,property,zone).toZonedDateTimeISO(zone);
  return {date:converted.toPlainDate().toString(),time:converted.toPlainTime().toString().slice(0,5)};
}
/**
 * Matches a RECURRENCE-ID to a master occurrence. RFC 5545 lets the two use different forms (UTC, another TZID,
 * floating), so date-times compare by instant rather than by their written text.
 */
function occurrenceKey(t:ICAL.Time, property:ICAL.Property|null, zone:string):string {
  if(t.isDate) return t.toString();
  try { return instantOf(t,property,zone).toString(); } catch { return t.toString(); }
}
/** A failed/unsupported feed throws so a refresh never interprets partial parsing as source deletion. */
export function parseICalendar(text:string, options:ParseCalendarOptions):FeedItem[] {
  if(new TextEncoder().encode(text).length > 2*1024*1024) throw new Error('Calendar exceeds the 2 MB limit.');
  if(!/^\s*BEGIN:VCALENDAR\r?\n/i.test(text) || !/\r?\nEND:VCALENDAR\s*$/i.test(text)) throw new Error('The response is not a complete iCalendar feed.');
  new Intl.DateTimeFormat('en-US',{timeZone:options.timeZone});
  const today = Temporal.Now.plainDateISO(options.timeZone);
  const from = Temporal.PlainDate.from(options.windowStart ?? today.subtract({days:90}).toString()).toString();
  const until = Temporal.PlainDate.from(options.windowEnd ?? today.add({days:365}).toString()).toString();
  if(until < from) throw new Error('Invalid calendar date window.');
  const calendar = new ICAL.Component(ICAL.parse(text));
  if(calendar.name !== 'vcalendar') throw new Error('Invalid calendar.');
  const components = [...calendar.getAllSubcomponents('vevent'),...calendar.getAllSubcomponents('vtodo')];
  if(components.length > MAX_ITEMS) throw new Error('Calendar contains too many entries.');
  const groups = new Map<string,ICAL.Component[]>();
  for(const c of components) {
    // Validate raw dates before ICAL.Time normalizes overflowing fields (e.g. Feb 30).
    for(const property of c.getAllProperties()) {
      if(property.type !== 'date' && property.type !== 'date-time') continue;
      for(const raw of property.toJSON().slice(3)) {
        if(typeof raw !== 'string') throw new Error('Invalid calendar date.');
        if(property.type === 'date') Temporal.PlainDate.from(raw);
        else if(raw.endsWith('Z')) Temporal.Instant.from(raw);
        else Temporal.PlainDateTime.from(raw);
      }
    }
    const uid = value(c,'uid');
    if(typeof uid !== 'string' || !uid.trim() || uid.length > 2000) throw new Error('Calendar entries require a valid UID.');
    const group = groups.get(uid) ?? []; group.push(c); groups.set(uid,group);
  }
  const output = new Map<string,FeedItem>(); let steps = 0;
  // Bound internal candidate scanning too: impossible BY* combinations can otherwise
  // spend unbounded time inside a single library next() call.
  class BoundedIterator extends ICAL.RecurIterator {
    override check_contracting_rules():boolean {
      if(++steps > MAX_STEPS) throw new Error('Calendar recurrence expansion exceeds the safety limit.');
      return super.check_contracting_rules();
    }
  }
  const emit = (c:ICAL.Component, start:ICAL.Time, end:ICAL.Time|null, recurrenceId:string|null, startProperty:ICAL.Property|null, endProperty:ICAL.Property|null, legacyRecurrenceId?:string) => {
    const inRange = (date:string) => date >= FIRST_DATE && date <= LAST_DATE;
    const todo = c.name === 'vtodo';
    let s = local(start,startProperty,options.timeZone);
    let e = end ? local(end,endProperty,options.timeZone) : null;
    let allDay = start.isDate;
    // Tasks hold dates in 1900-2199. A VTODO due outside that range (Outlook writes DUE 4501-01-01 for "no date") is
    // imported without a due date, and one that started before 1900 but is due in range starts on its due date, so
    // neither is left unimportable (or its stored task unlinked for good) by a date the task cannot hold.
    const undated = todo && !!e && !inRange(e.date);
    if(undated) e = null;
    if(todo && e && end && !inRange(s.date)) { s = e; allDay = end.isDate; }
    const due = todo && e ? e : s;
    // Keep an item whose start-to-due span overlaps the window: a VTODO that started long ago but is due soon still
    // belongs. An event is due on its start date, so it is filtered on that alone, as is an undated VTODO.
    const [first,last] = s.date < due.date ? [s.date,due.date] : [due.date,s.date];
    if(last < from || first > until) return;
    // An event's end past 2199 (an event running into 2300) is left off too, rather than making the whole item
    // unimportable.
    const endInRange = e && inRange(e.date) ? e : null;
    const uid = String(value(c,'uid'));
    const title = feedTitle(value(c,'summary'));
    const notes = String(value(c,'description') || '').slice(0,10000);
    output.set(JSON.stringify([uid,recurrenceId]),{uid,recurrenceId,title,notes,startDate:s.date,startTime:s.time,endDate:endInRange?.date ?? null,endTime:endInRange?.time ?? null,dueDate:undated ? null : due.date,dueTime:undated ? null : due.time,timeZone:options.timeZone,allDay,cancelled:String(value(c,'status')).toUpperCase() === 'CANCELLED',url:webLink(value(c,'url')),...(legacyRecurrenceId ? {legacyRecurrenceId} : {})});
    if(output.size > MAX_ITEMS) throw new Error('Calendar expands to more than 2000 occurrences.');
  };
  for(const group of groups.values()) {
    const masters = group.filter(c=>!c.hasProperty('recurrence-id'));
    if(masters.length > 1) throw new Error('Calendar contains duplicate UIDs.');
    const master = masters[0];
    // Keyed by occurrence instant; id is the stored recurrence identity, which becomes the matched occurrence's own
    // text so a moved occurrence keeps the identity of the task it replaces whatever form its RECURRENCE-ID uses.
    // legacy keeps the override's own text when that differs (see FeedItem.legacyRecurrenceId).
    const exceptions = new Map<string,{c:ICAL.Component;id:string;legacy?:string}>();
    for(const c of group.filter(c=>c.hasProperty('recurrence-id'))) {
      const property = c.getFirstProperty('recurrence-id');
      if(property?.getParameter('range')) throw new Error('Calendar RANGE recurrence overrides are not supported.');
      const recurrenceId = time(c,'recurrence-id')!;
      const key = occurrenceKey(recurrenceId,property,options.timeZone);
      if(exceptions.has(key)) throw new Error('Calendar contains duplicate recurrence overrides.');
      exceptions.set(key,{c,id:recurrenceId.toString()});
    }
    const renderSingle = (c:ICAL.Component, id:string|null, legacy?:string) => {
      const start = time(c,'dtstart') ?? time(c,'due') ?? time(c,'recurrence-id');
      if(!start) throw new Error('Calendar item has no start or due date.');
      const startProp = c.getFirstProperty('dtstart') ?? c.getFirstProperty('due') ?? c.getFirstProperty('recurrence-id');
      const endProp = c.getFirstProperty(c.name === 'vtodo'?'due':'dtend');
      let end = time(c,c.name === 'vtodo'?'due':'dtend');
      const duration = value(c,'duration');
      if(!end && duration instanceof ICAL.Duration) {end = start.clone();end.addDuration(duration);}
      emit(c,start,end,id,startProp,endProp ?? startProp,legacy);
    };
    if(master) {
      const start = time(master,'dtstart') ?? time(master,'due');
      // RFC 5545 makes both dates optional on a VTODO. An undated to-do has no day to land on, so it is left out
      // rather than failing the whole feed; an event still needs its DTSTART.
      if(!start && master.name !== 'vtodo') throw new Error('Calendar item has no start or due date.');
      const recurring = master.hasProperty('rrule') || master.hasProperty('rdate');
      if(!start) { /* undated VTODO: skipped */ }
      else if(!recurring) renderSingle(master,null);
      else {
        for(const rule of master.getAllProperties('rrule')) {
          const recurrence = rule.getFirstValue();
          if(!(recurrence instanceof ICAL.Recur) || !['DAILY','WEEKLY','MONTHLY','YEARLY'].includes(recurrence.freq)) throw new Error('Only daily, weekly, monthly and yearly calendar recurrences are supported.');
          if(recurrence.interval < 1 || recurrence.interval > 1000 || Object.values(recurrence.parts).some(parts=>parts.length > 366)) throw new Error('Calendar recurrence is too complex.');
          // BYHOUR, BYMINUTE and BYSECOND lists repeat an item within one day. A few times a day is a real schedule (a
          // class that meets at 8:00 and 14:00 on Mondays); more than 24 is sub-daily in effect and is refused.
          if((['BYHOUR','BYMINUTE','BYSECOND'] as const).reduce((perDay,part)=>perDay*Math.max(1,recurrence.parts[part]?.length ?? 0),1) > MAX_TIMES_PER_DAY) throw new Error('Calendar recurrence is too complex.');
          const cap = ICAL.Time.fromDateTimeString(`${Temporal.PlainDate.from(until).add({days:2})}T23:59:59Z`);
          if(!recurrence.until || recurrence.until.compare(cap) > 0) recurrence.until = cap;
          recurrence.iterator = dtstart => new BoundedIterator({rule:recurrence,dtstart});
        }
        for(const prop of master.getAllProperties('rdate')) if(prop.type === 'period') throw new Error('Calendar period RDATE values are not supported.');
        const expansion = new ICAL.RecurExpansion({component:master,dtstart:start});
        const endName = master.name === 'vtodo'?'due':'dtend';
        const originalEnd = time(master,endName);
        const duration = originalEnd?.subtractDate(start) ?? value(master,'duration');
        const startProp = master.getFirstProperty('dtstart') ?? master.getFirstProperty('due');
        while(true) {
          if(++steps > MAX_STEPS) throw new Error('Calendar recurrence expansion exceeds the safety limit.');
          const occurrence = expansion.next(); if(!occurrence) break;
          // The two-day margin covers conversion between source and selected time zones.
          if(occurrence.toString().slice(0,10) > Temporal.PlainDate.from(until).add({days:2}).toString()) break;
          const exception = exceptions.get(occurrenceKey(occurrence,startProp,options.timeZone));
          if(exception) {
            if(exception.id !== occurrence.toString()) { exception.legacy = exception.id; exception.id = occurrence.toString(); }
            continue;
          }
          let end:ICAL.Time|null = null;
          if(duration instanceof ICAL.Duration) {end=occurrence.clone();end.addDuration(duration);}
          emit(master,occurrence,end,occurrence.toString(),startProp,startProp);
        }
      }
    }
    // Also include detached and moved overrides whose original occurrence lies outside the window.
    for(const {c,id,legacy} of exceptions.values()) renderSingle(c,id,legacy);
  }
  return [...output.values()].sort((a,b)=>`${a.startDate}T${a.startTime ?? ''}`.localeCompare(`${b.startDate}T${b.startTime ?? ''}`));
}
