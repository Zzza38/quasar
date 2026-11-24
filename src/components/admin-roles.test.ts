import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { staffAccess } from '@/domain/staff';
import { Admin, type AdminBoot } from './admin';
import { AdminRoleGrants } from './admin-role-grants';
import { AdminRoles } from './admin-roles';

describe('staff console presentation', () => {
  const beta = { key: 'staff-roles', name: 'Staff roles', description: '', public: false, joinedAt: '2026-01-01T00:00:00Z' };
  const schoolManager = { ...staffAccess('school-manager')!, schoolId: 'school-1', schoolName: 'Harbor High' };

  it('shows managers their assigned school and school actions', () => {
    const html = renderToStaticMarkup(createElement(AdminRoles, { access: schoolManager }));
    expect(html).toContain('Harbor High');
    expect(html).toContain('Review school member reports');
    expect(html).not.toContain('Open a member record');
    expect(html).not.toContain('Global chat posts');
  });

  it('gives the owner an assignment control while staff see their own capabilities', () => {
    const controls = renderToStaticMarkup(createElement(AdminRoleGrants, { accountId: 'owner', schools: [], onAccessLost: async () => false }));
    expect(controls).toContain('>Assigned roles<');
    expect(controls).toContain('Assign a role</button>');
    const staff = renderToStaticMarkup(createElement(AdminRoles, { access: schoolManager }));
    expect(staff).not.toContain('Assign a role');
  });

  it('shows managers school tools and hides shared guide and owner tools', () => {
    const initial: AdminBoot = { accountId: 'manager', isAdmin: false, staff: schoolManager, betas: [beta], adminReady: true };
    const html = renderToStaticMarkup(createElement(Admin, { initial }));
    expect(html).toContain('School Manager · Harbor High');
    expect(html).toContain('>People<');
    expect(html).toContain('>Schools<');
    expect(html).toContain('>School activity<');
    expect(html).not.toContain('>Setup guides<');
    expect(html).not.toContain('>Audit log<');
  });

  it('keeps the role catalog behind its beta', () => {
    const initial: AdminBoot = { accountId: 'owner', isAdmin: true, staff: staffAccess('owner'), betas: [], adminReady: true };
    expect(renderToStaticMarkup(createElement(Admin, { initial }))).not.toContain('>Staff roles<');
    expect(renderToStaticMarkup(createElement(Admin, { initial: { ...initial, betas: [beta] } }))).toContain('>Staff roles<');
  });
});
