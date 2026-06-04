import { Decimal } from "decimal.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import {
  createSnapshotCoverage,
  resolveFillScopes,
  scopeKey,
} from "./source-priority.js";
import type {
  PnLAccountingInput,
  PnLAccountingOutput,
  PnLAccountingScope,
  PnLAccountingStatus,
  PnLCostQualityFact,
  PnLExecutionQualityMetric,
  PnLFeeTotal,
  PnLFillFact,
  PnLMarkPriceFact,
  PnLMissingReason,
  PnLPositionDetail,
  PnLPositionFact,
  PnLReconcileFact,
  PnLSnapshotFact,
} from "./types.js";

/**
 * PnL 계산의 누적 상태를 추적하는 mutable ledger다.
 *
 * calculator 내부에서만 사용하며 외부 노출은 output contract로만 한다.
 */
interface Ledger {
  cashKrw: Decimal;
  realizedPnlKrw: Decimal;
  /** strategy/market → position ledger */
  positions: Map<string, PositionLedger>;
  filledOrderIds: Set<string>;
  filledCount: number;
}

interface PositionLedger {
  quantity: Decimal;
  costBasisKrw: Decimal;
  market: string;
  strategyId: string;
  /** position source에서 넘어온 평균단가. fill 누적이 없으면 이 값을 기준으로 삼는다. */
  initialAverageEntryPrice: Decimal | null;
  /** mark price가 없을 때 positions snapshot에서 보존하는 미실현손익 추정값이다. */
  fallbackUnrealizedPnlKrw: Decimal | null;
}

/**
 * PnL/포지션 회계 계산기의 순수 진입점이다.
 *
 * 이 함수는 모든 입력을 받아 deterministic한 PnL/포지션 회계 output을 생성한다.
 * DB 접근, HTTP 호출, 외부 API 호출 side effect는 전혀 없다.
 * 동일 입력에 대해 항상 같은 결과를 반환한다 (deterministic).
 *
 * ## 책임 경계
 *
 * - **Unit 01 (이 파일)**: 입력 → 출력 순수 계산만 수행한다. snapshot 중복 insert 방지(idempotency)는
 *   Unit 02 persistence(`src/infrastructure/db/pnl-accounting/`)에서 책임진다.
 *   Unit 02는 repository 계층에서 captured_at + source fingerprint 기반 중복 감지 전략을 구현한다
 *   [handoff](.local/2026-06-04-issue-154-m17-pnl-position-accounting-handoff.md).
 * - 이 함수 자체는 idempotency key 검증을 하지 않으며, 호출자가 동일 입력을 여러 번 넘기면
 *   동일 출력을 여러 번 생성한다.
 *
 * 계산 흐름:
 * 1. snapshot source priority 적용 — snapshot이 있는 scope의 하위 source 중복 계산을 차단
 * 2. snapshot 미보유 scope의 fill 누적 — 평균단가 기반 실현손익 계산
 * 3. mark price 평가 — 미실현손익, 시장가치, 노출 비중 계산
 * 4. 비용 분해 — 수수료, spread, slippage, cancel/requote 집계
 * 5. missing reasons 수집
 */
export function calculatePnLAccounting(input: PnLAccountingInput): PnLAccountingOutput {
  const accountingInput = applyTargetScopeFilter(input);
  const missingReasons: PnLMissingReason[] = [];
  const scopes: PnLAccountingScope[] = [];

  // ── 1. snapshot coverage 판정 ──────────────────────────────────────────────
  const snapshotFacts = selectEffectiveSnapshots(accountingInput.pnlSnapshots);
  const snapshotCoverage = createSnapshotCoverage(
    snapshotFacts.map((s) => ({ strategyId: s.strategyId, market: s.market })),
  );
  const snapshotTotals = summarizeSnapshots(snapshotFacts);
  const fillCoverage = createFillScopeCoverage(accountingInput.fills);
  const positionCoverage = createPositionScopeCoverage(accountingInput.positions);

  // ── 2. reconcile fact 수집 ────────────────────────────────────────────────
  const reconciledPositions: PnLPositionFact[] = [];
  let hasUnknownReconcilePosition = false;
  for (const reconcile of accountingInput.reconcileFacts) {
    // snapshot이 이미 coverage 중이면 reconcile을 skip
    if (snapshotCoverage.isCovered(reconcile.strategyId, reconcile.market)) {
      continue;
    }

    const hasFillForReconcileScope = fillCoverage.isCovered(reconcile.strategyId, reconcile.market);
    const hasPositionForReconcileScope = positionCoverage.isCovered(reconcile.strategyId, reconcile.market);

    if (reconcile.recoveryStatus !== "RECOVERABLE") {
      missingReasons.push({
        message: reconcile.recoveryStatus === "MANUAL_REVIEW_REQUIRED"
          ? "수동 검토 필요"
          : "복구 가능 상태만 사용 가능",
        reasonCode: reconcile.recoveryStatus === "MANUAL_REVIEW_REQUIRED"
          ? "MANUAL_REVIEW_REQUIRED"
          : "RECOVERABLE_ONLY",
        scope: scopeKey(reconcile.strategyId, reconcile.market),
        source: "live_reconcile_position_snapshots",
      });
      if (!hasFillForReconcileScope) {
        // 수동 검토 대상만 있는 scope는 포지션 규모를 모르므로 equity를 현금만으로 확정하지 않는다.
        hasUnknownReconcilePosition = true;
      }
      continue;
    }

    if (hasFillForReconcileScope || hasPositionForReconcileScope) {
      // 실제 체결/포지션 근거가 있으면 평균단가뿐인 RECOVERABLE reconcile은 scope/source를 차지하지 않는다.
      continue;
    }

    if (reconcile.averageEntryPrice === null || reconcile.averageEntryPrice === undefined) {
      missingReasons.push({
        message: "평균단가 근거 없음",
        reasonCode: "AVERAGE_ENTRY_MISSING",
        scope: scopeKey(reconcile.strategyId, reconcile.market),
        source: reconcile.averageEntrySource ?? "live_reconcile_position_snapshots",
      });
      hasUnknownReconcilePosition = true;
      continue;
    }

    // reconcile fact를 position fact로 승격
    // ⚠️ reconcile은 현재 평균단가만 제공하고 보유 수량 정보는 없다.
    // 따라서 quantity를 "0"으로 설정하며, 시장가치와 미실현손익은 이 사실만으로 계산할 수 없다.
    // 평균단가만으로 0 PnL을 확정하면 실제 보유 규모를 숨기므로 부분 계산 원인을 함께 남긴다.
    missingReasons.push({
      message: "보유 수량 근거 없음",
      reasonCode: "POSITION_QUANTITY_MISSING",
      scope: scopeKey(reconcile.strategyId, reconcile.market),
      source: "live_reconcile_position_snapshots",
    });
    hasUnknownReconcilePosition = true;
    // 향후 reconcile에 실제 보유 수량이 추가되면 이 로직을 보강해야 한다.
    // [보강 경로]: reconcile source에서 quantity 필드가 추가되면
    //   seedLedgerFromReconcile에서 quantity>0인 경우 costBasisKrw를 채워
    //   MTM 평가 단계에서 marketValueKrw와 unrealizedPnlKrw가 정상 계산되게 한다.
    reconciledPositions.push({
      strategyId: reconcile.strategyId,
      market: reconcile.market,
      quantity: "0",
      averageEntryPrice: reconcile.averageEntryPrice,
      realizedPnl: "0",
      unrealizedPnl: null,
      updatedAt: reconcile.reconciledAt,
      source: `live_reconcile_position_snapshots:${reconcile.averageEntrySource ?? "reconciled"}`,
    });
  }

  // ── 3. positions fallback 수집 ─────────────────────────────────────────────
  const fallbackPositions: PnLPositionFact[] = [];
  for (const position of accountingInput.positions) {
    if (snapshotCoverage.isCovered(position.strategyId, position.market)) {
      continue;
    }

    const positionQuantity = parseNonNegativeDecimal(position.quantity);
    if (
      positionQuantity.greaterThan(0) &&
      (position.averageEntryPrice === null || position.averageEntryPrice === undefined)
    ) {
      missingReasons.push({
        message: "평균단가 근거 없음",
        reasonCode: "AVERAGE_ENTRY_MISSING",
        scope: scopeKey(position.strategyId, position.market),
        source: "positions",
      });
    }

    fallbackPositions.push(position);
  }

  // ── 4. fill 기반 ledger 구축 ──────────────────────────────────────────────
  const ledgerFills = sortFillsByExecutionTime(
    accountingInput.fills.filter(
      (fill) => !snapshotCoverage.isCovered(fill.strategyId, fill.market),
    ),
  );
  const ledger = buildFillLedger(ledgerFills);

  // ── 5. position source에서 초기 ledger 보강 ────────────────────────────────
  // reconcile로 복구한 position 정보를 ledger에 반영
  seedLedgerFromReconcile(ledger, reconciledPositions);
  // position fallback에서 평균단가 정보를 보강
  seedLedgerFromPositions(ledger, fallbackPositions);

  // ── 6. 현금 처리 ─────────────────────────────────────────────────────────
  let cashKrw: Decimal | null;
  if (accountingInput.cash !== null && accountingInput.cash !== undefined) {
    cashKrw = parseFinancialDecimal(accountingInput.cash.totalKrw);
  } else {
    cashKrw = null;
    if (snapshotTotals.equityKrw === null) {
      // snapshot equity가 없을 때만 현금 결측이 총자산 계산을 막으므로 missing reason으로 승격한다.
      missingReasons.push({
        message: "현금 정보 없음",
        reasonCode: "NO_CASH_SOURCE",
        scope: "global",
        source: "cash",
      });
    }
  }

  // ── 7. MTM 평가 ──────────────────────────────────────────────────────────
  const markPriceMap = buildMarkPriceMap(accountingInput.markPrices);
  const positionDetails = calculatePositionDetails(
    ledger,
    markPriceMap,
    cashKrw,
    snapshotTotals.equityKrw,
    missingReasons,
  );

  const hasUnquantifiedReconcile =
    hasUnknownReconcilePosition || hasUnquantifiedReconcilePosition(reconciledPositions);
  const hasLedgerPositionDetails = positionDetails.length > 0;
  // reconcile-only/source snapshot-only는 평가액 원천이 없으므로 position value를 0으로 확정하지 않는다.
  const positionMarketValueKrw = hasUnquantifiedReconcile
    ? null
    : snapshotFacts.length > 0 && !hasLedgerPositionDetails
      ? null
    : computePositionMarketValue(positionDetails);
  const ledgerUnrealizedPnlKrw = hasUnquantifiedReconcile
    ? null
    : computeUnrealizedPnl(positionDetails);
  const hasQuantifiedReconcile = hasQuantifiedPosition(reconciledPositions);
  const hasLedgerTradingData =
    ledgerFills.length > 0 ||
    fallbackPositions.length > 0 ||
    hasQuantifiedReconcile;

  const realizedPnlKrw = sumDecimalParts([
    { active: snapshotFacts.length > 0, value: snapshotTotals.realizedPnlKrw },
    { active: hasLedgerTradingData, value: ledger.realizedPnlKrw },
  ]);
  const unrealizedPnlKrw = sumDecimalParts([
    { active: snapshotFacts.length > 0, value: snapshotTotals.unrealizedPnlKrw },
    { active: hasLedgerTradingData, value: ledgerUnrealizedPnlKrw },
  ]);

  // ── 8. equity ─────────────────────────────────────────────────────────────
  const equityKrw =
    snapshotTotals.equityKrw !== null
      ? positionMarketValueKrw === null
        ? hasLedgerPositionDetails || hasUnquantifiedReconcile
          ? null
          : snapshotTotals.equityKrw
        : snapshotTotals.equityKrw.plus(positionMarketValueKrw)
      : cashKrw !== null && positionMarketValueKrw !== null
        ? cashKrw.plus(positionMarketValueKrw)
        : null;

  const totalPnlKrw =
    realizedPnlKrw !== null && unrealizedPnlKrw !== null
      ? realizedPnlKrw.plus(unrealizedPnlKrw)
      : null;

  // ── 9. 비용 분해 ─────────────────────────────────────────────────────────
  // 비용 분해는 PnL source priority와 독립된 evidence이므로 snapshot으로 덮인 fill fee도 보존한다.
  const feeTotals = buildFeeTotals(aggregateFeesByCurrency(accountingInput.fills));
  const spreadCost = aggregateQualityMetric(accountingInput.costQuality, "spreadCostBps");
  const slippage = aggregateQualityMetric(accountingInput.costQuality, "slippageBps");
  const cancelRequote = aggregateQualityMetric(
    accountingInput.costQuality,
    "cancelRequotePenaltyBps",
  );

  // ── 10. scope 빌드 ───────────────────────────────────────────────────────
  buildScopes(
    scopes,
    accountingInput,
    snapshotFacts,
    ledgerFills,
    ledger,
    resolveCalculationCapturedAt(accountingInput),
  );

  // ── 11. 상태 판정 ────────────────────────────────────────────────────────
  const status = determineStatus(scopes, missingReasons, accountingInput);

  // 거래 데이터가 전혀 없으면 PnL은 null로 남긴다 (실제 0과 계산 불가를 구분)
  const hasTradingData =
    ledgerFills.length > 0 ||
    fallbackPositions.length > 0 ||
    snapshotFacts.length > 0 ||
    hasQuantifiedReconcile;

  return {
    scopes,
    status,
    realizedPnlKrw: hasTradingData ? decimalOrNull(realizedPnlKrw) : null,
    unrealizedPnlKrw: hasTradingData ? decimalOrNull(unrealizedPnlKrw) : null,
    totalPnlKrw: hasTradingData ? decimalOrNull(totalPnlKrw) : null,
    cashKrw: decimalOrNull(cashKrw),
    positionMarketValueKrw: decimalOrNull(positionMarketValueKrw),
    equityKrw: decimalOrNull(equityKrw),
    positions: positionDetails,
    feeTotals,
    spreadCost,
    slippage,
    cancelRequote,
    missingReasons,
    trace: buildTrace(accountingInput, snapshotFacts),
  };
}

/**
 * targetScopes 계약을 계산 입력 전체에 적용한다.
 *
 * application 경계에서 batch source를 받아도 호출자가 요청한 strategy/market만 계산해야 하므로
 * scope가 있는 source는 동일한 필터를 통과시킨다. cash는 전역 잔고 evidence라 그대로 유지한다.
 */
function applyTargetScopeFilter(input: PnLAccountingInput): PnLAccountingInput {
  if (input.targetScopes === undefined || input.targetScopes.length === 0) {
    return input;
  }

  const scopeFilter = createTargetScopeFilter(input.targetScopes);

  return {
    ...input,
    fills: input.fills.filter((fill) =>
      scopeFilter.matchesScopedFact(fill.strategyId, fill.market),
    ),
    positions: input.positions.filter((position) =>
      scopeFilter.matchesScopedFact(position.strategyId, position.market),
    ),
    markPrices: input.markPrices.filter((markPrice) =>
      scopeFilter.matchesMarkPrice(markPrice.market),
    ),
    costQuality: input.costQuality.filter((fact) =>
      scopeFilter.matchesScopedFact(fact.strategyId, fact.market),
    ),
    pnlSnapshots: input.pnlSnapshots.filter((snapshot) =>
      scopeFilter.matchesSnapshot(snapshot.strategyId, snapshot.market),
    ),
    reconcileFacts: input.reconcileFacts.filter((reconcile) =>
      scopeFilter.matchesScopedFact(reconcile.strategyId, reconcile.market),
    ),
  };
}

/**
 * targetScopes를 source별 predicate로 바꾸는 작은 필터 객체를 만든다.
 *
 * market=null target은 strategy aggregate를 뜻해 해당 strategy의 모든 scoped fact를 포함한다.
 * 반대로 특정 market target은 aggregate snapshot을 포함하지 않아 단일 market 요청에 strategy 합계가
 * 섞이지 않게 한다.
 */
function createTargetScopeFilter(targetScopes: readonly PnLAccountingScope[]): {
  matchesScopedFact(strategyId: string, market: string): boolean;
  matchesSnapshot(strategyId: string, market: string | null): boolean;
  matchesMarkPrice(market: string): boolean;
} {
  const aggregateStrategies = new Set<string>();
  const scopedMarkets = new Set<string>();
  const targetMarkets = new Set<string>();

  for (const scope of targetScopes) {
    if (scope.market === null) {
      aggregateStrategies.add(scope.strategyId);
      continue;
    }

    scopedMarkets.add(scopeKey(scope.strategyId, scope.market));
    targetMarkets.add(scope.market);
  }

  return {
    matchesScopedFact(strategyId: string, market: string): boolean {
      return aggregateStrategies.has(strategyId) || scopedMarkets.has(scopeKey(strategyId, market));
    },
    matchesSnapshot(strategyId: string, market: string | null): boolean {
      if (aggregateStrategies.has(strategyId)) {
        return true;
      }

      return market !== null && scopedMarkets.has(scopeKey(strategyId, market));
    },
    matchesMarkPrice(market: string): boolean {
      return aggregateStrategies.size > 0 || targetMarkets.has(market);
    },
  };
}

/**
 * fill이 존재하는 strategy/market scope를 빠르게 판정한다.
 *
 * RECOVERABLE reconcile은 평균단가 보조 evidence라 실제 fill이 있는 scope에서는 계산 source로 승격하지
 * 않기 위해 이 coverage를 사용한다.
 */
function createFillScopeCoverage(fills: readonly PnLFillFact[]): {
  isCovered(strategyId: string, market: string): boolean;
} {
  const fillScopes = new Set(fills.map((fill) => scopeKey(fill.strategyId, fill.market)));

  return {
    isCovered(strategyId: string, market: string): boolean {
      return fillScopes.has(scopeKey(strategyId, market));
    },
  };
}

/**
 * current positions가 존재하는 scope를 판정한다.
 *
 * RECOVERABLE reconcile은 평균단가만 제공하므로, 같은 scope의 positions가 있으면 flat realized PnL이나
 * open quantity 처리를 positions fallback의 결측/평가 로직에 맡긴다.
 */
function createPositionScopeCoverage(positions: readonly PnLPositionFact[]): {
  isCovered(strategyId: string, market: string): boolean;
} {
  const positionScopes = new Set<string>();

  for (const position of positions) {
    positionScopes.add(scopeKey(position.strategyId, position.market));
  }

  return {
    isCovered(strategyId: string, market: string): boolean {
      return positionScopes.has(scopeKey(strategyId, market));
    },
  };
}

// ── fill ledger ──────────────────────────────────────────────────────────────

function buildFillLedger(fills: readonly PnLFillFact[]): Ledger {
  const ledger: Ledger = {
    cashKrw: new Decimal(0),
    realizedPnlKrw: new Decimal(0),
    positions: new Map(),
    filledOrderIds: new Set(),
    filledCount: 0,
  };

  for (const fill of fills) {
    const quantity = parseNonNegativeDecimal(fill.quantity);
    const price = parseNonNegativeDecimal(fill.price);
    const notional = quantity.times(price);
    const fee = parseNonNegativeDecimal(fill.fee);
    const feeKrw = fill.feeCurrency === "KRW" ? fee : new Decimal(0);

    if (quantity.isZero()) {
      continue;
    }

    // filled order 수 중복 제거
    if (!ledger.filledOrderIds.has(fill.orderId)) {
      ledger.filledOrderIds.add(fill.orderId);
      ledger.filledCount++;
    }

    const key = scopeKey(fill.strategyId, fill.market);
    const pos = getOrCreatePositionLedger(ledger, key, fill.strategyId, fill.market);

    if (fill.side === "BUY") {
      // KRW 원가에는 KRW로 확정된 수수료만 반영하고, 비-KRW fee는 feeTotals evidence로만 분리한다.
      const fillCostKrw = notional.plus(feeKrw);
      ledger.cashKrw = ledger.cashKrw.minus(fillCostKrw);
      pos.quantity = pos.quantity.plus(quantity);
      pos.costBasisKrw = pos.costBasisKrw.plus(fillCostKrw);
    } else {
      // SELL: FIFO 평균단가 기반 실현손익
      if (pos.quantity.lessThan(quantity)) {
        // 초과 매도는 invariant error — paper broker가 short을 만들지 않아야 한다.
        throw new PnLAccountingInvariantError(
          `SELL fill exceeds open position for ${fill.market}`,
        );
      }

      const averageCostKrw = pos.quantity.isZero()
        ? new Decimal(0)
        : pos.costBasisKrw.div(pos.quantity);
      const realizedCostBasisKrw = averageCostKrw.times(quantity);
      // 매도 손익도 KRW 환산 근거가 없는 비-KRW fee를 섞지 않아 KRW PnL 오염을 막는다.
      ledger.realizedPnlKrw = ledger.realizedPnlKrw.plus(notional.minus(realizedCostBasisKrw).minus(feeKrw));
      ledger.cashKrw = ledger.cashKrw.plus(notional.minus(feeKrw));
      pos.quantity = pos.quantity.minus(quantity);
      pos.costBasisKrw = pos.quantity.isZero()
        ? new Decimal(0)
        : pos.costBasisKrw.minus(realizedCostBasisKrw);
    }
  }

  return ledger;
}

/**
 * fill fact를 계산기가 소비할 deterministic execution order로 정렬한다.
 *
 * caller나 DB 반환 순서에 의존하면 같은 체결 집합도 다른 realized PnL을 만들 수 있으므로
 * `filledAt`을 우선하고, 동일 시각은 매수 우선 tie-break로 초과 매도 false positive를 줄인다.
 * 입력 배열은 변경하지 않는다.
 */
function sortFillsByExecutionTime(fills: readonly PnLFillFact[]): PnLFillFact[] {
  return [...fills].sort(compareFillFact);
}

function compareFillFact(left: PnLFillFact, right: PnLFillFact): number {
  const leftTime = toTime(left.filledAt);
  const rightTime = toTime(right.filledAt);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const sideCompare = sideSortRank(left.side) - sideSortRank(right.side);
  if (sideCompare !== 0) {
    return sideCompare;
  }

  return createFillTieBreakKey(left).localeCompare(createFillTieBreakKey(right));
}

function sideSortRank(side: PnLFillFact["side"]): number {
  return side === "BUY" ? 0 : 1;
}

function createFillTieBreakKey(fill: PnLFillFact): string {
  return JSON.stringify([
    fill.strategyId,
    fill.market,
    fill.orderId,
    fill.price,
    fill.quantity,
    fill.fee,
    fill.feeCurrency,
    fill.liquidity,
  ]);
}

// ── snapshot source priority ─────────────────────────────────────────────────

function selectEffectiveSnapshots(
  snapshots: readonly PnLSnapshotFact[],
): PnLSnapshotFact[] {
  const latestByStrategy = new Map<string, Map<string | null, PnLSnapshotFact>>();

  for (const snapshot of snapshots) {
    const marketKey = snapshot.market ?? null;
    const latestByMarket = latestByStrategy.get(snapshot.strategyId) ?? new Map<string | null, PnLSnapshotFact>();
    const existing = latestByMarket.get(marketKey);
    if (existing === undefined || compareSnapshotCandidate(snapshot, existing) > 0) {
      // 같은 strategy/market에 여러 snapshot이 있으면 최신 evidence 하나만 손익 source로 삼아 중복 합산을 막는다.
      latestByMarket.set(marketKey, snapshot);
    }
    latestByStrategy.set(snapshot.strategyId, latestByMarket);
  }

  return excludeMarketSnapshotsCoveredByAggregate(
    [...latestByStrategy.values()].flatMap((latestByMarket) => [...latestByMarket.values()]),
  ).sort(compareSnapshotScope);
}

/**
 * 같은 strategy의 aggregate snapshot과 market snapshot 중 중복 합산 없이 쓸 layer를 선택한다.
 *
 * `selectEffectiveSnapshots` 내부에서 strategy별 최신 snapshot 후보를 받은 뒤 호출된다. aggregate가 market
 * layer보다 최신이면 aggregate 하나가 strategy 전체를 대표하고, 더 최신 market snapshot이 있으면 오래된
 * aggregate가 최신 market evidence를 덮지 못하게 market layer를 선택한다. 입력과 출력은 모두 snapshot
 * fact 배열이며 외부 side effect는 없다.
 */
function excludeMarketSnapshotsCoveredByAggregate(
  snapshots: readonly PnLSnapshotFact[],
): PnLSnapshotFact[] {
  const byStrategy = new Map<string, PnLSnapshotFact[]>();
  for (const snapshot of snapshots) {
    const strategySnapshots = byStrategy.get(snapshot.strategyId) ?? [];
    strategySnapshots.push(snapshot);
    byStrategy.set(snapshot.strategyId, strategySnapshots);
  }

  const selected: PnLSnapshotFact[] = [];
  for (const strategySnapshots of byStrategy.values()) {
    const aggregate = strategySnapshots.find(
      (snapshot) => snapshot.market === null || snapshot.market === undefined,
    );
    const markets = strategySnapshots.filter(
      (snapshot) => snapshot.market !== null && snapshot.market !== undefined,
    );

    if (aggregate === undefined) {
      selected.push(...markets);
      continue;
    }

    if (markets.length === 0) {
      selected.push(aggregate);
      continue;
    }

    const aggregateTime = toTime(aggregate.capturedAt);
    const latestMarketTime = Math.max(...markets.map((snapshot) => toTime(snapshot.capturedAt)));
    if (aggregateTime >= latestMarketTime) {
      // aggregate가 market layer 이상으로 최신일 때만 하위 market snapshot을 덮어 중복 합산을 막는다.
      selected.push(aggregate);
    } else {
      // 더 최신 market snapshot이 있으면 오래된 aggregate 전체 합계가 최신 per-market 값을 덮지 못하게 한다.
      selected.push(...markets);
    }
  }

  return selected;
}

function compareSnapshotCandidate(left: PnLSnapshotFact, right: PnLSnapshotFact): number {
  const leftTime = toTime(left.capturedAt);
  const rightTime = toTime(right.capturedAt);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return createSnapshotTieBreakKey(left).localeCompare(createSnapshotTieBreakKey(right));
}

function compareSnapshotScope(left: PnLSnapshotFact, right: PnLSnapshotFact): number {
  const strategyCompare = left.strategyId.localeCompare(right.strategyId);
  if (strategyCompare !== 0) {
    return strategyCompare;
  }

  return (left.market ?? "").localeCompare(right.market ?? "");
}

function createSnapshotTieBreakKey(snapshot: PnLSnapshotFact): string {
  return JSON.stringify([
    snapshot.strategyId,
    snapshot.market ?? null,
    toTime(snapshot.capturedAt).toString(),
    parseFinancialDecimal(snapshot.equity).toFixed(),
    parseFinancialDecimal(snapshot.realizedPnl).toFixed(),
    parseFinancialDecimal(snapshot.unrealizedPnl).toFixed(),
    parseFinancialDecimal(snapshot.drawdownBps).toFixed(),
  ]);
}

function summarizeSnapshots(snapshots: readonly PnLSnapshotFact[]): {
  equityKrw: Decimal | null;
  realizedPnlKrw: Decimal | null;
  unrealizedPnlKrw: Decimal | null;
} {
  if (snapshots.length === 0) {
    return {
      equityKrw: null,
      realizedPnlKrw: null,
      unrealizedPnlKrw: null,
    };
  }

  return snapshots.reduce(
    (acc, snapshot) => ({
      equityKrw: acc.equityKrw.plus(parseFinancialDecimal(snapshot.equity)),
      realizedPnlKrw: acc.realizedPnlKrw.plus(parseFinancialDecimal(snapshot.realizedPnl)),
      unrealizedPnlKrw: acc.unrealizedPnlKrw.plus(parseFinancialDecimal(snapshot.unrealizedPnl)),
    }),
    {
      equityKrw: new Decimal(0),
      realizedPnlKrw: new Decimal(0),
      unrealizedPnlKrw: new Decimal(0),
    },
  );
}

// ── position/reconcile ledger seeding ────────────────────────────────────────

/**
 * reconcile fact에서 승격한 position 정보를 ledger에 보강한다.
 *
 * ⚠️ reconcile 원천 데이터는 현재 평균단가만 제공하고 보유 수량은 알 수 없다.
 * 따라서 `pos.quantity`는 "0"이며, 이 함수는 평균단가(initialAverageEntryPrice)만 설정한다.
 * fill이 없는 scope에서 reconcile의 평균단가를 참조할 수 있게 하는 것이 목적이다.
 *
 * 향후 reconcile에 quantity가 추가되면 아래 `pos.quantity !== "0"` 분기가 활성화되어
 * 시장가치와 미실현손익도 정상 계산된다.
 */
function seedLedgerFromReconcile(
  ledger: Ledger,
  positions: readonly PnLPositionFact[],
): void {
  for (const pos of positions) {
    const key = scopeKey(pos.strategyId, pos.market);
    const existing = ledger.positions.get(key);
    if (existing !== undefined && existing.quantity.greaterThan(0)) {
      // fill을 통해 이미 수량이 있는 position은 reconcile로 덮지 않는다.
      // fill 우선, reconcile은 fill이 없는 scope에서만 보강.
      continue;
    }

    const entry = getOrCreatePositionLedger(ledger, key, pos.strategyId, pos.market);
    const avgPrice = pos.averageEntryPrice !== null
      ? parseFinancialDecimal(pos.averageEntryPrice)
      : null;
    entry.initialAverageEntryPrice = avgPrice;

    // reconcile에 quantity가 추가되면 이 분기가 활성화된다.
    if (pos.quantity !== "0") {
      const qty = parseNonNegativeDecimal(pos.quantity);
      if (qty.greaterThan(0) && avgPrice !== null) {
        entry.quantity = qty;
        entry.costBasisKrw = qty.times(avgPrice);
      }
    }
  }
}

function seedLedgerFromPositions(
  ledger: Ledger,
  positions: readonly PnLPositionFact[],
): void {
  for (const pos of positions) {
    const key = scopeKey(pos.strategyId, pos.market);
    const existing = ledger.positions.get(key);
    const shouldApplyFallbackRealizedPnl = existing === undefined;
    if (existing !== undefined && existing.quantity.greaterThan(0)) {
      // fill 또는 reconcile로 이미 수량이 있으면 position fallback으로 덮지 않는다.
      continue;
    }

    const entry = getOrCreatePositionLedger(ledger, key, pos.strategyId, pos.market);
    const avgPrice = pos.averageEntryPrice !== null
      ? parseFinancialDecimal(pos.averageEntryPrice)
      : null;
    entry.initialAverageEntryPrice = avgPrice;
    entry.fallbackUnrealizedPnlKrw = pos.unrealizedPnl !== null
      ? parseFinancialDecimal(pos.unrealizedPnl)
      : null;

    if (shouldApplyFallbackRealizedPnl) {
      // position-only fallback에서는 positions.realizedPnl이 확정 손익 source이므로 ledger에 보존한다.
      ledger.realizedPnlKrw = ledger.realizedPnlKrw.plus(parseFinancialDecimal(pos.realizedPnl));
    }

    if (pos.quantity !== "0") {
      const qty = parseNonNegativeDecimal(pos.quantity);
      if (qty.greaterThan(0)) {
        // 평균단가가 없어도 수량은 평가액/equity 근거이므로 먼저 보존한다.
        entry.quantity = qty;
        if (avgPrice !== null) {
          entry.costBasisKrw = qty.times(avgPrice);
        }
      }
    }
  }
}

// ── mark-to-market ───────────────────────────────────────────────────────────

function buildMarkPriceMap(
  markPrices: readonly PnLMarkPriceFact[],
): Map<string, Decimal> {
  const latestByMarket = new Map<string, PnLMarkPriceFact>();
  for (const mp of markPrices) {
    const existing = latestByMarket.get(mp.market);
    if (existing === undefined || compareMarkPriceCandidate(mp, existing) > 0) {
      // 같은 market의 평가가가 여러 개면 가장 최신 관측값만 MTM evidence로 사용한다.
      latestByMarket.set(mp.market, mp);
    }
  }

  return new Map(
    [...latestByMarket.entries()].map(([market, fact]) => [
      market,
      parseNonNegativeDecimal(fact.priceKrw),
    ]),
  );
}

function compareMarkPriceCandidate(
  left: PnLMarkPriceFact,
  right: PnLMarkPriceFact,
): number {
  const leftTime = observedTimeOrUnknown(left);
  const rightTime = observedTimeOrUnknown(right);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const sourceRankCompare = markPriceSourceRank(left.source) - markPriceSourceRank(right.source);
  if (sourceRankCompare !== 0) {
    return sourceRankCompare;
  }

  return createMarkPriceTieBreakKey(left).localeCompare(createMarkPriceTieBreakKey(right));
}

function observedTimeOrUnknown(markPrice: PnLMarkPriceFact): number {
  return markPrice.observedAt === undefined
    ? Number.NEGATIVE_INFINITY
    : toTime(markPrice.observedAt);
}

function markPriceSourceRank(source: string): number {
  const normalized = source.toLowerCase();
  if (normalized.includes("bid")) {
    return 2;
  }
  if (normalized.includes("last")) {
    return 1;
  }
  return 0;
}

function createMarkPriceTieBreakKey(markPrice: PnLMarkPriceFact): string {
  return JSON.stringify([
    markPrice.market,
    markPrice.priceKrw,
    markPrice.source,
  ]);
}

/**
 * ledger position을 output detail로 변환하고 노출 비중을 계산한다.
 *
 * calculator 내부에서만 호출되며, ledger와 mark price, cash 또는 snapshot equity를 읽어 position별 평가액,
 * 미실현손익, exposure를 산출한다. snapshot equity가 있으면 최종 output equity의 분모와 맞추기 위해
 * cash 대신 snapshot equity를 exposure denominator로 사용한다. missingReasons 배열에는 평가가 결측만
 * 추가하며 그 외 외부 side effect는 없다.
 */
function calculatePositionDetails(
  ledger: Ledger,
  markPriceMap: Map<string, Decimal>,
  cashKrw: Decimal | null,
  snapshotEquityKrw: Decimal | null,
  missingReasons: PnLMissingReason[],
): PnLPositionDetail[] {
  const details: PnLPositionDetail[] = [];
  const totalMarketValueForExposure = computeLedgerMarketValueForExposure(ledger, markPriceMap);
  const exposureEquityKrw =
    totalMarketValueForExposure === null
      ? null
      : snapshotEquityKrw !== null
        ? snapshotEquityKrw.plus(totalMarketValueForExposure)
        : cashKrw !== null
          ? cashKrw.plus(totalMarketValueForExposure)
          : null;

  for (const [key, pos] of ledger.positions) {
    if (pos.quantity.isZero()) {
      continue;
    }

    const markPrice = markPriceMap.get(pos.market === "__aggregate__" ? "" : pos.market);
    const averageEntryPrice = pos.quantity.greaterThan(0) && pos.costBasisKrw.greaterThan(0)
      ? pos.costBasisKrw.div(pos.quantity)
      : pos.initialAverageEntryPrice;

    let marketValueKrw: Decimal | null = null;
    let unrealizedPnlKrw: Decimal | null = null;

    if (markPrice !== undefined) {
      marketValueKrw = pos.quantity.times(markPrice);
      if (averageEntryPrice !== null && pos.costBasisKrw.greaterThan(0)) {
        unrealizedPnlKrw = marketValueKrw.minus(pos.costBasisKrw);
      } else if (averageEntryPrice !== null) {
        unrealizedPnlKrw = pos.quantity.times(markPrice).minus(pos.quantity.times(averageEntryPrice));
      } else if (pos.fallbackUnrealizedPnlKrw !== null) {
        // 평균단가가 결측이어도 position snapshot의 미실현손익 추정값은 fallback evidence로 보존한다.
        unrealizedPnlKrw = pos.fallbackUnrealizedPnlKrw;
      }
    } else {
      if (pos.fallbackUnrealizedPnlKrw !== null) {
        // 평가가가 없으면 시장가치는 불명확하지만, position snapshot의 미실현손익은 총손익 근거로 유지한다.
        unrealizedPnlKrw = pos.fallbackUnrealizedPnlKrw;
      }
      // 평가가가 없음
      const scope = pos.market === "__aggregate__" ? scopeKey(pos.strategyId, null) : key;
      missingReasons.push({
        message: "평가가 없음",
        reasonCode: "NO_MARK_PRICE",
        scope,
        source: "mark_prices",
      });
    }

    // 노출 비중 계산
    let exposureBps: Decimal | null = null;
    if (marketValueKrw !== null && exposureEquityKrw !== null && exposureEquityKrw.greaterThan(0)) {
      exposureBps = marketValueKrw.div(exposureEquityKrw).times(10000);
    }

    details.push({
      strategyId: pos.strategyId,
      market: pos.market === "__aggregate__" ? "" : pos.market,
      quantity: pos.quantity.toFixed(),
      averageEntryPrice: averageEntryPrice?.toFixed() ?? null,
      marketValueKrw: marketValueKrw?.toFixed() ?? null,
      unrealizedPnlKrw: unrealizedPnlKrw?.toFixed() ?? null,
      exposureBps: exposureBps?.toFixed() ?? null,
    });
  }

  return details;
}

/**
 * 모든 open position의 평가액 합계를 노출 비중 계산용으로 먼저 산출한다.
 *
 * 어느 한 포지션이라도 평가가가 없으면 전체 equity 기준 노출을 확정할 수 없으므로 null을 반환한다.
 */
function computeLedgerMarketValueForExposure(
  ledger: Ledger,
  markPriceMap: Map<string, Decimal>,
): Decimal | null {
  let total = new Decimal(0);

  for (const pos of ledger.positions.values()) {
    if (pos.quantity.isZero()) {
      continue;
    }

    const markPrice = markPriceMap.get(pos.market === "__aggregate__" ? "" : pos.market);
    if (markPrice === undefined) {
      return null;
    }

    total = total.plus(pos.quantity.times(markPrice));
  }

  return total;
}

// ── 비용 분해 ────────────────────────────────────────────────────────────────

/**
 * 전체 fill fact의 통화별 fee evidence를 집계한다.
 *
 * snapshot source priority는 손익 중복 합산만 막아야 하며, 비용 분해 evidence는 체결 원천 전체에서
 * 독립적으로 보여줘야 하므로 snapshot coverage를 적용하지 않는다.
 */
function aggregateFeesByCurrency(fills: readonly PnLFillFact[]): Map<string, Decimal> {
  const feesByCurrency = new Map<string, Decimal>();

  for (const fill of fills) {
    const fee = parseNonNegativeDecimal(fill.fee);
    const existingFee = feesByCurrency.get(fill.feeCurrency) ?? new Decimal(0);
    feesByCurrency.set(fill.feeCurrency, existingFee.plus(fee));
  }

  return feesByCurrency;
}

function buildFeeTotals(feesByCurrency: Map<string, Decimal>): PnLFeeTotal[] {
  return [...feesByCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => ({
      currency,
      amount: amount.toFixed(),
    }));
}

function aggregateQualityMetric(
  facts: readonly PnLCostQualityFact[],
  field: "spreadCostBps" | "slippageBps" | "cancelRequotePenaltyBps",
): PnLExecutionQualityMetric {
  const values: Decimal[] = [];
  for (const fact of facts) {
    const v = fact[field];
    if (typeof v === "string" && v.length > 0) {
      values.push(parseFinancialDecimal(v));
    }
  }

  if (values.length === 0) {
    return {
      value: null,
      available: false,
      sampleCount: 0,
      source: "unavailable",
    };
  }

  const sum = values.reduce((acc, v) => acc.plus(v), new Decimal(0));
  const avg = sum.div(values.length);

  return {
    value: avg.toFixed(),
    available: true,
    sampleCount: values.length,
    source: "cost_quality_facts",
  };
}

// ── scope / status ───────────────────────────────────────────────────────────

function buildScopes(
  scopes: PnLAccountingScope[],
  input: PnLAccountingInput,
  snapshots: readonly PnLSnapshotFact[],
  fills: readonly PnLFillFact[],
  ledger: Ledger,
  capturedAt: string,
): void {
  const snapshotCoverage = createSnapshotCoverage(
    snapshots.map((s) => ({ strategyId: s.strategyId, market: s.market })),
  );
  const positionCoverage = createPositionScopeCoverage(input.positions);
  const seenScopes = new Set<string>();

  // snapshot에서 scope 추가
  for (const snapshot of snapshots) {
    const key = scopeKey(snapshot.strategyId, snapshot.market);
    if (!shouldIncludeOutputScope(input.targetScopes, snapshot.strategyId, snapshot.market)) continue;
    if (seenScopes.has(key)) continue;
    seenScopes.add(key);
    scopes.push({
      strategyId: snapshot.strategyId,
      market: snapshot.market,
      capturedAt: normalizeTimestamp(snapshot.capturedAt),
      source: "pnl_snapshots",
      status: "CALCULATED",
    });
  }

  // non-recoverable reconcile은 계산 source보다 수동 검토 evidence가 우선이므로 먼저 scope를 고정한다.
  for (const r of input.reconcileFacts) {
    const key = scopeKey(r.strategyId, r.market);
    if (!shouldIncludeOutputScope(input.targetScopes, r.strategyId, r.market)) continue;
    if (seenScopes.has(key) || snapshotCoverage.isCovered(r.strategyId, r.market)) continue;
    if (r.recoveryStatus === "RECOVERABLE") continue;
    seenScopes.add(key);
    scopes.push({
      strategyId: r.strategyId,
      market: r.market,
      capturedAt: normalizeTimestamp(r.reconciledAt),
      source: "live_reconcile_position_snapshots",
      status: "MANUAL_REVIEW_REQUIRED",
    });
  }

  // fill에서 scope 추가
  const fillScopes = resolveFillScopes(fills);
  for (const [key, scope] of fillScopes) {
    if (!shouldIncludeOutputScope(input.targetScopes, scope.strategyId, scope.market)) continue;
    if (seenScopes.has(key)) continue;
    seenScopes.add(key);
    const openPositions = findOpenPositionsForScope(ledger, scope.strategyId, scope.market);
    const hasOpenPosition = openPositions.length > 0;
    const hasMarkPriceForMarket = openPositions.every((p) =>
      input.markPrices.some((mp) => mp.market === p.market),
    );
    const fillStatus =
      hasOpenPosition && !hasMarkPriceForMarket ? "PARTIAL" : "CALCULATED";
    scopes.push({
      strategyId: scope.strategyId,
      market: scope.market,
      capturedAt: resolveFillScopeCapturedAt(fills, scope.strategyId, scope.market, capturedAt),
      source: "fills",
      status: fillStatus,
    });
  }

  // RECOVERABLE reconcile은 fill이 없는 scope에서만 fallback evidence로 남긴다.
  for (const r of input.reconcileFacts) {
    const key = scopeKey(r.strategyId, r.market);
    if (!shouldIncludeOutputScope(input.targetScopes, r.strategyId, r.market)) continue;
    if (seenScopes.has(key) || snapshotCoverage.isCovered(r.strategyId, r.market)) continue;
    if (r.recoveryStatus !== "RECOVERABLE") continue;
    if (positionCoverage.isCovered(r.strategyId, r.market)) continue;
    const reconcileStatus =
      r.averageEntryPrice === null || r.averageEntryPrice === undefined
        ? "MANUAL_REVIEW_REQUIRED"
        : "PARTIAL";
    seenScopes.add(key);
    scopes.push({
      strategyId: r.strategyId,
      market: r.market,
      capturedAt: normalizeTimestamp(r.reconciledAt),
      source: "live_reconcile_position_snapshots",
      // 평균단가 없는 RECOVERABLE은 수량 이전에 진입가 근거가 없어 계산 scope도 수동 검토로 올린다.
      status: reconcileStatus,
    });
  }

  // position fallback에서 scope 추가
  for (const p of input.positions) {
    const key = scopeKey(p.strategyId, p.market);
    if (!shouldIncludeOutputScope(input.targetScopes, p.strategyId, p.market)) continue;
    if (seenScopes.has(key) || snapshotCoverage.isCovered(p.strategyId, p.market)) continue;
    seenScopes.add(key);
    const hasAverageEntry = p.averageEntryPrice !== null && p.averageEntryPrice !== undefined;
    const hasOpenPosition = parseNonNegativeDecimal(p.quantity).greaterThan(0);
    const hasMarkPrice = input.markPrices.some((mp) => mp.market === p.market);
    const positionStatus =
      !hasOpenPosition || (hasAverageEntry && hasMarkPrice) ? "CALCULATED" : "PARTIAL";
    scopes.push({
      strategyId: p.strategyId,
      market: p.market,
      capturedAt: normalizeTimestamp(p.updatedAt),
      source: "positions",
      status: positionStatus,
    });
  }

  // scope가 하나도 없으면 global unavailable 추가
  if (scopes.length === 0) {
    scopes.push({
      strategyId: "global",
      market: null,
      capturedAt,
      source: "unavailable",
      status: "UNAVAILABLE",
    });
  }
}

/**
 * fill 기반 output scope의 source timestamp를 산출한다.
 *
 * `buildScopes` 내부에서만 호출하며, snapshot coverage 이후 실제 ledger에 쓰인 fill 목록만 입력으로 받는다.
 * market이 null이면 strategy aggregate fill scope이므로 해당 strategy의 최신 fill 시각을 반환한다.
 * 입력 source가 비어 있으면 caller가 넘긴 fallback capturedAt을 유지하며 외부 side effect는 없다.
 */
function resolveFillScopeCapturedAt(
  fills: readonly PnLFillFact[],
  strategyId: string,
  market: string | null,
  fallbackCapturedAt: string,
): string {
  const sourceTimes = fills
    .filter((fill) => fill.strategyId === strategyId && (market === null || fill.market === market))
    .map((fill) => toTime(fill.filledAt));

  return sourceTimes.length === 0
    ? fallbackCapturedAt
    : new Date(Math.max(...sourceTimes)).toISOString();
}

function determineStatus(
  scopes: readonly PnLAccountingScope[],
  missingReasons: readonly PnLMissingReason[],
  input: PnLAccountingInput,
): PnLAccountingStatus {
  if (scopes.length === 0)
    return "UNAVAILABLE";

  const hasUnavailable = scopes.some((s) => s.status === "UNAVAILABLE");
  const hasManualReview = scopes.some((s) => s.status === "MANUAL_REVIEW_REQUIRED");
  const hasPartial = scopes.some((s) => s.status === "PARTIAL");
  const allCalculated = scopes.every((s) => s.status === "CALCULATED");

  if (hasManualReview)
    return "MANUAL_REVIEW_REQUIRED";
  if (hasUnavailable && missingReasons.length > 0)
    return "UNAVAILABLE";
  if (hasPartial)
    return "PARTIAL";
  if (missingReasons.length > 0)
    return "PARTIAL";
  if (allCalculated)
    return "CALCULATED";

  // 데이터가 전혀 없는 경우
  const hasAnyInput =
    input.fills.length > 0 ||
    input.positions.length > 0 ||
    input.pnlSnapshots.length > 0 ||
    input.reconcileFacts.length > 0;

  return hasAnyInput ? "PARTIAL" : "UNAVAILABLE";
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * targetScopes가 지정된 계산에서 output scope를 노출해도 되는지 판정한다.
 *
 * 특정 market target은 해당 market scope만 반환하고, market=null target은 strategy 전체 요청으로 보아
 * aggregate와 하위 market scope를 모두 허용한다.
 */
function shouldIncludeOutputScope(
  targetScopes: readonly PnLAccountingScope[] | undefined,
  strategyId: string,
  market: string | null,
): boolean {
  if (targetScopes === undefined || targetScopes.length === 0) {
    return true;
  }

  return targetScopes.some((target) => {
    if (target.strategyId !== strategyId) {
      return false;
    }

    return target.market === null || target.market === market;
  });
}

function findOpenPositionsForScope(
  ledger: Ledger,
  strategyId: string,
  market: string | null,
): PositionLedger[] {
  return [...ledger.positions.values()].filter(
    (position) =>
      position.strategyId === strategyId &&
      (market === null || position.market === market) &&
      position.quantity.greaterThan(0),
  );
}

function getOrCreatePositionLedger(
  ledger: Ledger,
  key: string,
  strategyId: string,
  market: string,
): PositionLedger {
  const existing = ledger.positions.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const pos: PositionLedger = {
    quantity: new Decimal(0),
    costBasisKrw: new Decimal(0),
    market,
    strategyId,
    initialAverageEntryPrice: null,
    fallbackUnrealizedPnlKrw: null,
  };
  ledger.positions.set(key, pos);

  return pos;
}

/**
 * 수량이 있는 position-like fact가 하나라도 있는지 확인한다.
 *
 * realized/unrealized PnL을 0으로 확정할지, 계산 불가(null)로 남길지 결정하는 guard다.
 */
function hasQuantifiedPosition(positions: readonly PnLPositionFact[]): boolean {
  return positions.some((position) => parseNonNegativeDecimal(position.quantity).greaterThan(0));
}

function hasUnquantifiedReconcilePosition(positions: readonly PnLPositionFact[]): boolean {
  return positions.some((position) => parseNonNegativeDecimal(position.quantity).isZero());
}

function parseNonNegativeDecimal(value: string | undefined): Decimal {
  const d = parseFinancialDecimal(value ?? "0");
  if (d.isNegative()) {
    throw new PnLAccountingInvariantError("value must be non-negative");
  }

  return d;
}

function decimalOrNull(value: Decimal | null): string | null {
  return value === null ? null : value.toFixed();
}

function sumDecimalParts(
  parts: readonly { active: boolean; value: Decimal | null }[],
): Decimal | null {
  const activeParts = parts.filter((part) => part.active);
  if (activeParts.length === 0) {
    return null;
  }

  let sum = new Decimal(0);
  for (const part of activeParts) {
    if (part.value === null) {
      return null;
    }
    sum = sum.plus(part.value);
  }

  return sum;
}

function resolveCalculationCapturedAt(input: PnLAccountingInput): string {
  const timestamp =
    input.capturedAt ??
    input.trace?.lastSourceTimestamp ??
    findLastSourceTimestamp(input);

  return timestamp === undefined
    ? "1970-01-01T00:00:00.000Z"
    : normalizeTimestamp(timestamp);
}

function normalizeTimestamp(timestamp: unknown): string {
  return new Date(toTime(timestamp)).toISOString();
}

function toTime(timestamp: unknown): number {
  const value = timestamp instanceof Date
    ? timestamp.getTime()
    : new Date(String(timestamp)).getTime();
  if (!Number.isFinite(value)) {
    throw new PnLAccountingInvariantError("PnL accounting timestamp must be valid");
  }

  return value;
}

function computePositionMarketValue(details: readonly PnLPositionDetail[]): Decimal | null {
  if (details.length === 0) {
    // 포지션이 없으면 시장가치는 0으로 확정
    return new Decimal(0);
  }

  let sum = new Decimal(0);
  for (const d of details) {
    if (d.marketValueKrw !== null) {
      sum = sum.plus(parseFinancialDecimal(d.marketValueKrw));
    } else {
      return null; // 하나라도 평가가가 없으면 전체 계산 불가
    }
  }

  return sum;
}

function computeUnrealizedPnl(details: readonly PnLPositionDetail[]): Decimal | null {
  if (details.length === 0) {
    // 포지션이 없으면 미실현손익은 0으로 확정
    return new Decimal(0);
  }

  let hasAny = false;
  let sum = new Decimal(0);
  for (const d of details) {
    if (d.unrealizedPnlKrw !== null) {
      sum = sum.plus(parseFinancialDecimal(d.unrealizedPnlKrw));
      hasAny = true;
    } else {
      return null;
    }
  }

  return hasAny ? sum : null;
}

/**
 * trace 객체를 안전하게 조립한다.
 *
 * `exactOptionalPropertyTypes`에서 undefined 할당을 피하기 위해 optional property는
 * 값이 존재할 때만 할당한다.
 */
function buildTrace(
  input: PnLAccountingInput,
  snapshotFacts: readonly PnLSnapshotFact[],
): PnLAccountingOutput["trace"] {
  const trace: PnLAccountingOutput["trace"] = { ...input.trace };

  const tables: string[] = [];
  if (input.fills.length > 0) tables.push("fills");
  if (snapshotFacts.length > 0) tables.push("pnl_snapshots");
  if (input.positions.length > 0) tables.push("positions");
  if (input.reconcileFacts.length > 0) tables.push("live_reconcile_position_snapshots");
  if (tables.length > 0) {
    trace.sourceTables = tables;
  }

  const lastTs = findLastSourceTimestamp(input);
  if (lastTs !== undefined) {
    trace.lastSourceTimestamp = lastTs;
  }

  return trace;
}

function findLastSourceTimestamp(input: PnLAccountingInput): string | undefined {
  const timestamps: number[] = [];

  for (const fill of input.fills) {
    timestamps.push(toTime(fill.filledAt));
  }

  for (const pos of input.positions) {
    timestamps.push(toTime(pos.updatedAt));
  }

  for (const mp of input.markPrices) {
    if (mp.observedAt) {
      timestamps.push(toTime(mp.observedAt));
    }
  }

  for (const s of input.pnlSnapshots) {
    timestamps.push(toTime(s.capturedAt));
  }

  if (input.cash?.observedAt) {
    timestamps.push(toTime(input.cash.observedAt));
  }

  for (const reconcile of input.reconcileFacts) {
    timestamps.push(toTime(reconcile.reconciledAt));
  }

  if (timestamps.length === 0) {
    return undefined;
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

/**
 * PnL 회계 계산의 invariant 위반을 나타내는 오류다.
 *
 * 계산기는 외부 side effect 없이 실패하지만, 초과 매도나 음수 금액을 조용히 보정하면
 * 운영 손익 report가 잘못된 evidence가 되므로 명시적 예외로 중단한다.
 */
export class PnLAccountingInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PnLAccountingInvariantError";
  }
}
