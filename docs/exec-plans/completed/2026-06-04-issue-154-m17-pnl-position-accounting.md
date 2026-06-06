# Issue #154 M17 PnL/포지션 회계 Closeout

## Closeout Status

- Issue: [#154](https://github.com/limcpf/seemirai/issues/154) `[Feature] M17 PnL/포지션 회계`
- Mother branch: `issue-154-mother`
- 상태: Unit 01-03 구현 PR을 mother branch에 병합했고, main 대상 최종 PR 생성과 `$pr-review-drain`을 남겨 두었다.
- Sub PR:
  - [#155](https://github.com/limcpf/seemirai/pull/155) Unit 01 Foundation
  - [#156](https://github.com/limcpf/seemirai/pull/156) Unit 02 Persistence & Reconcile Source
  - [#157](https://github.com/limcpf/seemirai/pull/157) Unit 03 Status, Report & Closeout
- Final PR: 이 closeout 문서 커밋 후 `main` 대상으로 생성한다.

## 실제 변경 범위

- `src/application/pnl-accounting.ts`와 하위 모듈로 PnL/position accounting contract, 계산기, source priority, status/formatter/closeout helper를 추가했다.
- `src/infrastructure/db/pnl-accounting.ts`와 하위 repository/provider로 `pnl_snapshots`, `positions`, M16 reconcile snapshot source 연결을 구현했다.
- `/status` safe summary에 PnL/포지션 회계 상태를 연결하고, 내부 reason code보다 한국어 상태와 조치 문구가 먼저 보이도록 했다.
- PnL accounting unit/integration tests와 status regression tests를 추가했다.
- `docs/RUNTIME_CONFIG.md`에 M17 PnL/status 회계 기준을 반영했다.

## 완료 판단 기준

- 동일 fixture PnL 계산 deterministic, realized/unrealized PnL 분리, 평균단가/현금/보유 평가액/노출 비중 계산 기준을 테스트로 고정한다.
- `pnl_snapshots`가 있는 scope는 snapshot을 우선하고, 없는 scope만 `positions` fallback을 사용하는 source priority를 유지한다.
- 결측 평균단가, 평가가, 비용 source는 `0`으로 보정하지 않고 `계산 불가`와 원인을 사용자 표면에 노출한다.
- secret, raw provider payload, Authorization header, JWT, access/secret key는 status/report/audit payload에 노출하지 않는다.
- live order submit/cancel 경로를 추가하지 않는다.

## 검증 결과

실행 시각: 2026-06-06 00:47 KST

- `corepack pnpm typecheck`: 통과.
- `corepack pnpm exec vitest run tests/unit/pnl-accounting.test.ts tests/unit/paper-pnl-summary.test.ts tests/unit/daily-report.test.ts tests/unit/http-control.test.ts tests/unit/live-reconcile-runtime.test.ts`: 5 files, 176 tests 통과.
- `corepack pnpm exec vitest run tests/integration/daily-report.test.ts tests/integration/migrations.test.ts tests/integration/pnl-accounting.test.ts`: 3 files, 12 tests guard-skip. 세 파일 모두 `SEEMIRAI_RUN_DB_INTEGRATION=1`일 때만 DB integration을 실행한다.
- `./scripts/verify docs`: 문서 53개, 매니페스트 60개, 링크 181개 검증 통과.
- `./scripts/verify`: 문서/hook/GitHub 검증, typecheck, 전체 vitest 통과. 전체 vitest는 70 files, 987 tests 통과, 10 files, 92 tests guard-skip.
- live order API 회귀 scan: main 대비 `src/application`, `src/infrastructure`, `src/interfaces`, `src/runtime` 변경 파일에서 `POST /v1/orders`, `DELETE /v1/order`, `submitOrder`, `cancelOrder` 매칭 없음.

재현 명령:

```sh
corepack pnpm typecheck
corepack pnpm exec vitest run tests/unit/pnl-accounting.test.ts tests/unit/paper-pnl-summary.test.ts tests/unit/daily-report.test.ts tests/unit/http-control.test.ts tests/unit/live-reconcile-runtime.test.ts
corepack pnpm exec vitest run tests/integration/daily-report.test.ts tests/integration/migrations.test.ts tests/integration/pnl-accounting.test.ts
./scripts/verify docs
./scripts/verify
git diff --name-only origin/main...HEAD -- src/application src/infrastructure src/interfaces src/runtime | xargs --no-run-if-empty rg -n "POST /v1/orders|DELETE /v1/order|submitOrder|cancelOrder"
```

## 남은 리스크

- main 대상 최종 PR의 GitHub checks와 Codex clean signal은 이 문서 커밋 후 `$pr-review-drain`에서 확인한다.
- DB integration은 로컬 DB 가용성에 영향을 받는다. guard skip 또는 실행 불가가 발생하면 PR 본문과 review drain 보고서에 이유를 남긴다.

## 원본 Handoff 기준

## Goal

M17은 M16 live read-only reconcile 결과와 기존 paper/daily report 경계를 연결해, 운영자가 `/status`와 daily report에서 실현 손익, 미실현 손익, 현금, 보유 자산 평가액, 평균단가, 노출 비중, 비용 분해, 결측 원인을 신뢰할 수 있게 만드는 PnL/포지션 회계 기반을 구현한다.

## Split Decision

이 작업은 3개 구현 단위로 분할한다.

단일 handoff로 묶기에는 domain 계산, DB/reconcile source 연결, 사용자 표면 통합이 각각 다른 실패 모드와 검증 책임을 가진다. 반대로 issue 본문의 5개 예상 sub PR을 그대로 쪼개면 foundation, calculator, persistence가 같은 runtime 흐름을 공유해 handoff 비용이 커진다. 따라서 다음 3개 단위가 적정 분할이다.

1. **Unit 01 Foundation**: PnL/position accounting contract와 순수 계산기.
2. **Unit 02 Persistence & Reconcile Source**: `positions`, `pnl_snapshots`, M16 reconcile snapshot source 연결과 repository.
3. **Unit 03 Status, Report & Closeout**: `/status`, daily report, 문서와 최종 검증.

Unit 01은 Unit 02/03의 입력 contract를 고정하므로 반드시 선행한다. Unit 02와 Unit 03은 파일 소유권 일부가 다르지만 Unit 03이 Unit 02의 provider/output shape에 의존하므로 순차 진행을 기본으로 한다. 별도 agent 병렬 작업은 권장하지 않는다.

## Unit Metadata

### Unit 01 Foundation

- `Goal`: deterministic PnL/position accounting 입력/출력 contract와 순수 계산기를 만든다.
- `Owns`: `src/application/pnl-accounting.ts`, `src/application/pnl-accounting/**`, `src/application/index.ts`, `tests/unit/pnl-accounting.test.ts`, 필요 시 `tests/fixtures/m17/**`.
- `Excludes`: DB repository, migration, `/status`, daily report formatter, Telegram inbound, live broker 연결, 자동 주문 또는 자동 매도.
- `Dependencies`: 현재 branch `issue-154-mother`, 이 handoff, 기존 `src/application/paper-pnl-summary/**` 동작 보존.
- `Parallel`: 불가. Unit 02/03이 이 contract에 의존한다.
- `Verification`: `corepack pnpm exec vitest run tests/unit/pnl-accounting.test.ts tests/unit/paper-pnl-summary.test.ts`와 `corepack pnpm typecheck`가 통과해야 한다.
- `Handoff command`: `mkdir -p .local/transcripts && npx --yes reasonix run --effort high --budget 0.80 --transcript .local/transcripts/issue-154-unit-01-foundation.reasonix.jsonl "Read docs/exec-plans/completed/2026-06-04-issue-154-m17-pnl-position-accounting.md and implement Unit 01 Foundation only. Do not implement Unit 02, Unit 03, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."`

### Unit 02 Persistence & Reconcile Source

- `Goal`: Unit 01 accounting output을 DB와 M16 reconcile source에 연결하고 `pnl_snapshots` 우선, scope별 `positions` fallback 규칙을 persistence 경계에서 검증한다.
- `Owns`: `src/infrastructure/db/pnl-accounting.ts`, `src/infrastructure/db/pnl-accounting/**`, `src/infrastructure/db/index.ts`, Unit 01에서 만든 `src/application/pnl-accounting/**`의 provider/service 확장, `tests/unit/pnl-accounting*.test.ts`, `tests/integration/daily-report.test.ts`, 필요 시 `tests/integration/migrations.test.ts`.
- `Excludes`: `/status` payload 변경, daily report 문구 변경, 상시 PnL worker/scheduler, Telegram inbound command, live order submit/cancel, 불필요한 schema migration.
- `Dependencies`: Unit 01 완료. `pnl_snapshots` 기존 table과 `payload_json`으로 요구사항을 표현할 수 있으면 migration을 만들지 않는다.
- `Parallel`: 기본 불가. Unit 03은 이 단위의 provider/output shape가 확정된 뒤 진행한다.
- `Verification`: `corepack pnpm exec vitest run tests/unit/pnl-accounting.test.ts tests/integration/daily-report.test.ts tests/integration/migrations.test.ts`가 통과하거나 DB guard-skip 근거를 보고해야 한다.
- `Handoff command`: `mkdir -p .local/transcripts && npx --yes reasonix run --effort high --budget 1.00 --transcript .local/transcripts/issue-154-unit-02-persistence.reasonix.jsonl "Read docs/exec-plans/completed/2026-06-04-issue-154-m17-pnl-position-accounting.md and implement Unit 02 Persistence & Reconcile Source only. Assume Unit 01 is complete. Do not implement Unit 03, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."`

### Unit 03 Status, Report & Closeout

- `Goal`: PnL/position accounting summary를 `/status`와 daily report에 한국어 사용자 문구로 노출하고 M17 문서와 검증 evidence를 마무리한다.
- `Owns`: `src/interfaces/http-control/**`, `src/application/daily-report/**`, `src/runtime/**`의 status 조립부, `docs/RUNTIME_CONFIG.md`, `docs/product-specs/upbit-live-autonomous-trading.md`, 필요 시 `docs/design-docs/2026-05-15-m1-database-schema.md`, 관련 tests.
- `Excludes`: Telegram inbound `/pnl`/`/positions`, 자동매도/exit engine, live autonomous trading, 신규 worker scheduling, 투자 판단 문구, secret/raw provider payload 노출.
- `Dependencies`: Unit 01과 Unit 02 완료. Unit 02가 생성한 accounting provider/output shape를 사용한다.
- `Parallel`: 불가. 사용자 표면은 Unit 02 source contract에 의존한다.
- `Verification`: `corepack pnpm exec vitest run tests/unit/http-control.test.ts tests/unit/daily-report.test.ts tests/unit/pnl-accounting.test.ts`, `corepack pnpm typecheck`, `./scripts/verify docs`, 최종 `./scripts/verify`가 통과해야 한다.
- `Handoff command`: `mkdir -p .local/transcripts && npx --yes reasonix run --effort high --budget 1.00 --transcript .local/transcripts/issue-154-unit-03-status-report.reasonix.jsonl "Read docs/exec-plans/completed/2026-06-04-issue-154-m17-pnl-position-accounting.md and implement Unit 03 Status, Report & Closeout only. Assume Unit 01 and Unit 02 are complete. Do not implement Telegram inbound, exit engine, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."`

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
- `docs/PRD.md`
- `docs/FEATURE_REQUIREMENTS.md`
- `docs/DEVELOPMENT.md`
- `docs/RUNTIME_CONFIG.md`
- `docs/product-specs/upbit-live-autonomous-trading.md`
- `docs/exec-plans/completed/2026-06-02-issue-143-m16-live-reconcile.md`
- `docs/design-docs/2026-05-15-m1-database-schema.md`
- `docs/design-docs/2026-05-20-typescript-module-structure.md`
- `src/application/paper-pnl-summary/**`
- `src/application/daily-report/**`
- `src/interfaces/http-control/**`
- `src/infrastructure/db/daily-report/repository.ts`
- `src/infrastructure/db/live-reconcile/**`
- `src/runtime/live-reconcile-runtime/**`

우선순위가 충돌하면 다음 순서를 따른다.

1. 이 handoff 문서
2. `AGENTS.md`
3. `ARCHITECTURE.md`
4. `docs/FEATURE_REQUIREMENTS.md`
5. `docs/product-specs/upbit-live-autonomous-trading.md`
6. 기존 코드 contract와 테스트

## Current State

- Issue #154의 목표는 M17 PnL/포지션 회계다.
- M16은 실계좌 read-only reconcile을 완료했고, 평균단가/PnL은 M17 범위로 남겼다.
- 기존 `src/application/paper-pnl-summary/**`는 paper run 단위 KRW 손익 summary 계산기다. live/accounting source priority와 결측 원인 contract를 직접 표현하지 않으므로 M17 전용 application module을 새로 둔다.
- DB에는 이미 `positions`와 `pnl_snapshots`가 있다. `pnl_snapshots.payload_json`은 계산 source, 결측 원인, 비용 분해 같은 M17 보조 contract를 담을 수 있다.
- `daily-report`는 이미 `pnl_snapshots` 우선, scope별 `positions` fallback 로직 일부를 갖고 있다. 이 invariant를 깨지 않는다.
- `/status`에는 M16 reconcile safe summary가 있고, 내부 식별자는 `trace`로 분리하는 패턴이 있다.
- 현재 저장소에는 `.reasonix/skills/implementation-hygiene-self-check.md`와 `scripts/check-implementation-hygiene.mjs`가 없다. 구현 시점에 생겨 있으면 Final Hygiene Self-Check 절차를 따른다.

## Scope

허용 범위는 아래로 제한한다.

- PnL/position accounting application module 추가.
- realized PnL과 unrealized PnL 분리 계산.
- 평균단가, 현금, 보유 자산 평가액, 총 평가자산, market/strategy scope별 노출 비중 계산.
- fee, spread, slippage, cancel/requote penalty 분해. 관측 source가 없으면 `0`으로 보정하지 않고 계산 불가 원인을 남긴다.
- `pnl_snapshots`가 있는 scope는 snapshot을 우선하고, 없는 scope만 `positions` fallback을 사용한다.
- M16 `live_reconcile_position_snapshots`와 `positions`를 PnL source 후보로 연결한다. `MANUAL_REVIEW_REQUIRED` snapshot은 계산 가능 값으로 승격하지 않는다.
- `/status`에 secret-safe PnL/position summary를 추가하거나 기존 safe summary를 확장한다.
- daily report의 PnL/포지션 문구를 한국어 우선으로 보강한다. `unavailable` 같은 원문 code가 첫 화면 설명을 대체하지 않게 한다.
- 관련 단위/통합 테스트를 추가한다.
- M17 runtime/status/report 기준이 바뀌면 `docs/RUNTIME_CONFIG.md`와 `docs/product-specs/upbit-live-autonomous-trading.md`를 갱신한다.
- schema를 바꿀 필요가 명확한 경우에만 새 migration을 추가한다. 이 경우 `src/infrastructure/db/schema.ts`, DB 설계 문서, migration integration test를 함께 갱신한다.

## Non-goals

아래는 구현하면 안 된다.

- 자동 전략 live 주문 제출.
- `UpbitLiveBroker`를 strategy/execution runtime에 연결.
- `POST /v1/orders`, `DELETE /v1/order` 호출 경로 추가.
- Telegram inbound command 구현. `/pnl`, `/positions`, `/why`, `/risk`는 M20 이후 범위다.
- 자동 매도, 손절, 익절, trailing stop, exit engine 구현.
- 별도 상시 PnL worker, scheduler, retry loop 완성. M17은 reconcile/status/daily report 경계에서 호출 가능한 service까지만 허용한다.
- M18 판단 이유 ledger, M19 exit engine, M20 Telegram 양방향 운영, M21 수동 승인 live pilot, M22 완전 자동매매를 앞질러 구현.
- 신규 runtime dependency 추가.
- `config/paper.json`을 live profile로 승격.
- secret, API key, JWT, Authorization header, raw provider payload를 status/report/audit에 노출.
- 결측 평균단가, 평가가, source를 `0`으로 대체.
- non-KRW fee를 임의 환산.
- 투자 조언, 수익 보장, 매수/매도 추천 문구.
- DB schema를 단지 "깔끔하게" 만들기 위한 migration. 현재 `payload_json`으로 표현 가능한 metadata는 기존 table을 사용한다.
- 자동 commit, PR 생성, branch merge, force push.
- 관련 없는 문서 정리, 대규모 리팩터링, 기존 paper PnL 동작 변경.

## Architecture Direction

### Layering

권장 구조는 다음과 같다.

```text
src/application/pnl-accounting.ts
src/application/pnl-accounting/
  types.ts
  calculator.ts
  source-priority.ts
  formatter.ts
src/infrastructure/db/pnl-accounting.ts
src/infrastructure/db/pnl-accounting/
  repository.ts
  row-mapper.ts
```

정확한 파일명은 구현 중 조정할 수 있지만, 새 TypeScript public entry를 만들면 같은 이름의 디렉터리에 세부 구현을 두는 저장소 규칙을 따른다.

### Data Flow

```text
fills + orders reason_json + paper/live execution evidence
  + positions
  + pnl_snapshots
  + live_reconcile_position_snapshots
  + mark price source
  -> PnL accounting calculator
  -> PnL/position accounting summary
  -> pnl_snapshots payload_json, /status, daily report
```

`pnl_snapshots`는 시계열 evidence다. 같은 strategy/market scope에 snapshot이 있으면 그 scope의 `positions` fallback을 합산하지 않는다. `market=null` snapshot은 strategy aggregate이므로 같은 strategy의 market positions fallback을 모두 덮는다.

`positions`는 현재 snapshot이다. 과거 손익 복원 source로는 약하므로 fallback source임을 output에 명시한다.

`live_reconcile_position_snapshots`는 M16 복구 evidence다. `RECOVERABLE`이고 평균단가 근거가 있을 때만 계산 source 후보가 될 수 있다. `MANUAL_REVIEW_REQUIRED` 또는 평균단가 결측은 계산 불가 원인으로만 남긴다.

### Missing Value Policy

결측값은 다음 형태로 표현한다.

- 사용자 표면: `계산 불가`, `평가가 없음`, `평균단가 근거 없음`, `수동 검토 필요`처럼 행동 가능한 한국어.
- 내부 추적: stable reason code와 source는 `trace`, `payload_json`, `metadata` 하위에 둔다.
- 숫자 필드: 실제 0과 계산 불가를 구분한다. `null` 또는 `{ available: false }` 형태를 사용하고 임의 0 보정은 금지한다.

### Cost Breakdown

수수료는 fill에서 확정된 값을 우선한다. spread/slippage/cancel-requote는 paper simulation 또는 order reason/cost snapshot에서 관측 가능한 값만 집계한다. source가 없으면 해당 metric을 계산 불가로 표시한다.

### Side Effects

Unit 01은 순수 계산만 수행한다. Unit 02만 DB read/write를 허용한다. Unit 03은 HTTP status payload와 report formatting을 조립하고, Telegram provider 호출은 기존 daily report 전송 경계 외에 추가하지 않는다.

## Dependency Direction

- 신규 dependency를 추가하지 않는다.
- Decimal 계산은 기존 `decimal.js`와 `src/shared/decimal.ts` helper를 사용한다.
- DB 접근은 기존 Kysely `Database` type과 repository 패턴을 따른다.
- `application`은 `infrastructure`를 import하지 않는다.
- `interfaces/http-control`은 safe summary provider만 알고 DB row나 raw provider payload를 직접 해석하지 않는다.
- migration이 필요하면 현재 다음 version은 `000013_*`이어야 한다. migration을 추가하면 `tests/integration/migrations.test.ts`, `src/infrastructure/db/schema.ts`, `docs/design-docs/2026-05-15-m1-database-schema.md`를 함께 갱신한다.

## Contracts

### Accounting Scope

PnL scope는 최소한 다음을 표현해야 한다.

- `strategyId`: strategy 단위 구분.
- `market`: market별 scope면 market code, strategy aggregate면 `null`.
- `capturedAt`: ISO timestamp.
- `source`: `pnl_snapshots`, `positions`, `live_reconcile_position_snapshots`, `fills`, 또는 조합 source.
- `status`: `CALCULATED`, `PARTIAL`, `UNAVAILABLE`, `MANUAL_REVIEW_REQUIRED` 같은 stable code. 사용자 표면에는 한국어 label을 먼저 보여준다.

### Input Contract

계산기는 다음 입력을 받을 수 있어야 한다.

- fill facts: order id, strategy id, market, side, price, quantity, fee, fee currency, liquidity, filled at.
- position facts: strategy id, market, quantity, average entry price, realized PnL, unrealized PnL, updated at, source.
- mark price facts: market, KRW 평가가, observed at, source.
- cash facts: KRW available/locked/total, source, observed at.
- cost quality facts: spread cost bps, slippage bps, cancel/requote penalty bps, source.
- existing PnL snapshot facts: strategy id, market nullable, equity, realized/unrealized PnL, drawdown bps, captured at, payload metadata.
- reconcile facts: recovery status, average entry source, manual review evidence.

### Output Contract

결과는 최소한 다음 정보를 포함한다.

- realized PnL KRW.
- unrealized PnL KRW.
- total PnL KRW.
- cash KRW.
- position market value KRW.
- equity KRW.
- average entry price by market/strategy scope.
- quantity by market/strategy scope.
- exposure bps of equity.
- fee totals by currency.
- spread/slippage/cancel-requote metric과 source.
- missing reasons: 사용자-facing 한국어 message, stable reason code, affected scope.
- trace: run id, correlation id, source table, source timestamp 정도만 허용. secret/raw payload는 금지.

### Persistence Contract

`pnl_snapshots` write가 필요하면 다음 원칙을 따른다.

- `strategy_id`, `market`, `captured_at`, `equity`, `realized_pnl`, `unrealized_pnl`, `drawdown_bps`는 기존 컬럼을 사용한다.
- `payload_json`에는 `contract_version`, `source`, `cash_krw`, `position_market_value_krw`, `total_pnl_krw`, `fee_totals`, `execution_quality`, `missing_reasons`, `trace`를 저장할 수 있다.
- 같은 업무 흐름의 재시도에서 같은 snapshot을 반복 insert하지 않도록 repository 단계에서 idempotency strategy를 명시한다. DB unique index가 없으면 captured timestamp와 source fingerprint를 deterministic하게 만들고, 중복 방지 한계를 report back에 적는다.
- raw Upbit payload, Authorization header, access key, secret key, JWT는 저장하지 않는다.

### `/status` Contract

`/status`는 PnL/position 상태를 secret-safe summary로 노출해야 한다.

- 첫 화면 문구는 한국어 상태/원인/영향/필요 조치다.
- 내부 code, source id, reason code는 `trace` 하위에 둔다.
- DB 조회 실패는 `/status` 전체 실패가 아니라 해당 하위 영역의 `unavailable` 또는 `warning`으로 낮춘다.
- 계산 불가인 scope가 있으면 `0 KRW`가 아니라 `계산 불가`와 원인을 표시한다.

### Daily Report Contract

daily report는 기존 집계 흐름을 유지하되 다음을 보장한다.

- `pnl_snapshots` source를 우선한다.
- snapshot이 없는 scope만 `positions` fallback을 쓴다.
- aggregate snapshot과 per-market snapshot을 이중 합산하지 않는다.
- 결측 metric은 `계산 불가`로 표시하고, `unavailable` raw code가 사용자 문구를 대체하지 않는다.
- source는 한국어 설명 뒤에 괄호 또는 trace로 남긴다.

## Edge Cases

- fill이 하나도 없는 경우: 거래/수수료 수는 0이지만 손익 source가 없으면 계산 불가와 실제 0을 구분한다.
- BUY 이후 일부 SELL: 평균단가와 realized PnL이 deterministic해야 한다.
- 보유 수량보다 큰 SELL: short position을 만들지 말고 invariant error 또는 계산 불가로 fail-fast 한다.
- open position에 mark price가 없음: unrealized/total/equity/exposure를 계산 불가로 둔다.
- 평균단가가 없는 reconcile position: `MANUAL_REVIEW_REQUIRED` 또는 계산 불가로 둔다.
- non-KRW fee: 통화별 수수료를 분리하고 KRW 비중 계산은 계산 불가로 둔다.
- `pnl_snapshots`와 `positions`가 같은 scope에 동시에 있음: snapshot 우선, fallback 중복 합산 금지.
- strategy aggregate snapshot과 market snapshot이 동시에 있음: aggregate snapshot 우선, market snapshot 합산 제외.
- 같은 timestamp의 snapshot이 여럿 있음: deterministic tie-break를 사용하고 이유를 주석/테스트에 남긴다.
- DB 연결 없음 또는 query 실패: `/status`는 해당 하위 영역만 unavailable로 표시한다.
- M16 reconcile mismatch: 신규 주문 허용 신호로 쓰지 않고 manual review/fail-closed 상태를 보존한다.
- source payload에 secret 후보가 있음: summary/payload 저장 전 redaction 또는 제외한다.

## Acceptance Criteria

- 동일 fixture에서 PnL 계산 결과가 deterministic 하다.
- realized PnL과 unrealized PnL이 분리된다.
- 평균단가, 현금, 보유 자산 평가액, 노출 비중이 strategy/market scope별로 계산된다.
- 수수료, spread, slippage, cancel/requote penalty가 가능한 source에서 분해된다.
- 결측 source는 `0`이 아니라 `계산 불가`와 원인으로 표시된다.
- live read-only reconcile 결과와 PnL snapshot source가 연결된다.
- `pnl_snapshots`가 있는 scope는 snapshot을 우선하고, 없는 scope만 `positions` fallback을 사용한다.
- `/status`와 daily report formatter가 내부 code보다 한국어 상태, 원인, 영향, 필요 조치를 먼저 보여준다.
- secret, raw provider payload, Authorization header가 status/report/audit에 노출되지 않는다.
- 기본 `PAPER_NO_KEY` runtime에서 live order API 호출 0회 invariant가 유지된다.
- 관련 단위/통합 테스트와 `corepack pnpm typecheck`가 통과한다.
- 문서 변경 후 `./scripts/verify docs`가 통과한다.
- 최종적으로 `./scripts/verify`가 통과하거나 실행 불가 사유를 한국어로 보고한다.

## Verification

각 단위별 최소 검증은 Unit Metadata를 따른다. 전체 구현 완료 후 다음을 실행한다.

```sh
corepack pnpm typecheck
```

```sh
corepack pnpm exec vitest run tests/unit/pnl-accounting.test.ts tests/unit/paper-pnl-summary.test.ts tests/unit/daily-report.test.ts tests/unit/http-control.test.ts tests/unit/live-reconcile-runtime.test.ts
```

```sh
corepack pnpm exec vitest run tests/integration/daily-report.test.ts tests/integration/migrations.test.ts
```

```sh
./scripts/verify docs
```

```sh
./scripts/verify
```

Live order API 회귀 scan도 수행한다.

```sh
git diff --name-only -- src/application src/infrastructure src/interfaces src/runtime | xargs --no-run-if-empty rg -n "POST /v1/orders|DELETE /v1/order|submitOrder|cancelOrder"
```

기대 결과:

- typecheck와 관련 unit test가 통과한다.
- DB integration guard가 꺼져 skip되면 skip 근거를 보고한다. DB를 사용할 수 있으면 migration/daily-report integration도 통과해야 한다.
- 문서 구조 검증이 통과한다.
- 변경 파일 기준 `submitOrder`/`cancelOrder` scan에서 M17 신규 accounting/status/report 경로가 live 주문 side effect를 만들지 않는다는 근거가 확인된다.

## Final Hygiene Self-Check

구현을 마치기 전에 `.reasonix/skills/implementation-hygiene-self-check.md`가 있으면 읽고 03 구현 hygiene 자기검열을 수행한다.

현재 handoff 작성 시점에는 `.reasonix/skills/implementation-hygiene-self-check.md`와 `scripts/check-implementation-hygiene.mjs`가 없다. 구현 시점에도 없으면 새로 만들지 말고 생략 사유를 최종 보고에 적는다.

구현 시점에 script가 존재하면 아래 명령을 실행한다.

```sh
bun scripts/check-implementation-hygiene.mjs --contract docs/generated/2026-06-04-issue-154-m17-pnl-position-accounting.contract.json
```

hard fail이 있으면 수정한다. warning은 실제 문제인지 재검토하고, 수정하지 않으면 이유를 한국어로 보고한다. 최종 보고에는 hard fail, warning, 수정한 항목, 수정하지 않은 항목과 이유를 포함한다.

## Report Back

구현자는 최종 보고에 아래를 포함한다.

- 완료한 Unit 번호와 범위.
- 변경한 주요 파일.
- PnL source priority가 어떻게 구현됐는지.
- 계산 불가 원인과 사용자-facing 한국어 문구 예시.
- 실행한 검증 명령과 결과.
- DB integration 또는 전체 verify를 실행하지 못했다면 정확한 이유.
- live order API 호출 경로를 추가하지 않았다는 scan 근거.
- 남은 리스크와 open question.

## Handoff Command

Unit별로 별도 Reasonix 실행에 넘기는 경우:

```sh
mkdir -p .local/transcripts
npx --yes reasonix run \
  --effort high \
  --budget 0.80 \
  --transcript .local/transcripts/issue-154-unit-01-foundation.reasonix.jsonl \
  "Read docs/exec-plans/completed/2026-06-04-issue-154-m17-pnl-position-accounting.md and implement Unit 01 Foundation only. Do not implement Unit 02, Unit 03, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."
```

```sh
mkdir -p .local/transcripts
npx --yes reasonix run \
  --effort high \
  --budget 1.00 \
  --transcript .local/transcripts/issue-154-unit-02-persistence.reasonix.jsonl \
  "Read docs/exec-plans/completed/2026-06-04-issue-154-m17-pnl-position-accounting.md and implement Unit 02 Persistence & Reconcile Source only. Assume Unit 01 is complete. Do not implement Unit 03, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."
```

```sh
mkdir -p .local/transcripts
npx --yes reasonix run \
  --effort high \
  --budget 1.00 \
  --transcript .local/transcripts/issue-154-unit-03-status-report.reasonix.jsonl \
  "Read docs/exec-plans/completed/2026-06-04-issue-154-m17-pnl-position-accounting.md and implement Unit 03 Status, Report & Closeout only. Assume Unit 01 and Unit 02 are complete. Do not implement Telegram inbound, exit engine, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."
```

한 구현 agent가 순차 처리하는 경우:

```sh
mkdir -p .local/transcripts
npx --yes reasonix run \
  --effort high \
  --budget 2.50 \
  --transcript .local/transcripts/issue-154-m17-pnl-position-accounting.reasonix.jsonl \
  "Read docs/exec-plans/completed/2026-06-04-issue-154-m17-pnl-position-accounting.md and implement Unit 01, then Unit 02, then Unit 03 sequentially. Do not implement M18 or later, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."
```
