/**
 * What search engines and link previews are told about the site. The origin comes from NEXTAUTH_URL, the one
 * address the app already treats as its own (sign-in callbacks, the API's origin check), so canonical links,
 * the sitemap and Open Graph URLs never name a host the deployment does not answer on.
 */

import type { Metadata } from 'next';

export const SITE_NAME = 'Quasar';

/** The home page's title: the brand plus what the app is, since "Quasar" alone is an astronomy word to a search engine. */
export const SITE_TITLE = 'Quasar: free school schedule and homework app for students';

export const SITE_DESCRIPTION = 'Free school schedule and homework app for students. Handles rotating cycle days, snow days, two-hour delays and lunch waves. Works offline, no ads.';

export const SITE_KEYWORDS = ['school schedule app', 'rotating schedule', 'cycle day tracker', 'bell schedule', 'homework planner', 'student planner', 'block schedule', 'lunch waves', 'snow day schedule', 'offline school app'];

/** The link-preview card (1200×630, public/brand/og.png): the landing page's headline next to its Today card. */
const OG_IMAGE = { url: '/brand/og.png', width: 1200, height: 630, alt: 'Quasar: the schedule app for schools that can’t make up their mind. A Today card shows 14:32 left in Chemistry on cycle day 4 of 8.' };

/** Open Graph and Twitter card tags for one page, resolved against metadataBase; every page shares the one preview image. */
export function socialMetadata(page: { path: string; title: string; description: string }): Pick<Metadata, 'openGraph' | 'twitter'> {
  return {
    openGraph: { type: 'website', siteName: SITE_NAME, locale: 'en_US', url: page.path, title: page.title, description: page.description, images: [OG_IMAGE] },
    twitter: { card: 'summary_large_image', title: page.title, description: page.description, images: [OG_IMAGE] },
  };
}

const LOCAL_ORIGIN = 'http://localhost:3000';

/** The public origin of this deployment (no trailing slash); localhost when NEXTAUTH_URL is unset or malformed. */
export function siteOrigin(): string {
  const configured = process.env.NEXTAUTH_URL;
  if (!configured) return LOCAL_ORIGIN;
  try { return new URL(configured).origin; } catch { return LOCAL_ORIGIN; }
}

/** schema.org description of the app for the signed-out home page, so search results can label it as free education software. */
export function structuredData(): Record<string, unknown> {
  const origin = siteOrigin();
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    url: origin,
    description: SITE_DESCRIPTION,
    applicationCategory: 'EducationalApplication',
    operatingSystem: 'Web',
    browserRequirements: 'Requires a modern browser with JavaScript',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    featureList: ['Rotating cycle-day schedules', 'Snow days, delays and replacement days', 'Lunch waves', 'Tasks with due dates and reminders', 'Calendar feed import', 'Works offline'],
    image: `${origin}/brand/icon-512.png`,
  };
}
