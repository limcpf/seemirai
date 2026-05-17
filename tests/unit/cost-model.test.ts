import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  CostModel,
  evaluateCost,
  resolveDefaultSafetyBufferBps,
} from "../../src/domain/index.js";

describe("cost model foundation", () => {
  const baseInput = {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    expectedReturnBps: "25.000000000000000001",
    entryFeeBps: "5",
    exitFeeBps: "5",
    spreadCostBpsP75: "1.25",
    expectedSlippageBpsP95: "2.333333333333333333",
    cancelRequotePenaltyBps: "0.1",
    evaluatedAt: new Date("2026-05-17T00:00:00.000Z"),
  } as const;

  it("calculates cost bps and margin with Decimal precision", () => {
    const decision = new CostModel().evaluate(baseInput);

    expect(decision.kind).toBe("ALLOW");
    expect(decision.reasonCode).toBe("cost_margin_ok");
    expect(decision.snapshot).toMatchObject({
      expected_return_bps: "25.000000000000000001",
      entry_fee_bps: "5",
      exit_fee_bps: "5",
      spread_cost_bps_p75: "1.25",
      expected_slippage_bps_p95: "2.333333333333333333",
      cancel_requote_penalty_bps: "0.1",
      cost_bps: "13.683333333333333333",
      safety_buffer_bps: "10",
      required_return_bps: "23.683333333333333333",
      margin_bps: "1.316666666666666668",
      trade_allowed: true,
      evaluated_at: "2026-05-17T00:00:00.000Z",
    });
  });

  it("rejects candidates below cost plus safety buffer", () => {
    const decision = evaluateCost({
      ...baseInput,
      expectedReturnBps: "23.68",
    });

    expect(decision.kind).toBe("REJECT");
    expect(decision.tradeAllowed).toBe(false);
    expect(decision.reasonCode).toBe("cost_margin_insufficient");
    expect(decision.snapshot).toMatchObject({
      required_return_bps: "23.683333333333333333",
      margin_bps: "-0.003333333333333333",
      trade_allowed: false,
    });
  });

  it("resolves default safety buffers for BTC/ETH and phase 1.5 top alts", () => {
    expect(resolveDefaultSafetyBufferBps("KRW-BTC")).toBe("10");
    expect(resolveDefaultSafetyBufferBps("KRW-ETH")).toBe("10");
    expect(resolveDefaultSafetyBufferBps("KRW-SOL", "TOP_ALT")).toBe("20");

    expect(
      evaluateCost({
        ...baseInput,
        market: "KRW-SOL",
        safetyBufferMarketCategory: "TOP_ALT",
      }).snapshot.safety_buffer_bps,
    ).toBe("20");
  });

  it("rejects candidates when a safety buffer cannot be resolved", () => {
    const decision = evaluateCost({
      ...baseInput,
      market: "KRW-SOL",
    });

    expect(decision).toMatchObject({
      kind: "REJECT",
      reasonCode: "missing_cost_input",
    });
    expect(decision.snapshot.missing_fields).toEqual(["safety_buffer_bps"]);
  });

  it("rejects missing or invalid cost inputs without throwing", () => {
    const { entryFeeBps: _entryFeeBps, ...inputWithoutEntryFee } = baseInput;
    const missingDecision = evaluateCost(inputWithoutEntryFee);
    const invalidDecision = evaluateCost({
      ...baseInput,
      expectedSlippageBpsP95: 0.1 as unknown as string,
    });
    const negativeCostDecision = evaluateCost({
      ...baseInput,
      cancelRequotePenaltyBps: "-0.01",
    });

    expect(missingDecision.reasonCode).toBe("missing_cost_input");
    expect(missingDecision.snapshot.missing_fields).toEqual(["entry_fee_bps"]);
    expect(invalidDecision.reasonCode).toBe("invalid_cost_input");
    expect(invalidDecision.snapshot.invalid_fields).toEqual(["expected_slippage_bps_p95"]);
    expect(negativeCostDecision.reasonCode).toBe("invalid_cost_input");
    expect(negativeCostDecision.snapshot.invalid_fields).toEqual(["cancel_requote_penalty_bps"]);
  });

  it("does not make trade eligibility better when a cost component increases", () => {
    const lowerCost = evaluateCost({
      ...baseInput,
      expectedReturnBps: "24",
      spreadCostBpsP75: "1",
    });
    const higherCost = evaluateCost({
      ...baseInput,
      expectedReturnBps: "24",
      spreadCostBpsP75: "3",
    });

    expect(lowerCost.tradeAllowed).toBe(true);
    expect(higherCost.tradeAllowed).toBe(false);
    expect(
      new Decimal(higherCost.snapshot.margin_bps ?? "0").lessThan(
        new Decimal(lowerCost.snapshot.margin_bps ?? "0"),
      ),
    ).toBe(true);
  });

  it("returns a JSON-safe snapshot for broker submission metadata", () => {
    const decision = evaluateCost(baseInput);
    const parsedSnapshot: unknown = JSON.parse(JSON.stringify(decision.snapshot));

    expect(parsedSnapshot).toMatchObject({
      exchange_id: "upbit_krw_spot",
      market: "KRW-BTC",
      cost_bps: "13.683333333333333333",
      trade_allowed: true,
    });
  });
});
