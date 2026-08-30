import assert from "node:assert/strict";
import test from "node:test";
import {
  baselineForPlan, buildPolicyProfile, normalizeRateLimits, planGroupFor, preflightJob, quotaPathFor, ttlForWindow,
} from "../src/policy.js";
import type { QuotaSnapshot } from "../src/types.js";
import { testConfig } from "./helpers.js";

const config = testConfig("state.sqlite");

test("normalizes active and multi-bucket windows, credits, and arbitrary long durations", () => {
  const normalized = normalizeRateLimits({
    rateLimits: {
      primary: { usedPercent: 40, windowDurationMins: 43_200, resetsAt: 2_000_000_100 },
      secondary: { usedPercent: 91, windowDurationMins: 300, resetsAt: 2_000_000_000 },
      planType: "plus", limitId: "codex", limitName: "Codex",
      credits: { hasCredits: true, unlimited: false, balance: "20" },
    },
    rateLimitsByLimitId: { other: { primary: { usedPercent: 4, windowDurationMins: 60 } } },
  });
  assert.equal(normalized.activeBucket.fiveHour?.remainingPercent, 9);
  assert.equal(normalized.activeBucket.longWindows[0]?.windowDurationMins, 43_200);
  assert.equal(normalized.activeBucket.credits?.hasCredits, true);
  assert.equal(normalized.buckets.other?.fiveHour, null);
  assert.equal(normalized.buckets.codex?.limitName, "Codex");
});

test("classifies an explicitly labelled reserve bucket as secondary without exposing a model name", () => {
  const normalized = normalizeRateLimits({
    rateLimits: { limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 300 } },
    rateLimitsByLimitId: { base_model_inference: {
      limitId: "base_model_inference", limitName: "gpt-reserve",
      primary: { usedPercent: 5, windowDurationMins: 10_080, resetsAt: 2_000_000_000 },
    } },
  });
  assert.equal(normalized.activeBucket.laneId, "primary");
  assert.equal(normalized.buckets.base_model_inference?.laneId, "secondary");
  assert.equal(normalized.laneBuckets.secondary?.longWindows[0]?.remainingPercent, 95);
});

test("maps every plan family to its configured baseline", () => {
  assert.equal(planGroupFor("free"), "free_go");
  assert.equal(planGroupFor("go"), "free_go");
  assert.equal(planGroupFor("prolite"), "pro");
  assert.equal(planGroupFor("enterprise_cbp_usage_based"), "flexible");
  assert.equal(planGroupFor("business"), "standard");
  assert.equal(planGroupFor("future-plan"), "unknown");
  assert.equal(baselineForPlan("free", config), 20);
  assert.equal(baselineForPlan("plus", config), 10);
  assert.equal(baselineForPlan("pro", config), 5);
  assert.equal(baselineForPlan(null, config), 15);
});

test("learned mean raises the baseline and override adjusts the effective threshold", () => {
  const cold = buildPolicyProfile("plus", 8, 2, 0, "long", config);
  const ready = buildPolicyProfile("plus", 8, 3, -2, "long", config);
  assert.equal(cold.effectiveThresholdPercent, 10);
  assert.equal(cold.confidence, "low");
  assert.equal(ready.automaticThresholdPercent, 12);
  assert.equal(ready.effectiveThresholdPercent, 10);
  assert.equal(ready.confidence, "ready");
});

function snapshot(remaining: number, profile = buildPolicyProfile("plus", null, 0, 0, "long", config), credits = false): QuotaSnapshot {
  const fiveHour = { usedPercent: 100 - remaining, remainingPercent: remaining, windowDurationMins: 300, resetsAt: null };
  const activeBucket = {
    limitId: "codex", limitName: "Codex", planType: "plus", fiveHour, weekly: null, longWindows: [],
    credits: credits ? { hasCredits: true, unlimited: false, balance: "10" } : null,
    individualLimit: null, spendControlReached: false, rateLimitReachedType: remaining === 0 ? "rate_limit_reached" : null,
    laneId: "primary" as const,
  };
  const quotaPath = quotaPathFor(activeBucket, profile.effectiveThresholdPercent);
  return {
    fiveHour, weekly: null, longWindows: [], activeBucket, buckets: { codex: activeBucket }, planType: "plus",
    rateLimitReachedType: activeBucket.rateLimitReachedType, recommendation: "continue", quotaPath,
    mayConsumeCredits: quotaPath === "credits", profile, fetchedAt: new Date(0).toISOString(),
    nextRefreshAt: new Date(1).toISOString(), stale: false, refreshInProgress: false,
    backoffUntil: null, source: "cache", error: null, lanes: { primary: {
      laneId: "primary", detection: "active_default", available: true, bucket: activeBucket,
      window: fiveHour, quotaPath, recommendation: "continue", mayConsumeCredits: quotaPath === "credits",
      profile, reason: null,
    } },
  };
}

test("preflight defers at the learned threshold and allows runtime credit bypass", () => {
  assert.equal(preflightJob(snapshot(10), "long", config).decision, "defer");
  const credit = preflightJob(snapshot(0, undefined, true), "long", config);
  assert.equal(credit.decision, "caution");
  assert.equal(credit.quotaPath, "credits");
  assert.equal(credit.mayConsumeCredits, true);
});

test("spend control prevents credit bypass", () => {
  const value = snapshot(0, undefined, true);
  if (!value.activeBucket) throw new Error("missing bucket");
  value.activeBucket.spendControlReached = true;
  assert.equal(preflightJob(value, "long", config).decision, "defer");
});

test("adaptive TTL follows quota bands and exhausted reset grace", () => {
  const window = (remainingPercent: number) => ({ usedPercent: 100 - remainingPercent, remainingPercent,
    windowDurationMins: 300, resetsAt: null });
  assert.equal(ttlForWindow(window(80), 0, config), 900_000);
  assert.equal(ttlForWindow(window(50), 0, config), 300_000);
  assert.equal(ttlForWindow(window(20), 0, config), 120_000);
  assert.equal(ttlForWindow(window(10), 0, config), 60_000);
  const now = 1_000_000;
  assert.equal(ttlForWindow({ ...window(0), resetsAt: new Date(now + 600_000).toISOString() }, now, config), 630_000);
});
