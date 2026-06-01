import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluatePhase15AltEligibility } from "../../src/domain/index.js";
import type {
  MarketStatus,
  Phase15AltEligibilityInput,
  Phase15AltEligibilityThresholds,
} from "../../src/domain/index.js";

interface Phase15EligibilityFixture {
  thresholds: Phase15AltEligibilityThresholds;
  healthy: Omit<Phase15AltEligibilityInput, "thresholds"> & {
    marketStatus: MarketStatus;
  };
  blocked: Omit<Phase15AltEligibilityInput, "thresholds"> & {
    marketStatus: MarketStatus;
  };
}

const fixtureUrl = new URL("../fixtures/phase-1-5/alt-eligibility.json", import.meta.url);

describe("phase 1.5 alt eligibility evaluator", () => {
  it("returns approval evidence when every manual inclusion condition passes", async () => {
    const fixture = await loadFixture();
    const decision = evaluatePhase15AltEligibility({
      ...fixture.healthy,
      thresholds: fixture.thresholds,
      approvedBy: "operator",
      evidenceId: "phase15:KRW-SOL:2026-06-01",
      source: "unit-fixture",
    });

    expect(decision).toMatchObject({
      eligible: true,
      reasonCode: "phase_1_5_alt_eligible",
      failedConditions: [],
      evidence: {
        exchangeId: "upbit_krw_spot",
        market: "KRW-SOL",
        action: "APPROVE",
        observedAt: "2026-06-01T00:00:00.000Z",
        approvedBy: "operator",
        evidenceId: "phase15:KRW-SOL:2026-06-01",
        source: "unit-fixture",
      },
    });
    expect(decision.evidence.conditions.map((condition) => condition.reasonCode)).toEqual([
      "phase_1_5_listing_age_sufficient",
      "phase_1_5_market_warning_absent",
      "phase_1_5_market_caution_absent",
      "phase_1_5_30d_trade_value_sufficient",
      "phase_1_5_spread_p95_within_limit",
      "phase_1_5_expected_slippage_within_limit",
      "phase_1_5_depth_sufficient",
    ]);
  });

  it("fails closed and preserves every failed condition in evidence", async () => {
    const fixture = await loadFixture();
    const decision = evaluatePhase15AltEligibility({
      ...fixture.blocked,
      thresholds: fixture.thresholds,
    });

    expect(decision.eligible).toBe(false);
    expect(decision.reasonCode).toBe("phase_1_5_alt_ineligible");
    expect(decision.evidence.action).toBe("REJECT");
    expect(decision.failedConditions.map((condition) => condition.reasonCode)).toEqual([
      "phase_1_5_listing_age_too_young",
      "phase_1_5_market_warning_present",
      "phase_1_5_market_caution_present",
      "phase_1_5_30d_trade_value_insufficient",
      "phase_1_5_spread_p95_too_wide",
      "phase_1_5_expected_slippage_too_high",
      "phase_1_5_depth_insufficient",
    ]);
    expect(decision.evidence.conditions).toHaveLength(7);
  });

  it("treats missing, invalid, or mismatched inputs as ineligible evidence", async () => {
    const fixture = await loadFixture();
    const {
      thirtyDayAverageTradeValueKrw: _thirtyDayAverageTradeValueKrw,
      expectedSlippageBps: _expectedSlippageBps,
      ...inputWithMissingMetrics
    } = fixture.healthy;
    const decision = evaluatePhase15AltEligibility({
      ...inputWithMissingMetrics,
      listingAgeDays: Number.NaN,
      marketStatus: {
        ...fixture.healthy.marketStatus,
        market: "KRW-ETH",
      },
      sevenDaySpreadP95Bps: "-1",
      depthKrw: "-10",
      thresholds: fixture.thresholds,
    });

    expect(decision.eligible).toBe(false);
    expect(decision.evidence.action).toBe("REJECT");
    expect(decision.failedConditions.map((condition) => condition.reasonCode)).toEqual([
      "phase_1_5_listing_age_invalid",
      "phase_1_5_market_status_mismatch",
      "phase_1_5_market_status_mismatch",
      "phase_1_5_30d_trade_value_missing",
      "phase_1_5_spread_p95_invalid",
      "phase_1_5_expected_slippage_missing",
      "phase_1_5_depth_invalid",
    ]);
    expect(
      decision.failedConditions.find((condition) => condition.reasonCode === "phase_1_5_market_status_mismatch")
        ?.metadata,
    ).toMatchObject({
      context_market: "KRW-SOL",
      status_market: "KRW-ETH",
    });
    expect(
      decision.failedConditions.find((condition) => condition.reasonCode === "phase_1_5_listing_age_invalid")
        ?.actualValue,
    ).toBe("NaN");
  });

  it("does not treat MVP universe membership as a candidate eligibility failure", async () => {
    const fixture = await loadFixture();
    const decision = evaluatePhase15AltEligibility({
      ...fixture.healthy,
      marketStatus: {
        ...fixture.healthy.marketStatus,
        tradable: false,
        reasonCodes: ["market_not_in_mvp_universe:KRW-SOL"],
      },
      thresholds: fixture.thresholds,
    });

    expect(decision.eligible).toBe(true);
    expect(decision.evidence.action).toBe("APPROVE");
    expect(decision.failedConditions).toEqual([]);
  });
});

async function loadFixture(): Promise<Phase15EligibilityFixture> {
  const raw = await readFile(fileURLToPath(fixtureUrl), "utf8");
  return JSON.parse(raw) as Phase15EligibilityFixture;
}
