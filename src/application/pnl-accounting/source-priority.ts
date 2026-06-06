import type { NumericString } from "../../domain/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import type {
  PnLAccountingScope,
  PnLFillFact,
  PnLMarkPriceFact,
  PnLMissingReason,
  PnLPositionFact,
  PnLReconcileFact,
  PnLSource,
} from "./types.js";

/**
 * PnL source 우선순위 결정 결과다.
 *
 * calculator에 넘기기 전 scope별로 어떤 source를 쓸지 결정한다. position row와 reconcile row만
 * 골라내며, snapshot이 있는 scope의 position fallback을 제외한다.
 */
export interface SourceResolution {
  /** 선택된 포지션 source 목록 (snapshot에서 온 scope는 `null`로 대체됨) */
  resolvedPositions: (PnLPositionFact | PnLReconcileFact)[];
  /** source 우선순위 적용 과정에서 발생한 계산 불가 원인 */
  missingReasons: PnLMissingReason[];
  /** 각 strategy/market scope에 적용된 source 표시 */
  scopeSources: Map<string, PnLSource>;
}

/**
 * PnL snapshot과 position/reconcile fact 사이의 source 우선순위를 적용한다.
 *
 * 우선순위는 다음과 같다.
 * 1. `pnl_snapshots`가 있는 scope는 snapshot을 우선한다. 해당 scope의 positions/reconcile fallback은
 *    합산에서 제외한다.
 * 2. `market=null` snapshot은 strategy aggregate이므로 같은 strategy의 모든 market positions fallback을
 *    덮는다.
 * 3. `live_reconcile_position_snapshots`는 `RECOVERABLE`이고 평균단가 근거가 있을 때 source 후보가 된다.
 * 4. `MANUAL_REVIEW_REQUIRED`거나 평균단가가 결측이면 계산 불가 원인으로만 남긴다.
 * 5. snapshot도 reconcile도 없는 scope만 `positions` current snapshot을 fallback으로 사용한다.
 *
 * 이 함수는 순수 판단 로직이며 DB 접근이나 side effect는 없다.
 */
export function resolvePnLSources(
  snapshots: readonly { strategyId: string; market: string | null }[],
  positions: readonly PnLPositionFact[],
  reconcileFacts: readonly PnLReconcileFact[],
): SourceResolution {
  const missingReasons: PnLMissingReason[] = [];
  const scopeSources = new Map<string, PnLSource>();

  // ── 1. snapshot coverage 판정 ──────────────────────────────────────────────
  const strategiesWithAggregateSnapshot = new Set<string>();
  const marketsCoveredBySnapshot = new Set<string>();
  const positionFallbackScopes = new Set(
    positions.map((position) => scopeKey(position.strategyId, position.market)),
  );

  for (const snapshot of snapshots) {
    if (snapshot.market === null || snapshot.market === undefined) {
      // strategy aggregate snapshot: 같은 strategy의 모든 market positions fallback을 덮는다.
      strategiesWithAggregateSnapshot.add(snapshot.strategyId);
      scopeSources.set(scopeKey(snapshot.strategyId, null), "pnl_snapshots");
      continue;
    }

    marketsCoveredBySnapshot.add(scopeKey(snapshot.strategyId, snapshot.market));
    scopeSources.set(scopeKey(snapshot.strategyId, snapshot.market), "pnl_snapshots");
  }

  // ── 2. reconcile fact 처리 ─────────────────────────────────────────────────
  const resolvedReconcilePositions: PnLReconcileFact[] = [];
  for (const reconcile of reconcileFacts) {
    const key = scopeKey(reconcile.strategyId, reconcile.market);

    // snapshot이 있는 scope는 reconcile도 fallback도 쓰지 않는다.
    if (scopeSources.has(key)) {
      continue;
    }

    // aggregate snapshot이 있는 strategy는 reconcile도 덮는다.
    if (strategiesWithAggregateSnapshot.has(reconcile.strategyId)) {
      continue;
    }

    // RECOVERABLE이 아닌 reconcile 상태는 손익 근거가 아니라 수동 확인 evidence로 보존한다.
    if (reconcile.recoveryStatus !== "RECOVERABLE") {
      missingReasons.push({
        message: reconcile.recoveryStatus === "MANUAL_REVIEW_REQUIRED"
          ? "수동 검토 필요"
          : "복구 가능 상태만 사용 가능",
        reasonCode: reconcile.recoveryStatus === "MANUAL_REVIEW_REQUIRED"
          ? "MANUAL_REVIEW_REQUIRED"
          : "RECOVERABLE_ONLY",
        scope: key,
        source: "live_reconcile_position_snapshots",
      });
      // non-RECOVERABLE reconcile은 해당 scope의 포지션 근거가 신뢰 불가하다는 evidence이므로
      // 아래 positions fallback이 계산 source로 다시 선택되지 않게 scope를 점유한다.
      scopeSources.set(key, "live_reconcile_position_snapshots");
      continue;
    }

    if (positionFallbackScopes.has(key)) {
      // current position은 수량과 확정 손익을 갖기 때문에 평균단가뿐인 reconcile보다 우선한다.
      continue;
    }

    // 평균단가가 결측이면 계산 불가
    if (reconcile.averageEntryPrice === null || reconcile.averageEntryPrice === undefined) {
      missingReasons.push({
        message: "평균단가 근거 없음",
        reasonCode: "AVERAGE_ENTRY_MISSING",
        scope: key,
        source: reconcile.averageEntrySource ?? "live_reconcile_position_snapshots",
      });
      continue;
    }

    // RECOVERABLE이고 평균단가가 있으면 계산 source 후보가 된다.
    resolvedReconcilePositions.push(reconcile);
    scopeSources.set(key, "live_reconcile_position_snapshots");
  }

  // ── 3. positions fallback 처리 ────────────────────────────────────────────
  const fallbackPositions: PnLPositionFact[] = [];
  for (const position of positions) {
    const key = scopeKey(position.strategyId, position.market);

    // snapshot 또는 aggregate snapshot이 이미 coverage 중이면 fallback 제외
    if (scopeSources.has(key) || strategiesWithAggregateSnapshot.has(position.strategyId)) {
      continue;
    }

    // 오픈 수량이 있을 때만 평균단가가 MTM에 필요하며, 청산 완료 position은 realizedPnl만 보존하면 된다.
    if (
      hasOpenQuantity(position.quantity) &&
      (position.averageEntryPrice === null || position.averageEntryPrice === undefined)
    ) {
      missingReasons.push({
        message: "평균단가 근거 없음",
        reasonCode: "AVERAGE_ENTRY_MISSING",
        scope: key,
        source: "positions",
      });
      // 수량과 unrealized PnL만이라도 집계할 수 있으면 fallback 목록에 넣는다.
      // 단, 평균단가 없이 실현손익 계산은 불가능하다.
      fallbackPositions.push(position);
      scopeSources.set(key, "positions");
      continue;
    }

    fallbackPositions.push(position);
    scopeSources.set(key, "positions");
  }

  // ── 4. source 결정 ─────────────────────────────────────────────────────────
  // snapshot만 있거나 reconcile만 있거나 position만 있는 경우를 scopeSources 기반으로 판정
  const hasSnapshotCoverage = snapshots.length > 0;
  const hasResolvedSources =
    resolvedReconcilePositions.length > 0 || fallbackPositions.length > 0;

  if (hasSnapshotCoverage && !hasResolvedSources) {
    // snapshot만 있고 다른 source는 없는 경우 — snapshot이 모든 scope를 덮음
  }

  const resolvedPositions = [
    ...resolvedReconcilePositions.map(toPositionLike),
    ...fallbackPositions,
  ];

  return {
    resolvedPositions,
    missingReasons,
    scopeSources,
  };
}

/**
 * reconcile fact를 position fact 형태로 변환해 calculator가 동일하게 처리할 수 있게 한다.
 *
 * DB reconcile source는 quantity와 평균단가를 함께 제공할 수 있으므로 quantity가 있으면 그대로 보존한다.
 * 외부 caller가 아직 quantity를 제공하지 않는 경우만 "0"으로 둬 계산기가 규모 결측을 분리해 처리하게 한다.
 */
function toPositionLike(reconcile: PnLReconcileFact): PnLPositionFact {
  return {
    strategyId: reconcile.strategyId,
    market: reconcile.market,
    quantity: reconcile.quantity ?? "0",
    averageEntryPrice: reconcile.averageEntryPrice,
    realizedPnl: "0",
    unrealizedPnl: null,
    updatedAt: reconcile.reconciledAt,
    source: `live_reconcile_position_snapshots:${reconcile.averageEntrySource ?? "reconciled"}`,
  };
}

/**
 * 포지션 수량이 MTM 평균단가를 요구하는 오픈 상태인지 판정한다.
 *
 * `resolvePnLSources` 내부에서만 호출하며, 입력은 non-negative decimal 문자열이라는 domain invariant를
 * 유지해야 한다. 반환값은 평균단가 결측을 계산 불가 원인으로 기록할지 결정하는 데 쓰이며 side effect는 없다.
 */
function hasOpenQuantity(quantity: NumericString): boolean {
  return parseFinancialDecimal(quantity).greaterThan(0);
}

/**
 * snapshot이 존재하는 PnL scope를 빠르게 판정하는 coverage helper다.
 *
 * market이 null인 snapshot은 해당 strategy의 전체 시장 합계를 의미하므로
 * 같은 strategy의 모든 market position fallback을 막는다.
 */
export function createSnapshotCoverage(
  snapshots: readonly { strategyId: string; market: string | null }[],
): {
  isCovered(strategyId: string, market: string): boolean;
} {
  const strategiesWithAggregate = new Set<string>();
  const markets = new Set<string>();

  for (const snapshot of snapshots) {
    if (snapshot.market === null || snapshot.market === undefined) {
      strategiesWithAggregate.add(snapshot.strategyId);
    } else {
      markets.add(scopeKey(snapshot.strategyId, snapshot.market));
    }
  }

  return {
    isCovered(strategyId: string, market: string): boolean {
      return (
        strategiesWithAggregate.has(strategyId) || markets.has(scopeKey(strategyId, market))
      );
    },
  };
}

/**
 * scopeKey: strategyId와 market을 안정적인 문자열 key로 만든다.
 *
 * market이 null이면 strategy aggregate scope를 의미한다.
 */
export function scopeKey(strategyId: string, market: string | null): string {
  return market === null ? `${strategyId}::*` : `${strategyId}::${market}`;
}

/**
 * PnL 계산에 사용할 전체 source label을 조합한다.
 *
 * 여러 source가 함께 쓰일 때 "+"로 연결하고, source가 전혀 없으면 "unavailable"을 반환한다.
 */
export function buildSourceLabel(sourceBits: string[]): PnLSource {
  const unique = [...new Set(sourceBits)].filter((s) => s.length > 0).sort();
  if (unique.length === 0) {
    return "unavailable";
  }

  return unique.join("+") as PnLSource;
}

/**
 * fill facts에서 strategy/market scope를 추출해 source label을 만든다.
 *
 * fills만으로 계산한 scope는 "fills" source로 표시한다.
 */
export function resolveFillScopes(
  fills: readonly PnLFillFact[],
): Map<string, { strategyId: string; market: string | null }> {
  const scopes = new Map<string, { strategyId: string; market: string | null }>();
  const strategies = new Set(fills.map((f) => f.strategyId));

  for (const strategyId of strategies) {
    scopes.set(scopeKey(strategyId, null), { strategyId, market: null });
  }

  for (const fill of fills) {
    scopes.set(scopeKey(fill.strategyId, fill.market), {
      strategyId: fill.strategyId,
      market: fill.market,
    });
  }

  return scopes;
}
