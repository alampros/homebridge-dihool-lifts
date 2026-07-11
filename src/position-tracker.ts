/**
 * Binary state tracker for motorized lifts with hardware limit switches.
 *
 * Tracks only two positions: 0% (down) and 100% (up). The software sends a
 * single pulse to start movement and never sends a stop pulse — hardware
 * limit switches handle all stopping.
 *
 * Persists state to disk so position survives Homebridge restarts.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

/** Motor is stopped at a known binary position. */
interface StoppedState {
  readonly phase: 'stopped';
  /** Known position: 0 = down, 100 = up. */
  readonly position: 0 | 100;
}

/** Motor is running in a direction. */
interface MovingState {
  readonly phase: 'moving';
  readonly direction: 'up' | 'down';
  /** Timestamp (ms) when movement started. */
  readonly startedAt: number;
}

export type LiftState = Readonly<StoppedState | MovingState>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LiftStateConfig {
  /** Device ID — used as the persistence key. */
  deviceId: string;
  /** Full travel time going up, in seconds. Used only for the cosmetic "settled" timer. */
  travelTimeUpSec: number;
  /** Full travel time going down, in seconds. Used only for the cosmetic "settled" timer. */
  travelTimeDownSec: number;
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
  position: 0 | 100;
  phase: 'stopped' | 'moving';
  lastUpdated: string;
}

type PersistedStore = Record<string, PersistedDeviceState>;

// ---------------------------------------------------------------------------
// LiftStateTracker
// ---------------------------------------------------------------------------

export class LiftStateTracker {
  private state: LiftState;
  private readonly config: Readonly<LiftStateConfig>;
  private readonly persistPath: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(config: LiftStateConfig) {
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
  getState(): LiftState {
    return this.state;
  }

  /**
   * Get the last known binary position.
   * When stopped, returns the stopped position.
   * When moving, returns the position we WERE at before starting movement.
   */
  getPosition(): 0 | 100 {
    if (this.state.phase === 'stopped') {
      return this.state.position;
    }
    // Moving: return the opposite of the direction (where we came from)
    return this.state.direction === 'up' ? 0 : 100;
  }

  /**
   * Begin movement in the given direction.
   *
   * Returns `true` if the caller should send a pulse to start/reverse the motor.
   * Returns `false` if no pulse is needed (already moving in that direction,
   * or already stopped at the destination).
   */
  startMovement(direction: 'up' | 'down'): boolean {
    if (this.state.phase === 'moving') {
      if (this.state.direction === direction) {
        this.log(`Already moving ${direction}, ignoring`);
        return false;
      }
      // Reversing direction
      const prev = this.state;
      this.state = { phase: 'moving', direction, startedAt: this.now() };
      this.log(`${describeState(prev)} -> ${describeState(this.state)} (reverse)`);
      this.save();
      return true;
    }

    // Stopped
    if (this.state.position === 100 && direction === 'up') {
      this.log('Already at top, ignoring up command');
      return false;
    }
    if (this.state.position === 0 && direction === 'down') {
      this.log('Already at bottom, ignoring down command');
      return false;
    }

    const prev = this.state;
    this.state = { phase: 'moving', direction, startedAt: this.now() };
    this.log(`${describeState(prev)} -> ${describeState(this.state)}`);
    this.save();
    return true;
  }

  /**
   * Returns the timestamp (ms) at which the motor should have reached its
   * destination, based on travel time. Used by the accessory for the cosmetic
   * HomeKit timer.
   *
   * Throws if not in moving state.
   */
  settledAt(): number {
    if (this.state.phase !== 'moving') {
      throw new Error('Cannot compute settledAt: not moving');
    }
    const travelTimeSec = this.state.direction === 'up'
      ? this.config.travelTimeUpSec
      : this.config.travelTimeDownSec;
    return this.state.startedAt + travelTimeSec * 1000;
  }

  /**
   * Called when the cosmetic timer fires. Transitions from moving to stopped
   * at the destination (up→100, down→0) and persists.
   */
  completeMovement(): void {
    if (this.state.phase !== 'moving') {
      return;
    }

    const prev = this.state;
    const position: 0 | 100 = this.state.direction === 'up' ? 100 : 0;
    this.state = { phase: 'stopped', position };
    this.log(`${describeState(prev)} -> ${describeState(this.state)} (complete)`);
    this.save();
  }

  /** Persist current state to disk. */
  save(): void {
    const store = this.loadStore();

    store[this.config.deviceId] = {
      position: this.getPosition(),
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

  private loadState(): LiftState {
    const store = this.loadStore();
    const persisted = store[this.config.deviceId];

    if (!persisted) {
      return { phase: 'stopped', position: 0 };
    }

    // Crash recovery: if we were moving, assume the lift fell to bottom
    if (persisted.phase === 'moving') {
      this.log('Recovering from crash during movement — assuming at bottom');
      return { phase: 'stopped', position: 0 };
    }

    const pos = persisted.position === 100 ? 100 : 0;
    return { phase: 'stopped', position: pos };
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

function describeState(state: LiftState): string {
  switch (state.phase) {
    case 'stopped':
      return `stopped@${state.position}%`;
    case 'moving':
      return `moving(${state.direction})`;
  }
}
