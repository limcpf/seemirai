import type { ExchangeId, MarketCode, MarketEvent, TimestampInput } from "../../domain/index.js";

/**
 * historical event replay 범위를 지정하는 요청이다.
 *
 * backtest bridge는 이 요청으로 fixture, DB, object storage 등 실제 source 종류와 무관하게 같은 MarketEvent stream을
 * 요청한다. from/to는 eventTimestamp 기준이며, sourceId는 특정 fixture나 snapshot batch를 지정할 때 사용한다.
 */
export interface HistoricalEventReplayRequest {
  exchangeId?: ExchangeId;
  markets?: readonly MarketCode[];
  from?: TimestampInput;
  to?: TimestampInput;
  sourceId?: string;
  limit?: number;
}

/**
 * backtest orchestrator가 과거 market event를 읽기 위해 의존하는 application port다.
 *
 * runtime worker lifecycle, network adapter, DB cursor 구현은 이 port 밖에 둔다. 구현체는 반환 stream이
 * `compareMarketEvents` 기준으로 deterministic하게 정렬되어 있음을 보장해야 한다.
 */
export interface HistoricalEventSource {
  replay(request?: HistoricalEventReplayRequest): AsyncIterable<MarketEvent>;
}
