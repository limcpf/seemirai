# 기술 부채 추적기

사용자가 명시했거나 review drain 과정에서 확인된 후속 작업을 이 문서에 모은다.

## 기록 규칙

- 구현 중 우연히 발견한 취향 수준의 개선은 바로 기록하지 않는다.
- 제품 동작, 신뢰성, 보안, 검증 공백에 영향을 주는 항목만 남긴다.
- 각 항목은 근거, 영향, 권장 처리 시점을 포함한다.

## 항목

| ID | 상태 | 영향 | 근거 | 권장 처리 |
| --- | --- | --- | --- | --- |
| TD-001 | calibration candidate ready | 전략 후보 생성 설명력은 보강됐고 #68 closeout(pass) 증거가 확보되어 운영 기본 threshold 후보 산정으로 전환 가능함 | M11 Sub PR 1-4에서 candle momentum, realized volatility, volume spike, depth slope, depth 변화율, VWAP 이탈, 체결 방향 누적 imbalance, market regime, 시간대별 유동성 filter, cost-adjusted expected return feature의 contract, calculator, backtest/paper parity, strategy integration을 추가했다. 2026-05-30 기준 #68 72시간 closeout 증거가 `passed`로 확인되어 실제 기본값 변경 전 비교 후보를 산정할 수 있다. | `docs/design-docs/2026-05-26-m11-calibration-closure.md`의 비교 기준으로 별도 calibration issue 또는 PR에서 threshold 후보를 검토한다. |
| TD-002 | completed | 큰 TypeScript 단일 파일 책임 분리로 이후 전략/운영/v0.2 pilot 변경의 리뷰 범위와 회귀 추적 비용을 줄임 | #77 mother PR #85와 sub PR #78~#84에서 `execution-persistence`, `paper-broker`, `risk-gate-runtime`, `risk-gate`, `execution-engine`, `strategy-variants`, `backtest-orchestrator`를 public entry 유지 + same-basename directory 구조로 분리했다. 상세 완료 기록은 [`../tech-debt/2026-05-20-large-typescript-module-boundaries.md`](../tech-debt/2026-05-20-large-typescript-module-boundaries.md)에 남긴다. | 완료. `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify` 통과 후 #77을 닫는다. |
