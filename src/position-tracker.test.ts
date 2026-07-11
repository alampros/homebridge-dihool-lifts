import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiftStateTracker } from './position-tracker.js';
import type { LiftStateConfig } from './position-tracker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

function createTracker(
  storagePath: string,
  overrides?: Partial<LiftStateConfig>,
) {
  const clock = createClock();
  const logs: string[] = [];
  const config: LiftStateConfig = {
    deviceId: 'test-device',
    travelTimeUpSec: 10,
    travelTimeDownSec: 8,
    storagePath,
    ...overrides,
    now: clock.now,
    log: (msg) => logs.push(msg),
  };
  return { tracker: new LiftStateTracker(config), clock, config, logs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LiftStateTracker', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lift-state-tracker-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ========================================================================
  // 1. Initial state
  // ========================================================================

  describe('initial state', () => {
    it('has phase "stopped" at position 0 when no persisted state exists', () => {
      const { tracker } = createTracker(tempDir);
      expect(tracker.getState().phase).toBe('stopped');
      expect(tracker.getPosition()).toBe(0);
    });

    it('logs loaded state on construction', () => {
      const { logs } = createTracker(tempDir);
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0]).toMatch(/Loaded state: stopped@0%/);
    });
  });

  // ========================================================================
  // 2. startMovement
  // ========================================================================

  describe('startMovement', () => {
    it('from stopped@0, startMovement("up") → moving/up, returns true', () => {
      const { tracker } = createTracker(tempDir);
      expect(tracker.startMovement('up')).toBe(true);
      expect(tracker.getState()).toEqual({ phase: 'moving', direction: 'up', startedAt: 0 });
    });

    it('from stopped@100, startMovement("down") → moving/down, returns true', () => {
      const { tracker } = createTracker(tempDir);
      tracker.startMovement('up');
      tracker.completeMovement();
      expect(tracker.getPosition()).toBe(100);

      expect(tracker.startMovement('down')).toBe(true);
      expect(tracker.getState()).toEqual({ phase: 'moving', direction: 'down', startedAt: 0 });
    });

    it('from stopped@0, startMovement("down") → returns false (already at bottom)', () => {
      const { tracker } = createTracker(tempDir);
      expect(tracker.startMovement('down')).toBe(false);
      expect(tracker.getState().phase).toBe('stopped');
      expect(tracker.getPosition()).toBe(0);
    });

    it('from stopped@100, startMovement("up") → returns false (already at top)', () => {
      const { tracker } = createTracker(tempDir);
      tracker.startMovement('up');
      tracker.completeMovement();
      expect(tracker.startMovement('up')).toBe(false);
      expect(tracker.getState().phase).toBe('stopped');
      expect(tracker.getPosition()).toBe(100);
    });

    it('when already moving up, startMovement("up") → returns false', () => {
      const { tracker } = createTracker(tempDir);
      tracker.startMovement('up');
      expect(tracker.startMovement('up')).toBe(false);
      expect(tracker.getState()).toEqual({ phase: 'moving', direction: 'up', startedAt: 0 });
    });

    it('when already moving down, startMovement("down") → returns false', () => {
      const { tracker } = createTracker(tempDir);
      tracker.startMovement('up');
      tracker.completeMovement();
      tracker.startMovement('down');
      expect(tracker.startMovement('down')).toBe(false);
      expect(tracker.getState()).toEqual({ phase: 'moving', direction: 'down', startedAt: 0 });
    });

    it('when moving up, startMovement("down") → returns true (reversal)', () => {
      const { tracker, clock } = createTracker(tempDir);
      tracker.startMovement('up');
      clock.advance(1000);
      expect(tracker.startMovement('down')).toBe(true);
      expect(tracker.getState()).toEqual({ phase: 'moving', direction: 'down', startedAt: 1000 });
    });

    it('when moving down, startMovement("up") → returns true (reversal)', () => {
      const { tracker, clock } = createTracker(tempDir);
      tracker.startMovement('up');
      tracker.completeMovement();
      tracker.startMovement('down');
      clock.advance(1000);
      expect(tracker.startMovement('up')).toBe(true);
      expect(tracker.getState()).toEqual({ phase: 'moving', direction: 'up', startedAt: 1000 });
    });

    it('logs transitions', () => {
      const { tracker, logs } = createTracker(tempDir);
      tracker.startMovement('up');
      expect(logs.some((m) => m.includes('stopped@0%') && m.includes('moving(up)'))).toBe(true);
    });

    it('logs ignored commands', () => {
      const { tracker, logs } = createTracker(tempDir);
      tracker.startMovement('down');
      expect(logs.some((m) => m.includes('Already at bottom'))).toBe(true);
    });
  });

  // ========================================================================
  // 3. getPosition during movement
  // ========================================================================

  describe('getPosition during movement', () => {
    it('when moving up, getPosition returns 0 (where we came from)', () => {
      const { tracker } = createTracker(tempDir);
      tracker.startMovement('up');
      expect(tracker.getPosition()).toBe(0);
    });

    it('when moving down, getPosition returns 100 (where we came from)', () => {
      const { tracker } = createTracker(tempDir);
      tracker.startMovement('up');
      tracker.completeMovement();
      tracker.startMovement('down');
      expect(tracker.getPosition()).toBe(100);
    });
  });

  // ========================================================================
  // 4. completeMovement
  // ========================================================================

  describe('completeMovement', () => {
    it('after moving up → stopped@100', () => {
      const { tracker } = createTracker(tempDir);
      tracker.startMovement('up');
      tracker.completeMovement();
      expect(tracker.getState()).toEqual({ phase: 'stopped', position: 100 });
      expect(tracker.getPosition()).toBe(100);
    });

    it('after moving down → stopped@0', () => {
      const { tracker } = createTracker(tempDir);
      tracker.startMovement('up');
      tracker.completeMovement();
      tracker.startMovement('down');
      tracker.completeMovement();
      expect(tracker.getState()).toEqual({ phase: 'stopped', position: 0 });
      expect(tracker.getPosition()).toBe(0);
    });

    it('when already stopped is a no-op', () => {
      const { tracker } = createTracker(tempDir);
      tracker.completeMovement();
      expect(tracker.getState()).toEqual({ phase: 'stopped', position: 0 });
    });

    it('logs completion', () => {
      const { tracker, logs } = createTracker(tempDir);
      tracker.startMovement('up');
      tracker.completeMovement();
      expect(logs.some((m) => m.includes('complete') && m.includes('stopped@100%'))).toBe(true);
    });
  });

  // ========================================================================
  // 5. settledAt
  // ========================================================================

  describe('settledAt', () => {
    it('returns startedAt + travelTimeUpSec * 1000 when moving up', () => {
      const { tracker } = createTracker(tempDir);
      tracker.startMovement('up');
      expect(tracker.settledAt()).toBe(0 + 10 * 1000);
    });

    it('returns startedAt + travelTimeDownSec * 1000 when moving down', () => {
      const { tracker } = createTracker(tempDir);
      tracker.startMovement('up');
      tracker.completeMovement();
      tracker.startMovement('down');
      expect(tracker.settledAt()).toBe(0 + 8 * 1000);
    });

    it('throws when not moving', () => {
      const { tracker } = createTracker(tempDir);
      expect(() => tracker.settledAt()).toThrow('Cannot compute settledAt: not moving');
    });
  });

  // ========================================================================
  // 6. Persistence
  // ========================================================================

  describe('persistence', () => {
    it('restores stopped@100 after completeMovement on a new tracker instance', () => {
      const { tracker, config } = createTracker(tempDir);
      tracker.startMovement('up');
      tracker.completeMovement();

      const { tracker: tracker2 } = createTracker(tempDir, config);
      expect(tracker2.getState()).toEqual({ phase: 'stopped', position: 100 });
      expect(tracker2.getPosition()).toBe(100);
    });

    it('restores stopped@0 after completeMovement down on a new tracker instance', () => {
      const { tracker, config } = createTracker(tempDir);
      tracker.startMovement('up');
      tracker.completeMovement();
      tracker.startMovement('down');
      tracker.completeMovement();

      const { tracker: tracker2 } = createTracker(tempDir, config);
      expect(tracker2.getState()).toEqual({ phase: 'stopped', position: 0 });
      expect(tracker2.getPosition()).toBe(0);
    });

    it('position survives multiple save/load cycles', () => {
      const { tracker, config } = createTracker(tempDir);
      tracker.startMovement('up');
      tracker.completeMovement();

      // Cycle 2
      const { tracker: t2, config: c2 } = createTracker(tempDir, config);
      expect(t2.getPosition()).toBe(100);
      t2.startMovement('down');
      t2.completeMovement();

      // Cycle 3
      const { tracker: t3 } = createTracker(tempDir, c2);
      expect(t3.getPosition()).toBe(0);
    });
  });

  // ========================================================================
  // 7. Crash recovery
  // ========================================================================

  describe('crash recovery', () => {
    it('saved moving state loads as stopped@0', () => {
      const { tracker, clock, config } = createTracker(tempDir);
      tracker.startMovement('up');
      clock.advance(3000);
      tracker.save(); // simulate crash while moving

      const { tracker: tracker2, logs } = createTracker(tempDir, config);
      expect(tracker2.getState()).toEqual({ phase: 'stopped', position: 0 });
      expect(tracker2.getPosition()).toBe(0);
      expect(logs.some((m) => m.includes('Recovering from crash') && m.includes('bottom'))).toBe(true);
    });
  });

  // ========================================================================
  // 8. Asymmetric travel times
  // ========================================================================

  describe('asymmetric travel times', () => {
    it('settledAt uses up time when moving up', () => {
      const { tracker } = createTracker(tempDir, {
        travelTimeUpSec: 15,
        travelTimeDownSec: 5,
      });
      tracker.startMovement('up');
      expect(tracker.settledAt()).toBe(0 + 15 * 1000);
    });

    it('settledAt uses down time when moving down', () => {
      const { tracker } = createTracker(tempDir, {
        travelTimeUpSec: 15,
        travelTimeDownSec: 5,
      });
      tracker.startMovement('up');
      tracker.completeMovement();
      tracker.startMovement('down');
      expect(tracker.settledAt()).toBe(0 + 5 * 1000);
    });
  });
});
