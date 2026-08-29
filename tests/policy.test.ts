import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRateLimits, preflightJob, ttlForWindow } from "../src/policy.js";
import type { QuotaSnapshot } from "../src/types.js";
import { testConfig } from "./helpers.js";

const config = testConfig("state.sqlite");

test("normalizes five-hour and weekly windows regardless of slot order", () => {
  const normalized = normalizeRateLimits({
    rateLimits: {
      primary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 2_000_000_100 },
      secondary: { usedPercent: 91, windowDurationMins: 300, resetsAt: 2_000_000_000 },
      planType: "plus",
    },
  });
  assert.equal(normalized.fiveHour?.remainingPercent, 9);
  assert.equal(normalized.weekly?.remainingPercent, 60);
  assert.equal(normalized.fiveHour?.windowDurationMins, 300);
});

test("uses a multi-bucket response and clamps malformed percentages", () => {
  const normalized = normalizeRateLimits({
    rateLimitsByLimitId: {
      other: { primary: { usedPercent: 4, windowDurationMins: 60 } },
      codex: { primary: { usedPercent: 140, windowDurationMins: 300 } },
    },
  });
  assert.equal(normalized.fiveHour?.usedPercent, 100);
  assert.equal(normalized.fiveHour?.remainingPercent, 0);
});

test("adaptive TTL follows the quota bands", () => {
  const window = (remainingPercent: number) => ({
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    windowDurationMins: 300,
    resetsAt: null,
  });
  assert.equal(ttlForWindow(window(80), 0, config), 900_000);
  assert.equal(ttlForWindow(window(50), 0, config), 300_000);
  assert.equal(ttlForWindow(window(20), 0, config), 120_000);
  assert.equal(ttlForWindow(window(10), 0, config), 60_000);
});

test("exhausted window waits through reset grace without polling", () => {
  const now = 1_000_000;
  assert.equal(ttlForWindow({
    usedPercent: 100,
    remainingPercent: 0,
    windowDurationMins: 300,
    resetsAt: new Date(now + 600_000).toISOString(),
  }, now, config), 630_000);
});

function snapshot(remaining: number | null, stale = false): QuotaSnapshot {
  return {
    fiveHour: remaining === null ? null : {
      usedPercent: 100 - remaining,
      remainingPercent: remaining,
      windowDurationMins: 300,
      resetsAt: null,
    },
    weekly: null,
    planType: "plus",
    rateLimitReachedType: null,
    recommendation: remaining !== null && remaining > 20 ? "continue" : remaining !== null && remaining <= 10 ? "checkpoint_and_defer" : "caution",
    fetchedAt: new Date(0).toISOString(),
    nextRefreshAt: new Date(1).toISOString(),
    stale,
    refreshInProgress: false,
    backoffUntil: null,
    source: "cache",
    error: null,
  };
}

test("preflight defers long work at ten percent but allows bounded small work", () => {
  assert.equal(preflightJob(snapshot(10), "long").decision, "defer");
  assert.equal(preflightJob(snapshot(10), "small").decision, "caution");
  assert.equal(preflightJob(snapshot(80), "long").decision, "allow");
});

test("preflight fails safe for unknown or stale low quota", () => {
  assert.equal(preflightJob(snapshot(null), "long").decision, "defer");
  assert.equal(preflightJob(snapshot(15, true), "long").decision, "defer");
});
