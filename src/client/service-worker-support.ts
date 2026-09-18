/**
 * The service worker keeps Next's static bundles for offline use. Development
 * bundles are not content-addressed, so a cached copy goes stale on every edit
 * and hydration breaks. Only production registers the worker; development
 * removes any worker and cache a previous production build left behind.
 */
export const serviceWorkerEnabled = process.env.NODE_ENV === 'production';

export async function removeStaleWorkers(): Promise<void> {
  if (serviceWorkerEnabled || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
  await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
  if ('caches' in window) {
    const names = await caches.keys().catch(() => []);
    await Promise.all(names.filter((name) => name.startsWith('quasar-')).map((name) => caches.delete(name).catch(() => false)));
  }
}
