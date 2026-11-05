import { describe, expect, it } from 'vitest';
import { dockGroup, dockTarget } from './phone-dock';

describe('phone dock', () => {
  it('groups School with Classes and Messages with People', () => {
    expect(dockGroup('school')).toBe('classes');
    expect(dockGroup('classes')).toBe('classes');
    expect(dockGroup('messages')).toBe('people');
    expect(dockGroup('people')).toBe('people');
    expect(dockGroup('today')).toBeNull();
  });

  it('opens the first view of a group by default', () => {
    expect(dockTarget('classes', {}, 0)).toBe('classes');
    expect(dockTarget('people', {}, 0)).toBe('messages');
  });

  it('reopens the view used last', () => {
    expect(dockTarget('classes', { classes: 'school' }, 0)).toBe('school');
    expect(dockTarget('people', { people: 'people' }, 0)).toBe('people');
  });

  it('sends the People tab to chats while any are unread', () => {
    expect(dockTarget('people', { people: 'people' }, 2)).toBe('messages');
    expect(dockTarget('classes', { classes: 'school' }, 2)).toBe('school');
  });

  it('ignores a remembered view from the wrong group', () => {
    expect(dockTarget('classes', { classes: 'today' }, 0)).toBe('classes');
  });
});
