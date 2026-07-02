import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PositionTracker } from './position-tracker.js';
import type { PositionTrackerConfig } from './position-tracker.js';

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
  overrides?: Partial<PositionTrackerConfig>,
) {
  const clock = createClock();
  const logs: string[] = [];
  const config: PositionTrackerConfig = {
    deviceId: 'test-device',
    travelTimeUpSec: 10,
    travelTimeDownSec: 10,
    calibrationExtraSec: 2,
    storagePath,
    now: clock.now,
    log: (msg) => logs.push(msg),
    ...overrides,
  };
  return { tracker: new PositionTracker(config), clock, config, logs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PositionTracker', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'position-tracker-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ========================================================================
  // 1. Initial state
  // ========================================================================

  describe('initial state', () => {
    it('has phase "unknown" when no persisted state exists', () => {
      const { tracker } = createTracker(tempDir);
      expect(tracker.getState().phase).toBe('unknown');
    });

    it('returns null for getCurrentPosition() when unknown', () => {
      const { tracker } = createTracker(tempDir);
      expect(tracker.getCurrentPosition()).toBeNull();
    });
  });

  // ========================================================================
  // 2. Calibration
  // ========================================================================

  describe('calibration', () => {
    it('startMovement(0) from unknown state returns calibration plan going down', () => {
      const { tracker } = createTracker(tempDir);
      const plan = tracker.startMovement(0);
      expect(plan).not.toBeNull();
      expect(plan!.direction).toBe('down');
      expect(plan!.isCalibration).toBe(true);
    });

    it('startMovement(100) from unknown state calibrates down first (not up)', () => {
      const { tracker } = createTracker(tempDir);
      const plan = tracker.startMovement(100);
      expect(plan).not.toBeNull();
      // Always calibrates down — 0% is the only limit-switch endpoint
      expect(plan!.direction).toBe('down');
      expect(plan!.isCalibration).toBe(true);
    });

    it('startMovement(50) from unknown calibrates down', () => {
      const { tracker } = createTracker(tempDir);
      const plan = tracker.startMovement(50);
      expect(plan).not.toBeNull();
      expect(plan!.direction).toBe('down');
    });

    it('startMovement(51) from unknown calibrates down', () => {
      const { tracker } = createTracker(tempDir);
      const plan = tracker.startMovement(51);
      expect(plan).not.toBeNull();
      expect(plan!.direction).toBe('down');
    });

    it('calibration plan duration equals (travelTime + calibrationExtra) * 1000', () => {
      const { tracker } = createTracker(tempDir);
      const planDown = tracker.startMovement(0);
      expect(planDown!.durationMs).toBe((10 + 2) * 1000);

      // Need a fresh tracker because the first one is now calibrating
      const { tracker: trackerUp } = createTracker(tempDir, { deviceId: 'other-device' });
      const planUp = trackerUp.startMovement(100);
      expect(planUp!.durationMs).toBe((10 + 2) * 1000);
    });

    it('completeMovement() after calibration down sets position to 0 and phase to stopped', () => {
      const { tracker } = createTracker(tempDir);
      tracker.startMovement(0);
      const nextPlan = tracker.completeMovement();
      expect(nextPlan).toBeNull();
      expect(tracker.getState().phase).toBe('stopped');
      expect(tracker.getCurrentPosition()).toBe(0);
    });

    it('completeMovement() after unknown non-zero target returns follow-up plan to requested target', () => {
      const { tracker } = createTracker(tempDir);
      const calibrationPlan = tracker.startMovement(50);
      expect(calibrationPlan).toEqual({ direction: 'down', durationMs: 12000, isCalibration: true });

      const nextPlan = tracker.completeMovement();
      expect(nextPlan).toEqual({ direction: 'up', durationMs: 5000, isCalibration: false });
      expect(tracker.getState()).toMatchObject({
        phase: 'moving',
        direction: 'up',
        from: 0,
        to: 50,
      });

      tracker.completeMovement();
      expect(tracker.getState().phase).toBe('stopped');
      expect(tracker.getCurrentPosition()).toBe(50);
    });

    it('completeMovement() after unknown 100% target returns full upward follow-up plan', () => {
      const { tracker } = createTracker(tempDir);
      tracker.startMovement(100);

      const nextPlan = tracker.completeMovement();
      expect(nextPlan).toEqual({ direction: 'up', durationMs: 10000, isCalibration: false });
      expect(tracker.getState()).toMatchObject({
        phase: 'moving',
        direction: 'up',
        from: 0,
        to: 100,
      });
    });

    it('completeMovement() after startCalibration(up) sets position to 100', () => {
      const { tracker } = createTracker(tempDir);
      // Use startCalibration directly — startMovement always calibrates down
      tracker.startCalibration('up');
      const nextPlan = tracker.completeMovement();
      expect(nextPlan).toBeNull();
      expect(tracker.getState().phase).toBe('stopped');
      expect(tracker.getCurrentPosition()).toBe(100);
    });

    it('startMovement() during calibration returns null (ignored)', () => {
      const { tracker } = createTracker(tempDir);
      tracker.startMovement(0);
      expect(tracker.getState().phase).toBe('calibrating');
      expect(tracker.startMovement(100)).toBeNull();
    });
  });

  // ========================================================================
  // 3. Basic movement
  // ========================================================================

  describe('basic movement', () => {
    it('from position 0, startMovement(100) returns up plan with full travel duration (not calibration)', () => {
      const { tracker } = createTracker(tempDir);
      tracker.markCalibrated(0);
      const plan = tracker.startMovement(100);
      // 100% is NOT calibration — only 0% has a limit switch
      expect(plan).toEqual({ direction: 'up', durationMs: 10000, isCalibration: false });
    });

    it('from position 0, startMovement(50) returns up plan with half duration and isCalibration=false', () => {
      const { tracker } = createTracker(tempDir);
      tracker.markCalibrated(0);
      const plan = tracker.startMovement(50);
      expect(plan).toEqual({ direction: 'up', durationMs: 5000, isCalibration: false });
    });

    it('from position 100, startMovement(50) returns down plan with half duration', () => {
      const { tracker } = createTracker(tempDir);
      tracker.markCalibrated(100);
      const plan = tracker.startMovement(50);
      expect(plan).toEqual({ direction: 'down', durationMs: 5000, isCalibration: false });
    });

    it('from position 100, startMovement(0) returns down plan with calibration (limit switch at bottom)', () => {
      const { tracker } = createTracker(tempDir);
      tracker.markCalibrated(100);
      const plan = tracker.startMovement(0);
      expect(plan).toEqual({ direction: 'down', durationMs: 12000, isCalibration: true });
    });

    it('from position 25, startMovement(75) returns up plan with 5000ms duration', () => {
      const { tracker } = createTracker(tempDir);
      tracker.markCalibrated(25);
      const plan = tracker.startMovement(75);
      expect(plan).toEqual({ direction: 'up', durationMs: 5000, isCalibration: false });
    });

    it('completeMovement() sets position to the target', () => {
      const { tracker } = createTracker(tempDir);
      tracker.markCalibrated(0);
      tracker.startMovement(75);
      tracker.completeMovement();
      expect(tracker.getCurrentPosition()).toBe(75);
      expect(tracker.getState().phase).toBe('stopped');
    });
  });

  // ========================================================================
  // 4. Already at target
  // ========================================================================

  describe('already at target', () => {
    it('startMovement(50) from position 50 returns null', () => {
      const { tracker } = createTracker(tempDir);
      tracker.markCalibrated(50);
      expect(tracker.startMovement(50)).toBeNull();
    });

    it('startMovement(50.4) from position 50 returns null (within 1% tolerance)', () => {
      const { tracker } = createTracker(tempDir);
      tracker.markCalibrated(50);
      expect(tracker.startMovement(50.4)).toBeNull();
    });
  });

  // ========================================================================
  // 5. Position interpolation
  // ========================================================================

  describe('position interpolation', () => {
    it('0→100, advance 5000ms → position ≈ 50', () => {
      const { tracker, clock } = createTracker(tempDir);
      tracker.markCalibrated(0);
      tracker.startMovement(100);
      clock.advance(5000);
      expect(tracker.getCurrentPosition()).toBeCloseTo(50, 1);
    });

    it('0→100, advance 2500ms → position ≈ 25', () => {
      const { tracker, clock } = createTracker(tempDir);
      tracker.markCalibrated(0);
      tracker.startMovement(100);
      clock.advance(2500);
      expect(tracker.getCurrentPosition()).toBeCloseTo(25, 1);
    });

    it('100→0, advance 7500ms → position ≈ 25', () => {
      const { tracker, clock } = createTracker(tempDir);
      tracker.markCalibrated(100);
      tracker.startMovement(0);
      clock.advance(7500);
      expect(tracker.getCurrentPosition()).toBeCloseTo(25, 1);
    });

    it('0→50, advance 2500ms → position ≈ 25 (half way to target)', () => {
      const { tracker, clock } = createTracker(tempDir);
      tracker.markCalibrated(0);
      tracker.startMovement(50);
      clock.advance(2500);
      expect(tracker.getCurrentPosition()).toBeCloseTo(25, 1);
    });
  });

  // ========================================================================
  // 6. Asymmetric travel times
  // ========================================================================

  describe('asymmetric travel times', () => {
    it('movement 0→100 uses full up travel time (no calibration extra)', () => {
      const { tracker } = createTracker(tempDir, {
        travelTimeUpSec: 10,
        travelTimeDownSec: 5,
      });
      tracker.markCalibrated(0);
      const plan = tracker.startMovement(100);
      // 100% is timed, not calibration — no extra time
      expect(plan!.durationMs).toBe(10000);
    });

    it('movement 100→0 uses down travel time plus calibration extra (7s)', () => {
      const { tracker } = createTracker(tempDir, {
        travelTimeUpSec: 10,
        travelTimeDownSec: 5,
      });
      tracker.markCalibrated(100);
      const plan = tracker.startMovement(0);
      expect(plan!.durationMs).toBe(7000);
    });

    it('interpolation going up at 5000ms → 50%', () => {
      const { tracker, clock } = createTracker(tempDir, {
        travelTimeUpSec: 10,
        travelTimeDownSec: 5,
      });
      tracker.markCalibrated(0);
      tracker.startMovement(100);
      clock.advance(5000);
      expect(tracker.getCurrentPosition()).toBeCloseTo(50, 1);
    });

    it('interpolation going down at 2500ms → 50%', () => {
      const { tracker, clock } = createTracker(tempDir, {
        travelTimeUpSec: 10,
        travelTimeDownSec: 5,
      });
      tracker.markCalibrated(100);
      tracker.startMovement(0);
      clock.advance(2500);
      expect(tracker.getCurrentPosition()).toBeCloseTo(50, 1);
    });
  });

  // ========================================================================
  // 7. Snapshot (mid-movement interrupt)
  // ========================================================================

  describe('snapshot', () => {
    it('snapshotPosition() during movement freezes interpolated position and stops', () => {
      const { tracker, clock } = createTracker(tempDir);
      tracker.markCalibrated(0);
      tracker.startMovement(100);
      clock.advance(5000);
      const pos = tracker.snapshotPosition();
      expect(pos).toBeCloseTo(50, 1);
      expect(tracker.getState().phase).toBe('stopped');
      expect(tracker.getCurrentPosition()).toBeCloseTo(50, 1);
    });

    it('after snapshot, a new movement can be started from the snapshotted position', () => {
      const { tracker, clock } = createTracker(tempDir);
      tracker.markCalibrated(0);
      tracker.startMovement(100);
      clock.advance(5000);
      tracker.snapshotPosition();
      const plan = tracker.startMovement(75);
      expect(plan).not.toBeNull();
      expect(plan!.direction).toBe('up');
    });

    it('snapshotPosition() when stopped returns current position without changing state', () => {
      const { tracker } = createTracker(tempDir);
      tracker.markCalibrated(42);
      const pos = tracker.snapshotPosition();
      expect(pos).toBe(42);
      expect(tracker.getState().phase).toBe('stopped');
      expect(tracker.getCurrentPosition()).toBe(42);
    });

    it('snapshotPosition() during calibration transitions to unknown', () => {
      const { tracker } = createTracker(tempDir);
      tracker.startMovement(0); // starts calibration from unknown
      expect(tracker.getState().phase).toBe('calibrating');

      const pos = tracker.snapshotPosition();
      expect(pos).toBeNull();
      expect(tracker.getState().phase).toBe('unknown');
    });

    it('snapshotPosition() when unknown returns null', () => {
      const { tracker } = createTracker(tempDir);
      expect(tracker.snapshotPosition()).toBeNull();
      expect(tracker.getState().phase).toBe('unknown');
    });

    it('after interrupting calibration, next startMovement triggers fresh calibration down', () => {
      const { tracker, clock } = createTracker(tempDir);
      // Start calibration down
      tracker.startMovement(0);
      clock.advance(3000);

      // Interrupt it
      tracker.snapshotPosition();
      expect(tracker.getState().phase).toBe('unknown');

      // Next move should trigger a new calibration (always down — only limit switch)
      const plan = tracker.startMovement(100);
      expect(plan).not.toBeNull();
      expect(plan!.isCalibration).toBe(true);
      expect(plan!.direction).toBe('down');
      expect(tracker.getState().phase).toBe('calibrating');
    });
  });

  // ========================================================================
  // 8. markCalibrated()
  // ========================================================================

  describe('markCalibrated', () => {
    it('markCalibrated(0) sets position to 0 and phase to stopped', () => {
      const { tracker } = createTracker(tempDir);
      tracker.markCalibrated(0);
      expect(tracker.getState().phase).toBe('stopped');
      expect(tracker.getCurrentPosition()).toBe(0);
    });

    it('markCalibrated(100) sets position to 100 and phase to stopped', () => {
      const { tracker } = createTracker(tempDir);
      tracker.markCalibrated(100);
      expect(tracker.getState().phase).toBe('stopped');
      expect(tracker.getCurrentPosition()).toBe(100);
    });
  });

  // ========================================================================
  // 9. Persistence
  // ========================================================================

  describe('persistence', () => {
    it('restores position after completeMovement() on a new tracker instance', () => {
      const { tracker, config } = createTracker(tempDir);
      tracker.markCalibrated(0);
      tracker.startMovement(60);
      tracker.completeMovement();

      const { tracker: tracker2 } = createTracker(tempDir, config);
      expect(tracker2.getState().phase).toBe('stopped');
      expect(tracker2.getCurrentPosition()).toBe(60);
    });

    it('restores snapshotted position on a new tracker instance', () => {
      const { tracker, clock, config } = createTracker(tempDir);
      tracker.markCalibrated(0);
      tracker.startMovement(100);
      clock.advance(3000);
      tracker.snapshotPosition();

      const { tracker: tracker2 } = createTracker(tempDir, config);
      expect(tracker2.getState().phase).toBe('stopped');
      expect(tracker2.getCurrentPosition()).toBeCloseTo(30, 1);
    });

    it('position survives multiple save/load cycles', () => {
      const { tracker, config } = createTracker(tempDir);
      tracker.markCalibrated(0);
      tracker.startMovement(33);
      tracker.completeMovement();

      // Cycle 2
      const { tracker: t2, config: c2 } = createTracker(tempDir, config);
      expect(t2.getCurrentPosition()).toBe(33);
      t2.startMovement(66);
      t2.completeMovement();

      // Cycle 3
      const { tracker: t3 } = createTracker(tempDir, c2);
      expect(t3.getCurrentPosition()).toBe(66);
    });

    it('interrupted calibration persists as unknown', () => {
      const { tracker, clock, config } = createTracker(tempDir);
      tracker.startMovement(0); // starts calibrating
      clock.advance(3000);
      tracker.snapshotPosition(); // interrupts → unknown, saves

      const { tracker: tracker2 } = createTracker(tempDir, config);
      expect(tracker2.getState().phase).toBe('unknown');
      expect(tracker2.getCurrentPosition()).toBeNull();
    });
  });

  // ========================================================================
  // 10. Crash recovery
  // ========================================================================

  describe('crash recovery', () => {
    it('recovering from saved moving state results in unknown phase', () => {
      const { tracker, clock, config } = createTracker(tempDir);
      tracker.markCalibrated(0);
      tracker.startMovement(100);
      clock.advance(3000);
      tracker.save(); // simulate crash while moving

      const { tracker: tracker2 } = createTracker(tempDir, config);
      expect(tracker2.getState().phase).toBe('unknown');
      expect(tracker2.getCurrentPosition()).toBeNull();
    });

    it('recovering from saved calibrating state results in unknown phase', () => {
      const { tracker, config } = createTracker(tempDir);
      tracker.startMovement(0); // enters calibrating
      tracker.save(); // simulate crash while calibrating

      const { tracker: tracker2 } = createTracker(tempDir, config);
      expect(tracker2.getState().phase).toBe('unknown');
      expect(tracker2.getCurrentPosition()).toBeNull();
    });

    it('unknown state after crash recovery requires calibration before partial moves', () => {
      const { tracker, config } = createTracker(tempDir);
      tracker.markCalibrated(0);
      tracker.startMovement(100);
      tracker.save(); // crash

      const { tracker: tracker2 } = createTracker(tempDir, config);
      // Partial move should be rejected — forces calibration
      const plan = tracker2.startMovement(50);
      expect(plan).not.toBeNull();
      expect(plan!.isCalibration).toBe(true);
    });
  });

  // ========================================================================
  // 11. Clamping / edge cases
  // ========================================================================

  describe('clamping and edge cases', () => {
    it('startMovement(-10) treats target as 0', () => {
      const { tracker } = createTracker(tempDir);
      tracker.markCalibrated(50);
      const plan = tracker.startMovement(-10);
      expect(plan).not.toBeNull();
      expect(plan!.direction).toBe('down');
      expect(plan!.isCalibration).toBe(true);
    });

    it('startMovement(150) treats target as 100', () => {
      const { tracker } = createTracker(tempDir);
      tracker.markCalibrated(50);
      const plan = tracker.startMovement(150);
      expect(plan).not.toBeNull();
      expect(plan!.direction).toBe('up');
      expect(plan!.isCalibration).toBe(false); // 100% is timed, not calibration
    });

    it('position never goes below 0 during interpolation', () => {
      const { tracker, clock } = createTracker(tempDir);
      tracker.markCalibrated(10);
      tracker.startMovement(0);
      clock.advance(999999);
      expect(tracker.getCurrentPosition()).toBe(0);
    });

    it('position never goes above 100 during interpolation', () => {
      const { tracker, clock } = createTracker(tempDir);
      tracker.markCalibrated(90);
      tracker.startMovement(100);
      clock.advance(999999);
      expect(tracker.getCurrentPosition()).toBe(100);
    });
  });

  // ========================================================================
  // 12. completeMovement() when already stopped
  // ========================================================================

  describe('completeMovement when already stopped or unknown', () => {
    it('completeMovement() when stopped is a no-op and does not change state', () => {
      const { tracker } = createTracker(tempDir);
      tracker.markCalibrated(42);
      tracker.completeMovement();
      expect(tracker.getState().phase).toBe('stopped');
      expect(tracker.getCurrentPosition()).toBe(42);
    });

    it('completeMovement() when unknown is a no-op', () => {
      const { tracker } = createTracker(tempDir);
      tracker.completeMovement();
      expect(tracker.getState().phase).toBe('unknown');
      expect(tracker.getCurrentPosition()).toBeNull();
    });
  });

  // ========================================================================
  // 13. Transition logging
  // ========================================================================

  describe('transition logging', () => {
    it('logs state on construction', () => {
      const { logs } = createTracker(tempDir);
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0]).toMatch(/Loaded state: unknown/);
    });

    it('logs transition on markCalibrated', () => {
      const { logs } = createTracker(tempDir);
      const beforeCount = logs.length;
      // markCalibrated is called during createTracker? No, just constructed.
      // Let's call it:
      const { tracker, logs: logs2 } = createTracker(tempDir, { deviceId: 'log-test' });
      tracker.markCalibrated(50);
      expect(logs2.some((m) => m.includes('markCalibrated') && m.includes('stopped@50%'))).toBe(true);
      expect(beforeCount).toBeGreaterThanOrEqual(0); // use beforeCount to avoid lint warning
    });

    it('logs transition on startMovement', () => {
      const { tracker, logs } = createTracker(tempDir);
      tracker.markCalibrated(0);
      tracker.startMovement(75);
      expect(logs.some((m) => m.includes('stopped@0%') && m.includes('moving'))).toBe(true);
    });

    it('logs transition on completeMovement', () => {
      const { tracker, logs } = createTracker(tempDir);
      tracker.markCalibrated(0);
      tracker.startMovement(75);
      tracker.completeMovement();
      expect(logs.some((m) => m.includes('complete') && m.includes('stopped@75%'))).toBe(true);
    });

    it('logs transition on snapshotPosition during movement', () => {
      const { tracker, clock, logs } = createTracker(tempDir);
      tracker.markCalibrated(0);
      tracker.startMovement(100);
      clock.advance(5000);
      tracker.snapshotPosition();
      expect(logs.some((m) => m.includes('snapshot') && m.includes('stopped@50%'))).toBe(true);
    });

    it('logs transition on snapshotPosition during calibration', () => {
      const { tracker, logs } = createTracker(tempDir);
      tracker.startMovement(0); // calibrating
      tracker.snapshotPosition();
      expect(logs.some((m) => m.includes('calibration interrupted') && m.includes('unknown'))).toBe(true);
    });

    it('logs calibration start from unknown', () => {
      const { tracker, logs } = createTracker(tempDir);
      tracker.startMovement(0);
      expect(logs.some((m) => m.includes('Position unknown') && m.includes('calibration down to 0%'))).toBe(true);
    });

    it('logs when ignoring command during calibration', () => {
      const { tracker, logs } = createTracker(tempDir);
      tracker.startMovement(0); // starts calibrating
      tracker.startMovement(100); // should be ignored
      expect(logs.some((m) => m.includes('Ignoring') && m.includes('calibration in progress'))).toBe(true);
    });

    it('logs when already at target', () => {
      const { tracker, logs } = createTracker(tempDir);
      tracker.markCalibrated(50);
      tracker.startMovement(50);
      expect(logs.some((m) => m.includes('Already at 50%'))).toBe(true);
    });
  });
});
