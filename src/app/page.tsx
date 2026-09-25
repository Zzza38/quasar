import { Tracker } from '@/components/tracker';
import { initialBoot, queryOf, type SearchParams } from './boot';

// Rendered per request: the session cookie decides between the landing page and the signed-in workspace (see boot.ts).
export const dynamic = 'force-dynamic';

/** Today lives at `/`; the other views are served by [view]/page.tsx. */
export default async function HomePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return <Tracker initial={await initialBoot(params)} initialRoute={{ view: 'today', query: queryOf(params) }} />;
}
