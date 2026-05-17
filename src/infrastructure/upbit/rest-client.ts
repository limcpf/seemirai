import {
  UpbitMarketListResponseSchema,
  UpbitOrderbookInstrumentsResponseSchema,
} from "./schemas.js";
import type { UpbitMarket, UpbitOrderbookInstrument } from "./schemas.js";
import {
  createUpbitRateLimitStatus,
  parseRemainingReqHeader,
} from "./rate-limit.js";
import type { UpbitRateLimitStatus, UpbitRemainingReq } from "./rate-limit.js";

/**
 * Upbit public REST client 생성 옵션이다.
 *
 * 기본값은 실 Upbit quotation endpoint이며, test는 `fetchFn`을 주입해 인증 없이 deterministic fixture
 * 흐름을 검증한다.
 */
export interface UpbitRestClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

/**
 * Upbit public REST 응답 envelope이다.
 *
 * payload와 함께 `Remaining-Req` 기반 rate-limit 상태를 항상 반환해, caller가 정책 snapshot과 scheduler
 * 판단을 같은 응답에서 만들 수 있게 한다.
 */
export interface UpbitRestResponse<TPayload> {
  payload: TPayload;
  remainingReq?: UpbitRemainingReq;
  rateLimitStatus: UpbitRateLimitStatus;
}

/**
 * Upbit REST 비정상 응답 error다.
 *
 * 429/418 같은 요청 제한도 단순 실패로 버리지 않고 rate-limit 상태를 함께 담아 상위 worker가 backoff,
 * audit, 신규 주문 차단 후보 이벤트로 연결할 수 있게 한다.
 */
export class UpbitRestClientError extends Error {
  public readonly status: number;
  public readonly rateLimitStatus: UpbitRateLimitStatus;

  public constructor(status: number, statusText: string, rateLimitStatus: UpbitRateLimitStatus) {
    super(`Upbit REST request failed: ${status} ${statusText}`);
    this.name = "UpbitRestClientError";
    this.status = status;
    this.rateLimitStatus = rateLimitStatus;
  }
}

/**
 * Upbit 공개 quotation REST client다.
 *
 * MVP `PAPER_NO_KEY` 흐름에서 API key 없이 market list와 orderbook instruments만 조회한다. 인증/거래
 * API는 이 client에 넣지 않고 후속 policy-sync 또는 broker 경계에서 별도 승인 후 다룬다.
 */
export class UpbitPublicRestClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  public constructor(options: UpbitRestClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://api.upbit.com";
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /**
   * Upbit market 목록을 조회한다.
   *
   * 기본값은 `is_details=true`다. 시장경보 누락은 안전하지 않으므로 mapper 단계에서 tradable=false로
   * 정규화되지만, 정상 runtime에서는 상세 조회를 기본으로 사용한다.
   */
  public async getMarkets(options: { isDetails?: boolean } = {}): Promise<UpbitRestResponse<readonly UpbitMarket[]>> {
    const url = this.buildUrl("/v1/market/all");
    url.searchParams.set("is_details", String(options.isDetails ?? true));

    const response = await this.requestJson(url);
    return {
      ...response,
      payload: UpbitMarketListResponseSchema.parse(response.payload),
    };
  }

  /**
   * 지정 market들의 orderbook instrument 정책을 조회한다.
   *
   * 이 endpoint의 `tick_size`는 현재 가격 기준 값이므로 주문 검증용 전체 가격 band가 아니다. caller는
   * 결과를 raw policy 근거로 보존하고 별도 `PRICE_BANDS`를 주입해야 한다.
   */
  public async getOrderbookInstruments(
    markets: readonly string[],
  ): Promise<UpbitRestResponse<readonly UpbitOrderbookInstrument[]>> {
    const url = this.buildUrl("/v1/orderbook/instruments");
    url.searchParams.set("markets", markets.join(","));

    const response = await this.requestJson(url);
    return {
      ...response,
      payload: UpbitOrderbookInstrumentsResponseSchema.parse(response.payload),
    };
  }

  private buildUrl(pathname: string): URL {
    return new URL(pathname, this.baseUrl);
  }

  /**
   * 공통 GET JSON 호출 흐름이다.
   *
   * 모든 public REST 호출은 여기서 `Remaining-Req`를 먼저 해석한 뒤 schema parsing으로 넘어간다. 실패
   * 응답도 rate-limit 상태를 보존한 error로 올려 후속 worker가 같은 기준으로 복구한다.
   */
  private async requestJson(url: URL): Promise<UpbitRestResponse<unknown>> {
    const response = await this.fetchFn(url);
    const remainingReq = parseOptionalRemainingReqHeader(response.headers);
    const retryAfterSeconds = parseOptionalRetryAfterHeader(response.headers);
    const rateLimitStatus = createUpbitRateLimitStatus(
      response.status,
      remainingReq,
      retryAfterSeconds,
    );

    if (!response.ok) {
      throw new UpbitRestClientError(response.status, response.statusText, rateLimitStatus);
    }

    const payload: unknown = await response.json();

    return {
      payload,
      ...(remainingReq === undefined ? {} : { remainingReq }),
      rateLimitStatus,
    };
  }
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
