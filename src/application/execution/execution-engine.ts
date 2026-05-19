import { parseFinancialDecimal } from "../../shared/index.js";
import type { BrokerPort } from "../ports/index.js";
import type {
  BrokerOrder,
  CostSnapshot,
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

/**
 * broker 제출 직전에 CostModel/RiskGate 증거와 현재 주문 후보를 대조하기 위한 canonical fingerprint다.
 *
 * 이 evidence는 DB나 audit log를 거쳐 다시 들어와도 같은 비교 규칙을 적용할 수 있게 domain의 camelCase 필드를
 * JSON-safe snake_case로 고정한다. broker side effect에 영향을 주는 position effect, limit option, RiskGate 한도
 * 입력인 expected loss까지 포함해, 승인 이후 후보가 바뀌면 ExecutionEngine이 fail-closed할 수 있게 한다.
 */
export type ExecutionOrderIntentEvidence = JsonRecord & {
  exchange_id: string;
  market: string;
  strategy_id: string;
  side: string;
  order_type: string;
  requested_quantity: string;
  requested_notional: string;
  idempotency_key: string;
  position_effect?: string;
  requested_price?: string;
  post_only?: boolean;
  time_in_force?: string;
  expected_loss_bps_of_equity?: string;
};

/**
 * CostModel snapshot을 execution 승인 증거로 승격한 payload다.
 *
 * 순수 비용 계산 결과만으로는 어떤 주문 후보를 평가했는지 완전히 알 수 없으므로, ExecutionEngine boundary에서
 * `source=cost_model`과 주문 fingerprint를 함께 요구한다. 후속 persistence mapper가 stale snapshot을 잘못 붙여도
 * 현재 submission과 다시 대조해 broker 제출을 막기 위한 계약이다.
 */
export type ExecutionCostSnapshotEvidence = JsonRecord & {
  source: "cost_model";
  trade_allowed: boolean;
  reason_code: string;
  order_intent: ExecutionOrderIntentEvidence;
};

/**
 * RiskGate 평가 결과를 execution 승인 증거로 고정한 payload다.
 *
 * `OrderSubmission.riskApproval`은 저장소/mapper 경계를 지나며 `JsonRecord`가 되므로, 실행 직전에는 출처와 상태를
 * 다시 확인해야 한다. `approved=true`만 신뢰하지 않고 `source`, `status`, `action`, 주문 fingerprint를 모두
 * 검증해 손상되거나 오래된 RiskGate 증거가 broker side effect로 이어지지 않게 한다.
 */
export type ExecutionRiskApprovalEvidence = JsonRecord & {
  source: "risk_gate";
  approved: boolean;
  status: string;
  action: string;
  order_intent: ExecutionOrderIntentEvidence;
};

/**
 * 같은 Node.js process 안에서 동시에 들어온 동일 idempotency key 요청을 추적하는 임시 guard다.
 *
 * 이 Map은 durable 중복 방지가 아니라 in-flight side effect 억제용이다. 성공한 key를 계속 보관하면 장시간 runtime에서
 * 메모리가 증가하므로, broker promise가 settle되면 반드시 제거한다.
 */
interface InFlightExecutionSubmission {
  fingerprint: ExecutionOrderIntentEvidence;
  brokerSubmission: Promise<BrokerOrder>;
}

/**
 * CostModel과 RiskGate를 통과한 주문 후보만 BrokerPort로 넘기는 application service다.
 *
 * 이 계층은 Strategy, Upbit REST client, DB 구현체를 알지 않는다. 후속 sub PR에서 PaperBroker와 persistence가
 * 붙더라도 실행 순서 `CostModel -> RiskGate -> ExecutionEngine -> BrokerPort`를 유지하기 위한 마지막 guard다.
 * validate 단계는 순수 검증으로 끝내고, 모든 증거가 현재 후보와 일치한 뒤에만 `BrokerPort.submitOrder`라는 외부
 * side effect를 호출한다.
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
   *
   * 반환값은 broker 호출 여부까지 포함하는 execution boundary의 단일 결과다. 검증 실패는 `REJECTED`, 같은
   * in-flight 주문의 재진입은 `DUPLICATE_SUPPRESSED`, 실제 broker port 호출 성공은 `SUBMITTED`로 표현한다.
   */
  public async submitOrder(submission: OrderSubmission): Promise<ExecutionSubmitOrderResult> {
    // broker side effect를 만들기 전에 모든 runtime toggle, 비용 증거, RiskGate 증거를 먼저 fail-closed로 검증한다.
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
      readSubmissionExpectedLossBps(submission),
    );
    const existingSubmission = this.inFlightByIdempotencyKey.get(submission.intent.idempotencyKey);
    if (existingSubmission !== undefined) {
      const mismatches = compareOrderIntentEvidence(existingSubmission.fingerprint, currentFingerprint);
      if (Object.keys(mismatches).length > 0) {
        // 같은 idempotency key가 다른 후보에 재사용되면 생성 버그로 보고 기존 broker 결과를 돌려주지 않는다.
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

      // 같은 후보가 동시에 재제출된 경우에는 기존 broker promise를 공유해 submit side effect를 한 번으로 제한한다.
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
 *
 * 호출자가 일부 toggle만 넘겨도 기본값은 paper-only fail-closed profile로 유지된다.
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
 *
 * RiskGate가 승인한 당시의 주문 후보와 expected loss를 함께 snapshot으로 남긴다. 이후 submission boundary에서
 * 같은 후보인지 다시 비교하므로, RiskGate 이후 수량/가격/손실 입력이 바뀐 주문은 broker 직전에 거부된다.
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
 * CostModel snapshot에 ExecutionEngine이 현재 주문과 대조할 order intent fingerprint를 붙인다.
 *
 * CostModel 자체는 수수료와 기대수익 중심의 계산 결과를 만들기 때문에 strategy, side, idempotency key 같은
 * execution 후보 식별자를 알지 않는다. 이 helper는 비용 snapshot을 broker 제출 승인 증거로 쓰기 전에 후보
 * fingerprint를 추가하는 좁은 adapter 역할만 한다.
 */
export function createExecutionCostSnapshotEvidence(
  snapshot: CostSnapshot,
  intent: OrderIntent,
  expectedLossBpsOfEquity?: string,
): ExecutionCostSnapshotEvidence {
  return {
    ...snapshot,
    source: "cost_model",
    order_intent: createOrderIntentEvidence(intent, expectedLossBpsOfEquity),
  };
}

/**
 * 주문 제출 요청이 broker side effect를 실행해도 되는지 순수 함수로 검증한다.
 *
 * 검증 순서는 저렴하고 전역적인 차단 조건에서 시작해, 주문 금액, 비용 snapshot, RiskGate approval 순서로 좁혀 간다.
 * 이 함수는 broker port나 DB를 호출하지 않으므로 테스트와 runtime mapper에서 같은 fail-closed 판단을 재사용할 수 있다.
 */
export function validateExecutionSubmission(
  submission: OrderSubmission,
  safetyConfig: ExecutionSafetyConfig = defaultPaperExecutionSafetyConfig,
): ExecutionSubmissionValidationResult {
  const idempotencyKey = submission.intent.idempotencyKey.trim();
  if (idempotencyKey.length === 0) {
    // idempotency key가 없으면 broker/repository 어느 쪽에서도 중복 방지 기준을 만들 수 없으므로 즉시 거부한다.
    return reject("idempotency_key_missing", "Execution submission requires a non-empty idempotency key");
  }

  if (safetyConfig.liveTradingEnabled) {
    // MVP execution boundary는 paper-only이므로 live trading toggle이 열린 구성 자체를 실행 불가로 본다.
    return reject("live_trading_disabled", "Live trading is disabled for the MVP execution boundary");
  }

  if (!safetyConfig.paperNoKey) {
    // paper runtime은 API key 없이도 동작해야 하므로 key 의존 실행 경로가 섞인 설정을 차단한다.
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
    // 기본 paper profile은 시장가 체결 시뮬레이션을 닫아 둔다.
    return reject("market_order_disabled", "Market order execution is disabled in the paper profile", {
      order_type: intent.orderType,
    });
  }

  if (isEntryMarketOrderIntent(intent) && !safetyConfig.entryMarketOrderEnabled) {
    // 청산/축소 목적 시장가는 별도 toggle로 허용할 수 있지만, 신규 진입 시장가는 더 보수적으로 다시 막는다.
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

  // broker가 해석할 금융 숫자는 모두 양수 Decimal 문자열이어야 하며, JS number 정밀도 손실 경로는 받지 않는다.
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
    // 비용 검증 없이 들어온 주문은 기대수익이 비용과 safety buffer를 넘는지 알 수 없으므로 broker에 넘기지 않는다.
    return reject("cost_snapshot_missing", "Execution submission requires a cost snapshot");
  }

  if (
    snapshot.source !== "cost_model" ||
    snapshot.trade_allowed !== true ||
    snapshot.reason_code !== "cost_margin_ok" ||
    hasProblemFieldList(snapshot.missing_fields) ||
    hasProblemFieldList(snapshot.invalid_fields)
  ) {
    // 비용 snapshot은 allow flag뿐 아니라 정상 판정 사유와 입력 상태까지 execution 승인 조건으로 삼는다.
    return reject("cost_snapshot_not_allowed", "Cost snapshot must allow the trade with an OK margin reason", {
      source: snapshot.source,
      trade_allowed: snapshot.trade_allowed,
      reason_code: snapshot.reason_code,
      missing_fields: snapshot.missing_fields,
      invalid_fields: snapshot.invalid_fields,
    });
  }

  const mismatches: JsonRecord = {};
  appendStringMismatch(mismatches, "cost_snapshot_exchange_id", snapshot.exchange_id, submission.intent.exchangeId);
  appendStringMismatch(mismatches, "cost_snapshot_market", snapshot.market, submission.intent.market);

  const costOrderIntent = snapshot.order_intent;
  if (!isNonEmptyRecord(costOrderIntent)) {
    // 비용 snapshot이 어떤 주문 후보를 평가했는지 모르면 같은 market의 오래된 allow 결과를 재사용할 수 있다.
    return reject("cost_snapshot_mismatch", "Cost snapshot requires order intent fingerprint");
  }

  Object.assign(mismatches, compareCostSnapshotOrderIntent(submission, costOrderIntent));

  if (Object.keys(mismatches).length > 0) {
    // exchange/market만 같아도 수량, 방향, idempotency key가 다르면 비용 승인 근거가 다른 후보의 것이다.
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
    // RiskGate 승인 근거가 없으면 주문 한도, 손실 한도, kill switch 조건을 통과했는지 증명할 수 없다.
    return reject("risk_approval_missing", "Execution submission requires RiskGate approval evidence");
  }

  if (
    riskApproval.source !== "risk_gate" ||
    riskApproval.approved !== true ||
    riskApproval.action !== "ALLOW" ||
    !isApprovalCapableRiskStatus(riskApproval.status) ||
    hasProblemFieldList(riskApproval.failed_evaluation_reason_codes)
  ) {
    // RiskGate 승인은 출처, 상태, action, 실패 평가 목록이 모두 실행 가능 상태일 때만 유효하다.
    return reject("risk_approval_not_approved", "RiskGate evidence must be an approval-capable ALLOW result", {
      source: riskApproval.source,
      approved: riskApproval.approved,
      action: riskApproval.action,
      status: riskApproval.status,
      failed_evaluation_reason_codes: riskApproval.failed_evaluation_reason_codes,
    });
  }

  const riskOrderIntent = riskApproval.order_intent;
  if (!isNonEmptyRecord(riskOrderIntent)) {
    // RiskGate approval은 반드시 당시 주문 후보 fingerprint와 함께 저장되어야 현재 submission과 대조할 수 있다.
    return reject("risk_approval_missing", "RiskGate evidence requires order intent fingerprint");
  }

  const mismatches = compareRiskApprovalOrderIntent(submission, riskOrderIntent);
  if (Object.keys(mismatches).length > 0) {
    // RiskGate 승인 후 후보가 바뀌면 이전 approval을 재사용하지 않고 broker 직전에서 차단한다.
    return reject("risk_approval_mismatch", "RiskGate evidence does not match the execution order intent", {
      mismatches,
    });
  }

  return undefined;
}

function compareCostSnapshotOrderIntent(
  submission: OrderSubmission,
  costOrderIntent: JsonRecord,
): JsonRecord {
  // 비용 snapshot에 붙은 후보 fingerprint와 현재 submission fingerprint를 같은 비교 규칙으로 맞춘다.
  return compareOrderIntentEvidence(
    costOrderIntent,
    createOrderIntentEvidence(submission.intent, readSubmissionExpectedLossBps(submission)),
  );
}

function compareRiskApprovalOrderIntent(
  submission: OrderSubmission,
  riskOrderIntent: JsonRecord,
): JsonRecord {
  // RiskGate approval에 붙은 후보 fingerprint와 현재 submission fingerprint를 같은 비교 규칙으로 맞춘다.
  return compareOrderIntentEvidence(
    riskOrderIntent,
    createOrderIntentEvidence(submission.intent, readSubmissionExpectedLossBps(submission)),
  );
}

/**
 * 저장된 evidence fingerprint와 runtime fingerprint의 차이를 JSON-safe mismatch map으로 만든다.
 *
 * 금융 숫자는 Decimal 정규화 후 비교해 `"1.0"`과 `"1"` 같은 표현 차이를 제거한다. expected loss는 RiskGate 한도
 * 판단의 필수 입력이므로 양쪽에 정규화 가능한 값이 없으면 mismatch로 기록한다.
 */
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
  appendStringMismatch(
    mismatches,
    "position_effect",
    evidence.position_effect,
    readStringRecordValue(runtime, "position_effect"),
  );
  appendBooleanMismatch(mismatches, "post_only", evidence.post_only, readBooleanRecordValue(runtime, "post_only"));
  appendStringMismatch(
    mismatches,
    "time_in_force",
    evidence.time_in_force,
    readStringRecordValue(runtime, "time_in_force"),
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
  appendRequiredDecimalMismatch(
    mismatches,
    "expected_loss_bps_of_equity",
    evidence.expected_loss_bps_of_equity,
    readStringRecordValue(runtime, "expected_loss_bps_of_equity"),
  );

  return mismatches;
}

/**
 * OrderIntent와 expected loss를 execution evidence에서 쓰는 canonical JSON fingerprint로 변환한다.
 *
 * 이 함수가 CostModel/RiskGate/idempotency guard의 공통 비교 기준이다. 시장가 주문의 entry/reduce 분기와 지정가
 * 주문의 post-only/time-in-force는 체결/취소 side effect를 바꾸므로 fingerprint에 포함한다.
 */
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

  const positionEffect = readOrderIntentPositionEffect(intent);
  if (positionEffect !== undefined) {
    // position effect는 시장가 신규 진입 차단 여부를 바꾸므로 approval 이후 metadata 변경도 mismatch로 잡는다.
    evidence.position_effect = positionEffect;
  }

  if (intent.orderType === "LIMIT") {
    // LIMIT option은 후속 PaperBroker fill simulation 결과를 바꾸는 실행 조건이므로 승인 증거에 고정한다.
    evidence.requested_price = normalizeFinancialDecimalString(intent.requestedPrice);
    evidence.post_only = intent.postOnly === true;
    if (intent.timeInForce !== undefined) {
      evidence.time_in_force = intent.timeInForce;
    }
  }

  if (expectedLossBpsOfEquity !== undefined) {
    // expected loss는 RiskGate 단일 주문 손실 한도 입력이므로 주문 후보 fingerprint와 함께 보존한다.
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

function appendBooleanMismatch(
  target: JsonRecord,
  fieldName: string,
  evidenceValue: unknown,
  runtimeValue: boolean | undefined,
): void {
  const normalizedEvidenceValue = typeof evidenceValue === "boolean" ? evidenceValue : undefined;
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

function appendRequiredDecimalMismatch(
  target: JsonRecord,
  fieldName: string,
  evidenceValue: unknown,
  runtimeValue: string | undefined,
): void {
  const normalizedEvidenceValue = readNormalizedFinancialDecimalString(evidenceValue);
  const normalizedRuntimeValue = readNormalizedFinancialDecimalString(runtimeValue);

  if (
    normalizedEvidenceValue === undefined ||
    normalizedRuntimeValue === undefined ||
    normalizedEvidenceValue !== normalizedRuntimeValue
  ) {
    // 필수 Decimal evidence는 누락도 mismatch로 남겨 손실 한도 입력이 사라진 승인 재사용을 막는다.
    target[`${fieldName}_evidence`] = normalizedEvidenceValue ?? null;
    target[`${fieldName}_runtime`] = normalizedRuntimeValue ?? null;
  }
}

function normalizeFinancialDecimalString(value: string): string {
  try {
    return parseFinancialDecimal(value).toFixed();
  } catch {
    return value;
  }
}

function readNormalizedFinancialDecimalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    return parseFinancialDecimal(value).toFixed();
  } catch {
    return undefined;
  }
}

function isEntryMarketOrderIntent(intent: OrderIntent): boolean {
  const positionEffect = readOrderIntentPositionEffect(intent);

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

function readBooleanRecordValue(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key];

  return typeof value === "boolean" ? value : undefined;
}

function readRiskGateExpectedLossBps(context: RiskGateContext): string | undefined {
  // runtime path는 top-level RiskGateContext 입력을 우선하고, legacy metadata 중복 저장 값은 fallback으로만 쓴다.
  return context.expectedLossBpsOfEquity ?? readOrderIntentExpectedLossBps(context.orderIntent);
}

function readSubmissionExpectedLossBps(submission: OrderSubmission): string | undefined {
  // submission boundary에서도 top-level 값을 우선해 metadata를 쓰지 않는 runtime 경로와 같은 fingerprint를 만든다.
  return submission.expectedLossBpsOfEquity ?? readOrderIntentExpectedLossBps(submission.intent);
}

function readOrderIntentExpectedLossBps(intent: OrderIntent): string | undefined {
  return (
    readStringMetadata(intent.metadata, "expected_loss_bps_of_equity") ??
    readStringMetadata(intent.metadata, "expectedLossBpsOfEquity")
  );
}

function readOrderIntentPositionEffect(intent: OrderIntent): string | undefined {
  return (
    readStringMetadata(intent.metadata, "position_effect") ??
    readStringMetadata(intent.metadata, "positionEffect")
  );
}

function isApprovalCapableRiskStatus(value: unknown): boolean {
  return value === "PASS" || value === "WARN";
}

function hasProblemFieldList(value: unknown): boolean {
  return value !== undefined && (!Array.isArray(value) || value.length > 0);
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
