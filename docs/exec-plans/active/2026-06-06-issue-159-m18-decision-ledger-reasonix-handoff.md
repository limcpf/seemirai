# Issue #159 M18 판단 이유 Ledger와 설명 API Reasonix Implementation Handoff

## Goal

M18은 시스템이 왜 샀는지, 왜 팔았는지, 왜 보유 중인지, 왜 현금 상태를 유지했는지 운영자가 deterministic evidence로 조회할 수 있게 만드는 단계다. 구현자는 이미 생성된 strategy decision, order intent, discard reason, cost breakdown, risk decision, execution result, PnL/status context를 append-only decision ledger로 보존하고, `/status` 하위 read-only `why` summary가 이를 한국어 상태/원인/영향/필요 조치와 `추적 정보`로 설명하게 만들어야 한다. LLM은 판단 생성자가 아니라 deterministic ledger evidence를 요약하는 보조 계층으로만 사용한다.

## Split Decision

이 작업은 Issue #159 본문에 맞춰 4개 sub PR로 순차 분할한다.

4개 이상 분할은 기본적으로 피하지만, M18은 다음 이유로 4개가 적정하다.

- Sub PR 01은 문서와 public contract를 고정한다. 이후 모든 구현 단위가 이 contract와 migration 방향에 의존하므로 먼저 merge되어야 한다.
- Sub PR 02는 ledger domain/application contract와 DB persistence를 함께 소유한다. append-only schema, repository idempotency, user-facing reason mapping은 같은 실패 모드를 공유하므로 분리하면 table shape와 mapper contract를 반복 왕복하게 된다.
- Sub PR 03은 producer runtime과 `/status` why summary를 함께 소유한다. producer 없이 status만 만들면 실제 ledger write contract 검증이 빠지고, status 없이 producer만 만들면 사용자-facing integration이 완료되지 않는다.
- Sub PR 04는 LLM 보조 summary, fail-closed 검증, 전체 verification/closeout을 소유한다. LLM failure와 order-like output 차단은 deterministic summary 이후에 붙는 보조 경계이며, 최종 source scan과 문서 closeout이 같은 검증 책임을 갖는다.

병렬 구현은 권장하지 않는다. Sub PR 01 -> 02 -> 03 -> 04 순서로 진행한다. 같은 파일과 contract를 순차로 확장하므로 병렬 worktree가 오히려 `docs/generated/context-map.json`, `src/application/index.ts`, `src/interfaces/http-control/**`, `src/infrastructure/db/schema.ts`, migration version 충돌을 만들 가능성이 높다.

## Unit Metadata

### Sub PR 01: M18 Plan & Contract

- `Goal`: M18 실행 계획, 문서 기준, decision ledger/why summary public contract를 고정한다.
- `Owns`: `docs/exec-plans/active/**`, `docs/product-specs/upbit-live-autonomous-trading.md`, `docs/RUNTIME_CONFIG.md`, `docs/RELIABILITY.md`, 필요 시 `docs/SECURITY.md`, `docs/design-docs/2026-05-15-m1-database-schema.md`, `docs/generated/context-map.json`, `src/application/decision-ledger.ts`, `src/application/decision-ledger/**`, `src/application/index.ts`, `tests/unit/decision-ledger.test.ts`.
- `Excludes`: DB repository 구현, migration 적용, `paper-decision-runner` ledger write, `/status` why wiring, LLM provider 호출, 자동 commit, PR 생성, branch merge.
- `Dependencies`: 현재 branch `issue-159-mother`, GitHub Issue #159 본문, 이 handoff 문서. M17 PnL/status code가 main에 병합된 상태를 전제로 한다.
- `Parallel`: 불가. 이후 모든 sub PR이 이 contract와 문서 결정에 의존한다.
- `Verification`: `corepack pnpm exec vitest run tests/unit/decision-ledger.test.ts`, `corepack pnpm typecheck`, `./scripts/verify docs`가 통과해야 한다.
- `Handoff command`: `mkdir -p .local/transcripts && npx --yes reasonix run --effort high --budget 0.90 --transcript .local/transcripts/issue-159-subpr-01-plan-contract.reasonix.jsonl "Read docs/exec-plans/active/2026-06-06-issue-159-m18-decision-ledger-reasonix-handoff.md and implement Sub PR 01 M18 Plan & Contract only. Do not implement persistence, producer status summary, LLM boundary, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."`

### Sub PR 02: Ledger Foundation & Persistence

- `Goal`: decision ledger domain/application contract를 실제 append-only DB persistence와 repository idempotency로 연결한다.
- `Owns`: `src/application/decision-ledger.ts`, `src/application/decision-ledger/**`, `src/infrastructure/db/decision-ledger.ts`, `src/infrastructure/db/decision-ledger/**`, `src/infrastructure/db/schema.ts`, `migrations/000013_decision_ledger.sql`, `tests/unit/decision-ledger*.test.ts`, `tests/unit/decision-ledger-persistence.test.ts`, `tests/integration/decision-ledger.test.ts`, `tests/integration/migrations.test.ts`, DB schema 문서.
- `Excludes`: `paper-decision-runner` runtime write wiring, `/status` route/provider wiring, LLM summary generation, Telegram inbound, live order submit/cancel, migration version skip 또는 기존 migration 수정.
- `Dependencies`: Sub PR 01 완료. latest migration은 `000012_live_reconcile_exchange_order_snapshot_dedupe.sql`이므로 새 migration이 필요하면 `000013_decision_ledger.sql`을 사용한다.
- `Parallel`: 불가. Sub PR 03은 repository/provider output shape에 의존한다.
- `Verification`: `corepack pnpm exec vitest run tests/unit/decision-ledger.test.ts tests/unit/decision-ledger-persistence.test.ts tests/integration/decision-ledger.test.ts tests/integration/migrations.test.ts`, `corepack pnpm typecheck`가 통과하거나 DB integration guard skip 근거를 한국어로 보고해야 한다.
- `Handoff command`: `mkdir -p .local/transcripts && npx --yes reasonix run --effort high --budget 1.10 --transcript .local/transcripts/issue-159-subpr-02-ledger-persistence.reasonix.jsonl "Read docs/exec-plans/active/2026-06-06-issue-159-m18-decision-ledger-reasonix-handoff.md and implement Sub PR 02 Ledger Foundation & Persistence only. Assume Sub PR 01 is complete. Do not implement producer/status wiring, LLM boundary, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."`

### Sub PR 03: Producer & Status Why Summary

- `Goal`: `paper-decision-runner` trace를 decision ledger write로 연결하고, `/status` 하위 read-only `why` summary에서 market/strategy/cash hold 이유를 조회 가능하게 만든다.
- `Owns`: `src/application/paper-decision-runner.ts`, `src/application/paper-decision-runner/**`, `src/application/decision-ledger/**`, `src/interfaces/http-control.ts`, `src/interfaces/http-control/**`, `src/runtime/paper-decision-runner.ts`, status 조립부, `tests/unit/paper-decision-runner.test.ts`, `tests/unit/http-control.test.ts`, `tests/unit/decision-ledger*.test.ts`, 필요 시 `tests/integration/decision-ledger.test.ts`, 관련 문서.
- `Excludes`: LLM summary provider, Telegram inbound `/why`, 별도 write/control endpoint, live broker wiring, 주문 side effect 재시도, 자동 매도/exit engine, 신규 runtime dependency.
- `Dependencies`: Sub PR 01, 02 완료. repository write/read contract와 idempotency 결과가 확정되어 있어야 한다.
- `Parallel`: 불가. Sub PR 04의 LLM summary는 deterministic why summary output에 의존한다.
- `Verification`: `corepack pnpm exec vitest run tests/unit/paper-decision-runner.test.ts tests/unit/http-control.test.ts tests/unit/decision-ledger.test.ts`, `corepack pnpm typecheck`, live order API source scan이 통과해야 한다.
- `Handoff command`: `mkdir -p .local/transcripts && npx --yes reasonix run --effort high --budget 1.10 --transcript .local/transcripts/issue-159-subpr-03-producer-status.reasonix.jsonl "Read docs/exec-plans/active/2026-06-06-issue-159-m18-decision-ledger-reasonix-handoff.md and implement Sub PR 03 Producer & Status Why Summary only. Assume Sub PR 01 and Sub PR 02 are complete. Do not implement LLM boundary, Telegram inbound, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."`

### Sub PR 04: LLM Boundary, Verification & Closeout

- `Goal`: deterministic ledger evidence 기반 LLM summary 보조 계층을 추가하고, LLM failure/order-like output fail-closed, 전체 검증, closeout 문서를 완료한다.
- `Owns`: `src/application/decision-ledger/**`, `src/application/llm-risk-assistant/**` 중 필요한 최소 확장, `tests/unit/decision-ledger*.test.ts`, `tests/unit/llm-risk-assistant*.test.ts`, `tests/unit/http-control.test.ts`, `docs/exec-plans/active/**`, `docs/exec-plans/completed/**`, `docs/generated/context-map.json`, `docs/generated/**.contract.json`, 관련 README/index.
- `Excludes`: LLM 직접 매수/매도 판단, LLM output을 RiskGate approval 또는 Broker submission 입력으로 사용, 외부 LLM 기본 CI 호출, Telegram inbound, M19 exit engine, M20 Telegram command, main 대상 PR merge.
- `Dependencies`: Sub PR 01-03 완료. deterministic `/status.why` summary가 외부 LLM 없이 동작해야 한다.
- `Parallel`: 불가. 마지막 검증과 closeout 단위다.
- `Verification`: targeted LLM/why/status tests, `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify docs`, `./scripts/verify`, live order API source scan이 통과해야 한다.
- `Handoff command`: `mkdir -p .local/transcripts && npx --yes reasonix run --effort high --budget 1.00 --transcript .local/transcripts/issue-159-subpr-04-llm-closeout.reasonix.jsonl "Read docs/exec-plans/active/2026-06-06-issue-159-m18-decision-ledger-reasonix-handoff.md and implement Sub PR 04 LLM Boundary, Verification & Closeout only. Assume Sub PR 01, 02, and 03 are complete. Do not implement M19 or later, Telegram inbound, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."`

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
- `docs/exec-plans/completed/2026-06-04-issue-154-m17-pnl-position-accounting.md`
- `src/application/paper-decision-runner.ts`
- `src/application/paper-decision-runner/**`
- `src/application/execution/**`
- `src/application/risk/**`
- `src/application/llm-risk-assistant/**`
- `src/application/pnl-accounting/**`
- `src/interfaces/http-control.ts`
- `src/interfaces/http-control/**`
- `src/infrastructure/db/schema.ts`
- `src/infrastructure/db/migrations.ts`
- `migrations/*.sql`
- `tests/unit/paper-decision-runner.test.ts`
- `tests/unit/http-control.test.ts`
- `tests/unit/llm-risk-assistant*.test.ts`

우선순위가 충돌하면 다음 순서를 따른다.

1. 이 handoff 문서
2. GitHub Issue #159 본문
3. `AGENTS.md`
4. `ARCHITECTURE.md`
5. `docs/FEATURE_REQUIREMENTS.md`
6. `docs/product-specs/upbit-live-autonomous-trading.md`
7. 기존 코드 contract와 테스트

## Current State

- Issue #159은 open 상태이며 목표는 M18 판단 이유 ledger와 설명 API다.
- 현재 branch는 `issue-159-mother`다.
- M17 PnL/포지션 회계는 main에 병합됐고, `/status`에는 `pnl` safe summary가 있다.
- `PaperDecisionRunner`는 `FRAME_RECEIVED`, `STRATEGY_DECISION`, `ORDER_INTENT_CONVERSION`, `COST_DECISION`, `RISK_DECISION`, `EXECUTION_RESULT` trace record와 hold/discard/cost/risk/execution metric을 runtime-local 결과로 만든다.
- `PaperDecisionRunnerResult.metrics.liveOrderApiCalls`는 기본 invariant 확인용으로 항상 `0`이다.
- `/status` 현재 shape는 `runtime`, `tradingState`, `marketData`, `paper`, `database`, `alerts`, `dailyReport`, `pnl`, `reconcile`을 포함한다. M18 전용 `why` summary는 아직 없다.
- `src/application/llm-risk-assistant/**`는 M10 LLM 보조 경계를 갖고 있으며, 금지 action `BUY`, `SELL`, `INCREASE_POSITION`과 order-like field를 거부하는 테스트가 있다. M18은 이 경계를 재사용하거나 최소 확장하되 LLM을 주문 판단 경로로 올리지 않는다.
- DB migration 최신 파일은 `migrations/000012_live_reconcile_exchange_order_snapshot_dedupe.sql`이다. decision ledger table을 추가하면 다음 migration은 `000013_decision_ledger.sql`이어야 한다.
- `docs/exec-plans/active/README.md`는 현재 활성 계획이 없다고 되어 있다. 이 handoff 문서가 M18 active 계획 역할을 한다.
- 현재 저장소에는 `.reasonix/skills/implementation-hygiene-self-check.md`와 `scripts/check-implementation-hygiene.mjs`가 없다. 구현 시점에 생겨 있으면 Final Hygiene Self-Check 절차를 따른다.

## Scope

허용 범위는 아래로 제한한다.

- M18 active 실행 계획과 handoff 문서 갱신.
- M18 완료 조건을 `docs/product-specs/upbit-live-autonomous-trading.md`, `docs/RUNTIME_CONFIG.md`, `docs/RELIABILITY.md`, 필요 시 `docs/SECURITY.md`에 반영.
- `DecisionLedger`와 `WhySummary` public contract 추가.
- strategy decision, order intent, discard reason, cost breakdown, risk decision, execution result, PnL/status context를 frame 단위 evidence로 정규화.
- 판단 category를 stable contract로 정의. 최소 category는 `BUY`, `SELL`, `HOLD`, `CASH_HOLD`, `DISCARD`, `COST_REJECTED`, `RISK_REJECTED`, `EXECUTION_REJECTED`, `EXECUTED`, `EXPLANATION_FAILED`다. 단, frame category는 `EXPLANATION_FAILED`를 제외하고, `BUY`/`SELL`은 주문 의도/판단 단계이며 broker 제출 성공은 `EXECUTED`로만 표현한다.
- 내부 reason code와 사용자-facing 한국어 문구를 분리.
- frame id, exchange, market, strategy id, observed_at, decision_at, correlation id, source run id를 보존.
- 주문 후보 0건 frame도 HOLD/CASH_HOLD/DISCARD reason count와 cash hold 한국어 reason 목록을 남김.
- decision ledger 전용 append-only table과 repository 추가.
- 같은 frame/source/correlation 재실행이 중복 evidence를 만들지 않도록 dedupe key 또는 fingerprint를 고정.
- `paper-decision-runner` trace를 ledger input으로 변환.
- `/status` 하위 read-only `why` summary 추가. 별도 write/control endpoint는 만들지 않는다.
- market별 최근 판단 이유 summary, strategy별 최근 판단 이유 summary, cash hold reason summary를 제공.
- order id 또는 correlation id 기준 trace link는 내부 식별자로만 보존.
- 사용자-facing 응답은 한국어 상태, 원인, 영향, 필요 조치를 먼저 보여주고 내부 식별자는 `추적 정보`나 `trace`에 분리.
- LLM summary 보조 계층은 deterministic ledger evidence를 읽어 요약 초안을 만드는 역할로만 제한.
- LLM provider timeout, invalid JSON, output size 초과, provider 장애는 explanation generation failure evidence로만 저장.
- LLM output에 주문 지시, 포지션 크기, 주문 허용 의미가 있으면 요약 attachment에서 제외하거나 fail-closed evidence로 남김.
- 기본 verify/CI에서는 외부 LLM 호출 없이 fake/noop provider fixture로 검증.
- targeted tests, typecheck, docs verify, full verify, live order API 0회 source scan 실행.
- M18 완료 시 closeout 문서를 작성하고 active/completed 인덱스와 context map을 갱신.

## Non-goals

아래는 구현하면 안 된다.

- 별도 `/why` write endpoint 또는 control endpoint.
- Telegram inbound command. `/why`, `/pnl`, `/positions`, `/risk` 같은 command는 M20 이후 범위다.
- M19 자동 매도, exit engine, trailing stop, stop loss, take profit.
- M20 Telegram 양방향 운영.
- M21 수동 승인 live pilot.
- M22 운영자 승인 없는 자동 실거래.
- LLM 직접 매수/매도 판단.
- LLM output을 strategy decision, RiskGate approval, execution approval, broker submission 입력으로 사용.
- 실거래 주문 생성/취소 경로 추가.
- `UpbitLiveBroker`를 paper decision runner 또는 strategy runtime에 연결.
- `POST /v1/orders`, `DELETE /v1/order`, `submitOrder`, `cancelOrder` 신규 호출 경로 추가.
- 신규 runtime dependency 추가.
- raw provider payload, raw order detail, Authorization header, JWT, API key, secret key, query hash 원문 저장 또는 노출.
- 투자 자문 문구, 매수/매도 추천 문구, 수익 보장 표현.
- 웹 대시보드.
- 기존 `audit_events`, `risk_events`, `orders`, `pnl_snapshots` schema를 목적 없이 대체하는 리팩터링.
- 기존 M17 PnL summary, daily report, live reconcile behavior를 M18과 무관하게 바꾸는 작업.
- 기존 migration 파일 수정 또는 version gap 생성.
- 자동 commit, PR 생성, branch merge, force push.
- 관련 없는 문서 정리, 포맷 변경, 광범위한 모듈 분리.

## Architecture Direction

### Layering

권장 구조는 다음과 같다. 정확한 파일명은 구현 중 조정할 수 있지만, 새 TypeScript public entry를 만들면 public entry와 같은 이름의 디렉터리에 세부 구현을 둔다.

```text
src/application/decision-ledger.ts
src/application/decision-ledger/
  types.ts
  category.ts
  frame-builder.ts
  user-facing.ts
  why-summary.ts
  llm-summary.ts

src/infrastructure/db/decision-ledger.ts
src/infrastructure/db/decision-ledger/
  repository.ts
  row-mapper.ts
  status-provider.ts
  types.ts
```

의존 방향:

```text
domain/shared -> application/decision-ledger -> interfaces/http-control
application/decision-ledger ports -> infrastructure/db/decision-ledger
runtime -> application ports + infrastructure implementation 조립
```

`application`은 `infrastructure`를 import하지 않는다. `interfaces/http-control`은 summary provider contract만 알고 DB row나 raw payload를 직접 해석하지 않는다. `runtime` 조립부는 DB repository/provider를 주입할 수 있지만, `/status` route handler 안에서 write side effect를 수행하지 않는다.

### Data Flow

```text
PaperDecisionInputFrame
  -> strategy.evaluate()
  -> StrategyDecision
  -> order intent conversion
  -> CostModel decision
  -> RiskGate decision
  -> ExecutionEngine result
  -> PaperDecisionRunner trace
  -> DecisionLedgerFrame + DecisionEvidenceItem
  -> append-only DB rows
  -> WhySummary query
  -> /status.why safe summary
  -> optional LLM draft attachment
```

주문 후보 0건 frame은 실패나 누락이 아니다. frame 안에서 모든 strategy가 `HOLD` 또는 `BLOCK`이거나, conversion/cost/risk 단계에서 모두 차단되면 `HOLD`, `CASH_HOLD`, `DISCARD`, `COST_REJECTED`, `RISK_REJECTED` 중 실제 이유를 reason count로 보존한다.

### Side Effects

- Sub PR 01은 문서와 순수 public contract만 추가한다.
- Sub PR 02는 DB migration/repository write/read를 허용한다.
- Sub PR 03은 runner 완료 단계에서 ledger write를 호출하고 `/status` read-only provider를 연결한다.
- Sub PR 04는 LLM provider를 fake/noop 기반으로 테스트하고, 외부 provider smoke는 env guard가 있을 때만 허용한다.
- ledger write 실패는 이미 발생한 broker/order side effect를 재시도하지 않는다.
- ledger write 실패는 주문 허용 신호로 보정하지 않는다. 실패 evidence를 runner result, audit/risk evidence 또는 ledger failure summary에 남긴다.

## Dependency Direction

- 신규 dependency를 추가하지 않는다.
- Decimal 계산이 필요하면 기존 `decimal.js`와 `src/shared/index.ts` helper를 사용한다.
- runtime validation이 필요하면 기존 `zod`를 사용한다.
- DB 접근은 기존 Kysely `Database` type과 repository 패턴을 따른다.
- migration이 필요하면 `migrations/000013_decision_ledger.sql`을 추가하고, `src/infrastructure/db/schema.ts`, `tests/integration/migrations.test.ts`, DB 설계 문서를 함께 갱신한다.
- LLM은 기존 `src/application/llm-risk-assistant/**` contract를 우선 재사용한다. 새 provider dependency를 추가하지 않는다.
- 기본 `corepack pnpm test`와 `./scripts/verify`는 외부 LLM 호출, Upbit private API 호출, live order API 호출을 만들면 안 된다.

## Contracts

### Decision Frame Contract

Decision frame은 한 입력 frame과 하나의 strategy 평가 흐름을 기본 단위로 한다. 여러 order intent가 만들어질 수 있으므로 evidence item은 frame 아래에 여러 개 붙을 수 있다.

필수 의미:

- `ledgerVersion`: M18 contract version. stable literal `m18.decision_ledger.v1`만 허용하며, 호환되지 않는 contract 변경 시 새 literal로 올린다.
- `sourceRunId`: runner 또는 runtime 실행 단위 식별자. 없으면 `null`이 아니라 source unavailable reason을 trace에 남긴다.
- `sourceFrameId`: `PaperDecisionInputFrame.id`.
- `exchange`: 예: `UPBIT`.
- `market`: market별 판단이면 `KRW-BTC` 같은 code, cash/global 판단이면 `null` 허용.
- `strategyId`: strategy별 판단이면 strategy id, cash/global 판단이면 `null` 허용.
- `observedAt`: 시장/feature frame 관측 시각.
- `decisionAt`: 판단이 확정된 시각.
- `correlationId`: 주문, risk, execution evidence와 연결할 수 있는 stable id. 없으면 runner가 만든 deterministic id 또는 `null`과 `correlationUnavailableReason`을 trace에 남긴다.
- `category`: stable frame decision category. 사용자-facing 문구를 대체하지 않으며, LLM 장애 전용 `EXPLANATION_FAILED`는 frame category가 아니라 evidence/status로만 남긴다. `BUY`/`SELL`은 주문 의도/판단이며, broker 제출 성공은 `EXECUTED`로만 남긴다.
- `summaryStatus`: `RECORDED`, `PARTIAL`, `UNAVAILABLE`, `EXPLANATION_FAILED` 같은 read/query 상태.
- `reasonCounts`: hold/discard/cost/risk/execution reason count.
- `dedupeKey`: 같은 frame/source/correlation 재실행 중복 append를 차단하는 deterministic key.
- `trace`: 내부 id, fingerprint, source table, source id, correlation id 같은 추적 정보만 담는다.

### Evidence Item Contract

Evidence item은 frame 아래 append-only로 저장되는 단일 근거다.

필수 evidence kind:

- `STRATEGY_DECISION`: BUY/SELL/HOLD/BLOCK 판단과 strategy reason.
- `ORDER_INTENT`: 주문 후보 direction, quantity/notional/price summary, idempotency key trace. raw order detail은 금지.
- `DISCARD_REASON`: strategy block 또는 conversion discard reason.
- `COST_BREAKDOWN`: entry/exit fee, spread, slippage, cancel/requote penalty, required return, margin, allow/reject.
- `RISK_DECISION`: RiskGate approved/rejected, risk type, action, 한국어 설명, trace.
- `EXECUTION_RESULT`: paper execution accepted/rejected/filled result summary. broker raw payload는 금지.
- `PNL_STATUS_CONTEXT`: M17 PnL/status context를 읽을 수 있는 경우 safe summary만 연결.
- `EXPLANATION_SUMMARY`: deterministic 또는 LLM 보조 summary attachment.
- `EXPLANATION_FAILURE`: LLM failure, provider invalid output, output size 초과, order-like output 차단.

`EXPLANATION_FAILURE` evidence는 category `EXPLANATION_FAILED`와만 조합한다. 다른 evidence kind는 `EXPLANATION_FAILED` category를 가질 수 없고, `EXPLANATION_FAILURE`는 `BUY`/`SELL` 같은 주문 판단 category를 가질 수 없다.

필수 필드 의미:

- `evidenceKind`
- `category`
- `reasonCode`
- `userMessage`
- `impact`
- `action`
- `occurredAt`
- `source`
- `sourceId`
- `evidenceFingerprint`
- `payload`
- `trace`

`payload`와 `trace`에는 raw provider payload, raw order detail, secret 후보, Authorization/JWT/API key를 넣지 않는다.

### Persistence Contract

권장 schema는 frame table + evidence table 2개다. 더 단순한 단일 table로 충분하다고 판단하면 Sub PR 01 또는 02에서 결정 로그를 남기고 같은 semantic contract를 만족해야 한다.

권장 table:

```text
decision_ledger_frames
decision_ledger_evidence
```

`decision_ledger_frames` 최소 컬럼:

- `id uuid primary key default gen_random_uuid()`
- `ledger_version text not null`
- `source_run_id text null`
- `source_frame_id text not null`
- `exchange text not null`
- `market text null`
- `strategy_id text null`
- `category text not null`
- `summary_status text not null`
- `observed_at timestamptz not null`
- `decision_at timestamptz not null`
- `correlation_id text null`
- `reason_counts_json jsonb not null default '{}'::jsonb`
- `summary_json jsonb not null default '{}'::jsonb`
- `trace_json jsonb not null default '{}'::jsonb`
- `dedupe_key text not null unique`
- `created_at timestamptz not null default now()`

`decision_ledger_evidence` 최소 컬럼:

- `id uuid primary key default gen_random_uuid()`
- `frame_id uuid not null references decision_ledger_frames(id)`
- `evidence_kind text not null`
- `category text not null`
- `reason_code text null`
- `user_message text not null`
- `impact text null`
- `action text null`
- `source text not null`
- `source_id text null`
- `payload_json jsonb not null default '{}'::jsonb`
- `trace_json jsonb not null default '{}'::jsonb`
- `evidence_fingerprint text not null unique`
- `occurred_at timestamptz not null`
- `created_at timestamptz not null default now()`

Repository invariant:

- append-only insert만 수행한다.
- 같은 `dedupe_key` 또는 `evidence_fingerprint` 충돌은 중복 append 없이 기존 row를 재사용하거나 `inserted=false` 결과로 반환한다.
- 기존 row를 update해서 최신 summary처럼 덮어쓰지 않는다.
- delete는 구현하지 않는다.
- DB write 실패는 호출자에게 실패 결과로 반환하되 broker/order side effect 재시도를 유발하지 않는다.
- `audit_events`, `risk_events`, `orders`, `pnl_snapshots`와는 stable id 또는 correlation id만 연결한다.
- `ledger_version`은 `m18.decision_ledger.v1` literal로 고정한다. `EXPLANATION_FAILURE`와 `EXPLANATION_FAILED` 조합 외에는 설명 실패 category를 evidence category로 저장하지 않는다.

### Why Summary Contract

`/status` 하위 `why` summary는 read-only safe summary다.

필수 하위 summary:

- `markets`: market별 최근 판단 이유 section. 예: `KRW-BTC`, `KRW-ETH`.
- `markets.readStatus`: market section 조회 상태 (`OK`, `NOT_FOUND`, `UNAVAILABLE`).
- `markets.items`: market별 최근 판단 이유 item 목록.
- `strategies`: strategy별 최근 판단 이유 section.
- `strategies.readStatus`: strategy section 조회 상태 (`OK`, `NOT_FOUND`, `UNAVAILABLE`).
- `strategies.items`: strategy별 최근 판단 이유 item 목록.
- `cash`: 주문 후보 0건 또는 현금 보유 이유 summary section.
- `cash.readStatus`: cash section 조회 상태 (`OK`, `NOT_FOUND`, `UNAVAILABLE`).
- `cash.item`: cash hold summary. 조회 전/기록 없음이면 `null`, 주문 후보 0건이면 `holdReasons` 한국어 label/count 목록을 포함한다. 안정 reason code는 각 item의 `trace.reasonCode`에만 둔다.
- `generatedAt`: summary 생성 시각. HTTP JSON 응답과 같은 ISO 8601 string이다.
- `readStatus`: 전체 summary 조회 상태 (`OK`, `NOT_FOUND`, `UNAVAILABLE`). 개별 section 실패는 각 section `readStatus`로도 보존한다.
- `trace`: 내부 식별자, query source, correlation id만 포함.

각 summary item은 사용자-facing 정보를 먼저 가진다.

- `statusLabel`: 한국어 상태.
- `message`: 한국어 원인.
- `impact`: 한국어 영향.
- `action`: 한국어 필요 조치 또는 `null`.
- `latestDecisionAt`: 기록이 없으면 `null`, 있으면 ISO 8601 string이다.
- `category`와 `reasonCode`는 사용자-facing 최상위 item 필드가 아니라 `trace` 또는 detail 영역에 분리.

DB 조회 실패는 `/status` 전체 실패가 아니라 실패한 section의 `readStatus=UNAVAILABLE`로 낮춘다. 기록 없음과 조회 실패는 서로 다른 상태로 표현한다.

### LLM Summary Contract

LLM summary는 deterministic why summary 옆에 붙는 보조 attachment다.

- 입력은 redacted deterministic ledger evidence만 사용한다.
- output은 한국어 요약 초안과 source trace만 허용한다.
- provider timeout, invalid JSON, free-form output, output size 초과, provider 장애는 `EXPLANATION_FAILURE` evidence로만 남긴다.
- LLM output에 `BUY`, `SELL`, `INCREASE_POSITION`, 목표가, 포지션 크기, 주문 허용, 주문 취소 실행 의미가 있으면 attachment에서 제외하고 fail-closed evidence로 남긴다.
- LLM 실패는 strategy decision, RiskGate approval, Broker submission, live order permission, deterministic `/status.why` summary를 바꾸지 않는다.
- 기본 test/verify는 fake/noop provider만 사용한다.

## Edge Cases

- frame은 수신됐지만 모든 strategy가 `HOLD`: `HOLD`와 `CASH_HOLD` reason count를 남긴다.
- strategy가 `BLOCK`: `DISCARD`와 block reason을 남기고, order intent가 없다는 사실을 누락으로 보지 않는다.
- order intent conversion이 0건: conversion discard reason과 strategy decision을 함께 보존한다.
- cost rejection: `COST_REJECTED`로 저장하고 risk rejection과 구분한다.
- risk rejection: `RISK_REJECTED`로 저장하고 cost rejection과 구분한다.
- execution rejection: Cost/Risk는 통과했지만 execution/broker layer에서 거부된 결과로 저장한다.
- execution success: paper order id, idempotency key, fill summary는 trace/detail로 보존하되 raw broker payload는 저장하지 않는다.
- ledger write 실패: runner 결과에 실패 evidence를 남기고, 이미 실행된 broker side effect를 재시도하지 않는다.
- DB가 없는 local fixture run: deterministic result는 유지하고 ledger status를 `UNAVAILABLE` 또는 injected noop writer 결과로 표시한다.
- 같은 frame/source/correlation 재실행: dedupe key 또는 fingerprint로 중복 append를 차단한다.
- source run id가 없음: `unknown` 문자열로 섞지 말고 unavailable reason을 trace에 남긴다.
- 실제 0과 unknown/unavailable: count 0은 실제 0, `null` 또는 `available=false`는 조회 불가로 분리한다.
- market이 cash/global인 경우: market `null`과 category `CASH_HOLD`를 명시하고 `KRW-CASH` 같은 가짜 market을 만들지 않는다.
- PnL/status context 없음: `PNL_STATUS_CONTEXT`를 0으로 채우지 말고 unavailable reason으로 남긴다.
- LLM provider output이 너무 김: size failure evidence를 남기고 deterministic summary만 반환한다.
- LLM provider가 JSON이 아닌 자유문을 반환: invalid output evidence를 남기고 deterministic summary만 반환한다.
- LLM output에 주문처럼 보이는 field가 있음: fail-closed evidence를 남기고 attachment를 제외한다.
- `/status` provider 조회 실패: HTTP 200 안의 하위 `why.status=unavailable`로 표현하고 한국어 조치 문구를 제공한다.
- secret-like 문자열이 evidence payload에 섞임: 저장 전 redaction 또는 제외한다.

## Acceptance Criteria

- 종목별 최근 판단 이유를 `/status` 하위 why summary에서 조회할 수 있다.
- strategy별 최근 판단 이유를 `/status` 하위 why summary에서 조회할 수 있다.
- 주문 후보가 생성된 frame은 strategy decision, order intent, cost breakdown, risk decision, execution result를 연결한다.
- 주문 후보 0건 frame도 HOLD/CASH_HOLD/DISCARD reason count로 설명된다.
- cost rejection과 risk rejection은 서로 다른 판단 이유로 저장되고 조회 응답에서 구분된다.
- ledger row는 append-only이고 같은 frame/source/correlation 재실행으로 중복 evidence가 생기지 않는다.
- 사용자-facing 응답은 내부 code보다 한국어 상태, 원인, 영향, 필요 조치를 먼저 보여준다.
- 내부 id, fingerprint, reason code, correlation id는 `추적 정보` 또는 debug/detail 영역에 분리된다.
- LLM summary는 deterministic evidence를 읽는 보조 계층이며, LLM 실패가 주문 판단이나 RiskGate/Broker 결과를 바꾸지 않는다.
- LLM output에 주문 지시, 포지션 크기, 매수/매도 허용 의미가 있으면 fail-closed evidence로 남고 사용자 summary에 그대로 노출하지 않는다.
- raw access key, secret key, JWT, Authorization header, raw provider payload, raw order detail이 ledger/status/API/report artifact에 남지 않는다.
- 기본 `PAPER_NO_KEY` runtime에서 live order API 호출 0회 invariant가 유지된다.

## Acceptance Criteria Trace Matrix

| AC | 사용자 관측면 | 예상 수정 파일 | 필수 테스트 | 완료로 보지 않는 경우 |
| --- | --- | --- | --- | --- |
| 종목별 최근 판단 이유 조회 | `GET /status` 응답의 `why.markets` | `src/interfaces/http-control/**`, `src/application/decision-ledger/**`, `src/infrastructure/db/decision-ledger/**` | `tests/unit/http-control.test.ts`, `tests/unit/decision-ledger.test.ts` | provider만 export하고 `/status` shape에 연결하지 않은 경우 |
| strategy별 최근 판단 이유 조회 | `GET /status` 응답의 `why.strategies` | `src/interfaces/http-control/**`, `src/application/decision-ledger/**` | `tests/unit/http-control.test.ts`, `tests/unit/decision-ledger.test.ts` | strategy id를 trace에만 저장하고 사용자 summary가 없는 경우 |
| 주문 후보 frame evidence 연결 | ledger frame/detail query 또는 repository fixture | `src/application/paper-decision-runner/**`, `src/application/decision-ledger/**`, `src/infrastructure/db/decision-ledger/**` | `tests/unit/paper-decision-runner.test.ts`, `tests/integration/decision-ledger.test.ts` | strategy/cost/risk/execution 중 일부 evidence만 저장한 경우 |
| 주문 후보 0건 frame 설명 | `/status.why.cash`와 ledger reason count | `src/application/paper-decision-runner/**`, `src/application/decision-ledger/**` | `tests/unit/paper-decision-runner.test.ts`, `tests/unit/decision-ledger.test.ts` | order intent가 없다는 이유로 frame을 저장하지 않은 경우 |
| cost/risk rejection 구분 | `/status.why` trace category와 reason message | `src/application/decision-ledger/**`, `src/interfaces/http-control/**` | `tests/unit/decision-ledger.test.ts`, `tests/unit/http-control.test.ts` | rejection을 모두 `DISCARD` 하나로 합친 경우 |
| append-only와 dedupe | DB repository 결과와 migration constraint | `migrations/000013_decision_ledger.sql`, `src/infrastructure/db/decision-ledger/**`, `src/infrastructure/db/schema.ts` | `tests/unit/decision-ledger-persistence.test.ts`, `tests/integration/decision-ledger.test.ts`, `tests/integration/migrations.test.ts` | update/delete로 최신 row를 덮거나 재실행 때 evidence가 중복되는 경우 |
| 한국어 사용자 문구 우선 | `/status.why` item의 `statusLabel/message/impact/action` | `src/application/decision-ledger/user-facing.ts`, `src/interfaces/http-control/**` | `tests/unit/decision-ledger.test.ts`, `tests/unit/http-control.test.ts` | 내부 reason code가 첫 문구를 대체하는 경우 |
| 내부 추적 정보 분리 | `/status.why.*.trace` 또는 `추적 정보` | `src/application/decision-ledger/**`, `src/interfaces/http-control/**` | `tests/unit/http-control.test.ts` | correlation id, fingerprint를 숨기거나 첫 화면 문구로 노출하는 경우 |
| LLM 실패 격리 | deterministic why summary 유지 + failure evidence | `src/application/decision-ledger/llm-summary.ts`, `src/application/llm-risk-assistant/**` | `tests/unit/decision-ledger.test.ts`, `tests/unit/llm-risk-assistant-provider.test.ts` | provider 실패가 runner result, RiskGate, Broker 결과를 바꾸는 경우 |
| LLM order-like output 차단 | attachment 제외 + fail-closed evidence | `src/application/decision-ledger/llm-summary.ts`, `src/application/llm-risk-assistant/**` | `tests/unit/llm-risk-assistant-contract.test.ts`, `tests/unit/decision-ledger.test.ts` | BUY/SELL/position size를 사용자 summary에 그대로 노출하는 경우 |
| secret/raw payload 미노출 | ledger payload, `/status`, report artifact | `src/application/decision-ledger/**`, `src/infrastructure/db/decision-ledger/**`, `src/interfaces/http-control/**` | `tests/unit/decision-ledger.test.ts`, `tests/unit/http-control.test.ts` | raw provider payload, raw order detail, Authorization/JWT/API key가 payload/trace에 남는 경우 |
| live order API 0회 | source scan과 runtime invariant | `src/application/**`, `src/infrastructure/**`, `src/interfaces/**`, `src/runtime/**` | source scan, `corepack pnpm test` | `POST /v1/orders`, `DELETE /v1/order`, live broker submit/cancel 경로를 추가한 경우 |

## Forbidden Completion Shortcuts

- 새 provider/function/type을 만들거나 export한 것만으로 integration 완료라고 보고하지 않는다.
- 새 함수 직접 호출 테스트만으로 `/status`, runner, DB repository 같은 사용자/운영 표면 검증을 대체하지 않는다.
- ledger table만 만들고 `paper-decision-runner` 또는 `/status.why`에 연결하지 않은 상태를 완료로 보지 않는다.
- `paper-decision-runner` trace에 값이 있다는 이유만으로 durable ledger 완료라고 주장하지 않는다.
- `/status` schema에 필드만 추가하고 provider wiring이나 HTTP test가 없으면 완료로 보지 않는다.
- 기존 LLM risk assistant가 있다는 이유만으로 M18 why summary LLM boundary 완료라고 주장하지 않는다.
- fake provider 없이 실제 외부 LLM 호출에 의존하는 테스트를 기본 verify 완료 근거로 쓰지 않는다.
- cost rejection과 risk rejection을 같은 reason bucket으로 합치면 완료로 보지 않는다.
- 주문 후보 0건 frame을 ledger에 남기지 않으면 완료로 보지 않는다.
- 내부 code/reason/fingerprint가 사용자-facing 한국어 상태/원인/영향/조치를 대체하면 완료로 보지 않는다.
- handoff 문서나 필수 기준 문서를 읽을 수 없으면 추론 구현하지 말고 중단 보고한다.

## User-Facing Surface Checklist

사용자 표면이 있는 Sub PR 03-04는 아래를 모두 확인한다.

- `/status` response schema에 `why` summary가 포함된다.
- `why.markets`, `why.strategies`, `why.cash`가 모두 read-only로 동작한다.
- 하위 summary 조회 실패는 `/status` 전체 실패가 아니라 `unavailable` summary로 낮춘다.
- status label, message, impact, action은 한국어다.
- 내부 reason code, fingerprint, correlation id, order id는 `trace` 또는 `추적 정보`에 분리된다.
- raw provider payload, raw order detail, Authorization/JWT/API key는 응답에 없다.
- 실제 HTTP status provider test가 있다.
- runner에서 ledger write가 실패해도 broker/execution 재시도나 주문 허용 보정이 없다.
- LLM attachment가 없어도 deterministic why summary는 유지된다.

## Semantic Contracts

- current source와 historical source를 같은 배열/필드로 섞지 않는다. 최신 why summary와 ledger history는 별도 query/result로 구분한다.
- empty/not found와 read failure/unavailable을 같은 null 응답으로 합치지 않는다.
- 실제 count 0과 unknown/unavailable을 구분한다.
- cost rejection과 risk rejection을 같은 discard reason으로 합치지 않는다.
- strategy HOLD와 cash hold를 구분한다. HOLD는 strategy 판단이고 CASH_HOLD는 주문 후보 0건 frame의 운영 상태 설명이다.
- execution rejected와 risk rejected를 구분한다. execution rejected는 Cost/Risk 이후의 실행 경계 결과다.
- deterministic summary와 LLM draft를 구분한다. LLM draft는 deterministic summary를 덮어쓰지 않는다.
- raw provider payload, secret, Authorization header는 trace에도 원문으로 남기지 않는다.

## Verification

각 sub PR별 최소 검증은 Unit Metadata를 따른다. 전체 구현 완료 후 다음을 실행한다.

```sh
corepack pnpm typecheck
```

```sh
corepack pnpm exec vitest run tests/unit/decision-ledger.test.ts tests/unit/decision-ledger-persistence.test.ts tests/unit/paper-decision-runner.test.ts tests/unit/http-control.test.ts tests/unit/llm-risk-assistant-provider.test.ts
```

DB integration이 준비된 환경이면 다음을 실행한다.

```sh
SEEMIRAI_RUN_DB_INTEGRATION=1 corepack pnpm exec vitest run tests/integration/decision-ledger.test.ts tests/integration/migrations.test.ts
```

DB integration guard가 기본 off라면 다음 명령은 guard-skip 근거를 보고해도 된다.

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
git diff --name-only origin/main...HEAD -- src/application src/infrastructure src/interfaces src/runtime | xargs --no-run-if-empty rg -n "POST /v1/orders|DELETE /v1/order|submitOrder|cancelOrder"
```

기대 결과:

- typecheck와 targeted unit tests가 통과한다.
- DB integration이 guard-skip이면 skip 조건과 이유를 한국어로 보고한다. DB를 사용할 수 있으면 migration/repository integration도 통과해야 한다.
- `./scripts/verify docs`와 `./scripts/verify`가 통과한다.
- live order API source scan에서 M18 변경이 실거래 주문 생성/취소 경로를 추가하지 않았다는 근거가 확인된다. 기존 disabled/live broker 정의가 매칭되면 신규 호출 경로인지 diff 기준으로 설명한다.

## Final Hygiene Self-Check

구현을 마치기 전에 `.reasonix/skills/implementation-hygiene-self-check.md`가 있으면 읽고 03 구현 hygiene 자기검열을 수행한다.

현재 handoff 작성 시점에는 `.reasonix/skills/implementation-hygiene-self-check.md`와 `scripts/check-implementation-hygiene.mjs`가 없다. 구현 시점에도 없으면 새로 만들지 말고 생략 사유를 최종 보고에 적는다.

구현 시점에 script가 존재하면 아래 명령을 실행한다.

```sh
bun scripts/check-implementation-hygiene.mjs --contract docs/generated/2026-06-06-issue-159-m18-decision-ledger-reasonix-handoff.contract.json
```

hard fail이 있으면 수정한다. warning은 실제 문제인지 재검토하고, 수정하지 않으면 이유를 한국어로 보고한다. 최종 보고에는 hard fail, warning, 수정한 항목, 수정하지 않은 항목과 이유를 포함한다.

Final Hygiene Self-Check 뒤에는 acceptance criteria trace matrix를 다시 채우고, 각 AC가 어떤 테스트와 사용자 표면으로 검증됐는지 보고한다.

## Report Back

각 sub PR 구현자는 최종 보고에 아래를 포함한다.

- 완료한 Sub PR 번호와 범위.
- 변경한 주요 파일.
- 구현한 decision ledger/why summary contract.
- 사용자-facing 한국어 문구 예시.
- append-only/idempotency가 어떻게 보장되는지.
- cost rejection과 risk rejection을 어떻게 구분했는지.
- 주문 후보 0건 frame을 어떻게 설명했는지.
- LLM summary가 있는 경우 deterministic summary와 어떻게 분리했는지.
- 실행한 검증 명령과 결과.
- DB integration 또는 전체 verify를 실행하지 못했다면 정확한 이유.
- live order API 호출 경로를 추가하지 않았다는 scan 근거.
- hard fail/warning 자기검열 결과.
- 남은 리스크와 open question.

## Handoff Command

Sub PR별로 별도 Reasonix 실행에 넘기는 경우:

```sh
mkdir -p .local/transcripts
npx --yes reasonix run \
  --effort high \
  --budget 0.90 \
  --transcript .local/transcripts/issue-159-subpr-01-plan-contract.reasonix.jsonl \
  "Read docs/exec-plans/active/2026-06-06-issue-159-m18-decision-ledger-reasonix-handoff.md and implement Sub PR 01 M18 Plan & Contract only. Do not implement persistence, producer status summary, LLM boundary, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."
```

```sh
mkdir -p .local/transcripts
npx --yes reasonix run \
  --effort high \
  --budget 1.10 \
  --transcript .local/transcripts/issue-159-subpr-02-ledger-persistence.reasonix.jsonl \
  "Read docs/exec-plans/active/2026-06-06-issue-159-m18-decision-ledger-reasonix-handoff.md and implement Sub PR 02 Ledger Foundation & Persistence only. Assume Sub PR 01 is complete. Do not implement producer/status wiring, LLM boundary, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."
```

```sh
mkdir -p .local/transcripts
npx --yes reasonix run \
  --effort high \
  --budget 1.10 \
  --transcript .local/transcripts/issue-159-subpr-03-producer-status.reasonix.jsonl \
  "Read docs/exec-plans/active/2026-06-06-issue-159-m18-decision-ledger-reasonix-handoff.md and implement Sub PR 03 Producer & Status Why Summary only. Assume Sub PR 01 and Sub PR 02 are complete. Do not implement LLM boundary, Telegram inbound, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."
```

```sh
mkdir -p .local/transcripts
npx --yes reasonix run \
  --effort high \
  --budget 1.00 \
  --transcript .local/transcripts/issue-159-subpr-04-llm-closeout.reasonix.jsonl \
  "Read docs/exec-plans/active/2026-06-06-issue-159-m18-decision-ledger-reasonix-handoff.md and implement Sub PR 04 LLM Boundary, Verification & Closeout only. Assume Sub PR 01, 02, and 03 are complete. Do not implement M19 or later, Telegram inbound, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."
```

한 구현 agent가 순차 처리하는 경우:

```sh
mkdir -p .local/transcripts
npx --yes reasonix run \
  --effort high \
  --budget 3.50 \
  --transcript .local/transcripts/issue-159-m18-decision-ledger.reasonix.jsonl \
  "Read docs/exec-plans/active/2026-06-06-issue-159-m18-decision-ledger-reasonix-handoff.md and implement Sub PR 01, then 02, then 03, then 04 sequentially. Stop after each Sub PR verification and report before continuing. Do not implement M19 or later, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."
```
