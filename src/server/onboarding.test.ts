import { describe, expect, it } from 'vitest';
import { suggestNames } from './service';

describe('name suggestions from the Google profile', () => {
  it('uses the first name for display and the whole name in full', () => {
    expect(suggestNames('Maya  Chen', 'maya.chen@example.com')).toEqual({ displayName: 'Maya', fullName: 'Maya Chen' });
  });
  it('falls back to the email when Google gave no name', () => {
    expect(suggestNames('', 'jordan.lee@example.com')).toEqual({ displayName: 'Jordan', fullName: '' });
    expect(suggestNames('   ', 'x@example.com')).toEqual({ displayName: 'X', fullName: '' });
  });
});

import { afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });

describe('feedback before a school is chosen', () => {
  it('reaches the support inbox without a school and shows the sender email', () => {
    const db = openDatabase(':memory:'); databases.push(db);
    const service = new Service(db, 'owner@example.com');
    const add = (email: string) => { const id = randomUUID(); db.prepare('INSERT INTO users(id,google_sub,email,google_name,created_at) VALUES(?,?,?,?,?)').run(id, id, email, 'Maya Chen', new Date().toISOString()); return id; };
    const owner = add('owner@example.com');
    const newcomer = add('maya@example.com');
    expect(service.user(newcomer).suggestedNames).toEqual({ displayName: 'Maya', fullName: 'Maya Chen' });
    expect(() => service.requestCorrection(newcomer, 'The rotation is off by one day.')).toThrow('Enter your display name and full name first.');
    // Feedback must work while the student is still on the names step.
    service.feedback(newcomer, 'I cannot find my school and the add flow asks for Day 1.');
    service.profile(newcomer, { displayName: 'Maya', fullName: 'Maya Chen' });
    expect(() => service.requestCorrection(newcomer, 'The rotation is off by one day.')).toThrow('Join a school first.');
    const requests = service.requests(owner);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ schoolId: null, schoolName: null, email: 'maya@example.com' });
  });
});
