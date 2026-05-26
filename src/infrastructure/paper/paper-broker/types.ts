import type { PaperFillSimulatorOptions } from "../../../application/execution/index.js";
import type {
  ExchangeId,
  JsonRecord,
  NumericString,
  OrderLifecycleStatus,
  OrderbookEvent,
  TimestampInput,
} from "../../../domain/index.js";

export type PaperBrokerFillOptions = Omit<PaperFillSimulatorOptions, "submittedAt">;

/**
 * PaperBroker 초기 가상 잔고 입력이다.
 *
 * runtime, backtest bridge, unit test가 시작 시점의 available/locked 수량을 주입하는 경계이며, DB write나 외부 API
 * side effect 없이 in-memory 잔고 snapshot으로 정규화된다.
 */
export interface PaperBrokerBalanceInput {
  currency: string;
  available: NumericString;
  locked?: NumericString;
  total?: NumericString;
  updatedAt?: TimestampInput;
  metadata?: JsonRecord;
}

/**
 * PaperBroker 인스턴스 생성 옵션이다.
 *
 * 거래소 식별자, 초기 잔고, 주문 제출 시점에 사용할 호가 window, fill simulator 옵션, deterministic clock을 런타임 조립
 * 경계에서 주입한다. 이 옵션만으로 PaperBroker는 live order API를 열지 않는다.
 */
export interface PaperBrokerOptions {
  /**
   * 잔고 snapshot과 주문 결과에 찍을 거래소 식별자다.
   *
   * PaperBroker는 거래소별 client를 import하지 않으므로, runtime assembly가 선택한 paper profile의 exchange id를
   * 명시적으로 주입해야 한다.
   */
  exchangeId: ExchangeId;
  /** 테스트, backtest bridge, paper runtime이 시작 시점에 주입하는 가상 잔고다. */
  initialBalances?: readonly PaperBrokerBalanceInput[];
  /**
   * submit 시점에 사용할 호가 snapshot 묶음이다.
   *
   * BrokerPort에는 market data 조회 메서드가 없으므로, runtime은 주문 제출 전에 최신 snapshot을 broker에 기록해 둔다.
   */
  orderbookSnapshots?: OrderbookEvent | readonly OrderbookEvent[];
  /** latency, post-only 정책, 수수료처럼 fill simulator에 넘길 broker-local 옵션이다. */
  fillOptions?: PaperBrokerFillOptions;
  /** 사람이 로그에서 구분하기 쉬운 paper 주문 ID prefix다. */
  brokerOrderIdPrefix?: string;
  /** 테스트와 replay가 결정적 timestamp를 주입할 수 있게 하는 clock이다. */
  clock?: () => TimestampInput;
}

/**
 * market code에서 분리한 quote/base 통화쌍이다.
 *
 * balance mutation과 cancel release가 같은 파싱 결과를 공유해 BUY는 quote lock, SELL은 base lock을 일관되게 다룬다.
 */
export interface MarketCurrencies {
  quoteCurrency: string;
  baseCurrency: string;
}

/**
 * 주문 제출 결과가 가상 잔고에 만드는 delta 요약이다.
 *
 * PaperBroker metadata와 persistence evidence가 같은 값을 보도록 체결 수량, open 수량, quote/base available/locked delta를
 * 한 구조에 모은다.
 */
export interface PaperBrokerBalanceMutationSummary extends JsonRecord {
  base_currency: string;
  quote_currency: string;
  filled_quantity: NumericString;
  open_quantity: NumericString;
  canceled_quantity: NumericString;
  quote_available_delta: NumericString;
  quote_locked_delta: NumericString;
  base_available_delta: NumericString;
  base_locked_delta: NumericString;
}

/**
 * 주문 취소가 open lock을 해제한 근거다.
 *
 * cancel metadata와 execution persistence 검증이 같은 canceled/open 수량을 바라보게 하기 위한 paper-only evidence다.
 */
export interface PaperBrokerCancelMutationSummary extends JsonRecord {
  base_currency: string;
  quote_currency: string;
  released_currency: string;
  released_quantity: NumericString;
  canceled_quantity: NumericString;
}

/**
 * 가상 잔고 부족으로 주문 실행을 거부한 근거다.
 *
 * 거부 주문은 fill simulation 후보가 있어도 balance side effect를 적용하지 않으며, 이 payload가 그 fail-closed 이유를
 * metadata에 남긴다.
 */
export interface PaperBrokerBalanceRejectionSummary extends JsonRecord {
  reason_code: "paper_balance_insufficient";
  currency: string;
  balance_field: "available";
  required_quantity: NumericString;
  available_quantity: NumericString;
  shortage_quantity: NumericString;
  attempted_delta: NumericString;
}

/**
 * broker 인스턴스와 주문 intent의 거래소가 다른 경우의 거부 근거다.
 *
 * 서로 다른 exchange의 호가와 잔고가 섞이지 않도록 fill simulation 이전에 주문을 REJECTED로 닫는다.
 */
export interface PaperBrokerExchangeRejectionSummary extends JsonRecord {
  reason_code: "paper_exchange_mismatch";
  broker_exchange_id: ExchangeId;
  intent_exchange_id: ExchangeId;
}

/**
 * 가상 잔고 delta 적용 가능 여부다.
 *
 * 유효하지 않으면 주문은 REJECTED가 되고 balance mutation은 적용하지 않는다.
 */
export type PaperBrokerBalanceValidationResult =
  | {
      valid: true;
    }
  | {
      valid: false;
      rejection: PaperBrokerBalanceRejectionSummary;
    };

/**
 * fill simulator 호출 직전의 호가 window와 options다.
 *
 * latency 옵션에 따라 즉시 체결 snapshot과 post-submit snapshot window를 다르게 넘기기 위한 내부 orchestration 입력이다.
 */
export interface PaperBrokerFillSimulationRequest {
  orderbooks: readonly OrderbookEvent[];
  options: PaperFillSimulatorOptions;
}

/**
 * fill simulation과 잔고 검증을 broker 주문 상태로 정규화한 결과다.
 *
 * balance rejection은 simulation 상태보다 우선해 REJECTED로 닫히며, valid 경로만 remaining quantity를 open 수량으로
 * 유지한다.
 */
export interface PaperBrokerOrderState {
  status: OrderLifecycleStatus;
  remainingQuantity: NumericString;
  balanceMutationApplied: boolean;
  balanceRejection?: PaperBrokerBalanceRejectionSummary;
}
