# Issue #159 Sub PR 03 Review Fix DeepSeek Implementation Handoff

## Goal

현재 Sub PR 03 Producer & Status Why Summary 구현에서 Codex 리뷰로 발견된 결함을 모두 수정한다. `paper-decision-runner` 실행 결과가 frame별 decision ledger append로 실제 연결되어야 하고, producer는 다중 frame/다중 strategy/evidence를 정확히 보존해야 하며, `/status.why`는 조회 실패와 기록 없음이 구분되는 한국어 safe summary를 반환해야 한다.

## Split Decision

단일 handoff로 진행한다.

리뷰 finding은 모두 같은 runtime 흐름에 속한다.

```text
PaperDecisionRunner trace
  -> frame별 DecisionLedgerFrame + DecisionEvidenceItem
  -> append-only repository write
  -> DB-backed WhySummaryProvider
  -> GET /status why
```

producer, runner writer wiring, status unavailable handling, HTTP schema/test fixture는 서로 맞물려 있어 분리하면 같은 타입과 테스트를 반복 수정하게 된다. 별도 sub handoff로 나누지 않는다.

## Unit Metadata

- `Goal`: Sub PR 03 리뷰 finding 6건을 모두 수정하고 runner ledger write, producer correctness, `/status.why` unavailable semantics, HTTP/runner tests를 통과시킨다.
- `Owns`: `src/application/paper-decision-runner.ts`, `src/application/paper-decision-runner/**`, `src/application/decision-ledger.ts`, `src/application/decision-ledger/**`, `src/infrastructure/db/decision-ledger.ts`, `src/infrastructure/db/decision-ledger/**`, `src/interfaces/http-control.ts`, `src/interfaces/http-control/**`, `src/runtime/paper-decision-runner.ts`, `tests/unit/decision-ledger.test.ts`, `tests/unit/paper-decision-runner.test.ts`, `tests/unit/http-control.test.ts`, 필요 시 `tests/integration/decision-ledger.test.ts`.
- `Excludes`: LLM boundary 구현, Telegram inbound `/why`, 별도 write/control endpoint, live broker wiring, live order submit/cancel 경로, 주문 side effect 재시도, 자동 매도/exit engine, 신규 runtime dependency, 자동 commit/PR/merge.
- `Dependencies`: Sub PR 01 public contract와 Sub PR 02 ledger persistence가 현재 branch에 반영되어 있어야 한다. 현재 worktree에는 Sub PR 03 초기 구현 변경이 있을 수 있으며, 먼저 `git status --short`와 `git diff`로 기존 변경을 읽고 그 위에 고친다.
- `Parallel`: 불가. 같은 application contract, runner service, HTTP status schema/test를 동시에 수정하므로 병렬 작업이 충돌한다.
- `Verification`: `corepack pnpm typecheck`, targeted vitest, live order API source scan이 통과해야 한다. DB integration은 로컬 DB가 없으면 guard skip 근거를 한국어로 보고한다.
- `Handoff command`: `mkdir -p .local/transcripts && npx --yes reasonix run --effort high --budget 1.20 --transcript .local/transcripts/issue-159-subpr-03-review-fix.deepseek.jsonl "Read docs/exec-plans/active/2026-06-06-issue-159-subpr-03-review-fix-deepseek-handoff.md and implement all review fixes for Sub PR 03 only. Assume Sub PR 01 and Sub PR 02 are complete and current Sub PR 03 initial changes may already exist. Do not implement LLM boundary, Telegram inbound, live broker wiring, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."`

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

구현 전에 반드시 아래 파일을 읽는다.

- `AGENTS.md`
- `ARCHITECTURE.md`
- `docs/README.md`
- `docs/generated/context-map.json`
- `docs/PRD.md`
- `docs/FEATURE_REQUIREMENTS.md`
- `docs/DEVELOPMENT.md`
- `docs/PLANS.md`
- `docs/RUNTIME_CONFIG.md`
- `docs/RELIABILITY.md`
- `docs/SECURITY.md`
- `docs/product-specs/upbit-live-autonomous-trading.md`
- `docs/design-docs/2026-05-15-m1-database-schema.md`
- `docs/design-docs/2026-05-20-typescript-module-structure.md`
- `docs/exec-plans/active/2026-06-06-issue-159-m18-decision-ledger-reasonix-handoff.md`
- `docs/generated/2026-06-06-issue-159-m18-decision-ledger-reasonix-handoff.contract.json`
- `src/application/paper-decision-runner/service.ts`
- `src/application/paper-decision-runner/types.ts`
- `src/application/decision-ledger.ts`
- `src/application/decision-ledger/**`
- `src/infrastructure/db/decision-ledger/repository.ts`
- `src/infrastructure/db/decision-ledger/types.ts`
- `src/interfaces/http-control/status.ts`
- `src/interfaces/http-control/types.ts`
- `tests/unit/paper-decision-runner.test.ts`
- `tests/unit/http-control.test.ts`
- `tests/unit/decision-ledger.test.ts`

우선순위:

1. 이 handoff 문서
2. `AGENTS.md`
3. `ARCHITECTURE.md`
4. `docs/FEATURE_REQUIREMENTS.md`
5. `docs/exec-plans/active/2026-06-06-issue-159-m18-decision-ledger-reasonix-handoff.md`

## Current State

Codex review에서 다음 finding이 확인됐다.

- `paper-decision-runner`가 ledger writer/repository를 전혀 호출하지 않는다. 현재 runner는 `framesProcessed`, `metrics`, `trace`만 반환한다.
- `/status.why` provider 실패가 `UNAVAILABLE` summary가 아니라 `null` 또는 빈 projection 기반 `NOT_FOUND`로 내려간다.
- producer가 여러 입력 frame을 하나의 `DecisionLedgerFrame`으로 접고, 첫 trace record의 frame id를 전체 결과의 `sourceFrameId`로 사용한다.
- evidence fingerprint seed가 `dedupeKey + stage + frameId`뿐이라 같은 frame/stage의 여러 strategy/order evidence가 충돌한다.
- `ORDER_INTENT_CONVERSION` category가 실제 converter reason code(`order_intent_promoted`)를 고려하지 않아 대부분 `SELL`로 오분류된다.
- `ControlStatusSnapshot` fixture helper가 새 필수 `why` 필드를 채우지 않아 typecheck 실패 위험이 있고, 실제 HTTP status surface test가 빠져 있다.

검증 환경 상태:

- 이 worktree는 `node_modules`가 없을 수 있다. 구현자는 가능하면 `corepack pnpm install --frozen-lockfile` 후 검증한다.
- Codex review 시 `corepack pnpm typecheck`는 `tsc: not found`, targeted vitest는 `vitest: not found`로 실행되지 않았다.
- 기존 live broker 관련 `submitOrder`/`cancelOrder` source는 존재하지만, Sub PR 03 fix가 새 live order path를 추가하면 안 된다.

## Scope

허용되는 변경은 아래로 제한한다.

- `PaperDecisionRunnerPorts` 또는 인접 application contract에 ledger writer port를 추가한다.
- runner 완료 단계에서 frame별 producer 결과를 repository/writer에 append한다.
- ledger write 실패는 broker/order side effect를 재시도하지 않고, runner 결과 또는 ledger status/evidence에 실패를 보존한다.
- producer는 `PaperDecisionRunnerResult.trace`를 frame id 기준으로 나누고, 각 frame 또는 frame+strategy 흐름별 `DecisionLedgerFrame`을 만든다.
- 다중 strategy, 다중 order intent, 동일 stage 반복 evidence의 fingerprint가 충돌하지 않도록 안정 seed를 보강한다.
- order intent category는 실제 strategy decision/order intent direction에서 판정한다. direction을 알 수 없으면 `BUY`/`SELL`로 추정하지 않는다.
- `buildDecisionLedgerFromRunnerResult` 반환 shape를 바꿔야 한다면 public export와 테스트를 함께 갱신한다.
- DB-backed why summary provider는 query 실패를 `UNAVAILABLE` section/summary로 표현한다.
- `/status`는 why provider가 주입된 상태에서 provider 실패를 `why.readStatus="UNAVAILABLE"` 형태로 반환하고 endpoint 전체는 HTTP 200을 유지한다.
- provider 미주입의 `why: null` 정책을 유지할 수 있지만, 주입된 provider 실패와 기록 없음은 반드시 구분한다.
- `ControlStatusSnapshot` fixture helper와 schema/test를 새 `why` contract에 맞춘다.
- `tests/unit/http-control.test.ts`에 why provider 성공, provider 실패/DB 실패, `why: null` 기본 동작을 검증하는 테스트를 추가한다.
- `tests/unit/paper-decision-runner.test.ts`에 ledger writer 호출, frame별 append, write 실패 격리 테스트를 추가한다.
- `tests/unit/decision-ledger.test.ts`에 다중 frame, 동일 frame 동일 stage 다중 evidence fingerprint, BUY/SELL conversion category, unavailable summary 테스트를 추가한다.
- 필요하면 `tests/integration/decision-ledger.test.ts`에 repository append와 why provider 최신 조회를 보강한다.

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
- 주문 side effect 재시도. ledger write 실패 때문에 이미 끝난 broker/order 결과를 다시 실행하지 않는다.
- 신규 runtime dependency 또는 lockfile 변경.
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
application/decision-ledger ports -> infrastructure/db/decision-ledger
runtime -> application ports + infrastructure implementation 조립
```

`application`은 `infrastructure`를 import하지 않는다. runner가 DB repository concrete class를 직접 알게 만들지 말고 application-level writer port를 통해 호출한다. infrastructure DB repository는 runtime 또는 테스트 조립부에서 writer port로 주입한다.

### Recommended Flow

```text
PaperDecisionRunner.run()
  -> frame trace groups
  -> build ledger frame/evidence per source frame or frame+strategy flow
  -> writer.appendFrame(frame)
  -> writer.appendEvidenceItems(dbFrameId, evidenceItems)
  -> append result summary recorded in runner result or ledger status trace
```

writer 실패:

```text
broker/execution result remains unchanged
no broker retry
runner resolves with deterministic metrics/trace
ledger write failure is visible in Korean report/status trace or dedicated runner ledger result
```

### Status Flow

```text
GET /status
  -> read whySummaryProvider if injected
  -> provider success: why summary
  -> provider failure: why.readStatus = UNAVAILABLE with Korean section messages
  -> provider not injected: why = null
```

## Dependency Direction

- 신규 dependency를 추가하지 않는다.
- DB 접근은 기존 Kysely `Database` type과 `PostgresDecisionLedgerRepository` 패턴을 따른다.
- crypto가 필요하면 Node built-in `node:crypto`를 사용한다. 외부 hash package를 추가하지 않는다.
- JSON validation이 필요하면 기존 `zod` 또는 기존 validation helper를 재사용한다.
- HTTP response schema는 기존 Fastify schema style을 유지한다.
- test runner는 기존 Vitest만 사용한다.

## Contracts

### Runner Ledger Writer Contract

application layer에 최소 writer port를 둔다. 이름은 구현자가 기존 style에 맞춰 정하되 다음 의미를 만족해야 한다.

- frame append 입력은 `DecisionLedgerFrame`이다.
- evidence append 입력은 durable frame id와 `DecisionEvidenceItem[]`이다.
- 중복 frame/evidence append는 repository idempotency 결과를 그대로 보존한다.
- write 실패는 throw될 수 있지만 runner가 broker/order side effect를 재시도하면 안 된다.
- writer가 주입되지 않은 fixture run은 deterministic runner result를 유지한다. 이 경우 ledger status는 `UNAVAILABLE`, `NOT_CONFIGURED`, 또는 명확한 trace reason으로 표현한다.

### Producer Contract

- 한 `DecisionLedgerFrame`은 한 `PaperDecisionInputFrame.id`와 하나의 strategy 평가 흐름을 기본 단위로 한다.
- 여러 input frame을 처리한 runner result는 여러 ledger frame을 만든다.
- `sourceFrameId`는 해당 trace group의 frame id다.
- `dedupeKey`는 같은 source run, source frame, strategy/correlation scope를 안정적으로 포함한다.
- `evidenceFingerprint`는 최소한 frame dedupe key, stage, stage occurrence index 또는 stable source id, strategy id, reason code, order id/idempotency key 중 필요한 값을 포함해 같은 stage 반복을 구분한다.
- `FRAME_RECEIVED` 자체는 evidence로 저장하지 않을 수 있지만, frame observedAt/sourceFrameId를 결정하는 근거로 사용한다.
- `ORDER_INTENT_CONVERSION`의 BUY/SELL category는 converter reason code로 추정하지 않는다. 실제 strategy decision direction 또는 order intent direction metadata가 없으면 `DISCARD`, `HOLD`, 또는 별도 safe category로 낮춘다.
- payload/trace는 JSONB-safe 값만 포함한다. `Date`, `BigInt`, function, class instance를 넣지 않는다.
- raw order detail, raw provider payload, secret 후보 key/value를 payload/trace에 넣지 않는다.

### Why Summary Unavailable Contract

- 기록 없음은 `NOT_FOUND`다.
- 조회 실패는 `UNAVAILABLE`이다.
- `UNAVAILABLE` section은 `statusLabel`, `message`, `impact`, `action`에 한국어 안내를 담는다.
- `UNAVAILABLE` section의 item 목록은 비어 있을 수 있지만, 빈 목록만으로 실패를 표현하면 안 된다.
- `/status` endpoint는 why 조회 실패 때문에 500을 반환하지 않는다.
- `whySummaryProvider`가 주입되지 않은 경우의 `why: null`은 허용한다. 단, 주입된 provider가 실패하면 `null`로 낮추지 않는다.

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

- runner가 0 frame을 처리하면 ledger write를 시도하지 않고 summary에 명확한 unavailable/not found reason을 남긴다.
- 한 frame에서 여러 strategy가 평가되면 strategy별 evidence fingerprint가 충돌하지 않는다.
- 한 strategy가 여러 order intent를 만들면 order intent/cost/risk/execution evidence가 서로 덮이지 않는다.
- 같은 sourceRunId/sourceFrameId 재실행은 frame/evidence 중복 row를 만들지 않는다.
- broker가 거부한 paper order는 `EXECUTION_REJECTED` 또는 execution evidence로 남기고 fill metric과 구분한다.
- cost rejection과 risk rejection이 같은 frame에 섞이면 frame category 우선순위는 기존 contract를 따르되 evidence category는 각각 보존한다.
- cash/global frame은 가짜 market code를 만들지 않는다.
- sourceRunId가 없으면 `unknown` 문자열로 섞지 말고 unavailable reason을 trace에 남긴다.
- provider query 중 market section만 실패하는 구조를 선택한다면 section별 `UNAVAILABLE`을 보존한다. 단순화를 위해 전체 provider failure를 전체 `UNAVAILABLE`으로 낮춰도 된다.
- typecheck가 fixture 누락을 잡으면 fixture에 `why`를 추가하고 실제 HTTP test를 보강한다.

## Acceptance Criteria

- runner 실행 결과가 decision ledger writer를 통해 frame/evidence append를 호출한다.
- producer는 다중 input frame을 여러 ledger frame으로 보존한다.
- producer evidence fingerprint는 같은 frame/stage 반복에서도 충돌하지 않는다.
- order intent conversion category는 실제 direction을 사용하고 `order_intent_promoted`를 `SELL`로 오분류하지 않는다.
- ledger write 실패는 broker/execution 재시도를 만들지 않고 runner 결과를 유지한다.
- `/status.why` provider 실패는 `UNAVAILABLE` summary와 한국어 조치 문구로 표현된다.
- 기록 없음(`NOT_FOUND`)과 조회 실패(`UNAVAILABLE`)가 test에서 구분된다.
- `ControlStatusSnapshot` fixture와 HTTP schema가 `why` contract에 맞는다.
- 실제 HTTP status provider test가 `why.markets`, `why.strategies`, `why.cash`, `why: null`, `UNAVAILABLE`을 검증한다.
- cost rejection과 risk rejection evidence가 서로 다른 category/reason으로 남는다.
- payload/trace에는 raw provider payload, raw order detail, Authorization/JWT/API key/secret이 없다.
- 기본 `PAPER_NO_KEY` runtime에서 live order API 신규 호출 경로가 생기지 않는다.

## Acceptance Criteria Trace Matrix

| AC | 사용자 관측면 | 예상 수정 파일 | 필수 테스트 | 완료로 보지 않는 경우 |
| --- | --- | --- | --- | --- |
| runner ledger write 연결 | runner 실행 후 repository/writer append 호출 | `src/application/paper-decision-runner/**`, `src/application/decision-ledger/**`, `src/runtime/paper-decision-runner.ts` | `tests/unit/paper-decision-runner.test.ts` | producer 함수만 만들고 runner가 writer를 호출하지 않는 경우 |
| 다중 frame producer | ledger frame/detail query 또는 producer result | `src/application/decision-ledger/frame-builder.ts`, `tests/unit/decision-ledger.test.ts` | `tests/unit/decision-ledger.test.ts` | 여러 trace frame을 첫 frame dedupeKey 아래 evidence로 섞는 경우 |
| fingerprint 충돌 방지 | repository evidence append 결과 | `src/application/decision-ledger/frame-builder.ts`, `src/infrastructure/db/decision-ledger/**` | `tests/unit/decision-ledger.test.ts`, `tests/unit/decision-ledger-persistence.test.ts` | 같은 frame/stage의 두 evidence가 같은 fingerprint를 갖는 경우 |
| order intent category 정확성 | why trace category와 evidence category | `src/application/decision-ledger/frame-builder.ts`, `src/application/paper-decision-runner/**` | `tests/unit/decision-ledger.test.ts`, `tests/unit/paper-decision-runner.test.ts` | `order_intent_promoted`가 `SELL`로 저장되는 경우 |
| ledger write 실패 격리 | runner result와 broker 호출 횟수 | `src/application/paper-decision-runner/**` | `tests/unit/paper-decision-runner.test.ts` | ledger write 실패가 broker submit retry 또는 주문 허용 보정을 만드는 경우 |
| `/status.why` unavailable | GET `/status` JSON | `src/interfaces/http-control/**`, `src/application/decision-ledger/why-summary.ts`, `src/infrastructure/db/decision-ledger/status-provider.ts` | `tests/unit/http-control.test.ts`, `tests/unit/decision-ledger.test.ts` | provider 실패가 `why: null` 또는 `NOT_FOUND`로 내려가는 경우 |
| HTTP fixture/schema 정합성 | typecheck와 GET `/status` schema | `src/interfaces/http-control/types.ts`, `src/interfaces/http-control/schemas.ts`, `tests/unit/http-control.test.ts` | `corepack pnpm typecheck`, `tests/unit/http-control.test.ts` | `ControlStatusSnapshot` 수동 fixture에 `why`가 빠진 경우 |
| 한국어 사용자 문구 우선 | `why.*.statusLabel/message/impact/action` | `src/application/decision-ledger/user-facing.ts`, `src/interfaces/http-control/**` | `tests/unit/decision-ledger.test.ts`, `tests/unit/http-control.test.ts` | 내부 reason code가 첫 화면 설명을 대체하는 경우 |
| cost/risk 구분 | ledger evidence와 `/status.why` trace | `src/application/decision-ledger/**`, `src/application/paper-decision-runner/**` | `tests/unit/decision-ledger.test.ts`, `tests/unit/paper-decision-runner.test.ts` | cost/risk rejection을 모두 `DISCARD`로 합치는 경우 |
| secret/raw payload 미노출 | ledger payload/status response | `src/application/decision-ledger/**`, `src/infrastructure/db/decision-ledger/**`, `src/interfaces/http-control/**` | `tests/unit/decision-ledger.test.ts`, `tests/unit/http-control.test.ts` | raw order detail, Authorization/JWT/API key가 payload/trace/status에 남는 경우 |
| live order API 0회 | source scan | `src/application/**`, `src/infrastructure/**`, `src/interfaces/**`, `src/runtime/**` | source scan, targeted tests | 새 `POST /v1/orders`, `DELETE /v1/order`, live broker wiring을 추가하는 경우 |

## Forbidden Completion Shortcuts

- 새 provider/function/type을 만들거나 export한 것만으로 integration 완료라고 보고하지 않는다.
- producer 직접 호출 테스트만으로 runner ledger write integration을 대체하지 않는다.
- `/status` schema에 필드만 추가하고 provider wiring/HTTP test가 없으면 완료로 보지 않는다.
- `paper-decision-runner` trace에 값이 있다는 이유만으로 durable ledger 완료라고 주장하지 않는다.
- ledger write 실패 테스트 없이 "실패해도 재시도하지 않는다"고 보고하지 않는다.
- `why: null`만 반환하면서 provider 실패 격리라고 보고하지 않는다.
- 기록 없음과 DB 조회 실패를 모두 `NOT_FOUND` 또는 `null`로 합치면 완료로 보지 않는다.
- `order_intent_promoted`를 `BUY`/`SELL` 방향 정보로 취급하지 않는다.
- 같은 fingerprint를 repository idempotency로 skip시키는 것을 중복 방지 성공으로 오해하지 않는다.
- typecheck를 실행하지 않고 fixture 누락을 수동 추정으로 닫지 않는다.
- handoff 문서나 필수 기준 문서를 읽을 수 없으면 추론 구현하지 말고 중단 보고한다.

## User-Facing Surface Checklist

- `GET /status` response에 `why`가 포함된다.
- provider 미주입 기본값은 명확하게 `why: null`로 테스트된다.
- provider 성공 시 `why.markets`, `why.strategies`, `why.cash`가 모두 read-only로 동작한다.
- provider 실패 시 `why.readStatus=UNAVAILABLE` 또는 section `readStatus=UNAVAILABLE`이 내려간다.
- `UNAVAILABLE` 상태도 한국어 `statusLabel/message/impact/action`을 가진다.
- 내부 category, reason code, fingerprint, order id, correlation id는 `trace`에 분리된다.
- raw provider payload, raw order detail, Authorization/JWT/API key는 응답에 없다.
- 실제 HTTP status provider test가 있다.

## Semantic Contracts

- current/latest why summary와 historical ledger detail을 같은 배열에 섞지 않는다.
- empty/not found와 read failure/unavailable을 같은 `null` 또는 같은 `NOT_FOUND`로 합치지 않는다.
- 실제 count 0과 unknown/unavailable을 구분한다.
- strategy `HOLD`와 cash `CASH_HOLD`를 구분한다.
- cost rejection과 risk rejection을 같은 discard reason bucket으로 합치지 않는다.
- execution rejected와 risk rejected를 구분한다.
- sourceRunId가 없으면 `unknown` 문자열이 아니라 trace unavailable reason을 사용한다.
- raw provider payload, secret, Authorization header는 trace에도 원문으로 남기지 않는다.

## Verification

필수 명령:

```sh
corepack pnpm typecheck
corepack pnpm exec vitest run tests/unit/decision-ledger.test.ts tests/unit/decision-ledger-persistence.test.ts tests/unit/paper-decision-runner.test.ts tests/unit/http-control.test.ts
```

가능하면 DB integration:

```sh
SEEMIRAI_RUN_DB_INTEGRATION=1 corepack pnpm exec vitest run tests/integration/decision-ledger.test.ts tests/integration/migrations.test.ts
```

문서 구조를 변경했다면:

```sh
./scripts/verify docs
```

live order API source scan:

```sh
git diff --name-only origin/main...HEAD -- src/application src/infrastructure src/interfaces src/runtime | xargs --no-run-if-empty rg -n "POST /v1/orders|DELETE /v1/order|UpbitLiveBroker|createUpbitLiveBroker|submitOrder\\(|cancelOrder\\("
```

scan 결과에는 기존 live broker/guard 경로가 나올 수 있다. Sub PR 03 fix가 새로 추가한 live broker wiring 또는 private order endpoint 호출이 없는지 diff 기준으로 보고한다.

## Final Hygiene Self-Check

구현을 마치기 전에 `.reasonix/skills/implementation-hygiene-self-check.md`가 있으면 읽고 03 구현 hygiene 자기검열을 수행한다.

가능하면 아래 명령을 실행한다.

```sh
bun scripts/check-implementation-hygiene.mjs --contract docs/generated/2026-06-06-issue-159-subpr-03-review-fix-deepseek-handoff.contract.json
```

파일이나 script가 없으면 없는 사실을 한국어로 보고한다. hard fail이 있으면 수정한다. warning은 실제 문제인지 재검토하고, 수정하지 않으면 이유를 한국어로 보고한다.

## Report Back

최종 보고는 한국어로 작성하고 아래를 포함한다.

- 수정한 리뷰 finding 목록과 각 finding의 해결 방식.
- 변경한 주요 파일.
- runner ledger write가 어떤 port/repository 경계로 연결됐는지.
- 다중 frame과 다중 evidence fingerprint 충돌 방지 방식.
- `ORDER_INTENT_CONVERSION` category 판정 방식.
- `/status.why` success, `NOT_FOUND`, `UNAVAILABLE`, `null` 예시.
- ledger write 실패 시 broker retry가 없다는 테스트 근거.
- 실행한 검증 명령과 결과.
- DB integration을 실행하지 못했다면 정확한 이유.
- live order API source scan 결과.
- hygiene self-check hard fail/warning 결과.
- 남은 리스크와 open question.

## Handoff Command

```sh
mkdir -p .local/transcripts && npx --yes reasonix run --effort high --budget 1.20 --transcript .local/transcripts/issue-159-subpr-03-review-fix.deepseek.jsonl "Read docs/exec-plans/active/2026-06-06-issue-159-subpr-03-review-fix-deepseek-handoff.md and implement all review fixes for Sub PR 03 only. Assume Sub PR 01 and Sub PR 02 are complete and current Sub PR 03 initial changes may already exist. Do not implement LLM boundary, Telegram inbound, live broker wiring, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."
```
