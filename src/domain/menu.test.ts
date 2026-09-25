import { describe, expect, it } from 'vitest';
import { menuApiBase, menuChoiceName, menuPageUrl, menuWeekStart, parseMenuChoices, parseMenuSite, parseMenuWeek } from './menu';

describe('parseMenuSite', () => {
  it('reads the organisation and domain from any address on a Nutrislice or FLIK site', () => {
    expect(parseMenuSite('https://friendsacademy.flikisdining.com/')).toEqual({ org: 'friendsacademy', domain: 'flikisdining.com' });
    expect(parseMenuSite('friendsacademy.flikisdining.com/m')).toEqual({ org: 'friendsacademy', domain: 'flikisdining.com' });
    expect(parseMenuSite('HTTPS://Friends-Seminary.Nutrislice.com/menu/friends-seminary-school/lunch/2026-09-22')).toEqual({ org: 'friends-seminary', domain: 'nutrislice.com', school: 'friends-seminary-school', menu: 'lunch' });
    // The API host names the same site.
    expect(parseMenuSite('https://district.api.nutrislice.com/menu/api/schools/')).toEqual({ org: 'district', domain: 'nutrislice.com' });
  });
  it('rejects anything that is not a supported menu site', () => {
    for (const bad of ['https://example.com/menu/x/lunch', 'https://nutrislice.com/', 'https://www.nutrislice.com/menu/a/b', 'https://evil.com/?u=friendsacademy.nutrislice.com', 'not a url at all', 'https://a_b.nutrislice.com/']) {
      expect(() => parseMenuSite(bad), bad).toThrow(/Nutrislice/);
    }
  });
  it('builds the API base and the page students open', () => {
    const source = { org: 'friendsacademy', domain: 'flikisdining.com' as const, school: 'friends-academy', menu: 'lunch', name: 'MS/US Lunch' };
    expect(menuApiBase(source)).toBe('https://friendsacademy.api.flikisdining.com');
    expect(menuPageUrl(source)).toBe('https://friendsacademy.flikisdining.com/menu/friends-academy/lunch');
  });
});

describe('menuWeekStart', () => {
  it('is the Sunday that starts the provider week', () => {
    expect(menuWeekStart('2026-09-25')).toBe('2026-09-20'); // Friday
    expect(menuWeekStart('2026-09-20')).toBe('2026-09-20'); // Sunday
    expect(menuWeekStart('2026-09-21')).toBe('2026-09-20'); // Monday
    expect(menuWeekStart('2026-09-26')).toBe('2026-09-20'); // Saturday
  });
});

const food = (name: string) => ({ position: 1, is_section_title: false, text: '', food: { name } });
const section = (text: string) => ({ position: 0, is_section_title: true, text, food: null });

describe('parseMenuWeek', () => {
  it('groups each day’s foods under their station titles and keeps holiday notes', () => {
    const days = parseMenuWeek({ days: [
      { date: '2026-09-22', menu_items: [section('Soup'), food('Mushroom Barley'), section('Entree'), food('Chipotle Chicken Bowl, Rice, Beans'), food(' Sauteed  Spinach '), food('Chipotle Chicken Bowl, Rice, Beans'), section('Grill'), section('Empty station')] },
      { date: '2026-09-21', menu_items: [{ position: 0, is_section_title: false, text: 'Yom Kippur', is_holiday: true, food: null }] },
      { date: '2026-09-20', menu_items: [] },
      { date: '2026-09-23', menu_items: [{ position: 0, text: '', food: null }, food('Pizza'), section('Soup'), food('Avgolemono')] },
    ] });
    expect(days).toEqual([
      { date: '2026-09-20', notes: [], sections: [] },
      { date: '2026-09-21', notes: ['Yom Kippur'], sections: [] },
      { date: '2026-09-22', notes: [], sections: [{ title: 'Soup', items: ['Mushroom Barley'] }, { title: 'Entree', items: ['Chipotle Chicken Bowl, Rice, Beans', 'Sauteed Spinach'] }] },
      // Foods before any station go in an untitled section.
      { date: '2026-09-23', notes: [], sections: [{ title: '', items: ['Pizza'] }, { title: 'Soup', items: ['Avgolemono'] }] },
    ]);
  });
  it('tolerates missing item lists and skips days without a date, and refuses other shapes', () => {
    expect(parseMenuWeek({ days: [{ date: '2026-09-22' }, { date: 'soon', menu_items: [food('x')] }] })).toEqual([{ date: '2026-09-22', notes: [], sections: [] }]);
    expect(() => parseMenuWeek({ weeks: [] })).toThrow(/form Quasar does not understand/);
    expect(() => parseMenuWeek('<html>')).toThrow(/form Quasar does not understand/);
  });
  it('caps runaway payloads', () => {
    const items = Array.from({ length: 500 }, (_, index) => food(`Item ${index}`));
    const [day] = parseMenuWeek({ days: [{ date: '2026-09-22', menu_items: items }] });
    expect(day.sections[0].items).toHaveLength(200);
  });
});

describe('parseMenuChoices', () => {
  it('lists every published menu type of every school page', () => {
    const choices = parseMenuChoices([
      { name: 'LS Lunch  Menu', slug: 'ls-lunch', active_menu_types: [{ name: 'Lunch', slug: 'lunch' }] },
      { name: 'MS/US Employee Lunch', slug: 'friends-academy', active_menu_types: [{ name: 'Lunch', slug: 'lunch' }, { name: 'Snack', slug: 'snack' }] },
      { name: 'Closed', slug: 'closed', active_menu_types: [] },
      { name: 'Odd', slug: 'Not A Slug', active_menu_types: [{ name: 'Lunch', slug: 'lunch' }] },
    ]);
    expect(choices).toEqual([
      { school: 'ls-lunch', schoolName: 'LS Lunch Menu', menu: 'lunch', menuName: 'Lunch' },
      { school: 'friends-academy', schoolName: 'MS/US Employee Lunch', menu: 'lunch', menuName: 'Lunch' },
      { school: 'friends-academy', schoolName: 'MS/US Employee Lunch', menu: 'snack', menuName: 'Snack' },
    ]);
    expect(menuChoiceName(choices[0])).toBe('LS Lunch Menu');
    expect(menuChoiceName(choices[2])).toBe('MS/US Employee Lunch · Snack');
    expect(() => parseMenuChoices({ schools: [] })).toThrow(/form Quasar does not understand/);
  });
});
