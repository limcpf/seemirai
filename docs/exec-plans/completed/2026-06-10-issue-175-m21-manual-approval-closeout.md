# Issue #175 M21 수동 승인 live pilot closeout

## 목표

Issue #175 M21은 자동 주문 후보를 만들 수 있더라도 실제 Upbit live 주문 제출은 운영자가 Telegram에서 명시 승인한 proposal에만
허용하는 안전 단계다. M22 무승인 자동매매 전 마지막 guard로, 승인 없는 live 주문 0건과 `proposal -> approval -> risk decision ->
broker submission` evidence chain을 기계적으로 증명하는 것이 목표다.

- Issue: https://github.com/limcpf/seemirai/issues/175
- mother branch: `issue-175-mother`
- Sub PR 01: https://github.com/limcpf/seemirai/pull/176
- Sub PR 02: https://github.com/limcpf/seemirai/pull/177
- Sub PR 03: https://github.com/limcpf/seemirai/pull/178
- Final main PR: https://github.com/limcpf/seemirai/pull/179
- Final main PR 상태: review drain 완료 후 2026-06-10 19:08:37 KST에 `main` merge 완료, merge commit
  `99aca3f06953b6e5b7bb65db1024cc5b6e3c6996`

## 완료 범위

### Sub PR 01. Approval Contract, Config, Evidence & M20 Closeout

- M20 closeout stale 문구를 #174 main merge 완료 기준으로 보강
- `live_manual_approval` config contract와 기본 비활성 guard
- 기본 허용 market `KRW-BTC`, `KRW-ETH`, `KRW-ETC`
- 1회 주문 상한, 일일 승인 예산, proposal TTL, price deviation guard
- proposal 상태 전이와 append-only approval/reject/submission evidence contract
- proposal fingerprint와 raw Telegram/secret redaction audit projection
- M21 security/runtime/reliability/product 문서 기준 초안

### Sub PR 02. Telegram Approval Runtime & Guarded Submission

- `/approve <proposal_id>`와 `/reject <proposal_id>` parser/runtime
- M20 owner allowlist, bot mention guard, durable dedupe, audit append, reply redaction 재사용
- 처리 시각 기준 approval TTL 판단과 Telegram message 시각 safe metadata 보존
- expired/rejected/submitted/unknown proposal fail-closed
- APPROVED 중간 상태 재개와 audit projection 보강
- 제출 직전 risk gate, kill switch, reconcile freshness, budget, market allowlist, order type, price deviation 재검증
- durable daily approval budget reservation
- broker submit 성공/실패/불확실 상태와 store/audit failure 정규화
- fake broker 기반 integration test와 Codex review drain 완료

### Sub PR 03. Verification, Source Scan & Closeout

- rejected proposal 재승인 fail-closed 통합 테스트 추가
- stale fingerprint mismatch append 차단 회귀 테스트 추가
- Final PR review drain에서 최소 주문금액 미달, 음수 일일 예산 사용액 snapshot, 같은 proposal 동시 reservation 차단 회귀 테스트 추가
- M21 acceptance criteria 완료 표시
- `docs/product-specs/upbit-live-autonomous-trading.md`의 M21 구현 완료 조건과 M22 전환 gate 분리
- M21 closeout 문서와 completed plan index/context map 갱신

### Final main PR Review Drain

- PR #179 head `c260b5b5c54360a962f9efc53b459d4780f293e5`에서 Codex review finding 3건 처리
- `m21_order_notional_below_minimum`, `m21_daily_budget_usage_invalid`, `PROPOSAL_ALREADY_RESERVED` guard 보강
- 기존 thread `PRRT_kwDOScdx1c6IWf5u`, `PRRT_kwDOScdx1c6IWf5w`, `PRRT_kwDOScdx1c6IWf5x` resolve
- GitHub check `verify` pass, Codex clean signal `+1` 확인
- final main PR은 issue-subpr-runner 규칙에 따라 merge하지 않았고, 사용자가 직접 merge하도록 남김

## Acceptance Criteria Trace

| 기준 | 완료 근거 |
| --- | --- |
| M21 기본 config 비활성 | `loadRuntimeConfig` 기본값, `loadRuntimeConfig({ live_manual_approval: { enabled: true } })` 테스트 |
| 기본 허용 market | `defaultLiveManualApprovalConfig.allowed_markets`, `tests/unit/config.test.ts` |
| 주문 상한/일일 예산/TTL/price deviation 설정 | `live-manual-approval-config/schema.ts`, config unit test |
| proposal 없이 `/approve`로 live 주문 생성 금지 | unknown proposal runtime 결과 `PROPOSAL_NOT_FOUND`, fake broker submission 0회 |
| 승인되지 않은 proposal broker 전달 금지 | guard `m21_proposal_not_approved`, recheck failure integration test |
| expired/rejected/submitted proposal 재승인 차단 | expired/submitted/rejected integration test, broker submission 0회 |
| Telegram update/message/command 재전달 idempotency | duplicate polling integration test, broker submission 1회 |
| 제출 직전 재검증 | risk, kill switch, reconcile freshness, budget, market, order type, notional, Upbit KRW 최소 주문금액, 음수 daily usage, price deviation guard |
| M20 inbound readiness/reconcile freshness 필수 | `evaluateLiveManualApprovalRuntimeGuard`, `assertLiveManualApprovalRuntimeReady` |
| proposal/approval/risk/broker submission evidence | successful approval integration test evidence chain |
| 같은 proposal 동시 제출 중복 차단 | APPROVED proposal 동시 approve runtime test, reservation 선점 후 broker submission 1회 |
| approval/reject audit raw payload/secret redaction | `createLiveOrderApprovalEvidenceSnapshot`, `createLiveOrderApprovalAuditEvent` unit test |
| 기본 PAPER_NO_KEY live order API 0회 | source scan에서 M21 live submit은 approval runtime injected broker 경계로만 존재 |
| M22 autonomous loop 없음 | `LIVE_AUTONOMOUS` source scan 결과는 product spec/요구사항 문서뿐 |

## Source Scan

실행 경로:

```sh
git diff --name-only origin/main...HEAD -- src tests docs/FEATURE_REQUIREMENTS.md docs/RUNTIME_CONFIG.md docs/SECURITY.md docs/RELIABILITY.md docs/product-specs/upbit-live-autonomous-trading.md | xargs --no-run-if-empty rg -n "submitOrder\\(|POST /v1/orders|DELETE /v1/order|LIVE_AUTONOMOUS"
git diff --name-only origin/main...HEAD -- src tests docs/FEATURE_REQUIREMENTS.md docs/RUNTIME_CONFIG.md docs/SECURITY.md docs/RELIABILITY.md docs/product-specs/upbit-live-autonomous-trading.md | xargs --no-run-if-empty rg -n "/approve|/reject|approval|reject|approve"
rg -n "POST /v1/orders|DELETE /v1/order" src/runtime src/application src/infrastructure tests docs/SECURITY.md docs/RUNTIME_CONFIG.md docs/RELIABILITY.md
rg -n "LIVE_AUTONOMOUS" src tests docs/FEATURE_REQUIREMENTS.md docs/RUNTIME_CONFIG.md docs/SECURITY.md docs/RELIABILITY.md docs/product-specs/upbit-live-autonomous-trading.md
```

결과:

- `submitOrder(`: M21 변경 파일 기준 실제 runtime 매칭은 `src/runtime/live-order-approval-runtime/service.ts`의 승인된 proposal 제출
  경계 1곳이다. 테스트 매칭은 fake broker와 uncertain fake broker뿐이다.
- `POST /v1/orders`, `DELETE /v1/order`: M21 변경 파일 기준 runtime 신규 호출 없음. 매칭은 기존 live broker 문서/JSDoc, M20 closeout
  scan 기록, 보안/runtime 문서 설명이다.
- `/approve`, `/reject`: parser/runtime/test 문맥에서만 매칭된다. M20 auth/dedupe/audit/reply redaction 경계를 통과한 뒤
  `LiveOrderApprovalCommandRuntime`으로 위임된다.
- `LIVE_AUTONOMOUS`: product spec의 M22 이후 모드 설명과 source scan 요구사항만 매칭된다. M21 runtime code에는 autonomous loop가 없다.

판정: M21 변경은 승인 없는 live order submit path를 열지 않는다. live broker side effect는 수동 승인 evidence, recheck pass evidence,
budget reservation, audit projection을 통과한 `live-order-approval-runtime`의 injected `BrokerPort.submitOrder` 호출 1곳으로 제한된다.

## 검증

Sub PR 03, final PR review drain, finish-readiness-audit에서 직접 실행한 검증:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm exec vitest run tests/integration/live-order-approval-runtime.test.ts tests/unit/live-order-approval-contract.test.ts tests/unit/config.test.ts tests/unit/telegram-inbound.test.ts
./scripts/verify docs
git diff --check
./scripts/verify
```

결과:

- `corepack pnpm install --frozen-lockfile`: lockfile 변경 없이 의존성 설치
- `corepack pnpm typecheck`: 통과
- 관련 vitest: 4 files, 47 tests 통과
- `./scripts/verify docs`: 문서 64개, 매니페스트 81개, 링크 215개 확인
- `git diff --check`: 통과
- `./scripts/verify`: 80 passed / 11 skipped test files, 1309 passed / 113 skipped tests
- `finish-readiness-audit` 재검증 `./scripts/verify`: 80 passed / 11 skipped test files, 1309 passed / 113 skipped tests
- PR #179 GitHub check `verify`: head `c260b5b5c54360a962f9efc53b459d4780f293e5`, pass, 1m23s
- PR #179 Codex clean signal: reaction `+1`, 2026-06-10T03:54:47Z
- PR #179 review thread: 3건 모두 resolved, unresolved thread 0건

Sub PR 02 review drain 최종 검증:

- `corepack pnpm typecheck`: 통과
- `corepack pnpm exec vitest run tests/integration/live-order-approval-runtime.test.ts`: 18 tests 통과
- Telegram inbound 관련 vitest: 3 files, 18 tests 통과
- Upbit live broker/kill switch 관련 vitest: 2 files, 17 tests 통과
- `./scripts/verify docs`: 문서 63개, 매니페스트 80개, 링크 214개 확인
- `./scripts/verify`: 80 passed / 11 skipped test files, 1305 passed / 113 skipped tests
- GitHub check `verify`: PR #177 head `8b2d5581bea89c4f35eded3391f682f61353350c`에서 pass
- Codex clean signal: PR #177 reaction `+1`, 2026-06-10T03:14:41Z

## 결정 로그

- M21 기본 profile은 계속 비활성이며 `PAPER_NO_KEY` runtime을 실거래 profile로 승격하지 않는다.
- `/approve`와 `/reject`는 M20 Telegram inbound의 owner allowlist, bot mention guard, durable dedupe, audit, reply redaction 경계를
  그대로 재사용한다.
- proposal TTL은 Telegram message 시각이 아니라 approval 처리 시각으로 판단한다.
- `APPROVED` proposal은 broker 제출 전 crash/restart 재개 대상이지만, approval audit projection을 먼저 보강하지 못하면 제출하지 않는다.
- broker submit 예외는 거래소 도달 여부가 불확실하므로 `brokerSubmitted=true`와 수동 reconcile 필요 상태로 보존한다.
- submission/rejection/expiration audit projection 실패는 성공 응답으로 숨기지 않고 별도 보류/실패 상태로 운영자에게 드러낸다.
- 제출 직전 금액이 Upbit KRW 최소 주문금액보다 작거나 일일 예산 사용액 snapshot이 음수이면 broker 호출 전에 차단한다.
- 같은 proposal reservation이 이미 있으면 다른 제출 경로가 broker 직전 gate를 선점한 것으로 보고, 두 번째 요청은 proposal을 실패로
  닫지 않고 추가 broker 호출만 막는다.
- M22 전환에는 최소 1주 운영 중 reconcile mismatch, duplicate order, untracked fill 0건 확인이 필요하다.

## 남은 리스크와 후속 작업

- 실제 live pilot 운영 budget, API key allowlist, reconcile 관측 결과는 운영 실행 시점의 별도 evidence로 남겨야 한다.
- Telegram inbound polling worker와 M21 approval runtime을 production deployment lifecycle에 붙이는 작업은 운영 wiring에서 확인한다.
- Final main PR #179는 issue-subpr-runner workflow에 따라 review drain과 finish-readiness-audit까지 완료한 뒤 2026-06-10
  19:08:37 KST에 `main`으로 merge됐다.
