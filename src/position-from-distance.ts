export interface DistanceCalibration {
  /** Distance at the fully raised (100%) position. */
  minDistanceMm: number
  /** Distance at the fully lowered (0%) position. */
  maxDistanceMm: number
}

/**
 * Convert a calibrated distance reading to a HomeKit position percentage.
 * Values outside the calibrated range are clamped to an endpoint.
 */
export function positionFromDistance(
  distanceMm: number,
  calibration: DistanceCalibration,
): number | undefined {
  const { minDistanceMm, maxDistanceMm } = calibration

  if (
    !Number.isFinite(distanceMm) ||
    !Number.isFinite(minDistanceMm) ||
    !Number.isFinite(maxDistanceMm)
  ) {
    return undefined
  }

  const span = maxDistanceMm - minDistanceMm
  if (span <= 0) {
    return undefined
  }

  const rawPosition = ((maxDistanceMm - distanceMm) / span) * 100

  return Math.round(Math.max(0, Math.min(100, rawPosition)))
}
