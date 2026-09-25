import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/server/site';

// Read per request so the addresses follow the running deployment's NEXTAUTH_URL, not the build machine's.
export const dynamic = 'force-dynamic';

/**
 * The two public pages. The view paths (/schedule, /tasks, …) show the same landing page to a visitor without a
 * session and declare / as their canonical address, so listing them would only give crawlers duplicates.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  return [
    { url: `${origin}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${origin}/help`, changeFrequency: 'monthly', priority: 0.6 },
  ];
}
