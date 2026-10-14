export type SpaceRect = { x: number; y: number; width: number; height: number };

export const SHY_RANGE = 140;
export const SHY_REPULSION_RANGE = 3;
export type Point = { x: number; y: number };

export function buttonsOverlap(a: SpaceRect, b: SpaceRect, gap = 4): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

/** Stop before the first collision along the entire move, including thin buttons. */
function sweepButtons(rect: SpaceRect, move: Point, obstacles: readonly SpaceRect[], spacing = 4): { move: Point; normal: Point } {
  let fraction = 1;
  let normal: Point = { x: 0, y: 0 };
  for (const other of obstacles) {
    // Allow a button already inside the spacing margin to move out of it.
    const gap = buttonsOverlap(rect, other, spacing) ? 0 : spacing;
    const interval = (position: number, delta: number, low: number, high: number): [number, number] => {
      if (delta === 0) return position > low && position < high ? [-Infinity, Infinity] : [Infinity, -Infinity];
      const a = (low - position) / delta;
      const b = (high - position) / delta;
      return [Math.min(a, b), Math.max(a, b)];
    };
    const [xEntry, xExit] = interval(rect.x, move.x, other.x - gap - rect.width, other.x + other.width + gap);
    const [yEntry, yExit] = interval(rect.y, move.y, other.y - gap - rect.height, other.y + other.height + gap);
    const entry = Math.max(xEntry, yEntry);
    const exit = Math.min(xExit, yExit);
    // Floating-point translations can put touching glyphs a few millionths
    // of a pixel inside a neighbor. Treat that as contact, not an existing
    // overlap that is allowed to tunnel farther into the neighbor.
    if (entry >= -0.001 && entry < exit && entry < fraction && exit > 0) {
      fraction = Math.max(0, entry - 0.0001);
      normal = { x: xEntry >= yEntry ? -Math.sign(move.x) : 0, y: yEntry >= xEntry ? -Math.sign(move.y) : 0 };
    }
  }
  return { move: { x: move.x * fraction, y: move.y * fraction }, normal };
}

export function collisionFreeMove(rect: SpaceRect, move: Point, obstacles: readonly SpaceRect[]): Point {
  return sweepButtons(rect, move, obstacles).move;
}

/** Find the nearest free position when resizing would otherwise push buttons together. */
export function fitButton(rect: SpaceRect, bounds: SpaceRect, obstacles: readonly SpaceRect[]): Point | null {
  if (rect.width > bounds.width || rect.height > bounds.height) return null;
  const correction = keepInBounds(rect, bounds);
  const home = { ...rect, x: rect.x + correction.x, y: rect.y + correction.y };
  if (!obstacles.some(other => buttonsOverlap(home, other, 0))) return correction;
  const xs = [home.x, bounds.x, bounds.x + bounds.width - rect.width, ...obstacles.flatMap(other => [other.x - rect.width - 4, other.x + other.width + 4])];
  const ys = [home.y, bounds.y, bounds.y + bounds.height - rect.height, ...obstacles.flatMap(other => [other.y - rect.height - 4, other.y + other.height + 4])];
  let best: Point | null = null;
  let distance = Infinity;
  for (const x of xs) for (const y of ys) {
    if (x < bounds.x || y < bounds.y || x + rect.width > bounds.x + bounds.width || y + rect.height > bounds.y + bounds.height) continue;
    const score = Math.hypot(x - rect.x, y - rect.y);
    if (score < distance && !obstacles.some(other => buttonsOverlap({ ...rect, x, y }, other))) { best = { x: x - rect.x, y: y - rect.y }; distance = score; }
  }
  return best;
}

export function cursorGap(rect: SpaceRect, pointer: Point): number {
  return Math.hypot(Math.max(rect.x - pointer.x, 0, pointer.x - rect.x - rect.width), Math.max(rect.y - pointer.y, 0, pointer.y - rect.y - rect.height));
}

export function keepInBounds(rect: SpaceRect, bounds: SpaceRect): Point {
  const x = Math.max(bounds.x, Math.min(rect.x, bounds.x + bounds.width - rect.width));
  const y = Math.max(bounds.y, Math.min(rect.y, bounds.y + bounds.height - rect.height));
  return { x: x - rect.x, y: y - rect.y };
}

export const SHY_MAX_SPEED = 240;
const ACCELERATION = 3200;
const FRICTION = 4.8;
const BOUNCE = 0.65;

/** Integrate cursor repulsion, drag, and bounces without changing the speed limit over time. */
export function stepShyPhysics(rect: SpaceRect, velocity: Point, pointer: Point | null, bounds: SpaceRect, seconds: number, obstacles: readonly SpaceRect[] = [], neighborForce: Point = { x: 0, y: 0 }, spacing = 4): { move: Point; velocity: Point } {
  const dt = Math.max(0, Math.min(seconds, 1 / 30));
  const gap = pointer ? cursorGap(rect, pointer) : SHY_RANGE;
  let force: Point = { x: 0, y: 0 };
  if (pointer) {
    let x = rect.x + rect.width / 2 - pointer.x;
    let y = rect.y + rect.height / 2 - pointer.y;
    if (!x && !y) { x = velocity.x || 1; y = velocity.y; }
    const length = Math.hypot(x, y);
    const strength = ACCELERATION / (1 + gap / SHY_RANGE) ** 2;
    force = { x: x / length * strength, y: y / length * strength };
  }
  // Dense groups should separate without thousands of summed forces causing
  // abrupt reversals. Preserve the direction while limiting acceleration.
  const neighborScale = Math.min(1, 6000 / (Math.hypot(neighborForce.x, neighborForce.y) || 1));
  force.x += neighborForce.x * neighborScale;
  force.y += neighborForce.y * neighborScale;
  // A steady push into an edge should settle instead of repeatedly bouncing
  // a resting piece away from the wall and pulling it back into contact.
  if (rect.x <= bounds.x + 0.01 && force.x < 0 || rect.x + rect.width >= bounds.x + bounds.width - 0.01 && force.x > 0) force.x = 0;
  if (rect.y <= bounds.y + 0.01 && force.y < 0 || rect.y + rect.height >= bounds.y + bounds.height - 0.01 && force.y > 0) force.y = 0;
  const drag = Math.exp(-FRICTION * dt);
  const next = { x: velocity.x * drag + force.x / FRICTION * (1 - drag), y: velocity.y * drag + force.y / FRICTION * (1 - drag) };
  const speed = Math.hypot(next.x, next.y);
  if (speed > SHY_MAX_SPEED) { next.x *= SHY_MAX_SPEED / speed; next.y *= SHY_MAX_SPEED / speed; }
  if (!force.x && !force.y && Math.hypot(next.x, next.y) < 0.5) { next.x = 0; next.y = 0; }
  const wanted = { x: next.x * dt, y: next.y * dt };
  const maxX = Math.max(bounds.x, bounds.x + bounds.width - rect.width);
  const maxY = Math.max(bounds.y, bounds.y + bounds.height - rect.height);
  const bounded = { x: Math.max(bounds.x, Math.min(rect.x + wanted.x, maxX)) - rect.x, y: Math.max(bounds.y, Math.min(rect.y + wanted.y, maxY)) - rect.y };
  if (Math.abs(bounded.x - wanted.x) > 0.00001) next.x = Math.abs(next.x) < 40 ? 0 : -next.x * BOUNCE;
  if (Math.abs(bounded.y - wanted.y) > 0.00001) next.y = Math.abs(next.y) < 40 ? 0 : -next.y * BOUNCE;
  const collision = sweepButtons(rect, bounded, obstacles, spacing);
  const destination = { ...rect, x: rect.x + collision.move.x, y: rect.y + collision.move.y };
  // Check the final position too: a diagonal contact can begin inside the
  // spacing margin without the sweep reporting a positive entry time.
  if (obstacles.some(other => buttonsOverlap(destination, other, 0) && !buttonsOverlap(rect, other, -0.01))) {
    return { move: { x: 0, y: 0 }, velocity: { x: -next.x * BOUNCE, y: -next.y * BOUNCE } };
  }
  if (collision.normal.x) next.x *= -BOUNCE;
  if (collision.normal.y) next.y *= -BOUNCE;
  return { move: collision.move, velocity: next };
}

/** Equal and opposite repulsion, strongest when the rectangles touch. */
export function particleRepulsion(a: SpaceRect, b: SpaceRect): Point {
  const gap = Math.hypot(Math.max(a.x - b.x - b.width, b.x - a.x - a.width, 0), Math.max(a.y - b.y - b.height, b.y - a.y - a.height, 0));
  if (gap >= SHY_REPULSION_RANGE) return { x: 0, y: 0 };
  const x = a.x + a.width / 2 - b.x - b.width / 2;
  const y = a.y + a.height / 2 - b.y - b.height / 2;
  const length = Math.hypot(x, y);
  if (!length) return { x: 0, y: 0 };
  const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const area = Math.max(1, Math.min(a.width * a.height, b.width * b.height));
  const strength = (60000 + 180000 * Math.min(1, overlap / area)) * (1 - gap / SHY_REPULSION_RANGE) ** 2;
  return { x: x / length * strength, y: y / length * strength };
}
