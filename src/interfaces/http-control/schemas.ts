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

const operationalStatusDetailSchema = {
  required: ["status", "statusLabel", "message", "action", "trace"],
  properties: {
    status: { enum: ["ok", "warning", "unavailable"] },
    statusLabel: { type: "string" },
    message: { type: "string" },
    action: { type: ["string", "null"] },
    trace: { type: "object", additionalProperties: true },
  },
} as const;

const pilotEvidenceSafeSummarySchema = {
  type: ["object", "null"],
  required: ["profile", "status", "statusLabel", "occurredAt", "correlationId", "message", "action"],
  properties: {
    profile: { enum: ["PILOT_READ_ONLY", "PILOT_POLICY_SYNC", "PILOT_ORDER_SMOKE"] },
    status: { enum: ["SKIPPED", "PASSED", "FAILED", "MANUAL_REVIEW_REQUIRED"] },
    statusLabel: { type: "string" },
    occurredAt: { type: "string" },
    correlationId: { type: "string" },
    message: { type: "string" },
    action: { type: ["string", "null"] },
    auditEventId: { type: "string" },
    reportArtifactId: { type: "string" },
    reportArtifactPath: { type: "string" },
    safeMetadata: { type: "object", additionalProperties: true },
  },
  additionalProperties: false,
} as const;

const pilotRuntimeSafeSummarySchema = {
  type: "object",
  required: [
    "enabled",
    "profile",
    "privateSmokeEnabled",
    "orderSmokeEnabled",
    "credentialsConfigured",
    "keyScopes",
    "keyScopeEvidenceId",
    "policySyncMarket",
    "orderSmokeMarket",
    "orderSmokeMaxKrw",
    "lookupOrderConfigured",
    "statusLabel",
    "message",
    "action",
    "lastEvidence",
    "trace",
  ],
  properties: {
    enabled: { type: "boolean" },
    profile: { enum: ["PILOT_READ_ONLY", "PILOT_POLICY_SYNC", "PILOT_ORDER_SMOKE", null] },
    privateSmokeEnabled: { type: "boolean" },
    orderSmokeEnabled: { type: "boolean" },
    credentialsConfigured: { type: "boolean" },
    keyScopes: { type: "array", items: { type: "string" } },
    keyScopeEvidenceId: { type: ["string", "null"] },
    policySyncMarket: { type: ["string", "null"] },
    orderSmokeMarket: { type: ["string", "null"] },
    orderSmokeMaxKrw: { type: ["string", "null"] },
    lookupOrderConfigured: { type: "boolean" },
    statusLabel: { type: "string" },
    message: { type: "string" },
    action: { type: ["string", "null"] },
    lastEvidence: pilotEvidenceSafeSummarySchema,
    trace: { type: "object", additionalProperties: true },
  },
  additionalProperties: false,
} as const;

const liveAutonomousRuntimeSafeSummarySchema = {
  type: "object",
  required: [
    "enabled",
    "ready",
    "allowedMarkets",
    "maxOrderKrw",
    "dailyAutonomousNotionalLimitKrw",
    "maxOpenPositionNotionalKrw",
    "m21WeekGateEvidenceConfigured",
    "operatorArmEvidenceConfigured",
    "budgetEvidenceConfigured",
    "keyScopeEvidenceConfigured",
    "telegramInboundReady",
    "reconcileFresh",
    "pnlStatusReady",
    "decisionLedgerReady",
    "exitEngineReady",
    "statusLabel",
    "message",
    "action",
    "trace",
  ],
  properties: {
    enabled: { type: "boolean" },
    ready: { type: "boolean" },
    allowedMarkets: { type: "array", items: { type: "string" } },
    maxOrderKrw: { type: "string" },
    dailyAutonomousNotionalLimitKrw: { type: "string" },
    maxOpenPositionNotionalKrw: { type: "string" },
    m21WeekGateEvidenceConfigured: { type: "boolean" },
    operatorArmEvidenceConfigured: { type: "boolean" },
    budgetEvidenceConfigured: { type: "boolean" },
    keyScopeEvidenceConfigured: { type: "boolean" },
    telegramInboundReady: { type: "boolean" },
    reconcileFresh: { type: "boolean" },
    pnlStatusReady: { type: "boolean" },
    decisionLedgerReady: { type: "boolean" },
    exitEngineReady: { type: "boolean" },
    statusLabel: { type: "string" },
    message: { type: "string" },
    action: { type: ["string", "null"] },
    trace: { type: "object", additionalProperties: true },
  },
  additionalProperties: false,
} as const;

const reconcileStatusSummarySchema = {
  type: "object",
  required: [
    "lastReconcileAt",
    "result",
    "mismatchCount",
    "openOrderCount",
    "balanceStatus",
    "websocketStatus",
    "actionRequired",
    "message",
    "trace",
  ],
  properties: {
    lastReconcileAt: { type: ["string", "null"] },
    result: { enum: ["SUCCESS", "MISMATCH_DETECTED", "FAILED", "SKIPPED", "UNAVAILABLE"] },
    mismatchCount: { type: ["number", "null"] },
    openOrderCount: { type: ["number", "null"] },
    balanceStatus: { enum: ["OK", "STALE", "UNAVAILABLE"] },
    websocketStatus: { enum: ["CONNECTED", "DISCONNECTED", "RECONNECTING", "DEGRADED"] },
    actionRequired: { type: "string" },
    message: { type: "string" },
    trace: { type: "object", additionalProperties: true },
  },
  additionalProperties: false,
} as const;

const liveAutonomousExitReconcileSnapshotSchema = {
  type: "object",
  required: ["result", "mismatchCount", "openOrderCount", "balanceStatus", "websocketStatus", "lastReconcileAt"],
  properties: {
    result: { enum: ["SUCCESS", "MISMATCH_DETECTED", "FAILED", "SKIPPED", "UNAVAILABLE"] },
    mismatchCount: { type: ["number", "null"] },
    openOrderCount: { type: ["number", "null"] },
    balanceStatus: { enum: ["OK", "STALE", "UNAVAILABLE"] },
    websocketStatus: { enum: ["CONNECTED", "DISCONNECTED", "RECONNECTING", "DEGRADED"] },
    lastReconcileAt: { type: ["string", "null"] },
  },
  additionalProperties: false,
} as const;

const liveAutonomousExitStatusSummarySchema = {
  type: "object",
  required: [
    "enabled",
    "runtimeReady",
    "exitEngineReady",
    "status",
    "statusCode",
    "statusLabel",
    "message",
    "impact",
    "action",
    "market",
    "strategyId",
    "latestBrokerOrderStatus",
    "filledQuantity",
    "remainingQuantity",
    "reconcile",
    "trace",
  ],
  properties: {
    enabled: { type: "boolean" },
    runtimeReady: { type: "boolean" },
    exitEngineReady: { type: "boolean" },
    status: { enum: ["ok", "warning", "unavailable"] },
    statusCode: {
      enum: [
        "DISABLED",
        "BLOCKED",
        "READY",
        "NO_EXIT_INTENT",
        "EXIT_SUBMITTED",
        "REQUOTE_INTENT_CREATED",
        "RECONCILE_REQUIRED",
        "MANUAL_REVIEW_REQUIRED",
      ],
    },
    statusLabel: { type: "string" },
    message: { type: "string" },
    impact: { type: ["string", "null"] },
    action: { type: ["string", "null"] },
    market: { type: ["string", "null"] },
    strategyId: { type: ["string", "null"] },
    latestBrokerOrderStatus: { type: ["string", "null"] },
    filledQuantity: { type: ["string", "null"] },
    remainingQuantity: { type: ["string", "null"] },
    reconcile: liveAutonomousExitReconcileSnapshotSchema,
    trace: { type: "object", additionalProperties: true },
  },
  additionalProperties: false,
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

/**
 * kill switch 상태가 런타임에 요구하는 차단 조치의 HTTP 응답 schema다.
 *
 * `autoLiquidateOpenPositions`는 MVP paper trading safety invariant에 따라 항상 false다. HARD_STOP이어도 실계좌 청산이나
 * live broker side effect를 route 응답에서 약속하지 않는다.
 */
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

/**
 * kill switch control 이후 Telegram dispatch가 실제 provider 전송, cooldown skip, retry 예약 중 어디까지 진행됐는지 보여주는
 * 안전한 HTTP 응답 schema다. retry payload 원문은 민감 추적 정보가 섞일 수 있어 노출하지 않는다.
 */
const alertDispatchResponseSchema = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      required: [
        "fingerprint",
        "cooldownHit",
        "notification",
        "retryJobPlan",
        "retryJobEnqueueReceipt",
        "retryJobEnqueueFailure",
        "failureEvaluation",
      ],
      properties: {
        fingerprint: { type: "string" },
        cooldownHit: { type: "boolean" },
        notification: {
          type: "object",
          required: ["delivered", "providerMessageId", "skippedReason"],
          properties: {
            delivered: { type: "boolean" },
            providerMessageId: { type: ["string", "null"] },
            skippedReason: { type: ["string", "null"] },
          },
        },
        retryJobPlan: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              required: ["jobType", "idempotencyKey", "runAfter", "maxAttempts"],
              properties: {
                jobType: { type: "string" },
                idempotencyKey: { type: "string" },
                runAfter: { type: "string" },
                maxAttempts: { type: "number" },
              },
            },
          ],
        },
        retryJobEnqueueReceipt: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              required: ["jobType", "idempotencyKey", "jobId", "created"],
              properties: {
                jobType: { type: "string" },
                idempotencyKey: { type: "string" },
                jobId: { type: ["string", "null"] },
                created: { type: "boolean" },
              },
            },
          ],
        },
        retryJobEnqueueFailure: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              required: ["reasonCode", "message"],
              properties: {
                reasonCode: { type: "string" },
                message: { type: "string" },
              },
            },
          ],
        },
        failureEvaluation: {
          type: "object",
          required: ["state", "manualReviewReasonCode"],
          properties: {
            state: {
              type: "object",
              required: ["consecutiveFailures", "firstFailureAt", "lastFailureAt"],
              properties: {
                consecutiveFailures: { type: "number" },
                firstFailureAt: { type: ["string", "null"] },
                lastFailureAt: { type: ["string", "null"] },
              },
            },
            manualReviewReasonCode: { type: ["string", "null"] },
          },
        },
      },
    },
  ],
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
          "pnl",
          "reconcile",
          "liveAutonomousExit",
          "why",
        ],
        properties: {
          status: { const: "ok" },
          correlationId: { type: "string" },
          generatedAt: { type: "string" },
          runtime: {
            type: "object",
            required: [
              "exchange",
              "market",
              "mode",
              "universe",
              "liveTradingEnabled",
              "paperNoKey",
              "pilot",
              "liveAutonomous",
            ],
            properties: {
              exchange: { type: "string" },
              market: { type: "string" },
              mode: { type: "string" },
              universe: {
                type: "object",
                required: ["phase1", "phase1Count", "phase15"],
                properties: {
                  phase1: { type: "array", items: { type: "string" } },
                  phase1Count: { type: "number" },
                  phase15: {
                    type: "object",
                    required: [
                      "enabled",
                      "approvedAltMarkets",
                      "approvedAltCount",
                      "candidateMarkets",
                      "candidateMarketCount",
                      "maxManualApprovals",
                    ],
                    properties: {
                      enabled: { type: "boolean" },
                      approvedAltMarkets: { type: "array", items: { type: "string" } },
                      approvedAltCount: { type: "number" },
                      candidateMarkets: { type: "array", items: { type: "string" } },
                      candidateMarketCount: { type: "number" },
                      maxManualApprovals: { type: "number" },
                    },
                  },
                },
              },
              liveTradingEnabled: { type: "boolean" },
              paperNoKey: { type: "boolean" },
              pilot: pilotRuntimeSafeSummarySchema,
              liveAutonomous: liveAutonomousRuntimeSafeSummarySchema,
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
            required: [
              ...operationalStatusDetailSchema.required,
              "pendingPaperOrderCount",
              "openPositionCount",
            ],
            properties: {
              ...operationalStatusDetailSchema.properties,
              pendingPaperOrderCount: { type: ["number", "null"] },
              openPositionCount: { type: ["number", "null"] },
            },
          },
          database: readinessResponseSchema,
          alerts: {
            type: "object",
            required: [...operationalStatusDetailSchema.required, "lastSentAt", "lastSkippedAt"],
            properties: {
              ...operationalStatusDetailSchema.properties,
              lastSentAt: { type: ["string", "null"] },
              lastSkippedAt: { type: ["string", "null"] },
            },
          },
          dailyReport: {
            type: "object",
            required: [
              ...operationalStatusDetailSchema.required,
              "lastStatus",
              "reportDate",
              "nextRunAfter",
              "updatedAt",
            ],
            properties: {
              ...operationalStatusDetailSchema.properties,
              lastStatus: { type: "string" },
              reportDate: { type: ["string", "null"] },
              nextRunAfter: { type: ["string", "null"] },
              updatedAt: { type: ["string", "null"] },
            },
          },
          pnl: {
            type: "object",
            required: [
              ...operationalStatusDetailSchema.required,
              "latestCapturedAt",
              "latestEquityKrw",
              "latestRealizedPnlKrw",
              "latestUnrealizedPnlKrw",
              "latestDrawdownBps",
              "latestSource",
              "snapshotCount",
            ],
            properties: {
              ...operationalStatusDetailSchema.properties,
              latestCapturedAt: { type: ["string", "null"] },
              latestEquityKrw: { type: ["string", "null"] },
              latestRealizedPnlKrw: { type: ["string", "null"] },
              latestUnrealizedPnlKrw: { type: ["string", "null"] },
              latestDrawdownBps: { type: ["string", "null"] },
              latestSource: { type: ["string", "null"] },
              snapshotCount: { type: "number" },
            },
          },
          reconcile: reconcileStatusSummarySchema,
          liveAutonomousExit: liveAutonomousExitStatusSummarySchema,
          why: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                required: [
                  "markets",
                  "strategies",
                  "cash",
                  "generatedAt",
                  "readStatus",
                  "trace",
                ],
                properties: {
                  markets: {
                    type: "object",
                    required: ["readStatus", "statusLabel", "message", "impact", "action", "items", "trace"],
                    properties: {
                      readStatus: { enum: ["OK", "NOT_FOUND", "UNAVAILABLE"] },
                      statusLabel: { type: "string" },
                      message: { type: "string" },
                      impact: { type: ["string", "null"] },
                      action: { type: ["string", "null"] },
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["market", "statusLabel", "message", "impact", "action", "latestDecisionAt", "trace"],
                          properties: {
                            market: { type: "string" },
                            statusLabel: { type: "string" },
                            message: { type: "string" },
                            impact: { type: ["string", "null"] },
                            action: { type: ["string", "null"] },
                            latestDecisionAt: { type: ["string", "null"] },
                            trace: { type: "object", additionalProperties: true },
                          },
                        },
                      },
                      trace: { type: "object", additionalProperties: true },
                    },
                  },
                  strategies: {
                    type: "object",
                    required: ["readStatus", "statusLabel", "message", "impact", "action", "items", "trace"],
                    properties: {
                      readStatus: { enum: ["OK", "NOT_FOUND", "UNAVAILABLE"] },
                      statusLabel: { type: "string" },
                      message: { type: "string" },
                      impact: { type: ["string", "null"] },
                      action: { type: ["string", "null"] },
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["strategyId", "statusLabel", "message", "impact", "action", "latestDecisionAt", "trace"],
                          properties: {
                            strategyId: { type: "string" },
                            statusLabel: { type: "string" },
                            message: { type: "string" },
                            impact: { type: ["string", "null"] },
                            action: { type: ["string", "null"] },
                            latestDecisionAt: { type: ["string", "null"] },
                            trace: { type: "object", additionalProperties: true },
                          },
                        },
                      },
                      trace: { type: "object", additionalProperties: true },
                    },
                  },
                  cash: {
                    type: "object",
                    required: ["readStatus", "statusLabel", "message", "impact", "action", "item", "trace"],
                    properties: {
                      readStatus: { enum: ["OK", "NOT_FOUND", "UNAVAILABLE"] },
                      statusLabel: { type: "string" },
                      message: { type: "string" },
                      impact: { type: ["string", "null"] },
                      action: { type: ["string", "null"] },
                      item: {
                        anyOf: [
                          { type: "null" },
                          {
                            type: "object",
                            required: ["statusLabel", "message", "impact", "action", "latestDecisionAt", "holdReasons", "trace"],
                            properties: {
                              statusLabel: { type: "string" },
                              message: { type: "string" },
                              impact: { type: ["string", "null"] },
                              action: { type: ["string", "null"] },
                              latestDecisionAt: { type: ["string", "null"] },
                              holdReasons: {
                                type: "array",
                                items: {
                                  type: "object",
                                  required: ["label", "count", "trace"],
                                  properties: {
                                    label: { type: "string" },
                                    count: { type: "number" },
                                    trace: { type: "object", additionalProperties: true },
                                  },
                                },
                              },
                              trace: { type: "object", additionalProperties: true },
                            },
                          },
                        ],
                      },
                      trace: { type: "object", additionalProperties: true },
                    },
                  },
                  generatedAt: { type: "string" },
                  readStatus: { enum: ["OK", "NOT_FOUND", "UNAVAILABLE"] },
                  trace: { type: "object", additionalProperties: true },
                },
              },
            ],
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
        // 운영 증거의 집계 키가 공백이나 임의 포맷으로 깨지지 않도록 reason code 문법을 route 입구에서 고정한다.
        reasonCode: { type: "string", minLength: 1, pattern: "^[A-Za-z0-9][A-Za-z0-9_:-]*$" },
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
        // 성공 응답은 수락된 전이와 후속 조치만 담고, 거부 전이는 409 error schema로 분리한다.
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
          "alertDispatch",
          "alertDispatchFailure",
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
          alertDispatch: alertDispatchResponseSchema,
          alertDispatchFailure: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                required: ["reasonCode", "message"],
                properties: {
                  reasonCode: { type: "string" },
                  message: { type: "string" },
                },
              },
            ],
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
