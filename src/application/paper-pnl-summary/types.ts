import type { MarketCode, NumericString, OrderSide, TimestampInput } from "../../domain/index.js";

/**
 * KRW PnL 계산기가 소비하는 단일 paper fill 입력이다.
 *
 * 호출자는 PaperBroker, soak runner, fixture smoke 중 어디에서 온 체결이든 같은 경제적 의미로 정규화해 넘겨야 한다.
 * `totalFillNotional`과 `totalFee`는 KRW 기준 금액이며, 이 타입 자체는 DB write나 broker side effect를 갖지 않는다.
 */
export interface PaperPnlFillInput {
  orderId: string;
  market: MarketCode;
  side: OrderSide;
  filledQuantity: NumericString;
  totalFillNotional: NumericString;
  totalFee?: NumericString;
  filledAt?: TimestampInput;
}

/**
 * 미청산 포지션 평가에 사용할 market별 KRW 평가가다.
 *
 * long position은 보수적으로 즉시 매도 가능한 가격을 넘기는 것이 기본 invariant이며, 입력 source가 bid/fixture 중
 * 무엇을 선택했는지는 `source`에 남겨 report가 평가 근거를 설명할 수 있게 한다.
 */
export interface PaperPnlMarkPriceInput {
  market: MarketCode;
  priceKrw: NumericString;
  observedAt?: TimestampInput;
  source?: string;
}

/**
 * paper run 단위 KRW 손익 summary를 만들기 위한 순수 입력이다.
 *
 * `fills`는 시간순으로 들어와야 평균단가와 실현손익이 재현 가능하다. 같은 주문이 여러 호가 level에서 나뉘어
 * 체결될 수 있으므로 `filledOrderCount`는 `orderId`를 기준으로 중복 제거된다. `submittedOrderCount`를 주입하지
 * 않으면 계산기는 체결된 주문 수를 제출 수로 간주해 단위 테스트와 작은 fixture에서 null-safe 기본값을 제공한다.
 */
export interface PaperPnlSummaryInput {
  startingCashKrw: NumericString;
  fills: readonly PaperPnlFillInput[];
  markPrices?: readonly PaperPnlMarkPriceInput[];
  submittedOrderCount?: number;
}

/**
 * fill ledger만으로 손익 cost basis를 확정할 수 없을 때 만드는 unavailable summary 입력이다.
 *
 * 예를 들어 fixture가 초기 BTC 잔고를 들고 SELL부터 실행하면 현금 변화와 수수료는 알 수 있지만 평균 취득가가 없어
 * 실현손익을 확정할 수 없다. 이 입력은 runner를 실패시키지 않되 손익 필드를 `null`로 보류하는 경계다.
 */
export interface PaperPnlUnavailableSummaryInput {
  startingCashKrw: NumericString;
  endingCashKrw: NumericString;
  totalFeesKrw: NumericString;
  submittedOrderCount: number;
  filledOrderCount: number;
}

/**
 * 운영자와 report가 읽는 paper trading KRW 손익 summary shape다.
 *
 * 미청산 포지션 평가가가 없으면 mark-to-market이 필요한 값은 `null`로 남긴다. 현금, 실현손익, 수수료, 주문/체결 수는
 * 체결 ledger만으로 확정할 수 있으므로 항상 숫자 문자열 또는 숫자로 제공한다.
 */
export interface PaperPnlSummary {
  startingCashKrw: NumericString;
  endingCashKrw: NumericString;
  positionMarketValueKrw: NumericString | null;
  realizedPnlKrw: NumericString | null;
  unrealizedPnlKrw: NumericString | null;
  totalPnlKrw: NumericString | null;
  totalReturnBps: NumericString | null;
  totalFeesKrw: NumericString;
  submittedOrderCount: number;
  filledOrderCount: number;
}
