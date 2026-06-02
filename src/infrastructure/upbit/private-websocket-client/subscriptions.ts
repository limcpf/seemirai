import type {
  UpbitPrivateWebSocketFormat,
  UpbitPrivateWebSocketRequest,
  UpbitPrivateWebSocketType,
} from "./types.js";

/* ============================================================
 * Private WebSocket subscription builder
 *
 * myOrder: codes optional, 비어 있으면 전체 market 구독
 * myAsset: codes 금지, 지정 시 local fail-closed
 * format: DEFAULT 또는 JSON_LIST
 *
 * 요청 payload는 [{ticket}, {type, codes?}, ..., {format}]
 * 형태의 JSON array로 직렬화된다.
 * ============================================================ */

/** myOrder 구독 옵션이다. */
export interface CreateUpbitPrivateMyOrderSubscriptionOptions {
  ticket: string;
  /** 구독할 market code 목록이다. 비어 있거나 undefined면 전체 market을 구독한다. */
  codes?: readonly string[];
  format?: UpbitPrivateWebSocketFormat;
}

/** myAsset 구독 옵션이다. codes를 지정할 수 없다. */
export interface CreateUpbitPrivateMyAssetSubscriptionOptions {
  ticket: string;
  format?: UpbitPrivateWebSocketFormat;
}

/**
 * myOrder 구독 요청 JSON array를 생성한다.
 *
 * `codes`가 비어 있거나 undefined면 전체 market을 구독한다.
 * format 기본값은 "DEFAULT"이며, JSON_LIST는 Upbit JSON_LIST
 * 형식 payload를 수신할 때 사용한다.
 */
export function createUpbitPrivateMyOrderSubscription(
  options: CreateUpbitPrivateMyOrderSubscriptionOptions,
): UpbitPrivateWebSocketRequest {
  const { ticket, codes, format = "DEFAULT" } = options;

  if (ticket.trim().length === 0) {
    throw new Error("Upbit private WebSocket ticket is required");
  }

  const typeObject: { type: "myOrder"; codes?: readonly string[] } = { type: "myOrder" };

  // codes가 undefined거나 비어 있으면 전체 market 구독 → codes 필드를 생략한다.
  if (codes !== undefined && codes.length > 0) {
    typeObject.codes = codes;
  }

  return [{ ticket }, typeObject, { format }];
}

/**
 * myAsset 구독 요청 JSON array를 생성한다.
 *
 * `codes`를 지정하면 local fail-closed로 예외를 던진다.
 * myAsset은 항상 전체 계정 자산을 구독하며 market 필터를
 * 지원하지 않는다.
 */
export function createUpbitPrivateMyAssetSubscription(
  options: CreateUpbitPrivateMyAssetSubscriptionOptions,
): UpbitPrivateWebSocketRequest {
  const { ticket, format = "DEFAULT" } = options;
  assertNoMyAssetCodes(options);

  if (ticket.trim().length === 0) {
    throw new Error("Upbit private WebSocket ticket is required");
  }

  return [{ ticket }, { type: "myAsset" }, { format }];
}

/**
 * myOrder와 myAsset을 동시에 구독하는 요청 JSON array를 생성한다.
 *
 * runtime worker가 연결 직후 두 구독을 한 번에 보낼 때 사용한다.
 * myAsset에 codes가 없는 invariant는 createUpbitPrivateMyAssetSubscription이
 * 보장하므로 여기서는 재검증하지 않는다.
 */
export function createUpbitPrivateCombinedSubscription(
  myOrderOptions: CreateUpbitPrivateMyOrderSubscriptionOptions,
  myAssetOptions: CreateUpbitPrivateMyAssetSubscriptionOptions,
): UpbitPrivateWebSocketRequest {
  const ticket = myOrderOptions.ticket;
  assertNoMyAssetCodes(myAssetOptions);

  if (ticket.trim().length === 0) {
    throw new Error("Upbit private WebSocket ticket is required");
  }

  const format = myOrderOptions.format ?? myAssetOptions.format ?? "DEFAULT";
  const types: UpbitPrivateWebSocketTypeObject[] = [];

  types.push(buildMyOrderTypeObject(myOrderOptions));
  types.push({ type: "myAsset" });

  return [{ ticket }, ...types, { format }];
}

interface UpbitPrivateWebSocketTypeObject {
  type: UpbitPrivateWebSocketType;
  codes?: readonly string[];
}

function buildMyOrderTypeObject(
  options: CreateUpbitPrivateMyOrderSubscriptionOptions,
): UpbitPrivateWebSocketTypeObject {
  const obj: UpbitPrivateWebSocketTypeObject = { type: "myOrder" };

  if (options.codes !== undefined && options.codes.length > 0) {
    obj.codes = options.codes;
  }

  return obj;
}

function assertNoMyAssetCodes(options: CreateUpbitPrivateMyAssetSubscriptionOptions): void {
  const maybeConfigBuiltOptions = options as CreateUpbitPrivateMyAssetSubscriptionOptions & {
    codes?: unknown;
  };

  // 외부 config나 JS/any 경계에서 잘못 들어온 market filter는 전체 자산 구독으로 조용히 완화하지 않는다.
  if (maybeConfigBuiltOptions.codes !== undefined) {
    throw new Error("Upbit private WebSocket myAsset subscription does not support codes");
  }
}
