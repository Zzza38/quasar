'use client';

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { api } from '@/client/api';
import type { PersonalSchedule, StudentClass } from '@/domain/schedule';

/** A class to point at a directory entry. `name` guards against a rename that landed while the request was out. */
export type DirectoryLink = { id: string; directoryId: string; name?: string };

/** The schedule with these links applied, or null when nothing changes. */
export function applyDirectoryLinks(personal: PersonalSchedule, links: DirectoryLink[]): PersonalSchedule | null {
  let changed = false;
  const classes = personal.classes.map((cls) => {
    const link = links.find(entry => entry.id === cls.id && (entry.name === undefined || entry.name === cls.name));
    if (!link || cls.directoryId === link.directoryId) return cls;
    changed = true;
    return { ...cls, directoryId: link.directoryId };
  });
  return changed ? { ...personal, classes } : null;
}

const signature = (accountId: string, cls: StudentClass) => JSON.stringify([accountId, cls.id, cls.name, cls.teacher ?? '', cls.room ?? '', cls.directoryId ?? '']);

/**
 * Publishes the student's unlinked classes to the school directory while online and links each to its entry, so
 * classmates who typed a class another way still match. A link is bookkeeping, not an edit, so it skips the schedule
 * lock prompt. Each class is sent once per spelling per session; failures stay quiet and retry after the next change.
 * Returns `link`, which applies links from elsewhere (a confirmed "same class") to the latest saved schedule.
 */
export function useDirectoryLinks({ accountId, schoolId, personal, readable, online, enabled, save }: {
  accountId: string; schoolId: string | undefined; personal: PersonalSchedule; readable: boolean; online: boolean;
  /** The class-links beta; without it nothing is published. */
  enabled: boolean;
  save: (next: PersonalSchedule) => Promise<void>;
}) {
  const latest = useRef({ personal, save });
  useLayoutEffect(() => { latest.current = { personal, save }; });
  const link = useCallback(async (links: DirectoryLink[]) => {
    const next = applyDirectoryLinks(latest.current.personal, links);
    if (next) await latest.current.save(next);
  }, []);
  const sent = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled || !online || !readable || !schoolId) return;
    // Linked classes go too, once per session: the server skips live links and relinks ones to a removed entry.
    const pending = personal.classes.filter(cls => cls.name.trim() && (cls.teacher?.trim() || cls.room?.trim()) && !sent.current.has(signature(accountId, cls)));
    if (!pending.length) return;
    // A short wait lets a burst of edits (an import, a sync) settle into one request.
    const timer = setTimeout(() => {
      const keys = pending.map(cls => signature(accountId, cls));
      for (const key of keys) sent.current.add(key);
      api.directory.publish.mutate({ accountId, schoolId, grade: personal.grade, classes: pending.map(({ id, name, teacher, room, directoryId }) => ({ id, name, teacher, room, directoryId })) })
        .then(({ links }) => link(links.map(entry => ({ ...entry, name: pending.find(cls => cls.id === entry.id)?.name }))))
        .catch(() => { for (const key of keys) sent.current.delete(key); });
    }, 1500);
    return () => clearTimeout(timer);
  }, [accountId, schoolId, personal, readable, online, enabled, link]);
  return link;
}
