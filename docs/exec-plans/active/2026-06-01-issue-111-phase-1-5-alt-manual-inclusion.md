# issue #111 Phase 1.5 알트 수동 편입 실행 계획

## 목표

MVP paper trading의 `KRW-BTC`/`KRW-ETH` 기본 universe를 유지하면서, 운영자가 evidence snapshot을 확인한 KRW 알트를 최대 3개까지 수동 승인 방식으로 편입할 수 있게 한다.

## 범위

- 포함:
  - `universe.phase_1_5` config/schema와 승인 evidence contract
  - 알트 후보 eligibility evaluator와 fixture tests
  - universe/rule/cost/risk runtime 연결
  - 승인/철회/만료 evidence와 운영 표시
  - 문서 정합성, paper-only/live order API 0회 검증
- 제외:
  - 자동 신규 상장 편입
  - 저유동성 알트 편입
  - 시장가 신규 진입
  - 실거래 주문, Upbit private API/account 연동
  - v0.2 pilot profile

## 작업 단계

1. Foundation: phase 1.5 config/schema와 승인 evidence type을 추가한다.
2. Eligibility: 상장 후 90일 이상, warning/caution 부재, 30일 평균 거래대금, 7일 spread p95, slippage, depth evaluator와 fixture tests를 추가한다.
3. Runtime integration: 수동 승인된 알트만 universe/rule/cost/risk 경계에 연결하고, safety buffer 20 bps와 단일/전체 알트 리스크 한도를 확인한다.
4. Audit/reporting: 승인/철회/만료 evidence와 운영 표시를 남긴다.
5. Verification docs: 런타임 설정/업무 명세/검증 문서를 정리하고 `./scripts/verify` 및 paper decision runner fixture smoke를 통과시킨다.

## 검증 방법

- `corepack pnpm typecheck`
- `corepack pnpm test`
- `./scripts/verify`
- `node scripts/run-m9-paper-decision-runner.mjs --fixture-smoke --json`

## 검증 결과

- 2026-06-01: Sub PR 1 Foundation에서 config/schema, docs 구조, config unit test를 통과했다.
- 2026-06-01: Sub PR 2 Eligibility에서 후보 evaluator fixture와 warning/caution/invalid evidence regression test를 통과했다.
- 2026-06-01: Sub PR 3 Runtime integration에서 resolved universe, policy/rule/cost/runtime 연결, `./scripts/verify`를 통과했다.
- 2026-06-01: Sub PR 4 Audit/reporting에서 `PHASE_1_5_ALT_APPROVAL` audit event, `/status` safe summary, daily report 표시, `./scripts/verify`를 통과했다.
- 2026-06-01: Sub PR 5 Verification docs에서 `node scripts/run-m9-paper-decision-runner.mjs --fixture-smoke --json`을 실행했다.
  run id `5e571373-47c1-47ee-870a-3158610a8574`, status `passed`, live order API calls `0`, paper order submitted `1`,
  paper fill `1`, audit missing `0`. Artifact:
  `/home/lim/vaults/99_운영/seemirai-m9-paper/m9-paper-decision-2026-06-01T00-59-52-368Z-5e571373-summary.json`.

## 결정 로그

- 2026-06-01: issue #111 본문 계획에 맞춰 순차 sub PR mode로 진행한다.
- 2026-06-01: phase 1.5 기본 config는 비활성/빈 승인 목록으로 두어 기존 BTC/ETH paper runtime을 변경하지 않는다.
- 2026-06-01: eligibility evaluator는 외부 API/DB를 호출하지 않는 순수 함수로 두고, 모든 조건별 pass/fail을 approval evidence에 남긴다.
- 2026-06-01: runtime integration은 `RuntimeConfig.universe`를 policy mapper, `universe_allowed` rule, CostModel TOP_ALT safety buffer가 함께 읽는 해석 결과로 고정한다.
- 2026-06-01: 승인/거부/철회/만료 evidence는 `PHASE_1_5_ALT_APPROVAL` audit event로 남기고, `/status`와 daily report는 safe summary만 표시한다.

## 남은 이슈

- Sub PR 5 review drain과 mother branch merge 후 최종 main 대상 PR에서 review drain을 진행한다.
