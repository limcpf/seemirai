# M11 전략/피처 품질 보강 계약

- 상태: accepted
- 날짜: 2026-05-25
- 관련 문서:
  - [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md)
  - [`../PRD.md`](../PRD.md)
  - [`../FEATURE_REQUIREMENTS.md`](../FEATURE_REQUIREMENTS.md)
  - [`../RUNTIME_CONFIG.md`](../RUNTIME_CONFIG.md)
  - [`../exec-plans/active/2026-05-22-post-m8-milestone-plan.md`](../exec-plans/active/2026-05-22-post-m8-milestone-plan.md)

## 배경

TD-001은 현재 strategy variant가 얇은 feature snapshot에 의존해 후보 생성 설명력과 paper/backtest 보정 가능성이 낮다는 문제다.
M11은 feature 정의, 순수 계산기, backtest/paper parity, strategy integration, calibration report를 순차 sub PR로 나눈다.

Sub PR 1은 런타임 동작을 바꾸지 않는다. 이 문서는 이후 구현 PR이 공유할 feature 이름, 시간 기준, 단위, 부호 의미, 결측 처리,
runtime config contract, M9 #68 보호 경계를 고정한다.

## 결정

### Feature snapshot 기준

Feature calculator는 정규화된 market event window와 명시적 `observedAt`만 입력으로 받는 순수 계산기로 구현한다. DB, 네트워크,
broker, notifier, clock read side effect를 갖지 않는다. 같은 입력 window를 주면 backtest와 paper runner에서 같은 값을 반환해야
한다.

모든 금융 숫자와 ratio 출력은 decimal string이다. bucket 수, window 길이, count처럼 정수 의미가 있는 값만 number를 허용한다.
계산에 실패하거나 입력이 부족하면 값을 0으로 보정하지 않고 명시적 failure result를 반환한다.

### 시간 기준

- 기준 시각: caller가 넘긴 `observedAt`
- event 포함 범위: `(observedAt - window, observedAt]` half-open window
- 정렬 기준: `eventTimestamp`, `sequence`, `tieBreakKey`
- 지연 판단: `receivedAt`은 WebSocket lag와 stale 판단에만 사용하고 가격/수량 feature의 기준 시간으로 쓰지 않는다.
- 일별 기준: 24시간 거래대금과 Upbit 일봉 해석은 UTC 기준을 기본으로 두되, KST bucket은 별도 metadata로 함께 보존한다.

동일 timestamp의 이벤트가 여러 개면 fixture와 runtime source는 `sequence`와 `tieBreakKey`로 deterministic order를 제공해야 한다.
정렬 key가 부족한 입력은 parity 대상 fixture로 인정하지 않는다.

### 결측과 fail-closed

Feature failure는 주문 후보 생성에서 fail-closed로 해석한다.

| 상황 | 처리 |
| --- | --- |
| 필수 event window 부족 | `FEATURE_INSUFFICIENT_INPUT` failure |
| 숫자 파싱 실패 | `FEATURE_INVALID_DECIMAL` failure |
| 분모 0 또는 음수 가격/수량 | `FEATURE_INVALID_MARKET_VALUE` failure |
| stale 또는 disconnected status가 window 안에 있음 | `FEATURE_MARKET_DATA_STALE` failure |
| 선택 feature만 부족 | 해당 feature를 `unavailable`로 기록하되, 그 feature를 required로 선언한 strategy는 주문 후보를 만들 수 없음 |

report와 audit은 내부 reason code를 보존하되 사용자에게는 "피처 입력이 부족해 후보 생성을 중지했습니다"처럼 행동 언어를 먼저
보여준다.

## Feature 정의

M11 feature key는 아래 이름을 기준으로 한다. 구현 PR에서 계산식이 바뀌면 이 문서를 먼저 갱신한다.

| feature key | 목적 | 입력 window | 단위 | 부호 의미 | 결측 처리 |
| --- | --- | --- | --- | --- | --- |
| `candle_momentum_bps` | 최근 가격 진행 방향을 bps로 표현 | 기본 20개 1분 candle bucket | bps | 양수는 상승, 음수는 하락 | 첫 open 또는 마지막 close가 없으면 failure |
| `realized_volatility_bps` | 최근 수익률 변동성 | 기본 20개 1분 candle close return | bps | 항상 0 이상 | return 표본이 2개 미만이면 failure |
| `volume_spike_ratio` | 직전 bucket 거래대금이 기준 거래대금보다 얼마나 큰지 | 최신 1개 bucket / 이전 20개 bucket median | ratio | 1 초과는 평소보다 큼 | 기준 median이 0이면 failure |
| `bid_depth_slope_krw_per_bps` | bid 호가 깊이가 가격 이탈에 따라 쌓이는 속도 | 최신 orderbook snapshot 상위 15레벨 | KRW/bps | 클수록 매수측 깊이가 빠르게 쌓임 | 레벨 2개 미만이면 failure |
| `ask_depth_slope_krw_per_bps` | ask 호가 깊이가 가격 이탈에 따라 쌓이는 속도 | 최신 orderbook snapshot 상위 15레벨 | KRW/bps | 클수록 매도측 깊이가 빠르게 쌓임 | 레벨 2개 미만이면 failure |
| `depth_change_rate_ratio` | 최근 depth가 직전 기준 대비 줄었는지 확인 | 현재 depth5와 5분 전 depth5 | ratio | 양수는 깊이 증가, 음수는 깊이 감소 | 과거 depth가 없거나 0이면 failure |
| `vwap_deviation_bps` | 현재 가격이 rolling VWAP에서 얼마나 벗어났는지 확인 | 기본 20개 1분 trade bucket | bps | 양수는 VWAP 위, 음수는 VWAP 아래 | 거래대금 합계가 0이면 failure |
| `trade_direction_imbalance_ratio` | 체결 방향 누적 불균형 | 기본 최근 5분 trade events | -1..1 ratio | BID 체결 우세는 양수, ASK 체결 우세는 음수 | BID/ASK 체결이 모두 없으면 failure |
| `market_regime` | trend/range/volatile/liquidity stress를 분류 | momentum, volatility, volume, depth, spread feature snapshot | enum string | 부호 없음 | 필요한 하위 feature가 failure면 failure |
| `session_liquidity_score` | 시간대별 유동성 조건을 숫자로 표현 | KST hour, 최근 20개 bucket volume/depth baseline | 0..1 ratio | 1에 가까울수록 정상 유동성 | baseline이 없으면 failure |
| `session_liquidity_state` | 시간대별 유동성 filter 결과 | `session_liquidity_score`와 KST hour | enum string | 부호 없음 | score failure면 failure |
| `cost_adjusted_expected_return_bps` | 비용 차감 후 기대값을 전략 입력과 report에서 비교 | 기대수익률과 cost snapshot | bps | 양수는 비용 차감 후 기대값 남음 | cost 구성요소 중 필수 값이 없으면 failure |
| `cost_adjusted_margin_bps` | safety buffer까지 차감한 여유분 | `cost_adjusted_expected_return_bps - safety_buffer_bps` | bps | 양수만 후보 승격 가능 | safety buffer가 없으면 failure |

`cost_adjusted_expected_return_bps`는 CostModel을 대체하지 않는다. 전략 단계의 설명력과 calibration 비교를 위한 feature이며, 실제
주문 제출 허용은 기존 CostModel과 RiskGate가 계속 최종 권한을 가진다.

## Market regime 값

`market_regime`은 내부 enum string으로만 사용하며 사용자 문구에 그대로 노출하지 않는다.

| 값 | 의미 | 기본 사용 |
| --- | --- | --- |
| `trend_up` | momentum과 체결 방향이 상승 쪽으로 일치 | 추세 추종 후보 설명 |
| `trend_down` | momentum과 체결 방향이 하락 쪽으로 일치 | 추세 추종 후보 설명 |
| `range` | momentum은 작고 VWAP 이탈이 제한적 | 평균회귀 후보 설명 |
| `volatile` | realized volatility 또는 spread가 급격히 확대 | 보수적 차단 후보 |
| `liquidity_stress` | depth 감소 또는 session liquidity score 저하 | 리스크 차단 후보 |

## Strategy required feature 초안

Sub PR 4에서 strategy integration을 수행할 때 아래 required feature를 기준으로 삼는다.

| strategy | required feature |
| --- | --- |
| `trend_following` | `candle_momentum_bps`, `realized_volatility_bps`, `volume_spike_ratio`, `trade_direction_imbalance_ratio`, `market_regime`, `cost_adjusted_margin_bps` |
| `mean_reversion` | `vwap_deviation_bps`, `realized_volatility_bps`, `session_liquidity_score`, `market_regime`, `cost_adjusted_margin_bps` |
| `volatility_breakout` | `realized_volatility_bps`, `volume_spike_ratio`, `candle_momentum_bps`, `market_regime`, `cost_adjusted_margin_bps` |
| `orderbook_imbalance_momentum` | `bid_depth_slope_krw_per_bps`, `ask_depth_slope_krw_per_bps`, `trade_direction_imbalance_ratio`, `depth_change_rate_ratio`, `cost_adjusted_margin_bps` |
| `liquidity_reversion` | `depth_change_rate_ratio`, `session_liquidity_score`, `vwap_deviation_bps`, `cost_adjusted_margin_bps` |

기존 `spread_bps`, `depth_krw`, `trade_strength`, `orderbook_imbalance`, `mean_reversion_deviation_bps`,
`volatility_expansion_bps`, `breakout_direction`, `liquidity_reversion_bps` feature는 Sub PR 4 전까지 유지한다.

## Runtime config contract

M11 구현 PR은 새 threshold를 `strategyParameters.<strategy_id>` 아래에 추가한다. 모든 bps, KRW, ratio 값은 Decimal string으로
검증한다. bucket 수와 lookback 개수는 양의 정수 number로 검증한다. `market_regime` 허용 목록은 비어 있지 않은 enum string
배열이어야 한다.

기본 운영 threshold 변경은 M11 마지막 calibration PR 전까지 금지한다. Sub PR 2-4는 새 key와 schema, 테스트를 추가할 수 있지만
`config/paper.json`의 기본값을 더 공격적으로 바꾸지 않는다.

| threshold key | 단위 | 검증 | 보수적 조정 방향 |
| --- | --- | --- | --- |
| `min_candle_momentum_bps` | bps | Decimal string, 0 이상 | 높일수록 약한 momentum 후보 차단 |
| `min_realized_volatility_bps` | bps | Decimal string, 0 이상 | 높일수록 변동성 부족 후보 차단 |
| `max_realized_volatility_bps` | bps | Decimal string, 0 이상 | 낮출수록 급변동 후보 차단 |
| `max_spread_bps` | bps | Decimal string, 0 이상 | 낮출수록 스프레드 확대 국면을 보수적으로 차단 |
| `max_abs_vwap_deviation_bps` | bps | Decimal string, 0 이상 | 낮출수록 정상 range로 볼 수 있는 VWAP 이탈 폭 축소 |
| `min_volume_spike_ratio` | ratio | Decimal string, 0 이상 | 높일수록 거래대금 증가가 약한 후보 차단 |
| `min_depth_slope_krw_per_bps` | KRW/bps | Decimal string, 0 이상 | 높일수록 얕은 호가 후보 차단 |
| `min_depth_change_rate_ratio` | ratio | Decimal string | 높일수록 depth 감소 후보 차단 |
| `min_abs_vwap_deviation_bps` | bps | Decimal string, 0 이상 | 높일수록 작은 평균회귀 후보 차단 |
| `min_trade_direction_imbalance` | -1..1 ratio | Decimal string, 0..1 | 높일수록 약한 체결 방향성 후보 차단 |
| `allowed_market_regimes` | enum list | non-empty known regime list | 줄일수록 허용 regime 축소 |
| `min_session_liquidity_score` | 0..1 ratio | Decimal string, 0..1 | 높일수록 얇은 시간대 후보 차단 |
| `min_cost_adjusted_margin_bps` | bps | Decimal string | 높일수록 비용 차감 후 여유가 작은 후보 차단 |

## Paper/backtest parity

Sub PR 3 parity fixture는 같은 raw event window를 backtest path와 paper path에 넣고 다음을 비교한다.

- feature key별 값과 failure reason
- decimal string 정규화 결과
- `observedAt`과 window boundary
- stale data failure 여부
- cost-adjusted feature와 CostModel decision의 비용 구성요소 이름

Parity test는 값이 없는 metric을 0으로 채우면 실패해야 한다.

## M9 #68 보호 경계

M11 Sub PR 1-4는 #68 운영 관측이 끝나기 전에도 진행할 수 있지만 아래를 바꾸지 않는다.

- M9 paper trading runner 실행 방식
- #68 artifact 경로와 파일명
- daily report 생성/전송 경계
- Telegram outbound alert와 notification retry 동작
- control drill과 3일 report 비교 포맷
- 기본 운영 threshold를 더 공격적으로 바꾸는 설정

#68 결과가 Sub PR 5 시점에도 없으면 M11은 실제 threshold 확정 대신 보수적 제안과 후속 issue 후보만 남긴다.

## 대안

- 계산기 구현 PR에서 feature 이름을 정한다: backtest/paper parity와 strategy integration이 서로 다른 이름을 쓰기 쉬워 기각했다.
- #68 결과를 기다린 뒤 M11 전체를 시작한다: 문서 계약과 순수 계산기는 운영 artifact를 바꾸지 않으므로 병렬 진행이 가능해 기각했다.
- CostModel 결과를 strategy feature로 직접 대체한다: 비용 게이트 권한이 흐려지므로 기각했다. 전략 설명 feature와 최종 CostModel 판정은 분리한다.

## 영향

- Sub PR 2는 이 문서의 feature key와 결측 정책을 기준으로 순수 계산기를 구현한다.
- Sub PR 3은 같은 fixture에서 backtest와 paper feature 값이 일치하는지 검증한다.
- Sub PR 4는 strategy variant required feature와 discard audit을 이 계약에 맞춘다.
- Sub PR 5는 #68 관측 데이터가 있을 때만 threshold 비교와 보수적 기본값 제안을 수행한다.

## 후속 작업

1. 순수 feature calculator와 fixture 단위 테스트 구현
2. backtest/paper parity fixture 추가
3. strategy parameter schema와 strategy variant 입력 확장
4. calibration report와 #68 결과 유무에 따른 후속 issue 후보 정리
