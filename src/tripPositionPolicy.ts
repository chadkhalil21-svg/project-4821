/**
 * Economical automatic in-Travel GPS publication.
 *
 * The phone continues sampling locally; it does not need a button press.
 * Publish a moving position at most every 30 seconds and a stationary
 * freshness position at most every 60 seconds. This maintains the server's
 * five-minute stale-position and six-minute stationary check-in safeguards.
 *
 * These intervals are initial policy, not physical-device latency evidence.
 */
export const MOVING_REPORT_MS = 30_000;
export const STATIONARY_REPORT_MS = 60_000;
export const MOVEMENT_RADIUS_MI = 0.03;

export function shouldPublishTripPosition({
  elapsedMs, moved, hasPublished,
}: {
  elapsedMs: number; moved: boolean; hasPublished: boolean;
}): boolean {
  if (!hasPublished) return true;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return false;
  return elapsedMs >= (moved ? MOVING_REPORT_MS : STATIONARY_REPORT_MS);
}
