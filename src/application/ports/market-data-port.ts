import type {
  MarketDataStreamRequest,
  MarketDataStatusEvent,
  OrderbookEvent,
  TickerSnapshot,
  TradeEvent,
} from "../../domain/index.js";
import type { MarketCode } from "../../domain/index.js";

export interface MarketDataPort {
  streamTrades(request: MarketDataStreamRequest): AsyncIterable<TradeEvent | MarketDataStatusEvent>;
  streamOrderbook(request: MarketDataStreamRequest): AsyncIterable<OrderbookEvent | MarketDataStatusEvent>;
  getTicker(market: MarketCode): Promise<TickerSnapshot>;
}

