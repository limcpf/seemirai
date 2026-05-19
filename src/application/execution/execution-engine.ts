import { parseFinancialDecimal } from "../../shared/index.js";
import type { BrokerPort } from "../ports/index.js";
import type {
  BrokerOrder,
  JsonRecord,
  OrderIntent,
  OrderSubmission,
  RiskGateContext,
  RiskGateResult,
} from "../../domain/index.js";

/**
 * M6 ExecutionEngine이 broker 호출 전에 적용해야 하는 런타임 안전 설정이다.
 *
 * 기본값은 paper trading 전용이며, 실거래 주문과 시장가 주문 경로는 fail-closed로 닫는다.
 */
export interface ExecutionSafetyConfig {
  liveTradingEnabled: boolean;
  marketOrderEnabled: boolean;
  entryMarketOrderEnabled: boolean;
  paperNoKey: boolean;
}

export const defaultPaperExecutionSafetyConfig: ExecutionSafetyConfig = {
  liveTradingEnabled: false,
  marketOrderEnabled: false,
  entryMarketOrderEnabled: false,
  paperNoKey: true,
};

export type ExecutionSubmitStatus = "SUBMITTED" | "DUPLICATE_SUPPRESSED" | "REJECTED";

export type ExecutionRejectionReasonCode =
  | "idempotency_key_missing"
  | "idempotency_key_collision"
  | "live_trading_disabled"
  | "paper_no_key_required"
  | "market_order_disabled"
  | "entry_market_order_disabled"
  | "order_amount_invalid"
  | "cost_snapshot_missing"
  | "cost_snapshot_not_allowed"
  | "cost_snapshot_mismatch"
  | "risk_approval_missing"
  | "risk_approval_not_approved"
  | "risk_approval_mismatch";

export interface ExecutionRejection {
  reasonCode: ExecutionRejectionReasonCode;
  message: string;
  metadata?: JsonRecord;
}

export type ExecutionSubmitOrderResult =
  | {
      status: "SUBMITTED";
      submission: OrderSubmission;
      brokerOrder: BrokerOrder;
    }
  | {
      status: "DUPLICATE_SUPPRESSED";
      submission: OrderSubmission;
      brokerOrder: BrokerOrder;
    }
  | {
      status: "REJECTED";
      submission: OrderSubmission;
      rejection: ExecutionRejection;
    };

export type ExecutionSubmissionValidationResult =
  | {
      valid: true;
    }
  | {
      valid: false;
      rejection: ExecutionRejection;
    };

export interface ExecutionEnginePorts {
  broker: BrokerPort;
}

export interface ExecutionEngineOptions {
  safetyConfig?: Partial<ExecutionSafetyConfig>;
}

export type ExecutionOrderIntentEvidence = JsonRecord & {
  exchange_id: string;
  market: string;
  strategy_id: string;
  side: string;
  order_type: string;
  requested_quantity: string;
  requested_notional: string;
  idempotency_key: string;
  requested_price?: string;
  expected_loss_bps_of_equity?: string;
};

export type ExecutionRiskApprovalEvidence = JsonRecord & {
  source: "risk_gate";
  approved: boolean;
  status: string;
  action: string;
  order_intent: ExecutionOrderIntentEvidence;
};

interface InFlightExecutionSubmission {
  fingerprint: ExecutionOrderIntentEvidence;
  brokerSubmission: Promise<BrokerOrder>;
}

/**
 * CostModel과 RiskGate를 통과한 주문 후보만 BrokerPort로 넘기는 application service다.
 *
 * 이 계층은 Strategy, Upbit REST client, DB 구현체를 알지 않는다. 후속 sub PR에서 PaperBroker와 persistence가
 * 붙더라도 실행 순서 `CostModel -> RiskGate -> ExecutionEngine -> BrokerPort`를 유지하기 위한 마지막 guard다.
 */
export class ExecutionEngine {
  private readonly broker: BrokerPort;
  private readonly safetyConfig: ExecutionSafetyConfig;
  private readonly inFlightByIdempotencyKey = new Map<string, InFlightExecutionSubmission>();

  public constructor(ports: ExecutionEnginePorts, options: ExecutionEngineOptions = {}) {
    this.broker = ports.broker;
    this.safetyConfig = createExecutionSafetyConfig(options.safetyConfig);
  }

  /**
   * 주문 제출 요청을 검증하고, 통과한 요청만 broker에 전달한다.
   */
  public async submitOrder(submission: OrderSubmission): Promise<ExecutionSubmitOrderResult> {
    const validation = validateExecutionSubmission(submission, this.safetyConfig);
    if (!validation.valid) {
      return {
        status: "REJECTED",
        submission,
        rejection: validation.rejection,
      };
    }

    const currentFingerprint = createOrderIntentEvidence(
      submission.intent,
      readOrderIntentExpectedLossBps(submission.intent),
    );
    const existingSubmission = this.inFlightByIdempotencyKey.get(submission.intent.idempotencyKey);
    if (existingSubmission !== undefined) {
      const mismatches = compareOrderIntentEvidence(existingSubmission.fingerprint, currentFingerprint);
      if (Object.keys(mismatches).length > 0) {
        return {
          status: "REJECTED",
          submission,
          rejection: {
            reasonCode: "idempotency_key_collision",
            message: "In-flight idempotency key was reused for a different order fingerprint",
            metadata: {
              idempotency_key: submission.intent.idempotencyKey,
              mismatches,
            },
          },
        };
      }

      return {
        status: "DUPLICATE_SUPPRESSED",
        submission,
        brokerOrder: await existingSubmission.brokerSubmission,
      };
    }

    // 같은 process 안에서 동일 idempotency key가 동시에 들어와도 broker side effect는 한 번만 실행한다.
    const brokerSubmission = this.broker.submitOrder(submission);
    this.inFlightByIdempotencyKey.set(submission.intent.idempotencyKey, {
      fingerprint: currentFingerprint,
      brokerSubmission,
    });

    try {
      return {
        status: "SUBMITTED",
        submission,
        brokerOrder: await brokerSubmission,
      };
    } finally {
      // durable 중복 방지는 DB 경계에서 맡기고, application guard는 in-flight 요청만 보관한다.
      this.inFlightByIdempotencyKey.delete(submission.intent.idempotencyKey);
    }
  }
}

/**
 * runtime에서 넘기는 부분 설정을 paper trading 안전 기본값과 병합한다.
 */
export function createExecutionSafetyConfig(
  overrides: Partial<ExecutionSafetyConfig> = {},
): ExecutionSafetyConfig {
  return {
    ...defaultPaperExecutionSafetyConfig,
    ...overrides,
  };
}

/**
 * RiskGate 평가 결과를 ExecutionEngine이 대조할 수 있는 JSON evidence로 고정한다.
 */
export function createExecutionRiskApprovalEvidence(
  result: RiskGateResult,
  context: RiskGateContext,
): ExecutionRiskApprovalEvidence {
  const evidence: ExecutionRiskApprovalEvidence = {
    source: "risk_gate",
    approved: result.approved,
    status: result.status,
    action: result.action,
    order_intent: createOrderIntentEvidence(
      context.orderIntent,
      readRiskGateExpectedLossBps(context),
    ),
    threshold_snapshot: context.thresholdSnapshot,
    failed_evaluation_reason_codes: result.failedEvaluations.map((evaluation) => evaluation.reasonCode),
    warning_evaluation_reason_codes: result.warningEvaluations.map((evaluation) => evaluation.reasonCode),
  };

  return evidence;
}

/**
 * 주문 제출 요청이 broker side effect를 실행해도 되는지 순수 함수로 검증한다.
 */
export function validateExecutionSubmission(
  submission: OrderSubmission,
  safetyConfig: ExecutionSafetyConfig = defaultPaperExecutionSafetyConfig,
): ExecutionSubmissionValidationResult {
  const idempotencyKey = submission.intent.idempotencyKey.trim();
  if (idempotencyKey.length === 0) {
    return reject("idempotency_key_missing", "Execution submission requires a non-empty idempotency key");
  }

  if (safetyConfig.liveTradingEnabled) {
    return reject("live_trading_disabled", "Live trading is disabled for the MVP execution boundary");
  }

  if (!safetyConfig.paperNoKey) {
    return reject("paper_no_key_required", "Paper execution must be able to run without API keys");
  }

  const marketOrderRejection = validateMarketOrderSafety(submission.intent, safetyConfig);
  if (marketOrderRejection !== undefined) {
    return marketOrderRejection;
  }

  const amountRejection = validateOrderAmounts(submission.intent);
  if (amountRejection !== undefined) {
    return amountRejection;
  }

  const costSnapshotRejection = validateCostSnapshot(submission);
  if (costSnapshotRejection !== undefined) {
    return costSnapshotRejection;
  }

  const riskApprovalRejection = validateRiskApproval(submission);
  if (riskApprovalRejection !== undefined) {
    return riskApprovalRejection;
  }

  return {
    valid: true,
  };
}

function validateMarketOrderSafety(
  intent: OrderIntent,
  safetyConfig: ExecutionSafetyConfig,
): ExecutionSubmissionValidationResult | undefined {
  if (intent.orderType !== "MARKET") {
    return undefined;
  }

  if (!safetyConfig.marketOrderEnabled) {
    return reject("market_order_disabled", "Market order execution is disabled in the paper profile", {
      order_type: intent.orderType,
    });
  }

  if (!safetyConfig.entryMarketOrderEnabled || isEntryMarketOrderIntent(intent)) {
    return reject(
      "entry_market_order_disabled",
      "Entry market order execution is disabled by the MVP execution boundary",
      {
        order_type: intent.orderType,
        position_effect: readStringMetadata(intent.metadata, "position_effect"),
      },
    );
  }

  return undefined;
}

function validateOrderAmounts(intent: OrderIntent): ExecutionSubmissionValidationResult | undefined {
  const invalidFields: string[] = [];

  appendInvalidPositiveDecimalField(invalidFields, "requested_quantity", intent.requestedQuantity);
  appendInvalidPositiveDecimalField(invalidFields, "requested_notional", intent.requestedNotional);
  if (intent.orderType === "LIMIT") {
    appendInvalidPositiveDecimalField(invalidFields, "requested_price", intent.requestedPrice);
  }

  if (invalidFields.length === 0) {
    return undefined;
  }

  return reject("order_amount_invalid", "Execution order amount fields must be positive decimal strings", {
    invalid_fields: invalidFields,
  });
}

function validateCostSnapshot(
  submission: OrderSubmission,
): ExecutionSubmissionValidationResult | undefined {
  const snapshot = submission.costSnapshot;
  if (!isNonEmptyRecord(snapshot)) {
    return reject("cost_snapshot_missing", "Execution submission requires a cost snapshot");
  }

  if (snapshot.trade_allowed !== true) {
    return reject("cost_snapshot_not_allowed", "Cost snapshot must allow the trade before execution", {
      trade_allowed: snapshot.trade_allowed,
      reason_code: snapshot.reason_code,
    });
  }

  const mismatches: JsonRecord = {};
  appendStringMismatch(mismatches, "cost_snapshot_exchange_id", snapshot.exchange_id, submission.intent.exchangeId);
  appendStringMismatch(mismatches, "cost_snapshot_market", snapshot.market, submission.intent.market);

  if (Object.keys(mismatches).length > 0) {
    return reject("cost_snapshot_mismatch", "Cost snapshot does not match the execution order intent", {
      mismatches,
    });
  }

  return undefined;
}

function validateRiskApproval(
  submission: OrderSubmission,
): ExecutionSubmissionValidationResult | undefined {
  const riskApproval = submission.riskApproval;
  if (!isNonEmptyRecord(riskApproval)) {
    return reject("risk_approval_missing", "Execution submission requires RiskGate approval evidence");
  }

  if (riskApproval.approved !== true) {
    return reject("risk_approval_not_approved", "RiskGate evidence must approve the order before execution", {
      approved: riskApproval.approved,
      action: riskApproval.action,
      status: riskApproval.status,
    });
  }

  if (riskApproval.action !== "ALLOW") {
    return reject("risk_approval_not_approved", "RiskGate evidence must have ALLOW action before execution", {
      approved: riskApproval.approved,
      action: riskApproval.action,
      status: riskApproval.status,
    });
  }

  const riskOrderIntent = riskApproval.order_intent;
  if (!isNonEmptyRecord(riskOrderIntent)) {
    return reject("risk_approval_missing", "RiskGate evidence requires order intent fingerprint");
  }

  const mismatches = compareRiskApprovalOrderIntent(submission.intent, riskOrderIntent);
  if (Object.keys(mismatches).length > 0) {
    return reject("risk_approval_mismatch", "RiskGate evidence does not match the execution order intent", {
      mismatches,
    });
  }

  return undefined;
}

function compareRiskApprovalOrderIntent(intent: OrderIntent, riskOrderIntent: JsonRecord): JsonRecord {
  return compareOrderIntentEvidence(
    riskOrderIntent,
    createOrderIntentEvidence(intent, readOrderIntentExpectedLossBps(intent)),
  );
}

function compareOrderIntentEvidence(
  evidence: JsonRecord,
  runtime: JsonRecord,
): JsonRecord {
  const mismatches: JsonRecord = {};

  appendStringMismatch(mismatches, "exchange_id", evidence.exchange_id, readStringRecordValue(runtime, "exchange_id"));
  appendStringMismatch(mismatches, "market", evidence.market, readStringRecordValue(runtime, "market"));
  appendStringMismatch(
    mismatches,
    "strategy_id",
    evidence.strategy_id,
    readStringRecordValue(runtime, "strategy_id"),
  );
  appendStringMismatch(mismatches, "side", evidence.side, readStringRecordValue(runtime, "side"));
  appendStringMismatch(mismatches, "order_type", evidence.order_type, readStringRecordValue(runtime, "order_type"));
  appendStringMismatch(
    mismatches,
    "idempotency_key",
    evidence.idempotency_key,
    readStringRecordValue(runtime, "idempotency_key"),
  );
  appendDecimalMismatch(
    mismatches,
    "requested_quantity",
    evidence.requested_quantity,
    readStringRecordValue(runtime, "requested_quantity"),
  );
  appendDecimalMismatch(
    mismatches,
    "requested_notional",
    evidence.requested_notional,
    readStringRecordValue(runtime, "requested_notional"),
  );
  appendDecimalMismatch(
    mismatches,
    "requested_price",
    evidence.requested_price,
    readStringRecordValue(runtime, "requested_price"),
  );
  appendDecimalMismatch(
    mismatches,
    "expected_loss_bps_of_equity",
    evidence.expected_loss_bps_of_equity,
    readStringRecordValue(runtime, "expected_loss_bps_of_equity"),
  );

  return mismatches;
}

function createOrderIntentEvidence(
  intent: OrderIntent,
  expectedLossBpsOfEquity?: string,
): ExecutionOrderIntentEvidence {
  const evidence: ExecutionOrderIntentEvidence = {
    exchange_id: intent.exchangeId,
    market: intent.market,
    strategy_id: intent.strategyId,
    side: intent.side,
    order_type: intent.orderType,
    requested_quantity: normalizeFinancialDecimalString(intent.requestedQuantity),
    requested_notional: normalizeFinancialDecimalString(intent.requestedNotional),
    idempotency_key: intent.idempotencyKey,
  };

  if (intent.orderType === "LIMIT") {
    evidence.requested_price = normalizeFinancialDecimalString(intent.requestedPrice);
  }

  if (expectedLossBpsOfEquity !== undefined) {
    evidence.expected_loss_bps_of_equity = normalizeFinancialDecimalString(expectedLossBpsOfEquity);
  }

  return evidence;
}

function appendInvalidPositiveDecimalField(
  target: string[],
  fieldName: string,
  value: string,
): void {
  try {
    if (!parseFinancialDecimal(value).greaterThan(0)) {
      target.push(fieldName);
    }
  } catch {
    target.push(fieldName);
  }
}

function appendStringMismatch(
  target: JsonRecord,
  fieldName: string,
  evidenceValue: unknown,
  runtimeValue: string | undefined,
): void {
  const normalizedEvidenceValue = typeof evidenceValue === "string" ? evidenceValue : undefined;
  if (normalizedEvidenceValue !== runtimeValue) {
    target[`${fieldName}_evidence`] = normalizedEvidenceValue;
    target[`${fieldName}_runtime`] = runtimeValue;
  }
}

function appendDecimalMismatch(
  target: JsonRecord,
  fieldName: string,
  evidenceValue: unknown,
  runtimeValue: string | undefined,
): void {
  const normalizedEvidenceValue =
    typeof evidenceValue === "string" ? normalizeFinancialDecimalString(evidenceValue) : undefined;
  const normalizedRuntimeValue =
    runtimeValue === undefined ? undefined : normalizeFinancialDecimalString(runtimeValue);

  if (normalizedEvidenceValue !== normalizedRuntimeValue) {
    target[`${fieldName}_evidence`] = normalizedEvidenceValue;
    target[`${fieldName}_runtime`] = normalizedRuntimeValue;
  }
}

function normalizeFinancialDecimalString(value: string): string {
  try {
    return parseFinancialDecimal(value).toFixed();
  } catch {
    return value;
  }
}

function isEntryMarketOrderIntent(intent: OrderIntent): boolean {
  const positionEffect =
    readStringMetadata(intent.metadata, "position_effect") ??
    readStringMetadata(intent.metadata, "positionEffect");

  return positionEffect !== "REDUCE" && positionEffect !== "EXIT";
}

function readStringMetadata(metadata: JsonRecord | undefined, key: string): string | undefined {
  const value = metadata?.[key];

  return typeof value === "string" ? value : undefined;
}

function readStringRecordValue(record: JsonRecord, key: string): string | undefined {
  const value = record[key];

  return typeof value === "string" ? value : undefined;
}

function readRiskGateExpectedLossBps(context: RiskGateContext): string | undefined {
  return context.expectedLossBpsOfEquity ?? readOrderIntentExpectedLossBps(context.orderIntent);
}

function readOrderIntentExpectedLossBps(intent: OrderIntent): string | undefined {
  return (
    readStringMetadata(intent.metadata, "expected_loss_bps_of_equity") ??
    readStringMetadata(intent.metadata, "expectedLossBpsOfEquity")
  );
}

function isNonEmptyRecord(value: unknown): value is JsonRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

function reject(
  reasonCode: ExecutionRejectionReasonCode,
  message: string,
  metadata?: JsonRecord,
): ExecutionSubmissionValidationResult {
  return {
    valid: false,
    rejection: metadata === undefined ? { reasonCode, message } : { reasonCode, message, metadata },
  };
}
