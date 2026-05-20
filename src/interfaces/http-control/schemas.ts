import type { RouteShorthandOptions } from "fastify";

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
