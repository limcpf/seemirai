/**
 * Upbit private WebSocket client public entry point다.
 *
 * 이 모듈은 M16 reconcile REST bootstrap 이후 계정 주문/자산
 * 변화 추적을 위해 private WebSocket `myOrder`/`myAsset`
 * subscription, payload schema/mapper, reconnect/gap evidence
 * contract를 제공한다.
 *
 * WebSocket 입력 정규화까지만 담당하며, reconcile engine과
 * runtime worker는 만들지 않는다.
 *
 * 인증 처리:
 * - JWT Authorization header를 transport 생성 단계에만 전달한다.
 * - raw JWT, access key, secret key, Authorization header는
 *   log, status, audit payload에 저장하지 않는 invariant를
 *   유지한다.
 */

export {
  UpbitPrivateWebSocketClient,
  UpbitPrivateWebSocketBootstrapBuffer,
  createDefaultUpbitPrivateWebSocket,
} from "./private-websocket-client/client.js";
export type {
  UpbitPrivateWebSocketBootstrapBufferOptions,
  UpbitPrivateWebSocketBootstrapGapEvidence,
  UpbitPrivateWebSocketBufferedMessage,
  UpbitPrivateWebSocketBufferedMessageDrain,
  UpbitPrivateWebSocketClientOptions,
  UpbitPrivateWebSocketSubscriptionSession,
} from "./private-websocket-client/types.js";
export {
  createUpbitPrivateMyOrderSubscription,
  createUpbitPrivateMyAssetSubscription,
  createUpbitPrivateCombinedSubscription,
} from "./private-websocket-client/subscriptions.js";
export type {
  CreateUpbitPrivateMyOrderSubscriptionOptions,
  CreateUpbitPrivateMyAssetSubscriptionOptions,
} from "./private-websocket-client/subscriptions.js";
export {
  UpbitPrivateWebSocketMyOrderSchema,
  UpbitPrivateWebSocketMyAssetSchema,
  UpbitPrivateWebSocketPayloadSchema,
} from "./private-websocket-client/schemas.js";
export type {
  UpbitPrivateWebSocketMyOrder,
  UpbitPrivateWebSocketMyAsset,
  UpbitPrivateWebSocketPayload,
} from "./private-websocket-client/schemas.js";
export {
  toUpbitPrivateMyOrderEvent,
  toUpbitPrivateMyAssetEvent,
} from "./private-websocket-client/mapper.js";
export type {
  MapUpbitPrivateWebSocketEventOptions,
} from "./private-websocket-client/mapper.js";
export {
  UPBIT_PRIVATE_WEBSOCKET_URL,
} from "./private-websocket-client/types.js";
export type {
  UpbitPrivateWebSocketType,
  UpbitPrivateWebSocketFormat,
  UpbitPrivateWebSocketRequest,
  UpbitPrivateWebSocketTypeObject,
  UpbitPrivateWebSocketConnectionStatus,
  UpbitPrivateWebSocketLifecycleEvent,
  UpbitPrivateWebSocketErrorEvent,
  UpbitPrivateWebSocketEvent,
  UpbitPrivateMyOrderEvent,
  UpbitPrivateMyAssetEvent,
  UpbitPrivateMyAssetBalance,
  UpbitPrivateWebSocketTransport,
  UpbitPrivateWebSocketFactory,
} from "./private-websocket-client/types.js";
