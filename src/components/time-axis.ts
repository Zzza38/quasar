/** A shared time axis gives very short blocks room without overlapping neighbouring blocks. */
export function buildTimeAxis(start: number, end: number, boundaries: number[], scale = 1.3) {
  const points = [...new Set([start, end, ...boundaries.filter(time => time > start && time < end)])].sort((a, b) => a - b);
  const offsets = [0];
  for (let index = 1; index < points.length; index++) offsets.push(offsets[index - 1] + Math.max(24, (points[index] - points[index - 1]) * scale));
  const interpolate = (value: number, from: number[], to: number[]) => {
    const clamped = Math.max(from[0], Math.min(from[from.length - 1], value));
    const index = Math.max(1, from.findIndex(entry => entry >= clamped));
    return to[index - 1] + (clamped - from[index - 1]) / (from[index] - from[index - 1]) * (to[index] - to[index - 1]);
  };
  return { height: offsets[offsets.length - 1], y: (time: number) => interpolate(time, points, offsets), time: (y: number) => interpolate(y, offsets, points) };
}
