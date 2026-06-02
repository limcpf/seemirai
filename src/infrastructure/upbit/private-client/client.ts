import { randomUUID } from "node:crypto";
import {
  createUpbitRateLimitStatus,
  parseRemainingReqHeader,
} from "../rate-limit.js";
import { buildUpbitAuthorizationHeader, buildUpbitQueryString, buildUpbitUrlQueryString } from "./auth.js";
import {
  UPBIT_PRIVATE_API_BASE_URL,
  UPBIT_PRIVATE_ORDER_IDENTIFIER_MAX_LENGTH,
  UnsafeUpbitPrivateRequestError,
  UpbitPrivateRestClientError,
} from "./types.js";
import type {
  UpbitPrivateCancelOrderInput,
  UpbitPrivateCreateLimitOrderInput,
  UpbitPrivateCredentials,
  UpbitPrivateErrorKind,
  UpbitPrivateErrorTrace,
  UpbitPrivateGetOrderInput,
  UpbitPrivateListClosedOrdersInput,
  UpbitPrivateListOpenOrdersInput,
  UpbitPrivateRequestMethod,
  UpbitPrivateRestClientOptions,
  UpbitPrivateRestResponse,
  UpbitQueryParamValue,
  UpbitQueryParams,
} from "./types.js";
import type { UpbitRateLimitStatus, UpbitRemainingReq } from "../rate-limit.js";

interface UpbitPrivateRequestInput {
  method: UpbitPrivateRequestMethod;
  pathname: string;
  queryParams?: UpbitQueryParams;
  bodyParams?: UpbitQueryParams;
}

interface UpbitProviderErrorPayload {
  error?: {
    name?: unknown;
    message?: unknown;
  };
}

const CLOSED_ORDERS_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Upbit 종료 주문 조회 시간 파라미터의 정규화 결과다.
 *
 * `value`는 URL query와 JWT query hash에 그대로 쓰는 Unix timestamp(ms) 문자열이고, `timestampMs`는 거래소 호출 전
 * 조회 window invariant를 검증하기 위한 숫자 값이다. 이 구조는 파싱 결과만 보존하며 외부 side effect를 만들지 않는다.
 */
interface UpbitClosedOrdersTimestamp {
  value: string;
  timestampMs: number;
}

/**
 * Upbit private REST client foundation이다.
 *
 * 이 client는 JWT 인증, query hash, rate-limit envelope, 실패 정규화만 담당한다. 기본 `PAPER_NO_KEY` runtime에서 자동
 * 생성하지 않고, pilot env guard를 통과한 runner가 명시적으로 조립해야 한다. 주문 생성/취소 method는 low-level endpoint
 * wrapper이며, M14 소액 지정가 smoke 제한은 runtime guard가 통과한 입력만 전달해야 한다.
 */
export class UpbitPrivateRestClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly credentials: UpbitPrivateCredentials;
  private readonly nonceFactory: () => string;

  public constructor(options: UpbitPrivateRestClientOptions) {
    this.baseUrl = options.baseUrl ?? UPBIT_PRIVATE_API_BASE_URL;
    this.fetchFn = options.fetchFn ?? fetch;
    this.credentials = options.credentials;
    this.nonceFactory = options.nonceFactory ?? randomUUID;
  }

  /**
   * 계정 잔고 조회 private endpoint를 호출한다.
   *
   * `PILOT_READ_ONLY` 이상에서 자산조회 권한을 확인하는 호출 경계이며, 응답 schema/domain mapper는 후속 PR에서 붙인다.
   * 이 method는 주문 side effect를 만들지 않는다.
   */
  public async getAccounts(): Promise<UpbitPrivateRestResponse<unknown>> {
    return this.requestJson({
      method: "GET",
      pathname: "/v1/accounts",
    });
  }

  /**
   * market별 주문 가능 정보 endpoint를 호출한다.
   *
   * policy sync profile에서 수수료, 최소 주문금액, 주문 가능 유형 근거를 얻기 위한 read-only 호출이다. market query는 JWT
   * query hash와 URL에 동일하게 반영된다.
   */
  public async getOrderChance(market: string): Promise<UpbitPrivateRestResponse<unknown>> {
    return this.requestJson({
      method: "GET",
      pathname: "/v1/orders/chance",
      queryParams: [{ key: "market", value: market }],
    });
  }

  /**
   * 기존 주문을 uuid 또는 identifier로 조회한다.
   *
   * 조회 식별자는 정확히 하나만 허용해 거래소 호출 전 fail-closed 한다. 이 method는 주문 생성/취소 wrapper가 아니며 기존
   * 주문 상태 확인용 read-only endpoint만 호출한다.
   */
  public async getOrder(input: UpbitPrivateGetOrderInput): Promise<UpbitPrivateRestResponse<unknown>> {
    return this.requestJson({
      method: "GET",
      pathname: "/v1/order",
      queryParams: toSingleOrderIdentifierQueryParams(input, "주문 조회"),
    });
  }

  /**
   * 종료 주문 목록 조회 endpoint를 호출한다.
   *
   * M16 read-only reconcile이 체결 완료와 취소 주문을 조회하는 read-only wrapper다. `state`와 `states[]` 동시 지정,
   * 빈 `states[]`, 지원하지 않는 상태, `limit > 1000`은 fetch 전에 fail-closed 한다. `page`는 Upbit 공식 closed API가
   * 지원하지 않으므로 이 wrapper에 포함하지 않는다. `start_time`/`end_time` timestamp는 query hash와 URL query에
   * 같은 순서로 반영된다.
   */
  public async listClosedOrders(
    input: UpbitPrivateListClosedOrdersInput = {},
  ): Promise<UpbitPrivateRestResponse<unknown>> {
    const queryParams = toListClosedOrdersQueryParams(input);

    return this.requestJson({
      method: "GET",
      pathname: "/v1/orders/closed",
      queryParams,
    });
  }

  /**
   * 체결 대기 주문 목록 조회 endpoint를 호출한다.
   *
   * M15 live broker의 `listOpenOrders` 입력 경계이며, 예약 주문 대기 누락을 막기 위해 기본 조회도 `wait`와 `watch`를
   * 함께 요청한다. query hash와 URL query는 같은 순서의 key-value 목록에서 생성한다.
   */
  public async listOpenOrders(
    input: UpbitPrivateListOpenOrdersInput = {},
  ): Promise<UpbitPrivateRestResponse<unknown>> {
    const queryParams = toListOpenOrdersQueryParams(input);

    return this.requestJson({
      method: "GET",
      pathname: "/v1/orders/open",
      queryParams,
    });
  }

  /**
   * Upbit 지정가 주문 생성 endpoint를 호출한다.
   *
   * 이 method는 실제 주문 생성 side effect를 만들 수 있으므로, 호출자는 반드시 runtime order smoke guard가 만든 입력만
   * 전달해야 한다. JSON body와 JWT query hash는 같은 순서의 key-value 목록에서 생성한다.
   */
  public async createLimitOrder(
    input: UpbitPrivateCreateLimitOrderInput,
  ): Promise<UpbitPrivateRestResponse<unknown>> {
    return this.requestJson({
      method: "POST",
      pathname: "/v1/orders",
      bodyParams: toCreateLimitOrderBodyParams(input),
    });
  }

  /**
   * Upbit 개별 주문 취소 endpoint를 호출한다.
   *
   * 취소는 실계좌 side effect이므로 wrapper는 uuid/identifier 동시 지정이나 누락을 거래소 호출 전 차단한다. pilot smoke는
   * 같은 run에서 생성한 identifier만 이 method에 전달해야 한다.
   */
  public async cancelOrder(input: UpbitPrivateCancelOrderInput): Promise<UpbitPrivateRestResponse<unknown>> {
    return this.requestJson({
      method: "DELETE",
      pathname: "/v1/order",
      queryParams: toSingleOrderIdentifierQueryParams(input, "주문 취소"),
    });
  }

  private async requestJson<TPayload = unknown>(
    input: UpbitPrivateRequestInput,
  ): Promise<UpbitPrivateRestResponse<TPayload>> {
    const body = input.bodyParams === undefined ? undefined : JSON.stringify(toJsonBody(input.bodyParams));
    const queryString = buildUpbitQueryString(input.bodyParams ?? input.queryParams);
    const url = this.buildUrl(input.pathname, buildUpbitUrlQueryString(input.queryParams));
    const headers = new Headers({
      accept: "application/json",
      authorization: buildUpbitAuthorizationHeader({
        accessKey: this.credentials.accessKey,
        secretKey: this.credentials.secretKey,
        nonce: this.nonceFactory(),
        queryString,
      }),
    });
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: input.method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      // 응답을 받기 전 네트워크 실패도 raw 예외를 audit으로 흘리지 않고 private client 오류 contract로 닫는다.
      throw createPrivateNetworkError();
    }
    let remainingReq: UpbitRemainingReq | undefined;
    try {
      remainingReq = parseOptionalRemainingReqHeader(response.headers);
    } catch {
      // malformed rate-limit header는 복구 정책을 흐리므로 raw 파싱 예외 대신 provider 응답 오류로 닫는다.
      throw createMalformedRateLimitHeaderError(response);
    }
    const retryAfterSeconds = parseOptionalRetryAfterHeader(response.headers);
    const rateLimitStatus = createUpbitRateLimitStatus(response.status, remainingReq, retryAfterSeconds);

    if (!response.ok) {
      // provider 실패는 raw body를 저장하지 않고 짧은 error name만 trace로 남겨 secret-like 응답 전파를 막는다.
      throw await createPrivateRestClientError(response, rateLimitStatus);
    }

    try {
      const payload = (await response.json()) as TPayload;
      return {
        payload,
        ...(remainingReq === undefined ? {} : { remainingReq }),
        rateLimitStatus,
      };
    } catch {
      // JSON 파싱 실패는 거래소 응답 불일치이므로 후속 smoke가 같은 응답을 정상 evidence로 쓰지 못하게 닫는다.
      throw new UpbitPrivateRestClientError({
        status: response.status,
        statusText: response.statusText,
        kind: "INVALID_PROVIDER_RESPONSE",
        userMessage: "Upbit 응답을 해석하지 못했습니다. 원문 응답을 저장하지 않고 수동 확인으로 전환합니다.",
        rateLimitStatus,
        trace: {
          httpStatus: response.status,
          rateLimitStatus,
        },
      });
    }
  }

  private buildUrl(pathname: string, queryString: string): URL {
    const url = new URL(pathname, this.baseUrl);
    if (queryString.length > 0) {
      url.search = queryString;
    }

    return url;
  }
}

function toSingleOrderIdentifierQueryParams(
  input: UpbitPrivateGetOrderInput | UpbitPrivateCancelOrderInput,
  operationLabel: string,
): UpbitQueryParams {
  if (input.uuid !== undefined && input.identifier !== undefined) {
    throw new UnsafeUpbitPrivateRequestError({
      violations: [`${operationLabel} 식별자는 uuid 또는 identifier 중 하나만 지정해야 합니다`],
    });
  }

  if (input.uuid === undefined && input.identifier === undefined) {
    throw new UnsafeUpbitPrivateRequestError({
      violations: [`${operationLabel}에는 uuid 또는 identifier가 필요합니다`],
    });
  }

  return input.uuid === undefined
    ? [{ key: "identifier", value: input.identifier! }]
    : [{ key: "uuid", value: input.uuid }];
}

function toCreateLimitOrderBodyParams(input: UpbitPrivateCreateLimitOrderInput): UpbitQueryParams {
  const violations: string[] = [];
  validateRequiredString(input.market, "주문 생성 market", violations);
  validateOrderSide(input.side, violations);
  validateRequiredString(input.volume, "주문 생성 volume", violations);
  validateRequiredString(input.price, "주문 생성 price", violations);
  validateRequiredString(input.identifier, "주문 생성 identifier", violations);

  if (input.identifier.length > UPBIT_PRIVATE_ORDER_IDENTIFIER_MAX_LENGTH) {
    // Upbit identifier 재사용/길이 오류는 실주문 호출 전 local guard에서 차단해 중복 주문 위험을 줄인다.
    violations.push(`주문 생성 identifier는 ${UPBIT_PRIVATE_ORDER_IDENTIFIER_MAX_LENGTH}자 이하여야 합니다`);
  }

  if (input.timeInForce !== undefined && !["ioc", "fok", "post_only"].includes(input.timeInForce)) {
    violations.push("주문 생성 time_in_force는 ioc, fok, post_only 중 하나여야 합니다");
  }

  if (input.smpType !== undefined && !["cancel_maker", "cancel_taker", "reduce"].includes(input.smpType)) {
    violations.push("주문 생성 smp_type은 cancel_maker, cancel_taker, reduce 중 하나여야 합니다");
  }

  if (input.timeInForce === "post_only" && input.smpType !== undefined) {
    // Upbit 문서상 post_only와 SMP는 함께 사용할 수 없으므로 거래소 거부 전에 닫는다.
    violations.push("post_only 주문은 smp_type과 함께 사용할 수 없습니다");
  }

  if (violations.length > 0) {
    throw new UnsafeUpbitPrivateRequestError({ violations });
  }

  return [
    { key: "market", value: input.market },
    { key: "side", value: input.side },
    { key: "volume", value: input.volume },
    { key: "price", value: input.price },
    { key: "ord_type", value: "limit" },
    { key: "identifier", value: input.identifier },
    ...(input.timeInForce === undefined ? [] : [{ key: "time_in_force", value: input.timeInForce }]),
    ...(input.smpType === undefined ? [] : [{ key: "smp_type", value: input.smpType }]),
  ];
}

function toListClosedOrdersQueryParams(input: UpbitPrivateListClosedOrdersInput): UpbitQueryParams {
  const violations: string[] = [];
  const params: UpbitQueryParams[number][] = [];

  // `state`와 `states[]`는 동시에 지정할 수 없다.
  if (input.state !== undefined && input.states !== undefined) {
    violations.push("종료 주문 조회 state와 states[]는 동시에 지정할 수 없습니다");
  }

  if (input.market !== undefined) {
    validateRequiredString(input.market, "종료 주문 조회 market", violations);
    params.push({ key: "market", value: input.market });
  }

  if (input.state !== undefined) {
    if (input.state !== "done" && input.state !== "cancel") {
      violations.push("종료 주문 조회 state는 done 또는 cancel만 허용합니다");
    }
    params.push({ key: "state", value: input.state });
  } else {
    // 기본 상태는 체결 완료와 취소 주문을 함께 조회한다.
    const states = input.states ?? ["done", "cancel"];

    if (states.length === 0) {
      violations.push("종료 주문 조회 states[]는 비어 있을 수 없습니다");
    }
    for (const state of states) {
      if (state !== "done" && state !== "cancel") {
        violations.push("종료 주문 조회 states[]는 done 또는 cancel만 허용합니다");
        break;
      }
    }
    if (states.length > 0) {
      params.push({ key: "states[]", value: states });
    }
  }

  if (input.limit !== undefined) {
    validatePositiveInteger(input.limit, "종료 주문 조회 limit", violations);
    if (input.limit > 1000) {
      violations.push("종료 주문 조회 limit은 1000 이하여야 합니다");
    }
    params.push({ key: "limit", value: input.limit });
  }

  if (input.orderBy !== undefined) {
    if (input.orderBy !== "asc" && input.orderBy !== "desc") {
      violations.push("종료 주문 조회 order_by는 asc 또는 desc 여야 합니다");
    }
    params.push({ key: "order_by", value: input.orderBy });
  }

  const startTime = input.startTime === undefined ? undefined : toUpbitTimestamp(input.startTime);
  const endTime = input.endTime === undefined ? undefined : toUpbitTimestamp(input.endTime);

  if (startTime !== undefined && endTime !== undefined) {
    if (endTime.timestampMs < startTime.timestampMs) {
      violations.push("종료 주문 조회 end_time은 start_time 이후여야 합니다");
    }
    if (endTime.timestampMs - startTime.timestampMs > CLOSED_ORDERS_MAX_WINDOW_MS) {
      violations.push("종료 주문 조회 start_time/end_time window는 7일 이하여야 합니다");
    }
  }

  // reconcile snapshot이 거래소 거부나 누락에 의존하지 않도록 시간 window를 로컬에서 먼저 닫는다.
  if (startTime !== undefined) {
    params.push({ key: "start_time", value: startTime.value });
  }

  if (endTime !== undefined) {
    params.push({ key: "end_time", value: endTime.value });
  }

  if (violations.length > 0) {
    throw new UnsafeUpbitPrivateRequestError({ violations });
  }

  return params;
}

/**
 * ISO 8601 문자열 또는 Unix timestamp(ms) 숫자를 Upbit API가 요구하는 Unix timestamp(ms) 문자열로 변환한다.
 *
 * 이 함수는 결정적이어야 하며, 같은 입력이 항상 같은 문자열을 반환해 JWT query hash가 일관되게 유지되도록 한다.
 * 외부 side effect는 없으며, 파싱 실패 시 원본을 그대로 반영하지 않고 오류로 닫는다.
 */
function toUpbitTimestamp(value: string | number): UpbitClosedOrdersTimestamp {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new UnsafeUpbitPrivateRequestError({
        violations: [`종료 주문 조회 start_time/end_time을 해석할 수 없습니다: 유효하지 않은 시간 형식입니다`],
      });
    }
    return { value: String(value), timestampMs: value };
  }

  // ISO 8601 문자열을 Date로 파싱해 Unix timestamp(ms)로 변환한다.
  const timestampMs = new Date(value).getTime();
  if (Number.isNaN(timestampMs)) {
    throw new UnsafeUpbitPrivateRequestError({
      violations: [`종료 주문 조회 start_time/end_time을 해석할 수 없습니다: 유효하지 않은 시간 형식입니다`],
    });
  }

  return { value: String(timestampMs), timestampMs };
}

function toListOpenOrdersQueryParams(input: UpbitPrivateListOpenOrdersInput): UpbitQueryParams {
  const violations: string[] = [];
  const params: UpbitQueryParams[number][] = [];
  const states = input.states ?? ["wait", "watch"];

  if (input.market !== undefined) {
    validateRequiredString(input.market, "체결 대기 주문 조회 market", violations);
    params.push({ key: "market", value: input.market });
  }

  if (states.length === 0) {
    violations.push("체결 대기 주문 조회 states[]는 비어 있을 수 없습니다");
  }
  for (const state of states) {
    if (state !== "wait" && state !== "watch") {
      violations.push("체결 대기 주문 조회 states[]는 wait 또는 watch만 허용합니다");
      break;
    }
  }
  if (states.length > 0) {
    // 예약 주문 대기(`watch`)가 reconcile 대상에서 빠지지 않도록 기본 조회도 배열형 상태 필터로 고정한다.
    params.push({ key: "states[]", value: states });
  }

  if (input.page !== undefined) {
    validatePositiveInteger(input.page, "체결 대기 주문 조회 page", violations);
    params.push({ key: "page", value: input.page });
  }

  if (input.limit !== undefined) {
    validatePositiveInteger(input.limit, "체결 대기 주문 조회 limit", violations);
    if (input.limit > 100) {
      // Upbit open orders limit 상한은 100이므로 과도한 pagination 요청을 거래소 호출 전에 닫는다.
      violations.push("체결 대기 주문 조회 limit은 100 이하여야 합니다");
    }
    params.push({ key: "limit", value: input.limit });
  }

  if (input.orderBy !== undefined) {
    if (input.orderBy !== "asc" && input.orderBy !== "desc") {
      violations.push("체결 대기 주문 조회 order_by는 asc 또는 desc 여야 합니다");
    }
    params.push({ key: "order_by", value: input.orderBy });
  }

  if (violations.length > 0) {
    throw new UnsafeUpbitPrivateRequestError({ violations });
  }

  return params;
}

function validateRequiredString(value: string, label: string, violations: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    violations.push(`${label} 값이 필요합니다`);
  }
}

function validatePositiveInteger(value: number, label: string, violations: string[]): void {
  if (!Number.isInteger(value) || value < 1) {
    violations.push(`${label}는 1 이상의 정수여야 합니다`);
  }
}

function validateOrderSide(side: string, violations: string[]): void {
  if (side !== "bid" && side !== "ask") {
    violations.push("주문 생성 side는 bid 또는 ask 여야 합니다");
  }
}

function toJsonBody(params: UpbitQueryParams): Record<string, UpbitQueryParamValue | readonly UpbitQueryParamValue[]> {
  const body: Record<string, UpbitQueryParamValue | readonly UpbitQueryParamValue[]> = {};
  for (const param of params) {
    body[param.key] = param.value;
  }

  return body;
}

async function createPrivateRestClientError(
  response: Response,
  rateLimitStatus: UpbitRateLimitStatus,
): Promise<UpbitPrivateRestClientError> {
  const upbitErrorName = await readUpbitErrorName(response);
  const kind = toPrivateErrorKind(response.status, upbitErrorName, rateLimitStatus);
  const trace: UpbitPrivateErrorTrace = {
    httpStatus: response.status,
    ...(upbitErrorName === undefined ? {} : { upbitErrorName }),
    rateLimitStatus,
  };

  return new UpbitPrivateRestClientError({
    status: response.status,
    statusText: response.statusText,
    kind,
    userMessage: toPrivateErrorUserMessage(kind),
    rateLimitStatus,
    trace,
  });
}

async function readUpbitErrorName(response: Response): Promise<string | undefined> {
  try {
    const payload = (await response.clone().json()) as UpbitProviderErrorPayload;
    return typeof payload.error?.name === "string" && payload.error.name.length > 0
      ? payload.error.name
      : undefined;
  } catch {
    return undefined;
  }
}

function toPrivateErrorKind(
  status: number,
  upbitErrorName: string | undefined,
  rateLimitStatus: UpbitRateLimitStatus,
): UpbitPrivateErrorKind {
  if (status === 418) {
    return "RATE_LIMIT_BLOCKED";
  }

  if (status === 403 || upbitErrorName === "out_of_scope") {
    return "PERMISSION_DENIED";
  }

  if (status === 401) {
    return "AUTHENTICATION_FAILED";
  }

  if (status === 429 || rateLimitStatus.kind === "THROTTLED") {
    return "RATE_LIMIT_THROTTLED";
  }

  if (rateLimitStatus.kind === "BLOCKED") {
    return "RATE_LIMIT_BLOCKED";
  }

  if (status >= 500) {
    return "PROVIDER_UNAVAILABLE";
  }

  return "REQUEST_FAILED";
}

function toPrivateErrorUserMessage(kind: UpbitPrivateErrorKind): string {
  if (kind === "AUTHENTICATION_FAILED") {
    return "Upbit 인증에 실패했습니다. API key, IP allowlist, nonce 시간을 확인하세요.";
  }

  if (kind === "PERMISSION_DENIED") {
    return "Upbit 권한이 부족합니다. pilot profile에 필요한 권한 증거를 다시 확인하세요.";
  }

  if (kind === "RATE_LIMIT_THROTTLED") {
    return "Upbit 요청 한도에 도달했습니다. 같은 smoke에서 추가 요청을 지연하거나 중단하세요.";
  }

  if (kind === "RATE_LIMIT_BLOCKED") {
    return "Upbit가 요청을 일시 차단했습니다. retry-after 이후 수동 확인이 필요합니다.";
  }

  if (kind === "PROVIDER_UNAVAILABLE") {
    return "Upbit 응답이 일시적으로 불안정합니다. 추가 주문 없이 수동 확인으로 전환하세요.";
  }

  if (kind === "INVALID_PROVIDER_RESPONSE") {
    return "Upbit 응답 형식이 예상과 다릅니다. 원문 응답을 저장하지 않고 수동 확인으로 전환합니다.";
  }

  return "Upbit private API 요청이 실패했습니다. 추적 정보를 기준으로 원인을 확인하세요.";
}

function createPrivateNetworkError(): UpbitPrivateRestClientError {
  const rateLimitStatus = createUpbitRateLimitStatus(0);

  return new UpbitPrivateRestClientError({
    status: 0,
    statusText: "NETWORK_ERROR",
    kind: "REQUEST_FAILED",
    userMessage: "Upbit private API에 연결하지 못했습니다. 추가 요청을 중단하고 네트워크 상태를 확인하세요.",
    rateLimitStatus,
    trace: {
      rateLimitStatus,
    },
  });
}

function createMalformedRateLimitHeaderError(response: Response): UpbitPrivateRestClientError {
  const rateLimitStatus = createUpbitRateLimitStatus(response.status);

  return new UpbitPrivateRestClientError({
    status: response.status,
    statusText: response.statusText,
    kind: "INVALID_PROVIDER_RESPONSE",
    userMessage: "Upbit 요청 제한 헤더를 해석하지 못했습니다. 원문 헤더를 저장하지 않고 수동 확인으로 전환합니다.",
    rateLimitStatus,
    trace: {
      httpStatus: response.status,
      rateLimitStatus,
    },
  });
}

function parseOptionalRemainingReqHeader(headers: Headers): UpbitRemainingReq | undefined {
  const headerValue = headers.get("remaining-req");

  if (headerValue === null) {
    return undefined;
  }

  return parseRemainingReqHeader(headerValue);
}

function parseOptionalRetryAfterHeader(headers: Headers): number | undefined {
  const retryAfter = headers.get("retry-after");

  if (retryAfter === null) {
    return undefined;
  }

  const seconds = Number.parseInt(retryAfter, 10);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : undefined;
}
