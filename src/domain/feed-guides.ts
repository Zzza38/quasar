import { z } from 'zod';

/**
 * Where students get the iCal link that brings homework in as tasks (src/components/feed-guide.tsx). Support picks
 * which of these a school uses (none picked shows them all), and can reword any guide and add screenshots, either for
 * every school on a platform or for one school. A school's own guide wins over the platform's, which wins over the
 * built-in one below.
 */
export const FEED_PLATFORMS = ['schoology', 'classroom', 'canvas', 'other'] as const;
export type FeedPlatform = (typeof FEED_PLATFORMS)[number];
export const FEED_PLATFORM_NAMES: Record<FeedPlatform, string> = { schoology: 'Schoology', classroom: 'Google Classroom', canvas: 'Canvas', other: 'Something else' };

/** Step text and the note use the chat markdown subset (src/domain/markdown.ts): `**bold**`, `_italic_`, `` `code` ``. */
export const GUIDE_LIMITS = { steps: 12, text: 600, note: 600, name: 40 } as const;
export const guideStepSchema = z.object({
  text: z.string().trim().min(1, 'Write something for every step, or remove the empty one.').max(GUIDE_LIMITS.text),
  image: z.uuid().optional(),
});
export const feedGuideSchema = z.object({
  /** Replaces the platform's name on its tab, e.g. "Blackbaud" for a school whose "Something else" guide is its own. */
  name: z.string().trim().max(GUIDE_LIMITS.name).optional(),
  steps: z.array(guideStepSchema).min(1, 'A guide needs at least one step.').max(GUIDE_LIMITS.steps),
  note: z.string().trim().max(GUIDE_LIMITS.note),
});
export type GuideStep = z.infer<typeof guideStepSchema>;
export type FeedGuide = z.infer<typeof feedGuideSchema>;
export const feedPlatformsSchema = z.array(z.enum(FEED_PLATFORMS)).max(FEED_PLATFORMS.length)
  .transform((platforms) => FEED_PLATFORMS.filter((platform) => platforms.includes(platform)));

/** What a student's workspace carries: the platforms their school uses (empty when support has not said) and every guide, resolved for that school. */
export type FeedGuides = { platforms: FeedPlatform[]; guides: Record<FeedPlatform, FeedGuide> };

export const DEFAULT_FEED_GUIDES: Record<FeedPlatform, FeedGuide> = {
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

export const DEFAULT_FEED_GUIDES_STATE: FeedGuides = { platforms: [], guides: DEFAULT_FEED_GUIDES };

/** The label a guide goes by: its own name when support gave it one. */
export function guideName(platform: FeedPlatform, guide: FeedGuide | undefined): string {
  return guide?.name || FEED_PLATFORM_NAMES[platform];
}

/**
 * The school's platforms for a sentence ("Schoology or Canvas"), or '' when support hasn't picked any. An unnamed
 * "Something else" is left out, since it is not a name.
 */
export function platformNames(guides: FeedGuides | undefined): string {
  const names = (guides?.platforms ?? []).filter((platform) => platform !== 'other' || guides!.guides[platform].name).map((platform) => guideName(platform, guides!.guides[platform]));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0] ?? '';
}

/** Where a guide screenshot is served (src/app/api/guide-images). */
export const guideImageUrl = (id: string) => `/api/guide-images/${id}`;

/** The image ids a guide shows, for keeping uploads that are still in use. */
export function guideImages(guide: FeedGuide): string[] {
  return guide.steps.flatMap((step) => step.image ? [step.image] : []);
}
