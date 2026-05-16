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

export interface UpbitRestClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface UpbitRestResponse<TPayload> {
  payload: TPayload;
  remainingReq?: UpbitRemainingReq;
  rateLimitStatus: UpbitRateLimitStatus;
}

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

export class UpbitPublicRestClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  public constructor(options: UpbitRestClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://api.upbit.com";
    this.fetchFn = options.fetchFn ?? fetch;
  }

  public async getMarkets(options: { isDetails?: boolean } = {}): Promise<UpbitRestResponse<readonly UpbitMarket[]>> {
    const url = this.buildUrl("/v1/market/all");
    url.searchParams.set("is_details", String(options.isDetails ?? true));

    const response = await this.requestJson(url);
    return {
      ...response,
      payload: UpbitMarketListResponseSchema.parse(response.payload),
    };
  }

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
