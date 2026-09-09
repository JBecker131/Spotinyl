/**
 * Tonearm geometry.
 *
 * Angles are positive "swing" amounts in degrees, measured from the arm rest.
 * The CSS negates them, because the arm pivots on the right of the deck and
 * swings counter-clockwise onto the record.
 */

export const ARM_PARKED_DEG = 0;
export const ARM_LEAD_IN_DEG = 18;
export const ARM_INNER_DEG = 32;

export function progressRatio(progressMs, durationMs) {
  if (!Number.isFinite(progressMs) || !Number.isFinite(durationMs)) return 0;
  if (durationMs <= 0) return 0;
  const ratio = progressMs / durationMs;
  if (ratio < 0) return 0;
  if (ratio > 1) return 1;
  return ratio;
}

export function armAngle({ hasTrack, progressMs, durationMs }) {
  if (!hasTrack) return ARM_PARKED_DEG;
  const ratio = progressRatio(progressMs, durationMs);
  return ARM_LEAD_IN_DEG + ratio * (ARM_INNER_DEG - ARM_LEAD_IN_DEG);
}
