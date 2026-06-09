# Issue #165 Sub PR 01 Contracts & Rules DeepSeek Implementation Handoff

## Goal

M19 Sub PR 01은 exit engine의 public contract와 순수 rule 계층을 고정한다. 구현자는 `ExitDecision`, `ExitRule`, `ExitOrderIntent`, `ExitPolicySnapshot` 의미를 정의하고, 손절, 익절, trailing stop, 시간 기반 청산, 전략 exit signal, 리스크 기반 축소가 deterministic fixture에서 trigger/non-trigger로 검증되게 만들어야 한다. 이 단위는 broker submit, DB persistence, guarded live pilot을 구현하지 않는다.

## Split Decision

Issue #165는 sub PR mode로 진행한다. 이 handoff는 3개 분할 중 **Sub PR 01**이다.

foundation과 rules를 분리하지 않는 이유는 contract만 만들면 실제 exit rule output 의미를 검증할 수 없고, rule만 만들면 position scope, dust/min-order, policy snapshot invariant가 불명확해지기 때문이다. Sub PR 01은 Sub PR 02의 runtime/evidence 연결 입력을 만드는 선행 단위다.

## Unit Metadata

- `Goal`: exit contract, policy/config guard, exit rule engine, position 초과 SELL/REDUCE 차단, 최소 주문금액 미달/dust 처리까지 고정한다.
- `Owns`: `src/domain/orders.ts`, `src/domain/rules.ts`, 필요 시 `src/domain/exit.ts`, `src/application/rules/basic-rules.ts`, `src/application/rules/**`, `src/application/strategies/**`, `src/runtime/strategy-parameters.ts`, `src/runtime/registry-config.ts`, `tests/unit/rule-engine.test.ts`, `tests/unit/strategy-variants.test.ts`, 신규 M19 fixture, 관련 문서.
- `Excludes`: `ExecutionEngine` broker submit 변경, PaperBroker partial fill/cancel/requote runtime, DB migration/repository, decision ledger persistence, `/status.why` wiring, guarded live pilot smoke, 자동 commit, PR 생성, merge.
- `Dependencies`: 현재 branch `issue-165-mother`, Issue #165 본문, orchestration 문서 [`./2026-06-07-issue-165-m19-subpr-orchestration.md`](./2026-06-07-issue-165-m19-subpr-orchestration.md). M18 decision ledger와 M17 PnL/position accounting은 main에 반영된 상태를 전제로 한다.
- `Parallel`: 불가. Sub PR 02와 03은 이 contract와 rule output에 의존한다.
- `Verification`: `corepack pnpm exec vitest run tests/unit/rule-engine.test.ts tests/unit/strategy-variants.test.ts tests/unit/config.test.ts`, `corepack pnpm typecheck`, `./scripts/verify docs`.
- `Handoff command`: `mkdir -p .local/transcripts && npx --yes reasonix run --effort high --budget 1.00 --transcript .local/transcripts/issue-165-subpr-01-contracts-rules.reasonix.jsonl "Read docs/exec-plans/active/2026-06-07-issue-165-subpr-01-contracts-rules-deepseek-handoff.md and implement Sub PR 01 Contracts & Rules only. Do not implement Sub PR 02, Sub PR 03, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."`

## Mandatory Implementation Rules

The implementer must follow these rules throughout the task.

### 한국어 출력 규칙

- 주석 및 결과물은 모두 한국어로 표시한다.
- 사용자-facing CLI 메시지, 에러 메시지, 구현 요약, report back은 한국어로 작성한다.
- 코드 식별자, package script 이름, 외부 API 필드명처럼 관례적으로 영어가 필요한 항목은 영어를 유지할 수 있다.

### 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No flexibility or configurability that was not requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

### 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

- Do not improve adjacent code, comments, or formatting.
- Do not refactor things that are not broken.
- Match existing style.
- If unrelated dead code is noticed, mention it instead of deleting it.
- Remove imports/variables/functions that your changes made unused.

## Read First

구현 전에 반드시 아래 파일을 읽는다.

- `AGENTS.md`
- `ARCHITECTURE.md`
- `docs/README.md`
- `docs/generated/context-map.json`
- `docs/PRD.md`
- `docs/FEATURE_REQUIREMENTS.md`
- `docs/PLANS.md`
- `docs/RUNTIME_CONFIG.md`
- `docs/RELIABILITY.md`
- `docs/SECURITY.md`
- `docs/product-specs/upbit-live-autonomous-trading.md`
- `docs/exec-plans/completed/2026-06-04-issue-154-m17-pnl-position-accounting.md`
- `docs/exec-plans/completed/2026-06-06-issue-159-m18-decision-ledger-closeout.md`
- `docs/design-docs/2026-05-20-typescript-module-structure.md`
- `src/domain/orders.ts`
- `src/domain/rules.ts`
- `src/domain/risk.ts`
- `src/domain/strategy.ts`
- `src/application/rules/basic-rules.ts`
- `src/application/rules/rule-engine.ts`
- `src/application/strategies/**`
- `src/runtime/strategy-parameters.ts`
- `tests/unit/rule-engine.test.ts`
- `tests/unit/strategy-variants.test.ts`
- `tests/unit/execution-engine.test.ts`

우선순위가 충돌하면 다음 순서를 따른다.

1. 이 handoff 문서
2. Issue #165 본문
3. `AGENTS.md`
4. `ARCHITECTURE.md`
5. `docs/FEATURE_REQUIREMENTS.md`
6. `docs/product-specs/upbit-live-autonomous-trading.md`
7. 기존 코드 contract와 테스트

## Current State

- `OrderIntent.metadata.position_effect=REDUCE|EXIT`는 `ExecutionEngine` fingerprint에 이미 반영된다.
- `createStopLossRule`과 `createTakeProfitRule`은 현재 rule warning 수준 후보로 존재하지만, M19 exit engine contract로 독립된 exit order intent를 만들지는 않는다.
- `mean_reversion` 전략은 평균 근처 복귀 시 `SELL` 후보를 만들 수 있으나, 현재 포지션 scope를 초과하지 않는 exit 전용 sizing contract가 없다.
- 기본 `PAPER_NO_KEY` runtime은 `live_trading_enabled=false`, `market_order_enabled=false`, `entry_market_order_enabled=false`, `paper_no_key=true`를 강제한다.
- `hard stop` cancel plan은 pending paper order 취소만 허용하고 open position 자동 청산을 금지한다.

## Scope

허용 범위는 아래로 제한한다.

- `ExitDecision`, `ExitRule`, `ExitOrderIntent`, `ExitPolicySnapshot` 또는 동등한 public contract 추가.
- TypeScript public entry를 추가하면 같은 이름의 디렉터리에 상세 구현을 둔다.
- `ExitRule`은 broker, DB, Upbit client를 호출하지 않고 context만 평가한다.
- 손절, 익절, trailing stop, 시간 기반 청산, 전략 exit signal, 리스크 기반 축소 rule을 구현한다.
- trailing stop은 현재 peak/anchor price와 관측 시각이 있는 snapshot contract를 요구한다. snapshot이 없으면 임의 보정 없이 HOLD 또는 BLOCK으로 닫고 reason을 남긴다.
- exit intent는 `side=SELL`, `metadata.position_effect=REDUCE|EXIT`를 명시한다.
- exit intent 수량은 현재 open position 수량과 market/strategy scope를 넘지 않아야 한다.
- 최소 주문금액 미달 또는 dust 잔량은 broker submit 후보로 만들지 않고 evidence 가능한 reason으로 분리한다.
- exit 비용 evidence contract는 entry cost margin과 분리될 수 있게 이름과 metadata를 고정한다.
- 전략 exit signal은 기존 strategy decision flow와 충돌하지 않게 별도 metadata로 표현한다.
- 문서상 M19 trailing stop open question은 Issue #165 기준으로 포함한다고 정리한다.
- 핵심 TypeScript 타입/인터페이스/함수에는 한국어 JSDoc을 작성한다.
- 핵심 분기에는 "왜 차단/기록하는지"를 설명하는 한국어 한 줄 주석을 남긴다.

## Non-goals

아래는 구현하면 안 된다.

- BrokerPort submit/cancel 호출.
- PaperBroker partial fill, cancel, requote 구현.
- DB migration, repository, persistence 구현.
- RiskGate runtime event store 변경.
- decision ledger DB write 또는 `/status.why` route/provider wiring.
- guarded live pilot smoke 실행 또는 live order API 호출.
- `config/paper.json`을 live profile로 승격.
- 신규 dependency 추가.
- M20 Telegram inbound command.
- M21 수동 승인 주문 플로우.
- M22 운영자 승인 없는 자동 실거래.
- 장애 상황의 무조건 시장가 청산.
- guarded buy smoke로 신규 진입 포지션 생성.
- 기존 entry path의 시장가/비용/RiskGate guard 완화.
- 자동 commit, PR 생성, merge, force push.
- 관련 없는 문서 정리나 광범위한 리팩터링.

## Architecture Direction

권장 구조는 다음 중 하나다. 저장소의 same-basename directory 규칙을 따른다.

```text
src/domain/exit.ts
src/application/exit-engine.ts
src/application/exit-engine/
  types.ts
  rule-engine.ts
  rules.ts
  sizing.ts
  policy.ts
```

또는 기존 rule module에 더 작게 붙일 수 있으면 다음처럼 유지한다.

```text
src/application/rules/basic-rules.ts
src/application/rules/exit-rules.ts
src/application/rules/exit-sizing.ts
```

선택 기준:

- exit 전용 type이 3개 이상 생기고 Sub PR 02에서 runtime integration이 참조해야 하면 `src/application/exit-engine.ts` public entry를 만든다.
- 단순 rule 보강만으로 충분하면 기존 `src/application/rules/**` 경계를 유지한다.

## Dependency Direction

- domain contract는 application, infrastructure, runtime을 import하지 않는다.
- application exit rule은 domain type과 shared decimal helper만 사용한다.
- strategy는 broker, DB, Upbit client를 직접 호출하지 않는다.
- runtime config/schema 변경이 필요하면 `docs/RUNTIME_CONFIG.md`와 tests를 같이 갱신한다.
- 신규 runtime/dev dependency는 추가하지 않는다.

## Contracts

필수 semantic contract:

- `ExitDecision`: 특정 position scope에 대해 `HOLD`, `REDUCE`, `EXIT`, `BLOCK` 중 하나를 설명하는 순수 판단 결과.
- `ExitRule`: `ExitRuleContext`를 받아 단일 rule evaluation을 반환하며 외부 side effect가 없다.
- `ExitOrderIntent`: `OrderIntent`와 호환되되 `side=SELL`, `metadata.position_effect=REDUCE|EXIT`, `exit_reason_code`, `exit_rule_id`, `position_scope`를 포함한다.
- `ExitPolicySnapshot`: 최소 주문금액, 호가 단위, dust threshold, exit cost/slippage source, trailing state source를 표현한다.
- `ExitSizing`: 현재 open position quantity를 초과하지 않고, dust/min-order를 분리한다.

`REDUCE`와 `EXIT` 의미:

- `REDUCE`: position 일부 축소이며 남은 position이 유의미하게 존재한다.
- `EXIT`: position 전체 종료 의도이며 dust 잔량만 남는 경우 dust reason을 별도 evidence로 남긴다.

## Edge Cases

- open position quantity가 없거나 0이면 exit intent를 만들지 않는다.
- requested quantity가 open position보다 크면 open position 이하로 조용히 clamp하지 말고 BLOCK 또는 sizing rejection evidence를 남긴다.
- 최소 주문금액 미달은 broker submit으로 넘기지 않는다.
- dust 잔량은 "실제 0"과 "처리 불가 잔량"을 구분한다.
- trailing stop peak/anchor snapshot이 없으면 임의 peak를 현재가로 만들지 않는다.
- 시간 기반 청산은 UTC/KST 기준을 혼합하지 않고 입력 기준 시간을 metadata에 남긴다.
- 전략 exit signal이 BUY entry signal과 동시에 발생하면 exit 우선순위를 명시하고, entry 후보 완화로 처리하지 않는다.
- market warning/caution, policy unavailable, feature unavailable은 사용자-facing reason과 trace를 분리한다.

## Acceptance Criteria

- 모든 exit rule이 deterministic fixture로 trigger/non-trigger 검증된다.
- exit intent는 open position 수량과 market/strategy scope를 넘지 않는다.
- dust/min-order 처리는 broker submit 전에 reason evidence로 분리된다.
- trailing stop은 snapshot 없는 상태에서 추정 구현을 하지 않는다.
- entry용 cost margin과 exit용 비용/슬리피지/policy evidence contract가 섞이지 않는다.
- hard stop은 open position 자동 청산 후보를 만들지 않는다.
- 기본 `PAPER_NO_KEY` runtime guard를 완화하지 않는다.

## Acceptance Criteria Trace Matrix

| AC | 사용자 관측면 | 예상 수정 파일 | 필수 테스트 | 완료로 보지 않는 경우 |
| --- | --- | --- | --- | --- |
| exit rule fixture 검증 | PR 테스트 결과와 rule reason | `src/application/rules/**`, `tests/unit/rule-engine.test.ts` | rule별 trigger/non-trigger unit test | stop-loss/take-profit만 있고 trailing/time/risk/strategy exit 누락 |
| 포지션 초과 차단 | exit intent가 현재 보유 수량 이하 | `src/application/exit-engine/**` 또는 `src/application/rules/**` | position 초과 SELL 차단 test | 수량을 조용히 clamp하고 reason을 남기지 않음 |
| dust/min-order 분리 | dust 또는 최소 주문금액 미달 reason | exit sizing/policy module | dust/min-order unit test | broker submit 단계에서 처음 실패 |
| exit/entry cost 분리 | exit evidence 이름과 metadata | domain/application exit contract | contract unit test | 기존 entry `cost_margin_ok`를 그대로 exit 완료 근거로 사용 |
| hard stop 자동 청산 금지 | hard stop open position 청산 후보 없음 | runtime/config 관련 test 참고 | 기존 hard stop regression 유지 | hard stop에서 SELL intent 생성 |

## Forbidden Completion Shortcuts

- 타입만 export하고 실제 rule fixture 테스트 없이 완료라고 보고하지 않는다.
- stop-loss와 take-profit만 구현하고 trailing stop, 시간 기반 청산, 전략 exit signal, 리스크 기반 축소를 누락하지 않는다.
- 수량 초과를 `Math.min`식 보정으로 숨기지 않는다.
- dust/min-order를 "나중에 runtime에서 처리"한다고 미루지 않는다.
- `position_effect` metadata 없이 SELL이면 exit이라고 간주하지 않는다.
- entry 비용 snapshot을 exit approval evidence로 재사용하지 않는다.

## User-Facing Surface Checklist

Sub PR 01은 직접 HTTP/Telegram surface를 만들지 않지만, reason/message contract는 이후 `/status.why`와 report에서 한국어로 변환 가능해야 한다.

- 내부 reason code와 한국어 user message를 분리한다.
- 사용자-facing message는 상태, 원인, 영향, 필요 조치 중 필요한 정보를 포함한다.
- trace/debug에는 내부 id, rule id, threshold snapshot만 둔다.
- raw provider payload, secret, Authorization header는 metadata에 넣지 않는다.

## Semantic Contracts

- current position source와 historical PnL source를 같은 필드로 섞지 않는다.
- position quantity 0, unknown, unavailable을 구분한다.
- dust 잔량과 정상 잔량을 구분한다.
- trailing state unavailable과 trigger false를 구분한다.
- policy unavailable과 policy에서 금지된 상태를 구분한다.

## Verification

필수 명령:

```sh
corepack pnpm exec vitest run tests/unit/rule-engine.test.ts tests/unit/strategy-variants.test.ts tests/unit/config.test.ts
corepack pnpm typecheck
./scripts/verify docs
```

가능하면 추가 실행:

```sh
corepack pnpm exec vitest run tests/unit/execution-engine.test.ts tests/unit/risk-runtime-integration.test.ts
```

## Final Hygiene Self-Check

구현을 마치기 전에 `.reasonix/skills/implementation-hygiene-self-check.md`가 있으면 읽고 03 구현 hygiene 자기검열을 수행한다.

현재 저장소에는 `scripts/check-implementation-hygiene.mjs`와 JSON contract가 없으므로 해당 자동 명령은 생략한다. 이후 contract가 추가되면 아래 형식으로 실행한다.

```sh
bun scripts/check-implementation-hygiene.mjs --contract docs/generated/<contract-path>.json
```

hard fail이 있으면 수정한다. warning은 실제 문제인지 재검토하고, 수정하지 않으면 이유를 한국어로 보고한다. 최종 보고에는 hard fail, warning, 수정한 항목, 수정하지 않은 항목과 이유를 포함한다.

## Report Back

최종 보고는 한국어로 작성하고 아래를 포함한다.

- 변경 파일 목록
- 구현한 exit rule 목록
- dust/min-order/position 초과 처리 방식
- 실행한 검증 명령과 결과
- Sub PR 02로 넘겨야 할 contract 또는 open risk
- 구현하지 않은 범위

## Handoff Command

```sh
mkdir -p .local/transcripts && npx --yes reasonix run --effort high --budget 1.00 --transcript .local/transcripts/issue-165-subpr-01-contracts-rules.reasonix.jsonl "Read docs/exec-plans/active/2026-06-07-issue-165-subpr-01-contracts-rules-deepseek-handoff.md and implement Sub PR 01 Contracts & Rules only. Do not implement Sub PR 02, Sub PR 03, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."
```
