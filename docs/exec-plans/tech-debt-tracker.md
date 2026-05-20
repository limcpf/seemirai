# 기술 부채 추적기

사용자가 명시했거나 review drain 과정에서 확인된 후속 작업을 이 문서에 모은다.

## 기록 규칙

- 구현 중 우연히 발견한 취향 수준의 개선은 바로 기록하지 않는다.
- 제품 동작, 신뢰성, 보안, 검증 공백에 영향을 주는 항목만 남긴다.
- 각 항목은 근거, 영향, 권장 처리 시점을 포함한다.

## 항목

| ID | 상태 | 영향 | 근거 | 권장 처리 |
| --- | --- | --- | --- | --- |
| TD-001 | open | 전략 후보 생성 정확도와 설명력이 현재 feature set에 제한됨 | issue #16 Sub PR 3의 strategy variants는 M4 contract 고정을 위해 `spread_bps`, `depth_krw`, `trade_strength`, `orderbook_imbalance`, `mean_reversion_deviation_bps`, `volatility_expansion_bps`, `breakout_direction`, `liquidity_reversion_bps` 중심의 얇은 feature snapshot만 사용한다. 알파 품질을 높이려면 candle momentum, realized volatility, volume spike, depth slope, depth 변화율, VWAP 이탈, 체결 방향 누적 imbalance, market regime, 시간대별 유동성 filter, cost-adjusted expected return feature를 후속으로 정의해야 한다. | M6 paper execution과 M7 backtest 데이터가 쌓인 뒤 feature 산출식, 부호 의미, threshold 조정 기준을 design doc 또는 runtime config 문서에 고정한다. |
| TD-002 | open | 큰 TypeScript 단일 파일에 변경 이유가 다른 책임이 섞여 리뷰와 회귀 추적 비용이 증가함 | `risk-gate.ts`, `risk-gate-runtime.ts`, `paper-broker.ts`, `execution-persistence.ts`, `strategy-variants.ts`, `backtest-orchestrator.ts`, `execution-engine.ts`가 interface/type, service, validation, mapper, persistence helper를 한 파일에 함께 둔다. 상세 후보와 분리 기준은 [`../tech-debt/2026-05-20-large-typescript-module-boundaries.md`](../tech-debt/2026-05-20-large-typescript-module-boundaries.md)에 기록한다. | 기능 변경과 섞지 말고 모듈별 무동작 리팩터링 sub PR로 순차 처리한다. |
