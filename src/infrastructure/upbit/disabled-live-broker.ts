import type { BrokerPort } from "../../application/ports/index.js";
import type {
  BrokerBalanceSnapshot,
  BrokerOrder,
  MarketCode,
  OrderSubmission,
} from "../../domain/index.js";

export interface DisabledUpbitLiveBrokerOptions {
  reason?: string;
}

/**
 * MVP에서 Upbit 실거래 broker 경로가 호출됐을 때 발생하는 차단 오류다.
 *
 * paper runtime은 `BrokerPort` 확장 경계를 유지하되, 실거래 주문/취소/잔고 private API는 v0.2 pilot 승인 전까지
 * 어떤 runtime 조립에서도 성공할 수 없어야 한다.
 */
export class UpbitLiveBrokerDisabledError extends Error {
  public readonly methodName: string;

  public constructor(methodName: string, reason: string) {
    super(`Upbit live broker is disabled for MVP: ${methodName} (${reason})`);
    this.name = "UpbitLiveBrokerDisabledError";
    this.methodName = methodName;
  }
}

/**
 * Upbit 실거래 broker의 disabled/stub 구현체다.
 *
 * 이 class는 `BrokerPort` shape만 만족하고 Upbit REST/WebSocket private client를 만들지 않는다. 실거래 broker가
 * future extension point로 남아 있어도, MVP 코드 경로에서 실주문 API 호출이 조용히 성공하지 않도록 모든 메서드를
 * 명시적으로 fail-closed한다.
 */
export class DisabledUpbitLiveBroker implements BrokerPort {
  private readonly reason: string;

  public constructor(options: DisabledUpbitLiveBrokerOptions = {}) {
    this.reason = options.reason ?? "live_trading_enabled=false and PAPER_NO_KEY runtime is active";
  }

  /** 실거래 주문 제출은 MVP에서 금지된다. */
  public async submitOrder(_order: OrderSubmission): Promise<BrokerOrder> {
    throw this.createDisabledError("submitOrder");
  }

  /** 실거래 주문 취소도 private 주문 API이므로 MVP에서 금지된다. */
  public async cancelOrder(_orderId: string): Promise<BrokerOrder> {
    throw this.createDisabledError("cancelOrder");
  }

  /** 실거래 주문 조회는 private 주문 API이므로 MVP에서 금지된다. */
  public async getOrder(_orderId: string): Promise<BrokerOrder | undefined> {
    throw this.createDisabledError("getOrder");
  }

  /** 실거래 미체결 주문 조회는 private 주문 API이므로 MVP에서 금지된다. */
  public async listOpenOrders(_market?: MarketCode): Promise<readonly BrokerOrder[]> {
    throw this.createDisabledError("listOpenOrders");
  }

  /** 실거래 잔고 조회는 private asset API이므로 MVP에서 금지된다. */
  public async getBalances(): Promise<BrokerBalanceSnapshot> {
    throw this.createDisabledError("getBalances");
  }

  private createDisabledError(methodName: string): UpbitLiveBrokerDisabledError {
    // stub이 호출되는 순간을 설정/조립 버그로 보고 외부 API 대신 명시적 오류로 닫는다.
    return new UpbitLiveBrokerDisabledError(methodName, this.reason);
  }
}

export function createDisabledUpbitLiveBroker(
  options: DisabledUpbitLiveBrokerOptions = {},
): DisabledUpbitLiveBroker {
  return new DisabledUpbitLiveBroker(options);
}
