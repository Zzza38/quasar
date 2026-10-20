import { TRPCError } from '@trpc/server';
import { cycleDaySlots, effectiveSchedule, normalizePersonalSchedule, personalScheduleSchema, scheduleSchema, type Grade, type Schedule } from '@/domain/schedule';
import { CommunityService } from './community';
import type { Service } from './service';

export const MIN_SCHEDULE_SIGNAL_MEMBERS = 3;
export type ScheduleSignal = {
  cycleDayId: string; cycleDayLabel: string; slotId: string; periodLabel: string;
  start: string; end: string; count: number;
  draft: Schedule; summary: string;
};
export type ScheduleSignals = { baseVersion: number; grade: Grade | null; canPropose: boolean; signals: ScheduleSignal[] };

/** Only anonymous, thresholded timing changes leave this service. Personal class data never does. */
export class ScheduleSignalsService {
  constructor(private readonly service: Service) {}

  list(viewerId: string): ScheduleSignals {
    const viewer = this.service.ready(viewerId);
    if (!viewer.schoolId) throw new TRPCError({ code: 'FORBIDDEN', message: 'Join a school to see schedule suggestions.' });
    const school = this.service.school(viewer.schoolId);
    const own = this.service.entity(viewerId, 'personal');
    const personal = own && !own.deleted ? personalScheduleSchema.safeParse(own.data) : null;
    const grade = personal?.success ? personal.data.grade : undefined;
    const result: ScheduleSignals = {
      baseVersion: school.version, grade: grade ?? null,
      canPropose: (school.memberLocked || school.memberCount >= 10) && new CommunityService(this.service).isVerified(viewerId, school.id),
      signals: [],
    };
    if (!personal?.success || !grade || personal.data.customSchedule) return result;
    const { gradeSchedules: _variants, ...shared } = effectiveSchedule(school.schedule, { ...personal.data, periods: [] });
    const counts = new Map<string, { day: typeof shared.cycleDays[number]; slot: typeof shared.cycleDays[number]['slots'][number]; start: string; end: string; count: number }>();
    const rows = this.service.db.prepare(`SELECT e.data, u.reviewed_version FROM users u
      JOIN entities e ON e.owner_id=u.id AND e.id='personal' AND e.kind='personal' AND e.deleted=0
      WHERE u.school_id=? AND u.id<>? AND u.suspended_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=? AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=?))`)
      .all(school.id, viewerId, viewerId, viewerId) as { data: string; reviewed_version: number | null }[];
    const revisions = new Map<number, Schedule | undefined>();
    for (const row of rows) {
      const parsed = personalScheduleSchema.safeParse(JSON.parse(row.data));
      if (!parsed.success || parsed.data.grade !== grade || parsed.data.customSchedule) continue;
      let previous: Schedule | undefined;
      if (row.reviewed_version && row.reviewed_version !== school.version) {
        if (!revisions.has(row.reviewed_version)) {
          const revision = this.service.db.prepare('SELECT schedule FROM school_revisions WHERE school_id=? AND version=?').get(school.id, row.reviewed_version) as { schedule: string } | undefined;
          revisions.set(row.reviewed_version, revision ? JSON.parse(revision.schedule) : undefined);
        }
        previous = revisions.get(row.reviewed_version);
      }
      const memberPersonal = normalizePersonalSchedule(school.schedule, parsed.data, previous);
      const memberSchedule = effectiveSchedule(school.schedule, { ...memberPersonal, periods: [] });
      // One current personal entity per joined user, and one count per timing choice within that entity.
      const seen = new Set<string>();
      for (const day of memberSchedule.cycleDays) {
        for (const moved of cycleDaySlots(day, memberPersonal)) {
          const slot = day.slots.find(candidate => candidate.id === moved.id && candidate.periodId === moved.periodId);
          if (!slot || (slot.start === moved.start && slot.end === moved.end)) continue;
          const key = JSON.stringify([day.id, slot.id, moved.start, moved.end]);
          if (seen.has(key)) continue;
          seen.add(key);
          const existing = counts.get(key);
          if (existing) existing.count++;
          else counts.set(key, { day, slot, start: moved.start, end: moved.end, count: 1 });
        }
      }
    }
    for (const entry of counts.values()) {
      if (entry.count < MIN_SCHEDULE_SIGNAL_MEMBERS) continue;
      const draft = scheduleSchema.safeParse({ ...shared, cycleDays: shared.cycleDays.map(day => day.id !== entry.day.id ? day : {
        ...day, slots: day.slots.map(slot => slot.id !== entry.slot.id ? slot : { ...slot, start: entry.start, end: entry.end }).sort((a, b) => a.start.localeCompare(b.start)),
      }) });
      if (!draft.success) continue;
      const periodLabel = shared.periods.find(period => period.id === entry.slot.periodId)!.label;
      result.signals.push({ cycleDayId: entry.day.id, cycleDayLabel: entry.day.label, slotId: entry.slot.id, periodLabel,
        start: entry.start, end: entry.end, count: entry.count, draft: draft.data,
        summary: `Change ${periodLabel} on ${entry.day.label} to ${entry.start} to ${entry.end} for grade ${grade}.`,
      });
    }
    result.signals.sort((a, b) => b.count - a.count || a.cycleDayId.localeCompare(b.cycleDayId) || a.slotId.localeCompare(b.slotId) || a.start.localeCompare(b.start));
    return result;
  }
}
