import type {
  MarketDataStreamRequest,
  MarketDataStatusEvent,
  OrderbookEvent,
  TickerSnapshot,
  TradeEvent,
} from "../../domain/index.js";
import type { MarketCode } from "../../domain/index.js";

/**
 * 거래소 시세 수집 adapter가 구현해야 하는 application port다.
 *
 * 전략과 feature engine은 이 port만 보고 trade, orderbook, ticker 데이터를 읽는다. Upbit WebSocket
 * payload나 재연결 구현 세부사항은 infrastructure adapter 안에 숨긴다.
 */
export interface MarketDataPort {
  /** 체결 stream과 연결 상태 이벤트를 동일한 async stream으로 전달한다. */
  streamTrades(request: MarketDataStreamRequest): AsyncIterable<TradeEvent | MarketDataStatusEvent>;
  /** 호가 stream과 stale/reconnect 같은 상태 이벤트를 동일한 async stream으로 전달한다. */
  streamOrderbook(request: MarketDataStreamRequest): AsyncIterable<OrderbookEvent | MarketDataStatusEvent>;
  /** ticker stream과 stale/reconnect 같은 상태 이벤트를 동일한 async stream으로 전달한다. */
  streamTicker(request: MarketDataStreamRequest): AsyncIterable<TickerSnapshot | MarketDataStatusEvent>;
  /** 초기화, 재연결 복구, fixture 검증에 사용할 단건 호가 snapshot을 조회한다. */
  getOrderbook(market: MarketCode): Promise<OrderbookEvent>;
  /** 특정 market의 현재 ticker snapshot을 조회한다. */
  getTicker(market: MarketCode): Promise<TickerSnapshot>;
}
