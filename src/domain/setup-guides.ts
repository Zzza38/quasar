import { z } from 'zod';

/**
 * The setup guides support can edit (/admin → Setup guides). There are two kinds: where students get the iCal link
 * that brings homework in as tasks (src/components/setup-guide.tsx), and where they get a copy of their class
 * schedule to import (src/components/schedule-sources.tsx). For each kind support picks which platforms a school uses
 * (none picked shows them all), and can reword any guide and add screenshots, either for every school or for one. A
 * school's own guide wins over the one every school shares, which wins over the built-in one below.
 */
export const GUIDE_KINDS = ['calendar', 'schedule'] as const;
export type GuideKind = (typeof GUIDE_KINDS)[number];

export const FEED_PLATFORMS = ['schoology', 'classroom', 'canvas', 'other'] as const;
export type FeedPlatform = (typeof FEED_PLATFORMS)[number];
export const SCHEDULE_PLATFORMS = ['veracross', 'blackbaud', 'powerschool', 'infinite-campus', 'skyward', 'aspen', 'other'] as const;
export type SchedulePlatform = (typeof SCHEDULE_PLATFORMS)[number];

/** Step text and the note use the chat markdown subset (src/domain/markdown.ts): `**bold**`, `_italic_`, `` `code` ``. */
export const GUIDE_LIMITS = { steps: 12, text: 600, note: 600, name: 40 } as const;
export const guideStepSchema = z.object({
  text: z.string().trim().min(1, 'Write something for every step, or remove the empty one.').max(GUIDE_LIMITS.text),
  image: z.uuid().optional(),
});
export const setupGuideSchema = z.object({
  /** Replaces the platform's name on its tab, e.g. "Blackbaud" for a school whose "Something else" guide is its own. */
  name: z.string().trim().max(GUIDE_LIMITS.name).optional(),
  steps: z.array(guideStepSchema).min(1, 'A guide needs at least one step.').max(GUIDE_LIMITS.steps),
  note: z.string().trim().max(GUIDE_LIMITS.note),
});
export type GuideStep = z.infer<typeof guideStepSchema>;
export type SetupGuide = z.infer<typeof setupGuideSchema>;

/** What a student's workspace carries for one kind: the platforms their school uses (empty when support has not said) and every guide, resolved for that school. */
export type GuideSet = { platforms: string[]; guides: Record<string, SetupGuide> };

const DEFAULT_CALENDAR_GUIDES: Record<FeedPlatform, SetupGuide> = {
  schoology: {
    steps: [
      { text: 'Open Schoology in a **web browser** and sign in. The Schoology app can’t do this part.' },
      { text: 'Click **Calendar** at the top of the page.' },
      { text: 'Scroll to the very bottom of the calendar and click **Export**.' },
      { text: 'Pick **Share Calendar**, not Download Calendar. A link shows up.' },
      { text: 'Copy the whole link and paste it here. It covers all your classes.' },
    ],
    note: 'Only assignments with a due date come through. If a class never shows up, its teacher hasn’t set due dates in Schoology.',
  },
  classroom: {
    steps: [
      { text: 'Open **Google Calendar** on a computer, signed in with your school account.' },
      { text: 'In the calendar list on the left, find a class. Click the three dots next to it, then **Settings and sharing**.' },
      { text: 'Scroll down to **Secret address in iCal format** and copy it.' },
      { text: 'Paste it here. Every class has its own calendar, so repeat this for each one.' },
    ],
    note: 'No secret address? Your school turned it off. Ask your teacher or the school’s IT office.',
  },
  canvas: {
    steps: [
      { text: 'Open Canvas in a web browser and click **Calendar** in the menu on the left.' },
      { text: 'Click **Calendar Feed** in the bottom right corner.' },
      { text: 'Copy the link and paste it here.' },
    ],
    note: '',
  },
  other: {
    steps: [
      { text: 'Open the calendar in your school portal. Look for a button called **Export**, **Subscribe**, **Calendar feed** or **iCal**.' },
      { text: 'Copy the link it gives you. It usually ends in `.ics` or starts with `webcal://`. Both work.' },
    ],
    note: 'A downloaded .ics file won’t work. Quasar needs the link so it can keep checking for new homework.',
  },
};

const DEFAULT_SCHEDULE_GUIDES: Record<SchedulePlatform | 'veracross-sync', SetupGuide> = {
  veracross: {
    steps: [
      { text: 'Open your school’s **Veracross portal** in a web browser and sign in.' },
      { text: 'Open your schedule. It’s usually a tile on the home page, like **10-Day Schedule**. No tile? Go to **Classes & Reports** and click **Current Class Schedule**.' },
      { text: 'It opens as a PDF. Download it and upload it here.' },
    ],
    note: '',
  },
  blackbaud: {
    steps: [
      { text: 'Open your school’s Blackbaud portal in a web browser. The address usually ends in **myschoolapp.com**.' },
      { text: 'Click **My Day**, then **Schedule**. Parents pick their kid first, then **Schedule**.' },
      { text: 'Show a full week, or your whole rotation if it’s longer. Print the page, pick **Save as PDF** and upload it here.' },
    ],
    note: '',
  },
  powerschool: {
    steps: [
      { text: 'Open PowerSchool in a web browser. The app can’t do this part.' },
      { text: 'Click **My Schedule**, then the **Matrix** tab.' },
      { text: 'Click the **printer icon** in the top right, pick **Save as PDF** and upload it here.' },
    ],
    note: '',
  },
  'infinite-campus': {
    steps: [
      { text: 'Sign in to **Campus Student** or **Campus Parent**.' },
      { text: 'Open **Documents** in the menu (sometimes it’s under **More**) and click **Student Schedule**.' },
      { text: 'Download the PDF and upload it here. The Schedule page itself has no print button, so use Documents.' },
    ],
    note: '',
  },
  skyward: {
    steps: [
      { text: 'Sign in to Skyward **Family Access** or **Student Access**.' },
      { text: 'Click **Schedule**.' },
      { text: 'Click **Print Schedule**, pick **Save as PDF** and upload it here.' },
    ],
    note: '',
  },
  aspen: {
    steps: [
      { text: 'Sign in to Aspen in a web browser.' },
      { text: 'Go to **My Info**, then **Schedule**, and switch to **Matrix**.' },
      { text: 'Print the page, pick **Save as PDF** and upload it here.' },
    ],
    note: '',
  },
  other: {
    steps: [
      { text: 'Find your schedule in your school portal.' },
      { text: 'If there’s a download or PDF button, use it. If not, print the page and pick **Save as PDF**.' },
      { text: 'A screenshot works too, or a straight-on photo of a printed copy.' },
    ],
    note: '',
  },
  'veracross-sync': {
    steps: [
      { text: 'Open your school’s **Veracross portal** in a web browser on a computer. The app can’t do this part.' },
      { text: 'Click **Calendar** at the top, then **Calendar Subscriptions**. Some schools call it **My Calendar Subscriptions**, or have a **Subscribe** button on the calendar page.' },
      { text: 'If **Subscribe using Google Calendar** is checked, uncheck it.' },
      { text: 'Find **Class Schedule**, not Class Assignments. Right-click its **Subscribe** button and pick **Copy Link**. On a phone, press and hold it instead.' },
      { text: 'Paste the link here. It starts with `webcal://` or `https://`.' },
    ],
    note: 'No Calendar Subscriptions? Your school may have turned it off. Ask the tech office.',
  },
};

/**
 * Each kind's platforms in the order students see them, their names, and the built-in guides. `extras` are guides
 * that go with a platform without being one, shown wherever that platform is: the Veracross sync steps are in
 * Connect Veracross, not a tab of their own.
 */
export const GUIDES: Record<GuideKind, {
  label: string; platforms: readonly string[]; extras: Record<string, string>; names: Record<string, string>; defaults: Record<string, SetupGuide>;
}> = {
  calendar: {
    label: 'Homework calendar',
    platforms: FEED_PLATFORMS,
    extras: {},
    names: { schoology: 'Schoology', classroom: 'Google Classroom', canvas: 'Canvas', other: 'Something else' },
    defaults: DEFAULT_CALENDAR_GUIDES,
  },
  schedule: {
    label: 'Class schedule',
    platforms: SCHEDULE_PLATFORMS,
    extras: { 'veracross-sync': 'veracross' },
    names: { veracross: 'Veracross', blackbaud: 'Blackbaud', powerschool: 'PowerSchool', 'infinite-campus': 'Infinite Campus', skyward: 'Skyward', aspen: 'Aspen', other: 'Something else', 'veracross-sync': 'Veracross sync' },
    defaults: DEFAULT_SCHEDULE_GUIDES,
  },
};

/** Every guide of a kind support can edit: its platforms, then their extras. */
export const guideKeys = (kind: GuideKind): string[] => [...GUIDES[kind].platforms, ...Object.keys(GUIDES[kind].extras)];
/** `list` kept to the kind's platforms, in their order and without repeats. */
export const knownPlatforms = (kind: GuideKind, list: readonly string[]): string[] => GUIDES[kind].platforms.filter((platform) => list.includes(platform));

export const DEFAULT_GUIDE_SETS: Record<GuideKind, GuideSet> = {
  calendar: { platforms: [], guides: DEFAULT_CALENDAR_GUIDES },
  schedule: { platforms: [], guides: DEFAULT_SCHEDULE_GUIDES },
};

/** The label a guide goes by: its own name when support gave it one. */
export function guideName(kind: GuideKind, platform: string, guide: SetupGuide | undefined): string {
  return guide?.name || GUIDES[kind].names[platform] || platform;
}

/**
 * The school's platforms for a sentence ("Schoology or Canvas"), or '' when support hasn't picked any. An unnamed
 * "Something else" is left out, since it is not a name.
 */
export function platformNames(kind: GuideKind, set: GuideSet | undefined): string {
  const names = (set?.platforms ?? []).filter((platform) => platform !== 'other' || set!.guides[platform]?.name).map((platform) => guideName(kind, platform, set!.guides[platform]));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0] ?? '';
}

/** Where a guide screenshot is served (src/app/api/guide-images). */
export const guideImageUrl = (id: string) => `/api/guide-images/${id}`;

/** The image ids a guide shows, for keeping uploads that are still in use. */
export function guideImages(guide: SetupGuide): string[] {
  return guide.steps.flatMap((step) => step.image ? [step.image] : []);
}
