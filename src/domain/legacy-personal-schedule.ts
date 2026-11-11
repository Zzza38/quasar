import { applySlotChanges, cycleDaySchema, effectiveSchedule, scheduleSchema, type PersonalSchedule, type Schedule } from './schedule';

/** Freeze saved adjustments before leaving schedule following. Keep exceptional sparse data if legacy cannot represent it. */
export function materializePersonalSchedule(school: Schedule | undefined, personal: PersonalSchedule): PersonalSchedule {
  if (personal.periods === undefined && !personal.cycleDayOverrides.some(override => override.slotChanges !== undefined)) return personal;
  const basis = personal.customSchedule ?? (school ? effectiveSchedule(school, { ...personal, periods: [] }) : undefined);
  let freezeBasis = false;
  const cycleDayOverrides = personal.cycleDayOverrides.map(override => {
    if (!override.slotChanges) return override;
    const day = basis?.cycleDays.find(day => day.id === override.cycleDayId);
    // A removed day has no complete shared snapshot to freeze. Retain its additions, edits and tombstones.
    if (!day) return override;
    const slots = applySlotChanges(day.slots, override);
    const incomplete = Object.entries(override.slotChanges).some(([id, change]) => change !== null && !slots.some(slot => slot.id === id));
    if (incomplete || !cycleDaySchema.safeParse({ id: override.cycleDayId, label: day.label, slots }).success) { freezeBasis = true; return override; }
    return { cycleDayId: override.cycleDayId, slots };
  });
  const { periods, ...legacy } = personal;
  const missingPeriods = periods?.filter(period => !basis?.periods.some(entry => entry.id === period.id)) ?? [];
  const proposed = missingPeriods.length && basis ? scheduleSchema.safeParse({ ...basis, periods: [...basis.periods, ...missingPeriods] }) : undefined;
  const customSchedule = proposed?.success ? proposed.data : freezeBasis && basis ? basis : personal.customSchedule;
  // With no school and no private timetable there is nowhere legacy can keep private period metadata.
  return { ...legacy, cycleDayOverrides, customSchedule, ...((!basis || (proposed && !proposed.success)) && periods?.length ? { periods } : {}) };
}
