# 런타임 설정

이 문서는 Seemirai runtime을 어떤 안전 경계로 조립하는지 설명한다. `config/paper.json`은 MVP 기본 paper trading profile이며, API key 없이 로딩되어야 한다.

구현 기준:

- schema: `src/runtime/config.ts`
- registry 활성화 schema: `src/runtime/registry-config.ts`
- 기본 profile: `config/paper.json`

## 책임

`config/paper.json`은 실행 시 켤 exchange, universe, strategy, rule 조합과 안전 toggle을 정의한다. 가능한 exchange, strategy, rule 목록은 코드 registry가 갖고, config는 그중 활성화할 항목만 고른다.

이 파일은 secret 저장소가 아니다. API key, Telegram token, local control token 같은 값은 git에 커밋하지 않는다.

## 최상위 구조

| 필드 | 허용값 또는 기본값 | 역할 |
| --- | --- | --- |
| `exchange` | `UPBIT` | MVP 거래소 제품 범위 |
| `market` | `KRW_SPOT` | MVP 시장 범위 |
| `mode` | `PAPER_TRADING` | 실거래 주문 없이 paper runtime으로 실행 |
| `live_trading_enabled` | `false` 필수 | 실거래 주문 API 경로 차단 |
| `withdrawal_enabled` | `false` 필수 | 출금 권한과 출금 자동화 차단 |
| `cross_exchange_arbitrage_enabled` | `false` 필수 | 거래소 간 송금/환전 차익거래 차단 |
| `futures_enabled` | `false` 필수 | 선물 범위 차단 |
| `leverage_enabled` | `false` 필수 | 레버리지 범위 차단 |
| `market_order_enabled` | `false` 필수 | 시장가 주문 기본 차단 |
| `entry_market_order_enabled` | `false` 필수 | 신규 진입 시장가 주문 차단 |
| `paper_no_key` | `true` 필수 | paper mode가 API key 없이 시작됨을 보장 |
| `universe` | `KRW-BTC`, `KRW-ETH` | MVP 거래 후보 universe |
| `llm` | trade signal 생성 불가 | LLM이 매매 판단을 직접 만들지 못하게 제한 |
| `registry` | 정적 registry id 참조 | exchange, strategy, rule 활성화 조합 |
| `strategyParameters` | strategy별 기본 threshold | 전략 후보 생성과 rule 평가에 쓰는 보수적 기준값 |
| `secrets` | 기본 `{}` | schema shape만 표현하며 실제 secret은 저장하지 않음 |

## 안전 invariant

MVP 기본 profile에서는 다음 값이 켜져 있으면 안 된다.

```json
{
  "live_trading_enabled": true,
  "withdrawal_enabled": true,
  "cross_exchange_arbitrage_enabled": true,
  "futures_enabled": true,
  "leverage_enabled": true,
  "market_order_enabled": true,
  "entry_market_order_enabled": true,
  "paper_no_key": false
}
```

`assertSafeRuntimeConfig`는 위반 값을 발견하면 runtime config 로딩을 실패시킨다.

## PAPER_NO_KEY market data runtime

구현 기준:

- assembly: `src/runtime/market-data-runtime.ts`
- Upbit public WebSocket endpoint: `wss://api.upbit.com/websocket/v1`
- 기본 consumer id: `paper-no-key-market-data-worker`

`PAPER_NO_KEY` market data runtime은 `config/paper.json`을 로딩한 뒤 다음 조건을 추가로 검증한다.

- `exchange=UPBIT`, `market=KRW_SPOT`, `mode=PAPER_TRADING`이어야 한다.
- `registry.exchangeId=upbit_krw_spot`이어야 한다.
- `paper_no_key=true`이어야 한다.
- `secrets.upbit_access_key`, `secrets.upbit_secret_key`가 없어야 한다.
- WebSocket subscription message에는 `Authorization`, `Bearer`, private path, `myOrder`, `myAsset`, `orders/chance`, `/v1/orders` 후보가 없어야 한다.

runtime assembly는 `universe.phase_1`의 `KRW-BTC`, `KRW-ETH`에 대해 공개 `trade`, `orderbook` subscription만 만든다. 이 단계는
실제 주문, 잔고, 인증 API client를 생성하지 않는다.

market data status event는 다음 방식으로 저장 경계를 지난다.

| status | audit_events | risk_events | 신규 주문 차단 입력 |
| --- | --- | --- | --- |
| `CONNECTED` | `MARKET_DATA_STATUS`, `INFO` | 없음 | false |
| `STALE` | `MARKET_DATA_STATUS`, `WARN` | `stale_market_data`, `BLOCK_NEW_ORDERS` | true |
| `RECONNECTING` | `MARKET_DATA_STATUS`, `WARN` | `market_data_reconnecting`, `BLOCK_NEW_ORDERS` | true |
| `DISCONNECTED` | `MARKET_DATA_STATUS`, `ERROR` | `market_data_disconnected`, `BLOCK_NEW_ORDERS` | true |

M3는 실제 RiskGate state machine을 구현하지 않고 위 차단 입력 신호까지만 만든다. RiskGate 상태 전이와 주문 차단 적용은 M5 범위다.

## Universe 구조

```json
{
  "universe": {
    "phase_1": ["KRW-BTC", "KRW-ETH"],
    "auto_include_new_listing": false,
    "exclude_warning": true,
    "exclude_caution": true
  }
}
```

- `phase_1`: MVP 기본 거래 후보 market. 현재는 `KRW-BTC`, `KRW-ETH`만 허용한다.
- `auto_include_new_listing`: 신규 상장 자동 편입 금지.
- `exclude_warning`, `exclude_caution`: Upbit 시장경보 또는 주의 상태일 때 신규 진입 차단.

## Registry 구조

```json
{
  "registry": {
    "exchangeId": "upbit_krw_spot",
    "strategies": [
      {
        "id": "trend_following",
        "enabled": true,
        "ruleIds": ["universe_allowed", "risk_ok"]
      }
    ]
  }
}
```

허용 exchange id:

- `upbit_krw_spot`

허용 strategy id:

- `trend_following`
- `mean_reversion`

허용 rule id:

- `universe_allowed`
- `market_warning_absent`
- `spread_ok`
- `depth_sufficient`
- `cost_margin_ok`
- `risk_ok`
- `stop_loss`
- `take_profit`

규칙:

- 존재하지 않는 exchange, strategy, rule id는 fail-fast한다.
- `registry`와 `strategies[]`의 알 수 없는 키는 오타로 간주해 fail-fast한다.
- `strategies[].enabled=false`인 strategy는 활성 resolution 결과에서 제외된다.
- `strategies[].ruleIds`는 비어 있으면 안 된다.
- 같은 strategy id를 중복 선언하면 안 된다.

## Strategy Parameters 구조

구현 기준:

- schema: `src/runtime/strategy-parameters.ts`
- 기본 profile: `config/paper.json`

`strategyParameters`는 strategy id별 threshold를 명시한다. 모든 금융 값은 Decimal로 파싱 가능한 string이어야 하며, JS number는 정밀도와 단위 혼동을 피하기 위해 거부한다. 알 수 없는 strategy id나 threshold key는 오타로 간주해 fail-fast한다.

```json
{
  "strategyParameters": {
    "trend_following": {
      "max_spread_bps": "8",
      "min_depth_krw": "50000000",
      "breakout_lookback_buckets": 20,
      "min_trade_strength": "1.2",
      "min_orderbook_imbalance": "0.08"
    },
    "mean_reversion": {
      "max_spread_bps": "6",
      "min_depth_krw": "70000000",
      "entry_deviation_bps": "25",
      "exit_deviation_bps": "8",
      "stop_loss_bps": "35"
    }
  }
}
```

| strategy | threshold | 기본값 | 단위 | 보수적 조정 방향 |
| --- | --- | ---: | --- | --- |
| `trend_following` | `max_spread_bps` | `8` | bps | 낮출수록 넓은 spread 후보를 더 많이 차단 |
| `trend_following` | `min_depth_krw` | `50000000` | KRW | 높일수록 유동성이 부족한 후보를 더 많이 차단 |
| `trend_following` | `breakout_lookback_buckets` | `20` | feature bucket 수 | 높일수록 짧은 돌파 신호를 덜 신뢰 |
| `trend_following` | `min_trade_strength` | `1.2` | ratio | 높일수록 약한 체결강도 후보를 더 많이 차단 |
| `trend_following` | `min_orderbook_imbalance` | `0.08` | 0~1 ratio | 높일수록 약한 호가 불균형 후보를 더 많이 차단 |
| `mean_reversion` | `max_spread_bps` | `6` | bps | 낮출수록 넓은 spread 후보를 더 많이 차단 |
| `mean_reversion` | `min_depth_krw` | `70000000` | KRW | 높일수록 유동성이 부족한 후보를 더 많이 차단 |
| `mean_reversion` | `entry_deviation_bps` | `25` | bps | 높일수록 진입 신호를 더 드물게 허용 |
| `mean_reversion` | `exit_deviation_bps` | `8` | bps | 낮출수록 더 빨리 평균 복귀 청산 후보를 만든다 |
| `mean_reversion` | `stop_loss_bps` | `35` | bps | 낮출수록 손절 후보를 더 빨리 만든다 |

M4의 `risk_ok` rule은 RiskGate 활성 승인 구현이 아니다. `risk_ok`는 registry/config contract에 남기되, M5 전까지는 `risk_ok_placeholder` WARN으로 평가해 실행 승인으로 해석되지 않게 한다.

## 변경 절차

설정 구조나 허용 id를 바꾸면 다음을 함께 확인한다.

1. `src/runtime/config.ts` 또는 `src/runtime/registry-config.ts`
2. `src/runtime/strategy-parameters.ts`
3. `src/application/registry.ts`
4. `config/paper.json`
5. 관련 unit test
6. 이 문서와 기준 설계 문서

검증 명령:

```sh
corepack pnpm typecheck
corepack pnpm test
./scripts/verify
```
