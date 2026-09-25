import { notFound } from 'next/navigation';
import { Tracker } from '@/components/tracker';
import { viewFromSegment } from '@/lib/routes';
import { initialBoot, queryOf, type SearchParams } from '../boot';

// Rendered per request for the view the path names, with the session cookie deciding what fills it (see ../boot.ts).
export const dynamic = 'force-dynamic';

/** `/schedule`, `/tasks`, `/classes`, `/school`, `/people`, `/messages` (and `/today`, an alias of `/`). Anything else is a 404. */
export default async function ViewPage({ params, searchParams }: { params: Promise<{ view: string }>; searchParams: Promise<SearchParams> }) {
  const view = viewFromSegment((await params).view);
  if (!view) notFound();
  const query = await searchParams;
  return <Tracker initial={await initialBoot(query)} initialRoute={{ view, query: queryOf(query) }} />;
}
