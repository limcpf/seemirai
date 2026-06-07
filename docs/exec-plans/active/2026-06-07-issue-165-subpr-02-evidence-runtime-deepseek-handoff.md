# Issue #165 Sub PR 02 Evidence & Runtime Integration DeepSeek Implementation Handoff

## Goal

M19 Sub PR 02는 Sub PR 01의 exit contract와 rule output을 실제 paper execution workflow에 연결한다. 구현자는 exit intent가 RiskGate approval 없이 broker로 제출되지 않게 하고, exit 비용 evidence가 `REDUCE|EXIT` intent에만 적용되게 하며, partial fill, 미체결, cancel/requote, reconcile mismatch가 신규 진입 중지와 manual review evidence로 수렴하도록 runtime과 persistence를 통합해야 한다.

## Split Decision

Issue #165는 3개 sub PR로 분할한다. 이 handoff는 **Sub PR 02**다.

persistence와 runtime을 분리하지 않는 이유는 exit 실패, partial fill 잔량, RiskGate 승인, decision ledger evidence, PnL/position context가 같은 order lifecycle에서 함께 검증되어야 하기 때문이다. repository만 만들거나 runtime만 연결하면 "코드는 있으나 사용자 표면과 복구 evidence에 연결되지 않은" 상태가 되기 쉽다.

## Unit Metadata

- `Goal`: exit order evidence, RiskGate, decision ledger, PnL/position context, ExecutionEngine, PaperBroker, cancel/requote, 신규 진입 중지 전이를 하나의 paper runtime 흐름으로 연결한다.
- `Owns`: `src/application/execution/**`, `src/infrastructure/paper/paper-broker.ts`, `src/infrastructure/paper/paper-broker/**`, `src/infrastructure/db/execution-persistence.ts`, `src/infrastructure/db/execution-persistence/**`, `src/application/risk/**`, `src/infrastructure/db/risk-gate-runtime-event-store.ts`, `src/application/decision-ledger/**`, `src/infrastructure/db/decision-ledger/**`, `src/application/pnl-accounting/**`, `src/runtime/execution-runtime.ts`, 관련 tests.
- `Excludes`: Sub PR 01 rule contract 변경 재작업, guarded live pilot smoke 실행, M20 Telegram inbound, M21 수동 승인 주문 플로우, M22 무승인 자동 실거래, 신규 dependency, 자동 commit, PR 생성, merge.
- `Dependencies`: Sub PR 01 완료. exit contract와 fixture가 merge되어 있어야 한다.
- `Parallel`: 불가. Sub PR 03은 이 단위의 runtime/evidence 결과에 의존한다.
- `Verification`: `corepack pnpm exec vitest run tests/unit/execution-engine.test.ts tests/unit/paper-broker.test.ts tests/unit/paper-fill-simulator.test.ts tests/unit/execution-runtime.test.ts tests/unit/risk-runtime-integration.test.ts tests/unit/decision-ledger.test.ts tests/unit/pnl-accounting.test.ts`, 관련 integration tests, `corepack pnpm typecheck`.
- `Handoff command`: `mkdir -p .local/transcripts && npx --yes reasonix run --effort high --budget 1.20 --transcript .local/transcripts/issue-165-subpr-02-evidence-runtime.reasonix.jsonl "Read docs/exec-plans/active/2026-06-07-issue-165-subpr-02-evidence-runtime-deepseek-handoff.md and implement Sub PR 02 Evidence & Runtime Integration only. Assume Sub PR 01 is complete. Do not implement Sub PR 03, guarded live pilot smoke execution, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."`

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
- If a simpler approach exists, say so.
- If something is unclear, stop and ask.

### 2. Simplicity First

- No features beyond this handoff.
- No abstractions for single-use code.
- No dependency additions.
- Keep the runtime path readable and testable.

### 3. Surgical Changes

- Touch only files needed for Sub PR 02.
- Do not refactor entry strategy code except where required by exit integration contract.
- Do not change existing migration files.
- Remove unused code introduced by this sub PR.

## Read First

구현 전에 반드시 아래 파일을 읽는다.

- `AGENTS.md`
- `ARCHITECTURE.md`
- `docs/README.md`
- `docs/generated/context-map.json`
- `docs/FEATURE_REQUIREMENTS.md`
- `docs/RUNTIME_CONFIG.md`
- `docs/RELIABILITY.md`
- `docs/SECURITY.md`
- `docs/product-specs/upbit-live-autonomous-trading.md`
- `docs/exec-plans/active/2026-06-07-issue-165-m19-subpr-orchestration.md`
- `docs/exec-plans/active/2026-06-07-issue-165-subpr-01-contracts-rules-deepseek-handoff.md`
- `docs/exec-plans/completed/2026-06-04-issue-154-m17-pnl-position-accounting.md`
- `docs/exec-plans/completed/2026-06-06-issue-159-m18-decision-ledger-closeout.md`
- `src/application/execution/**`
- `src/infrastructure/paper/paper-broker.ts`
- `src/infrastructure/paper/paper-broker/**`
- `src/infrastructure/db/execution-persistence.ts`
- `src/application/risk/**`
- `src/infrastructure/db/risk-gate-runtime-event-store.ts`
- `src/application/decision-ledger/**`
- `src/application/pnl-accounting/**`
- `src/runtime/execution-runtime.ts`
- `tests/unit/execution-engine.test.ts`
- `tests/unit/paper-broker.test.ts`
- `tests/unit/paper-fill-simulator.test.ts`
- `tests/unit/execution-runtime.test.ts`
- `tests/unit/risk-runtime-integration.test.ts`

우선순위가 충돌하면 다음 순서를 따른다.

1. 이 handoff 문서
2. Sub PR 01에서 확정한 contract
3. Issue #165 본문
4. `AGENTS.md`
5. `ARCHITECTURE.md`
6. `docs/FEATURE_REQUIREMENTS.md`
7. 기존 코드 contract와 테스트

## Current State

- `ExecutionEngine`은 비용 snapshot과 RiskGate approval evidence가 현재 intent fingerprint와 일치할 때만 `BrokerPort.submitOrder`를 호출한다.
- fingerprint는 `position_effect`, limit option, expected loss를 포함한다.
- `PaperBroker`는 limit fill, partial fill, cancel, open order list, in-memory balance를 지원한다.
- `PostgresExecutionPersistenceRepository`는 paper execution 결과를 `orders`, `paper_orders`, `fills`, `positions`, `order_events`에 저장한다.
- `RiskGateRuntimeEventStore`는 order/risk/audit/kill switch evidence를 하나의 transaction으로 append한다.
- M18 decision ledger는 `/status.why` summary와 append-only evidence contract를 갖는다.
- `hard stop` runtime은 pending paper order cancel만 실행하고 open position 자동 청산을 금지한다.

## Scope

허용 범위는 아래로 제한한다.

- Sub PR 01의 exit intent를 `OrderSubmission`으로 승격하는 adapter/service 추가.
- exit cost evidence가 `position_effect=REDUCE|EXIT` intent에만 허용되도록 검증한다.
- entry intent에 exit cost evidence가 붙으면 broker 호출 전 fail-closed 한다.
- RiskGate approval 없는 exit order는 broker로 제출하지 않는다.
- RiskGate context와 exit intent의 market, strategy, side, quantity, price, expected loss, position effect mismatch를 fail-closed 한다.
- paper broker partial SELL fill, unfilled, cancel/requote, remaining quantity 계산을 검증한다.
- partial fill 후 잔량 기준으로 후속 cancel/requote 또는 남은 exit intent를 계산한다.
- exit 실패, reconcile mismatch, position quantity mismatch는 신규 진입 중지와 manual review evidence로 수렴한다.
- decision ledger에 SELL/HOLD/EXECUTION_REJECTED/PNL_STATUS_CONTEXT 또는 동등한 M19 evidence를 append-only로 남긴다.
- PnL/position context와 exit result가 같은 market/strategy scope를 가리키는지 검증한다.
- 사용자-facing summary에 필요한 한국어 message/action과 trace 분리를 제공한다.
- 핵심 TypeScript 타입/인터페이스/함수에는 한국어 JSDoc을 작성한다.
- DB write, 상태 전이, RiskGate, idempotency, retry/failure branch에는 "왜 이 분기에서 차단/기록/지연/커밋하는지" 한국어 한 줄 주석을 남긴다.

## Non-goals

아래는 구현하면 안 된다.

- live broker 자동 주문 연결.
- guarded live pilot smoke 실행 또는 artifact 작성.
- Upbit private 주문 API 호출 경로 추가.
- Telegram inbound command.
- M21 approval workflow.
- M22 autonomous live trading.
- hard stop open position 자동 청산.
- 신규 dependency 추가.
- 기존 entry order approval을 느슨하게 만드는 변경.
- Sub PR 01의 rule scope 재설계.
- 최종 closeout 문서 이동.
- 자동 commit, PR 생성, merge, force push.

## Architecture Direction

권장 runtime 흐름:

```text
ExitRule/ExitDecision
  -> ExitOrderIntent
  -> exit cost evidence
  -> RiskGateContext + RiskGateResult
  -> ExecutionEngine validation
  -> PaperBroker submit/cancel
  -> execution persistence + risk/audit/ledger evidence
  -> PnL/position context update or manual review evidence
```

구현 위치 후보:

```text
src/application/exit-engine/
  submission.ts
  runtime-evidence.ts
  remaining-intent.ts
src/application/execution/execution-engine/
  validation.ts
  evidence-fingerprint.ts
src/infrastructure/db/execution-persistence/
  row-mapper.ts
  state-transition-mapper.ts
src/runtime/execution-runtime.ts
```

새 public entry가 필요하면 same-basename directory 규칙을 지킨다.

## Dependency Direction

- application service는 broker port와 repository port만 알고 Upbit client를 알지 않는다.
- infrastructure DB repository는 application contract를 구현하지만 application에서 infrastructure를 import하지 않는다.
- runtime assembly만 concrete repository/broker를 조립한다.
- decision ledger write 실패는 이미 발생한 broker side effect를 재시도하지 않는다.
- Telegram/provider side effect는 이 sub PR 범위가 아니다.

## Contracts

필수 contract:

- Exit submission validation은 `position_effect=REDUCE|EXIT`를 필수로 본다.
- exit 비용 evidence는 entry `cost_margin_ok` snapshot과 다른 source/reason contract를 갖는다.
- `REDUCE`는 남은 포지션이 존재할 수 있고, `EXIT`는 전체 종료 의도다.
- partial fill result는 filled quantity, remaining quantity, canceled quantity를 분리한다.
- cancel/requote는 동일 exit scope와 idempotency lineage를 보존한다.
- manual review evidence는 신규 진입 차단 reason과 연결된다.
- raw provider payload, secret, Authorization header는 evidence/trace에 저장하지 않는다.

## Edge Cases

- RiskGate approval이 `ALLOW`가 아니면 exit도 broker로 제출하지 않는다.
- RiskGate approval이 entry intent fingerprint를 가리키면 exit submission을 거부한다.
- exit cost evidence가 entry intent에 붙으면 거부한다.
- SELL 수량이 open position보다 크면 broker submit 전에 거부한다.
- partial fill 후 잔량이 dust면 남은 exit intent를 만들지 않고 dust evidence로 닫는다.
- cancel 실패 또는 broker order open 유지 시 신규 진입 중지와 manual review evidence를 남긴다.
- position/PnL source unavailable은 `0`으로 보정하지 않는다.
- live broker disabled stub은 기본 `PAPER_NO_KEY`에서 계속 private API client를 만들지 않는다.

## Acceptance Criteria

- exit cost evidence는 `REDUCE|EXIT` intent에만 허용되고 entry intent에는 재사용되지 않는다.
- RiskGate approval 없이 exit order가 broker로 제출되지 않는다.
- exit intent는 open position 수량과 market/strategy scope를 넘지 않는다.
- partial fill 잔량 기준으로 후속 cancel/requote 또는 남은 exit intent가 계산된다.
- exit 실패 또는 reconcile mismatch는 신규 진입 중지와 manual review evidence로 수렴한다.
- decision ledger에서 매도/보유/축소 판단 이유를 한국어 summary로 조회할 수 있는 근거가 남는다.
- 기본 `PAPER_NO_KEY` runtime의 live order API 호출 0회가 유지된다.
- hard stop은 open position 자동 청산을 만들지 않는다.

## Acceptance Criteria Trace Matrix

| AC | 사용자 관측면 | 예상 수정 파일 | 필수 테스트 | 완료로 보지 않는 경우 |
| --- | --- | --- | --- | --- |
| exit cost evidence 분리 | entry 주문이 exit evidence로 승인되지 않음 | `src/application/execution/**` | `tests/unit/execution-engine.test.ts` | exit source flag만 추가하고 entry reuse 차단 없음 |
| RiskGate approval 필수 | broker submit 호출 전 거부 | `src/application/execution/**`, `src/application/risk/**` | execution/risk runtime tests | RiskGate 없는 exit을 PaperBroker test에서 직접 submit |
| partial fill 잔량 처리 | 잔량 cancel/requote 또는 dust evidence | `src/infrastructure/paper/**`, runtime adapter | `paper-broker`, `paper-fill-simulator`, execution runtime tests | partial fill status만 저장하고 후속 잔량 계산 없음 |
| 실패 시 신규 진입 중지 | manual review evidence와 kill switch/new-entry block | `src/application/risk/**`, `src/runtime/**` | `risk-runtime-integration`, `execution-runtime` tests | 실패 로그만 남기고 신규 진입 차단 없음 |
| decision ledger 연결 | `/status.why`가 읽을 SELL/HOLD/REJECT evidence | `src/application/decision-ledger/**` | decision ledger tests | provider export만 하고 runtime write 없음 |
| live order API 0회 | source scan 결과 | runtime/infrastructure 변경 파일 | source scan | Upbit live broker를 paper runtime에 조립 |

## Forbidden Completion Shortcuts

- 새 function/type export만으로 integration 완료라고 보고하지 않는다.
- ExecutionEngine 직접 호출 테스트만으로 paper broker partial fill/cancel/requote 검증을 대체하지 않는다.
- decision ledger mapper만 만들고 runner/runtime write를 연결하지 않은 상태를 완료라고 보고하지 않는다.
- failure reason을 log만 남기고 RiskGate/audit/ledger evidence로 남기지 않는다.
- partial fill 잔량을 무시하고 주문 상태만 `PARTIALLY_FILLED`로 저장하지 않는다.
- live broker smoke를 실행하지 않았는데 live pilot 완료라고 보고하지 않는다.

## User-Facing Surface Checklist

- exit failure, manual review, dust/min-order, partial fill 잔량은 한국어 상태/원인/영향/필요 조치를 제공한다.
- 내부 reason code, order id, idempotency key, correlation id는 trace/detail 영역에 분리한다.
- `/status.why` 또는 decision ledger provider가 읽을 수 있는 evidence kind/category를 남긴다.
- raw order detail, raw provider payload, secret, Authorization header는 payload/trace에 넣지 않는다.

## Semantic Contracts

- current position source와 historical PnL source를 섞지 않는다.
- empty position과 unavailable position source를 구분한다.
- filled quantity, remaining quantity, canceled quantity를 구분한다.
- dust remaining과 normal remaining을 구분한다.
- actual 0 PnL과 unknown/unavailable PnL을 구분한다.
- entry approval과 exit approval을 같은 evidence source로 합치지 않는다.

## Verification

필수 명령:

```sh
corepack pnpm exec vitest run tests/unit/execution-engine.test.ts tests/unit/paper-broker.test.ts tests/unit/paper-fill-simulator.test.ts tests/unit/execution-runtime.test.ts tests/unit/risk-runtime-integration.test.ts tests/unit/decision-ledger.test.ts tests/unit/pnl-accounting.test.ts
corepack pnpm typecheck
```

가능하면 추가 실행:

```sh
corepack pnpm exec vitest run tests/integration/execution-persistence.test.ts tests/integration/decision-ledger.test.ts tests/integration/order-events.test.ts tests/integration/pnl-accounting.test.ts
git diff --name-only origin/main...HEAD -- src/application src/infrastructure src/interfaces src/runtime | xargs --no-run-if-empty rg -n "POST /v1/orders|DELETE /v1/order|UpbitLiveBroker\\(|createUpbitPrivateClient"
```

DB integration이 guard-skip되면 skip 조건과 이유를 한국어로 보고한다.

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
- exit runtime 흐름 요약
- RiskGate/ledger/PnL evidence 연결 방식
- partial fill/cancel/requote 처리 방식
- 신규 진입 중지/manual review evidence 조건
- 실행한 검증 명령과 결과
- DB integration guard skip 여부
- Sub PR 03으로 넘길 smoke/closeout risk

## Handoff Command

```sh
mkdir -p .local/transcripts && npx --yes reasonix run --effort high --budget 1.20 --transcript .local/transcripts/issue-165-subpr-02-evidence-runtime.reasonix.jsonl "Read docs/exec-plans/active/2026-06-07-issue-165-subpr-02-evidence-runtime-deepseek-handoff.md and implement Sub PR 02 Evidence & Runtime Integration only. Assume Sub PR 01 is complete. Do not implement Sub PR 03, guarded live pilot smoke execution, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."
```
