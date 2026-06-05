import { sql } from "kysely";
import {
  createDatabasePnLAccountingStatusProvider,
  dailyReportJobType,
} from "../../application/index.js";
import type { PnLAccountingStatusSummary } from "../../application/index.js";
import type { KillSwitchState, Phase15AltApprovalEvidenceSnapshot } from "../../domain/index.js";
import { getKillSwitchActionPlan } from "../../domain/index.js";
import {
  listPhase15AltApprovalEvidenceSnapshots,
} from "../../infrastructure/db/index.js";
import type { Database } from "../../infrastructure/db/index.js";
import {
  createPilotRuntimeSafeSummary,
  createReconcileStatusSummary,
  resolveRuntimeUniverse,
} from "../../runtime/index.js";
import type { PilotRuntimeConfig, ReconcileStatusSummary, RuntimeConfig } from "../../runtime/index.js";
import { createDatabaseControlReadinessProvider } from "./readiness.js";
import type {
  ControlOperationalStatusCode,
  ControlOperationalStatusDetail,
  ControlStatusProvider,
  ControlStatusSnapshot,
  CreateDatabaseControlStatusProviderOptions,
} from "./types.js";

type TimestampValue = Date | string | null | undefined;

const disabledPilotRuntimeConfig = {
  enabled: false,
  privateSmokeEnabled: false,
  orderSmokeEnabled: false,
} satisfies PilotRuntimeConfig;

/**
 * `/status`가 durable 집계 하나를 읽은 결과다.
 *
 * count query helper와 status payload builder 사이의 내부 경계에서만 사용한다. `ok=false`일 때는 endpoint를 실패시키지 않고
 * `value=null`과 `reason`을 trace로 넘기는 것이 invariant이며, 외부 side effect는 없다.
 */
interface CountReadResult {
  value: number | null;
  ok: boolean;
  source: string;
  reason: string;
}

/**
 * `jobs` table에서 읽은 daily report 최신 row의 최소 projection이다.
 *
 * `/status`는 raw job payload 전체를 노출하지 않고 report date, lifecycle status, scheduling timestamp만 사용자 문구로
 * 변환한다. `last_error`는 원문을 반환하지 않고 존재 여부만 trace에 남겨 secret/provider payload 노출을 막는다.
 */
interface DailyReportJobStatusRow {
  status: string;
  payload_json: Record<string, unknown>;
  run_after: Date | string;
  last_error: string | null;
  updated_at: Date | string;
  idempotency_key: string;
}

/**
 * DB snapshot과 safe runtime config만 사용해 `/status` payload를 만든다.
 *
 * status는 운영 대시보드와 수동 점검을 위한 관측면이므로,
 * 일부 집계 조회가 실패해도 endpoint 전체를 실패시키기보다 null로 표시한다.
 */
export function createDatabaseControlStatusProvider(
  options: CreateDatabaseControlStatusProviderOptions,
): ControlStatusProvider {
  const clock = options.clock ?? (() => new Date());
  const statusReadinessProvider =
    options.statusReadinessProvider ??
    createDatabaseControlReadinessProvider({
      runtimeConfig: options.runtimeConfig,
      includeWriteCheck: false,
      clock,
      ...(options.database === undefined ? {} : { database: options.database }),
      ...(options.expectedMigrationVersion === undefined
        ? {}
        : { expectedMigrationVersion: options.expectedMigrationVersion }),
    });

  return {
    async getStatus(): Promise<ControlStatusSnapshot> {
      const killSwitch = await readKillSwitchStatus(options.database);
      const actionPlan = getKillSwitchActionPlan(killSwitch.state);
      const readiness = await statusReadinessProvider.check();
      const blockedReason = actionPlan.newOrdersBlocked ? killSwitch.reasonCode : null;
      const [paper, alerts, dailyReport, pnl, phase15ApprovalEvidence] = await Promise.all([
        readPaperStatus(options.database),
        readAlertStatus(options),
        readDailyReportStatus(options),
        readPnlAccountingStatus(options),
        readPhase15ApprovalEvidence(options),
      ]);
      const generatedAt = clock().toISOString();
      // kill switch action plan은 상태 문자열을 실제 주문 차단/수동 검토 신호로 변환하는 경계다.
      return {
        generatedAt,
        runtime: toSafeRuntimeSummary(options.runtimeConfig, generatedAt, phase15ApprovalEvidence, options),
        tradingState: {
          state: killSwitch.state,
          killSwitchState: killSwitch.state,
          blockedReason,
          newOrdersBlocked: actionPlan.newOrdersBlocked,
          requiresManualReview: actionPlan.requiresManualReview,
        },
        marketData: {
          connectionStatus: options.marketData?.connectionStatus ?? "unknown",
          lagMs: options.marketData?.lagMs ?? null,
          updatedAt: options.marketData?.updatedAt ?? null,
        },
        paper,
        database: readiness,
        alerts,
        dailyReport,
        pnl,
        reconcile: await toReconcileStatus(options),
      };
    },
  };
}

/**
 * PnL accounting durable snapshot을 `/status.pnl` safe summary로 변환한다.
 *
 * PnL 조회는 운영 관측면이므로 실패해도 endpoint 전체를 깨뜨리지 않는다. 단, 빈 snapshot과 DB 실패는 서로 다른
 * 한국어 상태/조치 문구로 표시해 운영자가 migration/권한 문제를 "아직 데이터 없음"으로 오해하지 않게 한다.
 */
async function readPnlAccountingStatus(
  options: CreateDatabaseControlStatusProviderOptions,
): Promise<ControlStatusSnapshot["pnl"]> {
  if (options.pnlAccounting !== undefined) {
    return toPnlAccountingStatus(options.pnlAccounting, "runtime_injected");
  }

  if (options.pnlAccountingStatusProvider !== undefined) {
    try {
      return toPnlAccountingStatus(
        await options.pnlAccountingStatusProvider.getStatus(),
        "pnl_accounting_status_provider",
      );
    } catch {
      // status endpoint는 PnL provider 장애를 전체 HTTP 실패로 키우지 않고 운영자가 볼 수 있는 실패 summary로 낮춘다.
      return toPnlAccountingStatus(
        emptyPnlAccountingStatus("UNAVAILABLE", "pnl_accounting_status_provider_failed"),
        "pnl_accounting_status_provider",
      );
    }
  }

  if (options.database === undefined) {
    return toPnlAccountingStatus(
      emptyPnlAccountingStatus("UNAVAILABLE", "database_not_configured"),
      "pnl_snapshots",
    );
  }

  return toPnlAccountingStatus(
    await createDatabasePnLAccountingStatusProvider(options.database).getStatus(),
    "pnl_snapshots",
  );
}

function toPnlAccountingStatus(
  summary: PnLAccountingStatusSummary,
  source: string,
): ControlStatusSnapshot["pnl"] {
  const status = mapPnlAccountingReadStatus(summary.readStatus);
  return {
    ...createOperationalStatusDetail({
      status: status.status,
      statusLabel: status.statusLabel,
      message: status.message,
      action: status.action,
      source,
      reason: summary.reason,
      extraTrace: {
        readStatus: summary.readStatus,
        latestStatus: summary.latestStatus,
      },
    }),
    latestCapturedAt: summary.latestCapturedAt,
    latestEquityKrw: summary.latestEquityKrw,
    latestRealizedPnlKrw: summary.latestRealizedPnlKrw,
    latestUnrealizedPnlKrw: summary.latestUnrealizedPnlKrw,
    latestDrawdownBps: summary.latestDrawdownBps,
    latestSource: summary.latestSource,
    snapshotCount: summary.snapshotCount,
  };
}

function mapPnlAccountingReadStatus(readStatus: PnLAccountingStatusSummary["readStatus"]): {
  status: ControlOperationalStatusCode;
  statusLabel: string;
  message: string;
  action: string | null;
} {
  switch (readStatus) {
    case "OK":
      return {
        status: "ok",
        statusLabel: "조회 가능",
        message: "최신 PnL snapshot에서 손익과 평가자산을 읽었다.",
        action: null,
      };
    case "NOT_FOUND":
      return {
        status: "ok",
        statusLabel: "기록 없음",
        message: "PnL snapshot 기록이 아직 없다.",
        action: "closeout 또는 daily report 경계에서 PnL snapshot 생성을 먼저 실행한다.",
      };
    case "UNAVAILABLE":
      return {
        status: "unavailable",
        statusLabel: "조회 불가",
        message: "PnL snapshot 상태를 DB에서 읽지 못했다.",
        action: "DB 연결, migration 적용 상태, pnl_snapshots table 접근 권한을 확인한다.",
      };
  }
}

function emptyPnlAccountingStatus(
  readStatus: Exclude<PnLAccountingStatusSummary["readStatus"], "OK">,
  reason: string,
): PnLAccountingStatusSummary {
  return {
    readStatus,
    latestCapturedAt: null,
    latestEquityKrw: null,
    latestRealizedPnlKrw: null,
    latestUnrealizedPnlKrw: null,
    latestDrawdownBps: null,
    latestSource: null,
    latestStatus: null,
    snapshotCount: 0,
    reason,
  };
}

/**
 * durable kill switch state를 읽어 `/status` tradingState로 전달한다.
 *
 * DB가 없을 때는 local/dev 환경의 기본값으로 NORMAL을 쓰고,
 * DB 조회 실패나 row 누락은 운영에서 안전한 MANUAL_REVIEW_REQUIRED로 닫는다.
 */
async function readKillSwitchStatus(
  database: Database | undefined,
): Promise<{ state: KillSwitchState; reasonCode: string | null }> {
  if (database === undefined) {
    return {
      state: "NORMAL",
      reasonCode: null,
    };
  }

  const row = await database
    .selectFrom("kill_switch_state")
    .select(["state", "reason_code"])
    .where("scope", "=", "global")
    .executeTakeFirst()
    .catch(() => undefined);

  // durable state를 읽지 못하면 운영 화면에서 정상 상태로 보이지 않게 수동 검토 상태로 닫는다.
  return {
    state: row?.state ?? "MANUAL_REVIEW_REQUIRED",
    reasonCode: row?.reason_code ?? "kill_switch_state_unavailable",
  };
}

/**
 * status용 paper 주문/포지션 집계와 조회 상태 문구를 만든다.
 *
 * 주문/포지션 조회는 운영 관측 정보이므로 실패해도 `/status` 전체를 깨뜨리지 않고 null과 한국어 조치 문구로 낮춘다.
 */
async function readPaperStatus(database: Database | undefined): Promise<ControlStatusSnapshot["paper"]> {
  const [pendingPaperOrders, openPositions] = await Promise.all([
    countPendingPaperOrders(database),
    countOpenPositions(database),
  ]);
  const failedSources = [pendingPaperOrders, openPositions].filter((result) => !result.ok);
  const status =
    failedSources.length === 0
      ? createOperationalStatusDetail({
          status: "ok",
          statusLabel: "조회 가능",
          message: "paper 주문과 포지션 집계를 DB에서 읽었다.",
          action: null,
          source: "orders+paper_orders+positions",
          reason: "paper_state_read",
        })
      : createOperationalStatusDetail({
          status: failedSources.length === 2 ? "unavailable" : "warning",
          statusLabel: failedSources.length === 2 ? "조회 불가" : "일부 조회 불가",
          message:
            failedSources.length === 2
              ? "paper 주문과 포지션 집계를 읽지 못했다."
              : "paper 주문 또는 포지션 집계 일부를 읽지 못했다.",
          action: "DB 연결과 migration 적용 상태를 확인한 뒤 다시 조회한다.",
          source: "orders+paper_orders+positions",
          reason: database === undefined ? "database_not_configured" : "paper_state_partially_unavailable",
          extraTrace: {
            failedSources: failedSources.map((result) => result.source),
            failedReasons: failedSources.map((result) => result.reason),
          },
        });

  return {
    ...status,
    pendingPaperOrderCount: pendingPaperOrders.value,
    openPositionCount: openPositions.value,
  };
}

/**
 * status용 paper 주문 대기 건수를 계산한다.
 *
 * 이 값은 관측 편의용이므로 조회 실패 시 `/status` 전체 실패 대신 null로 낮춘다.
 */
async function countPendingPaperOrders(database: Database | undefined): Promise<CountReadResult> {
  if (database === undefined) {
    return {
      value: null,
      ok: false,
      source: "orders+paper_orders",
      reason: "database_not_configured",
    };
  }

  try {
    const result = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM orders AS o
      INNER JOIN paper_orders AS po ON po.order_id = o.id
      WHERE o.status IN ('SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED')
    `.execute(database);
    return {
      value: Number(result.rows[0]?.count ?? "0"),
      ok: true,
      source: "orders+paper_orders",
      reason: "paper_order_count_read",
    };
  } catch {
    // 주문 집계 실패는 readiness 실패와 별개로 status snapshot에서 unknown으로 표현한다.
    return {
      value: null,
      ok: false,
      source: "orders+paper_orders",
      reason: "paper_order_count_unavailable",
    };
  }
}

/**
 * status용 open position 수를 계산한다.
 *
 * 포지션 집계도 관측 정보이므로 DB 오류를 endpoint 실패로 확대하지 않는다.
 */
async function countOpenPositions(database: Database | undefined): Promise<CountReadResult> {
  if (database === undefined) {
    return {
      value: null,
      ok: false,
      source: "positions",
      reason: "database_not_configured",
    };
  }

  try {
    const result = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM positions
      WHERE quantity::numeric <> 0
    `.execute(database);
    return {
      value: Number(result.rows[0]?.count ?? "0"),
      ok: true,
      source: "positions",
      reason: "open_position_count_read",
    };
  } catch {
    // 포지션 집계 실패는 운영자가 구분할 수 있도록 null로 남긴다.
    return {
      value: null,
      ok: false,
      source: "positions",
      reason: "open_position_count_unavailable",
    };
  }
}

/**
 * durable alert cooldown 상태를 `/status.alerts` payload로 변환한다.
 *
 * 호출 경계는 HTTP status provider 내부이며, DB가 없거나 query가 실패해도 endpoint 전체를 실패시키지 않는다. 반환값은 마지막
 * 전송/스킵 timestamp와 한국어 조치 문구만 포함하고, alert payload 원문이나 Telegram provider 응답은 노출하지 않는다.
 */
async function readAlertStatus(
  options: CreateDatabaseControlStatusProviderOptions,
): Promise<ControlStatusSnapshot["alerts"]> {
  if (options.alerts !== undefined) {
    return {
      ...createOperationalStatusDetail({
        status: "ok",
        statusLabel: "조회 가능",
        message: "런타임에서 주입한 alert 전송 상태를 반환했다.",
        action: null,
        source: "runtime_injected",
        reason: "alert_status_injected",
      }),
      lastSentAt: options.alerts.lastSentAt ?? null,
      lastSkippedAt: options.alerts.lastSkippedAt ?? null,
    };
  }

  if (options.database === undefined) {
    return {
      ...createOperationalStatusDetail({
        status: "unavailable",
        statusLabel: "조회 불가",
        message: "alert cooldown DB가 연결되지 않아 마지막 전송/스킵 시각을 확인하지 못했다.",
        action: "DB 연결 상태를 확인한 뒤 다시 조회한다.",
        source: "alert_cooldowns",
        reason: "database_not_configured",
      }),
      lastSentAt: null,
      lastSkippedAt: null,
    };
  }

  try {
    const row = await options.database
      .selectFrom("alert_cooldowns")
      .select((expressionBuilder) => [
        expressionBuilder.fn.max("last_sent_at").as("last_sent_at"),
        expressionBuilder.fn.max("last_skipped_at").as("last_skipped_at"),
      ])
      .executeTakeFirst();

    const lastSentAt = toIsoString(row?.last_sent_at);
    const lastSkippedAt = toIsoString(row?.last_skipped_at);
    return {
      ...createOperationalStatusDetail({
        status: "ok",
        statusLabel: "조회 가능",
        message:
          lastSentAt === null && lastSkippedAt === null
            ? "alert cooldown 기록이 아직 없어 마지막 전송/스킵 시각은 없다."
            : "alert cooldown 기록에서 마지막 전송/스킵 시각을 읽었다.",
        action: null,
        source: "alert_cooldowns",
        reason: "alert_cooldown_state_read",
      }),
      lastSentAt,
      lastSkippedAt,
    };
  } catch {
    // alert 집계 실패는 운영 화면만 unknown으로 낮추고 readiness 판정과 분리한다.
    return {
      ...createOperationalStatusDetail({
        status: "unavailable",
        statusLabel: "조회 불가",
        message: "alert cooldown 상태를 DB에서 읽지 못했다.",
        action: "DB migration과 alert_cooldowns table 접근 권한을 확인한다.",
        source: "alert_cooldowns",
        reason: "alert_cooldown_state_unavailable",
      }),
      lastSentAt: null,
      lastSkippedAt: null,
    };
  }
}

/**
 * daily report job durable 상태를 `/status.dailyReport` payload로 변환한다.
 *
 * `jobs` table의 최신 `report.daily` row만 읽는 read-only 경계다. 조회 실패는 `unavailable`로 낮추며, 실패 job의
 * `last_error` 원문은 HTTP payload에 넣지 않고 trace의 존재 여부로만 남긴다.
 */
async function readDailyReportStatus(
  options: CreateDatabaseControlStatusProviderOptions,
): Promise<ControlStatusSnapshot["dailyReport"]> {
  if (options.dailyReport !== undefined) {
    const lastStatus = options.dailyReport.lastStatus ?? "unavailable";
    const status = mapDailyReportJobStatus(lastStatus);
    return {
      ...createOperationalStatusDetail({
        status: status.status,
        statusLabel: status.statusLabel,
        message: status.message,
        action: status.action,
        source: "runtime_injected",
        reason: `daily_report_status_injected_${lastStatus.toLowerCase()}`,
      }),
      lastStatus,
      reportDate: options.dailyReport.reportDate ?? null,
      nextRunAfter: null,
      updatedAt: options.dailyReport.updatedAt ?? null,
    };
  }

  if (options.database === undefined) {
    return {
      ...createOperationalStatusDetail({
        status: "unavailable",
        statusLabel: "조회 불가",
        message: "daily report job DB가 연결되지 않아 마지막 실행 상태를 확인하지 못했다.",
        action: "DB 연결 상태를 확인한 뒤 다시 조회한다.",
        source: "jobs",
        reason: "database_not_configured",
      }),
      lastStatus: "unavailable",
      reportDate: null,
      nextRunAfter: null,
      updatedAt: null,
    };
  }

  try {
    const row = await options.database
      .selectFrom("jobs")
      .select(["status", "payload_json", "run_after", "last_error", "updated_at", "idempotency_key"])
      .where("job_type", "=", dailyReportJobType)
      .orderBy("updated_at", "desc")
      .orderBy("created_at", "desc")
      .executeTakeFirst();

    if (row === undefined) {
      return {
        ...createOperationalStatusDetail({
          status: "ok",
          statusLabel: "기록 없음",
          message: "daily report job 기록이 아직 없다.",
          action: "운영 시작 후 scheduler 또는 수동 daily report 실행 결과를 다시 확인한다.",
          source: "jobs",
          reason: "daily_report_job_not_found",
        }),
        lastStatus: "not_scheduled",
        reportDate: null,
        nextRunAfter: null,
        updatedAt: null,
      };
    }

    return toDailyReportStatus(row as DailyReportJobStatusRow);
  } catch {
    // daily report job 조회 실패도 status 하위 상태로만 낮춰 control endpoint 자체는 계속 관측 가능하게 둔다.
    return {
      ...createOperationalStatusDetail({
        status: "unavailable",
        statusLabel: "조회 불가",
        message: "daily report job 상태를 DB에서 읽지 못했다.",
        action: "DB migration과 jobs table 접근 권한을 확인한다.",
        source: "jobs",
        reason: "daily_report_job_state_unavailable",
      }),
      lastStatus: "unavailable",
      reportDate: null,
      nextRunAfter: null,
      updatedAt: null,
    };
  }
}

/**
 * daily report job row를 사용자 행동 언어 중심의 status 객체로 정규화한다.
 *
 * 입력은 이미 DB projection으로 제한된 row여야 한다. 출력은 `lastStatus`에 stable lifecycle code를 보존하되, 첫 화면 판단은
 * 한국어 `statusLabel/message/action`으로 가능해야 한다.
 */
function toDailyReportStatus(row: DailyReportJobStatusRow): ControlStatusSnapshot["dailyReport"] {
  const status = mapDailyReportJobStatus(row.status);
  return {
    ...createOperationalStatusDetail({
      status: status.status,
      statusLabel: status.statusLabel,
      message: status.message,
      action: status.action,
      source: "jobs",
      reason: `daily_report_job_${row.status.toLowerCase()}`,
      extraTrace: {
        idempotencyKey: row.idempotency_key,
        lastErrorPresent: row.last_error !== null,
      },
    }),
    lastStatus: row.status,
    reportDate: readDailyReportDate(row.payload_json, row.idempotency_key),
    nextRunAfter: row.status === "PENDING" ? toIsoString(row.run_after) : null,
    updatedAt: toIsoString(row.updated_at),
  };
}

/**
 * job lifecycle code를 운영자가 읽는 daily report 상태 문구로 변환한다.
 *
 * 이 함수는 pure mapping이며 DB나 외부 provider를 호출하지 않는다. 알 수 없는 상태는 성공으로 보지 않고 확인 필요 경고로
 * 낮춰 migration/schema 불일치를 숨기지 않는다.
 */
function mapDailyReportJobStatus(status: string): {
  status: ControlOperationalStatusCode;
  statusLabel: string;
  message: string;
  action: string | null;
} {
  switch (status) {
    case "COMPLETED":
      return {
        status: "ok",
        statusLabel: "완료",
        message: "마지막 daily report job이 완료됐다.",
        action: null,
      };
    case "PENDING":
      return {
        status: "ok",
        statusLabel: "예약됨",
        message: "daily report job이 예약되어 실행을 기다리고 있다.",
        action: null,
      };
    case "RUNNING":
      return {
        status: "ok",
        statusLabel: "실행 중",
        message: "daily report job이 현재 실행 중이다.",
        action: "실행이 끝난 뒤 상태를 다시 확인한다.",
      };
    case "FAILED":
      return {
        status: "warning",
        statusLabel: "실패",
        message: "마지막 daily report job이 실패했다.",
        action: "jobs table의 추적 정보와 audit event를 확인한 뒤 수동 재실행 또는 재시도를 진행한다.",
      };
    case "CANCELED":
      return {
        status: "warning",
        statusLabel: "취소됨",
        message: "마지막 daily report job이 취소됐다.",
        action: "운영자가 취소 사유를 확인하고 필요하면 다시 예약한다.",
      };
    case "unavailable":
      return {
        status: "unavailable",
        statusLabel: "조회 불가",
        message: "daily report 상태를 확인하지 못했다.",
        action: "DB 연결 상태 또는 런타임 주입 상태를 확인한 뒤 다시 조회한다.",
      };
    default:
      return {
        status: "warning",
        statusLabel: "확인 필요",
        message: "daily report job이 알 수 없는 상태를 반환했다.",
        action: "jobs table의 상태값과 migration 적용 상태를 확인한다.",
      };
  }
}

/**
 * daily report 기준일을 job payload 또는 idempotency key에서 안전하게 복원한다.
 *
 * payload가 비어 있어도 `report.daily:<date>` idempotency key를 fallback으로 사용한다. 이 값은 운영자가 재실행할 기준일을
 * 식별하기 위한 trace이며, raw payload 전체는 반환하지 않는다.
 */
function readDailyReportDate(payload: Record<string, unknown>, idempotencyKey: string): string | null {
  if (typeof payload.report_date === "string" && payload.report_date.length > 0) {
    return payload.report_date;
  }

  const keyPrefix = `${dailyReportJobType}:`;
  if (idempotencyKey.startsWith(keyPrefix)) {
    const reportDate = idempotencyKey.slice(keyPrefix.length);
    return reportDate.length > 0 ? reportDate : null;
  }

  return null;
}

/**
 * `/status` 하위 운영 영역의 공통 상태 문구를 만든다.
 *
 * caller는 source/reason 같은 내부 식별자를 trace로 분리해 전달해야 한다. 반환 객체는 secret, token, raw provider response를
 * 포함하지 않는다는 invariant를 유지한다.
 */
function createOperationalStatusDetail(input: {
  status: ControlOperationalStatusCode;
  statusLabel: string;
  message: string;
  action: string | null;
  source: string;
  reason: string;
  extraTrace?: Record<string, unknown>;
}): ControlOperationalStatusDetail {
  return {
    status: input.status,
    statusLabel: input.statusLabel,
    message: input.message,
    action: input.action,
    trace: {
      source: input.source,
      reason: input.reason,
      ...(input.extraTrace ?? {}),
    },
  };
}

/**
 * DB driver와 test double이 반환하는 timestamp 값을 HTTP payload용 ISO 문자열로 정규화한다.
 *
 * null/undefined는 관측값 부재를 의미하므로 null로 유지하고, 이 함수는 시간 값을 생성하거나 외부 상태를 읽지 않는다.
 */
function toIsoString(value: TimestampValue): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

/**
 * runtime config에서 운영 노출이 안전한 필드만 골라낸다.
 */
function toSafeRuntimeSummary(
  config: RuntimeConfig,
  observedAt: string,
  phase15ApprovalEvidence: readonly Phase15AltApprovalEvidenceSnapshot[],
  options: CreateDatabaseControlStatusProviderOptions,
): ControlStatusSnapshot["runtime"] {
  const universe = resolveRuntimeUniverse(config.universe, {
    observedAt,
    evidence: phase15ApprovalEvidence,
    exchangeId: config.registry.exchangeId,
  });

  return {
    exchange: config.exchange,
    market: config.market,
    mode: config.mode,
    universe: {
      phase1: config.universe.phase_1,
      phase1Count: config.universe.phase_1.length,
      phase15: {
        enabled: config.universe.phase_1_5.enabled,
        approvedAltMarkets: universe.phase15ApprovedAltMarkets,
        approvedAltCount: universe.phase15ApprovedAltMarkets.length,
        candidateMarkets: [...config.universe.phase_1_5.candidate_markets],
        candidateMarketCount: config.universe.phase_1_5.candidate_markets.length,
        maxManualApprovals: config.universe.phase_1_5.max_manual_approvals,
      },
    },
    liveTradingEnabled: config.live_trading_enabled,
    paperNoKey: config.paper_no_key,
    pilot: createPilotRuntimeSafeSummary(options.pilotConfig ?? disabledPilotRuntimeConfig, {
      generatedAt: observedAt,
      lastEvidence: options.pilotEvidence ?? null,
    }),
  };
}

async function readPhase15ApprovalEvidence(
  options: CreateDatabaseControlStatusProviderOptions,
): Promise<readonly Phase15AltApprovalEvidenceSnapshot[]> {
  if (options.phase15ApprovalEvidence !== undefined) {
    return options.phase15ApprovalEvidence;
  }
  if (options.database === undefined) {
    return [];
  }

  try {
    return await listPhase15AltApprovalEvidenceSnapshots(options.database);
  } catch {
    // status endpoint는 audit 조회 실패 때문에 전체 응답을 깨기보다 승인 universe를 보수적으로 비워 둔다.
    return [];
  }
}

/**
 * reconcile 상태 summary 입력을 `/status` 노출용으로 정규화한다.
 *
 * reconcile이 주입되지 않았으면 SKIPPED 기본값을 반환하고, 주입됐으면 그대로 전달한다.
 * 이 함수는 순수 변환 경계이며 외부 side effect가 없다.
 */
async function toReconcileStatus(
  options: CreateDatabaseControlStatusProviderOptions,
): Promise<ReconcileStatusSummary> {
  if (options.reconcileStatusProvider !== undefined) {
    try {
      return await options.reconcileStatusProvider.getReconcileStatus();
    } catch {
      // status endpoint는 reconcile provider 장애를 전체 HTTP 실패로 키우지 않고 운영자가 볼 수 있는 실패 summary로 낮춘다.
      return {
        lastReconcileAt: null,
        result: "FAILED",
        mismatchCount: null,
        openOrderCount: null,
        balanceStatus: "UNAVAILABLE",
        websocketStatus: "DEGRADED",
        actionRequired: "reconcile 상태 조회 실패",
        message: "reconcile 상태를 읽지 못했습니다. worker와 DB 상태를 확인한 뒤 다시 조회하세요.",
        trace: {
          source: "live_reconcile_status",
          reason: "reconcile_status_provider_failed",
        },
      };
    }
  }

  if (options.reconcile !== undefined) {
    return options.reconcile;
  }

  return createReconcileStatusSummary({
    lastReconcileAt: null,
    reconcileResult: null,
    mismatchCount: null,
    openOrderCount: null,
    balanceStatus: null,
    websocketStatus: "DISCONNECTED",
  });
}
