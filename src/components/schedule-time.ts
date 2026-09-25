/**
 * Infer daytime hours for school schedules; explicit AM/PM and 24-hour input win.
 * A zero-padded hour ("06:45") or one above 12 counts as 24-hour input.
 */
export function parseScheduleTime(text: string, previous = ''): string | null {
  const match = text.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  const zeroPadded = match[1].length === 2 && match[1].startsWith('0');
  if (minute > 59 || hour > 23 || (meridiem && (hour < 1 || hour > 12))) return null;
  if (meridiem) hour = hour % 12 + (meridiem === 'pm' ? 12 : 0);
  else if (hour >= 1 && hour <= 12 && !zeroPadded) {
    const previousHour = /^\d{2}:\d{2}$/.test(previous) ? Number(previous.slice(0, 2)) : null;
    const previousClockHour = previousHour === null ? null : previousHour % 12 || 12;
    const crossesTwelve = (previousClockHour === 11 && hour === 12)
      || (previousClockHour === 12 && hour === 11);
    // Without context, 7-11 read as morning and 12-6 as afternoon.
    let afternoon = hour === 12 || hour < 7;
    if (previousHour !== null) {
      // Crossing noon or midnight flips AM/PM; minute edits preserve it.
      if (crossesTwelve) afternoon = previousHour < 12;
      else if (previousClockHour === hour) afternoon = previousHour >= 12;
      // Early-bird periods: a morning value moved to 1-6 within two hours stays AM.
      else if (hour < 7 && previousHour >= 1 && previousHour < 12
        && Math.abs(previousHour - hour) <= 2) afternoon = false;
    }
    hour = hour % 12 + (afternoon ? 12 : 0);
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function displayScheduleTime(value: string): string {
  return value ? `${Number(value.slice(0, 2)) % 12 || 12}:${value.slice(3)}` : '';
}
