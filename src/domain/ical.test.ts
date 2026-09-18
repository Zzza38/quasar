import {describe,it,expect} from 'vitest';
import {parseICalendar} from './ical';
const wrap = (s:string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${s.replace(/\n/g,'\r\n')}\r\nEND:VCALENDAR\r\n`;
const event = (s:string) => `BEGIN:VEVENT\n${s}\nEND:VEVENT`;
const options = {timeZone:'America/New_York',windowStart:'2026-01-01',windowEnd:'2026-12-31'};
describe('iCalendar import',()=>{
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
  it('uses embedded VTIMEZONE offsets and bounds impossible recurrence candidates',()=>{
    const zone = 'BEGIN:VTIMEZONE\nTZID:School/Custom\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0500\nEND:STANDARD\nEND:VTIMEZONE';
    const [item] = parseICalendar(wrap(zone+'\n'+event('UID:custom\nDTSTART;TZID=School/Custom:20260911T090000')),{...options,timeZone:'UTC'});
    expect(item.startTime).toBe('14:00');
    expect(()=>parseICalendar(wrap(event('UID:impossible\nDTSTART:20260101T090000\nRRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30')),options)).toThrow('safety limit');
  });
  it('accepts a truly empty calendar and filters occurrences by window',()=>{
    expect(parseICalendar(wrap(''),options)).toEqual([]);
    const items=parseICalendar(wrap(event('UID:a\nDTSTART:20260901T090000\nRRULE:FREQ=DAILY;COUNT=30')),{...options,windowStart:'2026-09-10',windowEnd:'2026-09-12'});
    expect(items.map(i=>i.startDate)).toEqual(['2026-09-10','2026-09-11','2026-09-12']);
  });
});
