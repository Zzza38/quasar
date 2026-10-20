import type { Metadata } from 'next';
import { ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'Quasar has moved',
  description: 'Quasar now lives at getquasarapp.com. Sign in with the same Google account to find your saved schedule and tasks.',
  alternates: { canonical: 'https://getquasarapp.com/' },
  robots: { index: false, follow: true },
};

export default function MovedPage() {
  return <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-16 text-foreground">
    <section className="w-full max-w-lg rounded-3xl border border-border bg-card p-8 shadow-sm sm:p-12" aria-labelledby="moved-title">
      <img src="/brand/quasar-full.svg" alt="Quasar" className="mb-12 h-9 w-auto dark:hidden" />
      <img src="/brand/quasar-full-dark.svg" alt="Quasar" className="mb-12 hidden h-9 w-auto dark:block" />
      <p className="mb-3 text-sm font-medium text-muted-foreground">A new address for your school day</p>
      <h1 id="moved-title" className="mb-5 text-4xl font-semibold tracking-tight">Quasar has moved.</h1>
      <p className="mb-3 leading-relaxed text-muted-foreground">Your schedule has a new home at <span className="font-medium text-foreground">getquasarapp.com</span>.</p>
      <p className="mb-8 leading-relaxed text-muted-foreground">Sign in with the same Google account. Your synced schedule, tasks, and account are still there.</p>
      <Button asChild size="lg" className="h-auto w-full whitespace-normal py-3">
        <a href="https://getquasarapp.com/">Open getquasarapp.com <ArrowUpRight aria-hidden="true" /></a>
      </Button>
      <p className="mt-6 text-sm leading-relaxed text-muted-foreground">Update your bookmark or reinstall Quasar from the new address. Turn on browser reminders again there.</p>
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">Edits that haven't synced stay in this browser at the old address. Keep its site data until those edits have been recovered.</p>
    </section>
  </main>;
}
