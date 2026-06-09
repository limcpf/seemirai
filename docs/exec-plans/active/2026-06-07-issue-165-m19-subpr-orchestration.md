# Issue #165 M19 자동 매도와 포지션 축소 Sub PR Orchestration

## 목표

Issue [#165](https://github.com/limcpf/seemirai/issues/165) M19는 자동매수 확대 전에 포지션을 안전하게 줄이고 닫는 exit engine을 구현한다. 손절, 익절, trailing stop, 시간 기반 청산, 전략 exit signal, 리스크 기반 축소를 paper와 guarded live pilot 경계에서 검증하고, 모든 판단과 실패 복구를 decision ledger, RiskGate, PnL/position evidence로 설명 가능하게 남긴다.

## 현재 상태

- Issue: [#165](https://github.com/limcpf/seemirai/issues/165) `[Feature] M19 자동 매도와 포지션 축소`
- Mother branch: `issue-165-mother`
- 현재 작업 모드: **sub PR mode**
- 실제 sub branch/worktree/PR: 아직 생성하지 않았다. 이 문서는 구현 handoff와 계획 커밋을 위한 문서 산출물이다.
- upstream 관측: 현재 로컬 `issue-165-mother`는 `origin/main`을 upstream으로 보고 있다. 구현 시작 전 mother branch push/추적 관계를 확인해야 한다.

## 분할 판단

이슈 본문은 5개 예상 분할(foundation, rules, persistence, runtime, verification)을 제시하지만, 그대로 나누면 foundation과 rules가 같은 contract/runtime 흐름을 공유하고 persistence와 runtime도 같은 failure mode를 반복 검증하게 된다. 리뷰 단위와 구현 응집도를 기준으로 **3개 sub PR**이 적정하다.

1. **Sub PR 01 Contracts & Rules**: exit contract, config/policy guard, exit rule engine, position sizing, dust/min-order 처리를 함께 고정한다.
2. **Sub PR 02 Evidence & Runtime Integration**: RiskGate, decision ledger, PnL/position context, ExecutionEngine/PaperBroker partial fill/cancel/requote, 신규 진입 중지를 하나의 실행 흐름으로 연결한다.
3. **Sub PR 03 Verification, Guarded Pilot & Closeout**: guarded live pilot smoke guard, live order API 0회 source scan, 문서 closeout, 전체 검증을 마무리한다.

4개 이상으로 나누지 않는 이유:

- `ExitDecision`, `ExitRule`, `ExitOrderIntent`, `ExitPolicySnapshot` contract는 rule 구현 없이는 검증 가능한 의미가 약하다.
- exit order persistence와 runtime execution은 같은 append-only evidence와 mismatch failure path를 공유한다.
- guarded live pilot smoke는 구현 완료 후 검증 책임이므로 앞 단위와 병렬로 진행하면 실제 사용자 표면 연결 여부를 증명할 수 없다.

## Open Question 결정

`docs/product-specs/upbit-live-autonomous-trading.md`는 초기 exit rule에 trailing stop을 포함할지 open question으로 남겼지만, Issue #165 구현 범위와 acceptance criteria가 trailing stop을 명시한다. M19 handoff에서는 trailing stop을 **필수 rule**로 포함한다. 단, 과도한 실시간 최적화나 새 dependency 없이 deterministic fixture와 state snapshot contract로 최소 구현한다.

## Sub PR 계획

| Sub PR | Branch | Worktree | 목표 | PR base | 상태 |
| --- | --- | --- | --- | --- | --- |
| 01 | `issue-165/01-contracts-rules` | `../issue-165-01-contracts-rules` | exit contract와 모든 exit rule, position 초과/dust/min-order 차단 | `issue-165-mother` | planned |
| 02 | `issue-165/02-evidence-runtime` | `../issue-165-02-evidence-runtime` | RiskGate/ledger/PnL evidence와 paper execution, partial fill, cancel/requote, 신규 진입 중지 연결 | `issue-165-mother` | planned |
| 03 | `issue-165/03-verification-closeout` | `../issue-165-03-verification-closeout` | guarded live pilot smoke, live order API 0회 scan, 문서 closeout, 전체 검증 | `issue-165-mother` | planned |

## 의존성과 병렬 가능성

- 기본 순서: **01 -> 02 -> 03**
- 병렬 구현: 권장하지 않는다.
- 이유: Sub PR 02는 Sub PR 01의 contract와 rule output에 의존하고, Sub PR 03은 Sub PR 02의 실제 runtime/evidence 결과가 있어야 smoke와 closeout을 작성할 수 있다.
- 충돌 위험: `docs/generated/context-map.json`, `docs/exec-plans/active/README.md`, `src/application/index.ts`, `src/domain/index.ts`, `src/application/execution/**`, `src/application/decision-ledger/**`, `src/runtime/**`, migration/schema 파일은 순차 변경이 안전하다.

## 파일 소유권

### Sub PR 01 Contracts & Rules

- `src/domain/orders.ts`, `src/domain/rules.ts`, 필요 시 새 `src/domain/exit.ts`
- `src/application/rules/basic-rules.ts`, `src/application/rules/**`
- `src/application/strategies/**`
- `src/runtime/strategy-parameters.ts`, `src/runtime/registry-config.ts`, 필요 시 `config/paper.json`
- `docs/product-specs/upbit-live-autonomous-trading.md`, `docs/RUNTIME_CONFIG.md`, `docs/FEATURE_REQUIREMENTS.md`
- `tests/unit/rule-engine.test.ts`, `tests/unit/strategy-variants.test.ts`, 신규 exit fixture

### Sub PR 02 Evidence & Runtime Integration

- `src/application/execution/**`
- `src/infrastructure/paper/paper-broker.ts`, `src/infrastructure/paper/paper-broker/**`
- `src/infrastructure/db/execution-persistence.ts`, `src/infrastructure/db/execution-persistence/**`
- `src/application/risk/**`, `src/infrastructure/db/risk-gate-runtime-event-store.ts`
- `src/application/decision-ledger/**`, `src/infrastructure/db/decision-ledger/**`
- `src/application/pnl-accounting/**`, `src/runtime/execution-runtime.ts`
- 관련 unit/integration tests

### Sub PR 03 Verification, Guarded Pilot & Closeout

- `src/runtime/pilot-order-smoke/**`, `src/runtime/upbit-live-broker-runtime/**`, 필요 시 guarded smoke helper
- `tests/integration/upbit-order-smoke.test.ts`, `tests/integration/upbit-live-broker-smoke.test.ts`, 신규 M19 smoke tests
- `docs/product-specs/upbit-live-autonomous-trading.md`
- `docs/RUNTIME_CONFIG.md`, `docs/RELIABILITY.md`, `docs/SECURITY.md`, 필요 시 `docs/FEATURE_REQUIREMENTS.md`
- `docs/exec-plans/active/**`, `docs/exec-plans/completed/**`, `docs/generated/context-map.json`

## 공통 Definition of Done

- `corepack pnpm typecheck` 통과
- 관련 targeted unit/integration tests 통과
- `corepack pnpm test` 통과 또는 guard skip 근거 보고
- `./scripts/verify` 통과
- 문서 변경 시 `./scripts/verify docs` 통과
- 기본 `PAPER_NO_KEY` runtime live order API 호출 0회 source scan 기록
- `hard stop`이 open position 자동 청산을 만들지 않는 회귀 확인
- PR 본문에 targeted 검증과 skip/fail-closed evidence 기록

## Sub PR별 Handoff 문서

- Sub PR 01: [`./2026-06-07-issue-165-subpr-01-contracts-rules-deepseek-handoff.md`](./2026-06-07-issue-165-subpr-01-contracts-rules-deepseek-handoff.md)
- Sub PR 02: [`./2026-06-07-issue-165-subpr-02-evidence-runtime-deepseek-handoff.md`](./2026-06-07-issue-165-subpr-02-evidence-runtime-deepseek-handoff.md)
- Sub PR 03: [`./2026-06-07-issue-165-subpr-03-verification-closeout-deepseek-handoff.md`](./2026-06-07-issue-165-subpr-03-verification-closeout-deepseek-handoff.md)

## Sub-agent 지시 템플릿

```text
너는 issue #165의 Sub PR <n>을 담당한다.
소유 파일 범위는 이 orchestration 문서와 해당 DeepSeek handoff의 Owns 항목이다.
다른 sub PR이 소유한 파일은 구현하지 말고, 필요한 계약 의존성은 선행 sub PR 결과로만 사용한다.
M20 Telegram inbound, M21 수동 승인 주문 플로우, M22 무승인 자동 실거래, 장애 상황의 무조건 시장가 청산은 구현하지 않는다.
작업 후 변경 파일과 검증 결과를 한국어로 요약해라.
```

## 생성할 PR

구현 단계에서 각 sub PR은 `issue-165-mother`를 base로 PR을 만든다. Codex는 이 orchestration 문서 작성 단계에서 PR 생성, merge, branch 삭제를 수행하지 않는다.

## 남은 리스크

- M19 guarded live pilot은 실제 보유 소액 포지션 또는 paper fixture를 우선해야 한다. 신규 guarded buy smoke는 별도 운영자 승인 evidence 없이는 실행하지 않는다.
- exit 비용 evidence가 entry intent에 재사용되면 매수 경로가 느슨해질 수 있다. Sub PR 02에서 `position_effect=REDUCE|EXIT`와 fingerprint mismatch를 반드시 검증해야 한다.
- partial fill 이후 잔량 처리와 cancel/requote가 같은 order lifecycle evidence 안에서 닫히지 않으면 `/status.why`와 PnL/position snapshot이 어긋날 수 있다.
- 구현 완료 전까지 PR URL과 review drain 상태는 비어 있다.
