import { VIEWS, type View } from '@/components/app-state';

/** A view and its query string, as the server reads them from the address and the client keeps them in history. */
export interface Route { view: View; query: string }

/** The view a path segment names (`schedule` for `/schedule`; an empty segment or `today` is Today), or null. */
export function viewFromSegment(segment: string | undefined | null): View | null {
  if (!segment) return 'today';
  return VIEWS.find((entry) => entry.id === segment)?.id ?? null;
}

/** The address of a view: Today lives at `/`, every other view at `/<view>`, plus any query. */
export function viewPath(view: View, params?: URLSearchParams | Record<string, string>): string {
  const search = params ? new URLSearchParams(params).toString() : '';
  return `${view === 'today' ? '/' : `/${view}`}${search ? `?${search}` : ''}`;
}

/**
 * The route named by a browser address. Views used to live behind `#view?query` (bookmarks, installed shortcuts and
 * old links still carry that form), so a hash that names a view wins over the path; hashes that are only in-page
 * anchors (`#main`, `#conflicts`) are ignored. An unknown path is Today.
 */
export function routeFromLocation(location: { pathname: string; search: string; hash: string }): Route & { legacyHash: boolean } {
  const [name, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const fromHash = name ? viewFromSegment(name) : null;
  if (name && fromHash) return { view: fromHash, query, legacyHash: true };
  const segment = location.pathname.split('/').filter(Boolean)[0];
  return { view: viewFromSegment(segment) ?? 'today', query: location.search.replace(/^\?/, ''), legacyHash: false };
}
