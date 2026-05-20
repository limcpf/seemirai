import type {
  KillSwitchControlProvider,
  KillSwitchControlRequest,
  KillSwitchControlResult,
} from "../../application/index.js";
import {
  createHardStopPendingPaperOrderCancelJobPlan,
  createKillSwitchControlDecision,
} from "../../application/index.js";
import type { JsonRecord, KillSwitchState } from "../../domain/index.js";
import type { Database } from "./database.js";
import { toStateTransitionAuditRow } from "./order-events.js";
import { toRiskEventRow } from "./risk-events.js";

export interface CreatePostgresKillSwitchControlProviderOptions {
  database: Database;
  clock?: () => Date;
  actor?: string;
}

/**
 * HTTP control 요청을 durable kill switch 상태, audit/risk evidence, 후속 job 경계로 저장하는 provider를 만든다.
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
  request: KillSwitchControlRequest;
}

/**
 * kill switch control 요청을 하나의 DB transaction으로 처리한다.
 *
 * 상태 snapshot, audit event, risk event, HARD_STOP pending cancel job이 갈라지지 않도록 같은 transaction 안에서 묶는다.
 */
export async function applyPostgresKillSwitchControl(
  options: ApplyPostgresKillSwitchControlOptions,
): Promise<KillSwitchControlResult> {
  const occurredAt = options.request.occurredAt ?? options.clock?.() ?? new Date();
  const actor = options.request.actor ?? options.actor ?? "http-control";

  return options.database.transaction().execute(async (transaction) => {
    const current = await transaction
      .selectFrom("kill_switch_state")
      .selectAll()
      .where("scope", "=", "global")
      .executeTakeFirst();

    if (current === undefined) {
      throw new Error("global kill switch state row was not found");
    }

    const result = createKillSwitchControlDecision({
      currentState: current.state,
      targetState: options.request.targetState,
      reasonCode: options.request.reasonCode,
      correlationId: options.request.correlationId,
      occurredAt,
      actor,
      ...(options.request.message === undefined ? {} : { message: options.request.message }),
      ...(options.request.metadata === undefined ? {} : { metadata: options.request.metadata }),
    });

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

    const insertedRisk = await transaction
      .insertInto("risk_events")
      .values(
        toRiskEventRow({
          riskType: options.request.reasonCode,
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

    if (result.transition.accepted) {
      // 현재 snapshot이 transition의 from 상태와 같을 때만 전진시켜 중복/경합 요청을 fail-closed한다.
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
        throw new Error("accepted kill switch control transition current state mismatch");
      }
    }

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
      persistedResult.hardStopCancelJob = await enqueueHardStopCancelJob({
        database: transaction,
        result,
        reasonCode: options.request.reasonCode,
        correlationId: options.request.correlationId,
        occurredAt,
      });
    }

    return persistedResult;
  });
}

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
    return {
      jobType: jobPlan.jobType,
      idempotencyKey: jobPlan.idempotencyKey,
      jobId: inserted.id,
      created: true,
    };
  }

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

function toKillSwitchControlRiskAction(result: KillSwitchControlResult): string {
  if (!result.transition.accepted) {
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

function toKillSwitchControlRiskSeverity(
  result: KillSwitchControlResult,
): "INFO" | "WARN" | "ERROR" | "CRITICAL" {
  if (!result.transition.accepted) {
    return "WARN";
  }

  if (result.transition.toState === "HARD_STOP" || result.transition.toState === "MANUAL_REVIEW_REQUIRED") {
    return "CRITICAL";
  }

  return result.transition.toState === "NORMAL" ? "INFO" : "WARN";
}

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
    payload.recommended_target_state = input.result.recommendedTargetState;
  }

  return payload;
}

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
    payload.metadata = result.transition.event.metadata;
  }

  return payload;
}

function toActionPlanPayload(result: KillSwitchControlResult): JsonRecord {
  return {
    new_orders_blocked: result.actionPlan.newOrdersBlocked,
    strategy_evaluation_blocked: result.actionPlan.strategyEvaluationBlocked,
    cancel_pending_paper_orders: result.actionPlan.cancelPendingPaperOrders,
    auto_liquidate_open_positions: result.actionPlan.autoLiquidateOpenPositions,
    requires_manual_review: result.actionPlan.requiresManualReview,
  };
}
