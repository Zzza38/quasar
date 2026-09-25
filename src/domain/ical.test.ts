import {describe,it,expect} from 'vitest';
import {feedTitle,parseICalendar,webLink} from './ical';
const wrap = (s:string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${s.replace(/\n/g,'\r\n')}\r\nEND:VCALENDAR\r\n`;
const event = (s:string) => `BEGIN:VEVENT\n${s}\nEND:VEVENT`;
const options = {timeZone:'America/New_York',windowStart:'2026-01-01',windowEnd:'2026-12-31'};
describe('iCalendar import',()=>{
  it('trims titles the way tasks store them and falls back for whitespace-only summaries',()=>{
    const items = parseICalendar(wrap([event('UID:blank\nDTSTART;VALUE=DATE:20260911\nSUMMARY:   '),event('UID:padded\nDTSTART;VALUE=DATE:20260912\nSUMMARY:Essay  ')].join('\n')),options);
    expect(items.map(i=>i.title)).toEqual(['Untitled calendar item','Essay']);
    expect(feedTitle(` ${'a'.repeat(299)} b`)).toBe('a'.repeat(299));
    expect(feedTitle(undefined)).toBe('Untitled calendar item');
  });
  it('drops links whose normalized form exceeds the stored length limit',()=>{
    expect(webLink('https://a.example/'+'é'.repeat(1000))).toBeNull();
    expect(webLink('https://a.example/é')).toBe('https://a.example/%C3%A9');
  });
  it('converts UTC, floating and IANA TZID while preserving dates',()=>{
    const items = parseICalendar(wrap([
      event('UID:utc\nDTSTART:20260911T020000Z\nSUMMARY:UTC'),
      event('UID:local\nDTSTART:20260911T090000\nSUMMARY:Floating'),
      event('UID:zone\nDTSTART;TZID=America/Los_Angeles:20260911T090000\nSUMMARY:Pacific'),
      event('UID:date\nDTSTART;VALUE=DATE:20260911\nDTEND;VALUE=DATE:20260912'),
    ].join('\n')),options);
    expect(items.find(i=>i.uid==='utc')).toMatchObject({startDate:'2026-09-10',startTime:'22:00'});
    expect(items.find(i=>i.uid==='local')).toMatchObject({startTime:'09:00'});
    expect(items.find(i=>i.uid==='zone')).toMatchObject({startTime:'12:00'});
    expect(items.find(i=>i.uid==='date')).toMatchObject({startTime:null,endDate:'2026-09-12',allDay:true});
  });
  it('reads folded and escaped text and VTODO due dates',()=>{
    const [item] = parseICalendar(wrap('BEGIN:VTODO\nUID:todo\nDUE:20260911T150000Z\nSUMMARY:Home\n work\\, chapter 1\nDESCRIPTION:Line 1\\nLine 2\nEND:VTODO'),options);
    expect(item).toMatchObject({title:'Homework, chapter 1',notes:'Line 1\nLine 2',dueDate:'2026-09-11',dueTime:'11:00'});
  });
  it('surfaces web links from the URL property and drops other schemes',()=>{
    const items = parseICalendar(wrap([
      event('UID:web\nDTSTART;VALUE=DATE:20260911\nURL:https://classroom.example/assignment/1?x=1'),
      event('UID:typed\nDTSTART;VALUE=DATE:20260911\nURL;VALUE=URI:http://school.example/page'),
      event('UID:mail\nDTSTART;VALUE=DATE:20260911\nURL:mailto:teacher@example.com'),
      event('UID:script\nDTSTART;VALUE=DATE:20260911\nURL:javascript:alert(1)'),
      event('UID:none\nDTSTART;VALUE=DATE:20260911'),
    ].join('\n')),options);
    expect(items.find(i=>i.uid==='web')?.url).toBe('https://classroom.example/assignment/1?x=1');
    expect(items.find(i=>i.uid==='typed')?.url).toBe('http://school.example/page');
    expect(items.find(i=>i.uid==='mail')?.url).toBeNull();
    expect(items.find(i=>i.uid==='script')?.url).toBeNull();
    expect(items.find(i=>i.uid==='none')?.url).toBeNull();
  });
  it('expands RRULE/RDATE, respects EXDATE and moved/cancelled instances with stable identities',()=>{
    const items = parseICalendar(wrap([
      event('UID:repeat\nDTSTART:20260901T090000\nDTEND:20260901T100000\nRRULE:FREQ=DAILY;COUNT=4\nRDATE:20260910T090000\nEXDATE:20260902T090000\nSUMMARY:Class'),
      event('UID:repeat\nRECURRENCE-ID:20260903T090000\nDTSTART:20260903T110000\nSUMMARY:Moved'),
      event('UID:repeat\nRECURRENCE-ID:20260904T090000\nSTATUS:CANCELLED')
    ].join('\n')),options);
    expect(items).toHaveLength(4);
    expect(items.find(i=>i.title==='Moved')).toMatchObject({recurrenceId:'2026-09-03T09:00:00',startTime:'11:00'});
    expect(items.find(i=>i.cancelled)).toMatchObject({recurrenceId:'2026-09-04T09:00:00'});
    expect(items[0]).toMatchObject({endTime:'10:00'});
  });
  it('matches a RECURRENCE-ID written in a different zone form to its occurrence instead of duplicating it',()=>{
    const zoned = parseICalendar(wrap([
      event('UID:zoned\nDTSTART;TZID=America/New_York:20261026T090000\nRRULE:FREQ=WEEKLY;COUNT=3\nSUMMARY:Class'),
      event('UID:zoned\nRECURRENCE-ID:20261102T140000Z\nDTSTART:20261102T160000Z\nSUMMARY:Moved'),
    ].join('\n')),options);
    expect(zoned.map(i=>[i.recurrenceId,i.title,i.startDate,i.startTime])).toEqual([
      ['2026-10-26T09:00:00','Class','2026-10-26','09:00'],
      // The moved occurrence keeps the identity of the one it replaces.
      ['2026-11-02T09:00:00','Moved','2026-11-02','11:00'],
      ['2026-11-09T09:00:00','Class','2026-11-09','09:00'],
    ]);
    // Its own text, which imports before instant matching keyed it by, is kept for migrating that stored row.
    expect(zoned.map(i=>i.legacyRecurrenceId)).toEqual([undefined,'2026-11-02T14:00:00Z',undefined]);
    const utc = parseICalendar(wrap([
      event('UID:utc\nDTSTART:20261026T130000Z\nRRULE:FREQ=WEEKLY;COUNT=2\nSUMMARY:Class'),
      event('UID:utc\nRECURRENCE-ID;TZID=America/New_York:20261102T080000\nSTATUS:CANCELLED'),
    ].join('\n')),options);
    expect(utc.map(i=>[i.recurrenceId,i.cancelled])).toEqual([['2026-10-26T13:00:00Z',false],['2026-11-02T13:00:00Z',true]]);
  });
  it('skips an undated VTODO instead of failing the feed, but still requires a start on events',()=>{
    const items = parseICalendar(wrap([event('UID:dated\nDTSTART;VALUE=DATE:20260911\nSUMMARY:Essay'),'BEGIN:VTODO\nUID:someday\nSUMMARY:Someday\nEND:VTODO'].join('\n')),options);
    expect(items.map(i=>i.uid)).toEqual(['dated']);
    expect(()=>parseICalendar(wrap(event('UID:undated\nSUMMARY:No date')),options)).toThrow('Calendar item has no start or due date.');
  });
  it('keeps recurrence wall times stable across daylight saving',()=>{
    const items=parseICalendar(wrap(event('UID:dst\nDTSTART;TZID=America/New_York:20261031T090000\nRRULE:FREQ=DAILY;COUNT=3')),options);
    expect(items.map(i=>i.startTime)).toEqual(['09:00','09:00','09:00']);
  });
  it('rejects broken, incomplete, unsupported and excessive feeds',()=>{
    for(const text of ['<html>error</html>',wrap(event('DTSTART:20260911T090000')),wrap(event('UID:invalid\nDTSTART:20260230T090000')),wrap(event('UID:a\nDTSTART:20260911T090000\nRRULE:FREQ=SECONDLY')),wrap(event('UID:a\nDTSTART:20260101T090000\nRRULE:FREQ=DAILY;COUNT=3000'))]) {
      expect(()=>parseICalendar(text,{...options,windowEnd:'2036-12-31'})).toThrow();
    }
    expect(()=>parseICalendar('x'.repeat(2*1024*1024+1),options)).toThrow();
  });
  it('allows a few BYHOUR, BYMINUTE or BYSECOND times a day but refuses more than 24',()=>{
    const hours = Array.from({length:24},(_,hour)=>hour).join(',');
    for(const rule of [`FREQ=DAILY;BYHOUR=${hours};BYMINUTE=0,30;COUNT=4`,'FREQ=WEEKLY;BYMINUTE=0,5,10,15,20,25,30,35,40,45,50,55,58;BYSECOND=0,30;COUNT=4'])
      expect(()=>parseICalendar(wrap(event(`UID:sub\nDTSTART:20260925T080000Z\nRRULE:${rule}`)),options),rule).toThrow('Calendar recurrence is too complex.');
    const shifted = parseICalendar(wrap(event('UID:shift\nDTSTART:20260925T080000Z\nRRULE:FREQ=DAILY;BYHOUR=13;BYMINUTE=15;COUNT=2')),options);
    expect(shifted.map(i=>[i.startDate,i.startTime])).toEqual([['2026-09-25','09:15'],['2026-09-26','09:15']]);
    // A class that meets twice on Mondays: each meeting is its own occurrence.
    const twice = parseICalendar(wrap(event('UID:twice\nDTSTART:20260928T080000Z\nDURATION:PT1H\nRRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=8,14;COUNT=4')),options);
    expect(twice.map(i=>i.recurrenceId)).toEqual(['2026-09-28T08:00:00Z','2026-09-28T14:00:00Z','2026-10-05T08:00:00Z','2026-10-05T14:00:00Z']);
  });
  it('uses embedded VTIMEZONE offsets and bounds impossible recurrence candidates',()=>{
    const zone = 'BEGIN:VTIMEZONE\nTZID:School/Custom\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0500\nEND:STANDARD\nEND:VTIMEZONE';
    const [item] = parseICalendar(wrap(zone+'\n'+event('UID:custom\nDTSTART;TZID=School/Custom:20260911T090000')),{...options,timeZone:'UTC'});
    expect(item.startTime).toBe('14:00');
    expect(()=>parseICalendar(wrap(event('UID:impossible\nDTSTART:20260101T090000\nRRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30')),options)).toThrow('safety limit');
  });
  it('keeps a VTODO due inside the window even when it started before it, but still drops old events',()=>{
    const window = {...options,windowStart:'2026-06-13',windowEnd:'2027-09-11'};
    const items = parseICalendar(wrap([
      'BEGIN:VTODO\nUID:long\nDTSTART;VALUE=DATE:20260501\nDUE;VALUE=DATE:20261001\nSUMMARY:Term project\nEND:VTODO',
      'BEGIN:VTODO\nUID:done\nDTSTART;VALUE=DATE:20260401\nDUE;VALUE=DATE:20260501\nEND:VTODO',
      event('UID:old\nDTSTART;VALUE=DATE:20260501\nDTEND;VALUE=DATE:20261001'),
    ].join('\n')),window);
    expect(items.map(i=>[i.uid,i.startDate,i.dueDate])).toEqual([['long','2026-05-01','2026-10-01']]);
  });
  it('leaves off an end date past 2199 so the event can still be imported as a task',()=>{
    const [item] = parseICalendar(wrap(event('UID:forever\nDTSTART:20260911T090000\nDTEND:23000101T090000')),options);
    expect(item).toMatchObject({startDate:'2026-09-11',startTime:'09:00',endDate:null,endTime:null,dueDate:'2026-09-11'});
  });
  it('starts a VTODO that began before 1900 on its due date, and imports one due after 2199 without a due date',()=>{
    const items = parseICalendar(wrap([
      'BEGIN:VTODO\nUID:ancient\nDTSTART;VALUE=DATE:18500101\nDUE:20260911T150000Z\nSUMMARY:Ancient\nEND:VTODO',
      // Outlook's "no date" sentinel.
      'BEGIN:VTODO\nUID:someday\nDTSTART;VALUE=DATE:20260912\nDUE;VALUE=DATE:45010101\nSUMMARY:Someday\nEND:VTODO',
      'BEGIN:VTODO\nUID:never\nDTSTART;VALUE=DATE:18500101\nDUE;VALUE=DATE:45010101\nEND:VTODO',
    ].join('\n')),options);
    expect(items.map(i=>i.uid)).toEqual(['ancient','someday']);
    expect(items[0]).toMatchObject({startDate:'2026-09-11',startTime:'11:00',endDate:'2026-09-11',endTime:'11:00',dueDate:'2026-09-11',dueTime:'11:00',allDay:false});
    expect(items[1]).toMatchObject({startDate:'2026-09-12',startTime:null,endDate:null,endTime:null,dueDate:null,dueTime:null,allDay:true});
  });
  it('accepts a truly empty calendar and filters occurrences by window',()=>{
    expect(parseICalendar(wrap(''),options)).toEqual([]);
    const items=parseICalendar(wrap(event('UID:a\nDTSTART:20260901T090000\nRRULE:FREQ=DAILY;COUNT=30')),{...options,windowStart:'2026-09-10',windowEnd:'2026-09-12'});
    expect(items.map(i=>i.startDate)).toEqual(['2026-09-10','2026-09-11','2026-09-12']);
  });
});
