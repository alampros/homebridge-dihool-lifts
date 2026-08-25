import { describe, expect, it } from 'vitest';
import { parseLiftSenseStatus } from './liftsense-esp32.js';

describe('parseLiftSenseStatus', () => {
  it('prefers the filtered distance and preserves the raw sample', () => {
    expect(parseLiftSenseStatus(JSON.stringify({
      distance_mm: 500,
      raw_distance_mm: 520,
      filtered_distance_mm: 505,
      filter_ready: true,
      sensor_timeout: false,
    }))).toEqual({ distanceMm: 505, rawDistanceMm: 520, sensorTimeout: false });
  });

  it('supports the legacy distance response', () => {
    expect(parseLiftSenseStatus(JSON.stringify({
      distance_mm: 500,
      sensor_timeout: false,
    }))).toEqual({ distanceMm: 500, rawDistanceMm: undefined, sensorTimeout: false });
  });

  it('treats a warming filter as unavailable', () => {
    expect(parseLiftSenseStatus(JSON.stringify({
      distance_mm: 0,
      raw_distance_mm: 500,
      filtered_distance_mm: 0,
      filter_ready: false,
      sensor_timeout: true,
    })).sensorTimeout).toBe(true);
  });

  it('rejects malformed responses', () => {
    expect(() => parseLiftSenseStatus('{"distance_mm":"500"}')).toThrow(
      'ESP32 returned an invalid status response',
    );
  });
});
