import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { ParentSummaryView } from '@/components/parent-summary-view';
import { getDb } from '@/server/db';
import { ParentSummaryService, type SummaryView } from '@/server/parent-summary';
import { Service } from '@/server/service';

// Read per request: the summary is live, every view is logged, and the link can be turned off at any moment.
export const dynamic = 'force-dynamic';

/**
 * The weekly parent summary (src/server/parent-summary.ts): public, no sign-in, read-only. next.config.ts adds
 * no-store, no-referrer and X-Robots-Tag for /summary/*, and robots.ts keeps crawlers out. The title and link preview
 * are generic on purpose, so a chat app's preview of the link shows no name.
 */
export const metadata: Metadata = {
  title: 'Weekly summary · Quasar',
  description: 'A private weekly summary shared from Quasar.',
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: 'no-referrer',
  alternates: null,
  openGraph: null,
  twitter: null,
};

const NOTICES: Record<Exclude<SummaryView['state'], 'ok'>, (name: string) => { title: string; body: string }> = {
  missing: () => ({ title: 'This link doesn’t work', body: 'It may have been turned off or replaced with a new one. Ask for the current link.' }),
  paused: (name) => ({ title: `${name}’s summary is paused`, body: `It comes back when Quasar AI Plus is active on ${name}’s account again.` }),
  limited: () => ({ title: 'Too many visits right now', body: 'Try again in a few minutes.' }),
};

export default async function SummaryPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = (await headers()).get('cf-connecting-ip')?.slice(0, 64) || null;
  const view = new ParentSummaryService(new Service(getDb())).view(token, { ip });
  const notice = view.state === 'ok' ? null : NOTICES[view.state](view.state === 'paused' ? view.firstName : '');
  return <main className="min-h-dvh bg-background px-4 pb-14 pt-8 text-foreground sm:pt-14">
    <div className="mx-auto grid w-full max-w-xl gap-6">
      <div>
        <img src="/brand/quasar-full.svg" alt="Quasar" className="h-7 w-auto dark:hidden" />
        <img src="/brand/quasar-full-dark.svg" alt="Quasar" className="hidden h-7 w-auto dark:block" />
      </div>
      {view.state === 'ok' ? <ParentSummaryView summary={view.summary} /> : <section className="grid gap-2 rounded-2xl bg-card p-5 ring-1 ring-inset ring-foreground/[0.06]">
        <h1 className="text-xl font-bold tracking-tight">{notice!.title}</h1>
        <p className="text-[14px] leading-relaxed text-muted-foreground">{notice!.body}</p>
      </section>}
    </div>
  </main>;
}
