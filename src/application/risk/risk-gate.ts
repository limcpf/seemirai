import { Decimal } from "decimal.js";
import type {
  InfrastructureRiskSnapshot,
  JsonRecord,
  MarketCode,
  OrderIntent,
  PositionRiskSnapshot,
  RiskBlockAction,
  RiskEvaluationStatus,
  RiskEventSeverity,
  RiskGateContext,
  RiskGateEvaluation,
  RiskGateResult,
  RiskLimitThresholds,
  RiskThresholdSnapshot,
} from "../../domain/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";

interface ParsedThresholds {
  dailyLossLimitBps: Decimal;
  weeklyLossLimitBps: Decimal;
  maxDrawdownBps: Decimal;
  maxOrderNotionalBpsOfEquity: Decimal;
  maxExpectedLossBpsOfEquity: Decimal;
  btcEthMaxPositionBpsOfEquity: Decimal;
  altMaxPositionBpsOfEquity: Decimal;
  totalAltMaxPositionBpsOfEquity: Decimal;
  maxConsecutiveStrategyLosses: number;
}

interface DecimalRead {
  value: Decimal | undefined;
  evaluation?: RiskGateEvaluation;
}

interface EvaluationInput {
  status: RiskEvaluationStatus;
  reasonCode: string;
  message: string;
  severity: RiskEventSeverity;
  action: RiskBlockAction;
  thresholdSnapshot?: RiskThresholdSnapshot;
  metadata?: JsonRecord;
}

interface MarketExposure {
  market: MarketCode;
  bpsOfEquity: Decimal;
}

/**
 * M5 RiskGate의 손실, 노출, 인프라 장애 한도를 순수 함수로 평가한다.
 *
 * 이 evaluator는 DB나 broker를 호출하지 않고 전달받은 snapshot만 사용한다. runtime 연결과 persistence append는
 * 후속 Sub PR에서 같은 결과 payload를 사용해 붙인다.
 */
export function evaluateRiskGate(context: RiskGateContext): RiskGateResult {
  const thresholds = parseThresholds(context.thresholdSnapshot.thresholds);
  const evaluations: RiskGateEvaluation[] = [];

  evaluations.push(...evaluateLossLimits(context, thresholds));

  const equity = readPositiveDecimal(context.account.equityKrw, "account.equity_krw", {
    reasonCode: "account_equity_invalid",
    message: "Account equity must be greater than zero before RiskGate evaluation",
  });
  if (equity.evaluation !== undefined) {
    evaluations.push(equity.evaluation);
  }

  const orderNotionalBps =
    equity.value === undefined
      ? undefined
      : calculateOrderNotionalBps(context.orderIntent, equity.value, context.thresholdSnapshot);

  if (orderNotionalBps?.evaluation !== undefined) {
    evaluations.push(orderNotionalBps.evaluation);
  }
  if (orderNotionalBps?.value !== undefined) {
    evaluations.push(evaluateOrderNotionalLimit(context, thresholds, orderNotionalBps.value));
    evaluations.push(...evaluatePositionExposureLimits(context, thresholds, orderNotionalBps.value));
  }

  evaluations.push(evaluateExpectedLossLimit(context, thresholds));
  evaluations.push(evaluateConsecutiveStrategyLosses(context, thresholds));
  evaluations.push(...evaluateInfrastructureSignals(context.infrastructureSignals));

  return createRiskGateResult(evaluations, context.thresholdSnapshot);
}

/**
 * 계정 손실 한도와 MDD 한도를 평가한다.
 */
function evaluateLossLimits(
  context: RiskGateContext,
  thresholds: ParsedThresholds,
): RiskGateEvaluation[] {
  const evaluations: RiskGateEvaluation[] = [];
  const dailyLossBps = readDecimal(context.account.dailyRealizedPnlBps, "account.daily_realized_pnl_bps", {
    reasonCode: "daily_loss_bps_invalid",
    message: "Daily realized PnL bps must be a finite decimal string",
  });
  const weeklyLossBps = readDecimal(context.account.weeklyRealizedPnlBps, "account.weekly_realized_pnl_bps", {
    reasonCode: "weekly_loss_bps_invalid",
    message: "Weekly realized PnL bps must be a finite decimal string",
  });
  const maxDrawdownBps = readNonNegativeDecimal(context.account.maxDrawdownBps, "account.max_drawdown_bps", {
    reasonCode: "max_drawdown_bps_invalid",
    message: "Max drawdown bps must be a non-negative decimal string",
  });

  appendReadEvaluation(evaluations, dailyLossBps);
  appendReadEvaluation(evaluations, weeklyLossBps);
  appendReadEvaluation(evaluations, maxDrawdownBps);

  if (dailyLossBps.value !== undefined) {
    evaluations.push(
      dailyLossBps.value.lessThanOrEqualTo(thresholds.dailyLossLimitBps.negated())
        ? fail("daily_loss_limit_exceeded", "Daily loss limit is reached", "BLOCK_NEW_ORDER", {
            daily_realized_pnl_bps: dailyLossBps.value.toFixed(),
            threshold_bps: thresholds.dailyLossLimitBps.toFixed(),
          })
        : pass("daily_loss_limit_clear", "Daily loss limit is clear", {
            daily_realized_pnl_bps: dailyLossBps.value.toFixed(),
            threshold_bps: thresholds.dailyLossLimitBps.toFixed(),
          }),
    );
  }

  if (weeklyLossBps.value !== undefined) {
    evaluations.push(
      weeklyLossBps.value.lessThanOrEqualTo(thresholds.weeklyLossLimitBps.negated())
        ? fail("weekly_loss_limit_exceeded", "Weekly loss limit is reached", "BLOCK_NEW_ORDER", {
            weekly_realized_pnl_bps: weeklyLossBps.value.toFixed(),
            threshold_bps: thresholds.weeklyLossLimitBps.toFixed(),
          })
        : pass("weekly_loss_limit_clear", "Weekly loss limit is clear", {
            weekly_realized_pnl_bps: weeklyLossBps.value.toFixed(),
            threshold_bps: thresholds.weeklyLossLimitBps.toFixed(),
          }),
    );
  }

  if (maxDrawdownBps.value !== undefined) {
    evaluations.push(
      maxDrawdownBps.value.greaterThanOrEqualTo(thresholds.maxDrawdownBps)
        ? fail("max_drawdown_limit_exceeded", "Max drawdown limit is reached", "BLOCK_NEW_ORDER", {
            max_drawdown_bps: maxDrawdownBps.value.toFixed(),
            threshold_bps: thresholds.maxDrawdownBps.toFixed(),
          })
        : pass("max_drawdown_limit_clear", "Max drawdown limit is clear", {
            max_drawdown_bps: maxDrawdownBps.value.toFixed(),
            threshold_bps: thresholds.maxDrawdownBps.toFixed(),
          }),
    );
  }

  return withThresholdSnapshots(evaluations, context.thresholdSnapshot);
}

/**
 * 단일 주문 금액이 계정 평가액 대비 1%를 초과하는지 평가한다.
 */
function evaluateOrderNotionalLimit(
  context: RiskGateContext,
  thresholds: ParsedThresholds,
  orderNotionalBps: Decimal,
): RiskGateEvaluation {
  return withThresholdSnapshot(
    orderNotionalBps.greaterThan(thresholds.maxOrderNotionalBpsOfEquity)
      ? fail("order_notional_limit_exceeded", "Order notional exceeds the account equity limit", "BLOCK_NEW_ORDER", {
          order_notional_bps_of_equity: orderNotionalBps.toFixed(),
          requested_notional_krw: context.orderIntent.requestedNotional,
          threshold_bps: thresholds.maxOrderNotionalBpsOfEquity.toFixed(),
        })
      : pass("order_notional_limit_clear", "Order notional is within the account equity limit", {
          order_notional_bps_of_equity: orderNotionalBps.toFixed(),
          requested_notional_krw: context.orderIntent.requestedNotional,
          threshold_bps: thresholds.maxOrderNotionalBpsOfEquity.toFixed(),
        }),
    context.thresholdSnapshot,
  );
}

/**
 * 단일 주문 예상 손실이 계정 평가액 대비 0.2%를 초과하는지 평가한다.
 */
function evaluateExpectedLossLimit(
  context: RiskGateContext,
  thresholds: ParsedThresholds,
): RiskGateEvaluation {
  const expectedLoss = readExpectedLossBpsOfEquity(context);

  if (expectedLoss.evaluation !== undefined) {
    return withThresholdSnapshot(expectedLoss.evaluation, context.thresholdSnapshot);
  }

  if (expectedLoss.value === undefined) {
    // 예상 손실을 모르는 주문은 손실 한도 검증을 우회할 수 있으므로 승인하지 않는다.
    return withThresholdSnapshot(
      fail("expected_loss_missing", "Expected loss bps is required before RiskGate approval", "BLOCK_NEW_ORDER"),
      context.thresholdSnapshot,
    );
  }

  return withThresholdSnapshot(
    expectedLoss.value.greaterThan(thresholds.maxExpectedLossBpsOfEquity)
      ? fail("expected_loss_limit_exceeded", "Expected loss exceeds the account equity limit", "BLOCK_NEW_ORDER", {
          expected_loss_bps_of_equity: expectedLoss.value.toFixed(),
          threshold_bps: thresholds.maxExpectedLossBpsOfEquity.toFixed(),
        })
      : pass("expected_loss_limit_clear", "Expected loss is within the account equity limit", {
          expected_loss_bps_of_equity: expectedLoss.value.toFixed(),
          threshold_bps: thresholds.maxExpectedLossBpsOfEquity.toFixed(),
        }),
    context.thresholdSnapshot,
  );
}

/**
 * 현재 포지션과 주문 후보 반영 후의 시장별 예상 노출을 기준으로 포지션 한도를 평가한다.
 *
 * 이미 초과한 비대상 시장도 신규 주문으로 숨길 수 없도록 모든 보유 시장을 평가하고, SELL은 실제 보유 노출까지만
 * 차감해 총 노출 한도 우회를 막는다.
 */
function evaluatePositionExposureLimits(
  context: RiskGateContext,
  thresholds: ParsedThresholds,
  orderNotionalBps: Decimal,
): RiskGateEvaluation[] {
  const positionReads = context.positions.map((position) => readPositionBps(position));
  const invalidPositionEvaluations = positionReads.flatMap((read) =>
    read.evaluation === undefined ? [] : [read.evaluation],
  );
  if (invalidPositionEvaluations.length > 0) {
    // 포지션 snapshot이 깨지면 예상 노출을 신뢰할 수 없으므로 한도 평가 대신 수동 검토로 보낸다.
    return invalidPositionEvaluations.map((evaluation) =>
      withThresholdSnapshot(evaluation, context.thresholdSnapshot),
    );
  }

  const targetMarket = context.orderIntent.market;
  const currentExposureByMarket = createCurrentExposureByMarket(positionReads);
  const currentTargetExposureBps = currentExposureByMarket.get(targetMarket) ?? new Decimal(0);
  const candidateExposureDeltaBps = calculateCandidateExposureDeltaBps(
    context.orderIntent.side,
    orderNotionalBps,
    currentTargetExposureBps,
  );
  const projectedTargetExposureBps = clampAtZero(currentTargetExposureBps.plus(candidateExposureDeltaBps));
  const projectedExposures = createProjectedExposures(
    currentExposureByMarket,
    targetMarket,
    projectedTargetExposureBps,
  );

  return [
    ...evaluateBtcEthExposureLimit(context, thresholds, projectedExposures, {
      targetMarket,
      currentTargetExposureBps,
      candidateExposureDeltaBps,
      projectedTargetExposureBps,
    }),
    ...evaluateAltExposureLimits(context, thresholds, projectedExposures, {
      targetMarket,
      currentTargetExposureBps,
      candidateExposureDeltaBps,
      projectedTargetExposureBps,
    }),
  ];
}

/**
 * BTC/ETH 단일 포지션 한도를 모든 예상 시장 노출에 대해 평가한다.
 *
 * target market만 보지 않고 기존 BTC/ETH 보유분도 함께 검사해, 초과 상태에서 다른 시장 주문으로 우회하지 못하게 한다.
 */
function evaluateBtcEthExposureLimit(
  context: RiskGateContext,
  thresholds: ParsedThresholds,
  projectedExposures: readonly MarketExposure[],
  target: {
    targetMarket: MarketCode;
    currentTargetExposureBps: Decimal;
    candidateExposureDeltaBps: Decimal;
    projectedTargetExposureBps: Decimal;
  },
): RiskGateEvaluation[] {
  const breaches = projectedExposures.filter(
    (exposure) =>
      isBtcOrEthMarket(exposure.market) &&
      exposure.bpsOfEquity.greaterThan(thresholds.btcEthMaxPositionBpsOfEquity),
  );

  if (breaches.length > 0) {
    // 비대상 BTC/ETH라도 이미 한도를 넘으면 신규 주문을 차단해 복구 우선 순위를 유지한다.
    return [
      withThresholdSnapshot(
        fail("btc_eth_position_limit_exceeded", "BTC/ETH position exposure exceeds the configured limit", "BLOCK_NEW_ORDER", {
          target_market: target.targetMarket,
          current_target_position_bps_of_equity: target.currentTargetExposureBps.toFixed(),
          candidate_exposure_delta_bps_of_equity: target.candidateExposureDeltaBps.toFixed(),
          projected_target_position_bps_of_equity: target.projectedTargetExposureBps.toFixed(),
          threshold_bps: thresholds.btcEthMaxPositionBpsOfEquity.toFixed(),
          breached_markets: toExposureMetadata(breaches),
        }),
        context.thresholdSnapshot,
      ),
    ];
  }

  if (!isBtcOrEthMarket(target.targetMarket)) {
    return [];
  }

  return [
    withThresholdSnapshot(
      pass("btc_eth_position_limit_clear", "BTC/ETH position exposure is within the configured limit", {
        market: target.targetMarket,
        projected_position_bps_of_equity: target.projectedTargetExposureBps.toFixed(),
        threshold_bps: thresholds.btcEthMaxPositionBpsOfEquity.toFixed(),
      }),
      context.thresholdSnapshot,
    ),
  ];
}

/**
 * 알트 단일 포지션과 전체 알트 노출 한도를 모든 예상 시장 노출에 대해 평가한다.
 *
 * 전체 알트 합산은 target SELL을 실제 보유분까지만 차감한 예상 노출을 사용해 과도한 SELL notional로 한도를 우회하지
 * 못하게 한다.
 */
function evaluateAltExposureLimits(
  context: RiskGateContext,
  thresholds: ParsedThresholds,
  projectedExposures: readonly MarketExposure[],
  target: {
    targetMarket: MarketCode;
    currentTargetExposureBps: Decimal;
    candidateExposureDeltaBps: Decimal;
    projectedTargetExposureBps: Decimal;
  },
): RiskGateEvaluation[] {
  const evaluations: RiskGateEvaluation[] = [];
  const singleAltBreaches = projectedExposures.filter(
    (exposure) =>
      isAltMarket(exposure.market) &&
      exposure.bpsOfEquity.greaterThan(thresholds.altMaxPositionBpsOfEquity),
  );
  const projectedTotalAltExposureBps = projectedExposures.reduce(
    (sum, exposure) => (isAltMarket(exposure.market) ? sum.plus(exposure.bpsOfEquity) : sum),
    new Decimal(0),
  );

  if (singleAltBreaches.length > 0) {
    // 알트 단일 초과는 target 여부와 무관하게 전체 신규 주문 차단 조건으로 취급한다.
    evaluations.push(
      withThresholdSnapshot(
        fail("single_alt_position_limit_exceeded", "Single alt position exposure exceeds the configured limit", "BLOCK_NEW_ORDER", {
          target_market: target.targetMarket,
          current_target_position_bps_of_equity: target.currentTargetExposureBps.toFixed(),
          candidate_exposure_delta_bps_of_equity: target.candidateExposureDeltaBps.toFixed(),
          projected_target_position_bps_of_equity: target.projectedTargetExposureBps.toFixed(),
          threshold_bps: thresholds.altMaxPositionBpsOfEquity.toFixed(),
          breached_markets: toExposureMetadata(singleAltBreaches),
        }),
        context.thresholdSnapshot,
      ),
    );
  } else if (isAltMarket(target.targetMarket)) {
    evaluations.push(
      withThresholdSnapshot(
        pass("single_alt_position_limit_clear", "Single alt position exposure is within the configured limit", {
          market: target.targetMarket,
          projected_position_bps_of_equity: target.projectedTargetExposureBps.toFixed(),
          threshold_bps: thresholds.altMaxPositionBpsOfEquity.toFixed(),
        }),
        context.thresholdSnapshot,
      ),
    );
  }

  evaluations.push(
    withThresholdSnapshot(
      projectedTotalAltExposureBps.greaterThan(thresholds.totalAltMaxPositionBpsOfEquity)
        ? fail("total_alt_position_limit_exceeded", "Total alt position exposure exceeds the configured limit", "BLOCK_NEW_ORDER", {
            target_market: target.targetMarket,
            projected_total_alt_position_bps_of_equity: projectedTotalAltExposureBps.toFixed(),
            threshold_bps: thresholds.totalAltMaxPositionBpsOfEquity.toFixed(),
          })
        : pass("total_alt_position_limit_clear", "Total alt position exposure is within the configured limit", {
            target_market: target.targetMarket,
            projected_total_alt_position_bps_of_equity: projectedTotalAltExposureBps.toFixed(),
            threshold_bps: thresholds.totalAltMaxPositionBpsOfEquity.toFixed(),
          }),
      context.thresholdSnapshot,
    ),
  );

  return evaluations;
}

/**
 * 동일 strategy의 연속 손실 중지 기준을 평가한다.
 */
function evaluateConsecutiveStrategyLosses(
  context: RiskGateContext,
  thresholds: ParsedThresholds,
): RiskGateEvaluation {
  if (!Number.isSafeInteger(context.strategy.consecutiveLosses) || context.strategy.consecutiveLosses < 0) {
    return withThresholdSnapshot(
      fail("consecutive_strategy_losses_invalid", "Consecutive strategy losses must be a non-negative safe integer", "MANUAL_REVIEW_REQUIRED"),
      context.thresholdSnapshot,
    );
  }

  return withThresholdSnapshot(
    context.strategy.consecutiveLosses >= thresholds.maxConsecutiveStrategyLosses
      ? fail("consecutive_strategy_loss_limit_exceeded", "Consecutive strategy loss limit is reached", "PAUSE_STRATEGY", {
          strategy_id: context.strategy.strategyId,
          consecutive_losses: context.strategy.consecutiveLosses,
          threshold_count: thresholds.maxConsecutiveStrategyLosses,
        })
      : pass("consecutive_strategy_loss_limit_clear", "Consecutive strategy loss limit is clear", {
          strategy_id: context.strategy.strategyId,
          consecutive_losses: context.strategy.consecutiveLosses,
          threshold_count: thresholds.maxConsecutiveStrategyLosses,
        }),
    context.thresholdSnapshot,
  );
}

/**
 * market data, DB, idempotency 같은 인프라 차단 신호를 RiskGate 평가로 변환한다.
 */
function evaluateInfrastructureSignals(
  signals: readonly InfrastructureRiskSnapshot[],
): RiskGateEvaluation[] {
  if (signals.length === 0) {
    return [pass("infrastructure_signals_clear", "No infrastructure risk signal is active")];
  }

  return signals.map((signal) => {
    const metadata = createInfrastructureSignalMetadata(signal);

    // DB write/idempotency 위반은 상태 복구 전 재주문 위험이 커서 가장 강한 HARD_STOP으로 수렴한다.
    switch (signal.signal) {
      case "STALE_MARKET_DATA":
        return fail("stale_market_data", "Stale market data blocks new orders", "BLOCK_NEW_ORDER", metadata);
      case "WEBSOCKET_DISCONNECTED":
        return fail("websocket_disconnected", "Disconnected WebSocket blocks new orders", "BLOCK_NEW_ORDER", metadata);
      case "WEBSOCKET_RECONNECTING":
        return fail("websocket_reconnecting", "Reconnecting WebSocket blocks new orders", "BLOCK_NEW_ORDER", metadata);
      case "DB_WRITE_FAILURE":
        return fail("db_write_failure", "Database write failure triggers hard stop", "HARD_STOP", metadata);
      case "DUPLICATE_ORDER_IDEMPOTENCY_KEY":
        return fail("duplicate_order_idempotency_key", "Duplicate order idempotency key triggers hard stop", "HARD_STOP", metadata);
      case "BALANCE_POSITION_MISMATCH":
        return fail("balance_position_mismatch", "Balance/position mismatch requires manual review", "MANUAL_REVIEW_REQUIRED", metadata);
      case "NOTIFICATION_FAILURE":
        return warn("notification_failure", "Notification failure is audited but does not block RiskGate approval", metadata);
    }
  });
}

function calculateOrderNotionalBps(
  orderIntent: OrderIntent,
  equityKrw: Decimal,
  thresholdSnapshot: RiskThresholdSnapshot,
): DecimalRead {
  const requestedNotional = readPositiveDecimal(orderIntent.requestedNotional, "order_intent.requested_notional", {
    reasonCode: "order_notional_invalid",
    message: "Order requested notional must be a positive decimal string",
  });
  if (requestedNotional.evaluation !== undefined) {
    return {
      evaluation: withThresholdSnapshot(requestedNotional.evaluation, thresholdSnapshot),
      value: undefined,
    };
  }
  if (requestedNotional.value === undefined) {
    return {
      value: undefined,
    };
  }

  const canonicalNotional = readCanonicalOrderNotional(orderIntent, requestedNotional.value, thresholdSnapshot);
  if (canonicalNotional.evaluation !== undefined || canonicalNotional.value === undefined) {
    return canonicalNotional;
  }

  // 계정 평가액 대비 주문 크기를 bps로 환산해 설정 threshold와 같은 단위로 비교한다.
  return {
    value: canonicalNotional.value.dividedBy(equityKrw).times(10000),
  };
}

function readCanonicalOrderNotional(
  orderIntent: OrderIntent,
  requestedNotional: Decimal,
  thresholdSnapshot: RiskThresholdSnapshot,
): DecimalRead {
  if (orderIntent.orderType !== "LIMIT") {
    return {
      value: requestedNotional,
    };
  }

  const requestedPrice = readPositiveDecimal(orderIntent.requestedPrice, "order_intent.requested_price", {
    reasonCode: "order_price_invalid",
    message: "Limit order requested price must be a positive decimal string",
  });
  if (requestedPrice.evaluation !== undefined) {
    return {
      evaluation: withThresholdSnapshot(requestedPrice.evaluation, thresholdSnapshot),
      value: undefined,
    };
  }
  if (requestedPrice.value === undefined) {
    return {
      value: undefined,
    };
  }

  const requestedQuantity = readPositiveDecimal(orderIntent.requestedQuantity, "order_intent.requested_quantity", {
    reasonCode: "order_quantity_invalid",
    message: "Limit order requested quantity must be a positive decimal string",
  });
  if (requestedQuantity.evaluation !== undefined) {
    return {
      evaluation: withThresholdSnapshot(requestedQuantity.evaluation, thresholdSnapshot),
      value: undefined,
    };
  }
  if (requestedQuantity.value === undefined) {
    return {
      value: undefined,
    };
  }

  const calculatedNotional = requestedPrice.value.times(requestedQuantity.value);

  if (!calculatedNotional.equals(requestedNotional)) {
    // LIMIT 주문은 broker가 가격과 수량으로 제출하므로 notional 불일치를 한도 우회로 보아 차단한다.
    return {
      evaluation: withThresholdSnapshot(
        fail("order_notional_mismatch", "Limit order requested notional must equal price multiplied by quantity", "BLOCK_NEW_ORDER", {
          requested_notional_krw: requestedNotional.toFixed(),
          calculated_notional_krw: calculatedNotional.toFixed(),
          requested_price: requestedPrice.value.toFixed(),
          requested_quantity: requestedQuantity.value.toFixed(),
        }),
        thresholdSnapshot,
      ),
      value: undefined,
    };
  }

  return {
    value: calculatedNotional,
  };
}

function readExpectedLossBpsOfEquity(context: RiskGateContext): DecimalRead {
  const metadataValue =
    context.orderIntent.metadata?.expected_loss_bps_of_equity ??
    context.orderIntent.metadata?.expectedLossBpsOfEquity;
  const value = context.expectedLossBpsOfEquity ?? metadataValue;

  if (value === undefined || value === null) {
    return {
      value: undefined,
    };
  }

  return readNonNegativeDecimal(value, "risk_gate.expected_loss_bps_of_equity", {
    reasonCode: "expected_loss_bps_invalid",
    message: "Expected loss bps must be a non-negative decimal string",
  });
}

function readPositionBps(position: PositionRiskSnapshot): DecimalRead & { market: MarketCode } {
  const metadata: JsonRecord = {
    market: position.market,
  };
  assignIfDefined(metadata, "strategy_id", position.strategyId);
  const read = readNonNegativeDecimal(position.notionalBpsOfEquity, "position.notional_bps_of_equity", {
    reasonCode: "position_notional_bps_invalid",
    message: "Position notional bps must be a non-negative decimal string",
    metadata,
  });

  return {
    ...read,
    market: position.market,
  };
}

function readDecimal(
  value: unknown,
  fieldName: string,
  error: { reasonCode: string; message: string; metadata?: JsonRecord },
): DecimalRead {
  try {
    return {
      value: parseFinancialDecimal(value),
    };
  } catch {
    return {
      value: undefined,
      evaluation: fail(error.reasonCode, error.message, "MANUAL_REVIEW_REQUIRED", {
        field_name: fieldName,
        ...(error.metadata ?? {}),
      }),
    };
  }
}

function readNonNegativeDecimal(
  value: unknown,
  fieldName: string,
  error: { reasonCode: string; message: string; metadata?: JsonRecord },
): DecimalRead {
  const read = readDecimal(value, fieldName, error);
  if (read.value === undefined || read.evaluation !== undefined) {
    return read;
  }

  if (read.value.isNegative()) {
    return {
      value: undefined,
      evaluation: fail(error.reasonCode, error.message, "MANUAL_REVIEW_REQUIRED", {
        field_name: fieldName,
        ...(error.metadata ?? {}),
      }),
    };
  }

  return read;
}

function readPositiveDecimal(
  value: unknown,
  fieldName: string,
  error: { reasonCode: string; message: string; metadata?: JsonRecord },
): DecimalRead {
  const read = readNonNegativeDecimal(value, fieldName, error);
  if (read.value === undefined || read.evaluation !== undefined) {
    return read;
  }

  if (read.value.isZero()) {
    return {
      value: undefined,
      evaluation: fail(error.reasonCode, error.message, "MANUAL_REVIEW_REQUIRED", {
        field_name: fieldName,
        ...(error.metadata ?? {}),
      }),
    };
  }

  return read;
}

function appendReadEvaluation(evaluations: RiskGateEvaluation[], read: DecimalRead): void {
  if (read.evaluation !== undefined) {
    evaluations.push(read.evaluation);
  }
}

/**
 * position snapshot을 시장별 bps 맵으로 합산한다.
 *
 * 같은 market의 여러 전략 포지션이 들어와도 RiskGate 포지션 한도는 market 단위 exposure로 평가한다.
 */
function createCurrentExposureByMarket(
  positionReads: readonly (DecimalRead & { market: MarketCode })[],
): ReadonlyMap<MarketCode, Decimal> {
  const exposures = new Map<MarketCode, Decimal>();

  for (const position of positionReads) {
    if (position.value === undefined) {
      continue;
    }

    exposures.set(position.market, (exposures.get(position.market) ?? new Decimal(0)).plus(position.value));
  }

  return exposures;
}

/**
 * 주문 방향과 현재 target 노출을 기준으로 예상 노출 변화량을 계산한다.
 *
 * BUY는 주문 금액 전체를 더하고, SELL은 현재 보유분보다 더 많이 줄였다고 보지 않는다.
 */
function calculateCandidateExposureDeltaBps(
  side: OrderIntent["side"],
  orderNotionalBps: Decimal,
  currentTargetExposureBps: Decimal,
): Decimal {
  if (side === "BUY") {
    return orderNotionalBps;
  }

  // SELL 주문 금액이 보유분을 초과해도 실제 포지션 감소분은 현재 target 노출로 제한한다.
  return Decimal.min(orderNotionalBps, currentTargetExposureBps).negated();
}

/**
 * 현재 노출 맵에 target 시장의 예상 노출을 반영해 평가용 배열로 변환한다.
 *
 * target이 신규 시장이거나 전량 SELL로 0이 되더라도 pass/fail metadata가 같은 기준을 쓰도록 target 항목은 유지한다.
 */
function createProjectedExposures(
  currentExposureByMarket: ReadonlyMap<MarketCode, Decimal>,
  targetMarket: MarketCode,
  projectedTargetExposureBps: Decimal,
): MarketExposure[] {
  const projectedExposureByMarket = new Map(currentExposureByMarket);

  projectedExposureByMarket.set(targetMarket, projectedTargetExposureBps);

  return [...projectedExposureByMarket.entries()].map(([market, bpsOfEquity]) => ({
    market,
    bpsOfEquity,
  }));
}

function toExposureMetadata(exposures: readonly MarketExposure[]): JsonRecord[] {
  return exposures.map((exposure) => ({
    market: exposure.market,
    bps_of_equity: exposure.bpsOfEquity.toFixed(),
  }));
}

function clampAtZero(value: Decimal): Decimal {
  return value.isNegative() ? new Decimal(0) : value;
}

function parseThresholds(thresholds: RiskLimitThresholds): ParsedThresholds {
  return {
    dailyLossLimitBps: parseNonNegativeThreshold(thresholds.dailyLossLimitBps, "daily_loss_limit_bps"),
    weeklyLossLimitBps: parseNonNegativeThreshold(thresholds.weeklyLossLimitBps, "weekly_loss_limit_bps"),
    maxDrawdownBps: parseNonNegativeThreshold(thresholds.maxDrawdownBps, "max_drawdown_bps"),
    maxOrderNotionalBpsOfEquity: parseNonNegativeThreshold(
      thresholds.maxOrderNotionalBpsOfEquity,
      "max_order_notional_bps_of_equity",
    ),
    maxExpectedLossBpsOfEquity: parseNonNegativeThreshold(
      thresholds.maxExpectedLossBpsOfEquity,
      "max_expected_loss_bps_of_equity",
    ),
    btcEthMaxPositionBpsOfEquity: parseNonNegativeThreshold(
      thresholds.btcEthMaxPositionBpsOfEquity,
      "btc_eth_max_position_bps_of_equity",
    ),
    altMaxPositionBpsOfEquity: parseNonNegativeThreshold(
      thresholds.altMaxPositionBpsOfEquity,
      "alt_max_position_bps_of_equity",
    ),
    totalAltMaxPositionBpsOfEquity: parseNonNegativeThreshold(
      thresholds.totalAltMaxPositionBpsOfEquity,
      "total_alt_max_position_bps_of_equity",
    ),
    maxConsecutiveStrategyLosses: thresholds.maxConsecutiveStrategyLosses,
  };
}

function parseNonNegativeThreshold(value: string, fieldName: string): Decimal {
  const decimal = parseFinancialDecimal(value);

  if (decimal.isNegative()) {
    throw new Error(`${fieldName} must not be negative`);
  }

  return decimal;
}

function createRiskGateResult(
  evaluations: readonly RiskGateEvaluation[],
  thresholdSnapshot: RiskThresholdSnapshot,
): RiskGateResult {
  const failedEvaluations = evaluations.filter((evaluation) => evaluation.status === "FAIL");
  const warningEvaluations = evaluations.filter((evaluation) => evaluation.status === "WARN");
  const action = selectMostRestrictiveAction(evaluations);
  const status: RiskEvaluationStatus =
    failedEvaluations.length > 0 ? "FAIL" : warningEvaluations.length > 0 ? "WARN" : "PASS";

  return {
    status,
    approved: failedEvaluations.length === 0 && action === "ALLOW",
    action,
    evaluations,
    failedEvaluations,
    warningEvaluations,
    thresholdSnapshot,
  };
}

function selectMostRestrictiveAction(evaluations: readonly RiskGateEvaluation[]): RiskBlockAction {
  return evaluations.reduce<RiskBlockAction>((selected, evaluation) => {
    // 여러 위반이 동시에 발생하면 운영 복구 비용이 가장 큰 action을 전체 결과로 선택한다.
    return actionPriority[evaluation.action] > actionPriority[selected] ? evaluation.action : selected;
  }, "ALLOW");
}

const actionPriority: Readonly<Record<RiskBlockAction, number>> = {
  ALLOW: 0,
  PAUSE_STRATEGY: 1,
  BLOCK_NEW_ORDER: 2,
  MANUAL_REVIEW_REQUIRED: 3,
  HARD_STOP: 4,
};

function createInfrastructureSignalMetadata(signal: InfrastructureRiskSnapshot): JsonRecord {
  const metadata: JsonRecord = {
    signal: signal.signal,
    observed_at: signal.observedAt,
  };
  assignIfDefined(metadata, "exchange_id", signal.exchangeId);
  assignIfDefined(metadata, "market", signal.market);
  assignIfDefined(metadata, "strategy_id", signal.strategyId);
  assignIfDefined(metadata, "order_id", signal.orderId);
  assignIfDefined(metadata, "idempotency_key", signal.idempotencyKey);
  assignIfDefined(metadata, "metadata", signal.metadata);
  return metadata;
}

function isBtcOrEthMarket(market: MarketCode): boolean {
  const baseAsset = getBaseAsset(market);
  return baseAsset === "BTC" || baseAsset === "ETH";
}

function isAltMarket(market: MarketCode): boolean {
  return !isBtcOrEthMarket(market);
}

function getBaseAsset(market: MarketCode): string {
  return market.split("-").at(-1)?.toUpperCase() ?? market.toUpperCase();
}

function pass(reasonCode: string, message: string, metadata?: JsonRecord): RiskGateEvaluation {
  const input: EvaluationInput = {
    status: "PASS",
    reasonCode,
    message,
    severity: "INFO",
    action: "ALLOW",
  };
  if (metadata !== undefined) {
    input.metadata = metadata;
  }

  return createEvaluation(input);
}

function warn(reasonCode: string, message: string, metadata?: JsonRecord): RiskGateEvaluation {
  const input: EvaluationInput = {
    status: "WARN",
    reasonCode,
    message,
    severity: "WARN",
    action: "ALLOW",
  };
  if (metadata !== undefined) {
    input.metadata = metadata;
  }

  return createEvaluation(input);
}

function fail(
  reasonCode: string,
  message: string,
  action: Exclude<RiskBlockAction, "ALLOW">,
  metadata?: JsonRecord,
): RiskGateEvaluation {
  const input: EvaluationInput = {
    status: "FAIL",
    reasonCode,
    message,
    severity: action === "HARD_STOP" || action === "MANUAL_REVIEW_REQUIRED" ? "CRITICAL" : "BLOCKING",
    action,
  };
  if (metadata !== undefined) {
    input.metadata = metadata;
  }

  return createEvaluation(input);
}

function withThresholdSnapshots(
  evaluations: readonly RiskGateEvaluation[],
  thresholdSnapshot: RiskThresholdSnapshot,
): RiskGateEvaluation[] {
  return evaluations.map((item) => ({ ...item, thresholdSnapshot }));
}

function withThresholdSnapshot(
  evaluation: RiskGateEvaluation,
  thresholdSnapshot: RiskThresholdSnapshot,
): RiskGateEvaluation {
  return {
    ...evaluation,
    thresholdSnapshot,
  };
}

function createEvaluation(input: EvaluationInput): RiskGateEvaluation {
  const evaluation: RiskGateEvaluation = {
    status: input.status,
    reasonCode: input.reasonCode,
    message: input.message,
    severity: input.severity,
    action: input.action,
  };

  if (input.thresholdSnapshot !== undefined) {
    evaluation.thresholdSnapshot = input.thresholdSnapshot;
  }
  if (input.metadata !== undefined) {
    evaluation.metadata = input.metadata;
  }

  return evaluation;
}

function assignIfDefined(target: JsonRecord, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
