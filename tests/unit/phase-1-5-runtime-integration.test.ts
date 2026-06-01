import { describe, expect, it } from "vitest";
import {
  createUniverseAllowedRule,
  evaluateRules,
} from "../../src/application/index.js";
import {
  evaluateCost,
} from "../../src/domain/index.js";
import type {
  CostModelInput,
  MarketStatus,
  RuleContext,
  SafetyBufferMarketCategory,
} from "../../src/domain/index.js";
import {
  toMarketStatus,
} from "../../src/infrastructure/upbit/index.js";
import {
  loadRuntimeConfig,
  resolveRuntimeSafetyBufferMarketCategory,
  resolveRuntimeUniverse,
} from "../../src/runtime/index.js";

const observedAt = "2026-06-01T00:00:00.000Z";

describe("phase 1.5 runtime integration", () => {
  it("adds only active manual approvals to policy and rule allowed markets", async () => {
    const config = loadRuntimeConfig({
      universe: {
        phase_1_5: {
          enabled: true,
          manual_approvals: [
            {
              market: "KRW-SOL",
              approved_at: "2026-05-31T00:00:00.000Z",
              evidence_id: "phase15:KRW-SOL:2026-05-31",
            },
            {
              market: "KRW-XRP",
              approved_at: "2026-05-01T00:00:00.000Z",
              expires_at: "2026-05-31T23:59:59.000Z",
            },
          ],
        },
      },
    });
    const universe = resolveRuntimeUniverse(config.universe, { observedAt });

    expect(universe.allowedMarkets).toEqual(["KRW-BTC", "KRW-ETH", "KRW-SOL"]);
    expect(universe.phase15ApprovedAltMarkets).toEqual(["KRW-SOL"]);
    expect(universe.phase15ExpiredAltMarkets).toEqual(["KRW-XRP"]);

    expect(toPolicyStatus("KRW-SOL", universe.allowedMarkets)).toMatchObject({
      tradable: true,
      warning: false,
      caution: false,
    });
    expect(toPolicyStatus("KRW-XRP", universe.allowedMarkets)).toMatchObject({
      tradable: false,
      reasonCodes: ["market_not_in_mvp_universe:KRW-XRP"],
    });

    const passResult = await evaluateRules(
      [createUniverseAllowedRule({ allowedMarkets: universe.allowedMarkets })],
      createRuleContext("KRW-SOL", toPolicyStatus("KRW-SOL", universe.allowedMarkets), universe.allowedMarkets),
    );
    const failResult = await evaluateRules(
      [createUniverseAllowedRule({ allowedMarkets: universe.allowedMarkets })],
      createRuleContext("KRW-XRP", toPolicyStatus("KRW-XRP", universe.allowedMarkets), universe.allowedMarkets),
    );

    expect(passResult.passed).toBe(true);
    expect(failResult.failedEvaluations).toMatchObject([
      {
        reasonCode: "universe_not_allowed",
      },
    ]);
  });

  it("keeps warning and caution as new-entry blockers even when an alt is manually approved", () => {
    const config = loadRuntimeConfig({
      universe: {
        phase_1_5: {
          enabled: true,
          manual_approvals: [
            {
              market: "KRW-SOL",
              approved_at: "2026-05-31T00:00:00.000Z",
            },
          ],
        },
      },
    });
    const universe = resolveRuntimeUniverse(config.universe, { observedAt });

    const warningStatus = toMarketStatus(
      {
        market: "KRW-SOL",
        korean_name: "솔라나",
        english_name: "Solana",
        market_event: {
          warning: true,
          caution: false,
        },
      },
      { allowedMarkets: universe.allowedMarkets, observedAt },
    );
    const cautionStatus = toMarketStatus(
      {
        market: "KRW-SOL",
        korean_name: "솔라나",
        english_name: "Solana",
        market_event: {
          warning: false,
          caution: true,
        },
      },
      { allowedMarkets: universe.allowedMarkets, observedAt },
    );

    expect(warningStatus).toMatchObject({
      tradable: false,
      warning: true,
      reasonCodes: ["market_warning"],
    });
    expect(cautionStatus).toMatchObject({
      tradable: false,
      caution: true,
      reasonCodes: ["market_caution:ANY"],
    });
  });

  it("applies TOP_ALT 20 bps safety buffer only to approved phase 1.5 alts", () => {
    const config = loadRuntimeConfig({
      universe: {
        phase_1_5: {
          enabled: true,
          manual_approvals: [
            {
              market: "KRW-SOL",
              approved_at: "2026-05-31T00:00:00.000Z",
            },
          ],
        },
      },
    });
    const universe = resolveRuntimeUniverse(config.universe, { observedAt });
    const approvedAltCostDecision = evaluateCost(createAltCostInput(
      "KRW-SOL",
      resolveRuntimeSafetyBufferMarketCategory("KRW-SOL", universe),
    ));
    const unapprovedAltCostDecision = evaluateCost(createAltCostInput(
      "KRW-XRP",
      resolveRuntimeSafetyBufferMarketCategory("KRW-XRP", universe),
    ));

    expect(approvedAltCostDecision.snapshot).toMatchObject({
      safety_buffer_bps: "20",
      required_return_bps: "32",
      trade_allowed: true,
    });
    expect(unapprovedAltCostDecision).toMatchObject({
      kind: "REJECT",
      reasonCode: "missing_cost_input",
    });
    expect(unapprovedAltCostDecision.snapshot.missing_fields).toEqual(["safety_buffer_bps"]);
  });

  it("keeps rejected eligibility evidence out of the approved runtime universe", () => {
    const config = loadRuntimeConfig({
      universe: {
        phase_1_5: {
          enabled: true,
          manual_approvals: [
            {
              market: "KRW-SOL",
              approved_at: "2026-05-31T00:00:00.000Z",
            },
          ],
        },
      },
    });
    const universe = resolveRuntimeUniverse(config.universe, {
      observedAt,
      evidence: [
        {
          exchangeId: "upbit_krw_spot",
          market: "KRW-SOL",
          action: "REJECT",
          observedAt,
          thresholds: {
            minListingAgeDays: 90,
            minThirtyDayAverageTradeValueKrw: "10000000000",
            maxSevenDaySpreadP95Bps: "15",
            maxExpectedSlippageBps: "20",
            minDepthKrw: "100000000",
          },
          conditions: [],
        },
      ],
    });

    expect(universe.allowedMarkets).toEqual(["KRW-BTC", "KRW-ETH"]);
    expect(universe.phase15ApprovedAltMarkets).toEqual([]);
    expect(universe.phase15RejectedAltMarkets).toEqual(["KRW-SOL"]);
  });
});

function createAltCostInput(
  market: string,
  marketCategory: SafetyBufferMarketCategory | undefined,
): CostModelInput {
  const input: CostModelInput = {
    exchangeId: "upbit_krw_spot",
    market,
    expectedReturnBps: "35",
    entryFeeBps: "5",
    exitFeeBps: "5",
    spreadCostBpsP75: "1",
    expectedSlippageBpsP95: "1",
    cancelRequotePenaltyBps: "0",
  };

  if (marketCategory !== undefined) {
    input.safetyBufferMarketCategory = marketCategory;
  }

  return input;
}

function toPolicyStatus(market: string, allowedMarkets: readonly string[]): MarketStatus {
  return toMarketStatus(
    {
      market,
      korean_name: "테스트",
      english_name: "Test",
      market_event: {
        warning: false,
        caution: false,
      },
    },
    { allowedMarkets, observedAt },
  );
}

function createRuleContext(
  market: string,
  marketStatus: MarketStatus,
  allowedMarkets: readonly string[],
): RuleContext {
  return {
    exchangeId: "upbit_krw_spot",
    market,
    observedAt,
    universe: {
      allowedMarkets,
    },
    marketStatus,
  };
}
