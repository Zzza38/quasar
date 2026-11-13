import { describe, expect, it } from 'vitest';
import { assignmentTask, matchSectionClass, schoologyItemKey, schoologyItemUrl, turnedIn } from './schoology';

const classes = [
  { id: 'english', name: 'Foundations in Literature: Inquiry and Analysis' },
  { id: 'spanish', name: 'Honors Spanish 2' },
  { id: 'algebra2', name: 'Algebra II' },
  { id: 'algebra1', name: 'Algebra I' },
  { id: 'free', name: 'Free Period' },
];

describe('schoologyItemKey', () => {
  it('reads the assignment or event from the iCal URL, then the description link', () => {
    expect(schoologyItemKey({ notes: '', imported: { url: 'https://fa.schoology.com/assignment/8621095578' } })).toBe('assignment:8621095578');
    expect(schoologyItemKey({ notes: 'Read ch. 4\n - Link: http://fa.schoology.com/event/123', imported: { url: null } })).toBe('event:123');
    expect(schoologyItemKey({ notes: 'https://docs.example/assignment/5', imported: null })).toBeNull();
    expect(schoologyItemKey({ notes: '' })).toBeNull();
  });
});

describe('schoologyItemUrl', () => {
  it('opens calendar metadata, description-only imports, and direct API imports', () => {
    expect(schoologyItemUrl({ imported: { url: 'https://fa.schoology.com/assignment/123' } })).toBe('https://fa.schoology.com/assignment/123');
    expect(schoologyItemUrl({ imported: { url: null }, notes: 'Read chapter 4\n - Link: http://fa.schoology.com/assignment/456' })).toBe('https://fa.schoology.com/assignment/456');
    expect(schoologyItemUrl({ notes: 'See (https://fa.schoology.com/event/789).' })).toBe('https://fa.schoology.com/event/789');
    expect(schoologyItemUrl({ notes: '' }, 'sgy_123')).toBe('https://app.schoology.com/assignment/123');
    expect(schoologyItemUrl({ notes: 'Review https://fa.schoology.com/assignment/10\n - Link: https://fa.schoology.com/assignment/456' })).toBe('https://fa.schoology.com/assignment/456');
    expect(schoologyItemUrl({ notes: 'Review https://fa.schoology.com/assignment/10' }, 'sgy_123')).toBe('https://app.schoology.com/assignment/123');
  });
  it('rejects lookalike hosts, credentials, invalid item paths, and unrelated task ids', () => {
    for (const url of ['https://evil.schoology.com.example/assignment/123', 'https://notschoology.com/assignment/123', 'https://user:secret@schoology.com/assignment/123', 'javascript:alert(1)', 'https://fa.schoology.com/assignment/123oops']) {
      expect(schoologyItemUrl({ imported: { url } })).toBeNull();
    }
    expect(schoologyItemUrl({ notes: '' }, 'other_123')).toBeNull();
  });
});

describe('matchSectionClass', () => {
  it('matches the course or section title by its words', () => {
    expect(matchSectionClass({ courseTitle: 'Honors Spanish 2', sectionTitle: 'Honors Spanish 2 A block' }, classes)).toBe('spanish');
    expect(matchSectionClass({ courseTitle: 'Spanish 2 Honors', sectionTitle: '' }, classes)).toBe('spanish');
  });

  it('drops a trailing section label only when nothing matched as written', () => {
    expect(matchSectionClass({ courseTitle: 'English 9: The Self and Society', sectionTitle: 'Foundations in Literature: Inquiry and Analysis E' }, classes)).toBe('english');
    // "Algebra II" is a class as written, so its last I is never taken for a section letter.
    expect(matchSectionClass({ courseTitle: 'Algebra II', sectionTitle: 'Algebra II B' }, classes)).toBe('algebra2');
    expect(matchSectionClass({ courseTitle: 'Algebra II', sectionTitle: 'Section 3' }, [{ id: 'algebra1', name: 'Algebra I' }])).toBeNull();
  });

  it('gives no class when two classes match, or none does', () => {
    expect(matchSectionClass({ courseTitle: 'Biology', sectionTitle: '' }, [{ id: 'a', name: 'Biology' }, { id: 'b', name: 'biology' }])).toBeNull();
    expect(matchSectionClass({ courseTitle: 'Chemistry', sectionTitle: 'Chemistry A' }, classes)).toBeNull();
    expect(matchSectionClass({ courseTitle: 'Free Period', sectionTitle: '' }, classes)).toBeNull();
    expect(matchSectionClass({ courseTitle: '', sectionTitle: '' }, classes)).toBeNull();
  });
});

describe('assignmentTask', () => {
  const recent = String(Date.parse('2026-10-29T12:00:00Z') / 1000);
  const base = { id: 601, title: '  Lab   report ', description: '<p>Bring goggles&nbsp;&amp; gloves</p>', web_url: 'https://fa.schoology.com/assignment/601', published: '1', last_updated: recent };
  it('turns an assignment into task fields with the feed-style link', () => {
    expect(assignmentTask({ ...base, due: '2026-10-31 23:59:00' }, '2026-10-30')).toEqual({
      title: 'Lab report', dueDate: '2026-10-31', dueTime: '23:59', notes: 'Bring goggles & gloves\n - Link: https://fa.schoology.com/assignment/601' });
    expect(schoologyItemKey({ notes: assignmentTask({ ...base, due: '' }, '2026-10-30')!.notes })).toBe('assignment:601');
    expect(assignmentTask({ ...base, due: '2026-11-03 00:00:00' }, '2026-10-30')).toMatchObject({ dueDate: '2026-11-03', dueTime: null });
    expect(assignmentTask({ ...base, due: '', title: '', description: '', web_url: 'javascript:alert(1)' }, '2026-10-30'))
      .toEqual({ title: 'Untitled assignment', dueDate: null, dueTime: null, notes: ' - Link: https://app.schoology.com/assignment/601' });
  });
  it('leaves out old, far-off and unpublished assignments', () => {
    expect(assignmentTask({ ...base, due: '2026-10-16 08:00:00' }, '2026-10-30')).not.toBeNull();
    expect(assignmentTask({ ...base, due: '2026-10-15 08:00:00' }, '2026-10-30')).toBeNull();
    expect(assignmentTask({ ...base, due: '2027-12-01 08:00:00' }, '2026-10-30')).toBeNull();
    expect(assignmentTask({ ...base, due: '', published: 0 }, '2026-10-30')).toBeNull();
    expect(assignmentTask({ ...base, id: 'x', due: '' }, '2026-10-30')).toBeNull();
    // Undated: only while Schoology changed it in the last two weeks.
    expect(assignmentTask({ ...base, due: '', last_updated: String(Date.parse('2026-09-24T12:00:00Z') / 1000) }, '2026-10-30')).toBeNull();
    expect(assignmentTask({ ...base, due: '', last_updated: undefined }, '2026-10-30')).toBeNull();
  });
});

describe('turnedIn', () => {
  it('counts a non-draft revision only', () => {
    expect(turnedIn({ revision: [{ draft: '1' }] })).toBe(false);
    expect(turnedIn({ revision: [{ draft: 1 }, { draft: 0 }] })).toBe(true);
    expect(turnedIn({ revision: [] })).toBe(false);
    expect(turnedIn(null)).toBe(false);
  });
});
