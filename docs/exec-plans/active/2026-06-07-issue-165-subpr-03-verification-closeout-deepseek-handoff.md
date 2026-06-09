# Issue #165 Sub PR 03 Verification, Guarded Pilot & Closeout DeepSeek Implementation Handoff

## Goal

M19 Sub PR 03은 Sub PR 01-02에서 구현한 exit engine을 검증 가능한 완료 상태로 닫는다. 구현자는 guarded live pilot smoke guard, existing small position 또는 paper fixture 우선 정책, guarded buy smoke 별도 승인 차단, live order API 0회 source scan, 문서 closeout, 전체 verify 결과를 남겨야 한다. 이 단위는 새 exit 기능을 크게 추가하지 않고 검증과 운영 경계를 완성한다.

## Split Decision

Issue #165는 3개 sub PR로 분할한다. 이 handoff는 마지막 **Sub PR 03**이다.

verification과 closeout을 별도 단위로 둔 이유는 guarded live pilot과 문서 closeout이 구현 후 실제 evidence를 요구하기 때문이다. Sub PR 02와 합치면 runtime integration diff와 smoke/documentation diff가 커져 리뷰가 불편해지고, pilot guard 누락을 발견하기 어렵다.

## Unit Metadata

- `Goal`: M19 guarded pilot guard와 최종 검증/문서 closeout을 완료한다.
- `Owns`: `src/runtime/pilot-order-smoke/**`, `src/runtime/upbit-live-broker-runtime/**` 중 M19 guard에 필요한 최소 변경, `tests/integration/upbit-order-smoke.test.ts`, `tests/integration/upbit-live-broker-smoke.test.ts`, 신규 M19 smoke/source-scan tests, `docs/product-specs/upbit-live-autonomous-trading.md`, `docs/RUNTIME_CONFIG.md`, `docs/RELIABILITY.md`, `docs/SECURITY.md`, 필요 시 `docs/FEATURE_REQUIREMENTS.md`, `docs/exec-plans/active/**`, `docs/exec-plans/completed/**`, `docs/generated/context-map.json`.
- `Excludes`: 새로운 exit rule 추가, runtime architecture 재작성, Telegram inbound, M21 approval workflow, M22 autonomous live trading, unguarded live order API 호출, 자동 commit, PR 생성, merge.
- `Dependencies`: Sub PR 01과 Sub PR 02 완료. exit rule, runtime/evidence integration, paper verification이 선행되어야 한다.
- `Parallel`: 불가. 최종 검증과 closeout 단위다.
- `Verification`: `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify`, targeted/gated smoke source scan.
- `Handoff command`: `mkdir -p .local/transcripts && npx --yes reasonix run --effort high --budget 1.00 --transcript .local/transcripts/issue-165-subpr-03-verification-closeout.reasonix.jsonl "Read docs/exec-plans/active/2026-06-07-issue-165-subpr-03-verification-closeout-deepseek-handoff.md and implement Sub PR 03 Verification, Guarded Pilot & Closeout only. Assume Sub PR 01 and Sub PR 02 are complete. Do not implement M20 or later, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."`

## Mandatory Implementation Rules

The implementer must follow these rules throughout the task.

### 한국어 출력 규칙

- 주석 및 결과물은 모두 한국어로 표시한다.
- 사용자-facing CLI 메시지, 에러 메시지, 구현 요약, report back은 한국어로 작성한다.
- 코드 식별자, package script 이름, 외부 API 필드명처럼 관례적으로 영어가 필요한 항목은 영어를 유지할 수 있다.

### 1. Think Before Coding

- State assumptions explicitly.
- If live pilot evidence cannot be produced safely, do not improvise. Leave guarded skip/fail-closed evidence.
- If operator approval evidence is missing, stop live order side effects before API call.

### 2. Simplicity First

- Verification helpers should be small and deterministic.
- Do not add new operational modes beyond M19 guard needs.
- Do not add dependencies.

### 3. Surgical Changes

- Keep final docs focused on M19.
- Do not rewrite prior M15-M18 closeout documents.
- Do not move active documents to completed until the sub PR implementation work is actually complete.

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
- `docs/product-specs/upbit-v0-2-pilot-private-api.md`
- `docs/exec-plans/active/2026-06-07-issue-165-m19-subpr-orchestration.md`
- `docs/exec-plans/active/2026-06-07-issue-165-subpr-01-contracts-rules-deepseek-handoff.md`
- `docs/exec-plans/active/2026-06-07-issue-165-subpr-02-evidence-runtime-deepseek-handoff.md`
- `docs/exec-plans/completed/2026-06-01-issue-124-m14-v0-2-pilot.md`
- `docs/exec-plans/completed/2026-06-02-issue-135-m15-upbit-live-broker.md`
- `docs/exec-plans/completed/2026-06-02-issue-143-m16-live-reconcile.md`
- `docs/exec-plans/completed/2026-06-04-issue-154-m17-pnl-position-accounting.md`
- `docs/exec-plans/completed/2026-06-06-issue-159-m18-decision-ledger-closeout.md`
- `src/runtime/pilot-config.ts`
- `src/runtime/pilot-order-smoke.ts`
- `src/runtime/pilot-order-smoke/**`
- `src/runtime/upbit-live-broker-runtime.ts`
- `src/runtime/upbit-live-broker-runtime/**`
- `tests/integration/upbit-order-smoke.test.ts`
- `tests/integration/upbit-live-broker-smoke.test.ts`
- `tests/helpers/upbit-smoke-artifacts.ts`

우선순위가 충돌하면 다음 순서를 따른다.

1. 이 handoff 문서
2. Sub PR 01-02 완료 결과
3. Issue #165 본문
4. `AGENTS.md`
5. `docs/SECURITY.md`
6. `docs/RUNTIME_CONFIG.md`
7. 기존 code/test contract

## Current State

- v0.2 pilot과 M15 live broker smoke는 explicit env guard와 소액 지정가 주문 생성/취소 smoke를 갖는다.
- `PAPER_NO_KEY` 기본 runtime은 live order API 호출 0회를 유지해야 한다.
- M16 read-only reconcile은 `자산조회`, `주문조회` 권한만 요구하고 주문 side effect를 만들지 않는다.
- M19는 기존 보유 소액 포지션 또는 paper fixture를 우선해야 한다.
- guarded buy smoke로 신규 진입 포지션을 만드는 경로는 별도 운영자 승인과 별도 evidence 없이는 실행되면 안 된다.
- 현재 저장소의 smoke artifact는 secret redaction을 요구한다.

## Scope

허용 범위는 아래로 제한한다.

- M19 live pilot guard 문서와 runtime guard를 확정한다.
- guarded live pilot은 기존 보유 소액 포지션 또는 paper fixture를 우선 사용한다.
- 신규 guarded buy smoke 진입은 별도 env guard, 운영자 승인 evidence, 소액 한도, redacted artifact 조건 없이는 skip 또는 fail-closed 한다.
- 실제 smoke를 실행하지 못하는 기본 검증에서는 safe skip evidence를 남긴다.
- `PAPER_NO_KEY` 기본 runtime live order API 호출 0회 source scan을 수행하고 결과를 closeout에 기록한다.
- `hard stop` open position 자동 청산 금지 회귀를 확인한다.
- M19 완료 기준을 `docs/product-specs/upbit-live-autonomous-trading.md`, `docs/RUNTIME_CONFIG.md`, `docs/RELIABILITY.md`, `docs/SECURITY.md`, 필요 시 `docs/FEATURE_REQUIREMENTS.md`에 반영한다.
- 최종 closeout 문서를 `docs/exec-plans/completed/`에 작성한다.
- active README와 completed README, `docs/generated/context-map.json`을 현재 문서 상태에 맞게 갱신한다.
- 전체 검증 명령과 결과를 closeout에 기록한다.

## Non-goals

아래는 구현하면 안 된다.

- M20 Telegram inbound command.
- M21 수동 승인 주문 플로우.
- M22 운영자 승인 없는 자동 실거래.
- live autonomous small budget 운영 시작.
- 신규 strategy 또는 exit rule 추가.
- Upbit 출금, 입출금 자동화, 선물, 레버리지, 타인 계정.
- unguarded `POST /v1/orders` 또는 `DELETE /v1/order` 호출.
- API key, JWT, Authorization header, raw provider payload를 문서, artifact, status, PR body에 남기기.
- 신규 dependency 추가.
- 자동 commit, PR 생성, merge, force push.

## Architecture Direction

M19 pilot guard는 기존 M14/M15 pilot guard를 확장하되 기본 runtime을 승격하지 않는다.

```text
PAPER_NO_KEY
  -> paper exit fixture and source scan only

M19_EXIT_PILOT
  -> explicit env guard
  -> existing small position or paper fixture first
  -> operator evidence id required
  -> redacted artifact only
  -> no unapproved guarded buy smoke
```

권장 env guard 이름은 구현 시 기존 naming과 맞춘다. 예:

```text
SEEMIRAI_RUN_M19_EXIT_PILOT=1
SEEMIRAI_M19_EXIT_PILOT_POSITION_SOURCE=EXISTING_SMALL_POSITION|PAPER_FIXTURE
SEEMIRAI_M19_EXIT_PILOT_MAX_KRW=...
SEEMIRAI_M19_EXIT_PILOT_OPERATOR_EVIDENCE_ID=...
SEEMIRAI_RUN_M19_GUARDED_BUY_SMOKE=1
SEEMIRAI_M19_GUARDED_BUY_APPROVAL_EVIDENCE_ID=...
```

정확한 이름은 기존 `pilot-order-smoke` guard style과 일치시킨다.

## Dependency Direction

- smoke guard는 runtime layer에 둔다.
- live broker implementation은 guard가 통과한 owner-operated smoke에서만 생성한다.
- artifact helper는 redaction 검사를 통과한 safe summary만 저장한다.
- 문서 closeout은 implementation evidence를 요약하고 secret 원문을 포함하지 않는다.

## Contracts

필수 contract:

- 기본 `PAPER_NO_KEY` 검증은 private/live order API를 호출하지 않는다.
- M19 exit pilot은 existing small position 또는 paper fixture를 우선한다.
- guarded buy smoke는 별도 approval evidence 없이는 API 호출 전에 fail-closed 한다.
- smoke artifact는 access key, secret key, JWT, Authorization header, raw provider payload를 포함하지 않는다.
- closeout에는 실행한 명령, pass/skip/fail, skip 이유, source scan 결과가 있어야 한다.

## Edge Cases

- 운영자 approval evidence id가 없으면 guarded buy smoke는 skip이 아니라 fail-closed evidence를 남긴다.
- existing small position을 확인할 수 없으면 paper fixture path로만 검증한다.
- live pilot env가 켜졌지만 order smoke price/volume/identifier가 없으면 API 호출 전 중단한다.
- source scan에서 live order API 호출 후보가 발견되면 closeout하지 말고 수정 또는 blocker 보고한다.
- artifact redaction 검사 실패 시 artifact를 커밋하지 않는다.
- DB integration/gated live smoke가 guard-skip되면 skip 조건을 PR 본문과 closeout에 남긴다.

## Acceptance Criteria

- `PAPER_NO_KEY` 기본 runtime의 live order API 호출 0회가 유지된다.
- M19 live pilot은 명시 env guard, 소액 한도, 운영자 입력, redacted artifact 없이는 실행되지 않는다.
- M19 live pilot은 기존 보유 소액 포지션 또는 paper fixture를 우선 사용한다.
- guarded buy smoke 신규 진입은 별도 운영자 승인과 별도 evidence 없이는 실행되지 않는다.
- `/status.why` 또는 decision ledger에서 매도/보유/축소 판단 이유를 한국어로 확인할 수 있다.
- hard stop은 여전히 open position 자동 청산을 만들지 않는다.
- `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify`가 통과하거나 guard skip 이유가 기록된다.
- M19 closeout 실행 계획 문서가 작성되고 active/completed 인덱스와 context map이 맞다.

## Acceptance Criteria Trace Matrix

| AC | 사용자 관측면 | 예상 수정 파일 | 필수 테스트 | 완료로 보지 않는 경우 |
| --- | --- | --- | --- | --- |
| live order API 0회 | source scan/verify evidence | runtime/source scan closeout | source scan command | smoke skip만 있고 source scan 없음 |
| M19 pilot guard | env 없이는 API 호출 전 중단 | `src/runtime/pilot-order-smoke/**` | guarded smoke tests | env 일부만 검사하고 주문 API 호출 가능 |
| existing position/paper fixture 우선 | closeout evidence | runtime smoke helper/docs | smoke guard test | 신규 buy smoke를 기본 경로로 사용 |
| guarded buy 별도 승인 | approval evidence id 없으면 fail-closed | pilot guard module | guarded buy negative test | approval 없이 price/volume으로 주문 생성 |
| why/ledger 확인 | 한국어 매도/보유/축소 이유 | decision ledger/status 관련 tests | `http-control`/ledger targeted test | 내부 reason code만 노출 |
| closeout 문서 | completed plan과 context map | docs exec plans | `./scripts/verify docs` | active README/context-map 미갱신 |

## Forbidden Completion Shortcuts

- smoke guard 문서만 쓰고 테스트 없이 완료라고 보고하지 않는다.
- live pilot을 실행하지 않았는데 실행 성공으로 기록하지 않는다.
- guard skip을 pass로 둔갑시키지 않는다.
- raw Upbit response나 secret-like 값을 artifact/문서에 넣지 않는다.
- final closeout 없이 `./scripts/verify` 통과만으로 M19 완료라고 하지 않는다.
- 구현 후 active 문서를 completed로 옮기면서 context map을 갱신하지 않는 상태로 끝내지 않는다.

## User-Facing Surface Checklist

- `/status.why` 또는 decision ledger summary의 첫 화면은 한국어 상태/원인/영향/필요 조치를 제공한다.
- smoke/CLI 출력은 guard 충족 여부, skip/fail-closed 이유, 필요한 운영자 조치를 한국어로 설명한다.
- 내부 id, evidence id, correlation id는 `추적 정보` 또는 trace로 분리한다.
- secret, raw provider payload, Authorization header는 표시하지 않는다.

## Semantic Contracts

- smoke skip, fail-closed, success를 구분한다.
- existing small position, paper fixture, guarded buy smoke source를 구분한다.
- actual 0 live order calls와 unknown source scan result를 구분한다.
- redacted artifact와 raw provider payload를 구분한다.
- operator approval evidence id와 API credential을 섞지 않는다.

## Verification

필수 명령:

```sh
corepack pnpm typecheck
corepack pnpm test
./scripts/verify
```

필수 source scan:

```sh
git diff --name-only origin/main...HEAD -- src/application src/infrastructure src/interfaces src/runtime | xargs --no-run-if-empty rg -n "POST /v1/orders|DELETE /v1/order|UpbitLiveBroker\\(|createUpbitPrivateClient|submitOrder\\(|cancelOrder\\("
```

targeted smoke/regression 후보:

```sh
corepack pnpm exec vitest run tests/unit/execution-runtime.test.ts tests/unit/http-control.test.ts tests/unit/upbit-smoke-artifacts.test.ts
corepack pnpm exec vitest run tests/integration/upbit-order-smoke.test.ts tests/integration/upbit-live-broker-smoke.test.ts
```

gated live smoke는 필요한 env와 operator evidence가 없으면 실행하지 말고 guard skip/fail-closed 근거를 보고한다.

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
- guarded live pilot guard 조건
- guarded buy smoke 차단 조건
- source scan 결과
- 실행한 검증 명령과 결과
- guard skip/fail-closed evidence
- closeout 문서 경로
- 남은 운영 리스크

## Handoff Command

```sh
mkdir -p .local/transcripts && npx --yes reasonix run --effort high --budget 1.00 --transcript .local/transcripts/issue-165-subpr-03-verification-closeout.reasonix.jsonl "Read docs/exec-plans/active/2026-06-07-issue-165-subpr-03-verification-closeout-deepseek-handoff.md and implement Sub PR 03 Verification, Guarded Pilot & Closeout only. Assume Sub PR 01 and Sub PR 02 are complete. Do not implement M20 or later, automatic commit, PR creation, merge, or unrelated changes. Report back in Korean."
```
