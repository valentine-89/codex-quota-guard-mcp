import type { QuotaBucket, QuotaSnapshot, QuotaLaneId } from "./types.js";

export const PACING_MAX_GAP_MS = 15 * 60_000;
export const PACING_RATE_MAX_AGE_MS = 5 * 60_000;
interface SampleWindow { id: string; reset: string; remaining: number; rates: number[] }
export interface PacingSample { identity: string; at: number; windows: SampleWindow[] }
export interface Pacing {
  confidence: "cold_start" | "low" | "ready" | "unavailable";
  sampleCount: number;
  burnRatePercentPerMinute: number | null;
  minutesToReserve: number | null;
  reservePercent: number;
  checkAgainBy: string;
  maxSegmentMinutes: number;
  reason: string;
}

function windows(bucket: QuotaBucket): SampleWindow[] {
  const all = [bucket.fiveHour, ...bucket.longWindows, bucket.individualLimit];
  if (all.some(w => w && (!w.resetsAt || !Number.isFinite(Date.parse(w.resetsAt))))) return [];
  return all.flatMap((w, i) =>
    w?.resetsAt && Number.isFinite(Date.parse(w.resetsAt))
      ? [{ id: `${i}:${"windowDurationMins" in w ? w.windowDurationMins : "individual"}`, reset: w.resetsAt, remaining: w.remainingPercent, rates: [] }] : []);
}

/** Only call with a new successful backend sample, never with a cache hit. */
export function samplePacing(previous: PacingSample | null, bucket: QuotaBucket, identity: string, at: number): PacingSample {
  const current = windows(bucket);
  const elapsed = previous ? at - previous.at : 0;
  const continuous = previous?.identity === identity && elapsed > 0 && elapsed <= PACING_MAX_GAP_MS
    && current.length > 0 && current.length === previous.windows.length
    && current.every((w, i) => w.id === previous.windows[i]!.id && w.reset === previous.windows[i]!.reset
      && w.remaining <= previous.windows[i]!.remaining && Date.parse(w.reset) > at);
  if (continuous) {
    current.forEach((w, i) => {
      const old = previous.windows[i]!;
      const history = elapsed <= PACING_RATE_MAX_AGE_MS ? old.rates : [];
      w.rates = [...history, (old.remaining - w.remaining) / (elapsed / 60_000)].slice(-4);
    });
  }
  return { identity, at, windows: current };
}

export function pacingFor(snapshot: QuotaSnapshot, laneId: QuotaLaneId, sample: PacingSample | null,
  identity: string | null, reservePercent: number, now: number): Pacing {
  const lane = snapshot.lanes[laneId];
  const unavailable = snapshot.stale || snapshot.refreshInProgress || !!snapshot.error || !!snapshot.backoffUntil || !lane?.available;
  const age = sample ? now - sample.at : Infinity;
  const usable = !unavailable && sample?.identity === identity && age >= 0 && age <= PACING_RATE_MAX_AGE_MS;
  const count = usable && sample.windows.length ? Math.min(...sample.windows.map(w => w.rates.length + 1), 5) : 0;
  const rate = usable ? Math.max(0, ...sample.windows.flatMap(w => w.rates)) * 1.5 : 0;
  const budgets = usable ? sample.windows.flatMap(w => {
    const speed = Math.max(0, ...w.rates) * 1.5;
    return speed > 0 ? [Math.max(0, (w.remaining - reservePercent) / speed - age / 60_000)] : [];
  }) : [];
  const minutesToReserve = budgets.length ? Math.min(...budgets) : null;
  const confidence = unavailable ? "unavailable" : count >= 3 ? "ready" : count >= 2 ? "low" : "cold_start";
  const urgent = confidence !== "ready" || lane?.recommendation !== "continue" || rate >= 1
    || (minutesToReserve !== null && minutesToReserve <= 10);
  const interval = urgent ? 30_000 : 60_000;
  // Deadlines are anchored to the backend read: repeated cache calls never renew them.
  const fetched = snapshot.fetchedAt ? Date.parse(snapshot.fetchedAt) : now;
  const deadline = unavailable ? Math.max(now + 30_000, Date.parse(snapshot.nextRefreshAt))
    : Math.min(fetched + interval, minutesToReserve === null || lane?.quotaPath !== "included" ? Infinity : now + minutesToReserve * 60_000);
  return { confidence, sampleCount: Number.isFinite(count) ? count : 0,
    burnRatePercentPerMinute: rate > 0 ? rate : null, minutesToReserve, reservePercent,
    checkAgainBy: new Date(deadline).toISOString(),
    maxSegmentMinutes: unavailable ? 0 : Math.max(0, Math.min(interval / 60_000, (deadline - now) / 60_000)),
    reason: unavailable ? "quota_unavailable" : confidence === "cold_start" ? "fresh_samples_required"
      : urgent ? "short_segment_required" : "bounded_active_work" };
}
