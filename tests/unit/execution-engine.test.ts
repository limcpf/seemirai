import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ExecutionEngine,
  createExecutionCostSnapshotEvidence,
  createExecutionRiskApprovalEvidence,
  evaluateRiskGate,
  validateExecutionSubmission,
} from "../../src/application/index.js";
import {
  createRiskThresholdSnapshot,
  defaultRiskLimitThresholds,
  evaluateCost,
} from "../../src/domain/index.js";
import type { BrokerPort } from "../../src/application/index.js";
import type { ExecutionRiskApprovalEvidence } from "../../src/application/index.js";
import type {
  BrokerOrder,
  MarketOrderIntent,
  OrderIntent,
  OrderSubmission,
  RiskGateContext,
} from "../../src/domain/index.js";

const observedAt = "2026-05-19T09:00:00.000Z";
const thresholdSnapshot = createRiskThresholdSnapshot(defaultRiskLimitThresholds, observedAt);

type CreateSubmissionOverrides = Omit<Partial<OrderSubmission>, "expectedLossBpsOfEquity"> & {
  expectedLossBpsOfEquity?: OrderSubmission["expectedLossBpsOfEquity"] | undefined;
  intent?: OrderIntent;
};

describe("M6 ExecutionEngine contract", () => {
  it("submits a limit order only after cost and RiskGate evidence match the current intent", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const submission = createSubmission();

    const result = await engine.submitOrder(submission);

    expect(result).toMatchObject({
      status: "SUBMITTED",
      brokerOrder: {
        idempotencyKey: "execution-candidate-1",
        status: "SUBMITTED",
        requestedPrice: "10000000",
      },
    });
    expect(submitOrder).toHaveBeenCalledTimes(1);
    expect(submitOrder).toHaveBeenCalledWith(submission);
  });

  it("rejects submissions without a cost snapshot before calling BrokerPort", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const result = await engine.submitOrder(
      createSubmission({
        costSnapshot: {},
      }),
    );

    expect(result).toMatchObject({
      status: "REJECTED",
      rejection: {
        reasonCode: "cost_snapshot_missing",
      },
    });
    expect(submitOrder).not.toHaveBeenCalled();
  });

  it("rejects submissions when the cost snapshot did not allow the trade", () => {
    const submission = createSubmission({
      costSnapshot: {
        ...createCostSnapshot(createLimitIntent()),
        trade_allowed: false,
        reason_code: "cost_margin_insufficient",
      },
    });

    expect(validateExecutionSubmission(submission)).toMatchObject({
      valid: false,
      rejection: {
        reasonCode: "cost_snapshot_not_allowed",
      },
    });
  });

  it("rejects cost snapshots without the cost model source, OK reason, or clean input fields", () => {
    const baseCostSnapshot = createCostSnapshot(createLimitIntent());

    expect(
      validateExecutionSubmission(
        createSubmission({
          costSnapshot: {
            ...baseCostSnapshot,
            reason_code: "missing_cost_input",
          },
        }),
      ),
    ).toMatchObject({
      valid: false,
      rejection: {
        reasonCode: "cost_snapshot_not_allowed",
      },
    });

    expect(
      validateExecutionSubmission(
        createSubmission({
          costSnapshot: {
            ...baseCostSnapshot,
            missing_fields: ["entry_fee_bps"],
          },
        }),
      ),
    ).toMatchObject({
      valid: false,
      rejection: {
        reasonCode: "cost_snapshot_not_allowed",
      },
    });

    expect(
      validateExecutionSubmission(
        createSubmission({
          costSnapshot: {
            ...baseCostSnapshot,
            source: "fixture",
          },
        }),
      ),
    ).toMatchObject({
      valid: false,
      rejection: {
        reasonCode: "cost_snapshot_not_allowed",
      },
    });
  });

  it("fails closed when CostModel evidence describes a different order candidate", () => {
    const submission = createSubmission({
      costSnapshot: createCostSnapshot(
        createLimitIntent({
          requestedNotional: "6000",
          idempotencyKey: "execution-candidate-cost-mismatch",
        }),
      ),
    });

    expect(validateExecutionSubmission(submission)).toMatchObject({
      valid: false,
      rejection: {
        reasonCode: "cost_snapshot_mismatch",
        metadata: {
          mismatches: {
            requested_notional_evidence: "6000",
            requested_notional_runtime: "5000",
            idempotency_key_evidence: "execution-candidate-cost-mismatch",
            idempotency_key_runtime: "execution-candidate-1",
          },
        },
      },
    });
  });

  it("rejects submissions without RiskGate approval evidence before calling BrokerPort", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const result = await engine.submitOrder(
      createSubmission({
        riskApproval: {},
      }),
    );

    expect(result).toMatchObject({
      status: "REJECTED",
      rejection: {
        reasonCode: "risk_approval_missing",
      },
    });
    expect(submitOrder).not.toHaveBeenCalled();
  });

  it("rejects RiskGate evidence without the risk gate source or approval-capable status", () => {
    const approvedRiskApproval = createRiskApprovalEvidence(createLimitIntent());

    expect(
      validateExecutionSubmission(
        createSubmission({
          riskApproval: {
            ...approvedRiskApproval,
            source: "fixture",
          },
        }),
      ),
    ).toMatchObject({
      valid: false,
      rejection: {
        reasonCode: "risk_approval_not_approved",
      },
    });

    expect(
      validateExecutionSubmission(
        createSubmission({
          riskApproval: {
            ...approvedRiskApproval,
            status: "FAIL",
          },
        }),
      ),
    ).toMatchObject({
      valid: false,
      rejection: {
        reasonCode: "risk_approval_not_approved",
      },
    });

    expect(
      validateExecutionSubmission(
        createSubmission({
          riskApproval: {
            ...approvedRiskApproval,
            failed_evaluation_reason_codes: ["expected_loss_limit_exceeded"],
          },
        }),
      ),
    ).toMatchObject({
      valid: false,
      rejection: {
        reasonCode: "risk_approval_not_approved",
      },
    });

    expect(
      validateExecutionSubmission(
        createSubmission({
          riskApproval: {
            ...approvedRiskApproval,
            failed_evaluation_reason_codes: "expected_loss_limit_exceeded",
          },
        }),
      ),
    ).toMatchObject({
      valid: false,
      rejection: {
        reasonCode: "risk_approval_not_approved",
      },
    });
  });

  it("fails closed when RiskGate evidence describes a different order candidate", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const approvedRiskApproval = createRiskApprovalEvidence(createLimitIntent());
    const result = await engine.submitOrder(
      createSubmission({
        riskApproval: {
          ...approvedRiskApproval,
          order_intent: {
            ...approvedRiskApproval.order_intent,
            market: "KRW-ETH",
            idempotency_key: "execution-candidate-eth",
            requested_notional: "7000",
          },
        },
      }),
    );

    expect(result).toMatchObject({
      status: "REJECTED",
      rejection: {
        reasonCode: "risk_approval_mismatch",
        metadata: {
          mismatches: {
            market_evidence: "KRW-ETH",
            market_runtime: "KRW-BTC",
            idempotency_key_evidence: "execution-candidate-eth",
            idempotency_key_runtime: "execution-candidate-1",
            requested_notional_evidence: "7000",
            requested_notional_runtime: "5000",
          },
        },
      },
    });
    expect(submitOrder).not.toHaveBeenCalled();
  });

  it("rejects blank idempotency keys before cost or broker side effects", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const intent = createLimitIntent({
      idempotencyKey: "   ",
    });
    const result = await engine.submitOrder(createSubmission({ intent }));

    expect(result).toMatchObject({
      status: "REJECTED",
      rejection: {
        reasonCode: "idempotency_key_missing",
      },
    });
    expect(submitOrder).not.toHaveBeenCalled();
  });

  it("suppresses duplicate broker submission for the same idempotency key", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const submission = createSubmission();

    const firstResultPromise = engine.submitOrder(submission);
    const duplicateResultPromise = engine.submitOrder(submission);
    const [firstResult, duplicateResult] = await Promise.all([
      firstResultPromise,
      duplicateResultPromise,
    ]);

    expect(firstResult.status).toBe("SUBMITTED");
    expect(duplicateResult).toMatchObject({
      status: "DUPLICATE_SUPPRESSED",
      brokerOrder: {
        idempotencyKey: "execution-candidate-1",
      },
    });
    expect(submitOrder).toHaveBeenCalledTimes(1);
  });

  it("rejects in-flight idempotency key reuse when the order fingerprint differs", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const firstSubmission = createSubmission();
    const approvedRiskApproval = createRiskApprovalEvidence(createLimitIntent());
    const collidingSubmission = createSubmission({
      intent: createLimitIntent({
        requestedNotional: "6000",
      }),
      riskApproval: {
        ...approvedRiskApproval,
        order_intent: {
          ...approvedRiskApproval.order_intent,
          requested_notional: "6000",
        },
      },
    });

    const firstResultPromise = engine.submitOrder(firstSubmission);
    const collisionResult = await engine.submitOrder(collidingSubmission);
    const firstResult = await firstResultPromise;

    expect(firstResult.status).toBe("SUBMITTED");
    expect(collisionResult).toMatchObject({
      status: "REJECTED",
      rejection: {
        reasonCode: "idempotency_key_collision",
        metadata: {
          mismatches: {
            requested_notional_evidence: "5000",
            requested_notional_runtime: "6000",
          },
        },
      },
    });
    expect(submitOrder).toHaveBeenCalledTimes(1);
  });

  it("rejects RiskGate evidence when expected loss input changed after approval", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const result = await engine.submitOrder(
      createSubmission({
        expectedLossBpsOfEquity: "25",
        riskApproval: createRiskApprovalEvidence(createLimitIntent()),
      }),
    );

    expect(result).toMatchObject({
      status: "REJECTED",
      rejection: {
        reasonCode: "risk_approval_mismatch",
        metadata: {
          mismatches: {
            expected_loss_bps_of_equity_evidence: "10",
            expected_loss_bps_of_equity_runtime: "25",
          },
        },
      },
    });
    expect(submitOrder).not.toHaveBeenCalled();
  });

  it("rejects execution evidence when expected loss is missing from the order fingerprint", () => {
    const submission = createSubmission({
      expectedLossBpsOfEquity: undefined,
    });

    expect(validateExecutionSubmission(submission)).toMatchObject({
      valid: false,
      rejection: {
        reasonCode: "cost_snapshot_mismatch",
        metadata: {
          mismatches: {
            expected_loss_bps_of_equity_evidence: null,
            expected_loss_bps_of_equity_runtime: null,
          },
        },
      },
    });
  });

  it("rejects RiskGate evidence when limit execution options changed after approval", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const approvedRiskApproval = createRiskApprovalEvidence(createLimitIntent());
    const result = await engine.submitOrder(
      createSubmission({
        intent: createLimitIntent({
          postOnly: true,
          timeInForce: "IOC",
        }),
        riskApproval: approvedRiskApproval,
      }),
    );

    expect(result).toMatchObject({
      status: "REJECTED",
      rejection: {
        reasonCode: "risk_approval_mismatch",
        metadata: {
          mismatches: {
            post_only_evidence: false,
            post_only_runtime: true,
            time_in_force_runtime: "IOC",
          },
        },
      },
    });
    expect(submitOrder).not.toHaveBeenCalled();
  });

  it("treats omitted limit time-in-force as GTC in execution fingerprints", () => {
    const approvedIntent = createLimitIntent({
      timeInForce: "GTC",
    });
    const runtimeIntent = createLimitIntent();

    expect(
      validateExecutionSubmission(
        createSubmission({
          intent: runtimeIntent,
          costSnapshot: createCostSnapshot(approvedIntent),
          riskApproval: createRiskApprovalEvidence(approvedIntent),
        }),
      ),
    ).toMatchObject({
      valid: true,
    });
  });

  it("suppresses duplicate in-flight submissions when omitted and explicit GTC mean the same limit order", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const implicitGtcSubmission = createSubmission({
      intent: createLimitIntent(),
    });
    const explicitGtcSubmission = createSubmission({
      intent: createLimitIntent({
        timeInForce: "GTC",
      }),
    });

    const firstResultPromise = engine.submitOrder(implicitGtcSubmission);
    const duplicateResult = await engine.submitOrder(explicitGtcSubmission);
    const firstResult = await firstResultPromise;

    expect(firstResult.status).toBe("SUBMITTED");
    expect(duplicateResult).toMatchObject({
      status: "DUPLICATE_SUPPRESSED",
    });
    expect(submitOrder).toHaveBeenCalledTimes(1);
  });

  it("rejects RiskGate evidence when market position effect changed after approval", () => {
    const approvedEntryIntent = createMarketIntent({
      side: "SELL",
    });
    const reduceOnlyRuntimeIntent = createMarketIntent({
      side: "SELL",
      metadata: {
        position_effect: "REDUCE",
      },
    });

    expect(
      validateExecutionSubmission(
        createSubmission({
          intent: reduceOnlyRuntimeIntent,
          costSnapshot: createCostSnapshot(reduceOnlyRuntimeIntent),
          riskApproval: createRiskApprovalEvidence(approvedEntryIntent),
        }),
        {
          liveTradingEnabled: false,
          marketOrderEnabled: true,
          entryMarketOrderEnabled: false,
          paperNoKey: true,
        },
      ),
    ).toMatchObject({
      valid: false,
      rejection: {
        reasonCode: "risk_approval_mismatch",
        metadata: {
          mismatches: {
            position_effect_runtime: "REDUCE",
          },
        },
      },
    });
  });

  it("rejects market orders in the default paper profile", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const intent = createMarketIntent();
    const result = await engine.submitOrder(createSubmission({ intent }));

    expect(result).toMatchObject({
      status: "REJECTED",
      rejection: {
        reasonCode: "market_order_disabled",
      },
    });
    expect(submitOrder).not.toHaveBeenCalled();
  });

  it("keeps entry market orders disabled even when market order simulation is explicitly enabled", () => {
    const intent = createMarketIntent();

    expect(
      validateExecutionSubmission(createSubmission({ intent }), {
        liveTradingEnabled: false,
        marketOrderEnabled: true,
        entryMarketOrderEnabled: false,
        paperNoKey: true,
      }),
    ).toMatchObject({
      valid: false,
      rejection: {
        reasonCode: "entry_market_order_disabled",
      },
    });
  });

  it("allows entry market simulation only when both market toggles are explicitly enabled", () => {
    const intent = createMarketIntent();

    expect(
      validateExecutionSubmission(createSubmission({ intent }), {
        liveTradingEnabled: false,
        marketOrderEnabled: true,
        entryMarketOrderEnabled: true,
        paperNoKey: true,
      }),
    ).toMatchObject({
      valid: true,
    });
  });

  it("allows reduce-only market simulation when entry market orders stay disabled", () => {
    const intent = createMarketIntent({
      side: "SELL",
      metadata: {
        position_effect: "REDUCE",
      },
    });

    expect(
      validateExecutionSubmission(createSubmission({ intent }), {
        liveTradingEnabled: false,
        marketOrderEnabled: true,
        entryMarketOrderEnabled: false,
        paperNoKey: true,
      }),
    ).toMatchObject({
      valid: true,
    });
  });

  it("rejects live-trading execution config before BrokerPort side effects", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine(
      { broker },
      {
        safetyConfig: {
          liveTradingEnabled: true,
        },
      },
    );
    const result = await engine.submitOrder(createSubmission());

    expect(result).toMatchObject({
      status: "REJECTED",
      rejection: {
        reasonCode: "live_trading_disabled",
      },
    });
    expect(submitOrder).not.toHaveBeenCalled();
  });

  describe("M19 exit cost evidence validation", () => {
    it("accepts exit intent with exit_cost_model source and REDUCE position_effect", () => {
      const intent = createSellLimitIntent({
        metadata: {
          position_effect: "REDUCE",
          exit_reason_code: "stop_loss_exit",
          exit_rule_id: "stop_loss",
        },
      });
      const riskApproval = createRiskApprovalEvidence(intent);

      const result = validateExecutionSubmission(
        createSubmission({
          intent,
          costSnapshot: createExitCostSnapshot(intent),
          riskApproval,
        }),
      );

      // exit intent가 RiskGate 승인을 받고 exit cost evidence가 유효하면 broker 제출 전 검증을 통과해야 한다.
      expect(result.valid).toBe(true);
    });

    it("rejects exit_cost_model source on entry intent without position_effect", () => {
      const intent = createLimitIntent();

      expect(
        validateExecutionSubmission(
          createSubmission({
            intent,
            costSnapshot: createExitCostSnapshot(intent),
          }),
        ),
      ).toMatchObject({
        valid: false,
        rejection: {
          reasonCode: "exit_cost_evidence_on_entry",
        },
      });
    });

    it("rejects BUY intent even when REDUCE position_effect is attached", () => {
      const intent = createLimitIntent({
        metadata: {
          position_effect: "REDUCE",
          exit_reason_code: "stop_loss_exit",
          exit_rule_id: "stop_loss",
        },
      });

      expect(
        validateExecutionSubmission(
          createSubmission({
            intent,
            costSnapshot: createExitCostSnapshot(intent),
            riskApproval: createRiskApprovalEvidence(intent),
          }),
        ),
      ).toMatchObject({
        valid: false,
        rejection: {
          reasonCode: "exit_cost_evidence_on_entry",
        },
      });
    });

    it("rejects exit cost evidence without exit reason and rule metadata", () => {
      const intent = createSellLimitIntent({
        metadata: {
          position_effect: "EXIT",
        },
      });

      expect(
        validateExecutionSubmission(
          createSubmission({
            intent,
            costSnapshot: createExitCostSnapshot(intent),
          }),
        ),
      ).toMatchObject({
        valid: false,
        rejection: {
          reasonCode: "exit_cost_evidence_invalid",
          metadata: {
            missing_exit_reason_code: true,
            missing_exit_rule_id: true,
          },
        },
      });
    });

    it("rejects exit cost evidence when exit_cost_allowed is false", () => {
      const intent = createSellLimitIntent({
        metadata: {
          position_effect: "REDUCE",
          exit_reason_code: "stop_loss_exit",
          exit_rule_id: "stop_loss",
        },
      });

      expect(
        validateExecutionSubmission(
          createSubmission({
            intent,
            costSnapshot: {
              source: "exit_cost_model",
              exit_cost_allowed: false,
              exit_cost_reason_code: "exit_cost_margin_insufficient",
              exit_cost_bps: "5",
              exit_slippage_bps: "2",
              position_scope: {
                market: "KRW-BTC",
                strategy_id: "trend_following",
                total_quantity: "0.01",
              },
            },
          }),
        ),
      ).toMatchObject({
        valid: false,
        rejection: {
          reasonCode: "exit_cost_evidence_invalid",
        },
      });
    });

    it("rejects exit cost evidence when position_scope mismatches intent", () => {
      const intent = createSellLimitIntent({
        metadata: {
          position_effect: "REDUCE",
          exit_reason_code: "stop_loss_exit",
          exit_rule_id: "stop_loss",
        },
      });

      expect(
        validateExecutionSubmission(
          createSubmission({
            intent,
            costSnapshot: {
              source: "exit_cost_model",
              exit_cost_allowed: true,
              exit_cost_reason_code: "exit_cost_margin_ok",
              exit_cost_bps: "5",
              exit_slippage_bps: "2",
              position_scope: {
                market: "KRW-ETH",
                strategy_id: "mean_reversion",
                total_quantity: "0.01",
              },
            },
          }),
        ),
      ).toMatchObject({
        valid: false,
        rejection: {
          reasonCode: "exit_position_scope_mismatch",
        },
      });
    });

    it("rejects exit cost evidence when position_scope quantity is missing or non-positive", () => {
      const intent = createSellLimitIntent({
        metadata: {
          position_effect: "REDUCE",
          exit_reason_code: "stop_loss_exit",
          exit_rule_id: "stop_loss",
        },
      });

      expect(
        validateExecutionSubmission(
          createSubmission({
            intent,
            costSnapshot: {
              ...createExitCostSnapshot(intent),
              position_scope: {
                market: "KRW-BTC",
                strategy_id: "trend_following",
                total_quantity: "0",
              },
            },
          }),
        ),
      ).toMatchObject({
        valid: false,
        rejection: {
          reasonCode: "exit_position_scope_mismatch",
        },
      });
    });

    it("rejects entry intent carrying exit-related metadata", () => {
      const intent = createLimitIntent({
        metadata: {
          exit_reason_code: "stop_loss_exit",
          exit_rule_id: "stop_loss",
          exit_cost_bps: "5",
        },
      });

      expect(
        validateExecutionSubmission(createSubmission({ intent })),
      ).toMatchObject({
        valid: false,
        rejection: {
          reasonCode: "exit_cost_evidence_on_entry",
        },
      });
    });

    it("rejects SELL order when quantity exceeds open position", () => {
      const intent = createSellLimitIntent({
        requestedQuantity: "0.02",
        metadata: {
          position_effect: "EXIT",
          exit_reason_code: "take_profit_exit",
          exit_rule_id: "take_profit",
        },
      });

      expect(
        validateExecutionSubmission(
          createSubmission({
            intent,
            costSnapshot: {
              source: "exit_cost_model",
              exit_cost_allowed: true,
              exit_cost_reason_code: "exit_cost_margin_ok",
              exit_cost_bps: "5",
              exit_slippage_bps: "2",
              position_scope: {
                market: "KRW-BTC",
                strategy_id: "trend_following",
                total_quantity: "0.01",
              },
            },
          }),
        ),
      ).toMatchObject({
        valid: false,
        rejection: {
          reasonCode: "exit_sell_quantity_exceeds_position",
          metadata: {
            requested_quantity: "0.02",
            open_position_quantity: "0.01",
          },
        },
      });
    });
  });

  it("does not import strategy, Upbit, runtime, or DB implementations", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src", "application", "execution", "execution-engine.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/from\s+["'][^"']*(strategy|upbit|runtime|infrastructure\/db)/iu);
  });
});

function createBrokerPort() {
  const submitOrder = vi.fn(async (submission: OrderSubmission): Promise<BrokerOrder> => {
    const brokerOrder: BrokerOrder = {
      brokerOrderId: "paper-order-1",
      idempotencyKey: submission.intent.idempotencyKey,
      exchangeId: submission.intent.exchangeId,
      market: submission.intent.market,
      side: submission.intent.side,
      orderType: submission.intent.orderType,
      status: "SUBMITTED",
      requestedQuantity: submission.intent.requestedQuantity,
      remainingQuantity: submission.intent.requestedQuantity,
      updatedAt: observedAt,
    };

    if (submission.intent.orderType === "LIMIT") {
      return {
        ...brokerOrder,
        requestedPrice: submission.intent.requestedPrice,
      };
    }

    return brokerOrder;
  });

  const broker: BrokerPort = {
    submitOrder,
    cancelOrder: async (orderId: string): Promise<BrokerOrder> => ({
      brokerOrderId: orderId,
      idempotencyKey: "execution-candidate-1",
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      side: "BUY",
      orderType: "LIMIT",
      status: "CANCELED",
      requestedQuantity: "0.0005",
      remainingQuantity: "0",
      requestedPrice: "10000000",
      updatedAt: observedAt,
    }),
    getOrder: async () => undefined,
    listOpenOrders: async () => [],
    getBalances: async () => ({
      exchangeId: "upbit_krw_spot",
      balances: [],
      capturedAt: observedAt,
    }),
  };

  return {
    submitOrder,
    broker,
  };
}

function createSubmission(overrides: CreateSubmissionOverrides = {}): OrderSubmission {
  const intent = overrides.intent ?? createLimitIntent();
  const hasExpectedLossOverride = Object.prototype.hasOwnProperty.call(
    overrides,
    "expectedLossBpsOfEquity",
  );
  const expectedLossBpsOfEquity = hasExpectedLossOverride ? overrides.expectedLossBpsOfEquity : "10";
  const submission: OrderSubmission = {
    intent,
    costSnapshot: createCostSnapshot(intent, expectedLossBpsOfEquity, !hasExpectedLossOverride),
    riskApproval: createRiskApprovalEvidence(intent, expectedLossBpsOfEquity, !hasExpectedLossOverride),
    submittedAt: observedAt,
  };
  if (expectedLossBpsOfEquity !== undefined) {
    submission.expectedLossBpsOfEquity = expectedLossBpsOfEquity;
  }

  const { expectedLossBpsOfEquity: _expectedLossOverride, ...otherOverrides } = overrides;
  return {
    ...submission,
    ...otherOverrides,
  };
}

function createCostSnapshot(
  intent: OrderIntent,
  expectedLossBpsOfEquity?: string,
  useDefaultExpectedLoss = true,
): OrderSubmission["costSnapshot"] {
  const resolvedExpectedLossBpsOfEquity =
    expectedLossBpsOfEquity ?? (useDefaultExpectedLoss ? "10" : undefined);

  return createExecutionCostSnapshotEvidence(
    evaluateCost({
      exchangeId: intent.exchangeId,
      market: intent.market,
      expectedReturnBps: "30",
      entryFeeBps: "5",
      exitFeeBps: "5",
      spreadCostBpsP75: "1",
      expectedSlippageBpsP95: "1",
      cancelRequotePenaltyBps: "0.5",
    }).snapshot,
    intent,
    resolvedExpectedLossBpsOfEquity,
  );
}

function createRiskApprovalEvidence(
  intent: OrderIntent,
  expectedLossBpsOfEquity?: string,
  useDefaultExpectedLoss = true,
): ExecutionRiskApprovalEvidence {
  const resolvedExpectedLossBpsOfEquity =
    expectedLossBpsOfEquity ?? (useDefaultExpectedLoss ? "10" : undefined);
  const riskContext = createRiskContext(intent, resolvedExpectedLossBpsOfEquity);
  return createExecutionRiskApprovalEvidence(evaluateRiskGate(riskContext), riskContext);
}

function createRiskContext(
  intent: OrderIntent,
  expectedLossBpsOfEquity?: string,
): RiskGateContext {
  const context: RiskGateContext = {
    orderIntent: intent,
    account: {
      equityKrw: "1000000",
      dailyRealizedPnlBps: "-10",
      weeklyRealizedPnlBps: "-20",
      maxDrawdownBps: "100",
      capturedAt: observedAt,
    },
    positions: [],
    strategy: {
      strategyId: intent.strategyId,
      consecutiveLosses: 0,
      capturedAt: observedAt,
    },
    infrastructureSignals: [],
    thresholdSnapshot,
    observedAt,
  };
  if (expectedLossBpsOfEquity !== undefined) {
    context.expectedLossBpsOfEquity = expectedLossBpsOfEquity;
  }

  return context;
}

function createLimitIntent(overrides: Partial<Extract<OrderIntent, { orderType: "LIMIT" }>> = {}): Extract<
  OrderIntent,
  { orderType: "LIMIT" }
> {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "BUY",
    orderType: "LIMIT",
    requestedPrice: "10000000",
    requestedQuantity: "0.0005",
    requestedNotional: "5000",
    idempotencyKey: "execution-candidate-1",
    reason: "unit-test",
    ...overrides,
  };
}

function createMarketIntent(overrides: Partial<MarketOrderIntent> = {}): MarketOrderIntent {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "BUY",
    orderType: "MARKET",
    requestedQuantity: "0.0005",
    requestedNotional: "5000",
    idempotencyKey: "execution-market-candidate-1",
    reason: "unit-test-market",
    ...overrides,
  };
}

function createSellLimitIntent(overrides: Partial<Extract<OrderIntent, { orderType: "LIMIT" }>> = {}): Extract<
  OrderIntent,
  { orderType: "LIMIT" }
> {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "SELL",
    orderType: "LIMIT",
    requestedPrice: "10000000",
    requestedQuantity: "0.0005",
    requestedNotional: "5000",
    idempotencyKey: "exit-candidate-1",
    reason: "unit-test-exit",
    ...overrides,
  };
}

function createExitCostSnapshot(intent: OrderIntent): OrderSubmission["costSnapshot"] {
  return {
    source: "exit_cost_model",
    exit_cost_allowed: true,
    exit_cost_reason_code: "exit_cost_margin_ok",
    exit_cost_bps: "5",
    exit_slippage_bps: "2",
    position_scope: {
      market: intent.market,
      strategy_id: intent.strategyId,
      total_quantity: "0.01",
    },
  };
}
