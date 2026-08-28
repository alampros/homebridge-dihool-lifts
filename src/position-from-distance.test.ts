import { describe, expect, it } from 'vitest'

import { positionFromDistance } from './position-from-distance.js'

describe('positionFromDistance', () => {
  it('maps the configured maximum distance to 0% and minimum to 100%', () => {
    const calibration = {
      minDistanceMm: 200,
      maxDistanceMm: 1000,
    }

    expect(positionFromDistance(1000, calibration)).toBe(0)
    expect(positionFromDistance(600, calibration)).toBe(50)
    expect(positionFromDistance(200, calibration)).toBe(100)
  })

  it('clamps readings outside the calibrated range', () => {
    const calibration = {
      minDistanceMm: 200,
      maxDistanceMm: 1000,
    }

    expect(positionFromDistance(1200, calibration)).toBe(0)
    expect(positionFromDistance(100, calibration)).toBe(100)
  })

  it('rejects calibration whose minimum and maximum are reversed', () => {
    expect(
      positionFromDistance(500, {
        minDistanceMm: 1000,
        maxDistanceMm: 200,
      }),
    ).toBeUndefined()
  })

  it('rejects non-finite readings', () => {
    expect(
      positionFromDistance(Number.NaN, {
        minDistanceMm: 200,
        maxDistanceMm: 1000,
      }),
    ).toBeUndefined()
  })
})
