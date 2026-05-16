import type {
  ExchangePolicySnapshot,
  FeePolicy,
  MarketPolicy,
  MarketStatus,
  OrderRulePolicy,
} from "../../domain/index.js";
import type { MarketCode } from "../../domain/index.js";

/**
 * 거래소 정책 조회 책임을 분리하는 application port다.
 *
 * 주문 가능 market, 시장경보, 호가 단위, 최소 주문금액, 수수료 같은 정책값을 제공한다. 정책 수치는
 * 코드 상수로 고정하지 않고 설정, DB snapshot, 또는 거래소 API 응답에서 adapter가 주입한다.
 */
export interface ExchangePolicyPort {
  /** 거래소가 제공하는 market 정책 목록을 조회한다. */
  getMarkets(): Promise<readonly MarketPolicy[]>;
  /** 단일 market의 거래 가능 상태와 warning/caution 상태를 조회한다. */
  getMarketStatus(market: MarketCode): Promise<MarketStatus>;
  /** 주문 전 검증에 필요한 호가 단위와 최소 주문금액 규칙을 조회한다. */
  getOrderRules(market: MarketCode): Promise<OrderRulePolicy>;
  /** 비용 계산에 사용할 현재 수수료 정책을 조회한다. */
  getFees(market: MarketCode): Promise<FeePolicy>;
  /** 주문 전 검증과 audit에 남길 정책 snapshot 전체를 조회한다. */
  getPolicySnapshot(market: MarketCode): Promise<ExchangePolicySnapshot>;
}
