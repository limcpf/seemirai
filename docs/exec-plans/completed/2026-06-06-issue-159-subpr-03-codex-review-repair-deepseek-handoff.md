# Issue #159 Sub PR 03 Codex Review Repair DeepSeek Implementation Handoff

## Goal

Issue #159 Sub PR 03 Producer & Status Why Summary의 DeepSeek 구현 결과에 대해 Codex review가 다시 발견한 P1급 결함을 모두 수정한다. `paper-decision-runner` ledger writer는 durable DB frame id로 frame/evidence를 재시도 가능하게 연결해야 하고, producer는 frame/strategy 단위 category와 reason count를 정확히 보존해야 하며, DB-backed `/status.why`는 기록 없음과 조회 실패를 확실히 구분해야 한다. 최종 상태는 `corepack pnpm typecheck`, targeted unit tests, 문서 검증, `./scripts/verify`가 통과해야 한다.

## Split Decision

단일 handoff로 진행한다.

이번 수리는 서로 분리된 기능 추가가 아니라 같은 runtime 흐름의 끊어진 연결을 고치는 작업이다.

```text
PaperDecisionRunner trace
  -> frame/strategy 단위 DecisionLedgerFrame + DecisionEvidenceItem
  -> application writer port
  -> DB repository adapter
  -> DB-backed WhySummaryProvider
  -> GET /status why
  -> typecheck/unit/verify
```

writer port, producer grouping, DB-backed why provider, HTTP schema/test fixture가 같은 public contract를 공유한다. 분리하면 같은 타입과 테스트 fixture를 반복 수정하게 되므로 과분할이다.

## Unit Metadata

- `Goal`: Codex review finding 전부를 고쳐 Sub PR 03 Producer & Status Why Summary가 runner write, producer correctness, `/status.why` unavailable semantics, typecheck, tests, verify 기준을 만족하게 한다.
- `Owns`: `src/application/paper-decision-runner.ts`, `src/application/paper-decision-runner/**`, `src/application/decision-ledger.ts`, `src/application/decision-ledger/**`, `src/infrastructure/db/decision-ledger.ts`, `src/infrastructure/db/decision-ledger/**`, `src/interfaces/http-control.ts`, `src/interfaces/http-control/**`, `src/runtime/paper-decision-runner.ts` 또는 인접 조립부, `tests/unit/decision-ledger.test.ts`, `tests/unit/paper-decision-runner.test.ts`, `tests/unit/http-control.test.ts`, 필요 시 `tests/integration/decision-ledger.test.ts`.
- `Excludes`: LLM boundary, Telegram inbound command, 별도 `/why` endpoint, live broker wiring, UpbitLiveBroker 연결, `POST /v1/orders`/`DELETE /v1/order` 신규 호출 경로, M19 이후 exit engine, 신규 runtime dependency, lockfile 변경, migration 변경, 자동 commit/PR/merge.
- `Dependencies`: 현재 worktree의 Sub PR 01/02/03 변경과 `docs/exec-plans/completed/2026-06-06-issue-159-subpr-03-review-fix-deepseek-handoff.md`가 선행 입력이다. 먼저 `git status --short`, `git diff`, `corepack pnpm typecheck` 실패를 확인하고 그 위에 최소 수정한다.
- `Parallel`: 불가. 같은 application contract, producer builder, HTTP schema, unit fixture를 동시에 수정하므로 병렬 작업은 충돌 위험이 높다.
- `Verification`: `corepack pnpm typecheck`, targeted vitest, DB integration guard skip 또는 통과, `./scripts/verify docs`, `./scripts/verify`, live order API source scan이 통과해야 한다.
- `Handoff command`: `mkdir -p .local/transcripts && npx --yes reasonix run --effort high --budget 1.20 --transcript .local/transcripts/issue-159-subpr-03-codex-review-repair.deepseek.jsonl "Read docs/exec-plans/completed/2026-06-06-issue-159-subpr-03-codex-review-repair-deepseek-handoff.md and fix all Codex review findings for Issue #159 Sub PR 03 only. Work on the existing unstaged/untracked implementation. Do not implement LLM boundary, Telegram inbound, live broker wiring, live order API paths, migrations, lockfile changes, automatic commit, PR creation, or unrelated refactors. Report back in Korean."`

## Mandatory Implementation Rules

The implementer must follow these rules throughout the task.

### 한국어 출력 규칙

- 주석 및 결과물은 모두 한국어로 표시한다.
- 사용자-facing CLI 메시지, 에러 메시지, 구현 요약, report back은 한국어로 작성한다.
- 코드 식별자, package script 이름, 외부 API 필드명처럼 관례적으로 영어가 필요한 항목은 영어를 유지할 수 있다.

### 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.
- The test: Every changed line should trace directly to the user's request.

## Read First

The implementer must read these files before editing:

1. `AGENTS.md`
2. `ARCHITECTURE.md`
3. `docs/README.md`
4. `docs/generated/context-map.json`
5. `docs/PRD.md`
6. `docs/FEATURE_REQUIREMENTS.md`
7. `docs/DEVELOPMENT.md`
8. `docs/PLANS.md`
9. `docs/RELIABILITY.md`
10. `docs/SECURITY.md`
11. `docs/exec-plans/completed/2026-06-06-issue-159-m18-decision-ledger-reasonix-handoff.md`
12. `docs/exec-plans/completed/2026-06-06-issue-159-subpr-03-review-fix-deepseek-handoff.md`
13. `docs/exec-plans/completed/2026-06-06-issue-159-subpr-03-codex-review-repair-deepseek-handoff.md`
14. `src/application/paper-decision-runner/service.ts`
15. `src/application/paper-decision-runner/types.ts`
16. `src/application/decision-ledger/frame-builder.ts`
17. `src/application/decision-ledger/why-summary.ts`
18. `src/infrastructure/db/decision-ledger/repository.ts`
19. `src/infrastructure/db/decision-ledger/status-provider.ts`
20. `src/interfaces/http-control/status.ts`
21. `src/interfaces/http-control/schemas.ts`
22. `src/interfaces/http-control/types.ts`
23. `tests/unit/decision-ledger.test.ts`
24. `tests/unit/paper-decision-runner.test.ts`
25. `tests/unit/http-control.test.ts`

If any instruction conflicts, follow this priority:

1. This handoff document
2. `AGENTS.md`
3. `ARCHITECTURE.md`
4. `docs/exec-plans/completed/2026-06-06-issue-159-m18-decision-ledger-reasonix-handoff.md`
5. `docs/exec-plans/completed/2026-06-06-issue-159-subpr-03-review-fix-deepseek-handoff.md`
6. `docs/FEATURE_REQUIREMENTS.md`

## Current State

현재 worktree에는 Sub PR 03 review-fix 구현 변경이 staged 없이 unstaged/untracked 상태로 존재한다.

Codex review에서 남은 blocking finding:

- `paper-decision-runner`가 evidence append에 durable DB frame id가 아니라 `frame.sourceFrameId`를 넘긴다.
- `PaperDecisionLedgerWriterPort.appendFrame` 결과가 durable id를 반환하지 않아 실제 `PostgresDecisionLedgerRepository`와 맞지 않는다.
- duplicate frame에서 evidence append를 생략해, 이전 실행에서 frame만 insert되고 evidence가 실패한 경우 재시도 복구가 불가능하다.
- producer가 `frameId`만으로 그룹화하고 runner 전체 `paperOrderSubmittedCount`/`paperFillCount`를 모든 frame category 판정에 재사용한다.
- producer가 frame+strategy flow contract를 지키지 않아 다중 strategy가 한 frame 안에 섞일 수 있다.
- DB-backed why provider가 query 실패를 catch한 뒤 빈 projection으로 `NOT_FOUND`를 반환한다.
- HTTP layer의 injected provider failure `UNAVAILABLE` 테스트는 필요하지만, DB-backed provider failure도 별도로 검증해야 한다.
- `tests/unit/decision-ledger.test.ts`가 새 `{ frames: [...] }` 반환 shape와 `PaperDecisionRunnerResult` 필수 필드에 맞지 않아 typecheck가 실패한다.
- `tests/unit/http-control.test.ts`의 `statusSnapshotProvider` fixture가 `why`를 누락해 `/status`가 500을 반환한다.
- `tests/unit/paper-decision-runner.test.ts`에 runner ledger writer 호출, duplicate frame evidence append, writer failure isolation 검증이 없다.
- `/status.why` success, provider not injected `why: null`, injected provider failure, DB provider query failure HTTP surface 테스트가 없다.

최근 검증 결과:

- `corepack pnpm typecheck`: 실패.
- `corepack pnpm exec vitest run tests/unit/decision-ledger.test.ts tests/unit/paper-decision-runner.test.ts tests/unit/http-control.test.ts`: 실패. decision-ledger 3건, http-control 1건 실패.
- `corepack pnpm exec vitest run tests/integration/decision-ledger.test.ts tests/integration/migrations.test.ts`: DB guard로 20건 skip.
- `./scripts/verify docs`: 통과.
- `./scripts/verify`: 문서/hook/GitHub 검증 통과 후 typecheck 실패.
- 변경 diff live order API scan: 신규 `POST /v1/orders`, `DELETE /v1/order` 매칭 없음.

## Scope

허용되는 변경은 아래로 제한한다.

- `PaperDecisionLedgerWriterPort`를 durable frame id 반환이 가능한 shape로 수정한다.
- runner가 `appendFrame` 결과의 durable id를 사용해 evidence를 append하게 한다.
- duplicate frame(`inserted=false`)이어도 evidence append를 시도해 idempotent 재시도 복구가 가능하게 한다.
- `PostgresDecisionLedgerRepository`와 application writer port 사이의 adapter 또는 mapping을 필요한 최소 범위로 추가한다. application layer가 infrastructure를 import하면 안 된다.
- runner ledger write 실패는 broker/execution side effect를 재시도하지 않고 `ledgerWriteStatus`로만 보고한다. 일부 frame/evidence만 쓴 뒤 실패했다면 `PARTIAL` 또는 명확한 `UNAVAILABLE` 정책을 테스트로 고정한다.
- producer grouping을 `sourceFrameId + strategyId` 또는 equivalent strategy flow grain으로 보정한다.
- producer category, reasonCounts, evidence category는 해당 group trace에서 계산한다. runner 전체 metric을 모든 frame에 복사하지 않는다.
- producer dedupeKey는 sourceRunId, sourceFrameId, strategy/correlation scope를 안정적으로 포함한다.
- producer evidence fingerprint는 같은 frame/stage 반복, 다중 strategy, 다중 order intent, cost/risk/execution 반복에서 충돌하지 않게 한다.
- `ORDER_INTENT_CONVERSION`은 `metadata.intent_directions` 같은 실제 direction만 사용한다. direction이 없으면 BUY/SELL로 추정하지 않는다.
- DB-backed why provider query failure는 `UNAVAILABLE` summary로 표현한다. 빈 projection 기반 `NOT_FOUND`와 섞지 않는다.
- `/status` schema와 `ControlStatusSnapshot` fixture를 `why` contract에 맞춘다.
- `tests/unit/decision-ledger.test.ts`, `tests/unit/paper-decision-runner.test.ts`, `tests/unit/http-control.test.ts`를 새 contract와 acceptance criteria에 맞게 수정한다.
- 문서 구조를 바꾸지 않는 한 추가 문서는 만들지 않는다. 이 handoff 산출물 자체를 구현자가 수정할 필요는 없다.

## Non-goals

아래는 구현하면 안 된다.

- LLM summary provider, LLM attachment, LLM failure evidence 구현.
- Telegram inbound `/why`, `/pnl`, `/positions`, `/risk` command.
- 별도 `/why` endpoint, write endpoint, control endpoint.
- M19 exit engine, 자동 매도, trailing stop, stop loss, take profit.
- M20 Telegram 양방향 운영, M21 수동 승인 live pilot, M22 자동 실거래.
- LLM 직접 매수/매도 판단 또는 LLM output을 RiskGate/Broker input으로 사용하는 변경.
- `UpbitLiveBroker`를 `paper-decision-runner` 또는 strategy runtime에 연결.
- `POST /v1/orders`, `DELETE /v1/order`, live broker `submitOrder`, live broker `cancelOrder` 신규 호출 경로.
- ledger write 실패 때문에 이미 끝난 broker/order 결과를 다시 실행하는 주문 side effect 재시도.
- 신규 runtime dependency, package manager 변경, lockfile 변경.
- migration 추가/수정. 이번 수리는 기존 decision ledger schema와 repository contract 위에서 해결한다.
- 기존 migration 파일 수정, migration version gap 생성, ledger schema 목적 외 DB schema 변경.
- raw provider payload, raw order detail, Authorization header, JWT, API key, secret key, query hash 원문 저장 또는 노출.
- 투자 자문 문구, 매수/매도 추천 문구, 수익 보장 표현.
- 웹 대시보드나 UI 작업.
- M17 PnL summary, daily report, live reconcile behavior를 M18과 무관하게 바꾸는 작업.
- 관련 없는 문서 정리, 포맷 변경, 광범위한 모듈 분리.
- 자동 commit, PR 생성, branch merge, force push.

## Architecture Direction

### Layering

의존 방향은 기존 M18 handoff를 유지한다.

```text
domain/shared -> application/decision-ledger -> interfaces/http-control
application/paper-decision-runner -> application/decision-ledger port
application port -> infrastructure/db adapter
runtime/test composition -> port implementation injection
```

`application`은 `infrastructure`를 import하지 않는다. `interfaces/http-control`은 `WhySummaryProvider` contract만 알고 DB row나 raw payload를 직접 해석하지 않는다. DB repository concrete class는 infrastructure 또는 runtime 조립부에 머문다.

### Runner Write Flow

권장 흐름:

```text
PaperDecisionRunner.run()
  -> collect trace and final metrics
  -> buildDecisionLedgerFromRunnerResult(...)
  -> for each frameResult:
       appendFrame(frame) -> durable frame id
       appendEvidenceItems(durableFrameId, evidenceItems)
  -> return runner metrics/trace + ledgerWriteStatus
```

주의:

- `sourceFrameId`는 DB FK가 아니다.
- `appendEvidenceItems`에는 durable DB `decision_ledger_frames.id`를 넘겨야 한다.
- duplicate frame이어도 repository evidence idempotency로 중복 append를 차단할 수 있어야 한다.
- writer failure는 runner result를 실패로 throw하지 않고 status로 낮춘다. 단, 테스트가 의도적으로 runner throw를 기대하면 안 된다.

### Producer Flow

권장 흐름:

```text
PaperDecisionRunnerResult.trace
  -> group by sourceFrameId
  -> within frame, group by strategyId / no-strategy flow
  -> derive group-local category and reasonCounts from records
  -> build DecisionLedgerFrame per group
  -> build DecisionEvidenceItem per record with stable fingerprint
```

`FRAME_RECEIVED`는 observedAt/sourceFrameId 결정 근거로 쓰되 evidence item으로 저장하지 않아도 된다. strategyId가 없는 frame-level record는 같은 frame의 strategy groups에 필요한 context로 병합하거나, 주문 후보가 전혀 없는 frame-level flow로만 저장한다. 같은 frame에서 여러 strategy가 평가되면 서로 다른 ledger frame 또는 명확히 구분된 flow로 남겨야 한다.

### Status Flow

```text
GET /status
  -> whySummaryProvider not injected: why = null
  -> injected provider success: why summary
  -> injected provider throw: why.readStatus = UNAVAILABLE
  -> DB-backed provider query failure: why.readStatus = UNAVAILABLE
  -> no ledger rows: why.readStatus = NOT_FOUND
```

`UNAVAILABLE` section은 빈 item 목록만으로 표현하지 않는다. `statusLabel`, `message`, `impact`, `action`, `trace.reason`에 한국어 상태와 조치 문구가 있어야 한다.

## Dependency Direction

- 신규 dependency를 추가하지 않는다.
- hash가 필요하면 Node built-in `node:crypto`를 사용한다. 기존 단순 hash를 유지할 수 있지만, 충돌 방지 seed는 충분히 안정적이어야 한다.
- Decimal 계산은 기존 `decimal.js`와 shared helper를 유지한다.
- runtime validation이 필요하면 기존 helper 또는 `zod`를 재사용하되, 새 dependency를 추가하지 않는다.
- DB 접근은 기존 Kysely `Database`, `PostgresDecisionLedgerRepository`, row mapper, validation 패턴을 따른다.
- HTTP response schema는 기존 Fastify schema style을 유지한다.
- test runner는 기존 Vitest만 사용한다.
- lockfile은 수정하지 않는다.

## Contracts

### Runner Ledger Writer Contract

application layer writer port는 다음 의미를 만족해야 한다.

- `appendFrame(frame)` 입력은 `DecisionLedgerFrame`이다.
- `appendFrame(frame)` 결과는 최소한 `inserted`와 durable frame id를 제공한다.
- durable frame id는 `decision_ledger_frames.id` FK로 사용할 수 있는 값이다.
- `appendEvidenceItems(frameId, evidenceItems)`의 `frameId`는 durable DB frame id다.
- duplicate frame/evidence append는 repository idempotency 결과를 보존한다.
- duplicate frame이어도 evidence append를 시도해, 이전 실패로 누락된 evidence가 있으면 채울 수 있어야 한다.
- writer failure는 throw될 수 있지만 runner가 broker/order side effect를 재시도하면 안 된다.
- writer가 주입되지 않은 fixture run은 deterministic runner result를 유지하고 `ledgerWriteStatus="NOT_CONFIGURED"`를 반환한다.

### Producer Contract

- 한 `DecisionLedgerFrame`은 한 `PaperDecisionInputFrame.id`와 하나의 strategy 평가 흐름을 기본 단위로 한다.
- 여러 input frame을 처리한 runner result는 여러 ledger frame을 만든다.
- 같은 input frame에서 여러 strategy가 평가되면 strategy별 판단이 섞이지 않는다.
- `sourceFrameId`는 해당 trace group의 frame id다.
- `strategyId`는 해당 trace group의 strategy id다. cash/global 판단이면 `null`이 가능하다.
- `dedupeKey`는 source run, source frame, strategy/correlation scope를 포함한다.
- `reasonCounts`는 group-local hold/discard/cost/risk/execution reason만 담는다.
- `category`는 group-local evidence에서 결정한다. runner 전체 `paperFillCount` 하나로 모든 group을 `EXECUTED`로 만들지 않는다.
- `ORDER_INTENT_CONVERSION`의 BUY/SELL category는 converter reason code로 추정하지 않는다. 실제 direction metadata가 없으면 BUY/SELL이 아닌 safe category로 낮춘다.
- `evidenceFingerprint`는 frame dedupe key, stage, occurrence index, strategy id, reason code, order id/idempotency key 등 필요한 안정 값을 포함한다.
- payload/trace는 JSONB-safe 값만 포함한다.
- raw order detail, raw provider payload, secret 후보 key/value를 payload/trace에 넣지 않는다.

### Why Summary Unavailable Contract

- 기록 없음은 `NOT_FOUND`다.
- 조회 실패는 `UNAVAILABLE`이다.
- DB-backed provider 내부 query failure도 `UNAVAILABLE`이다.
- `UNAVAILABLE` section은 한국어 `statusLabel`, `message`, `impact`, `action`을 가진다.
- `/status` endpoint는 why 조회 실패 때문에 500을 반환하지 않는다.
- `whySummaryProvider`가 주입되지 않은 경우의 `why: null`은 유지한다.
- injected provider failure와 DB provider query failure는 `why: null` 또는 `NOT_FOUND`로 낮추지 않는다.

### HTTP Schema Contract

`/status` 200 schema는 다음을 허용해야 한다.

- `why: null`
- `why.readStatus`: `OK`, `NOT_FOUND`, `UNAVAILABLE`
- `why.markets.readStatus`: `OK`, `NOT_FOUND`, `UNAVAILABLE`
- `why.strategies.readStatus`: `OK`, `NOT_FOUND`, `UNAVAILABLE`
- `why.cash.readStatus`: `OK`, `NOT_FOUND`, `UNAVAILABLE`
- 모든 section에는 한국어 `statusLabel`, `message`, `impact`, `action`, `trace`가 있다.
- user-facing 최상위 필드에 raw internal reason code를 직접 올리지 않는다. reason code는 `trace.reasonCode` 같은 trace 영역에 둔다.

## Edge Cases

- runner가 0 frame을 처리하면 ledger write를 시도하지 않거나 빈 `frames` 결과를 안전하게 처리한다. 이 경우 writer 호출 횟수를 테스트로 고정한다.
- sourceRunId가 없으면 `paper-runner-${Date.now()}` 같은 비결정 id를 dedupe key에 섞지 않는다. `null`과 trace unavailable reason을 사용하거나 deterministic source id를 주입받는다.
- 한 frame에서 여러 strategy가 모두 HOLD면 strategy별 HOLD evidence와 cash hold summary가 서로 모순되지 않아야 한다.
- 한 strategy가 여러 order intent를 만들면 order intent/cost/risk/execution evidence가 서로 덮이지 않는다.
- 같은 sourceRunId/sourceFrameId/strategy 재실행은 frame/evidence 중복 row를 만들지 않는다.
- broker가 거부한 paper order는 `EXECUTION_REJECTED` 또는 execution evidence로 남기고 fill metric과 구분한다.
- cost rejection과 risk rejection이 같은 run에 섞여도 각 frame/evidence category는 해당 group의 실제 경계 결과를 따른다.
- DB provider에서 market query만 실패하는 구조를 선택할 수 있지만, 단순화를 위해 전체 provider failure를 전체 `UNAVAILABLE`으로 낮춰도 된다.
- `ControlStatusSnapshot` fixture helper는 `why: null`을 기본으로 채워 기존 status tests를 깨지 않게 한다.
- HTTP `/status` response schema가 `why`를 필수로 요구하면 모든 fixture provider도 반드시 `why`를 반환한다.

## Acceptance Criteria

- runner 실행 결과가 decision ledger writer를 통해 frame/evidence append를 호출한다.
- runner evidence append는 durable DB frame id를 사용한다.
- duplicate frame 재시도에서도 evidence append가 idempotent하게 시도된다.
- ledger write 실패는 broker/execution 재시도를 만들지 않고 runner result를 유지한다.
- producer는 다중 input frame을 여러 ledger frame으로 보존한다.
- producer는 같은 input frame의 다중 strategy 흐름을 섞지 않는다.
- producer category와 reasonCounts는 group-local evidence에서 산출된다.
- producer evidence fingerprint는 같은 frame/stage 반복에서도 충돌하지 않는다.
- order intent conversion category는 실제 direction을 사용하고 `order_intent_promoted`를 SELL로 오분류하지 않는다.
- DB-backed `/status.why` provider 실패는 `UNAVAILABLE` summary와 한국어 조치 문구로 표현된다.
- 기록 없음(`NOT_FOUND`)과 조회 실패(`UNAVAILABLE`)가 test에서 구분된다.
- `ControlStatusSnapshot` fixture와 HTTP schema가 `why` contract에 맞는다.
- 실제 HTTP status provider test가 `why.markets`, `why.strategies`, `why.cash`, `why: null`, injected provider failure, DB provider failure를 검증한다.
- cost rejection과 risk rejection evidence가 서로 다른 category/reason으로 남는다.
- payload/trace에는 raw provider payload, raw order detail, Authorization/JWT/API key/secret이 없다.
- 기본 `PAPER_NO_KEY` runtime에서 live order API 신규 호출 경로가 생기지 않는다.
- `corepack pnpm typecheck`, targeted unit tests, `./scripts/verify docs`, `./scripts/verify`가 통과한다.

## Acceptance Criteria Trace Matrix

| AC | 사용자 관측면 | 예상 수정 파일 | 필수 테스트 | 완료로 보지 않는 경우 |
| --- | --- | --- | --- | --- |
| runner durable writer 연결 | runner 실행 후 ledger writer append 호출 | `src/application/paper-decision-runner/**`, `src/application/decision-ledger/**`, 필요 시 `src/infrastructure/db/decision-ledger/**` | `tests/unit/paper-decision-runner.test.ts` | writer port만 바꾸고 evidence가 sourceFrameId로 append되는 경우 |
| duplicate frame evidence 재시도 | 재실행 시 누락 evidence 복구 | `src/application/paper-decision-runner/service.ts`, writer adapter | `tests/unit/paper-decision-runner.test.ts`, 가능하면 repository integration | `inserted=false`일 때 evidence append를 생략하는 경우 |
| ledger write 실패 격리 | runner result와 broker 호출 횟수 | `src/application/paper-decision-runner/service.ts` | `tests/unit/paper-decision-runner.test.ts` | ledger failure가 broker submit 재호출 또는 runner throw를 만드는 경우 |
| 다중 frame producer | ledger frame/detail query 또는 producer result | `src/application/decision-ledger/frame-builder.ts` | `tests/unit/decision-ledger.test.ts` | 한 run의 fill count로 모든 frame이 EXECUTED가 되는 경우 |
| 다중 strategy producer | strategy별 why summary | `src/application/decision-ledger/frame-builder.ts` | `tests/unit/decision-ledger.test.ts` | 같은 sourceFrameId의 여러 strategy가 하나의 strategyId로 접히는 경우 |
| group-local reason count | `/status.why.cash`와 ledger reason count | `src/application/decision-ledger/frame-builder.ts`, `src/application/decision-ledger/why-summary.ts` | `tests/unit/decision-ledger.test.ts` | runner 전체 blockingReasonCounts가 모든 frame에 복사되는 경우 |
| fingerprint 충돌 방지 | repository evidence append 결과 | `src/application/decision-ledger/frame-builder.ts` | `tests/unit/decision-ledger.test.ts`, `tests/unit/decision-ledger-persistence.test.ts` | 같은 frame/stage의 두 evidence가 같은 fingerprint를 갖는 경우 |
| order intent category 정확성 | why trace category와 evidence category | `src/application/decision-ledger/frame-builder.ts`, `src/application/paper-decision-runner/**` | `tests/unit/decision-ledger.test.ts`, `tests/unit/paper-decision-runner.test.ts` | `order_intent_promoted`가 BUY/SELL direction으로 취급되는 경우 |
| `/status.why` unavailable | GET `/status` JSON | `src/interfaces/http-control/**`, `src/infrastructure/db/decision-ledger/status-provider.ts` | `tests/unit/http-control.test.ts`, `tests/unit/decision-ledger.test.ts` | provider 실패가 `why: null` 또는 `NOT_FOUND`로 내려가는 경우 |
| DB-backed provider failure | DB query failure safe summary | `src/infrastructure/db/decision-ledger/status-provider.ts` | `tests/unit/http-control.test.ts` 또는 DB provider unit test | DB catch가 빈 projection으로 `NOT_FOUND`를 반환하는 경우 |
| HTTP fixture/schema 정합성 | typecheck와 GET `/status` schema | `src/interfaces/http-control/types.ts`, `src/interfaces/http-control/schemas.ts`, `tests/unit/http-control.test.ts` | `corepack pnpm typecheck`, `tests/unit/http-control.test.ts` | `ControlStatusSnapshot` fixture에 `why`가 빠진 경우 |
| 한국어 사용자 문구 우선 | `why.*.statusLabel/message/impact/action` | `src/application/decision-ledger/user-facing.ts`, `src/interfaces/http-control/**` | `tests/unit/decision-ledger.test.ts`, `tests/unit/http-control.test.ts` | 내부 reason code가 첫 화면 설명을 대체하는 경우 |
| live order API 0회 | source scan | `src/application/**`, `src/infrastructure/**`, `src/interfaces/**`, `src/runtime/**` | source scan | 새 `POST /v1/orders`, `DELETE /v1/order`, live broker wiring을 추가하는 경우 |

## Forbidden Completion Shortcuts

- 새 provider/function/type을 만들거나 export한 것만으로 integration 완료라고 보고하지 않는다.
- producer 직접 호출 테스트만으로 runner ledger write integration을 대체하지 않는다.
- fake writer가 호출됐다는 사실만으로 durable DB id contract 완료라고 주장하지 않는다.
- duplicate frame에서 evidence append를 생략하면서 repository idempotency 완료라고 보고하지 않는다.
- runner 전체 metric을 frame별 category에 재사용하면서 다중 frame producer 완료라고 보고하지 않는다.
- `frameId`만 group key로 쓰면서 다중 strategy producer 완료라고 보고하지 않는다.
- `/status` schema에 필드만 추가하고 provider wiring/HTTP test가 없으면 완료로 보지 않는다.
- `why: null`만 반환하면서 provider 실패 격리라고 보고하지 않는다.
- DB provider failure를 빈 projection 기반 `NOT_FOUND`로 낮추면 완료로 보지 않는다.
- 기록 없음과 DB 조회 실패를 모두 `NOT_FOUND` 또는 `null`로 합치면 완료로 보지 않는다.
- `order_intent_promoted`를 BUY/SELL 방향 정보로 취급하지 않는다.
- 같은 fingerprint를 repository idempotency로 skip시키는 것을 충돌 방지 성공으로 오해하지 않는다.
- typecheck를 실행하지 않고 fixture 누락을 수동 추정으로 닫지 않는다.
- handoff 문서나 필수 기준 문서를 읽을 수 없으면 추론 구현하지 말고 중단 보고한다.

## User-Facing Surface Checklist

- `GET /status` response에 `why`가 포함된다.
- provider 미주입 기본값은 `why: null`로 테스트된다.
- injected provider 성공은 `why.markets`, `why.strategies`, `why.cash`를 HTTP response에서 확인한다.
- injected provider failure는 HTTP 200과 `why.readStatus="UNAVAILABLE"`로 테스트된다.
- DB-backed provider query failure는 `UNAVAILABLE`로 테스트된다.
- ledger 기록 없음은 `NOT_FOUND`로 테스트된다.
- section `statusLabel`, `message`, `impact`, `action`은 한국어다.
- 내부 reason code, fingerprint, correlation id, order id는 `trace`에 분리된다.
- raw provider payload, raw order detail, Authorization/JWT/API key는 응답에 없다.
- runner에서 ledger write가 실패해도 broker/execution 재시도나 주문 허용 보정이 없다.

## Semantic Contracts

- durable DB frame id와 source frame id는 다른 값이다. evidence FK에는 durable DB frame id만 사용한다.
- frame duplicate와 evidence duplicate는 별도 idempotency 경계다. frame duplicate가 evidence append skip을 의미하지 않는다.
- current runner trace와 historical DB why summary를 같은 배열/필드로 섞지 않는다.
- empty/not found와 read failure/unavailable을 같은 null 응답으로 합치지 않는다.
- 실제 count 0과 unknown/unavailable을 구분한다.
- cost rejection과 risk rejection을 같은 discard reason으로 합치지 않는다.
- strategy HOLD와 cash hold를 구분한다. HOLD는 strategy 판단이고 CASH_HOLD는 주문 후보 0건 frame의 운영 상태 설명이다.
- execution rejected와 risk rejected를 구분한다. execution rejected는 Cost/Risk 이후의 실행 경계 결과다.
- raw provider payload, secret, Authorization header는 trace에도 원문으로 남기지 않는다.

## Verification

필수 검증:

```sh
corepack pnpm typecheck
```

```sh
corepack pnpm exec vitest run tests/unit/decision-ledger.test.ts tests/unit/decision-ledger-persistence.test.ts tests/unit/paper-decision-runner.test.ts tests/unit/http-control.test.ts
```

DB integration이 준비된 환경이면 다음을 실행한다.

```sh
SEEMIRAI_RUN_DB_INTEGRATION=1 corepack pnpm exec vitest run tests/integration/decision-ledger.test.ts tests/integration/migrations.test.ts
```

DB integration guard가 기본 off라면 다음 명령으로 guard-skip 근거를 보고해도 된다.

```sh
corepack pnpm exec vitest run tests/integration/decision-ledger.test.ts tests/integration/migrations.test.ts
```

문서 구조와 전체 검증:

```sh
./scripts/verify docs
```

```sh
./scripts/verify
```

live order API 회귀 scan:

```sh
git diff --name-only origin/main...HEAD -- src/application src/infrastructure src/interfaces src/runtime | xargs --no-run-if-empty rg -n "POST /v1/orders|DELETE /v1/order|UpbitLiveBroker|createUpbitLiveBroker|submitOrder\\(|cancelOrder\\("
```

기대 결과:

- typecheck가 통과한다.
- targeted unit tests가 통과한다.
- DB integration이 guard-skip이면 skip 조건과 이유를 한국어로 보고한다. DB를 사용할 수 있으면 migration/repository integration도 통과해야 한다.
- `./scripts/verify docs`와 `./scripts/verify`가 통과한다.
- live order API source scan에서 이번 변경이 실거래 주문 생성/취소 경로를 추가하지 않았다는 근거가 확인된다. 기존 disabled/live broker 정의가 매칭되면 신규 호출 경로인지 diff 기준으로 설명한다.

## Final Hygiene Self-Check

구현을 마치기 전에 `.reasonix/skills/implementation-hygiene-self-check.md`가 있으면 읽고 03 구현 hygiene 자기검열을 수행한다.

가능하면 아래 명령을 실행한다.

```sh
bun scripts/check-implementation-hygiene.mjs --contract docs/generated/2026-06-06-issue-159-subpr-03-codex-review-repair-deepseek-handoff.contract.json
```

현재 repository에 해당 script가 없으면 새로 만들지 말고 생략 사유를 최종 보고에 적는다. hard fail이 있으면 수정한다. warning은 실제 문제인지 재검토하고, 수정하지 않으면 이유를 한국어로 보고한다.

Final Hygiene Self-Check 뒤에는 acceptance criteria trace matrix를 다시 채우고, 각 AC가 어떤 테스트와 사용자 표면으로 검증됐는지 보고한다.

## Report Back

최종 보고에는 아래를 포함한다.

- 완료한 범위와 수정한 Codex review finding 목록.
- 변경한 주요 파일.
- runner writer port가 durable DB frame id를 어떻게 보존하는지.
- duplicate frame 재시도에서 evidence append가 어떻게 동작하는지.
- producer가 frame/strategy 단위 category와 reasonCounts를 어떻게 계산하는지.
- cost rejection과 risk rejection을 어떻게 구분했는지.
- 주문 후보 0건 frame을 어떻게 설명했는지.
- `/status.why`에서 `why: null`, `NOT_FOUND`, `UNAVAILABLE`을 어떻게 구분했는지.
- 사용자-facing 한국어 문구 예시.
- 실행한 검증 명령과 결과.
- DB integration 또는 전체 verify를 실행하지 못했다면 정확한 이유.
- live order API 호출 경로를 추가하지 않았다는 scan 근거.
- hard fail/warning 자기검열 결과.
- 남은 리스크와 open question.

## Handoff Command

```sh
mkdir -p .local/transcripts && npx --yes reasonix run --effort high --budget 1.20 --transcript .local/transcripts/issue-159-subpr-03-codex-review-repair.deepseek.jsonl "Read docs/exec-plans/completed/2026-06-06-issue-159-subpr-03-codex-review-repair-deepseek-handoff.md and fix all Codex review findings for Issue #159 Sub PR 03 only. Work on the existing unstaged/untracked implementation. Do not implement LLM boundary, Telegram inbound, live broker wiring, live order API paths, migrations, lockfile changes, automatic commit, PR creation, or unrelated refactors. Report back in Korean."
```
