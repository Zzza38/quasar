import ICAL from 'ical.js';
import { Temporal } from '@js-temporal/polyfill';

export type FeedItem = { uid:string; recurrenceId:string|null; title:string; notes:string; startDate:string; startTime:string|null; endDate:string|null; endTime:string|null; dueDate:string; dueTime:string|null; timeZone:string; allDay:boolean; cancelled:boolean; url:string|null };
export type ParseCalendarOptions = {timeZone:string;windowStart?:string;windowEnd?:string};
const MAX_ITEMS = 2000;
const MAX_STEPS = 50_000;
const value = (c:ICAL.Component, name:string) => c.getFirstPropertyValue(name);
/** Only web links are surfaced; other schemes (mailto, javascript, file) are dropped rather than rendered as buttons. */
export function webLink(raw:unknown):string|null {
  if(typeof raw !== 'string') return null;
  const text = raw.trim(); if(!text || text.length > 2000) return null;
  try { const url = new URL(text); return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null; } catch { return null; }
}
const time = (c:ICAL.Component, name:string):ICAL.Time|null => {
  const v = value(c,name); if(v == null) return null;
  if(!(v instanceof ICAL.Time)) throw new Error(`Invalid calendar ${name}.`);
  return v;
};
function local(t:ICAL.Time, property:ICAL.Property|null, zone:string) {
  const date = `${String(t.year).padStart(4,'0')}-${String(t.month).padStart(2,'0')}-${String(t.day).padStart(2,'0')}`;
  Temporal.PlainDate.from(date);
  if(t.isDate) return {date,time:null};
  const clock = `${String(t.hour).padStart(2,'0')}:${String(t.minute).padStart(2,'0')}:${String(t.second).padStart(2,'0')}`;
  const tzid = property?.getParameter('tzid');
  let instant:Temporal.Instant;
  if(t.zone.tzid === 'UTC') instant = Temporal.Instant.from(`${date}T${clock}Z`);
  else if(t.zone.tzid !== 'floating' && t.zone.component) instant = Temporal.Instant.fromEpochMilliseconds(t.toUnixTime()*1000);
  else instant = Temporal.PlainDateTime.from(`${date}T${clock}`).toZonedDateTime(typeof tzid === 'string' ? tzid : zone).toInstant();
  const converted = instant.toZonedDateTimeISO(zone);
  return {date:converted.toPlainDate().toString(),time:converted.toPlainTime().toString().slice(0,5)};
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
  const emit = (c:ICAL.Component, start:ICAL.Time, end:ICAL.Time|null, recurrenceId:string|null, startProperty:ICAL.Property|null, endProperty:ICAL.Property|null) => {
    const s = local(start,startProperty,options.timeZone);
    const e = end ? local(end,endProperty,options.timeZone) : null;
    if(s.date < from || s.date > until) return;
    const uid = String(value(c,'uid'));
    const title = String(value(c,'summary') || 'Untitled calendar item').slice(0,300);
    const notes = String(value(c,'description') || '').slice(0,10000);
    const due = c.name === 'vtodo' && e ? e : s;
    output.set(JSON.stringify([uid,recurrenceId]),{uid,recurrenceId,title,notes,startDate:s.date,startTime:s.time,endDate:e?.date ?? null,endTime:e?.time ?? null,dueDate:due.date,dueTime:due.time,timeZone:options.timeZone,allDay:start.isDate,cancelled:String(value(c,'status')).toUpperCase() === 'CANCELLED',url:webLink(value(c,'url'))});
    if(output.size > MAX_ITEMS) throw new Error('Calendar expands to more than 2000 occurrences.');
  };
  for(const group of groups.values()) {
    const masters = group.filter(c=>!c.hasProperty('recurrence-id'));
    if(masters.length > 1) throw new Error('Calendar contains duplicate UIDs.');
    const master = masters[0];
    const exceptions = new Map<string,ICAL.Component>();
    for(const c of group.filter(c=>c.hasProperty('recurrence-id'))) {
      if(c.getFirstProperty('recurrence-id')?.getParameter('range')) throw new Error('Calendar RANGE recurrence overrides are not supported.');
      const id = time(c,'recurrence-id')!.toString();
      if(exceptions.has(id)) throw new Error('Calendar contains duplicate recurrence overrides.');
      exceptions.set(id,c);
    }
    const renderSingle = (c:ICAL.Component, id:string|null) => {
      const start = time(c,'dtstart') ?? time(c,'due') ?? time(c,'recurrence-id');
      if(!start) throw new Error('Calendar item has no start or due date.');
      const startProp = c.getFirstProperty('dtstart') ?? c.getFirstProperty('due') ?? c.getFirstProperty('recurrence-id');
      const endProp = c.getFirstProperty(c.name === 'vtodo'?'due':'dtend');
      let end = time(c,c.name === 'vtodo'?'due':'dtend');
      const duration = value(c,'duration');
      if(!end && duration instanceof ICAL.Duration) {end = start.clone();end.addDuration(duration);}
      emit(c,start,end,id,startProp,endProp ?? startProp);
    };
    if(master) {
      const start = time(master,'dtstart') ?? time(master,'due');
      if(!start) throw new Error('Calendar item has no start or due date.');
      const recurring = master.hasProperty('rrule') || master.hasProperty('rdate');
      if(!recurring) renderSingle(master,null);
      else {
        for(const rule of master.getAllProperties('rrule')) {
          const recurrence = rule.getFirstValue();
          if(!(recurrence instanceof ICAL.Recur) || !['DAILY','WEEKLY','MONTHLY','YEARLY'].includes(recurrence.freq)) throw new Error('Only daily, weekly, monthly and yearly calendar recurrences are supported.');
          if(recurrence.interval < 1 || recurrence.interval > 1000 || Object.values(recurrence.parts).some(parts=>parts.length > 366)) throw new Error('Calendar recurrence is too complex.');
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
          if(exceptions.has(occurrence.toString())) continue;
          let end:ICAL.Time|null = null;
          if(duration instanceof ICAL.Duration) {end=occurrence.clone();end.addDuration(duration);}
          emit(master,occurrence,end,occurrence.toString(),startProp,startProp);
        }
      }
    }
    // Also include detached and moved overrides whose original occurrence lies outside the window.
    for(const [id,c] of exceptions) renderSingle(c,id);
  }
  return [...output.values()].sort((a,b)=>`${a.startDate}T${a.startTime ?? ''}`.localeCompare(`${b.startDate}T${b.startTime ?? ''}`));
}
