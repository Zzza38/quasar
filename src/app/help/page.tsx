import type { Metadata } from 'next';
import { Help } from '@/components/help';
import { socialMetadata } from '@/server/site';

// Rendered per request so the canonical and preview addresses follow the running deployment's NEXTAUTH_URL rather
// than the build machine's (a container image is built without it).
export const dynamic = 'force-dynamic';

const DESCRIPTION = 'Answers to common questions about Quasar: adding your school, working out the rotation day, fixing bell times, importing Schoology, Google Classroom or Canvas homework, offline use, reminders and privacy.';

export const metadata: Metadata = {
  title: 'Help',
  description: DESCRIPTION,
  alternates: { canonical: '/help' },
  ...socialMetadata({ path: '/help', title: 'Help · Quasar', description: DESCRIPTION }),
};

export default function HelpPage() {
  return <Help />;
}
