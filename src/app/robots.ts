import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/server/site';

// Read per request so the sitemap address follows the running deployment's NEXTAUTH_URL, not the build machine's.
export const dynamic = 'force-dynamic';

/** Crawlers may read everything public; the API and the support page carry nothing worth listing. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/admin'] },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
