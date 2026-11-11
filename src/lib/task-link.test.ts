import { describe, expect, it } from 'vitest';
import { taskLink } from './task-link';

describe('task links', () => {
  it('opens an assignment URL in notes without surrounding prose or Markdown', () => {
    expect(taskLink({ notes: 'Complete [the assignment](https://school.example/assignment/42).' })).toBe('https://school.example/assignment/42');
    expect(taskLink({ notes: 'Read https://school.example/lesson_(2).' })).toBe('https://school.example/lesson_(2)');
    expect(taskLink({ notes: 'Open https://school.example/task?a=1&b=2 then https://other.example' })).toBe('https://school.example/task?a=1&b=2');
  });

  it('keeps the imported source link ahead of links in notes', () => {
    expect(taskLink({ notes: 'https://notes.example', imported: { url: 'https://calendar.example' } })).toBe('https://calendar.example');
  });

  it('does not create a shortcut for plain notes or unsafe schemes', () => {
    for (const notes of ['', 'Read chapter 3', 'javascript:alert(1)', 'file:///tmp/homework', 'https://']) {
      expect(taskLink({ notes })).toBeNull();
    }
  });
});
