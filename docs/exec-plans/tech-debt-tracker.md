# 기술 부채 추적기

사용자가 명시했거나 review drain 과정에서 확인된 후속 작업을 이 문서에 모은다.

## 기록 규칙

- 구현 중 우연히 발견한 취향 수준의 개선은 바로 기록하지 않는다.
- 제품 동작, 신뢰성, 보안, 검증 공백에 영향을 주는 항목만 남긴다.
- 각 항목은 근거, 영향, 권장 처리 시점을 포함한다.

## 항목

| ID | 상태 | 영향 | 근거 | 권장 처리 |
| --- | --- | --- | --- | --- |
| TD-001 | inactive proposal ready | M11 자체는 #102 Sub PR 5까지 완료되어 닫혔고, #68 closeout(pass) 증거 기반 비활성 threshold 후보의 기본값 활성화 승인만 남음 | M11 Sub PR 1-4에서 candle momentum, realized volatility, volume spike, depth slope, depth 변화율, VWAP 이탈, 체결 방향 누적 imbalance, market regime, 시간대별 유동성 filter, cost-adjusted expected return feature의 contract, calculator, backtest/paper parity, strategy integration을 추가했다. 2026-05-31 기준 #102 Sub PR 5에서 #68 원천 artifact를 재검증했고, `averageMarginBps=-1.333333333333`이라 공격적 완화는 차단한 채 `/home/lim/vaults/99_운영/seemirai-m9-paper/m11-threshold-calibration-profile-proposal.json`에 비활성 보수 후보만 남겼다. `config/paper.json` 기본 threshold는 변경하지 않았다. | 동일 run shape 전후 비교를 붙이는 별도 calibration approval PR에서 activation 여부를 검토한다. |
| TD-002 | completed | 큰 TypeScript 단일 파일 책임 분리로 이후 전략/운영/v0.2 pilot 변경의 리뷰 범위와 회귀 추적 비용을 줄임 | #77 mother PR #85와 sub PR #78~#84에서 `execution-persistence`, `paper-broker`, `risk-gate-runtime`, `risk-gate`, `execution-engine`, `strategy-variants`, `backtest-orchestrator`를 public entry 유지 + same-basename directory 구조로 분리했다. 상세 완료 기록은 [`../tech-debt/2026-05-20-large-typescript-module-boundaries.md`](../tech-debt/2026-05-20-large-typescript-module-boundaries.md)에 남긴다. | 완료. `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify` 통과 후 #77을 닫는다. |
