import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  KillSwitchControlProvider,
  KillSwitchControlResult,
  KillSwitchControlTargetState,
} from "../../application/index.js";
import { canonicalizeKillSwitchReasonCode } from "../../application/index.js";
import { createErrorResponse, getCorrelationId } from "./errors.js";

export interface KillSwitchControlRequestBody {
  /**
   * 운영자가 전환하려는 전역 kill switch target이다.
   *
   * HTTP schema에서 허용 enum을 먼저 좁히므로 route handler는 `STRATEGY_PAUSED` 같은 별도 제어 상태를 받지 않는다.
   */
  targetState: KillSwitchControlTargetState;
  /**
   * 전이 요청의 운영 사유 코드다.
   *
   * route handler에서 canonical lowercase로 정규화되어 provider로 전달되며, 이 값이 audit/risk 집계 키의 기준이 된다.
   */
  reasonCode: string;
  /**
   * 운영자가 남긴 보조 설명이다.
   */
  message?: string;
  /**
   * HTTP token 사용자 또는 자동화 이름처럼 audit event에 남길 실행 주체다.
   */
  actor?: string;
  /**
   * incident id, runbook id처럼 운영자가 추가로 남기는 추적 metadata다.
   */
  metadata?: Record<string, unknown>;
}

/**
 * `POST /kill-switch` route handler를 만든다.
 *
 * route는 인증과 schema 검증을 통과한 요청만 provider로 넘기고, 불법 전이는 409 error로 정규화한다. HTTP layer는
 * request/response shape과 safe error만 책임지고, 상태 전이 판정·DB evidence·job 예약은 provider 경계로 위임한다.
 */
export function createKillSwitchControlRouteHandler(provider: KillSwitchControlProvider) {
  return async (
    request: FastifyRequest<{ Body: KillSwitchControlRequestBody }>,
    reply: FastifyReply,
  ) => {
    const correlationId = getCorrelationId(request);
    // reasonCode는 provider 진입 전에 canonical 값으로 맞춰 audit/risk/job 집계 키가 대소문자로 분산되지 않게 한다.
    const reasonCode = canonicalizeKillSwitchReasonCode(request.body.reasonCode);
    // provider는 상태 전이와 durable evidence 저장을 책임지는 application/infrastructure 경계다.
    const result = await provider.apply({
      targetState: request.body.targetState,
      reasonCode,
      correlationId,
      ...(request.body.actor === undefined ? {} : { actor: request.body.actor }),
      ...(request.body.message === undefined ? {} : { message: request.body.message }),
      ...(request.body.metadata === undefined ? {} : { metadata: request.body.metadata }),
    });

    if (!result.transition.accepted) {
      // 거부 전이는 서버 장애가 아니라 운영 명령 충돌/불법 전이이므로 correlation-aware 409 응답으로 반환한다.
      return reply.status(409).send(
        createErrorResponse({
          correlationId,
          code: result.transition.reasonCode,
          message: result.transition.message,
        }),
      );
    }

    return reply.status(200).send(createKillSwitchControlSuccessResponse(correlationId, result));
  };
}

/**
 * 성공한 kill switch 전이를 HTTP 응답 shape으로 변환한다.
 *
 * 응답에는 secret이나 raw DB row를 넣지 않고, 운영자가 즉시 확인해야 하는 전이 결과, action plan, 후속 job, evidence id,
 * Telegram dispatch 결과만 노출한다. 실패 응답은 이 함수가 아니라 공통 error response를 사용한다.
 */
function createKillSwitchControlSuccessResponse(
  correlationId: string,
  result: KillSwitchControlResult,
) {
  return {
    status: "ok",
    correlationId,
    transition: {
      accepted: result.transition.accepted,
      fromState: result.transition.fromState,
      toState: result.transition.toState,
      reasonCode: result.transition.reasonCode,
      message: result.transition.message,
    },
    actionPlan: {
      newOrdersBlocked: result.actionPlan.newOrdersBlocked,
      strategyEvaluationBlocked: result.actionPlan.strategyEvaluationBlocked,
      cancelPendingPaperOrders: result.actionPlan.cancelPendingPaperOrders,
      autoLiquidateOpenPositions: result.actionPlan.autoLiquidateOpenPositions,
      requiresManualReview: result.actionPlan.requiresManualReview,
    },
    reasonMatchesTarget: result.reasonMatchesTarget,
    recommendedTargetState: result.recommendedTargetState ?? null,
    hardStopCancelJob: result.hardStopCancelJob ?? null,
    evidence: {
      auditEventId: result.auditEventId ?? null,
      riskEventId: result.riskEventId ?? null,
    },
    alertDispatch: createAlertDispatchResponse(result.alertDispatch),
    alertDispatchFailure:
      result.alertDispatchFailure === undefined
        ? null
        : {
            reasonCode: result.alertDispatchFailure.reasonCode,
            message: "Kill switch 상태 전이는 저장됐지만 Telegram dispatch evidence가 실패했다.",
          },
  };
}

/**
 * kill switch control 후속 Telegram dispatch 결과를 HTTP 응답에 안전하게 싣는 표현으로 줄인다.
 *
 * provider message id와 fingerprint는 운영 추적에 필요하지만, retry payload 원문이나 notifier 내부 상태는 외부 응답에 싣지
 * 않는다. correlation id는 상위 응답 필드와 audit evidence에서 이어 보게 한다.
 */
function createAlertDispatchResponse(
  alertDispatch: KillSwitchControlResult["alertDispatch"],
) {
  if (alertDispatch === undefined) {
    return null;
  }

  return {
    fingerprint: alertDispatch.fingerprint,
    cooldownHit: alertDispatch.cooldownHit,
    notification: {
      delivered: alertDispatch.notification.delivered,
      providerMessageId: alertDispatch.notification.providerMessageId ?? null,
      skippedReason: alertDispatch.notification.skippedReason ?? null,
    },
    retryJobPlan:
      alertDispatch.retryJobPlan === undefined
        ? null
        : {
            jobType: alertDispatch.retryJobPlan.jobType,
            idempotencyKey: alertDispatch.retryJobPlan.idempotencyKey,
            runAfter: toHttpTimestamp(alertDispatch.retryJobPlan.runAfter),
            maxAttempts: alertDispatch.retryJobPlan.maxAttempts,
          },
    retryJobEnqueueReceipt:
      alertDispatch.retryJobEnqueueReceipt === undefined
        ? null
        : {
            jobType: alertDispatch.retryJobEnqueueReceipt.jobType,
            idempotencyKey: alertDispatch.retryJobEnqueueReceipt.idempotencyKey,
            jobId: alertDispatch.retryJobEnqueueReceipt.jobId ?? null,
            created: alertDispatch.retryJobEnqueueReceipt.created,
          },
    retryJobEnqueueFailure: alertDispatch.retryJobEnqueueFailure ?? null,
    failureEvaluation: {
      state: {
        consecutiveFailures: alertDispatch.failureEvaluation.state.consecutiveFailures,
        firstFailureAt: toNullableHttpTimestamp(alertDispatch.failureEvaluation.state.firstFailureAt),
        lastFailureAt: toNullableHttpTimestamp(alertDispatch.failureEvaluation.state.lastFailureAt),
      },
      manualReviewReasonCode: alertDispatch.failureEvaluation.manualReviewReasonCode ?? null,
    },
  };
}

/**
 * application layer의 timestamp 입력을 HTTP JSON schema가 기대하는 문자열로 고정한다.
 */
function toHttpTimestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * 실패 누적 상태처럼 아직 시각이 없는 값을 HTTP nullable timestamp로 정규화한다.
 */
function toNullableHttpTimestamp(value: Date | string | null) {
  return value === null ? null : toHttpTimestamp(value);
}
