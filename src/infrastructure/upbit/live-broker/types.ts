import type {
  ExchangeId,
  TimestampInput,
} from "../../../domain/index.js";
import type {
  UpbitPrivateCancelOrderInput,
  UpbitPrivateCreateLimitOrderInput,
  UpbitPrivateGetOrderInput,
  UpbitPrivateListOpenOrdersInput,
  UpbitPrivateRestResponse,
} from "../private-client.js";

/**
 * UpbitLiveBroker가 private REST client에 요구하는 최소 method 집합이다.
 *
 * 구현체는 production `UpbitPrivateRestClient` 또는 unit test fake client일 수 있다. 이 contract는 live broker가 직접
 * 인증/JWT를 만들지 않고, 검증된 private client 경계만 호출하게 하며, 각 method는 실제 Upbit private API side effect를
 * 만들 수 있다.
 */
export interface UpbitLiveBrokerPrivateClient {
  createLimitOrder(input: UpbitPrivateCreateLimitOrderInput): Promise<UpbitPrivateRestResponse<unknown>>;
  cancelOrder(input: UpbitPrivateCancelOrderInput): Promise<UpbitPrivateRestResponse<unknown>>;
  getOrder(input: UpbitPrivateGetOrderInput): Promise<UpbitPrivateRestResponse<unknown>>;
  listOpenOrders(input?: UpbitPrivateListOpenOrdersInput): Promise<UpbitPrivateRestResponse<unknown>>;
  getAccounts(): Promise<UpbitPrivateRestResponse<unknown>>;
}

/**
 * UpbitLiveBroker가 반환 metadata에 남기는 호출 종류다.
 *
 * raw provider payload 대신 어느 BrokerPort method가 어떤 rate-limit trace를 만들었는지 audit/status에서 식별하기 위한
 * 안정 식별자이며, 값 자체는 외부 side effect가 없다.
 */
export type UpbitLiveBrokerOperation =
  | "submitOrder"
  | "cancelOrder"
  | "getOrder"
  | "listOpenOrders"
  | "getBalances";

/**
 * UpbitLiveBroker 생성 옵션이다.
 *
 * `privateClient`는 이미 runtime guard와 credential 입력을 통과한 호출자가 주입해야 한다. `clock`은 mapper snapshot 시각을
 * 고정하기 위한 경계이며, `exchangeId`는 기본 KRW 현물 exchange id를 테스트나 future region broker에서 바꿀 때만 지정한다.
 */
export interface UpbitLiveBrokerOptions {
  privateClient: UpbitLiveBrokerPrivateClient;
  exchangeId?: ExchangeId;
  clock?: () => TimestampInput;
}
