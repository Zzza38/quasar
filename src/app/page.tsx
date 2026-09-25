import type { Metadata } from 'next';
import { Tracker } from '@/components/tracker';
import { SITE_TITLE, structuredData } from '@/server/site';
import { initialBoot, queryOf, type SearchParams } from './boot';

// Rendered per request: the session cookie decides between the landing page and the signed-in workspace (see boot.ts).
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: SITE_TITLE };

/** Today lives at `/`; the other views are served by [view]/page.tsx. */
export default async function HomePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const initial = await initialBoot(params);
  return <>
    {/* Crawlers only ever see the signed-out page, so that is the one that describes the app to them. The JSON is
        static and "<" is escaped so no value could ever close the script element. */}
    {initial.kind === 'signed-out' && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData()).replaceAll('<', '\\u003c') }} />}
    <Tracker initial={initial} initialRoute={{ view: 'today', query: queryOf(params) }} />
  </>;
}
