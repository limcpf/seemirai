import {
  PostgresPnlAccountingRepository,
  computePnlSnapshotSourceFingerprint,
} from "../../infrastructure/db/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import { calculatePnLAccounting } from "./calculator.js";
import type {
  PnLAccountingInput,
  PnLAccountingOutput,
  PnLSnapshotFact,
} from "./types.js";
import { scopeKey } from "./source-priority.js";
import type { PersistPnlSnapshotResult } from "../../infrastructure/db/pnl-accounting/types.js";

/**
 * PnL 회계 closeout이 DB에서 읽어야 하는 source data provider port다.
 *
 * 이 port를 구현하는 쪽은 fills, positions, reconcile facts, pnl snapshots, mark prices, cash, cost quality를
 * 읽어 calculator에 넘길 형태로 정규화한다. closeout은 DB schema를 직접 알지 못하며, data provider만 바꾸면
 * fixture/mock 기반 테스트나 향후 worker input injection으로 대체 가능하다.
 */
export interface PnLAccountingDataProvider {
  /**
   * PnL 회계 계산에 필요한 모든 source data를 읽어 calculator 입력으로 정규화한다.
   *
   * @param capturedAt 계산 기준 시각. 없으면 provider가 source timestamp에서 도출한다.
   * @returns calculator 입력
   */
  loadPnLAccountingInput(capturedAt?: Date | string): Promise<PnLAccountingInput>;
  /**
   * Drawdown 산출에만 사용할 과거 PnL snapshot history를 읽는다.
   *
   * 현재 계산 source인 `loadPnLAccountingInput().pnlSnapshots`와 과거 peak 비교 source는 의미가 다르다.
   * 구현체가 이 method를 제공하지 않으면 closeout은 history 없음으로 처리하고, 현재 계산 source를 history로 재사용하지 않는다.
   *
   * @param capturedAt 현재 closeout 캡처 시각
   * @returns drawdown peak 비교용 과거 snapshot 목록
   */
  loadPnLAccountingSnapshotHistory?(capturedAt?: Date | string): Promise<readonly PnLSnapshotFact[]>;
}

/**
 * PnL 회계 closeout 실행 입력이다.
 *
 * data provider와 repository를 주입받아 순수 계산 → persistence까지 하나의 use case로 묶는다.
   * drawdown 산출은 data provider의 별도 snapshot history method로만 수행해 현재 계산 source와 과거 peak source를 섞지 않는다.
 */
export interface RunPnLAccountingCloseoutOptions {
  /** source data provider — fills, positions, reconcile, snapshots, mark prices, cash, cost quality를 읽는다 */
  dataProvider: PnLAccountingDataProvider;
  /** PnL snapshot persistence repository */
  repository: PostgresPnlAccountingRepository;
  /** snapshot 캡처 시각. 없으면 provider가 source timestamp에서 도출한다. */
  capturedAt?: Date | string;
  /** 테스트 재현성을 위한 clock 주입. 없으면 실제 현재 시각을 사용한다. */
  clock?: () => Date;
}

/**
 * PnL 회계 closeout 실행 결과다.
 *
 * `output`은 calculator가 생성한 순수 계산 결과이고, `persisted`는 repository에 저장된 snapshot record 정보다.
 * persistence가 중복 insert를 차단한 경우 `persisted.inserted`가 false일 수 있다.
 */
export interface RunPnLAccountingCloseoutResult {
  /** calculator 출력 */
  output: PnLAccountingOutput;
  /** persistence 결과. inserted=false면 source fingerprint 충돌로 중복이 차단됐거나 저장 가능한 snapshot이 없었다. */
  persisted: PersistPnlSnapshotResult;
  /** 중복 감지에 사용된 source fingerprint */
  sourceFingerprint: string;
  /** closeout에 사용된 snapshot 캡처 시각 */
  capturedAt: string;
  /** 산출된 최대 낙폭 bps. 과거 snapshot history가 없거나 알 수 없으면 "0"이다. */
  drawdownBps: string;
}

/**
 * PnL/포지션 회계 closeout을 실행한다.
 *
 * data provider가 DB에서 source data를 읽고, calculator로 순수 계산한 뒤, drawdown을 산출하고
 * repository로 durable snapshot을 저장한다. 이 함수는 외부 side effect를 repository persist 호출로만
 * 제한하며, provider 호출 실패와 calculator invariant error를 분리해 throw한다.
 *
 * ## Drawdown 산출
 *
 * drawdown은 `(peakEquity - currentEquity) / peakEquity * 10000` bps로 계산한다.
   * peak equity는 별도로 로딩한 과거 `pnl_snapshots` history 중 동일 strategy/market scope의 equity를 기준으로 한다.
 * 이전 snapshot이 없거나 current equity가 peak보다 크면 drawdown은 0이다.
 *
 * @param options closeout 실행 입력
 * @returns closeout 결과
 */
export async function runPnLAccountingCloseout(
  options: RunPnLAccountingCloseoutOptions,
): Promise<RunPnLAccountingCloseoutResult> {
  const clock = options.clock ?? (() => new Date());
  const capturedAt = normalizeCapturedAt(options.capturedAt ?? clock());

  // ── 1. source data 로딩 ──────────────────────────────────────────────────
  const accountingInput = await options.dataProvider.loadPnLAccountingInput(capturedAt);

  // ── 2. 순수 계산 ────────────────────────────────────────────────────────
  const output = calculatePnLAccounting(accountingInput);

  // ── 3. drawdown 산출 ────────────────────────────────────────────────────
  // drawdown은 현재 snapshot의 capturedAt보다 이전 snapshot 중에서 peak equity를 찾아 비교한다.
  // 현재 run이 포함된 snapshot을 drawdown 기준으로 삼지 않도록 capturedAt 기준 이전 항목만 사용한다.
  const drawdownHistory = await options.dataProvider.loadPnLAccountingSnapshotHistory?.(capturedAt) ?? [];
  const drawdownBps = computeDrawdownBps(output, drawdownHistory, capturedAt);

  // ── 4. source fingerprint 계산 ──────────────────────────────────────────
  const sourceFingerprint = computePnlSnapshotSourceFingerprint(
    output,
    capturedAt,
    drawdownBps,
  );

  // ── 5. durable snapshot persistence ─────────────────────────────────────
  // idempotency는 repository 내부에서 captured_at + scope + fingerprint 기반 advisory lock으로 처리된다.
  const persisted = await options.repository.persistPnlSnapshot({
    output,
    capturedAt,
    drawdownBps,
    sourceFingerprint,
  });

  return {
    output,
    persisted,
    sourceFingerprint,
    capturedAt: normalizeCapturedAt(capturedAt),
    drawdownBps,
  };
}

/**
 * PnL 회계 결과에서 현재 equity와 동일 scope의 과거 snapshot peak equity를 비교해 drawdown bps를 산출한다.
 *
 * calculator output의 equity가 null이면 drawdown을 알 수 없으므로 "0"을 반환한다.
 * `since`보다 strictly 이전(`< since`) snapshot만 peak equity 후보로 사용한다.
 * 현재 계산 source로 전달된 snapshot을 이 history에 섞으면 현재 equity가 오염될 수 있으므로 호출자는 별도 history만 넘겨야 한다.
 * 이전 snapshot이 없거나 current equity가 peak 이상이면 drawdown은 0이다.
 *
 * @param output calculator 출력
 * @param allSnapshots drawdown history용 과거 pnl_snapshots
 * @param since 이 시각 이후 snapshot은 peak 기준에서 제외한다.
 * @returns drawdown bps (Decimal 문자열). 알 수 없으면 "0"
 */
function computeDrawdownBps(
  output: PnLAccountingOutput,
  allSnapshots: readonly PnLSnapshotFact[],
  since: Date | string,
): string {
  if (output.equityKrw === null || output.equityKrw === undefined) {
    return "0";
  }

  const sinceMs = toTimeMs(since);
  if (!Number.isFinite(sinceMs)) {
    return "0";
  }

  const currentEquity = parseFinancialDecimal(output.equityKrw);
  let peakEquity = currentEquity;
  const outputScopeKeys = new Set(output.scopes.map((scope) => scopeKey(scope.strategyId, scope.market)));
  if (outputScopeKeys.size === 0) {
    return "0";
  }

  for (const snapshot of allSnapshots) {
    const snapshotTimeMs = toTimeMs(snapshot.capturedAt);
    // 현재 run 이후 또는 같은 시각 snapshot은 peak 기준에서 제외한다.
    if (!Number.isFinite(snapshotTimeMs) || snapshotTimeMs >= sinceMs) {
      continue;
    }

    if (!outputScopeKeys.has(scopeKey(snapshot.strategyId, snapshot.market))) {
      continue;
    }

    const snapshotEquity = parseFinancialDecimal(snapshot.equity);
    if (snapshotEquity.greaterThan(peakEquity)) {
      peakEquity = snapshotEquity;
    }
  }

  if (peakEquity.lessThanOrEqualTo(0) || currentEquity.greaterThanOrEqualTo(peakEquity)) {
    return "0";
  }

  // drawdown bps = (peak - current) / peak * 10000
  const drawdown = peakEquity.minus(currentEquity).div(peakEquity).mul(10000);
  return drawdown.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Date 또는 ISO timestamp 입력을 ISO 8601 문자열로 정규화한다.
 *
 * 잘못된 timestamp는 closeout 전체를 실패시키고, 정규화 실패는 caller에게 예외로 전파한다.
 */
function normalizeCapturedAt(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Date 또는 ISO timestamp를 epoch millis로 정규화한다.
 *
 * drawdown 계산에서 snapshot capturedAt 비교에만 사용하며, 잘못된 입력은 NaN을 반환해 필터에서 제외된다.
 */
function toTimeMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
