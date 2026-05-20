import type { RouteShorthandOptions } from "fastify";
import { killSwitchControlTargetStates } from "../../application/index.js";

const readinessCheckSchema = {
  type: "object",
  required: ["name", "status", "critical", "checkedAt", "message", "observedValue"],
  properties: {
    name: { type: "string" },
    status: { enum: ["ok", "fail"] },
    critical: { type: "boolean" },
    checkedAt: { type: "string" },
    message: { type: "string" },
    observedValue: { type: ["string", "number", "boolean", "null"] },
  },
} as const;

const readinessResponseSchema = {
  type: "object",
  required: ["status", "ready", "checkedAt", "checks"],
  properties: {
    status: { enum: ["ok", "error"] },
    ready: { type: "boolean" },
    checkedAt: { type: "string" },
    checks: {
      type: "array",
      items: readinessCheckSchema,
    },
  },
} as const;

const nullableOperationalStatusSchema = {
  type: "object",
  required: ["connectionStatus", "lagMs", "updatedAt"],
  properties: {
    connectionStatus: { type: "string" },
    lagMs: { type: ["number", "null"] },
    updatedAt: { type: ["string", "null"] },
  },
} as const;

const errorResponseSchema = {
  type: "object",
  required: ["status", "correlationId", "error"],
  properties: {
    status: { const: "error" },
    correlationId: { type: "string" },
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
    },
  },
} as const;

const actionPlanSchema = {
  type: "object",
  required: [
    "newOrdersBlocked",
    "strategyEvaluationBlocked",
    "cancelPendingPaperOrders",
    "autoLiquidateOpenPositions",
    "requiresManualReview",
  ],
  properties: {
    newOrdersBlocked: { type: "boolean" },
    strategyEvaluationBlocked: { type: "boolean" },
    cancelPendingPaperOrders: { type: "boolean" },
    autoLiquidateOpenPositions: { const: false },
    requiresManualReview: { type: "boolean" },
  },
} as const;

export const healthzRouteOptions: RouteShorthandOptions = {
  schema: {
    response: {
      200: {
        type: "object",
        required: ["status", "service", "check", "timestamp", "uptimeSeconds", "correlationId"],
        properties: {
          status: { const: "ok" },
          service: { const: "seemirai" },
          check: { const: "process" },
          timestamp: { type: "string" },
          uptimeSeconds: { type: "number" },
          correlationId: { type: "string" },
        },
      },
      500: errorResponseSchema,
    },
  },
};

export const readyzRouteOptions: RouteShorthandOptions = {
  schema: {
    response: {
      200: readinessResponseSchema,
      503: readinessResponseSchema,
      500: errorResponseSchema,
    },
  },
};

export const statusRouteOptions: RouteShorthandOptions = {
  schema: {
    response: {
      200: {
        type: "object",
        required: [
          "status",
          "correlationId",
          "generatedAt",
          "runtime",
          "tradingState",
          "marketData",
          "paper",
          "database",
          "alerts",
          "dailyReport",
        ],
        properties: {
          status: { const: "ok" },
          correlationId: { type: "string" },
          generatedAt: { type: "string" },
          runtime: {
            type: "object",
            required: ["exchange", "market", "mode", "universe", "liveTradingEnabled", "paperNoKey"],
            properties: {
              exchange: { type: "string" },
              market: { type: "string" },
              mode: { type: "string" },
              universe: {
                type: "object",
                required: ["phase1", "phase1Count"],
                properties: {
                  phase1: { type: "array", items: { type: "string" } },
                  phase1Count: { type: "number" },
                },
              },
              liveTradingEnabled: { type: "boolean" },
              paperNoKey: { type: "boolean" },
            },
          },
          tradingState: {
            type: "object",
            required: [
              "state",
              "killSwitchState",
              "blockedReason",
              "newOrdersBlocked",
              "requiresManualReview",
            ],
            properties: {
              state: { type: "string" },
              killSwitchState: { type: "string" },
              blockedReason: { type: ["string", "null"] },
              newOrdersBlocked: { type: "boolean" },
              requiresManualReview: { type: "boolean" },
            },
          },
          marketData: nullableOperationalStatusSchema,
          paper: {
            type: "object",
            required: ["pendingPaperOrderCount", "openPositionCount"],
            properties: {
              pendingPaperOrderCount: { type: ["number", "null"] },
              openPositionCount: { type: ["number", "null"] },
            },
          },
          database: readinessResponseSchema,
          alerts: {
            type: "object",
            required: ["lastSentAt", "lastSkippedAt"],
            properties: {
              lastSentAt: { type: ["string", "null"] },
              lastSkippedAt: { type: ["string", "null"] },
            },
          },
          dailyReport: {
            type: "object",
            required: ["lastStatus", "reportDate", "updatedAt"],
            properties: {
              lastStatus: { type: "string" },
              reportDate: { type: ["string", "null"] },
              updatedAt: { type: ["string", "null"] },
            },
          },
        },
      },
      500: errorResponseSchema,
    },
  },
};

export const killSwitchRouteOptions: RouteShorthandOptions = {
  schema: {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["targetState", "reasonCode"],
      properties: {
        targetState: { enum: killSwitchControlTargetStates },
        reasonCode: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1 },
        actor: { type: "string", minLength: 1 },
        metadata: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
    response: {
      200: {
        type: "object",
        required: [
          "status",
          "correlationId",
          "transition",
          "actionPlan",
          "reasonMatchesTarget",
          "recommendedTargetState",
          "hardStopCancelJob",
          "evidence",
        ],
        properties: {
          status: { const: "ok" },
          correlationId: { type: "string" },
          transition: {
            type: "object",
            required: ["accepted", "fromState", "toState", "reasonCode", "message"],
            properties: {
              accepted: { const: true },
              fromState: { type: "string" },
              toState: { type: "string" },
              reasonCode: { type: "string" },
              message: { type: "string" },
            },
          },
          actionPlan: actionPlanSchema,
          reasonMatchesTarget: { type: "boolean" },
          recommendedTargetState: { type: ["string", "null"] },
          hardStopCancelJob: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                required: ["jobType", "idempotencyKey", "created"],
                properties: {
                  jobType: { type: "string" },
                  idempotencyKey: { type: "string" },
                  jobId: { type: "string" },
                  created: { type: "boolean" },
                },
              },
            ],
          },
          evidence: {
            type: "object",
            required: ["auditEventId", "riskEventId"],
            properties: {
              auditEventId: { type: ["string", "null"] },
              riskEventId: { type: ["string", "null"] },
            },
          },
        },
      },
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      409: errorResponseSchema,
      500: errorResponseSchema,
    },
  },
};
