import { describe, expect, it } from 'vitest';
import { routeFromLocation, viewFromSegment, viewPath } from './routes';

const at = (pathname: string, search = '', hash = '') => routeFromLocation({ pathname, search, hash });

describe('view paths', () => {
  it('puts Today at the root and every other view at its own path, with the query after it', () => {
    expect(viewPath('today')).toBe('/');
    expect(viewPath('tasks')).toBe('/tasks');
    expect(viewPath('messages', { with: 'abc', room: '' })).toBe('/messages?with=abc&room=');
    expect(viewPath('classes', new URLSearchParams('private=open'))).toBe('/classes?private=open');
  });

  it('reads a path segment as a view and rejects anything else', () => {
    expect(viewFromSegment(undefined)).toBe('today');
    expect(viewFromSegment('today')).toBe('today');
    expect(viewFromSegment('people')).toBe('people');
    expect(viewFromSegment('admin')).toBeNull();
    expect(viewFromSegment('wp-login.php')).toBeNull();
  });

  it('reads the route from a browser address, unknown paths falling back to Today', () => {
    expect(at('/')).toEqual({ view: 'today', query: '', legacyHash: false });
    expect(at('/schedule', '?date=2026-09-25')).toEqual({ view: 'schedule', query: 'date=2026-09-25', legacyHash: false });
    expect(at('/somewhere-else')).toEqual({ view: 'today', query: '', legacyHash: false });
  });

  it('still understands the old #view addresses and flags them for rewriting, but not in-page anchors', () => {
    expect(at('/', '', '#classes?directory=open')).toEqual({ view: 'classes', query: 'directory=open', legacyHash: true });
    expect(at('/', '', '#/tasks')).toEqual({ view: 'tasks', query: '', legacyHash: true });
    expect(at('/tasks', '', '#main')).toEqual({ view: 'tasks', query: '', legacyHash: false });
    expect(at('/', '', '#conflicts')).toEqual({ view: 'today', query: '', legacyHash: false });
  });
});
