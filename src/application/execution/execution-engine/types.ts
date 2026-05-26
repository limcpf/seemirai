import type { BrokerOrder, JsonRecord, OrderSubmission } from "../../../domain/index.js";
import type { BrokerPort } from "../../ports/index.js";

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

/**
 * ExecutionEngine 제출 결과의 안정적인 status 코드다.
 *
 * 호출자는 이 값을 기준으로 broker side effect 발생, in-flight 중복 억제, 검증 거부를 구분한다.
 */
export type ExecutionSubmitStatus = "SUBMITTED" | "DUPLICATE_SUPPRESSED" | "REJECTED";

/**
 * ExecutionEngine이 broker 호출 전 주문을 거부할 때 사용하는 reason code다.
 *
 * 각 값은 사용자 메시지와 별도로 audit/debug 영역에서 재현 가능한 fail-closed 근거를 추적하기 위한 내부 식별자다.
 */
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

/**
 * broker 제출 전 validation 실패를 설명하는 결과 payload다.
 *
 * message는 운영자 행동 언어로 남기고, metadata에는 mismatch나 입력 손상 같은 재현 정보를 보존한다.
 */
export interface ExecutionRejection {
  reasonCode: ExecutionRejectionReasonCode;
  message: string;
  metadata?: JsonRecord;
}

/**
 * ExecutionEngine submitOrder의 외부 반환 타입이다.
 *
 * `SUBMITTED`와 `DUPLICATE_SUPPRESSED`는 broker order를 포함하고, `REJECTED`는 broker side effect 없이 rejection만 포함한다.
 */
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

/**
 * broker 호출 전 순수 validation 결과다.
 *
 * valid가 false이면 호출자는 반드시 broker side effect를 만들지 않고 rejection을 반환해야 한다.
 */
export type ExecutionSubmissionValidationResult =
  | {
      valid: true;
    }
  | {
      valid: false;
      rejection: ExecutionRejection;
    };

/**
 * ExecutionEngine이 외부 시스템과 만나는 port 묶음이다.
 *
 * 현재 side effect 경계는 BrokerPort 하나이며, Strategy/DB/Upbit client를 이 계층에 직접 주입하지 않는다.
 */
export interface ExecutionEnginePorts {
  broker: BrokerPort;
}

/**
 * ExecutionEngine 생성 시 runtime에서 덮어쓸 수 있는 옵션이다.
 *
 * safetyConfig는 partial로만 받고 paper trading fail-closed 기본값과 병합된다.
 */
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
