import { describe, expect, it } from 'vitest';
import { emptyPersonalSchedule } from '@/domain/schedule';
import { applyDirectoryLinks } from './directory-links';

describe('applying directory links', () => {
  const personal = { ...emptyPersonalSchedule(), classes: [{ id: 'lit', name: 'Literature' }, { id: 'bio', name: 'Biology', directoryId: '00000000-0000-4000-8000-000000000001' }] };
  const id = '00000000-0000-4000-8000-000000000002';

  it('links only the named classes and skips a class renamed while the request was out', () => {
    expect(applyDirectoryLinks(personal, [{ id: 'lit', directoryId: id, name: 'Literature' }])?.classes[0]).toEqual({ id: 'lit', name: 'Literature', directoryId: id });
    expect(applyDirectoryLinks(personal, [{ id: 'lit', directoryId: id, name: 'English' }])).toBeNull();
  });

  it('returns null when nothing changes', () => {
    expect(applyDirectoryLinks(personal, [{ id: 'bio', directoryId: '00000000-0000-4000-8000-000000000001' }, { id: 'gone', directoryId: id }])).toBeNull();
  });
});
