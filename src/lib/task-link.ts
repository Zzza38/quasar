import type { Task } from '@/domain/task';

/** Prefer the calendar's source URL, then the first web link in the notes. */
export function taskLink(task: Pick<Task, 'notes'> & { imported?: Pick<NonNullable<Task['imported']>, 'url'> | null }): string | null {
  if (task.imported?.url) return task.imported.url;
  for (const match of task.notes.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    let candidate = match[0].replace(/[.,;:!?]+$/, '');
    // A closing bracket can belong to prose or Markdown, but also to the URL itself.
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (candidate.endsWith(close) && candidate.split(close).length > candidate.split(open).length) {
        candidate = candidate.slice(0, -1);
      }
    }
    try {
      const url = new URL(candidate);
      if (url.hostname) return candidate;
    } catch { /* Try the next link when this one is incomplete. */ }
  }
  return null;
}
