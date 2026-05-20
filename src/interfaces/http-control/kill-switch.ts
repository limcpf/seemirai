import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  KillSwitchControlProvider,
  KillSwitchControlResult,
  KillSwitchControlTargetState,
} from "../../application/index.js";
import { canonicalizeKillSwitchReasonCode } from "../../application/index.js";
import { createErrorResponse, getCorrelationId } from "./errors.js";

export interface KillSwitchControlRequestBody {
  targetState: KillSwitchControlTargetState;
  reasonCode: string;
  message?: string;
  actor?: string;
  metadata?: Record<string, unknown>;
}

/**
 * `POST /kill-switch` route handler를 만든다.
 *
 * route는 인증과 schema 검증을 통과한 요청만 provider로 넘기고, 불법 전이는 409 error로 정규화한다.
 */
export function createKillSwitchControlRouteHandler(provider: KillSwitchControlProvider) {
  return async (
    request: FastifyRequest<{ Body: KillSwitchControlRequestBody }>,
    reply: FastifyReply,
  ) => {
    const correlationId = getCorrelationId(request);
    const reasonCode = canonicalizeKillSwitchReasonCode(request.body.reasonCode);
    const result = await provider.apply({
      targetState: request.body.targetState,
      reasonCode,
      correlationId,
      ...(request.body.actor === undefined ? {} : { actor: request.body.actor }),
      ...(request.body.message === undefined ? {} : { message: request.body.message }),
      ...(request.body.metadata === undefined ? {} : { metadata: request.body.metadata }),
    });

    if (!result.transition.accepted) {
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
  };
}
