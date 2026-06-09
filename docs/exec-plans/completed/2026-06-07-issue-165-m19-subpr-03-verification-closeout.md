# Issue #165 M19 Sub PR 03 Verification, Guarded Pilot & Closeout

## 목표

M19 Sub PR 03은 Sub PR 01(exit contracts & rules)과 Sub PR 02(evidence & runtime integration)에서 구현한 exit engine을 검증 가능한 완료 상태로 닫는다. M14/M15 pilot guard를 M19 exit pilot으로 확장하고, 신규 guarded buy smoke를 별도 운영자 승인 없이 차단하는 경계를 완성했다.

## 실제 변경 범위

### M19 Exit Pilot Guard

- [`src/runtime/pilot-config/types.ts`](../../../src/runtime/pilot-config/types.ts): M19 exit pilot guard 타입 상수(`M19_EXIT_PILOT_POSITION_SOURCES`, `M19_EXIT_PILOT_SMOKE_RESULTS`), `M19ExitPilotGuardConfig`, `DisabledM19ExitPilotGuardConfig`, `M19ExitPilotGuardConfigResult` 타입 추가
- [`src/runtime/pilot-config/validation.ts`](../../../src/runtime/pilot-config/validation.ts): `loadM19ExitPilotGuardConfigFromEnv` 함수 추가 — `SEEMIRAI_RUN_M19_EXIT_PILOT`, `SEEMIRAI_M19_EXIT_PILOT_POSITION_SOURCE`, `SEEMIRAI_M19_EXIT_PILOT_POSITION_EVIDENCE_ID`, `SEEMIRAI_M19_EXIT_PILOT_MAX_KRW`, `SEEMIRAI_M19_EXIT_PILOT_OPERATOR_EVIDENCE_ID`, `SEEMIRAI_RUN_M19_GUARDED_BUY_SMOKE`, `SEEMIRAI_M19_GUARDED_BUY_APPROVAL_EVIDENCE_ID` env 해석 및 검증
- [`src/runtime/pilot-config/summary.ts`](../../../src/runtime/pilot-config/summary.ts): `M19ExitPilotGuardSafeSummary` 타입과 `createM19ExitPilotGuardSafeSummary` 함수 추가 — operator, position, approval evidence id를 boolean으로만 노출
- [`src/runtime/pilot-config.ts`](../../../src/runtime/pilot-config.ts): 신규 M19 타입/함수 export

### M19 Guarded Buy Smoke

- [`src/runtime/pilot-order-smoke/guard.ts`](../../../src/runtime/pilot-order-smoke/guard.ts): `validateM19GuardedBuySmokeGuard` 함수와 `M19GuardedBuySmokeValidation` 타입 추가
  - M19 guard 비활성 → buy/ask 모두 SKIPPED
  - 매도(side=ask) → PASSED (기존 포지션 축소 경계)
  - buy + guarded buy off → SKIPPED
  - buy + guarded buy on + approval 없음 → FAILED_CLOSED
  - buy + guarded buy on + approval 있음 → PASSED
- [`src/runtime/pilot-order-smoke.ts`](../../../src/runtime/pilot-order-smoke.ts): 신규 M19 guard 함수/타입 export
- [`src/runtime/index.ts`](../../../src/runtime/index.ts): 신규 M19 타입/함수 re-export

### 검증 (Tests)

- [`tests/unit/m19-exit-pilot-guard.test.ts`](../../../tests/unit/m19-exit-pilot-guard.test.ts): M19 guard 테스트
  - M19 guard 비활성/활성 config 해석
  - 잘못된 position source 예외 검증
  - `EXISTING_SMALL_POSITION` evidence 누락 예외 검증
  - 소액 한도 범위 검증 (5000 미만, 50000 초과)
  - guarded buy smoke skip/fail-closed/pass 분기 검증
  - safe summary credential redaction 검증
  - 한국어 violation 문구 검증

### 문서 갱신

- [`docs/RUNTIME_CONFIG.md`](../../RUNTIME_CONFIG.md): M19 Exit Pilot guard 섹션 추가 (guard env, guarded buy smoke guard, invariant, safe summary)
- [`docs/product-specs/upbit-live-autonomous-trading.md`](../../product-specs/upbit-live-autonomous-trading.md): M19 Sub PR 03 완료 상태로 갱신, M19 마일스톤에 ✅ 완료 조건 반영
- [`docs/SECURITY.md`](../../SECURITY.md): M19 exit pilot 보안 기준 추가 (PAPER_NO_KEY 0회, guarded buy approval evidence, secret redaction)
- [`docs/RELIABILITY.md`](../../RELIABILITY.md): M19 exit pilot 신뢰성 기준 추가 (safe skip, cancel confirmation polling, manual review 수렴)
- 이 closeout 문서: 완료 evidence 기록

## Guard 조건 요약

### M19 Exit Pilot Guard

| env | 의미 |
| --- | --- |
| `SEEMIRAI_RUN_M19_EXIT_PILOT=1` | M19 exit pilot guard 활성화 필수 |
| `SEEMIRAI_M19_EXIT_PILOT_POSITION_SOURCE=EXISTING_SMALL_POSITION\|PAPER_FIXTURE` | 검증할 포지션 기준 |
| `SEEMIRAI_M19_EXIT_PILOT_POSITION_EVIDENCE_ID=<redacted>` | `EXISTING_SMALL_POSITION` 선택 시 필요한 M16 reconcile 또는 운영자 position evidence |
| `SEEMIRAI_M19_EXIT_PILOT_MAX_KRW=5000~50000` | 소액 한도 |
| `SEEMIRAI_M19_EXIT_PILOT_OPERATOR_EVIDENCE_ID=<redacted>` | 운영자 확인 증거 |

### Guarded Buy Smoke 차단 조건

| 조건 | 결과 | API 호출 |
| --- | --- | --- |
| M19 guard 미활성 | SKIPPED | 없음 |
| M19 guard 미활성 + guarded buy on | **FAILED_CLOSED** | 없음 |
| guarded buy off (`SEEMIRAI_RUN_M19_GUARDED_BUY_SMOKE` 미설정 또는 `!=1`) | SKIPPED | 없음 |
| guarded buy on + approval evidence 없음 | **FAILED_CLOSED** | 없음 |
| guarded buy on + approval evidence 있음 + side=bid | PASSED | 가능 |
| side=ask + M19 guard 활성 | PASSED | 가능 |

### 운영 모드별 live API 호출

| 모드 | live order API 호출 | 근거 |
| --- | --- | --- |
| `PAPER_NO_KEY` | **0회** | `DisabledUpbitLiveBroker.submitOrder()`가 항상 예외 던짐 (`src/infrastructure/upbit/disabled-live-broker.ts` [line 44-45]). `OrderSmokeGuardedBroker`는 PAPER_NO_KEY에서 조립되지 않음 (`src/runtime/upbit-live-broker-runtime/service.ts` [guard.ts에서 M19 guard로 확인]). |
| `PILOT_ORDER_SMOKE` | 가드 충족 시 1회 생성/취소 | M14/M15 pilot guard + 운영자 price/volume/identifier 필수 |
| M19 exit pilot (ask) | 가드 충족 시 허용 | 기존 포지션은 M16 reconcile/position evidence 필수, paper fixture 우선, 소액 한도 |
| M19 guarded buy | approval evidence 있을 때만 허용 | 별도 운영자 승인 필수, 없으면 FAILED_CLOSED |

## Source Scan 결과

### PAPER_NO_KEY live order API 0회 확인

**대상 경로**: `src/runtime/`, `src/infrastructure/`, `src/application/`, `src/interfaces/`

**검색 패턴**: `POST /v1/orders`, `DELETE /v1/order`, `UpbitLiveBroker(`, `createUpbitPrivateClient`, `submitOrder(`, `cancelOrder(`

**결과**:

- `src/runtime/pilot-order-smoke/guard.ts`:54 — **주석만 존재**: M14 guard 위반 시 `POST /v1/orders` 또는 `DELETE /v1/order` 호출 금지 안내 (코드 아님)
- `src/infrastructure/upbit/disabled-live-broker.ts`:44 — PAPER_NO_KEY 기본 broker: `submitOrder` 호출 시 항상 예외 반환
- `src/runtime/upbit-live-broker-runtime/service.ts`:272 — `OrderSmokeGuardedBroker.submitOrder()`: guarded factory를 통해서만 생성, PAPER_NO_KEY에서는 인스턴스 생성 불가
- `src/infrastructure/upbit/live-broker/service.ts`:58 — 실제 `UpbitLiveBroker.submitOrder()`: `createGuardedUpbitLiveBrokerRuntime()`를 통해서만 인스턴스 생성

**판정**: 기본 `PAPER_NO_KEY` runtime은 live order API 호출 **0회**를 유지한다. 모든 live order API 경로는 명시 env guard를 통과한 factory에서만 열리며, M19 guard도 같은 불변식을 깨지 않는다.

### Hard Stop Open Position 자동 청산 금지 회귀

기존 `src/runtime/execution-runtime.ts`의 `executeHardStopPendingPaperOrderCancels`는 `autoLiquidateOpenPositions=false`를 유지하며, M19 변경은 이 경계를 건드리지 않았다. `src/infrastructure/upbit/disabled-live-broker.ts`의 `submitOrder`가 항상 예외를 던져 우회 경로도 없다.

## Codex Review Findings 수정 (2026-06-09)

6개 Codex review finding을 수정했다.

### F1 (P1): `loadM19ExitPilotGuardConfigFromEnv` throw → FAILED_CLOSED 이관

**변경**: `src/runtime/pilot-config/validation.ts`에서 `SEEMIRAI_M19_GUARDED_BUY_APPROVAL_EVIDENCE_ID` 누락 시 violation → throw 제거. `guardedBuySmokeEnabled=true, guardedBuyApprovalEvidenceId=undefined`인 valid config를 반환하고, FAILED_CLOSED 판단은 `validateM19GuardedBuySmokeGuard`가 담당한다.

### F2 (P1): `validateM19GuardedBuySmokeGuard` type 연결

**변경**: `src/runtime/pilot-order-smoke/guard.ts`에서 파라미터 타입을 `M19ExitPilotGuardConfig | undefined` → `M19ExitPilotGuardConfigResult`로 변경. loader 결과를 그대로 받아 disabled → SKIPPED, approval 누락 → FAILED_CLOSED, 승인 → PASSED가 자연스럽게 연결된다.

### F3 (P1): M19 guard를 integration smoke 경로에 연결

**변경**: `tests/integration/upbit-order-smoke.test.ts`, `tests/integration/upbit-live-broker-smoke.test.ts`의 real smoke test body에 M19 guard 호출 추가. plan 생성 직후 `loadM19ExitPilotGuardConfigFromEnv` → `validateM19GuardedBuySmokeGuard("bid")` 호출, FAILED_CLOSED 시 artifact에 evidence 기록 후 throw. M19 env 미설정 시 기존 동작 유지 (SKIPPED).

### F4 (P2): M19 max KRW 상한 연결

**변경**: M19 guard PASSED + enabled 시 `plan.notionalKrw`가 `SEEMIRAI_M19_EXIT_PILOT_MAX_KRW` 이하인지 추가 검증. 초과 시 API 호출 전 `UnsafePilotOrderSmokeRequestError` 발생.

### F5 (P2): 문서 stale 문구 수정

**변경**: completed closeout 문서의 중복 "Guarded buy smoke 실제 실행 미검증" 항목 제거, `./scripts/verify 실행 불가` claim 제거, guard skip evidence 구문 수정. `./scripts/verify docs` 통과 확인.

### F6 (P3): safe summary 사용자-facing 메시지 한국어화

**변경**: `src/runtime/pilot-config/summary.ts`의 `createM19ExitPilotGuardSafeSummary`에서 `positionSource` enum (`PAPER_FIXTURE`, `EXISTING_SMALL_POSITION`)을 한국어 라벨 ("종이매매 장부", "기존 소액 포지션")로 변환. `message`에서 `PAPER_NO_KEY` 등 내부 코드 제거, `trace`에만 raw enum 보존.

## 운영 리스크 보강 (2026-06-09 Codex)

사용자가 남은 운영 리스크로 지적한 두 항목 중 코드 guard로 해결 가능한 항목을 추가로 닫았다.

### R1: Guarded buy smoke 실제 실행

초기 Codex 세션의 secret-safe env 점검 결과, Upbit credential, private/order smoke guard, M19 exit pilot guard, guarded buy approval evidence env가 모두 미설정이었다. 따라서 당시에는 실제 Upbit guarded buy smoke 1회 실행을 수행하지 않았다. 이후 운영자가 별도 세션에서 env를 export한 뒤 실제 guarded live broker smoke를 실행해 성공 증적을 제공했다.

운영자 제공 secret-safe 콘솔 증적:

```sh
pnpm exec vitest run tests/integration/upbit-live-broker-smoke.test.ts
# 결과: 1 file passed, 4 tests passed
# Upbit live broker real smoke integration > guarded UpbitLiveBroker로 단일 post_only 지정가 주문을 생성, 조회, 취소한다: passed
# Start at: 2026-06-09 13:39:29 KST
# Duration: 3.58s
```

이 증적은 access key, secret key, JWT, Authorization header, raw provider payload, 계정 원문을 포함하지 않는다. 실제 smoke는 단일 `post_only` 지정가 주문을 생성, 조회, 취소하는 경로가 완료됐음을 보여주며, 체결 내역 발생을 완료 조건으로 보지 않는다.

추가 보강:

- `SEEMIRAI_RUN_M19_GUARDED_BUY_SMOKE=1`만 켜지고 `SEEMIRAI_RUN_M19_EXIT_PILOT=1`이 없으면 일반 order smoke로 낮추지 않고 API 호출 전 fail-closed 한다.
- M19 guard가 활성화된 bid smoke는 `sideEffectPossible=false`인 `SKIPPED` 결과도 일반 order smoke로 낮추지 않고 API 호출 전 차단한다.
- 실제 order/live-broker smoke는 Upbit cancel 직후 상태 반영 지연을 흡수하기 위해 같은 UUID/identifier만 짧게 재조회한다.
  그래도 terminal cancel이 확인되지 않으면 성공으로 올리지 않고 수동 점검으로 남긴다.
- 기존 negative/contract test에 이 오설정 회귀를 추가했다.

### R2: `EXISTING_SMALL_POSITION` source

기존에는 `EXISTING_SMALL_POSITION` enum 선택 자체만 guard가 허용했고 실제 포지션 확인은 M16 reconcile과 운영자 수동 확인에 의존했다. 이제 `EXISTING_SMALL_POSITION`을 선택하려면 `SEEMIRAI_M19_EXIT_PILOT_POSITION_EVIDENCE_ID`가 필수이며, 누락 시 config load 단계에서 API 호출 전 fail-closed 한다.

추가 보강:

- `M19ExitPilotGuardConfig.positionEvidenceId` optional field 추가
- `createM19ExitPilotGuardSafeSummary.positionEvidenceConfigured` boolean 추가
- evidence id 원문은 safe summary에 노출하지 않고 boolean과 trace reason만 남김
- missing evidence negative test 추가

### R3: 보안/신뢰성 기준 문서 반영

finish readiness audit에서 Sub PR 03 handoff가 요구한 `docs/SECURITY.md`, `docs/RELIABILITY.md` M19 기준 반영이 누락된 것을 확인했다. 다음 기준을 추가해 문서 DnD를 닫았다.

- `docs/SECURITY.md`: M19 exit pilot은 `PILOT_ORDER_SMOKE` 위의 추가 guard로만 열고, guarded buy approval evidence 없이는 API 호출 전 fail-closed 한다.
- `docs/SECURITY.md`: operator/position/approval evidence id는 credential이나 raw snapshot이 아니며 safe summary에서는 boolean 또는 redacted trace로만 노출한다.
- `docs/RELIABILITY.md`: 실제 smoke 미실행은 pass로 둔갑시키지 않고 skip/fail-closed 사유로 기록한다.
- `docs/RELIABILITY.md`: Upbit cancel 직후 상태 반영 지연은 같은 UUID/identifier polling으로만 흡수하고, terminal cancel 미확인은 manual review로 수렴한다.

## 실행한 검증 (최종)

### typecheck

```sh
pnpm typecheck
# 결과: 통과 (exit code 0)
```

### unit tests

```sh
pnpm exec vitest run tests/unit/
# 결과: 65 files, 1167 tests passed, 1 skipped
```

### integration tests

```sh
pnpm exec vitest run tests/integration/
# 결과: 3 files passed, 11 skipped (12 passed, 112 skipped)
```

### scripts/verify

```sh
./scripts/verify
# 결과: 문서 구조 62개 문서/79 매니페스트/213 링크 통과, hook 검증 통과, GitHub 검증 통과, typecheck 통과, 전체 test 75 files passed/11 skipped, 1261 tests passed/113 skipped
```

### source scan

```sh
rg -n "POST /v1/orders|DELETE /v1/order|createLimitOrder\(|submitOrder\(|cancelOrder\(" src/runtime src/infrastructure src/application src/interfaces tests/integration
# 결과: 모든 live order API 경로는 guard 뒤에 있음. unguarded 경로 없음.
```

### M19 guard negative tests

```sh
pnpm exec vitest run tests/unit/m19-exit-pilot-guard.test.ts --reporter=verbose
# 결과: 22 passed
# - guarded buy smoke approval 누락 → loader throw 없이 valid config 반환 (F1)
# - disabled → SKIPPED (F2)
# - guarded buy on + approval 없음 → FAILED_CLOSED (F1/F2)
# - guarded buy on + approval 있음 → PASSED
# - guarded buy marker만 켜진 오설정 → FAILED_CLOSED
# - EXISTING_SMALL_POSITION evidence 누락 → FAILED_CLOSED
# - safe summary 한국어 라벨 변환 (F6)
```

### 실제 guarded buy smoke

**실행 완료**: 운영자가 env를 export한 별도 세션에서 `tests/integration/upbit-live-broker-smoke.test.ts` real smoke를 실행했고, 4개 테스트가 모두 통과했다. 실제 guarded live broker smoke는 단일 `post_only` 지정가 주문 생성, 조회, 취소 경로를 완료했다.

## 남은 운영 리스크

- 없음. M19 guard contract, negative path, `EXISTING_SMALL_POSITION` evidence guard, source scan, hard stop 자동 청산 금지, 실제 guarded live broker smoke 실행 증적을 확인했다.

## Closeout 문서 경로

이 문서는 [`docs/exec-plans/completed/2026-06-07-issue-165-m19-subpr-03-verification-closeout.md`](./2026-06-07-issue-165-m19-subpr-03-verification-closeout.md)에 완료 기록으로 보존한다.
