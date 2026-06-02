import { Decimal } from "decimal.js";
import type { ExchangeId, MarketCode, NumericString, TimestampInput } from "../../../domain/index.js";
import { UPBIT_KRW_SPOT_EXCHANGE_ID } from "../policy-mapper.js";
import type {
  UpbitPrivateMyAssetEvent,
  UpbitPrivateMyOrderEvent,
} from "./types.js";
import type {
  UpbitPrivateWebSocketMyAsset,
  UpbitPrivateWebSocketMyOrder,
} from "./schemas.js";

/* ============================================================
 * Private WebSocket payload mapper
 *
 * raw myOrder/myAsset payload를 정규화된 event contract로
 * 변환한다. numeric 값은 Decimal을 통해 문자열로 보존해
 * 정밀도 손실을 방지한다.
 *
 * raw payload, Authorization/JWT, access key, secret key는
 * 정규화 결과에 포함하지 않는다.
 * ============================================================ */

/** mapper 공통 옵션이다. */
export interface MapUpbitPrivateWebSocketEventOptions {
  exchangeId?: ExchangeId;
  receivedAt: TimestampInput;
}

/**
 * myOrder raw payload를 정규화된 `UpbitPrivateMyOrderEvent`로 변환한다.
 *
 * Upbit private WebSocket은 sequence가 없으므로 event 식별자와
 * timestamp만 보존한다. runtime worker가 gap/stale을 판단할 때는
 * eventTimestamp나 receivedAt을 기준으로 삼아야 한다.
 */
export function toUpbitPrivateMyOrderEvent(
  payload: UpbitPrivateWebSocketMyOrder,
  options: MapUpbitPrivateWebSocketEventOptions,
): UpbitPrivateMyOrderEvent {
  const exchangeId = options.exchangeId ?? UPBIT_KRW_SPOT_EXCHANGE_ID;

  return {
    type: "MY_ORDER",
    exchangeId,
    orderId: payload.uuid,
    market: payload.code as MarketCode,
    side: payload.ask_bid,
    state: payload.state,
    price: toNumericString(payload.price),
    volume: toNumericString(payload.volume),
    remainingVolume: toNumericString(payload.remaining_volume),
    executedVolume: toNumericString(payload.executed_volume),
    tradePrice: toNumericString(payload.trade_price),
    paidFee: toNumericString(payload.paid_fee),
    // Upbit myOrder 공식 payload에는 fee currency가 없으므로 관측된 경우에만 보존한다.
    ...(payload.fee_currency === undefined ? {} : { feeCurrency: payload.fee_currency }),
    orderTimestamp: timestampFromMilliseconds(payload.order_timestamp),
    eventTimestamp: timestampFromMilliseconds(payload.timestamp),
    receivedAt: options.receivedAt,
    streamType: payload.stream_type,
    metadata: {
      // raw payload 중 정규화 필드 외 추가 정보를 보존하되
      // secret, JWT, Authorization header는 절대 포함하지 않는다.
      rawType: payload.type,
    },
  };
}

/**
 * myAsset raw payload를 정규화된 `UpbitPrivateMyAssetEvent`로 변환한다.
 *
 * balance/locked는 numeric string으로 보존한다.
 * raw payload, secret, JWT, Authorization header는
 * 반환 객체에 포함하지 않는다.
 */
export function toUpbitPrivateMyAssetEvent(
  payload: UpbitPrivateWebSocketMyAsset,
  options: MapUpbitPrivateWebSocketEventOptions,
): UpbitPrivateMyAssetEvent {
  const exchangeId = options.exchangeId ?? UPBIT_KRW_SPOT_EXCHANGE_ID;

  return {
    type: "MY_ASSET",
    exchangeId,
    balances: payload.assets.map((unit) => ({
      currency: unit.currency,
      balance: toNumericString(unit.balance),
      locked: toNumericString(unit.locked),
    })),
    eventTimestamp: timestampFromMilliseconds(payload.asset_timestamp),
    receivedAt: options.receivedAt,
    streamType: payload.stream_type,
    metadata: {
      rawType: payload.type,
    },
  };
}

/**
 * WebSocket numeric 값을 안정적인 문자열로 변환한다.
 *
 * number(1750000000000)와 문자열("0.001") 입력을 모두 Decimal로
 * 정규화해 후속 저장/비교 경계에서 정밀도 차이가 발생하지 않게 한다.
 */
function toNumericString(value: string | number): NumericString {
  return new Decimal(value).toFixed();
}

function timestampFromMilliseconds(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
