# Upbit KRW Paper Trading MVP 업무 명세

작성일: 2026-05-13

## 1. 전제

MVP는 수익 극대화 제품이 아니다. 국내 원화 현물 기반에서 자동 주문 엔진, 비용 모델, 리스크 게이트, 알림, 감사 로그가 실제 시장 데이터로 사고 없이 작동하는지 검증하는 시스템이다.

MVP 정의:

```text
MVP = Upbit KRW 현물 + paper trading + 자동 주문 엔진 검증
```

실거래는 MVP 완료 기준이 아니라 v0.2 pilot 범위다.

## 2. 확정 결정

| ID | 결정 | MVP 반영 |
| --- | --- | --- |
| OQ-001 | MVP 거래소는 Upbit KRW 현물 | `UpbitKrwSpotAdapter`만 구현하고 다중 거래소 주문 실행은 제외 |
| OQ-002 | MVP 완료 기준은 paper trading | 실거래 주문 API 호출 없이 가상 주문/체결/잔고로 검증 |
| OQ-003 | 비용 기반 동적 안전마진 | 총비용 + 종목군별 safety buffer를 초과할 때만 거래 후보 허용 |
| OQ-004 | 보수적 손실·노출 한도 | 계정/전략/종목/주문/인프라 한도를 선적용 |
| OQ-005 | 1차 universe는 KRW-BTC, KRW-ETH | 알트는 phase 1.5에서 최대 3개까지 수동 편입 |
| OQ-006 | PostgreSQL + TimescaleDB, Redis/BullMQ MVP 제외 | 비동기 작업은 PostgreSQL `jobs` table 기반 DB-backed queue로 시작 |
| OQ-007 | 시장가 주문 기본 비활성 | 신규 진입 시장가 금지, emergency 축소는 공격적 지정가 우선 |
| OQ-008 | LLM 입력은 공식 Upbit 공지/정책/시장경보 | LLM은 리스크 분류기이며 매수/매도 신호를 만들 수 없음 |
| OQ-009 | MVP 알림은 Telegram 우선 | Slack은 인터페이스만 두고 비활성 |
| OQ-010 | 출금·송금·거래소 간 차익거래 제외 | 본인 계정, 국내 원화 현물, paper trading으로 제한 |

## 3. 운영 모드

### 3.1 MVP 기본 모드

```yaml
mvp:
  exchange: UPBIT
  market: KRW_SPOT
  mode: PAPER_TRADING
  live_trading_enabled: false
  withdrawal_enabled: false
  cross_exchange_arbitrage_enabled: false
  futures_enabled: false
```

MVP 기본 모드는 실거래 주문 API를 호출하지 않는다. 주문 생성, 취소, 체결, 잔고 변화는 `PaperBroker`가 모의 처리한다.

### 3.2 정책 동기화 주의점

Upbit `orders/chance`는 수수료율, 주문 가능 유형, 최소/최대 주문 가능 금액, 계정 잔고를 제공하지만 인증이 필요한 API다. 따라서 MVP는 다음 두 프로파일을 분리한다.

| 프로파일 | 목적 | API Key | 허용 |
| --- | --- | --- | --- |
| `PAPER_NO_KEY` | 기본 MVP 실행 | 없음 | 공개 시세, 마켓, 호가, 체결 데이터 |
| `POLICY_SYNC` | 정책 스냅샷 갱신 또는 통합 검증 | 주문조회 권한 등 최소 권한 | `orders/chance`, 주문 생성 테스트 등 |

`POLICY_SYNC`는 실거래 주문을 제출하지 않으며, 주문 권한이 필요한 경우에도 출금 권한은 절대 포함하지 않는다.

## 4. Exchange Adapter 범위

MVP 구현 대상은 `UpbitKrwSpotAdapter` 하나다. 인터페이스는 추후 다중 거래소 확장을 막지 않는 수준까지만 추상화한다.

필수 메서드:

```text
ExchangeAdapter
  - get_markets()
  - get_orderbook(market)
  - stream_trades(markets)
  - stream_orderbook(markets)
  - get_order_chance(market)
  - place_limit_order(order)
  - cancel_order(order_id)
  - get_order(order_id)
  - get_balances()
```

MVP paper runtime에서 `place_limit_order`, `cancel_order`, `get_order`, `get_balances`는 실제 Upbit 호출 대신 `PaperBroker` 구현으로 대체한다.

Upbit API 확인 기준:

- 페어 목록은 `GET /v1/market/all`을 사용하고 `market_event.warning`, `market_event.caution`을 universe 필터로 사용한다.
- 호가는 WebSocket `orderbook`을 사용하고 ask/bid price와 size를 수신한다.
- 내 주문/체결 스트림은 pilot 단계에서 WebSocket `myOrder`로 검증한다.
- 주문 가능 정보는 `GET /v1/orders/chance`를 정책 동기화 프로파일에서 사용한다.
- 주문 생성 테스트 API는 실주문 전 검증 후보로 둔다.

## 5. Universe 정책

### 5.1 Phase 1

MVP 기본 universe:

```yaml
universe:
  phase_1:
    - KRW-BTC
    - KRW-ETH
  auto_include_new_listing: false
  exclude_warning: true
  exclude_caution: true
  min_listing_age_days: 90
```

Phase 1에서는 BTC와 ETH만 거래 후보로 본다. 두 종목도 `warning = true` 또는 `caution = true`이면 신규 진입을 차단한다.

### 5.2 Phase 1.5 알트 편입 조건

알트는 자동 편입하지 않는다. 최대 3개까지 수동 승인하며 아래 조건을 모두 통과해야 한다.

- 30일 평균 거래대금 상위권
- 상장 후 90일 이상
- `market_event.warning = false`
- `market_event.caution = false`
- 최근 7일 스프레드 p95 기준 통과
- 주문금액 대비 예상 슬리피지 기준 통과
- 거래지원 종료, 유의종목, 입출금 이슈 공지가 없음

승인, 거부, 철회, 만료 판단은 조건별 snapshot을 포함한 audit evidence로 남긴다. 운영 표시는 `/status`의 safe runtime
summary와 deterministic daily report에서 확인하며, 실거래 주문 API나 Upbit private account API를 열지 않는다.

금지:

- 신규 상장 자동 편입
- 유의종목
- 주의 경보 종목
- 거래지원 종료 예정 종목
- 입출금 이슈가 있는 종목

## 6. 비용 모델

거래 허용 공식:

```text
cost_bps =
  entry_fee_bps
+ exit_fee_bps
+ spread_cost_bps_p75
+ expected_slippage_bps_p95
+ cancel_requote_penalty_bps

trade_allowed =
  expected_return_bps >= cost_bps + safety_buffer_bps
```

필수 측정값:

- `bid_fee`
- `ask_fee`
- `maker_bid_fee`
- `maker_ask_fee`
- 현재 스프레드
- 최근 1시간 스프레드 p50/p75/p95
- 주문 크기별 예상 슬리피지
- 부분체결률
- 주문 취소 후 재주문 빈도
- 신호 발생 후 체결까지 걸린 시간

기본 safety buffer:

| 종목군 | safety_buffer_bps | 처리 |
| --- | ---: | --- |
| BTC, ETH | 10 | 거래 후보 허용 가능 |
| 거래대금 상위 알트 | 20 | Phase 1.5 수동 편입 후 허용 가능 |
| 저유동성 알트 | N/A | 거래 금지 |
| 신규 상장/유의/주의 종목 | N/A | 거래 금지 |

Upbit 수수료는 이벤트와 계정 조건에 따라 달라질 수 있으므로, 실거래 전환 전에는 `orders/chance` 또는 정책 스냅샷으로 확인해야 한다.

## 7. 리스크 정책

기본 리스크 설정:

```yaml
risk:
  leverage_enabled: false
  daily_loss_limit_pct: 1.0
  weekly_loss_limit_pct: 3.0
  max_drawdown_pct: 5.0
  max_order_notional_pct: 1.0
  max_trade_loss_pct: 0.2
  max_btc_eth_position_pct_each: 20.0
  max_single_alt_position_pct: 5.0
  max_total_alt_position_pct: 15.0
  consecutive_loss_stop_count: 3
```

차단 조건:

- 일간 손실 -1% 도달
- 주간 손실 -3% 도달
- 전체 최대 낙폭 -5% 도달
- 1회 주문 금액이 계정 평가액의 1% 초과
- 1회 거래 예상 손실이 계정 평가액의 0.2% 초과
- BTC/ETH 단일 보유 한도 각 20% 초과
- 알트 단일 보유 한도 5% 초과
- 알트 전체 보유 한도 15% 초과
- 동일 전략 연속 손실 3회
- API 오류, 시세 지연, WebSocket 단절, 잔고 불일치
- Upbit 시장경보 또는 거래지원 종료/유의종목 관련 공식 공지 감지

Upbit KRW 마켓 최소 주문 가능 금액은 5,000 KRW 기준을 사용하되, 정책 변경 가능성을 고려해 구현에서는 정책값으로 주입한다.

## 8. 주문 정책

기본 설정:

```yaml
orders:
  default_order_type: LIMIT
  market_order_enabled: false
  entry_market_order_enabled: false
  post_only_preferred: true
  aggressive_limit_exit_enabled: true
```

시장가 주문 금지:

- 신규 진입 시장가 금지
- 저유동성 알트 시장가 금지
- 뉴스/공지 직후 시장가 금지
- API 지연 중 시장가 금지
- 잔고 불일치 상태 시장가 금지

Emergency 축소 후보:

```yaml
market_order:
  enabled: false
  allow_entry: false
  allow_exit: false
aggressive_limit_exit:
  enabled: true
  requires_emergency_mode: true
  max_slippage_bps:
    BTC_ETH: 15
    TOP_ALT: 30
  max_notional_pct: 1.0
```

공격적 지정가 예시:

```text
매수 축소/전환 필요 시:
  limit_price = best_ask * (1 + max_slippage_bps)

매도 축소 필요 시:
  limit_price = best_bid * (1 - max_slippage_bps)

time_in_force = IOC
```

MVP에서는 emergency 축소도 paper trading으로만 검증한다. 실제 시장가 또는 IOC/FOK 실주문은 v0.2 pilot 승인 전까지 호출하지 않는다.

## 9. 저장소 정책

MVP 저장소:

```yaml
storage:
  primary: PostgreSQL
  timeseries: TimescaleDB
  queue: PostgreSQL jobs table
  cache: none_for_mvp
  analytics_later: ClickHouse
```

PostgreSQL 일반 테이블:

- `orders`
- `order_events`
- `fills`
- `balances`
- `positions`
- `audit_events`
- `strategy_configs`
- `risk_events`
- `alerts`
- `policy_snapshots`
- `jobs`

TimescaleDB hypertable:

- `trades`
- `candles`
- `orderbook_snapshots`
- `orderbook_metrics`
- `strategy_signals`
- `pnl_snapshots`

DB-backed queue:

- `jobs.id`
- `jobs.job_type`
- `jobs.idempotency_key`
- `jobs.payload_json`
- `jobs.status`
- `jobs.run_after`
- `jobs.locked_at`
- `jobs.locked_by`
- `jobs.attempt_count`
- `jobs.max_attempts`
- `jobs.last_error`

Redis와 BullMQ는 MVP에서 제외한다. 주문, 체결, 리스크, audit, 알림, 정책 스냅샷, 비동기 job 상태의 기준 기록은 PostgreSQL/TimescaleDB에 남긴다.

ClickHouse는 MVP에서 보류한다. 다거래소, 다종목, tick/orderbook 원천 장기 저장 단계에서 분석 전용 저장소로 재검토한다.

## 10. LLM 정책

MVP LLM 입력:

```yaml
llm:
  enabled: true
  can_generate_trade_signal: false
  allowed_sources:
    - exchange_notice
    - developer_changelog
    - market_event
  allowed_actions:
    - NO_ACTION
    - BLOCK_NEW_ENTRY
    - CANCEL_PENDING
    - PAUSE_STRATEGY
    - ALERT_ONLY
```

포함:

- Upbit 공지
- Upbit Developer Center changelog
- `market_event.warning`
- `market_event.caution`
- 거래지원 종료/유의종목 관련 공지
- 점검/장애 공지

제외:

- 일반 뉴스
- SNS
- 커뮤니티
- 유튜브
- 루머성 텔레그램

출력 스키마:

```json
{
  "risk_level": "NONE | LOW | MEDIUM | HIGH | CRITICAL",
  "affected_markets": ["KRW-BTC"],
  "event_type": "DELISTING | CAUTION | MAINTENANCE | API_CHANGE | FEE_CHANGE | UNKNOWN",
  "recommended_action": "NO_ACTION | BLOCK_NEW_ENTRY | CANCEL_PENDING | PAUSE_STRATEGY | ALERT_ONLY",
  "reason": "..."
}
```

`recommended_action`에는 `BUY`, `SELL`, `INCREASE_POSITION` 같은 주문 허용 또는 포지션 확대 액션을 둘 수 없다.

## 11. 알림 정책

MVP 기본 알림:

```yaml
alerts:
  primary_channel: Telegram
  slack_adapter: defined_but_disabled
  p0_requires_new_order_block: true
```

인터페이스:

```text
Notifier
  - send_info()
  - send_warning()
  - send_critical()
  - send_daily_report()
```

심각도:

| 등급 | 예시 | 처리 |
| --- | --- | --- |
| P0 | 포지션 보유 중 데이터 지연, 주문/잔고 불일치, 손실 한도 도달, API 인증 실패 | 즉시 알림, 신규 주문 중지 |
| P1 | 슬리피지 초과, 주문 일부 미체결, WebSocket 재연결 | 알림, 전략별 주의 |
| P2 | 주문 체결, 전략 신호, 일간 리포트 | 요약 또는 낮은 우선순위 |
| P3 | 백테스트 완료, 모델 학습 완료 | 로그 중심 |

## 12. 보안·컴플라이언스 경계

MVP 허용:

- 본인 계정
- 국내 원화 현물
- 공개 시세 조회
- 주문 조회 정책 동기화
- paper trading

v0.2 pilot 후보:

- 소액 실거래
- 자산 조회
- 주문 조회
- 주문 생성/취소

MVP 금지:

- 출금 API 권한
- 입출금 자동화
- 거래소 간 차익거래
- 해외 거래소 자동 연동
- 선물/레버리지
- 타인 계정 연결
- 타인 자금 운용
- 신호 판매

세무와 감사 로그 보존 후보:

- 매수 체결가
- 매도 체결가
- 수수료
- 체결 시각
- 주문 ID
- 종목
- 수량
- 원화 환산금액
- 실현손익
- 모델/전략 버전

## 13. MVP 완료 조건

- [ ] Upbit KRW public market data를 실시간으로 수집한다.
- [ ] `KRW-BTC`, `KRW-ETH` universe가 정책 기준으로 생성된다.
- [ ] `warning` 또는 `caution` 종목은 신규 진입 후보에서 제외된다.
- [ ] 모든 주문 후보는 동적 비용 모델과 safety buffer를 통과해야 한다.
- [ ] 모든 주문 후보는 리스크 게이트 승인 또는 거부 기록을 남긴다.
- [ ] paper trading에서 주문 생성, 취소, 부분체결, 재호가, 가상 잔고 변경을 기록한다.
- [ ] 실거래 주문 API가 호출되지 않았음을 테스트로 확인한다.
- [ ] Telegram P0 알림은 신규 주문 차단과 함께 발생한다.
- [ ] LLM 출력만으로 주문 후보가 생성되지 않는다.
- [ ] 출금, 송금, 선물, 레버리지, 거래소 간 차익거래 경로가 없다.
- [ ] 일간 리포트가 전략별 PnL, 수수료 추정, 슬리피지, 차단 사유를 포함한다.

## 14. 구현 업무 분해 후보

| 업무 ID | 업무 | 산출물 |
| --- | --- | --- |
| WORK-001 | Upbit public market data adapter | 체결/호가/티커 수집, rate limit 처리 |
| WORK-002 | policy snapshot과 `orders/chance` contract | 수수료, 최소 주문금액, 주문 유형, 호가 단위 정책 모델 |
| WORK-003 | universe manager | BTC/ETH phase 1, warning/caution 차단, phase 1.5 후보 필터 |
| WORK-004 | dynamic cost model | 비용 bps 계산, safety buffer, 폐기 사유 기록 |
| WORK-005 | risk gate | 손실/노출/인프라/시장경보 차단 |
| WORK-006 | paper broker | 가상 주문, 가상 체결, 가상 잔고, idempotency |
| WORK-007 | event-based backtest bridge | paper broker와 같은 비용/리스크 게이트 재사용 |
| WORK-008 | storage schema | PostgreSQL/TimescaleDB 테이블, DB-backed jobs queue |
| WORK-009 | Telegram notifier | P0/P1/P2/P3 알림, 일간 리포트 |
| WORK-010 | LLM risk classifier | 공식 Upbit 입력만 사용, 주문 허용 액션 금지 |
| WORK-011 | security guard | API key redaction, 출금 권한 금지, 실거래 비활성 테스트 |

## 15. 테스트 요구사항

- 단위 테스트:
  - 동적 비용 공식
  - safety buffer 판정
  - 리스크 한도 위반 차단
  - universe warning/caution 차단
  - LLM 출력 스키마와 금지 액션 검증
- 통합 테스트:
  - WebSocket 단절과 재연결
  - paper trading에서 주문 API 미호출
  - P0 이벤트 발생 시 신규 주문 차단과 Telegram 알림 후보 생성
  - 정책 스냅샷 변경 시 주문 검증 결과 변경
- 수동 테스트:
  - Upbit Developer Center 정책과 로컬 정책 스냅샷 비교
  - 24시간 paper trading 리포트 검토
  - API Key 없이 MVP 기본 모드가 실행되는지 확인
  - 정책 동기화 프로파일이 출금 권한 없이 동작하는지 확인

## 16. 참고 출처

- Upbit: [페어 목록 조회](https://docs.upbit.com/kr/kr/reference/list-trading-pairs)
- Upbit: [페어별 주문 가능 정보 조회](https://docs.upbit.com/kr/reference/available-order-information)
- Upbit: [요청 수 제한](https://docs.upbit.com/kr/reference/rate-limits)
- Upbit: [호가 WebSocket](https://docs.upbit.com/kr/reference/websocket-orderbook)
- Upbit: [내 주문 및 체결 WebSocket](https://docs.upbit.com/kr/reference/websocket-myorder)
- Upbit: [주문 생성](https://docs.upbit.com/kr/reference/new-order)
- Upbit: [주문 생성 테스트](https://docs.upbit.com/kr/reference/order-test)
- Upbit: [KRW 마켓 주문 가격 단위와 최소 주문 가능 금액](https://docs.upbit.com/kr/docs/krw-market-info)
- Upbit: [API Key 발급](https://docs.upbit.com/kr/docs/api-key)
- 금융위원회: [가상자산시장 불공정거래 조사체계 가동](https://www.fsc.go.kr/no010101/82625?curPage=4&srchBeginDt=2024-07-01&srchCtgry=&srchEndDt=2024-07-31&srchKey=sj&srchText=)
- 국세청: [거주자의 가상자산소득 과세 개요](https://g.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=238935&mi=40370)
