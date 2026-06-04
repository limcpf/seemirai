import { describe, expect, it, vi } from "vitest";
import {
  calculatePnLAccounting,
  PnLAccountingInvariantError,
  formatPnLAccountingStatus,
  formatMissingReason,
  labelMissingReasonCode,
  buildSourceLabel,
  createSnapshotCoverage,
  resolvePnLSources,
  scopeKey,
} from "../../src/application/index.js";
import type {
  PnLAccountingInput,
  PnLCashFact,
  PnLFillFact,
  PnLMarkPriceFact,
  PnLPositionFact,
  PnLReconcileFact,
  PnLSource,
  PnLSnapshotFact,
} from "../../src/application/index.js";

// ── 기본 fixture ─────────────────────────────────────────────────────────────

function defaultCash(): PnLCashFact {
  return {
    availableKrw: "1000000",
    lockedKrw: "0",
    totalKrw: "1000000",
    source: "paper_broker",
    observedAt: new Date("2026-06-01T00:00:00Z"),
  };
}

function buyFill(
  orderId: string,
  market: string,
  quantity: string,
  price: string,
  fee: string,
  strategyId = "trend_following",
): PnLFillFact {
  const totalNotional = (
    BigInt(Math.round(parseFloat(quantity) * parseFloat(price) * 1e8)) /
    BigInt(1e8)
  ).toString();
  // 간단한 계산: quantity * price = notional
  const q = parseFloat(quantity);
  const p = parseFloat(price);
  const notional = (q * p).toFixed(8).replace(/\.?0+$/, "");
  return {
    orderId,
    strategyId,
    market,
    side: "BUY",
    price,
    quantity,
    fee,
    feeCurrency: "KRW",
    liquidity: "TAKER",
    filledAt: new Date("2026-06-01T00:00:00Z"),
  };
}

function sellFill(
  orderId: string,
  market: string,
  quantity: string,
  price: string,
  fee: string,
  strategyId = "trend_following",
): PnLFillFact {
  const q = parseFloat(quantity);
  const p = parseFloat(price);
  const notional = (q * p).toFixed(8).replace(/\.?0+$/, "");
  return {
    orderId,
    strategyId,
    market,
    side: "SELL",
    price,
    quantity,
    fee,
    feeCurrency: "KRW",
    liquidity: "TAKER",
    filledAt: new Date("2026-06-01T00:00:00Z"),
  };
}

function markPrice(market: string, priceKrw: string): PnLMarkPriceFact {
  return {
    market,
    priceKrw,
    source: "fixture_bid",
    observedAt: new Date("2026-06-01T00:00:00Z"),
  };
}

// ── 테스트 ──────────────────────────────────────────────────────────────────

describe("M17 PnL accounting calculator", () => {
  describe("fill 기반 실현손익", () => {
    it("BUY 후 SELL 시 실현손익을 정확히 계산한다", () => {
      const input: PnLAccountingInput = {
        fills: [
          buyFill("b1", "KRW-BTC", "0.01", "100000000", "50"),
          sellFill("s1", "KRW-BTC", "0.01", "101000000", "50"),
        ],
        positions: [],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      // 실현손익: 0.01*101M - 50 - (0.01*100M + 50) = 1,009,950 - 1,000,050 = 9,900
      // 총 수수료 100
      expect(result.status).toBe("CALCULATED");
      expect(result.realizedPnlKrw).not.toBeNull();
      expect(parseFloat(result.realizedPnlKrw!)).toBeCloseTo(9900, -2);
      expect(result.unrealizedPnlKrw).toBe("0"); // 포지션 완전 청산 → MTM 대상 없음, 0으로 확정
      expect(result.cashKrw).not.toBeNull();
      expect(result.totalPnlKrw).not.toBeNull();
    });

    it("여러 번의 부분 매수와 매도에서 평균단가 기반 실현손익을 계산한다", () => {
      const fills: PnLFillFact[] = [
        buyFill("b1", "KRW-BTC", "0.01", "100000000", "50"),
        buyFill("b2", "KRW-BTC", "0.02", "110000000", "110"),
        sellFill("s1", "KRW-BTC", "0.015", "108000000", "81"),
      ];

      const input: PnLAccountingInput = {
        fills,
        positions: [],
        markPrices: [markPrice("KRW-BTC", "107000000")],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      // 매수: 0.01@100M, 0.02@110M → 매수원가 = (1,000,000+2,200,000+160)/0.03 = 106,672,000/BTC
      // 매도 0.015@108M → 실현원가 = 0.015*106,672,000 = 1,600,080
      // 매도대금 = 0.015*108M = 1,620,000
      // 실현손익 = 1,620,000 - 1,600,080 - 수수료(81+50+110=241) ≈ 19,839
      expect(result.status).toBe("CALCULATED");
      expect(result.realizedPnlKrw).not.toBeNull();
      const realized = parseFloat(result.realizedPnlKrw!);
      expect(realized).toBeGreaterThan(0);
      // 약 19,839 KRW
      expect(realized).toBeCloseTo(19839, 0);

      // 남은 포지션 평가
      expect(result.positions).toHaveLength(1);
      const btcPos = result.positions.find((p) => p.market === "KRW-BTC");
      expect(btcPos).toBeDefined();
      expect(btcPos!.averageEntryPrice).not.toBeNull();
      expect(btcPos!.unrealizedPnlKrw).not.toBeNull();
    });

    it("초과 매도 시 invariant error로 실패한다", () => {
      const input: PnLAccountingInput = {
        fills: [
          sellFill("s1", "KRW-BTC", "0.01", "100000000", "50"),
        ],
        positions: [],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      expect(() => calculatePnLAccounting(input)).toThrow(
        PnLAccountingInvariantError,
      );
    });

    it("입력 순서가 뒤섞여도 filledAt 기준으로 실현손익을 계산한다", () => {
      const buy = {
        ...buyFill("b1", "KRW-BTC", "0.01", "100000000", "50"),
        filledAt: new Date("2026-06-01T00:00:00Z"),
      };
      const sell = {
        ...sellFill("s1", "KRW-BTC", "0.01", "101000000", "50"),
        filledAt: new Date("2026-06-01T00:01:00Z"),
      };

      const input: PnLAccountingInput = {
        fills: [sell, buy],
        positions: [],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.status).toBe("CALCULATED");
      expect(result.realizedPnlKrw).toBe("9900");
      expect(result.totalPnlKrw).toBe("9900");
    });

    it("비-KRW 수수료는 KRW 원가와 실현손익에 섞지 않는다", () => {
      const input: PnLAccountingInput = {
        fills: [
          {
            ...buyFill("b1", "KRW-BTC", "0.01", "100000000", "0.00001"),
            feeCurrency: "BTC",
          },
        ],
        positions: [],
        markPrices: [markPrice("KRW-BTC", "101000000")],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.unrealizedPnlKrw).toBe("10000");
      expect(result.feeTotals).toEqual([{ currency: "BTC", amount: "0.00001" }]);
    });
  });

  describe("MTM 미실현손익", () => {
    it("평가가가 주어지면 미실현손익을 계산한다", () => {
      const input: PnLAccountingInput = {
        fills: [
          buyFill("b1", "KRW-BTC", "0.01", "100000000", "50"),
        ],
        positions: [],
        markPrices: [markPrice("KRW-BTC", "101000000")],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      // 미실현손익: 0.01 * 101M - (0.01 * 100M + 50) = 1,010,000 - 1,000,050 = 9,950
      expect(result.unrealizedPnlKrw).not.toBeNull();
      expect(parseFloat(result.unrealizedPnlKrw!)).toBeCloseTo(9950, -2);
      expect(result.totalPnlKrw).not.toBeNull();
    });

    it("같은 market 평가가가 여러 개면 observedAt이 가장 최신인 값을 사용한다", () => {
      const input: PnLAccountingInput = {
        fills: [
          buyFill("b1", "KRW-BTC", "0.01", "100000000", "50"),
        ],
        positions: [],
        markPrices: [
          {
            ...markPrice("KRW-BTC", "101000000"),
            observedAt: new Date("2026-06-01T00:02:00Z"),
            source: "newer_bid",
          },
          {
            ...markPrice("KRW-BTC", "90000000"),
            observedAt: new Date("2026-06-01T00:01:00Z"),
            source: "older_bid",
          },
        ],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.unrealizedPnlKrw).toBe("9950");
      expect(result.positionMarketValueKrw).toBe("1010000");
    });

    it("평가가 observedAt이 같으면 bid source를 last보다 우선한다", () => {
      const observedAt = new Date("2026-06-01T00:02:00Z");
      const input: PnLAccountingInput = {
        fills: [
          buyFill("b1", "KRW-BTC", "0.01", "100000000", "50"),
        ],
        positions: [],
        markPrices: [
          {
            ...markPrice("KRW-BTC", "105000000"),
            observedAt,
            source: "last",
          },
          {
            ...markPrice("KRW-BTC", "100000000"),
            observedAt,
            source: "bid",
          },
        ],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.positionMarketValueKrw).toBe("1000000");
      expect(result.unrealizedPnlKrw).toBe("-50");
    });

    it("평가가가 없으면 미실현손익과 총손익이 null이다", () => {
      const input: PnLAccountingInput = {
        fills: [
          buyFill("b1", "KRW-BTC", "0.01", "100000000", "50"),
        ],
        positions: [],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.unrealizedPnlKrw).toBeNull();
      expect(result.positionMarketValueKrw).toBeNull();
      expect(result.equityKrw).toBeNull();
      expect(result.totalPnlKrw).toBeNull();
      expect(result.status).toBe("PARTIAL");
      expect(result.missingReasons.some((r) => r.reasonCode === "NO_MARK_PRICE")).toBe(true);
    });

    it("여러 market과 전략에 대한 포지션을 각각 평가한다", () => {
      const input: PnLAccountingInput = {
        fills: [
          buyFill("b1", "KRW-BTC", "0.01", "100000000", "50", "trend_following"),
          buyFill("b2", "KRW-ETH", "2", "3000000", "30", "mean_reversion"),
        ],
        positions: [],
        markPrices: [
          markPrice("KRW-BTC", "101000000"),
          markPrice("KRW-ETH", "3010000"),
        ],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.positions).toHaveLength(2);
      const btc = result.positions.find((p) => p.market === "KRW-BTC");
      const eth = result.positions.find((p) => p.market === "KRW-ETH");
      expect(btc).toBeDefined();
      expect(eth).toBeDefined();
      expect(btc!.unrealizedPnlKrw).not.toBeNull();
      expect(eth!.unrealizedPnlKrw).not.toBeNull();

      // 노출 비중 계산
      if (btc!.exposureBps && eth!.exposureBps) {
        expect(parseFloat(btc!.exposureBps)).toBeGreaterThan(0);
        expect(parseFloat(eth!.exposureBps)).toBeGreaterThan(0);
        expect(parseFloat(btc!.exposureBps)).toBeCloseTo(
          (1010000 / (1000000 + 1010000 + 6020000)) * 10000,
          5,
        );
      }
    });

    it("snapshot equity를 position exposure 분모에 포함한다", () => {
      const snapshot: PnLSnapshotFact = {
        strategyId: "trend_following",
        market: null,
        capturedAt: new Date("2026-06-01T00:00:00Z"),
        equity: "10000000",
        realizedPnl: "0",
        unrealizedPnl: "0",
        drawdownBps: "0",
      };
      const position: PnLPositionFact = {
        strategyId: "mean_reversion",
        market: "KRW-BTC",
        quantity: "0.01",
        averageEntryPrice: "100000000",
        realizedPnl: "0",
        unrealizedPnl: null,
        updatedAt: new Date("2026-06-01T00:00:00Z"),
        source: "positions",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [position],
        markPrices: [markPrice("KRW-BTC", "100000000")],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [snapshot],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);
      const btc = result.positions.find((p) => p.market === "KRW-BTC");

      expect(result.equityKrw).toBe("11000000");
      expect(btc).toBeDefined();
      expect(parseFloat(btc!.exposureBps!)).toBeCloseTo(
        (1000000 / 11000000) * 10000,
        5,
      );
    });
  });

  describe("source priority", () => {
    it("snapshot이 있는 scope는 position fallback을 제외한다", () => {
      const snapshot: PnLSnapshotFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        capturedAt: new Date("2026-06-01T00:00:00Z"),
        equity: "1050000",
        realizedPnl: "50000",
        unrealizedPnl: "0",
        drawdownBps: "0",
      };

      const position: PnLPositionFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        quantity: "0.01",
        averageEntryPrice: "100000000",
        realizedPnl: "0",
        unrealizedPnl: "0",
        updatedAt: new Date("2026-06-01T00:00:00Z"),
        source: "positions",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [position],
        markPrices: [markPrice("KRW-BTC", "101000000")],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [snapshot],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      // snapshot이 있으므로 position fallback은 제외되고 snapshot의 손익 값이 우선 사용된다.
      expect(result.status).toBe("CALCULATED");
      expect(result.realizedPnlKrw).toBe("50000");
      expect(result.unrealizedPnlKrw).toBe("0");
      expect(result.totalPnlKrw).toBe("50000");
      expect(result.positionMarketValueKrw).toBeNull();
      expect(result.equityKrw).toBe("1050000");
      expect(result.positions.filter((p) => p.strategyId === "trend_following")).toHaveLength(0);
    });

    it("snapshot scope capturedAt은 제외된 fallback timestamp를 쓰지 않는다", () => {
      const snapshot: PnLSnapshotFact = {
        strategyId: "trend_following",
        market: null,
        capturedAt: new Date("2026-06-01T00:00:00Z"),
        equity: "1050000",
        realizedPnl: "50000",
        unrealizedPnl: "0",
        drawdownBps: "0",
      };
      const position: PnLPositionFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        quantity: "0.01",
        averageEntryPrice: "100000000",
        realizedPnl: "0",
        unrealizedPnl: null,
        updatedAt: new Date("2026-06-04T00:00:00Z"),
        source: "positions",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [position],
        markPrices: [markPrice("KRW-BTC", "101000000")],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [snapshot],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.scopes[0]!.source).toBe("pnl_snapshots");
      expect(result.scopes[0]!.capturedAt).toBe("2026-06-01T00:00:00.000Z");
    });

    it("strategy aggregate snapshot(market=null)은 같은 strategy의 모든 market position을 덮는다", () => {
      const snapshot: PnLSnapshotFact = {
        strategyId: "trend_following",
        market: null, // strategy aggregate
        capturedAt: new Date("2026-06-01T00:00:00Z"),
        equity: "1050000",
        realizedPnl: "50000",
        unrealizedPnl: "0",
        drawdownBps: "0",
      };

      const position: PnLPositionFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        quantity: "0.01",
        averageEntryPrice: "100000000",
        realizedPnl: "100000",
        unrealizedPnl: "50000",
        updatedAt: new Date("2026-06-01T00:00:00Z"),
        source: "positions",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [position],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [snapshot],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      // aggregate snapshot이 있으므로 position fallback은 제외된다
      // position이 무시되고 aggregate snapshot 값만 손익에 반영되어야 함
      expect(result.realizedPnlKrw).toBe("50000");
      expect(result.unrealizedPnlKrw).toBe("0");
      expect(result.positionMarketValueKrw).toBeNull();
      expect(result.equityKrw).toBe("1050000");
      expect(result.positions.filter((p) => p.strategyId === "trend_following")).toHaveLength(0);
    });

    it("오래된 aggregate snapshot으로 최신 market snapshot을 덮지 않는다", () => {
      const aggregateSnapshot: PnLSnapshotFact = {
        strategyId: "trend_following",
        market: null,
        capturedAt: new Date("2026-06-01T00:00:00Z"),
        equity: "1000",
        realizedPnl: "10",
        unrealizedPnl: "0",
        drawdownBps: "0",
      };
      const marketSnapshot: PnLSnapshotFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        capturedAt: new Date("2026-06-04T00:00:00Z"),
        equity: "2000",
        realizedPnl: "20",
        unrealizedPnl: "5",
        drawdownBps: "0",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [aggregateSnapshot, marketSnapshot],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.status).toBe("PARTIAL");
      expect(result.scopes).toHaveLength(1);
      expect(result.scopes[0]!.market).toBe("KRW-BTC");
      expect(result.scopes[0]!.capturedAt).toBe("2026-06-04T00:00:00.000Z");
      expect(result.equityKrw).toBe("2000");
      expect(result.realizedPnlKrw).toBe("20");
      expect(result.unrealizedPnlKrw).toBe("5");
      expect(
        result.missingReasons.some((r) => r.reasonCode === "SNAPSHOT_COVERAGE_PARTIAL"),
      ).toBe(true);
    });
  });

  describe("reconcile fact 처리", () => {
    it("MANUAL_REVIEW_REQUIRED reconcile은 계산 불가 원인으로만 남긴다", () => {
      const reconcile: PnLReconcileFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        recoveryStatus: "MANUAL_REVIEW_REQUIRED",
        averageEntryPrice: null,
        reconciledAt: new Date("2026-06-01T00:00:00Z"),
        averageEntrySource: "live_reconcile",
        manualReviewEvidenceId: "ev-001",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [reconcile],
      };

      const result = calculatePnLAccounting(input);

      expect(
        result.missingReasons.some(
          (r) =>
            r.reasonCode === "MANUAL_REVIEW_REQUIRED" &&
            r.source === "live_reconcile_position_snapshots",
        ),
      ).toBe(true);
      expect(result.positionMarketValueKrw).toBeNull();
      expect(result.equityKrw).toBeNull();
    });

    it("RECOVERABLE이고 평균단가만 있으면 부분 계산 source로 남긴다", () => {
      const reconcile: PnLReconcileFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        recoveryStatus: "RECOVERABLE",
        averageEntryPrice: "100000000",
        reconciledAt: new Date("2026-06-01T00:00:00Z"),
        averageEntrySource: "live_reconcile",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [],
        markPrices: [markPrice("KRW-BTC", "101000000")],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [reconcile],
      };

      const result = calculatePnLAccounting(input);

      expect(result.status).toBe("PARTIAL");
      expect(result.realizedPnlKrw).toBeNull();
      expect(result.unrealizedPnlKrw).toBeNull();
      expect(result.positionMarketValueKrw).toBeNull();
      expect(result.equityKrw).toBeNull();
      expect(result.scopes[0]!.status).toBe("PARTIAL");
      expect(
        result.missingReasons.some((r) => r.reasonCode === "POSITION_QUANTITY_MISSING"),
      ).toBe(true);
    });

    it("snapshot과 별도 unknown reconcile이 함께 있으면 전체 PnL을 확정하지 않는다", () => {
      const snapshot: PnLSnapshotFact = {
        strategyId: "trend_following",
        market: null,
        capturedAt: new Date("2026-06-01T00:00:00Z"),
        equity: "1050000",
        realizedPnl: "50000",
        unrealizedPnl: "10000",
        drawdownBps: "0",
      };
      const reconcile: PnLReconcileFact = {
        strategyId: "mean_reversion",
        market: "KRW-ETH",
        recoveryStatus: "RECOVERABLE",
        averageEntryPrice: "3000000",
        reconciledAt: new Date("2026-06-01T00:00:00Z"),
        averageEntrySource: "live_reconcile",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [snapshot],
        reconcileFacts: [reconcile],
      };

      const result = calculatePnLAccounting(input);

      expect(result.status).toBe("PARTIAL");
      expect(result.realizedPnlKrw).toBeNull();
      expect(result.unrealizedPnlKrw).toBeNull();
      expect(result.totalPnlKrw).toBeNull();
      expect(
        result.missingReasons.some((r) => r.reasonCode === "POSITION_QUANTITY_MISSING"),
      ).toBe(true);
    });

    it("RECOVERABLE이어도 평균단가가 없으면 수동 검토 scope로 남긴다", () => {
      const reconcile: PnLReconcileFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        recoveryStatus: "RECOVERABLE",
        averageEntryPrice: null,
        reconciledAt: new Date("2026-06-01T00:00:00Z"),
        averageEntrySource: "live_reconcile",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [],
        markPrices: [markPrice("KRW-BTC", "101000000")],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [reconcile],
      };

      const result = calculatePnLAccounting(input);

      expect(result.status).toBe("MANUAL_REVIEW_REQUIRED");
      expect(result.scopes[0]!.status).toBe("MANUAL_REVIEW_REQUIRED");
      expect(
        result.missingReasons.some((r) => r.reasonCode === "AVERAGE_ENTRY_MISSING"),
      ).toBe(true);
    });

    it("RECOVERABLE이 아닌 reconcile은 평균단가가 있어도 계산 source로 승격하지 않는다", () => {
      const reconcile: PnLReconcileFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        recoveryStatus: "MISMATCH",
        averageEntryPrice: "100000000",
        reconciledAt: new Date("2026-06-01T00:00:00Z"),
        averageEntrySource: "live_reconcile",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [],
        markPrices: [markPrice("KRW-BTC", "101000000")],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [reconcile],
      };

      const result = calculatePnLAccounting(input);

      expect(result.status).toBe("MANUAL_REVIEW_REQUIRED");
      expect(result.realizedPnlKrw).toBeNull();
      expect(result.positions).toHaveLength(0);
      expect(result.positionMarketValueKrw).toBeNull();
      expect(result.equityKrw).toBeNull();
      expect(
        result.missingReasons.some((r) => r.reasonCode === "RECOVERABLE_ONLY"),
      ).toBe(true);
    });

    it("fills가 있으면 non-RECOVERABLE reconcile scope보다 fill scope를 우선한다", () => {
      const reconcile: PnLReconcileFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        recoveryStatus: "MISMATCH",
        averageEntryPrice: "100000000",
        reconciledAt: new Date("2026-06-01T00:01:00Z"),
        averageEntrySource: "live_reconcile",
      };

      const input: PnLAccountingInput = {
        fills: [
          buyFill("b1", "KRW-BTC", "0.01", "100000000", "50"),
        ],
        positions: [],
        markPrices: [markPrice("KRW-BTC", "101000000")],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [reconcile],
      };

      const result = calculatePnLAccounting(input);
      const marketScope = result.scopes.find((s) => s.market === "KRW-BTC");

      expect(result.status).toBe("CALCULATED");
      expect(marketScope).toBeDefined();
      expect(marketScope!.source).toBe("fills");
      expect(marketScope!.status).toBe("CALCULATED");
      expect(
        result.missingReasons.some((r) => r.reasonCode === "RECOVERABLE_ONLY"),
      ).toBe(false);
    });

    it("fills가 있으면 RECOVERABLE reconcile보다 fill scope를 우선한다", () => {
      const reconcile: PnLReconcileFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        recoveryStatus: "RECOVERABLE",
        averageEntryPrice: "100000000",
        reconciledAt: new Date("2026-06-01T00:02:00Z"),
        averageEntrySource: "live_reconcile",
      };

      const input: PnLAccountingInput = {
        fills: [
          buyFill("b1", "KRW-BTC", "0.01", "100000000", "50"),
        ],
        positions: [],
        markPrices: [markPrice("KRW-BTC", "101000000")],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [reconcile],
      };

      const result = calculatePnLAccounting(input);
      const marketScope = result.scopes.find((s) => s.market === "KRW-BTC");

      expect(result.status).toBe("CALCULATED");
      expect(marketScope).toBeDefined();
      expect(marketScope!.source).toBe("fills");
      expect(marketScope!.status).toBe("CALCULATED");
      expect(
        result.missingReasons.some((r) => r.reasonCode === "POSITION_QUANTITY_MISSING"),
      ).toBe(false);
    });

    it("청산 완료 position은 RECOVERABLE reconcile 수량 결측보다 우선한다", () => {
      const position: PnLPositionFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        quantity: "0",
        averageEntryPrice: null,
        realizedPnl: "12345",
        unrealizedPnl: null,
        updatedAt: new Date("2026-06-01T00:00:00Z"),
        source: "positions",
      };
      const reconcile: PnLReconcileFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        recoveryStatus: "RECOVERABLE",
        averageEntryPrice: "100000000",
        reconciledAt: new Date("2026-06-01T00:01:00Z"),
        averageEntrySource: "live_reconcile",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [position],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [reconcile],
      };

      const result = calculatePnLAccounting(input);

      expect(result.status).toBe("CALCULATED");
      expect(result.realizedPnlKrw).toBe("12345");
      expect(result.totalPnlKrw).toBe("12345");
      expect(
        result.missingReasons.some((r) => r.reasonCode === "POSITION_QUANTITY_MISSING"),
      ).toBe(false);
    });
  });

  describe("결측 처리 및 한국어 메시지", () => {
    it("평가가가 없으면 NO_MARK_PRICE 원인을 남긴다", () => {
      const input: PnLAccountingInput = {
        fills: [
          buyFill("b1", "KRW-BTC", "0.01", "100000000", "50"),
        ],
        positions: [],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.status).toBe("PARTIAL");
      expect(result.missingReasons.length).toBeGreaterThan(0);
      expect(
        result.missingReasons.some((r) => r.reasonCode === "NO_MARK_PRICE"),
      ).toBe(true);

      // 한국어 메시지 확인
      const noMarkPrice = result.missingReasons.find(
        (r) => r.reasonCode === "NO_MARK_PRICE",
      );
      expect(noMarkPrice).toBeDefined();
      expect(noMarkPrice!.message).toBe("평가가 없음");
    });

    it("현금 정보가 없으면 NO_CASH_SOURCE 원인을 남긴다", () => {
      const input: PnLAccountingInput = {
        fills: [],
        positions: [],
        markPrices: [],
        cash: null,
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.status).toBe("UNAVAILABLE");
      expect(result.cashKrw).toBeNull();
      expect(result.equityKrw).toBeNull();
      expect(
        result.missingReasons.some((r) => r.reasonCode === "NO_CASH_SOURCE"),
      ).toBe(true);
    });

    it("snapshot-only 계산은 현금 source가 없어도 계산 완료로 유지한다", () => {
      const snapshot: PnLSnapshotFact = {
        strategyId: "trend_following",
        market: null,
        capturedAt: new Date("2026-06-01T00:00:00Z"),
        equity: "1050000",
        realizedPnl: "50000",
        unrealizedPnl: "10000",
        drawdownBps: "0",
      };
      const input: PnLAccountingInput = {
        fills: [],
        positions: [],
        markPrices: [],
        cash: null,
        costQuality: [],
        pnlSnapshots: [snapshot],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.status).toBe("CALCULATED");
      expect(result.cashKrw).toBeNull();
      expect(result.equityKrw).toBe("1050000");
      expect(
        result.missingReasons.some((r) => r.reasonCode === "NO_CASH_SOURCE"),
      ).toBe(false);
    });

    it("현금 source가 없으면 fills 순현금흐름을 실제 현금 잔고로 표시하지 않는다", () => {
      const input: PnLAccountingInput = {
        fills: [
          buyFill("b1", "KRW-BTC", "0.01", "100000000", "50"),
          sellFill("s1", "KRW-BTC", "0.01", "101000000", "50"),
        ],
        positions: [],
        markPrices: [],
        cash: null,
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.status).toBe("PARTIAL");
      expect(result.realizedPnlKrw).toBe("9900");
      expect(result.cashKrw).toBeNull();
      expect(result.equityKrw).toBeNull();
      expect(
        result.missingReasons.some((r) => r.reasonCode === "NO_CASH_SOURCE"),
      ).toBe(true);
    });

    it("평균단가가 없는 position은 AVERAGE_ENTRY_MISSING 원인을 남긴다", () => {
      const position: PnLPositionFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        quantity: "0.01",
        averageEntryPrice: null,
        realizedPnl: "0",
        unrealizedPnl: null,
        updatedAt: new Date("2026-06-01T00:00:00Z"),
        source: "positions",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [position],
        markPrices: [markPrice("KRW-BTC", "101000000")],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(
        result.missingReasons.some(
          (r) => r.reasonCode === "AVERAGE_ENTRY_MISSING",
        ),
      ).toBe(true);
    });

    it("청산 완료 position fallback은 평균단가가 없어도 계산 완료로 남긴다", () => {
      const position: PnLPositionFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        quantity: "0",
        averageEntryPrice: null,
        realizedPnl: "12345",
        unrealizedPnl: null,
        updatedAt: new Date("2026-06-01T00:00:00Z"),
        source: "positions",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [position],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.status).toBe("CALCULATED");
      expect(result.realizedPnlKrw).toBe("12345");
      expect(result.unrealizedPnlKrw).toBe("0");
      expect(result.totalPnlKrw).toBe("12345");
      expect(result.scopes[0]!.status).toBe("CALCULATED");
      expect(
        result.missingReasons.some((r) => r.reasonCode === "AVERAGE_ENTRY_MISSING"),
      ).toBe(false);
    });

    it("평균단가가 없어도 position fallback 수량과 시장가치는 보존한다", () => {
      const position: PnLPositionFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        quantity: "0.01",
        averageEntryPrice: null,
        realizedPnl: "1000",
        unrealizedPnl: null,
        updatedAt: new Date("2026-06-01T00:00:00Z"),
        source: "positions",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [position],
        markPrices: [markPrice("KRW-BTC", "101000000")],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.status).toBe("PARTIAL");
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0]!.quantity).toBe("0.01");
      expect(result.positions[0]!.marketValueKrw).toBe("1010000");
      expect(result.positions[0]!.unrealizedPnlKrw).toBeNull();
      expect(result.positionMarketValueKrw).toBe("1010000");
      expect(result.equityKrw).toBe("2010000");
    });

    it("position fallback만 있으면 positions.realizedPnl을 보존한다", () => {
      const position: PnLPositionFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        quantity: "0.01",
        averageEntryPrice: "100000000",
        realizedPnl: "12345",
        unrealizedPnl: null,
        updatedAt: new Date("2026-06-01T00:00:00Z"),
        source: "positions",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [position],
        markPrices: [markPrice("KRW-BTC", "101000000")],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.status).toBe("CALCULATED");
      expect(result.realizedPnlKrw).toBe("12345");
      expect(result.unrealizedPnlKrw).toBe("10000");
      expect(result.totalPnlKrw).toBe("22345");
    });

    it("mark price가 없으면 position fallback의 unrealizedPnl 추정값을 보존한다", () => {
      const position: PnLPositionFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        quantity: "0.01",
        averageEntryPrice: "100000000",
        realizedPnl: "12345",
        unrealizedPnl: "5000",
        updatedAt: new Date("2026-06-01T00:00:00Z"),
        source: "positions",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [position],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.status).toBe("PARTIAL");
      expect(result.realizedPnlKrw).toBe("12345");
      expect(result.unrealizedPnlKrw).toBe("5000");
      expect(result.totalPnlKrw).toBe("17345");
      expect(result.positionMarketValueKrw).toBeNull();
      expect(result.equityKrw).toBeNull();
      expect(result.scopes[0]!.status).toBe("PARTIAL");
    });

    it("targetScopes가 있으면 요청한 scope만 계산한다", () => {
      const input: PnLAccountingInput = {
        targetScopes: [
          {
            strategyId: "trend_following",
            market: "KRW-BTC",
            capturedAt: "2026-06-01T00:00:00.000Z",
            source: "fills",
            status: "CALCULATED",
          },
        ],
        fills: [
          buyFill("b1", "KRW-BTC", "0.01", "100000000", "50", "trend_following"),
          buyFill("b2", "KRW-ETH", "2", "3000000", "30", "mean_reversion"),
        ],
        positions: [],
        markPrices: [
          markPrice("KRW-BTC", "101000000"),
          markPrice("KRW-ETH", "3010000"),
        ],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.positions).toHaveLength(1);
      expect(result.positions[0]!.strategyId).toBe("trend_following");
      expect(result.positions[0]!.market).toBe("KRW-BTC");
      expect(result.positionMarketValueKrw).toBe("1010000");
      expect(result.feeTotals).toEqual([{ currency: "KRW", amount: "50" }]);
      expect(result.scopes.some((s) => s.strategyId === "mean_reversion")).toBe(false);
      expect(result.scopes.some((s) => s.strategyId === "trend_following" && s.market === null)).toBe(false);
    });

    it("호출 시각이 달라도 동일 입력에서 항상 같은 결과를 반환한다 (deterministic)", () => {
      const input: PnLAccountingInput = {
        fills: [
          buyFill("b1", "KRW-BTC", "0.01", "100000000", "50"),
          sellFill("s1", "KRW-BTC", "0.01", "101000000", "50"),
        ],
        positions: [],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-06-01T01:00:00Z"));
        const result1 = calculatePnLAccounting(input);
        vi.setSystemTime(new Date("2026-06-01T02:00:00Z"));
        const result2 = calculatePnLAccounting({ ...input });

        expect(result1.realizedPnlKrw).toBe(result2.realizedPnlKrw);
        expect(result1.totalPnlKrw).toBe(result2.totalPnlKrw);
        expect(result1.cashKrw).toBe(result2.cashKrw);
        expect(result1.status).toBe(result2.status);
        expect(result2).toEqual(result1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("비용 분해", () => {
    it("통화별 수수료를 분리 집계한다", () => {
      const input: PnLAccountingInput = {
        fills: [
          buyFill("b1", "KRW-BTC", "0.01", "100000000", "50"),
          buyFill("b2", "KRW-BTC", "0.01", "100000000", "25"),
        ],
        positions: [],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.feeTotals).toHaveLength(1);
      expect(result.feeTotals[0]!.currency).toBe("KRW");
      expect(parseFloat(result.feeTotals[0]!.amount)).toBe(75);
    });

    it("snapshot으로 덮인 fill도 feeTotals에는 포함한다", () => {
      const snapshot: PnLSnapshotFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        capturedAt: new Date("2026-06-01T00:00:00Z"),
        equity: "1050000",
        realizedPnl: "50000",
        unrealizedPnl: "0",
        drawdownBps: "0",
      };

      const input: PnLAccountingInput = {
        fills: [
          buyFill("covered-fill", "KRW-BTC", "0.01", "100000000", "50"),
        ],
        positions: [],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [snapshot],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.realizedPnlKrw).toBe("50000");
      expect(result.unrealizedPnlKrw).toBe("0");
      expect(result.feeTotals).toEqual([{ currency: "KRW", amount: "50" }]);
    });

    it("spread/slippage/cancel-requote 비용을 집계한다", () => {
      const input: PnLAccountingInput = {
        fills: [],
        positions: [],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [
          {
            strategyId: "trend_following",
            market: "KRW-BTC",
            spreadCostBps: "3.5",
            slippageBps: "2.1",
            source: "paper_fill_simulator",
          },
          {
            strategyId: "trend_following",
            market: "KRW-BTC",
            spreadCostBps: "4.0",
            slippageBps: "1.9",
            cancelRequotePenaltyBps: "1.0",
            source: "paper_fill_simulator",
          },
        ],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      // spread: (3.5 + 4.0) / 2 = 3.75
      expect(result.spreadCost.available).toBe(true);
      expect(parseFloat(result.spreadCost.value!)).toBeCloseTo(3.75, 2);

      // slippage: (2.1 + 1.9) / 2 = 2.0
      expect(result.slippage.available).toBe(true);
      expect(parseFloat(result.slippage.value!)).toBeCloseTo(2.0, 2);

      // cancel-requote: 1.0 / 1 = 1.0
      expect(result.cancelRequote.available).toBe(true);
      expect(parseFloat(result.cancelRequote.value!)).toBeCloseTo(1.0, 2);
    });

    it("관측 source가 없으면 비용 metric은 unavailable이다", () => {
      const input: PnLAccountingInput = {
        fills: [],
        positions: [],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.spreadCost.available).toBe(false);
      expect(result.spreadCost.value).toBeNull();
      expect(result.slippage.available).toBe(false);
    });
  });

  describe("scope 빌드", () => {
    it("fills에서 strategy/market scope를 추출한다", () => {
      const input: PnLAccountingInput = {
        fills: [
          buyFill("b1", "KRW-BTC", "0.01", "100000000", "50", "trend_following"),
          buyFill("b2", "KRW-ETH", "2", "3000000", "30", "mean_reversion"),
        ],
        positions: [],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.scopes.length).toBeGreaterThanOrEqual(2);
      const hasTrendFollowing = result.scopes.some(
        (s) => s.strategyId === "trend_following",
      );
      const hasMeanReversion = result.scopes.some(
        (s) => s.strategyId === "mean_reversion",
      );
      expect(hasTrendFollowing).toBe(true);
      expect(hasMeanReversion).toBe(true);
    });

    it("aggregate fill scope는 모든 open child position에 mark price가 있어야 계산 완료다", () => {
      const input: PnLAccountingInput = {
        fills: [
          buyFill("b1", "KRW-BTC", "0.01", "100000000", "50", "trend_following"),
          buyFill("b2", "KRW-ETH", "2", "3000000", "30", "trend_following"),
        ],
        positions: [],
        markPrices: [
          markPrice("KRW-BTC", "101000000"),
        ],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);
      const aggregateScope = result.scopes.find(
        (s) => s.strategyId === "trend_following" && s.market === null,
      );

      expect(aggregateScope).toBeDefined();
      expect(aggregateScope!.status).toBe("PARTIAL");
    });

    it("positions가 RECOVERABLE reconcile 수량 결측을 정량화하면 평가액을 계산한다", () => {
      const position: PnLPositionFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        quantity: "0.01",
        averageEntryPrice: "100000000",
        realizedPnl: "0",
        unrealizedPnl: null,
        updatedAt: new Date("2026-06-01T00:00:00Z"),
        source: "positions",
      };
      const reconcile: PnLReconcileFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        recoveryStatus: "RECOVERABLE",
        averageEntryPrice: "100000000",
        reconciledAt: new Date("2026-06-01T00:01:00Z"),
        averageEntrySource: "live_reconcile",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [position],
        markPrices: [markPrice("KRW-BTC", "101000000")],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [reconcile],
      };

      const result = calculatePnLAccounting(input);

      expect(result.status).toBe("CALCULATED");
      expect(result.positionMarketValueKrw).toBe("1010000");
      expect(result.unrealizedPnlKrw).toBe("10000");
      expect(
        result.missingReasons.some((r) => r.reasonCode === "POSITION_QUANTITY_MISSING"),
      ).toBe(false);
    });

    it("fills와 positions가 같은 scope에 있으면 scope source는 fills를 보존한다", () => {
      const position: PnLPositionFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        quantity: "0.01",
        averageEntryPrice: "100000000",
        realizedPnl: "0",
        unrealizedPnl: "0",
        updatedAt: new Date("2026-06-01T00:00:00Z"),
        source: "positions",
      };

      const input: PnLAccountingInput = {
        fills: [
          buyFill("b1", "KRW-BTC", "0.01", "100000000", "50"),
        ],
        positions: [position],
        markPrices: [markPrice("KRW-BTC", "101000000")],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);
      const marketScope = result.scopes.find((s) => s.market === "KRW-BTC");

      expect(marketScope).toBeDefined();
      expect(marketScope!.source).toBe("fills");
    });

    it("mark price가 없는 open position fallback scope는 PARTIAL이다", () => {
      const position: PnLPositionFact = {
        strategyId: "trend_following",
        market: "KRW-BTC",
        quantity: "0.01",
        averageEntryPrice: "100000000",
        realizedPnl: "0",
        unrealizedPnl: null,
        updatedAt: new Date("2026-06-01T00:00:00Z"),
        source: "positions",
      };

      const input: PnLAccountingInput = {
        fills: [],
        positions: [position],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.scopes[0]!.source).toBe("positions");
      expect(result.scopes[0]!.status).toBe("PARTIAL");
    });
  });

  describe("입력이 없는 경우", () => {
    it("빈 입력에서도 의미 있는 출력을 반환한다", () => {
      const input: PnLAccountingInput = {
        fills: [],
        positions: [],
        markPrices: [],
        cash: defaultCash(),
        costQuality: [],
        pnlSnapshots: [],
        reconcileFacts: [],
      };

      const result = calculatePnLAccounting(input);

      expect(result.status).toBe("UNAVAILABLE");
      expect(result.realizedPnlKrw).toBeNull();
      expect(result.unrealizedPnlKrw).toBeNull();
      expect(result.totalPnlKrw).toBeNull();
      expect(result.cashKrw).toBe("1000000");
      expect(result.equityKrw).toBe("1000000"); // 포지션이 없을 때 equity = cash
      expect(result.positions).toHaveLength(0);
    });
  });
});

describe("source priority 순수 로직", () => {
  it("createSnapshotCoverage: aggregate snapshot이 strategy의 모든 market을 덮는다", () => {
    const coverage = createSnapshotCoverage([
      { strategyId: "trend_following", market: null },
    ]);

    expect(coverage.isCovered("trend_following", "KRW-BTC")).toBe(true);
    expect(coverage.isCovered("trend_following", "KRW-ETH")).toBe(true);
    expect(coverage.isCovered("mean_reversion", "KRW-BTC")).toBe(false);
  });

  it("createSnapshotCoverage: market snapshot이 특정 market만 덮는다", () => {
    const coverage = createSnapshotCoverage([
      { strategyId: "trend_following", market: "KRW-BTC" },
    ]);

    expect(coverage.isCovered("trend_following", "KRW-BTC")).toBe(true);
    expect(coverage.isCovered("trend_following", "KRW-ETH")).toBe(false);
  });

  it("scopeKey: market이 null이면 aggregate key를 반환한다", () => {
    expect(scopeKey("trend_following", null)).toBe("trend_following::*");
    expect(scopeKey("trend_following", "KRW-BTC")).toBe("trend_following::KRW-BTC");
  });

  it("buildSourceLabel: source 조합을 '+'로 연결한다", () => {
    const compositeSource: PnLSource = "fills+pnl_snapshots+positions";

    expect(buildSourceLabel(["fills"])).toBe("fills");
    expect(buildSourceLabel(["fills", "positions"])).toBe("fills+positions");
    expect(buildSourceLabel(["pnl_snapshots", "fills", "positions"])).toBe(
      compositeSource,
    );
    expect(buildSourceLabel([])).toBe("unavailable");
  });

  it("resolvePnLSources: snapshot이 있는 scope는 position fallback을 제외한다", () => {
    const result = resolvePnLSources(
      [{ strategyId: "trend_following", market: "KRW-BTC" }],
      [
        {
          strategyId: "trend_following",
          market: "KRW-BTC",
          quantity: "0.01",
          averageEntryPrice: "100000000",
          realizedPnl: "0",
          unrealizedPnl: "0",
          updatedAt: new Date(),
          source: "positions",
        },
        {
          strategyId: "mean_reversion",
          market: "KRW-ETH",
          quantity: "2",
          averageEntryPrice: "3000000",
          realizedPnl: "0",
          unrealizedPnl: "0",
          updatedAt: new Date(),
          source: "positions",
        },
      ],
      [],
    );

    // KRW-BTC는 snapshot으로 덮였으므로 resolvedPositions에 없어야 함
    const hasBtc = result.resolvedPositions.some(
      (p) => p.strategyId === "trend_following" && p.market === "KRW-BTC",
    );
    expect(hasBtc).toBe(false);

    // KRW-ETH는 snapshot이 없으므로 fallback에 포함
    const hasEth = result.resolvedPositions.some(
      (p) => p.strategyId === "mean_reversion" && p.market === "KRW-ETH",
    );
    expect(hasEth).toBe(true);
  });

  it("resolvePnLSources: MANUAL_REVIEW_REQUIRED reconcile은 missing reason으로만 남긴다", () => {
    const result = resolvePnLSources(
      [],
      [],
      [
        {
          strategyId: "trend_following",
          market: "KRW-BTC",
          recoveryStatus: "MANUAL_REVIEW_REQUIRED",
          averageEntryPrice: null,
          reconciledAt: new Date(),
          manualReviewEvidenceId: "ev-001",
        },
      ],
    );

    expect(result.resolvedPositions).toHaveLength(0);
    expect(
      result.missingReasons.some((r) => r.reasonCode === "MANUAL_REVIEW_REQUIRED"),
    ).toBe(true);
  });

  it("resolvePnLSources: RECOVERABLE이 아닌 reconcile은 평균단가가 있어도 제외한다", () => {
    const result = resolvePnLSources(
      [],
      [],
      [
        {
          strategyId: "trend_following",
          market: "KRW-BTC",
          recoveryStatus: "MISMATCH",
          averageEntryPrice: "100000000",
          reconciledAt: new Date(),
        },
      ],
    );

    expect(result.resolvedPositions).toHaveLength(0);
    expect(
      result.missingReasons.some((r) => r.reasonCode === "RECOVERABLE_ONLY"),
    ).toBe(true);
  });

  it("resolvePnLSources: non-RECOVERABLE reconcile scope는 positions fallback을 차단한다", () => {
    const result = resolvePnLSources(
      [],
      [
        {
          strategyId: "trend_following",
          market: "KRW-BTC",
          quantity: "0.01",
          averageEntryPrice: "100000000",
          realizedPnl: "0",
          unrealizedPnl: "0",
          updatedAt: new Date(),
          source: "positions",
        },
      ],
      [
        {
          strategyId: "trend_following",
          market: "KRW-BTC",
          recoveryStatus: "MANUAL_REVIEW_REQUIRED",
          averageEntryPrice: null,
          reconciledAt: new Date(),
        },
      ],
    );

    expect(result.resolvedPositions).toHaveLength(0);
    expect(
      result.missingReasons.some((r) => r.reasonCode === "MANUAL_REVIEW_REQUIRED"),
    ).toBe(true);
  });

  it("resolvePnLSources: current position은 RECOVERABLE reconcile보다 우선한다", () => {
    const result = resolvePnLSources(
      [],
      [
        {
          strategyId: "trend_following",
          market: "KRW-BTC",
          quantity: "0.01",
          averageEntryPrice: "100000000",
          realizedPnl: "12345",
          unrealizedPnl: "1000",
          updatedAt: new Date(),
          source: "positions",
        },
      ],
      [
        {
          strategyId: "trend_following",
          market: "KRW-BTC",
          recoveryStatus: "RECOVERABLE",
          averageEntryPrice: "100000000",
          reconciledAt: new Date(),
          averageEntrySource: "live_reconcile",
        },
      ],
    );

    expect(result.resolvedPositions).toHaveLength(1);
    const resolvedPosition = result.resolvedPositions[0] as PnLPositionFact;
    expect(resolvedPosition.source).toBe("positions");
    expect(resolvedPosition.quantity).toBe("0.01");
    expect(resolvedPosition.realizedPnl).toBe("12345");
    expect(result.scopeSources.get(scopeKey("trend_following", "KRW-BTC"))).toBe("positions");
  });

  it("resolvePnLSources: 청산 position은 평균단가 없이도 source로 남긴다", () => {
    const result = resolvePnLSources(
      [],
      [
        {
          strategyId: "trend_following",
          market: "KRW-BTC",
          quantity: "0",
          averageEntryPrice: null,
          realizedPnl: "12345",
          unrealizedPnl: null,
          updatedAt: new Date(),
          source: "positions",
        },
      ],
      [],
    );

    expect(result.resolvedPositions).toHaveLength(1);
    expect(
      result.missingReasons.some((r) => r.reasonCode === "AVERAGE_ENTRY_MISSING"),
    ).toBe(false);
  });
});

describe("formatter 한국어 메시지", () => {
  it("formatPnLAccountingStatus: 상태 코드를 한국어로 변환한다", () => {
    expect(formatPnLAccountingStatus("CALCULATED")).toBe("계산 완료");
    expect(formatPnLAccountingStatus("PARTIAL")).toBe("일부 계산 가능");
    expect(formatPnLAccountingStatus("UNAVAILABLE")).toBe("계산 불가");
    expect(formatPnLAccountingStatus("MANUAL_REVIEW_REQUIRED")).toBe(
      "수동 검토 필요",
    );
  });

  it("formatMissingReason: missing reason의 message를 반환한다", () => {
    const reason = {
      message: "평가가 없음",
      reasonCode: "NO_MARK_PRICE",
      scope: "trend_following::KRW-BTC",
      source: "mark_prices",
    };
    expect(formatMissingReason(reason)).toBe("평가가 없음");
  });

  it("labelMissingReasonCode: POSITION_QUANTITY_MISSING을 한국어로 변환한다", () => {
    expect(labelMissingReasonCode("POSITION_QUANTITY_MISSING")).toBe(
      "보유 수량 근거 없음",
    );
  });

  it("labelMissingReasonCode: SNAPSHOT_COVERAGE_PARTIAL을 한국어로 변환한다", () => {
    expect(labelMissingReasonCode("SNAPSHOT_COVERAGE_PARTIAL")).toBe(
      "일부 snapshot coverage만 확인됨",
    );
  });
});
