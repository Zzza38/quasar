'use client';

import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar';

/**
 * A member's picture (docs/CHAT.md §13): their uploaded or Google picture when they have one, else a gradient
 * initial. One component for the chat list, bubbles, People, the profile sheet and the account controls.
 */

export const AVATAR_GRADIENT = 'linear-gradient(135deg, color-mix(in srgb, var(--primary) 75%, white) 0%, var(--primary) 60%, color-mix(in srgb, var(--primary) 70%, black) 100%)';
const SIZES = { xs: 'size-6 text-[10px]', sm: 'size-7 text-[11px]', md: 'size-10 text-sm', lg: 'size-14 text-xl', xl: 'size-24 text-3xl' } as const;
export type AvatarSize = keyof typeof SIZES;

/** The first character of a name (a whole emoji or other astral character counts as one), or "?". */
export function initialOf(name: string): string {
  return (Array.from(name.trim())[0] ?? '?').toUpperCase();
}

export function MemberAvatar({ name, src, size = 'md', muted, className, label }: { name: string; src?: string | null; size?: AvatarSize; muted?: boolean; className?: string;
  /** An accessible name, when the picture stands alone (a members list). Decorative otherwise. */
  label?: string }) {
  return <Avatar role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : 'true'} className={cn('shrink-0 ring-0', SIZES[size], className)}>
    {src && <AvatarImage src={src} alt="" referrerPolicy="no-referrer" draggable={false} />}
    <AvatarFallback delayMs={src ? 400 : 0} className={cn('font-extrabold', muted ? 'bg-muted text-muted-foreground' : 'text-primary-foreground')} style={muted ? undefined : { background: AVATAR_GRADIENT }}>{initialOf(name)}</AvatarFallback>
  </Avatar>;
}

/** A group's members as overlapping pictures (up to `max`), or the group icon when there is nobody to show. */
export function AvatarStack({ members, size = 'sm', max = 3, className }: { members: { id: string; displayName: string; avatar: string | null }[]; size?: 'xs' | 'sm' | 'md'; max?: number; className?: string }) {
  const shown = members.slice(0, max);
  if (!shown.length) return <span aria-hidden="true" className={cn('grid shrink-0 place-items-center rounded-full bg-primary-soft text-primary-soft-foreground', SIZES[size], className)}><Icon name="users" size={size === 'md' ? 18 : 14} /></span>;
  return <span aria-hidden="true" className={cn('flex shrink-0 -space-x-2', className)}>
    {shown.map((member) => <MemberAvatar key={member.id} name={member.displayName} src={member.avatar} size={size} className="ring-2 ring-background" />)}
  </span>;
}
