/** Infer daytime hours for school schedules; explicit AM/PM and 24-hour input win. */
export function parseScheduleTime(text: string, previous = ''): string | null {
  const match = text.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (minute > 59 || hour > 23 || (meridiem && (hour < 1 || hour > 12))) return null;
  if (meridiem) hour = hour % 12 + (meridiem === 'pm' ? 12 : 0);
  else if (hour >= 1 && hour <= 12) {
    const previousHour = /^\d{2}:\d{2}$/.test(previous) ? Number(previous.slice(0, 2)) : null;
    const previousClockHour = previousHour === null ? null : previousHour % 12 || 12;
    const crossesTwelve = (previousClockHour === 11 && hour === 12)
      || (previousClockHour === 12 && hour === 11);
    // Crossing noon or midnight flips AM/PM; minute edits preserve it.
    let afternoon = hour === 12 || hour < 7;
    if (previousHour !== null) {
      if (crossesTwelve) afternoon = previousHour < 12;
      else if (previousClockHour === hour) afternoon = previousHour >= 12;
    }
    hour = hour % 12 + (afternoon ? 12 : 0);
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function displayScheduleTime(value: string): string {
  return value ? `${Number(value.slice(0, 2)) % 12 || 12}:${value.slice(3)}` : '';
}
