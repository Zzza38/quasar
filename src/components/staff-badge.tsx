import { STAFF_LABELS, type StaffRank } from '@/domain/staff';

export function StaffBadge({ rank }: { rank?: StaffRank | null }) {
  if (!rank) return null;
  return <span className="ml-1.5 inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-primary-soft px-1.5 align-[1px] text-[10px] font-semibold leading-4 text-primary-soft-foreground ring-1 ring-inset ring-primary/15">{STAFF_LABELS[rank]}</span>;
}
