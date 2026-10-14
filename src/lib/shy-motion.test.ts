import { describe, expect, it } from 'vitest';
import { buttonsOverlap, collisionFreeMove, fitButton, particleRepulsion, SHY_MAX_SPEED, stepShyPhysics } from './shy-motion';

describe('shy particle physics', () => {
  it('limits abrupt reversals and settles against an edge under a steady push', () => {
    const bounds = { x: 8, y: 8, width: 984, height: 784 };
    const rect = { x: 200, y: 200, width: 10, height: 20 };
    const reversed = stepShyPhysics(rect, { x: 240, y: 0 }, null, bounds, 1 / 60, [], { x: -90000, y: 0 });
    expect(reversed.velocity.x).toBeGreaterThan(100);
    const edge = { ...rect, x: 8 };
    const settled = stepShyPhysics(edge, { x: 0, y: 0 }, { x: 50, y: 210 }, bounds, 1 / 60, [], { x: -90000, y: 0 });
    expect(settled.move).toEqual({ x: 0, y: 0 });
    expect(settled.velocity).toEqual({ x: 0, y: 0 });
  });
  it('pushes distant pieces with inverse-square falloff and separates overlapping particles with forces', () => {
    const rect = { x: 200, y: 200, width: 10, height: 20 };
    const bounds = { x: 0, y: 0, width: 1000, height: 1000 };
    const near = stepShyPhysics(rect, { x: 0, y: 0 }, { x: 195, y: 210 }, bounds, 1 / 60);
    expect(near.velocity.x).toBeGreaterThan(40);
    const at = (distance: number) => stepShyPhysics(rect, { x: 0, y: 0 }, { x: rect.x - distance, y: 210 }, bounds, 1 / 60).velocity.x;
    expect(at(140)).toBeGreaterThan(0);
    expect(at(1260)).toBeGreaterThan(0);
    expect(at(1260)).toBeCloseTo(at(0) / 100);
    expect(at(140)).toBeCloseTo(at(0) / 4);
    const force = particleRepulsion(rect, { ...rect, x: 205 });
    const touching = particleRepulsion(rect, { ...rect, x: 210 });
    expect(Math.abs(force.x)).toBeGreaterThan(Math.abs(touching.x));
    expect(stepShyPhysics(rect, { x: 0, y: 0 }, null, bounds, 1 / 60, [], force).move.x).toBeLessThan(0);
  });
  it('does not deepen a tiny floating-point overlap between touching letters', () => {
    const rect = { x: 100.0000001, y: 100, width: 8, height: 20 };
    const neighbor = { x: 108, y: 100, width: 8, height: 20 };
    const result = stepShyPhysics(rect, { x: 160, y: 0 }, null, { x: 0, y: 0, width: 1000, height: 1000 }, 1 / 60, [neighbor], { x: 0, y: 0 }, 0.05);
    expect(result.move.x).toBe(0);
    expect(result.velocity.x).toBeLessThan(0);
  });
  it('applies equal and opposite forces to nearby pieces, with no distant force', () => {
    const a = { x: 100, y: 100, width: 8, height: 20 };
    const b = { x: 109, y: 100, width: 8, height: 20 };
    const force = particleRepulsion(a, b);
    const reverse = particleRepulsion(b, a);
    expect(force.x).toBeLessThan(0);
    expect(reverse.x).toBe(-force.x);
    expect(reverse.y + force.y).toBe(0);
    expect(particleRepulsion(a, { ...b, x: 200 })).toEqual({ x: 0, y: 0 });
    expect(particleRepulsion(a, { ...b, x: 111 })).toEqual({ x: 0, y: 0 });
    expect(Math.abs(particleRepulsion(a, { ...b, x: 108 }).x)).toBe(60000);
    const bounds = { x: 0, y: 0, width: 1000, height: 1000 };
    const left = stepShyPhysics(a, { x: 0, y: 0 }, null, bounds, 1 / 60, [], force, 0);
    const right = stepShyPhysics(b, { x: 0, y: 0 }, null, bounds, 1 / 60, [], reverse, 0);
    expect(left.move.x).toBeLessThan(0);
    expect(right.move.x).toBeGreaterThan(0);
    expect(Math.hypot(left.velocity.x, left.velocity.y)).toBeLessThanOrEqual(SHY_MAX_SPEED + 0.000001);
  });
  it('accelerates smoothly from rest and caps speed without running out of stamina', () => {
    const bounds = { x: 0, y: 0, width: 10000, height: 1000 };
    let rect = { x: 100, y: 300, width: 100, height: 40 };
    let velocity = { x: 0, y: 0 };
    const speeds: number[] = [];
    for (let frame = 0; frame < 300; frame++) {
      const next = stepShyPhysics(rect, velocity, { x: rect.x + 50, y: rect.y + 20 }, bounds, 1 / 60);
      velocity = next.velocity;
      speeds.push(Math.hypot(velocity.x, velocity.y));
      expect(Math.hypot(next.move.x, next.move.y)).toBeLessThanOrEqual(SHY_MAX_SPEED / 60 + 0.00001);
      rect = { ...rect, x: rect.x + next.move.x, y: rect.y + next.move.y };
    }
    expect(speeds[0]).toBeLessThan(60);
    expect(speeds[10]).toBeGreaterThan(speeds[0]);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(SHY_MAX_SPEED);
    expect(speeds.at(-1)).toBeCloseTo(SHY_MAX_SPEED);
    expect(rect.x - 100).toBeGreaterThan(500);
  });

  it('repels harder when the cursor is closer and glides to a stop through friction', () => {
    const rect = { x: 300, y: 300, width: 100, height: 40 };
    const bounds = { x: 0, y: 0, width: 2000, height: 1000 };
    const near = stepShyPhysics(rect, { x: 0, y: 0 }, { x: 295, y: 320 }, bounds, 1 / 60);
    const far = stepShyPhysics(rect, { x: 0, y: 0 }, { x: 220, y: 320 }, bounds, 1 / 60);
    expect(near.velocity.x).toBeGreaterThan(far.velocity.x);
    let velocity = { x: 120, y: 0 };
    let current = rect;
    const first = stepShyPhysics(current, velocity, null, bounds, 1 / 60);
    expect(first.move.x).toBeGreaterThan(0);
    expect(first.velocity.x).toBeLessThan(velocity.x);
    for (let frame = 0; frame < 120; frame++) {
      const next = stepShyPhysics(current, velocity, null, bounds, 1 / 60);
      velocity = next.velocity;
      current = { ...current, x: current.x + next.move.x, y: current.y + next.move.y };
    }
    expect(velocity).toEqual({ x: 0, y: 0 });
    expect(current.x).toBeGreaterThan(rect.x);
  });

  it('bounces off field edges and other buttons without intersecting them', () => {
    const bounds = { x: 8, y: 16, width: 984, height: 776 };
    const wall = stepShyPhysics({ x: 891, y: 300, width: 100, height: 40 }, { x: 100, y: 0 }, null, bounds, 1 / 30);
    expect(wall.velocity.x).toBeLessThan(0);
    expect(891 + wall.move.x + 100).toBeLessThanOrEqual(bounds.x + bounds.width);
    const rect = { x: 100, y: 200, width: 40, height: 40 };
    const obstacle = { x: 148, y: 200, width: 40, height: 40 };
    const bounce = stepShyPhysics(rect, { x: 200, y: 0 }, null, bounds, 1 / 30, [obstacle]);
    expect(bounce.velocity.x).toBeLessThan(0);
    expect(buttonsOverlap({ ...rect, x: rect.x + bounce.move.x }, obstacle)).toBe(false);
  });

  it('prevents passing through thin buttons and fits resized buttons into free space', () => {
    const rect = { x: 0, y: 20, width: 20, height: 20 };
    const obstacle = { x: 40, y: 20, width: 4, height: 20 };
    const move = collisionFreeMove(rect, { x: 100, y: 0 }, [obstacle]);
    expect(move.x).toBeGreaterThan(0);
    expect(move.x).toBeLessThan(16);
    for (let step = 0; step <= 20; step++) expect(buttonsOverlap({ ...rect, x: move.x * step / 20 }, obstacle)).toBe(false);
    const resized = { x: 0, y: 0, width: 260, height: 100 };
    const displaced = { x: 250, y: 20, width: 80, height: 40 };
    const stationary = { x: 170, y: 20, width: 80, height: 40 };
    const correction = fitButton(displaced, resized, [stationary])!;
    const fitted = { ...displaced, x: displaced.x + correction.x, y: displaced.y + correction.y };
    expect(buttonsOverlap(fitted, stationary)).toBe(false);
    expect(fitted.x + fitted.width).toBeLessThanOrEqual(resized.width);
  });
});
