import type { Selectable } from "kysely";
import type { PnLAccountingOutput } from "../../../application/pnl-accounting.js";
import type { PnlSnapshotInsertInput, ReconcilePositionSnapshotRecord } from "./types.js";
import type { LiveReconcilePositionSnapshotsTable } from "../schema.js";

/**
 * PnL snapshot row 변환 옵션이다.
 *
 * drawdown은 calculator output에 포함되지 않는 별도 시계열 값이므로 호출자가 명시적으로 제공해야 한다.
 * unknown을 0으로 보정하면 risk report가 낙폭 해소로 오판할 수 있어 required option으로 둔다.
 */
export interface PnlSnapshotRowInputOptions {
  /** payload에 보존할 source fingerprint */
  sourceFingerprint?: string;
  /** 호출자가 산출한 최대 낙폭 bps */
  drawdownBps: string;
}

/**
 * PnL 회계 output을 `pnl_snapshots` table insert row 목록으로 변환한다.
 *
 * 각 scope가 하나의 snapshot row가 되며, `market=null`은 strategy aggregate snapshot이다.
 * payload_json에는 fee totals, execution quality metrics, missing reasons, trace 등
 * 손익 재계산과 감사에 필요한 보조 evidence를 함께 보존한다.
 *
 * @param output calculator가 생성한 PnL accounting 결과
 * @param capturedAt snapshot 캡처 시각
 * @returns `pnl_snapshots` insert row 목록
 */
export function toPnlSnapshotRowInputs(
  output: PnLAccountingOutput,
  capturedAt: Date | string,
  options: PnlSnapshotRowInputOptions,
): PnlSnapshotInsertInput[] {
  const captured = normalizeCapturedAt(capturedAt);

  if (
    output.scopes.length === 0 ||
    output.equityKrw === null ||
    output.equityKrw === undefined ||
    output.realizedPnlKrw === null ||
    output.realizedPnlKrw === undefined ||
    output.unrealizedPnlKrw === null ||
    output.unrealizedPnlKrw === undefined
  ) {
    // 계산 불가 값을 0으로 꾸며 저장하면 운영자가 실제 0 PnL로 오해하므로 durable snapshot을 만들지 않는다.
    return [];
  }

  const rows: PnlSnapshotInsertInput[] = [];
  const persistedScopes = selectPersistableScopes(output.scopes);

  for (const scope of persistedScopes) {
    rows.push({
      strategy_id: scope.strategyId,
      market: scope.market,
      captured_at: captured,
      equity: output.equityKrw,
      realized_pnl: output.realizedPnlKrw,
      unrealized_pnl: output.unrealizedPnlKrw,
      drawdown_bps: options.drawdownBps,
      payload_json: buildPnlSnapshotPayload(output, scope, options.sourceFingerprint),
    });
  }

  return rows;
}

/**
 * `pnl_snapshots`에 저장 가능한 scope만 고른다.
 *
 * calculator output의 최상위 PnL 값은 여러 market scope에 균등 분배할 수 없는 aggregate 값이다.
 * 따라서 aggregate scope가 정확히 하나 있으면 그 row만 저장하고, 단일 market 계산일 때만 market row를 허용한다.
 * 단일 전략의 여러 market만 계산된 경우에는 strategy aggregate row 하나로 접어 중복 과대 표시를 막는다.
 * 여러 strategy aggregate가 섞이면 top-level global PnL을 strategy별 값으로 배분할 근거가 없어 저장하지 않는다.
 */
function selectPersistableScopes(
  scopes: PnLAccountingOutput["scopes"],
): Array<{ strategyId: string; market: string | null }> {
  const aggregateScopes = scopes.filter((scope) => scope.market === null);
  if (aggregateScopes.length === 1) {
    const [scope] = aggregateScopes;
    return [{ strategyId: scope!.strategyId, market: null }];
  }

  if (aggregateScopes.length > 1) {
    // 최상위 PnL은 전역 합계라 strategy별 aggregate row로 복제하면 report와 risk evidence가 과대 표시된다.
    return [];
  }

  if (scopes.length === 1) {
    const [scope] = scopes;
    return [{ strategyId: scope!.strategyId, market: scope!.market }];
  }

  const strategyIds = [...new Set(scopes.map((scope) => scope.strategyId))];
  if (strategyIds.length === 1) {
    return [{ strategyId: strategyIds[0]!, market: null }];
  }

  // 여러 strategy가 섞인 output은 단일 row로 의미 있게 표현할 수 없어 저장하지 않는다.
  return [];
}

/**
 * snapshot payload JSON을 조립한다.
 *
 * DB의 `payload_json`은 추후 PnL 재계산 없이도 비용 분해, 결측 원인, trace 정보를 조회할 수 있게
 * 보존하는 evidence 저장소다. 민감 정보는 넣지 않는다.
 *
 * @param output calculator 출력
 * @param scope 선택적 scope (특정 market payload에만 포함할 정보 구분용)
 * @returns PostgreSQL jsonb에 저장할 payload object
 */
function buildPnlSnapshotPayload(
  output: PnLAccountingOutput,
  scope?: { strategyId: string; market: string | null },
  sourceFingerprint?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    status: output.status,
    feeTotals: output.feeTotals.map((fee) => ({
      currency: fee.currency,
      amount: fee.amount,
    })),
    spreadCost: {
      value: output.spreadCost.value,
      available: output.spreadCost.available,
      sampleCount: output.spreadCost.sampleCount,
    },
    slippage: {
      value: output.slippage.value,
      available: output.slippage.available,
      sampleCount: output.slippage.sampleCount,
    },
    cancelRequote: {
      value: output.cancelRequote.value,
      available: output.cancelRequote.available,
      sampleCount: output.cancelRequote.sampleCount,
    },
    cashKrw: output.cashKrw,
  };

  if (sourceFingerprint !== undefined) {
    payload.sourceFingerprint = sourceFingerprint;
  }

  // scope가 명시된 경우 해당 scope의 position detail을 포함한다.
  if (scope !== undefined && scope.market !== null) {
    const posDetail = output.positions.find(
      (pos) => pos.strategyId === scope.strategyId && pos.market === scope.market,
    );
    if (posDetail !== undefined) {
      payload.positionDetail = {
        quantity: posDetail.quantity,
        averageEntryPrice: posDetail.averageEntryPrice,
        marketValueKrw: posDetail.marketValueKrw,
        unrealizedPnlKrw: posDetail.unrealizedPnlKrw,
        exposureBps: posDetail.exposureBps,
      };
    }
  }

  // missing reasons는 scope로 필터하지 않고 전체를 보존한다 (감사 evidence).
  if (output.missingReasons.length > 0) {
    payload.missingReasons = output.missingReasons.map((reason) => ({
      message: reason.message,
      reasonCode: reason.reasonCode,
      scope: reason.scope,
      source: reason.source,
    }));
  }

  // trace 정보는 최소한만 보존한다 (runId, correlationId, sourceTables, lastSourceTimestamp).
  if (output.trace.runId !== undefined || output.trace.correlationId !== undefined) {
    payload.trace = {
      runId: output.trace.runId,
      correlationId: output.trace.correlationId,
      sourceTables: output.trace.sourceTables,
      lastSourceTimestamp: output.trace.lastSourceTimestamp,
    };
  }

  return payload;
}

/**
 * `live_reconcile_position_snapshots` table row를 application-level reconcile snapshot record로 변환한다.
 *
 * 이 함수는 순수 변환이며 DB 접근이나 side effect는 없다.
 *
 * @param row DB에서 읽은 live_reconcile_position_snapshots row
 * @returns application-level reconcile position snapshot record
 */
export function toReconcilePositionSnapshotRecord(
  row: Selectable<LiveReconcilePositionSnapshotsTable>,
): ReconcilePositionSnapshotRecord {
  return {
    id: row.id,
    runId: row.run_id,
    exchange: row.exchange,
    market: row.market,
    strategyId: row.strategy_id,
    quantity: row.quantity,
    averageEntryPrice: row.average_entry_price,
    recoveryStatus: row.recovery_status,
    source: row.source,
    capturedAt: row.captured_at,
    evidence: (row.evidence_json ?? {}) as Record<string, unknown>,
  };
}

function normalizeCapturedAt(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
