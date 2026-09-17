import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { appRouter } from './router';
import type { Schedule } from '@/domain/schedule';
import type { Entity, Mutation } from '@/domain/sync';

const schedule: Schedule = {
  version: 1, timeZone: 'America/New_York',
  periods: [{id:'A',label:'A',kind:'class'},{id:'L',label:'Lunch',kind:'lunch'}],
  cycleDays: [{id:'1',label:'Day 1',slots:[{id:'a1',periodId:'A',start:'08:00',end:'09:00'},{id:'l1',periodId:'L',start:'12:00',end:'12:30'}]}],
  anchorDate:'2026-09-08',anchorCycleDayId:'1',schoolWeekdays:[1,2,3,4,5],advanceWeekdays:[1,2,3,4,5],exceptions:[]
};
const task = {title:'Read chapter 1',dueDate:null,dueTime:null,classId:null,notes:'',completed:false};
const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });
function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  function user(email = `${randomUUID()}@example.com`) {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, 'Student', 'Student Name', new Date().toISOString());
    return id;
  }
  const owner = user('owner@example.com'), student = user();
  const school = service.createSchool(student, {name:'Example High',location:'Boston, MA',schedule});
  return {db,service,user,owner,student,school};
}
function mutation(data: Record<string,unknown>|null, base: Entity|null=null, id=base?.id || randomUUID()): Mutation {
  return {mutationId:randomUUID(),id,kind:'task',base,data};
}
function applied(result: ReturnType<Service['sync']>) { if (result.status !== 'applied') throw Error('Expected applied'); return result.entity; }

describe('school membership and owner authorization', () => {
  it('requires Google session and both names before onboarding', async () => {
    const f = fixture();
    const caller = appRouter.createCaller({service:f.service,userId:null});
    await expect(caller.workspace()).rejects.toMatchObject({code:'UNAUTHORIZED'});
    await expect(caller.admin.schools()).rejects.toMatchObject({code:'UNAUTHORIZED'});
    f.db.prepare('UPDATE users SET full_name=? WHERE id=?').run('',f.student);
    expect(() => f.service.createSchool(f.student,{name:'Test',location:'NY',schedule})).toThrow('Enter your');
  });
  it('requires explicit community selection and never grants approval to creators', () => {
    const f=fixture();
    expect(f.school.approved).toBe(false);
    expect(f.service.user(f.student).schoolId).toBeNull();
    expect(() => f.service.join(f.student,{schoolId:f.school.id,choice:'approved'})).toThrow('explicitly');
    f.service.join(f.student,{schoolId:f.school.id,choice:'community'});
    expect(f.service.user(f.student).schoolId).toBe(f.school.id);
    expect(f.service.entity(f.student,'personal')?.data.customSchedule).toBeNull();
  });
  it('locks atomically on the tenth distinct member and remains locked after departures', () => {
    const f=fixture();
    const members=[f.student,...Array.from({length:9},()=>f.user())];
    for (const id of members.slice(0,9)) f.service.join(id,{schoolId:f.school.id,choice:'community'});
    expect(f.service.school(f.school.id).memberLocked).toBe(false);
    f.service.join(f.student,{schoolId:f.school.id,choice:'community'});
    expect(f.service.school(f.school.id).memberCount).toBe(9);
    f.service.join(members[9],{schoolId:f.school.id,choice:'community'});
    expect(f.service.school(f.school.id).memberLocked).toBe(true);
    expect(() => f.service.updateSchool(f.student,{schoolId:f.school.id,expectedVersion:1,schedule})).toThrow('locked');
    const other=f.service.createSchool(f.owner,{name:'Other School',location:'Boston',schedule});
    f.service.join(members[9],{schoolId:other.id,choice:'community'});
    expect(f.service.school(f.school.id)).toMatchObject({memberCount:9,memberLocked:true});
  });
  it('rejects nonmember edits and forged admin calls, but owner can correct locks', async () => {
    const f=fixture();
    expect(() => f.service.updateSchool(f.student,{schoolId:f.school.id,expectedVersion:1,schedule})).toThrow('Only school members');
    const caller=appRouter.createCaller({service:f.service,userId:f.student});
    await expect(caller.admin.update({schoolId:f.school.id,expectedVersion:1,schedule,approved:true,supportLocked:true})).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(caller.admin.requests()).rejects.toMatchObject({code:'FORBIDDEN'});
    f.service.updateSchool(f.owner,{schoolId:f.school.id,expectedVersion:1,schedule,approved:true,supportLocked:true},true);
    f.service.join(f.student,{schoolId:f.school.id,choice:'approved'});
    expect(() => f.service.updateSchool(f.student,{schoolId:f.school.id,expectedVersion:2,schedule})).toThrow('locked');
    const corrected=f.service.updateSchool(f.owner,{schoolId:f.school.id,expectedVersion:2,schedule,approved:true,supportLocked:true},true);
    expect(corrected.version).toBe(3);
    expect(() => f.service.updateSchool(f.owner,{schoolId:f.school.id,expectedVersion:2,schedule,approved:true,supportLocked:true},true)).toThrow('changed');
  });
  it('preserves personal classes/lunch overrides and review history after corrections', () => {
    const f=fixture(); f.service.join(f.student,{schoolId:f.school.id,choice:'community'});
    const base=f.service.entity(f.student,'personal')!;
    const data={...base.data,classes:[{id:'biology',name:'Biology'}],assignments:{A:'biology'},cycleDayOverrides:[{cycleDayId:'1',slots:[{id:'l1',periodId:'L',start:'12:15',end:'12:45'}]}]};
    applied(f.service.sync(f.student,{mutationId:randomUUID(),id:'personal',kind:'personal',base,data}));
    const changed={...schedule,periods:[{id:'L',label:'Lunch',kind:'lunch' as const}],cycleDays:[{...schedule.cycleDays[0],slots:[{id:'l1',periodId:'L',start:'12:30',end:'13:00'}]}]};
    f.service.updateSchool(f.owner,{schoolId:f.school.id,expectedVersion:1,schedule:changed,approved:true,supportLocked:true},true);
    const workspace=f.service.workspace(f.student);
    expect(workspace.entities.find(e=>e.id==='personal')?.data).toMatchObject(data);
    expect(workspace.review).toMatchObject({previous:schedule,current:changed,version:2});
    f.service.acknowledge(f.student,2);
    expect(f.service.workspace(f.student).review).toBeNull();
    expect(f.service.entity(f.student,'personal')?.data).toMatchObject(data);
  });
  it('keeps other members names/tasks out of workspace and routes correction requests to owner', () => {
    const f=fixture(); f.service.join(f.student,{schoolId:f.school.id,choice:'community'});
    f.service.requestCorrection(f.student,'Lunch should begin at 12:15; see the published bell schedule.');
    expect(f.service.requests(f.owner)).toHaveLength(1);
    const request=f.service.requests(f.owner)[0];
    expect(request).not.toHaveProperty('fullName');
    expect(()=>f.service.requests(f.student)).toThrow('Owner');
    f.service.resolveRequest(f.owner,request.id);
    expect(f.service.requests(f.owner)).toHaveLength(0);
  });
});

describe('durable synchronization', () => {
  it('binds each upload to the original authenticated account across cookie changes', async () => {
    const f=fixture();
    const caller=appRouter.createCaller({service:f.service,userId:f.owner});
    await expect(caller.sync({...mutation(task),accountId:f.student})).rejects.toMatchObject({code:'UNAUTHORIZED'});
    expect(f.service.workspace(f.owner).entities).toHaveLength(0);
    expect((await caller.sync({...mutation(task),accountId:f.owner})).status).toBe('applied');
  });
  it('retries safely, rejects reused IDs with changed payloads, and isolates users', () => {
    const f=fixture(); const input=mutation(task);
    const a=f.service.sync(f.student,input), b=f.service.sync(f.student,input);
    expect(a).toEqual(b);
    expect(f.service.workspace(f.student).entities).toHaveLength(1);
    expect(()=>f.service.sync(f.student,{...input,data:{...task,title:'Different'}})).toThrow('retry ID');
    expect(f.service.workspace(f.owner).entities).toHaveLength(0);
    const forged=mutation({...task,title:'Hacked'},applied(a));
    expect(()=>f.service.sync(f.owner,forged)).toThrow('base revision');
  });
  it('merges non-conflicting edits and retains competing values for explicit choices', () => {
    const f=fixture(); const base=applied(f.service.sync(f.student,mutation(task)));
    const remote=applied(f.service.sync(f.student,mutation({...task,notes:'From laptop'},base)));
    const merged=applied(f.service.sync(f.student,mutation({...task,completed:true},base)));
    expect(merged.data).toMatchObject({notes:'From laptop',completed:true});
    const conflictMutation=mutation({...task,notes:'From phone'},base);
    const conflict=f.service.sync(f.student,conflictMutation);
    expect(conflict.status).toBe('conflict');
    expect(f.service.sync(f.student,conflictMutation)).toEqual(conflict);
    expect(f.service.entity(f.student,base.id)).toEqual(merged);
    const resolved=applied(f.service.sync(f.student,mutation({...merged.data,notes:'From phone'},merged)));
    expect(resolved.data.notes).toBe('From phone');
    expect(remote.version).toBeLessThan(resolved.version);
  });
  it('surfaces delete versus edit and validates both input and merged result', () => {
    const f=fixture(); const base=applied(f.service.sync(f.student,mutation(task)));
    applied(f.service.sync(f.student,mutation({...task,title:'Changed'},base)));
    expect(f.service.sync(f.student,mutation(null,base)).status).toBe('conflict');
    expect(()=>f.service.sync(f.student,mutation({...task,title:''}))).toThrow();
    expect(()=>f.service.sync(f.student,mutation({...task,dueTime:'12:00'}))).toThrow('due date');
    expect(()=>f.service.sync(f.student,mutation(task,{...base,data:{...task,title:'Fake base'}}))).toThrow('base revision');
  });
  it('persists saved class/lunch data and receipts after database reopen', () => {
    const directory=mkdtempSync(join(tmpdir(),'quasar-test-')); const path=join(directory,'test.sqlite');
    try {
      const db=openDatabase(path); const id=randomUUID();
      db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id,id,'test@example.com','Test','Test User',new Date().toISOString());
      const service=new Service(db);
      const data={classes:[{id:'bio',name:'Biology'}],assignments:{A:'bio'},cycleDayOverrides:[],dateOverrides:[],customSchedule:schedule};
      const input: Mutation={mutationId:randomUUID(),id:'personal',kind:'personal',base:null,data};
      const saved=service.sync(id,input); db.close();
      const reopened=openDatabase(path);
      try { const after=new Service(reopened); expect(after.sync(id,input)).toEqual(saved); expect(after.workspace(id).entities[0].data).toMatchObject(data); }
      finally { reopened.close(); }
    } finally { rmSync(directory,{recursive:true,force:true}); }
  });
});

describe('grade-specific school revisions', () => {
  it('persists selected grades while preserving other schedules and revision history', () => {
    const f = fixture();
    f.service.join(f.student, { schoolId: f.school.id, choice: 'community' });
    const draft = { ...schedule, cycleDays: [{ ...schedule.cycleDays[0], label: 'Junior day' }] };
    const updated = f.service.updateSchool(f.student, { schoolId: f.school.id, expectedVersion: 1, schedule: draft, grades: ['9', '10'] });
    expect(updated.schedule.cycleDays).toEqual(schedule.cycleDays);
    expect(updated.schedule.gradeSchedules?.['9']?.cycleDays).toEqual(draft.cycleDays);
    expect(updated.schedule.gradeSchedules?.['10']?.cycleDays).toEqual(draft.cycleDays);
    expect(f.service.workspace(f.student).review?.current).toEqual(updated.schedule);
    expect(() => f.service.updateSchool(f.student, { schoolId: f.school.id, expectedVersion: 1, schedule: draft, grades: ['11'] })).toThrow('changed');
    expect(() => f.service.updateSchool(f.student, { schoolId: f.school.id, expectedVersion: 2, schedule: draft, grades: [] })).toThrow();
  });
});
