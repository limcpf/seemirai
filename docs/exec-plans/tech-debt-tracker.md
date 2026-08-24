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
| TD-003 | follow-up split | Issue #206은 2026-08-25 실거래 arm/cleanup evidence 기준으로 닫고, 장기 운영 관측성, feature 품질, 전략 보정, SELL 실운영 검증, TUI 표현, daemon 운영화, BTC 단일 하드코딩 해소는 후속 개발 묶음으로 유지함 | 2026-06-23 운영 DB/status 점검에서 최근 15분 `trades=150`, `orderbook_metrics=449`, 최신 entry 재계산과 status의 `autonomous_24x7_entry_signal_weak` 값은 일치했다. 다만 live 판단은 `strategy_signals`에 누적되지 않았고, live CLI entry feature는 public tick fallback 중심이며, 자동전략 소유 BTC 포지션이 없어 SELL 분기는 운영 DB에서 아직 재현되지 않았다. 2026-06-24 점검에서는 production `live:ops`의 config, strategy, broker guard, closeout validator 곳곳에 `KRW-BTC` 단일 전제가 하드코딩되어 `KRW-ETH` 같은 추가 market은 config 변경만으로 열 수 없음을 확인했다. 2026-08-25에는 #267 successor raw evidence로 실제 주문·체결까지 확인했지만, M23 7일 `production-day` PASS manifest와 wallet quantity 수동점검은 #277, #278, #279로 분리했다. | 아래 7개 항목을 별도 issue/subPR로 쪼갠다: live 판단 이력 DB 저장, DB-backed feature 강화, threshold calibration, SELL 경로 실운영 검증, TUI/status 문구 분리, 24/7 daemon 운영 안정화, 다중 market/ETH 확장 구조 개선. #267 closeout gap은 #277, #278, #279를 따른다. 상세 DnD 후보는 [`active/2026-06-15-issue-206-live-ops-real-arm.md`](./active/2026-06-15-issue-206-live-ops-real-arm.md)의 post-merge backlog를 따른다. |
