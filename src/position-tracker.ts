/**
 * Timer-based position estimation for motorized lifts without encoder feedback.
 *
 * Tracks estimated position (0–100%) by integrating motor run-time against
 * configured full-travel durations. Persists state to disk so position
 * survives Homebridge restarts.
 *
 * This module has zero Homebridge dependencies — pure logic + file I/O —
 * making it independently testable with fake timers.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

/** Position is not known — needs calibration before partial moves work. */
interface UnknownState {
  readonly phase: 'unknown';
}

/** Motor is stopped at a known position. */
interface StoppedState {
  readonly phase: 'stopped';
  /** Estimated position 0–100. */
  readonly position: number;
}

/** Motor is running toward a target position. */
interface MovingState {
  readonly phase: 'moving';
  /** Direction of travel. */
  readonly direction: 'up' | 'down';
  /** Position when movement started (0–100). */
  readonly from: number;
  /** Target position (0–100). */
  readonly to: number;
  /** Timestamp (ms) when movement started. */
  readonly startedAt: number;
}

/** Motor is running a full-travel calibration move. */
interface CalibratingState {
  readonly phase: 'calibrating';
  /** Direction of calibration travel. */
  readonly direction: 'up' | 'down';
  /** Timestamp (ms) when calibration started. */
  readonly startedAt: number;
  /** Optional target to move to after calibration completes. */
  readonly pendingTarget?: number;
}

export type TrackerState = UnknownState | StoppedState | MovingState | CalibratingState;

// ---------------------------------------------------------------------------
// Movement plan — returned to the caller so it can drive the hardware
// ---------------------------------------------------------------------------

export interface MovementPlan {
  /** Which direction to pulse the motor. */
  direction: 'up' | 'down';
  /** How long to run the motor (ms). */
  durationMs: number;
  /** True when this is an endpoint calibration move. */
  isCalibration: boolean;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PositionTrackerConfig {
  /** Device ID — used as the persistence key. */
  deviceId: string;
  /** Full travel time going up, in seconds. */
  travelTimeUpSec: number;
  /** Full travel time going down, in seconds. */
  travelTimeDownSec: number;
  /**
   * Extra seconds to add when commanding 0%, ensuring the motor hits the
   * physical limit switch and we can snap to a known endpoint.
   */
  calibrationExtraSec: number;
  /** Directory for the persistence file. */
  storagePath: string;
  /**
   * Injectable clock for testing. Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * Optional log callback for state transition logging.
   * Called with a human-readable message on every state change.
   */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const PERSISTENCE_FILENAME = 'dihool-lifts-positions.json';

interface PersistedDeviceState {
  position: number;
  phase: 'stopped' | 'moving' | 'calibrating' | 'unknown';
  lastUpdated: string;
}

type PersistedStore = Record<string, PersistedDeviceState>;

// ---------------------------------------------------------------------------
// PositionTracker
// ---------------------------------------------------------------------------

export class PositionTracker {
  private state: TrackerState;
  private readonly config: Readonly<PositionTrackerConfig>;
  private readonly persistPath: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(config: PositionTrackerConfig) {
    this.config = config;
    this.now = config.now ?? Date.now;
    this.log = config.log ?? (() => {});
    this.persistPath = join(config.storagePath, PERSISTENCE_FILENAME);
    this.state = this.loadState();
    this.log(`Loaded state: ${describeState(this.state)}`);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Current tracker state (readonly snapshot). */
  getState(): Readonly<TrackerState> {
    return this.state;
  }

  /**
   * Get the current estimated position.
   * Returns `null` if position is unknown (needs calibration).
   * If the motor is moving, interpolates based on elapsed time.
   */
  getCurrentPosition(): number | null {
    switch (this.state.phase) {
      case 'unknown':
        return null;
      case 'stopped':
        return this.state.position;
      case 'calibrating':
        // During calibration we don't have a meaningful position
        return null;
      case 'moving':
        return this.interpolatePosition(this.state);
    }
  }

  /**
   * Plan and begin a movement toward `target` (0–100).
   *
   * Returns a `MovementPlan` describing what the hardware should do,
   * or `null` if no movement is needed (already at target).
   *
   * Call `completeMovement()` when the plan's timer fires.
   */
  startMovement(target: number): MovementPlan | null {
    const clamped = clamp(target, 0, 100);

    // If unknown position, calibrate down to 0% first (the only limit-switch endpoint).
    // Non-zero targets are remembered and planned after calibration completes.
    if (this.state.phase === 'unknown') {
      this.log(`Position unknown, starting calibration down to 0%${clamped !== 0 ? ` before moving to ${fmtPos(clamped)}` : ''}`);
      return this.startCalibration('down', clamped === 0 ? undefined : clamped);
    }

    // If calibrating, ignore new commands
    if (this.state.phase === 'calibrating') {
      this.log(`Ignoring startMovement(${clamped}) — calibration in progress`);
      return null;
    }

    const currentPos = this.getCurrentPosition()!;

    // Already there (within 1% tolerance)
    if (Math.abs(currentPos - clamped) < 1) {
      this.log(`Already at ${fmtPos(currentPos)}, ignoring target ${fmtPos(clamped)}`);
      return null;
    }

    const direction: 'up' | 'down' = clamped > currentPos ? 'up' : 'down';
    const travel = Math.abs(clamped - currentPos);
    const travelTimeSec = direction === 'up'
      ? this.config.travelTimeUpSec
      : this.config.travelTimeDownSec;

    // Only 0% is a true calibration move (physical limit switch at bottom).
    // 100% is a timed stop — the top is defined by travel time, not a switch.
    const isCalibration = clamped === 0;
    const durationMs = isCalibration
      ? (travelTimeSec + this.config.calibrationExtraSec) * 1000
      : (travel / 100) * travelTimeSec * 1000;

    const prev = this.state;
    this.state = {
      phase: 'moving',
      direction,
      from: currentPos,
      to: clamped,
      startedAt: this.now(),
    };
    this.log(`${describeState(prev)} -> ${describeState(this.state)} (${durationMs}ms${isCalibration ? ', calibration' : ''})`);

    return { direction, durationMs, isCalibration };
  }

  /**
   * Snapshot the current interpolated position and freeze it.
   * Use when interrupting a movement mid-flight (e.g., user sends a new
   * target while motor is running).
   *
   * Returns the snapshotted position, or `null` if position is unknown.
   */
  snapshotPosition(): number | null {
    const prev = this.state;

    switch (this.state.phase) {
      case 'moving': {
        const pos = this.interpolatePosition(this.state);
        this.state = { phase: 'stopped', position: pos };
        this.log(`${describeState(prev)} -> ${describeState(this.state)} (snapshot)`);
        this.save();
        return pos;
      }

      case 'calibrating':
        // Calibration was interrupted before hitting the limit switch.
        // We don't know where we are — mark unknown so next command
        // triggers a fresh calibration.
        this.state = { phase: 'unknown' };
        this.log(`${describeState(prev)} -> ${describeState(this.state)} (calibration interrupted)`);
        this.save();
        return null;

      case 'stopped':
        return this.state.position;

      case 'unknown':
        return null;
    }
  }

  /**
   * Called when the motor-run timer fires. Finalizes position and
   * transitions to stopped.
   */
  completeMovement(): MovementPlan | null {
    const prev = this.state;
    let pendingTarget: number | undefined;

    switch (this.state.phase) {
      case 'moving':
        this.state = { phase: 'stopped', position: this.state.to };
        break;
      case 'calibrating':
        pendingTarget = this.state.pendingTarget;
        this.state = {
          phase: 'stopped',
          position: this.state.direction === 'down' ? 0 : 100,
        };
        break;
      default:
        // Already stopped or unknown — nothing to do
        return null;
    }

    this.log(`${describeState(prev)} -> ${describeState(this.state)} (complete)`);
    this.save();

    if (pendingTarget !== undefined) {
      return this.startMovement(pendingTarget);
    }

    return null;
  }

  /**
   * Force-set a known position. Primarily used after a calibration move
   * confirms the lift is at an endpoint (0 or 100), but also useful for
   * restoring a known position from external sources.
   *
   * The value is clamped to 0–100.
   */
  markCalibrated(position: number): void {
    const prev = this.state;
    this.state = { phase: 'stopped', position: clamp(position, 0, 100) };
    this.log(`${describeState(prev)} -> ${describeState(this.state)} (markCalibrated)`);
    this.save();
  }

  /**
   * Begin a calibration move in the given direction.
   * Returns a movement plan for full travel + extra time.
   */
  startCalibration(direction: 'up' | 'down', pendingTarget?: number): MovementPlan {
    const travelTimeSec = direction === 'up'
      ? this.config.travelTimeUpSec
      : this.config.travelTimeDownSec;
    const durationMs = (travelTimeSec + this.config.calibrationExtraSec) * 1000;

    const prev = this.state;
    const nextState: CalibratingState = {
      phase: 'calibrating',
      direction,
      startedAt: this.now(),
    };
    this.state = pendingTarget === undefined ? nextState : { ...nextState, pendingTarget };
    this.log(`${describeState(prev)} -> ${describeState(this.state)} (${durationMs}ms)`);

    return { direction, durationMs, isCalibration: true };
  }

  /** Persist current state to disk. */
  save(): void {
    const store = this.loadStore();
    const pos = this.getCurrentPosition();

    store[this.config.deviceId] = {
      position: pos ?? 0,
      phase: this.state.phase,
      lastUpdated: new Date().toISOString(),
    };

    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(store, null, 2), 'utf-8');
    } catch {
      // Non-fatal — we'll just lose position on next restart
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private interpolatePosition(moving: MovingState): number {
    const elapsed = this.now() - moving.startedAt;
    const travelTimeSec = moving.direction === 'up'
      ? this.config.travelTimeUpSec
      : this.config.travelTimeDownSec;

    const totalTravel = Math.abs(moving.to - moving.from);
    const expectedDurationMs = (totalTravel / 100) * travelTimeSec * 1000;

    // How far we've gone as a fraction of the expected movement duration
    const fraction = expectedDurationMs > 0 ? Math.min(elapsed / expectedDurationMs, 1) : 1;
    // Scale to the actual travel range
    const delta = totalTravel * fraction;

    if (moving.direction === 'up') {
      return clamp(moving.from + delta, 0, 100);
    }
    return clamp(moving.from - delta, 0, 100);
  }

  private loadState(): TrackerState {
    const store = this.loadStore();
    const persisted = store[this.config.deviceId];

    if (!persisted) {
      return { phase: 'unknown' };
    }

    // If we crashed mid-movement or were explicitly marked unknown, need recalibration
    if (persisted.phase === 'moving' || persisted.phase === 'calibrating' || persisted.phase === 'unknown') {
      return { phase: 'unknown' };
    }

    return { phase: 'stopped', position: clamp(persisted.position, 0, 100) };
  }

  private loadStore(): PersistedStore {
    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      return JSON.parse(raw) as PersistedStore;
    } catch {
      return {};
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function fmtPos(pos: number): string {
  return `${Math.round(pos)}%`;
}

function describeState(state: TrackerState): string {
  switch (state.phase) {
    case 'unknown':
      return 'unknown';
    case 'stopped':
      return `stopped@${fmtPos(state.position)}`;
    case 'moving':
      return `moving(${fmtPos(state.from)}->${fmtPos(state.to)}, ${state.direction})`;
    case 'calibrating':
      return `calibrating(${state.direction})`;
  }
}
