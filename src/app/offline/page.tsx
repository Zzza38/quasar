import type { Metadata } from 'next';
import { Tracker } from '@/components/tracker';

// The service worker serves this neutral shell when a navigation cannot reach the server.
// The client restores the last saved workspace from this device before showing a screen.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function OfflinePage() {
  return <Tracker initial={{ kind: 'none', renderedAt: 0 }} />;
}
