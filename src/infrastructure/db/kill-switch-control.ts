import type {
  KillSwitchAlertDispatchOptions,
  KillSwitchControlProvider,
  KillSwitchControlRequest,
  KillSwitchControlResult,
} from "../../application/index.js";
import {
  createHardStopPendingPaperOrderCancelJobPlan,
  createKillSwitchControlDecision,
  createKillSwitchControlConflictResult,
  dispatchKillSwitchControlAlert,
} from "../../application/index.js";
import type { JsonRecord, KillSwitchState } from "../../domain/index.js";
import type { Database } from "./database.js";
import { toStateTransitionAuditRow } from "./order-events.js";
import { toRiskEventRow } from "./risk-events.js";

export interface CreatePostgresKillSwitchControlProviderOptions {
  /**
   * kill switch state, audit/risk evidence, jobs를 같은 transaction으로 묶기 위한 DB handle이다.
   */
  database: Database;
  /**
   * 테스트와 운영 재현성을 위한 clock injection이다.
   *
   * 지정하지 않으면 요청 처리 시각을 사용한다.
   */
  clock?: () => Date;
  /**
   * 요청 actor가 없을 때 audit event에 남길 기본 실행 주체다.
   */
  actor?: string;
  /**
   * kill switch 전이를 Telegram alert dispatch로 이어 붙이는 선택 의존성이다.
   *
   * 값이 없으면 durable state/audit/risk/job 처리만 수행한다. 값이 있으면 DB transaction commit 이후 alert cooldown과 provider
   * 전송 경계로 이어가되, control evidence transaction 자체에는 Telegram side effect를 섞지 않는다.
   */
  alertDispatch?: KillSwitchAlertDispatchOptions;
}

/**
 * HTTP control 요청을 durable kill switch 상태, audit/risk evidence, 후속 job 경계로 저장하는 provider를 만든다.
 *
 * application port를 PostgreSQL transaction 구현에 연결하는 얇은 adapter다. route handler는 이 provider만 알고, DB row shape이나
 * jobs table의 idempotency 처리에는 의존하지 않는다.
 */
export function createPostgresKillSwitchControlProvider(
  options: CreatePostgresKillSwitchControlProviderOptions,
): KillSwitchControlProvider {
  return {
    async apply(input: KillSwitchControlRequest): Promise<KillSwitchControlResult> {
      return applyPostgresKillSwitchControl({
        ...options,
        request: input,
      });
    },
  };
}

export interface ApplyPostgresKillSwitchControlOptions
  extends CreatePostgresKillSwitchControlProviderOptions {
  /**
   * HTTP 또는 테스트 provider에서 전달한 canonical kill switch 전이 요청이다.
   */
  request: KillSwitchControlRequest;
}

/**
 * kill switch control 요청을 하나의 DB transaction으로 처리한다.
 *
 * 상태 snapshot, audit event, risk event, HARD_STOP pending cancel job이 갈라지지 않도록 같은 transaction 안에서 묶는다.
 * 상태 변경이 거부되더라도 audit/risk evidence는 남겨야 하므로, business decision과 persistence 순서를 명시적으로 유지한다.
 */
export async function applyPostgresKillSwitchControl(
  options: ApplyPostgresKillSwitchControlOptions,
): Promise<KillSwitchControlResult> {
  const occurredAt = options.request.occurredAt ?? options.clock?.() ?? new Date();
  const actor = options.request.actor ?? options.actor ?? "http-control";

  const result = await options.database.transaction().execute(async (transaction) => {
    // 전역 kill switch는 단일 durable row가 source of truth이므로 요청 payload가 아니라 DB snapshot에서 현재 상태를 읽는다.
    const current = await transaction
      .selectFrom("kill_switch_state")
      .selectAll()
      .where("scope", "=", "global")
      .executeTakeFirst();

    if (current === undefined) {
      // baseline row가 없으면 운영 제어의 기준점이 없으므로 evidence를 만들 수 없는 infrastructure 장애로 본다.
      throw new Error("global kill switch state row was not found");
    }

    // state machine 판정은 DB write 전에 끝내고, 이후 persistence 단계는 이 result를 그대로 증거화한다.
    let result = createKillSwitchControlDecision({
      currentState: current.state,
      targetState: options.request.targetState,
      reasonCode: options.request.reasonCode,
      correlationId: options.request.correlationId,
      occurredAt,
      actor,
      ...(options.request.message === undefined ? {} : { message: options.request.message }),
      ...(options.request.metadata === undefined ? {} : { metadata: options.request.metadata }),
    });

    if (result.transition.accepted) {
      // 현재 snapshot이 transition의 from 상태와 같을 때만 전진시켜 중복/경합 요청을 409 거부 evidence로 낮춘다.
      const updatedState = await transaction
        .updateTable("kill_switch_state")
        .set({
          state: result.transition.toState,
          reason_code: result.transition.reasonCode,
          correlation_id: options.request.correlationId,
          payload_json: createKillSwitchSnapshotPayload(result),
          updated_at: occurredAt,
        })
        .where("scope", "=", "global")
        .where("state", "=", result.transition.fromState)
        .returning("scope")
        .executeTakeFirst();

      if (updatedState === undefined) {
        // 다른 요청이 먼저 상태를 바꾼 경우 rollback하지 않고 관측된 현재 상태를 포함한 conflict evidence로 커밋한다.
        const observed = await transaction
          .selectFrom("kill_switch_state")
          .select("state")
          .where("scope", "=", "global")
          .executeTakeFirst();
        result = createKillSwitchControlConflictResult({
          attemptedResult: result,
          observedState: observed?.state,
          occurredAt,
        });
      }
    }

    // 수락/거부 여부와 무관하게 모든 control 시도는 audit event로 남겨 운영자가 누가 무엇을 요청했는지 추적할 수 있게 한다.
    const insertedAudit = await transaction
      .insertInto("audit_events")
      .values(
        toStateTransitionAuditRow({
          event: result.transition.event,
          actor,
          correlationId: options.request.correlationId,
        }),
      )
      .returning("id")
      .executeTakeFirstOrThrow();

    // risk event는 dashboard/alert 집계 기준이므로 요청 사유가 아니라 최종 판정 reasonCode를 저장한다.
    const insertedRisk = await transaction
      .insertInto("risk_events")
      .values(
        toRiskEventRow({
          riskType: result.transition.reasonCode,
          severity: toKillSwitchControlRiskSeverity(result),
          action: toKillSwitchControlRiskAction(result),
          occurredAt,
          payloadJson: createRiskEventPayload({
            result,
            correlationId: options.request.correlationId,
            auditEventId: insertedAudit.id,
          }),
        }),
      )
      .returning("id")
      .executeTakeFirstOrThrow();

    const persistedResult: KillSwitchControlResult = {
      ...result,
      auditEventId: insertedAudit.id,
      riskEventId: insertedRisk.id,
    };

    if (
      result.transition.accepted &&
      result.transition.toState === "HARD_STOP" &&
      result.actionPlan.cancelPendingPaperOrders
    ) {
      // HARD_STOP은 즉시 broker cancel을 호출하지 않고 같은 transaction 안에 재시도 가능한 pending job만 예약한다.
      persistedResult.hardStopCancelJob = await enqueueHardStopCancelJob({
        database: transaction,
        result,
        reasonCode: result.transition.reasonCode,
        correlationId: options.request.correlationId,
        occurredAt,
      });
    }

    return persistedResult;
  });

  return appendKillSwitchAlertDispatch({
    result,
    options,
    occurredAt,
    actor,
  });
}

async function appendKillSwitchAlertDispatch(input: {
  result: KillSwitchControlResult;
  options: ApplyPostgresKillSwitchControlOptions;
  occurredAt: Date | string;
  actor: string;
}): Promise<KillSwitchControlResult> {
  if (input.options.alertDispatch === undefined) {
    return input.result;
  }

  // 상태 전이 evidence commit 이후에 알림을 전송해 Telegram 장애가 kill switch durable update를 rollback하지 못하게 한다.
  const alertDispatch = await dispatchKillSwitchControlAlert({
    alertDispatch: input.options.alertDispatch,
    controlRequest: {
      ...input.options.request,
      occurredAt: input.occurredAt,
      actor: input.actor,
    },
    controlResult: input.result,
  });
  if (alertDispatch === undefined) {
    return input.result;
  }

  return {
    ...input.result,
    alertDispatch,
  };
}

/**
 * HARD_STOP pending cancel job을 idempotent하게 jobs table에 적재한다.
 *
 * 같은 전이 사건이 재시도되면 기존 job을 재사용하고, 새로운 전이 사건이면 별도 idempotency key로 새 job을 만든다.
 * 이 함수는 job 생성만 담당하며 실제 paper order cancel side effect는 후속 worker 경계에서 수행한다.
 */
async function enqueueHardStopCancelJob(input: {
  database: Database;
  result: KillSwitchControlResult;
  reasonCode: string;
  correlationId: string;
  occurredAt: Date | string;
}): Promise<NonNullable<KillSwitchControlResult["hardStopCancelJob"]>> {
  const jobPlan = createHardStopPendingPaperOrderCancelJobPlan({
    transition: input.result.transition,
    actionPlan: input.result.actionPlan,
    reasonCode: input.reasonCode,
    correlationId: input.correlationId,
    occurredAt: input.occurredAt,
  });

  const inserted = await input.database
    .insertInto("jobs")
    .values({
      job_type: jobPlan.jobType,
      idempotency_key: jobPlan.idempotencyKey,
      payload_json: jobPlan.payloadJson,
      run_after: jobPlan.runAfter,
      max_attempts: jobPlan.maxAttempts,
      status: "PENDING",
    })
    .onConflict((conflict) => conflict.column("idempotency_key").doNothing())
    .returning("id")
    .executeTakeFirst();

  if (inserted !== undefined) {
    // 첫 요청이 job을 만든 경우 caller가 새 side effect 경계를 확인할 수 있도록 created=true로 반환한다.
    return {
      jobType: jobPlan.jobType,
      idempotencyKey: jobPlan.idempotencyKey,
      jobId: inserted.id,
      created: true,
    };
  }

  // 재시도나 중복 요청은 기존 job id를 찾아 같은 HARD_STOP 사건의 후속 처리 경계를 재사용한다.
  const existing = await input.database
    .selectFrom("jobs")
    .select("id")
    .where("idempotency_key", "=", jobPlan.idempotencyKey)
    .executeTakeFirstOrThrow();

  return {
    jobType: jobPlan.jobType,
    idempotencyKey: jobPlan.idempotencyKey,
    jobId: existing.id,
    created: false,
  };
}

/**
 * risk event의 action 문자열을 운영자가 보는 상태 전이 의미로 변환한다.
 *
 * 거부 전이는 실행 차단 사건으로 별도 집계하고, 수락 전이는 target state별 운영 조치 이름으로 남긴다.
 */
function toKillSwitchControlRiskAction(result: KillSwitchControlResult): string {
  if (!result.transition.accepted) {
    // state machine이나 reason mapping이 거부한 요청은 실제 상태 변경이 아니라 차단 사건이다.
    return "REJECT_KILL_SWITCH_TRANSITION";
  }

  switch (result.transition.toState) {
    case "NORMAL":
      return "RESTORE_NORMAL";
    case "NEW_ORDERS_BLOCKED":
      return "BLOCK_NEW_ORDERS";
    case "HARD_STOP":
      return "HARD_STOP";
    case "MANUAL_REVIEW_REQUIRED":
      return "MANUAL_REVIEW_REQUIRED";
    case "STRATEGY_PAUSED":
      return "PAUSE_STRATEGY";
  }
}

/**
 * kill switch control 결과를 risk severity로 변환한다.
 *
 * HARD_STOP과 수동 검토는 운영 개입이 필요한 치명도 높은 상태이고, 정상 복구는 정보성, 신규 주문 차단은 경고성으로 분류한다.
 */
function toKillSwitchControlRiskSeverity(
  result: KillSwitchControlResult,
): "INFO" | "WARN" | "ERROR" | "CRITICAL" {
  if (!result.transition.accepted) {
    // 거부된 요청도 운영자가 확인해야 하지만 시스템 장애로 단정하지 않기 위해 WARN에 둔다.
    return "WARN";
  }

  if (result.transition.toState === "HARD_STOP" || result.transition.toState === "MANUAL_REVIEW_REQUIRED") {
    return "CRITICAL";
  }

  return result.transition.toState === "NORMAL" ? "INFO" : "WARN";
}

/**
 * risk_events.payload_json에 저장할 kill switch control evidence를 만든다.
 *
 * risk event는 alert/dashboard 집계에 쓰이므로 action plan, reason-target 일치 여부, audit event id를 함께 저장해
 * 상태 전이의 원인과 후속 차단 범위를 한 번에 추적할 수 있게 한다.
 */
function createRiskEventPayload(input: {
  result: KillSwitchControlResult;
  correlationId: string;
  auditEventId: string;
}): JsonRecord {
  const payload: JsonRecord = {
    audit_kind: "KILL_SWITCH_CONTROL",
    audit_event_id: input.auditEventId,
    correlation_id: input.correlationId,
    from_state: input.result.transition.fromState,
    to_state: input.result.transition.toState,
    accepted: input.result.transition.accepted,
    reason_code: input.result.transition.reasonCode,
    message: input.result.transition.message,
    reason_matches_target: input.result.reasonMatchesTarget,
    action_plan: toActionPlanPayload(input.result),
  };

  if (input.result.recommendedTargetState !== undefined) {
    // known reason의 권장 target은 운영자가 mismatch나 자동화 오류를 빠르게 확인하는 근거다.
    payload.recommended_target_state = input.result.recommendedTargetState;
  }

  return payload;
}

/**
 * kill_switch_state.payload_json에 저장할 최신 상태 snapshot을 만든다.
 *
 * 이 snapshot은 현재 durable state가 어떤 전이 판단과 action plan으로 만들어졌는지 남기는 보조 증거다. rejected transition은
 * durable state를 바꾸지 않으므로 이 payload는 accepted transition update에서만 사용된다.
 */
function createKillSwitchSnapshotPayload(result: KillSwitchControlResult): JsonRecord {
  const payload: JsonRecord = {
    event_kind: result.transition.event.eventKind,
    from_state: result.transition.fromState,
    to_state: result.transition.toState,
    accepted: result.transition.accepted,
    reason_code: result.transition.reasonCode,
    message: result.transition.message,
    action_plan: toActionPlanPayload(result),
  };

  if (result.transition.event.metadata !== undefined) {
    // actor, correlation id, reason mapping 결과를 snapshot에도 복사해 audit/risk event 없이도 최신 상태 근거를 볼 수 있게 한다.
    payload.metadata = result.transition.event.metadata;
  }

  return payload;
}

/**
 * domain action plan을 DB JSON naming convention으로 변환한다.
 *
 * HTTP 응답은 camelCase를 유지하지만 DB evidence는 기존 snake_case payload 관례를 따른다.
 */
function toActionPlanPayload(result: KillSwitchControlResult): JsonRecord {
  return {
    new_orders_blocked: result.actionPlan.newOrdersBlocked,
    strategy_evaluation_blocked: result.actionPlan.strategyEvaluationBlocked,
    cancel_pending_paper_orders: result.actionPlan.cancelPendingPaperOrders,
    auto_liquidate_open_positions: result.actionPlan.autoLiquidateOpenPositions,
    requires_manual_review: result.actionPlan.requiresManualReview,
  };
}
