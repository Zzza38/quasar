import { Temporal } from '@js-temporal/polyfill';

/** datetime-local has no offset. During the autumn clock change we display the first occurrence's offset. */
export function announcementTime(value: string, zone: string, now: number) {
  if (!value) return { error: '', instant: null, offset: null };
  try {
    const local = Temporal.PlainDateTime.from(value);
    const zoned = local.toZonedDateTime(zone);
    if (!zoned.toPlainDateTime().equals(local)) {
      return { error: 'The clocks skip this time. Choose a different time.', instant: null, offset: null };
    }
    if (zoned.epochMilliseconds <= now) {
      return { error: 'Choose a date and time in the future.', instant: null, offset: null };
    }
    if (local.year > 9999) throw new RangeError();
    return { error: '', instant: new Date(zoned.epochMilliseconds).toISOString(), offset: zoned.offset };
  } catch {
    return { error: 'Enter a valid date and time.', instant: null, offset: null };
  }
}
