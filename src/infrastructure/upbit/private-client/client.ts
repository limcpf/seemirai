import { randomUUID } from "node:crypto";
import {
  createUpbitRateLimitStatus,
  parseRemainingReqHeader,
} from "../rate-limit.js";
import { buildUpbitAuthorizationHeader, buildUpbitQueryString } from "./auth.js";
import {
  UPBIT_PRIVATE_API_BASE_URL,
  UnsafeUpbitPrivateRequestError,
  UpbitPrivateRestClientError,
} from "./types.js";
import type {
  UpbitPrivateCredentials,
  UpbitPrivateErrorKind,
  UpbitPrivateErrorTrace,
  UpbitPrivateGetOrderInput,
  UpbitPrivateRequestMethod,
  UpbitPrivateRestClientOptions,
  UpbitPrivateRestResponse,
  UpbitQueryParams,
} from "./types.js";
import type { UpbitRateLimitStatus, UpbitRemainingReq } from "../rate-limit.js";

interface UpbitPrivateRequestInput {
  method: UpbitPrivateRequestMethod;
  pathname: string;
  queryParams?: UpbitQueryParams;
}

interface UpbitProviderErrorPayload {
  error?: {
    name?: unknown;
    message?: unknown;
  };
}

/**
 * Upbit private REST client foundation이다.
 *
 * 이 client는 JWT 인증, query hash, rate-limit envelope, 실패 정규화만 담당한다. 기본 `PAPER_NO_KEY` runtime에서 자동
 * 생성하지 않고, pilot env guard를 통과한 runner가 명시적으로 조립해야 한다. 주문 생성/취소 side effect method는 sub PR 3
 * 범위에서 제공하지 않는다.
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
      queryParams: toOrderLookupQueryParams(input),
    });
  }

  private async requestJson<TPayload = unknown>(
    input: UpbitPrivateRequestInput,
  ): Promise<UpbitPrivateRestResponse<TPayload>> {
    const queryString = buildUpbitQueryString(input.queryParams);
    const url = this.buildUrl(input.pathname, queryString);
    const headers = new Headers({
      accept: "application/json",
      authorization: buildUpbitAuthorizationHeader({
        accessKey: this.credentials.accessKey,
        secretKey: this.credentials.secretKey,
        nonce: this.nonceFactory(),
        queryString,
      }),
    });

    const response = await this.fetchFn(url, {
      method: input.method,
      headers,
    });
    const remainingReq = parseOptionalRemainingReqHeader(response.headers);
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

function toOrderLookupQueryParams(input: UpbitPrivateGetOrderInput): UpbitQueryParams {
  if (input.uuid !== undefined && input.identifier !== undefined) {
    throw new UnsafeUpbitPrivateRequestError({
      violations: ["주문 조회 식별자는 uuid 또는 identifier 중 하나만 지정해야 합니다"],
    });
  }

  if (input.uuid === undefined && input.identifier === undefined) {
    throw new UnsafeUpbitPrivateRequestError({
      violations: ["주문 조회에는 uuid 또는 identifier가 필요합니다"],
    });
  }

  return input.uuid === undefined
    ? [{ key: "identifier", value: input.identifier! }]
    : [{ key: "uuid", value: input.uuid }];
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
  if (rateLimitStatus.kind === "BLOCKED") {
    return "RATE_LIMIT_BLOCKED";
  }

  if (rateLimitStatus.kind === "THROTTLED" || status === 429) {
    return "RATE_LIMIT_THROTTLED";
  }

  if (status === 401) {
    return "AUTHENTICATION_FAILED";
  }

  if (status === 403 || upbitErrorName === "out_of_scope") {
    return "PERMISSION_DENIED";
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
