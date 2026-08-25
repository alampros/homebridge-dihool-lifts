import { describe, expect, it } from 'vitest';
import { MedianFilter } from './median-filter.js';

describe('MedianFilter', () => {
  it('waits for the minimum sample count', () => {
    const filter = new MedianFilter(5, 3);

    expect(filter.add(100)).toBeUndefined();
    expect(filter.add(102)).toBeUndefined();
    expect(filter.add(98)).toBe(100);
  });

  it('suppresses a single short-lived impulse', () => {
    const filter = new MedianFilter(5, 3);

    filter.add(100);
    filter.add(102);
    expect(filter.add(1000)).toBe(102);
    expect(filter.add(99)).toBe(101);
    expect(filter.add(101)).toBe(101);
  });

  it('tracks a sustained change once it fills the rolling window', () => {
    const filter = new MedianFilter(3, 3);

    filter.add(100);
    filter.add(100);
    expect(filter.add(100)).toBe(100);
    expect(filter.add(500)).toBe(100);
    expect(filter.add(500)).toBe(500);
  });

  it('clears prior readings on reset', () => {
    const filter = new MedianFilter(5, 3);
    filter.add(100);
    filter.add(101);
    filter.add(102);

    filter.reset();

    expect(filter.add(200)).toBeUndefined();
  });
});
