import type {
  DailyReportDataProvider,
  DailyReportExecutionQualityFact,
  DailyReportSourceData,
  DailyReportWindow,
} from "../../../application/index.js";
import { createDailyReportJobPlan } from "../../../application/index.js";
import { orderLifecycleStatuses } from "../../../domain/index.js";
import type { JsonRecord } from "../../../domain/index.js";
import type { Database } from "../database.js";
import { enqueueJob } from "../jobs.js";
import type { EnqueueJobResult } from "../jobs.js";

const orderStatusRank = new Map<string, number>(
  orderLifecycleStatuses.map((status, index) => [status, index]),
);

/**
 * PostgreSQL에서 daily report facts와 job 예약을 처리하는 repository다.
 *
 * application service는 `DailyReportDataProvider`만 의존하고, 이 class가 Kysely query와 `jobs` insert side effect를 담당한다.
 * 모든 fact 조회는 `DailyReportWindow`의 UTC half-open 범위를 사용해야 하며, job 예약은 `report.daily:<reportDate>`
 * idempotency key를 통해 같은 기준일의 중복 생성을 막는다.
 */
export class PostgresDailyReportRepository implements DailyReportDataProvider {
  public constructor(private readonly database: Database) {}

  /**
   * 리포트 기준 window에 속한 DB facts를 application 집계 입력으로 변환한다.
   */
  public async loadDailyReportSourceData(window: DailyReportWindow): Promise<DailyReportSourceData> {
    return loadDailyReportSourceData(this.database, window);
  }

  /**
   * daily report worker가 처리할 job을 idempotent하게 예약한다.
   */
  public async enqueueDailyReportJob(
    input: EnqueueDailyReportJobInput,
  ): Promise<EnqueueDailyReportJobResult> {
    return enqueueDailyReportJob(this.database, input);
  }
}

/**
 * daily report job 예약 입력이다.
 *
 * `reportDate`가 업무 중복 차단 기준이며 `runAfter`와 `maxAttempts`는 scheduler 정책만 조정한다. 같은 기준일을 두 번 예약해도
 * `jobs.idempotency_key` 때문에 같은 row가 재사용되어야 한다.
 */
export interface EnqueueDailyReportJobInput {
  reportDate: string;
  runAfter?: Date | string;
  maxAttempts?: number;
}

/**
 * daily report job 예약 결과다.
 *
 * `created=false`이면 같은 기준일 job이 이미 존재했다는 뜻이다. 호출자는 이 값을 사용해 중복 Telegram 전송이 아니라 기존
 * job 상태 확인 또는 skip으로 흐름을 이어가야 한다.
 */
export interface EnqueueDailyReportJobResult extends EnqueueJobResult {
  plan: ReturnType<typeof createDailyReportJobPlan>;
}

/**
 * PostgreSQL facts를 daily report application 입력으로 읽는다.
 *
 * 이 함수는 DB read만 수행하고 리포트 문구를 만들지 않는다. JSON payload의 선택적 metric은 best-effort로 읽되 값이 없으면
 * fact에서 생략해 application 집계가 `unavailable`로 표시하게 한다.
 */
export async function loadDailyReportSourceData(
  database: Database,
  window: DailyReportWindow,
): Promise<DailyReportSourceData> {
  const queryWindow = toQueryWindow(window);

  if (database.isTransaction) {
    // 이미 열린 transaction은 호출자가 snapshot 경계를 소유하므로, 테스트/상위 workflow의 rollback 범위를 깨지 않는다.
    return loadDailyReportSourceDataFromSnapshot(database, queryWindow);
  }

  // 여러 fact table을 서로 다른 MVCC 시점으로 읽으면 같은 기준일 재실행 결과가 흔들리므로 단일 repeatable-read snapshot으로 묶는다.
  return database.transaction().setIsolationLevel("repeatable read").execute(async (transaction) =>
    loadDailyReportSourceDataFromSnapshot(transaction, queryWindow),
  );
}

/**
 * 하나의 MVCC snapshot 안에서 daily report fact들을 순서대로 읽는다.
 *
 * 이 helper는 외부 side effect 없이 DB read만 수행한다. 호출자는 repeatable-read transaction 또는 이미 열린 transaction을
 * 넘겨야 하며, 반환된 fact 묶음은 같은 기준일 window와 같은 DB snapshot에서 나온 값이라는 invariant를 유지해야 한다.
 */
async function loadDailyReportSourceDataFromSnapshot(
  database: Database,
  queryWindow: DailyReportQueryWindow,
): Promise<DailyReportSourceData> {
  const orders = await loadOrderFacts(database, queryWindow);
  const fills = await loadFillFacts(database, queryWindow);
  const positions = await loadPositionFacts(database, queryWindow);
  const pnlSnapshots = await loadPnlSnapshotFacts(database, queryWindow);
  const auditEvents = await loadAuditEventFacts(database, queryWindow);
  const riskEvents = await loadRiskEventFacts(database, queryWindow);
  const executionQuality = await loadExecutionQualityFacts(database, queryWindow);

  return {
    orders,
    fills,
    positions,
    pnlSnapshots,
    auditEvents,
    riskEvents,
    executionQuality,
  };
}

/**
 * DB jobs queue에 daily report job을 예약한다.
 *
 * 현재 schema에는 `(job_type, report_date)` composite unique key가 없으므로 application idempotency key에 두 값을 함께
 * 넣는다. 이 경계에서 duplicate insert를 삼켜 기존 row를 반환해야 scheduler 재시작이나 수동 재실행이 중복 전송으로 번지지 않는다.
 */
export async function enqueueDailyReportJob(
  database: Database,
  input: EnqueueDailyReportJobInput,
): Promise<EnqueueDailyReportJobResult> {
  const plan = createDailyReportJobPlan(input);
  const result = await enqueueJob(database, {
    jobType: plan.jobType,
    idempotencyKey: plan.idempotencyKey,
    payloadJson: { ...plan.payloadJson },
    ...(plan.runAfter === undefined ? {} : { runAfter: plan.runAfter }),
    ...(plan.maxAttempts === undefined ? {} : { maxAttempts: plan.maxAttempts }),
  });

  return {
    ...result,
    plan,
  };
}

/**
 * 기준일 window 안에 생성된 주문을 읽어 상태별 거래 흐름 입력으로 변환한다.
 *
 * 주문 생성 시각을 기준으로 삼아 리포트의 주문 수가 같은 주문 retry나 fill row 개수에 의해 중복 증가하지 않게 한다.
 */
async function loadOrderFacts(
  database: Database,
  window: DailyReportQueryWindow,
): Promise<DailyReportSourceData["orders"]> {
  const rows = await database
    .selectFrom("orders")
    .select(["id", "status", "strategy_id", "market", "requested_notional", "created_at"])
    .where("created_at", ">=", window.utcStartAt)
    .where("created_at", "<", window.utcEndAt)
    .execute();
  const orderEvents = await loadAcceptedOrderStateEvents(database, rows.map((row) => row.id));
  const eventsByOrderId = groupOrderEventsByOrderId(orderEvents);

  return rows.map((row) => ({
    status: resolveOrderStatusAtWindowEnd(row.status, eventsByOrderId.get(row.id) ?? [], window),
    strategyId: row.strategy_id,
    market: row.market,
    requestedNotional: row.requested_notional,
    createdAt: row.created_at,
  }));
}

/**
 * 기준일 window 안의 체결 row를 읽어 비용과 거래 횟수 입력으로 변환한다.
 *
 * fill은 실제 수수료와 체결 명목 금액의 확정 근거다. 주문과 left join해 strategy id를 best-effort로 보강하지만, 과거 데이터
 * 손상으로 주문 row가 없어도 체결 비용 자체는 리포트에서 누락하지 않는다.
 */
async function loadFillFacts(
  database: Database,
  window: DailyReportQueryWindow,
): Promise<DailyReportSourceData["fills"]> {
  const rows = await database
    .selectFrom("fills as f")
    .leftJoin("orders as o", "o.id", "f.order_id")
    .select([
      "o.strategy_id as strategy_id",
      "f.market as market",
      "f.side as side",
      "f.price as price",
      "f.quantity as quantity",
      "f.fee as fee",
      "f.fee_currency as fee_currency",
      "f.liquidity as liquidity",
      "f.filled_at as filled_at",
    ])
    .where("f.filled_at", ">=", window.utcStartAt)
    .where("f.filled_at", "<", window.utcEndAt)
    .execute();

  return rows.map((row) => ({
    ...(row.strategy_id === null || row.strategy_id === undefined ? {} : { strategyId: row.strategy_id }),
    market: row.market,
    side: row.side,
    price: row.price,
    quantity: row.quantity,
    fee: row.fee,
    feeCurrency: row.fee_currency,
    liquidity: row.liquidity,
    filledAt: row.filled_at,
  }));
}

/**
 * 기준일 종료 전까지 알려진 포지션 snapshot을 읽는다.
 *
 * positions는 시계열이 아니라 현재 상태 테이블이다. 기준일 종료 후 갱신됐다는 이유로 row를 제외하면 과거 리포트 재실행 때
 * fallback 손익과 open position 수가 사라지므로, repository는 현재 snapshot 전체를 읽고 application 집계가 source를 표시한다.
 */
async function loadPositionFacts(
  database: Database,
  _window: DailyReportQueryWindow,
): Promise<DailyReportSourceData["positions"]> {
  const rows = await database
    .selectFrom("positions")
    .select(["strategy_id", "market", "quantity", "realized_pnl", "unrealized_pnl", "updated_at"])
    .execute();

  return rows.map((row) => ({
    strategyId: row.strategy_id,
    market: row.market,
    quantity: row.quantity,
    realizedPnl: row.realized_pnl,
    unrealizedPnl: row.unrealized_pnl,
    updatedAt: row.updated_at,
  }));
}

/**
 * 기준일 window 안의 PnL snapshot을 읽는다.
 *
 * 같은 strategy/market의 여러 snapshot 중 최신값 선택은 application 집계가 담당한다. repository는 DB timestamp window만
 * 강제해 persistence와 업무 집계 책임을 분리한다.
 */
async function loadPnlSnapshotFacts(
  database: Database,
  window: DailyReportQueryWindow,
): Promise<DailyReportSourceData["pnlSnapshots"]> {
  const rows = await database
    .selectFrom("pnl_snapshots")
    .select([
      "strategy_id",
      "market",
      "captured_at",
      "equity",
      "realized_pnl",
      "unrealized_pnl",
      "drawdown_bps",
    ])
    .where("captured_at", ">=", window.utcStartAt)
    .where("captured_at", "<", window.utcEndAt)
    .execute();

  return rows.map((row) => ({
    strategyId: row.strategy_id,
    market: row.market,
    capturedAt: row.captured_at,
    equity: row.equity,
    realizedPnl: row.realized_pnl,
    unrealizedPnl: row.unrealized_pnl,
    drawdownBps: row.drawdown_bps,
  }));
}

/**
 * 기준일 window 안의 감사 이벤트를 읽는다.
 *
 * 폐기 후보 필터링은 payload kind를 봐야 하므로 repository는 원본 JSON을 보존한다. 이 단계에서 임의로 reason code를
 * 해석하지 않아 새 audit payload가 추가되어도 application 집계에서 일관되게 처리할 수 있다.
 */
async function loadAuditEventFacts(
  database: Database,
  window: DailyReportQueryWindow,
): Promise<DailyReportSourceData["auditEvents"]> {
  const rows = await database
    .selectFrom("audit_events")
    .select(["event_type", "severity", "payload_json", "occurred_at"])
    .where("occurred_at", ">=", window.utcStartAt)
    .where("occurred_at", "<", window.utcEndAt)
    .execute();

  return rows.map((row) => ({
    eventType: row.event_type,
    severity: row.severity,
    payloadJson: row.payload_json,
    occurredAt: row.occurred_at,
  }));
}

/**
 * 기준일 window 안의 리스크 이벤트를 읽는다.
 *
 * `action`과 `risk_type`은 차단 사유 리포트의 기본 축이므로 별도 컬럼 값을 그대로 보존한다. payload JSON은 상세 근거가
 * 필요한 후속 확장용으로 함께 전달한다.
 */
async function loadRiskEventFacts(
  database: Database,
  window: DailyReportQueryWindow,
): Promise<DailyReportSourceData["riskEvents"]> {
  const rows = await database
    .selectFrom("risk_events")
    .select(["risk_type", "severity", "action", "market", "strategy_id", "payload_json", "occurred_at"])
    .where("occurred_at", ">=", window.utcStartAt)
    .where("occurred_at", "<", window.utcEndAt)
    .execute();

  return rows.map((row) => ({
    riskType: row.risk_type,
    severity: row.severity,
    action: row.action,
    market: row.market,
    strategyId: row.strategy_id,
    payloadJson: row.payload_json,
    occurredAt: row.occurred_at,
  }));
}

/**
 * 기준일 window 안의 paper execution 품질과 비용 snapshot을 읽는다.
 *
 * fill 수수료와 별도로 슬리피지, spread 비용, 취소/재호가 비용은 JSON payload에만 있을 수 있다. repository는 가능한 값만
 * fact로 올리고, application이 없는 metric을 unavailable로 표시한다.
 */
async function loadExecutionQualityFacts(
  database: Database,
  window: DailyReportQueryWindow,
): Promise<DailyReportExecutionQualityFact[]> {
  const rows = await database
    .selectFrom("fills as f")
    .innerJoin("orders as o", "o.id", "f.order_id")
    .leftJoin("paper_orders as p", "p.order_id", "o.id")
    .select([
      "o.id as order_id",
      "o.strategy_id as strategy_id",
      "o.market as market",
      "o.reason_json as reason_json",
      "p.fill_model_json as fill_model_json",
    ])
    .where("f.filled_at", ">=", window.utcStartAt)
    .where("f.filled_at", "<", window.utcEndAt)
    .orderBy("o.id", "asc")
    .orderBy("f.filled_at", "asc")
    .execute();
  const filledOrders = new Set<string>();

  return rows.flatMap((row) => {
    if (filledOrders.has(row.order_id)) {
      return [];
    }
    // 체결 품질은 실제 체결이 있는 주문만 평균에 넣어 주문 후보의 예상 비용이 실행 품질을 왜곡하지 않게 한다.
    filledOrders.add(row.order_id);

    const actualSlippageBps = readNestedString(row.fill_model_json, [
      "paper_fill_simulation",
      "slippageBps",
    ]);
    const expectedSlippageBps = readNestedString(row.reason_json, [
      "cost_snapshot",
      "expected_slippage_bps_p95",
    ]);
    const fact: DailyReportExecutionQualityFact = {
      strategyId: row.strategy_id,
      market: row.market,
    };

    assignIfDefined(fact, "slippageBps", actualSlippageBps ?? expectedSlippageBps);
    assignIfDefined(fact, "spreadCostBps", readNestedString(row.reason_json, [
      "cost_snapshot",
      "spread_cost_bps_p75",
    ]));
    assignIfDefined(fact, "cancelRequotePenaltyBps", readNestedString(row.reason_json, [
      "cost_snapshot",
      "cancel_requote_penalty_bps",
    ]));

    return [fact];
  });
}

/**
 * 기준일 종료 시점 주문 상태를 복원하기 위해 읽는 accepted order event row다.
 *
 * repository 내부 전용 모델이며 DB row를 수정하지 않는다. 상태 복원은 `fromStatus`/`toStatus`, lifecycle rank,
 * half-open window 종료 시각을 기준으로 수행한다.
 */
interface DailyReportOrderStateEventRow {
  /** 상태 전이가 속한 주문 ID다. */
  orderId: string;
  /** 전이 직전 상태이며, window 종료 이후 첫 전이를 만났을 때 과거 상태 복원에 사용한다. */
  fromStatus: string;
  /** 전이 이후 상태이며, window 종료 이전 마지막 전이의 기준 상태로 사용한다. */
  toStatus: string;
  /** 상태 전이가 발생한 업무 시각이다. */
  occurredAt: Date | string;
}

/**
 * 주문 snapshot을 기준일 종료 시점 상태로 되돌리기 위한 accepted 상태 전이 event를 읽는다.
 *
 * `orders.status`는 현재 상태라 과거 기준일 재실행에 그대로 쓰면 deterministic하지 않다. 이 함수는 상태 복원에 필요한
 * append-only `order_events`만 읽고, 상태 선택 자체는 application fact 변환 단계에서 수행한다.
 */
async function loadAcceptedOrderStateEvents(
  database: Database,
  orderIds: readonly string[],
): Promise<DailyReportOrderStateEventRow[]> {
  if (orderIds.length === 0) {
    return [];
  }

  const rows = await database
    .selectFrom("order_events")
    .select([
      "order_id",
      "from_status",
      "to_status",
      "occurred_at",
    ])
    .where("order_id", "in", orderIds)
    .where("accepted", "=", true)
    .execute();

  return rows.map((row) => ({
    orderId: row.order_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    occurredAt: row.occurred_at,
  }));
}

/**
 * 상태 전이 event를 주문 ID별로 묶는다.
 *
 * 같은 주문의 전이 순서 비교는 별도 함수에서 하므로 이 함수는 group side effect 없이 Map만 구성한다.
 */
function groupOrderEventsByOrderId(
  events: readonly DailyReportOrderStateEventRow[],
): Map<string, DailyReportOrderStateEventRow[]> {
  const grouped = new Map<string, DailyReportOrderStateEventRow[]>();
  for (const event of events) {
    const current = grouped.get(event.orderId) ?? [];
    current.push(event);
    grouped.set(event.orderId, current);
  }

  return grouped;
}

/**
 * 기준일 종료 직전의 주문 상태를 canonical event log에서 복원한다.
 *
 * 종료 이전 accepted event가 있으면 마지막 `to_status`가 기준 상태다. 종료 이후 첫 accepted event만 있는 주문은 그 event의
 * `from_status`가 종료 시점 상태다. event evidence가 전혀 없을 때만 현재 snapshot을 fallback으로 사용한다.
 */
function resolveOrderStatusAtWindowEnd(
  currentStatus: string,
  events: readonly DailyReportOrderStateEventRow[],
  window: DailyReportQueryWindow,
): string {
  const orderedEvents = [...events].sort(compareOrderStateEvents);
  let latestStatusBeforeEnd: string | undefined;

  for (const event of orderedEvents) {
    if (toTime(event.occurredAt) < window.utcEndAt.getTime()) {
      latestStatusBeforeEnd = event.toStatus;
      continue;
    }

    // window 종료 이후 첫 전이는 from_status가 종료 시점 상태이므로 과거 리포트 재실행 때 현재 snapshot 오염을 막는다.
    return latestStatusBeforeEnd ?? event.fromStatus;
  }

  return latestStatusBeforeEnd ?? currentStatus;
}

/**
 * 같은 주문의 상태 전이 event를 deterministic하게 정렬한다.
 *
 * 업무상 순서는 `occurred_at`이 우선이며, 같은 timestamp가 들어온 경우 UUID가 아니라 주문 lifecycle rank로 전이 chain을
 * 정렬한다. 이 비교는 read-only 계산이며 DB 상태를 변경하지 않는다.
 */
function compareOrderStateEvents(
  left: DailyReportOrderStateEventRow,
  right: DailyReportOrderStateEventRow,
): number {
  const timeComparison = toTime(left.occurredAt) - toTime(right.occurredAt);
  if (timeComparison !== 0) {
    return timeComparison;
  }

  const fromStatusComparison = compareOrderStatusRank(left.fromStatus, right.fromStatus);
  if (fromStatusComparison !== 0) {
    return fromStatusComparison;
  }

  const toStatusComparison = compareOrderStatusRank(left.toStatus, right.toStatus);
  if (toStatusComparison !== 0) {
    return toStatusComparison;
  }

  return left.fromStatus.localeCompare(right.fromStatus) || left.toStatus.localeCompare(right.toStatus);
}

/**
 * lifecycle 상태의 업무 진행 순서로 같은 timestamp 전이를 비교한다.
 *
 * 같은 시각에 여러 accepted event가 기록될 수 있으므로 UUID 같은 저장소 식별자가 아니라 상태 machine 순서를 기준으로
 * 전이 chain을 복원한다.
 */
function compareOrderStatusRank(left: string, right: string): number {
  return readOrderStatusRank(left) - readOrderStatusRank(right);
}

/**
 * 주문 상태 code를 lifecycle rank로 변환한다.
 *
 * 알 수 없는 상태는 알려진 상태 뒤에 배치해 canonical 상태 chain을 우선 보존한다. fallback은 deterministic 정렬용이며
 * 상태 code 자체를 변경하지 않는다.
 */
function readOrderStatusRank(status: string): number {
  return orderStatusRank.get(status) ?? orderLifecycleStatuses.length;
}

/**
 * paper execution과 비용 snapshot payload에서 체결 품질 metric을 best-effort로 읽는다.
 *
 * actual slippage가 있으면 paper simulation 값을 우선하고, 없으면 비용 모델의 expected slippage를 fallback으로 사용한다.
 * metric이 없으면 fact에서 생략해 application이 unavailable로 표시하게 한다.
 */
function readNestedString(record: unknown, path: readonly string[]): string | undefined {
  let current: unknown = record;
  for (const segment of path) {
    if (!isJsonRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return typeof current === "string" && current.length > 0 ? current : undefined;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

/**
 * PostgreSQL 조회에 사용하는 UTC half-open window다.
 *
 * application `DailyReportWindow`의 문자열 timestamp를 DB driver가 비교할 수 있는 `Date`로 바꾼 내부 모델이다.
 * 모든 query는 `utcStartAt <= timestamp < utcEndAt` invariant를 공유해야 한다.
 */
interface DailyReportQueryWindow {
  utcStartAt: Date;
  utcEndAt: Date;
}

/**
 * application window를 DB query용 Date 경계로 변환한다.
 *
 * 외부 side effect는 없으며, repository의 모든 fact query가 같은 Date 객체 경계를 쓰게 만드는 adapter 경계다.
 */
function toQueryWindow(window: DailyReportWindow): DailyReportQueryWindow {
  return {
    utcStartAt: new Date(window.utcStartAt),
    utcEndAt: new Date(window.utcEndAt),
  };
}

/**
 * DB timestamp 값을 epoch millis로 정규화한다.
 *
 * 상태 전이 정렬과 window 종료 비교가 잘못된 timestamp를 조용히 받아들이면 과거 주문 상태 복원이 틀어지므로 즉시 실패한다.
 */
function toTime(value: Date | string): number {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(time)) {
    throw new Error("daily report DB timestamp must be valid");
  }

  return time;
}
