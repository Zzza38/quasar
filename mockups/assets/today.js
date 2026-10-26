// Fake Today data and the timeline renderer shared by the five classmates-popup mockups.
// Each page calls Today.render({ chip, onOpen }) and builds its own popup in onOpen(period, chipEl).

const FRIENDS = {
  hunter: { name: 'Hunter Reyes', shared: 4, next: 'Free', nextRoom: 'Library' },
  liam:   { name: 'Liam Okafor', shared: 3, next: 'Chemistry', nextRoom: 'STU 2' },
  sofia:  { name: 'Sofia Marchetti', shared: 2, next: 'Chemistry', nextRoom: 'STU 2' },
  ava:    { name: 'Ava Lindqvist', shared: 5, next: 'Lunch', nextRoom: 'Dining hall' },
  noah:   { name: 'Noah Bauer', shared: 2, next: 'Lunch', nextRoom: 'Dining hall' },
  maya:   { name: 'Maya Chen', shared: 3, next: 'Spanish II', nextRoom: 'Room 204' },
  eli:    { name: 'Eli Brooks', shared: 1, next: 'Lunch', nextRoom: 'Dining hall' },
  jonah:  { name: 'Jonah Weiss', shared: 2, next: 'Free', nextRoom: 'Library' },
  priya:  { name: 'Priya Natarajan', shared: 4, next: 'Spanish II', nextRoom: 'Room 204' },
};

const PERIODS = [
  { id: 'adv', start: '8:00 AM', end: '8:10 AM', name: 'Advisory', color: '#64748b', detail: 'Room 112 · Rahul Patel', mates: [] },
  { id: 'chem', start: '8:15 AM', end: '9:00 AM', name: 'Chemistry', color: '#22c55e', detail: 'Block C (1, 4, 8) · STU 2 · Dana Whitfield', mates: ['liam'], past: true },
  { id: 'dd', start: '9:45 AM', end: '10:25 AM', name: 'Digital Design and Illustration I', color: '#db2777', block: 'Block G', room: 'STU 4', teacher: 'Amanda Fisk', detail: 'Block G (3, 6, 10) · STU 4 · Amanda Fisk', mates: ['hunter', 'liam', 'sofia'], now: true },
  { id: 'asm', start: '10:30 AM', end: '11:15 AM', name: 'Assembly / Clubs', color: '#94a3b8', detail: 'Meeting House', mates: [] },
  { id: 'eng', start: '11:20 AM', end: '12:05 PM', name: 'English 10', color: '#8b5cf6', block: 'Block B', room: 'Room 118', teacher: 'Marcus Hale', detail: 'Block B (2, 5, 9) · Room 118 · Marcus Hale', mates: ['ava', 'noah', 'maya', 'eli', 'jonah', 'priya', 'hunter'] },
  { id: 'lunch', start: '12:10 PM', end: '12:50 PM', name: 'Lunch', color: '#f59e0b', detail: 'Dining hall', mates: [] },
];

const ICONS = {
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  pin: '<path d="M20 10c0 4.99-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 14.99 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  chat: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
};

const Today = {
  FRIENDS, PERIODS,
  icon(name, size = 14, stroke = 2.2) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  },
  avatar(id, size = 'md', extra = '') {
    return `<span class="avatar av-${size} ${extra}" aria-hidden="true">${FRIENDS[id].name[0]}</span>`;
  },
  first(id) { return FRIENDS[id].name.split(' ')[0]; },
  together(id) { const n = FRIENDS[id].shared; return n === 1 ? 'Only this class together' : `${n} classes together`; },
  /** Same wording as withLabel() in src/lib/classmates.ts. */
  withLabel(ids) {
    const n = ids.map((id) => Today.first(id));
    if (n.length === 1) return `With ${n[0]}`;
    if (n.length === 2) return `With ${n[0]} and ${n[1]}`;
    return `With ${n[0]}, ${n[1]} and ${n.length - 2} more`;
  },
  defaultChip(period) {
    return `${Today.icon('users', 13, 2.4)}<span>${Today.withLabel(period.mates)}</span>`;
  },
  /** chip(period) returns the chip's inner HTML; onOpen(period, el) opens the page's popup. */
  render({ chip = Today.defaultChip, onOpen, autoOpen = 'dd' }) {
    const app = document.createElement('div');
    app.className = 'app';
    app.innerHTML = `<header><div><h1>Today</h1><p>Tuesday, October 27 · Day 6</p></div></header>
      <div class="card"><ol class="tl">${PERIODS.map((p) => `
        <li class="row ${p.now ? 'now' : ''}" data-row="${p.id}">
          <div class="time"><strong>${p.start}</strong><span>${p.end}</span></div>
          <div class="body"><span class="bar" style="background:${p.color};${p.past ? 'opacity:.4' : ''}"></span>
            <div class="main">
              <div class="title"><strong style="${p.past ? 'color:var(--muted-foreground)' : ''}">${p.name}</strong>
                ${p.now ? '<span class="chip now-chip">Now</span>' : ''}
                ${p.mates.length ? `<button type="button" class="chip" data-period="${p.id}" aria-haspopup="dialog" aria-expanded="false">${chip(p)}</button>` : ''}
              </div>
              <div class="hint">${p.detail}</div>
              <div class="slot" data-slot="${p.id}"></div>
            </div>
          </div>
        </li>`).join('')}</ol></div>
      <p class="note">Mockup · tap any "With …" chip</p>`;
    document.body.prepend(app);
    app.querySelectorAll('[data-period]').forEach((el) => el.addEventListener('click', (event) => {
      event.stopPropagation();
      onOpen(PERIODS.find((p) => p.id === el.dataset.period), el);
    }));
    if (autoOpen) setTimeout(() => app.querySelector(`[data-period="${autoOpen}"]`)?.click(), 30);
  },
  setExpanded(el) {
    document.querySelectorAll('[data-period]').forEach((chip) => chip.setAttribute('aria-expanded', String(chip === el)));
  },
};
window.Today = Today;
