'use client';

import { useCallback, useEffect, useState, type ComponentProps } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { classSearchScore } from '@/domain/class-match';
import type { Grade } from '@/domain/schedule';
import { formatRoom } from '@/lib/format';
import { Autocomplete } from './primitives';

export type ClassDirectory = RouterOutput['directory']['list'];
export type DirectoryEntry = ClassDirectory['classes'][number];

/** Directory suggestions are only kept for the current school while online. */
export function useClassDirectory(schoolId: string, online: boolean) {
  const [directory, setDirectory] = useState<ClassDirectory | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    setDirectory(null); setError('');
    if (!online || !schoolId) return;
    let active = true;
    api.directory.list.query({ schoolId }).then(result => { if (active) setDirectory(result); }).catch(err => { if (active) setError(errorMessage(err)); });
    return () => { active = false; };
  }, [schoolId, online, revision]);
  return { directory, error, reload };
}

export function ClassNameInput({ entries, grade, onChoose, ...props }: Omit<ComponentProps<typeof Autocomplete>, 'options' | 'onSelect'> & {
  entries: DirectoryEntry[]; grade?: Grade; onChoose: (entry: DirectoryEntry) => void;
}) {
  const matches = entries.filter(entry => !grade || entry.grades.includes(grade))
    .map(entry => ({ entry, score: classSearchScore(props.value, entry.name) }))
    .filter((match): match is { entry: DirectoryEntry; score: number } => match.score !== null)
    .sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name)).slice(0, 8);
  return <Autocomplete {...props} options={matches.map(({ entry }) => ({ value: entry.id, label: entry.name,
    description: [entry.teacher, entry.room && formatRoom(entry.room), 'School directory'].filter(Boolean).join(' · '),
  }))} onSelect={id => { const entry = entries.find(entry => entry.id === id); if (entry) onChoose(entry); }} />;
}
