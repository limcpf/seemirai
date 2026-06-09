# Issue #170 M20 Telegram inbound closeout

## 목표

Issue #170 M20은 운영자가 Telegram에서 현재 상태와 판단 이유를 조회하고, 제한된 kill switch 계열 control 명령을 안전하게 실행할
수 있게 하는 작업이다. M20은 inbound command 경계를 여는 범위이며, live 주문 승인과 live broker 제출은 M21 이후로 남긴다.

- Issue: https://github.com/limcpf/seemirai/issues/170
- mother branch: `issue-170-mother`
- Sub PR 01: https://github.com/limcpf/seemirai/pull/171
- Sub PR 02: https://github.com/limcpf/seemirai/pull/172
- Sub PR 03: `issue-170-subpr-03-verification-closeout`

## 완료 범위

### Sub PR 01. Inbound Foundation, Security & Dedupe

- inbound config/env contract와 기본 비활성 guard
- Telegram `getUpdates` polling provider와 fake provider
- owner chat/user allowlist와 bot mention parser guard
- `/status`, `/positions`, `/pnl`, `/why <market|cash>`, `/orders`, `/risk`, `/pause`, `/resume`, `/kill` parser/router type
- `TELEGRAM_INBOUND_COMMAND` audit event와 jobs table 기반 durable dedupe store
- unauthorized/unknown/malformed/duplicate audit evidence
- Telegram token, raw provider body, raw update, raw message text redaction

### Sub PR 02. Command Runtime Integration

- read-only command runtime: `/status`, `/positions`, `/pnl`, `/why <market|cash>`, `/orders`, `/risk`
- control command runtime: `/pause`, `/resume`, `/kill`
- 60초 TTL의 동일 명령 2단계 confirmation store
- kill switch control provider mapping
  - `/pause` -> `NEW_ORDERS_BLOCKED`, `operator_pause`
  - `/resume` -> `NORMAL`, `operator_resume`
  - `/kill` -> `HARD_STOP`, `operator_kill`
- Telegram `sendMessage` reply adapter와 4096자 제한 formatter
- dedupe 저장 실패와 audit append 실패 fail-closed 처리
- durable control evidence에서 Telegram caller source 보존

### Sub PR 03. Verification, Docs & Closeout

- fake polling integration test 추가
- M20 inbound source scan 결과 정리
- `docs/RUNTIME_CONFIG.md`, `docs/SECURITY.md`, `docs/RELIABILITY.md`, `docs/FEATURE_REQUIREMENTS.md`,
  `docs/product-specs/upbit-live-autonomous-trading.md` 갱신
- 완료 기록과 문서 인덱스/context map 갱신

## Acceptance Criteria Trace

| 기준 | 완료 근거 |
| --- | --- |
| 기본 비활성 inbound | `loadRuntimeTelegramInboundConfig` guard와 config 기본값, `tests/unit/telegram-inbound.test.ts` |
| owner allowlist | `evaluateTelegramInboundAuthorization`, unauthorized audit-only 테스트 |
| read-only command 무부작용 | runtime handler가 status provider만 호출하고 kill switch/live broker를 호출하지 않는 테스트 |
| control command 인증/확인/idempotency | `/pause` 2단계 confirmation, dedupe, kill switch provider mapping 테스트 |
| `/pause` 전역 신규 주문 중단 | `NEW_ORDERS_BLOCKED`/`operator_pause` mapping 테스트 |
| `/resume` state machine 준수 | 기존 kill switch control provider가 불법 전이를 거부하는 경계를 재사용 |
| 중복 update/message/command 차단 | in-memory/durable dedupe 테스트와 fake polling integration test |
| secret/raw payload 저장 금지 | audit/reply/result redaction 테스트 |
| 한국어 user-facing 응답과 추적 정보 분리 | Telegram formatter tests와 4096자 제한 테스트 |
| PAPER_NO_KEY live order API 0회 유지 | M20 inbound 경로 source scan에서 live broker submit/cancel 신규 매칭 없음 |
| M21 approval/live submit 경로 제외 | `/approve` parser negative test와 M20 inbound 경로 source scan |

## Source Scan

실행 경로:

```sh
rg -n "setWebhook|webhook" src/runtime/telegram-inbound-runtime src/infrastructure/telegram src/application/telegram-inbound tests/unit/telegram-inbound.test.ts tests/unit/telegram-inbound-runtime.test.ts tests/integration/telegram-inbound-runtime.test.ts
rg -n "/approve|/reject|approval|approve|reject" src/runtime/telegram-inbound-runtime src/infrastructure/telegram src/application/telegram-inbound tests/unit/telegram-inbound.test.ts tests/unit/telegram-inbound-runtime.test.ts tests/integration/telegram-inbound-runtime.test.ts
rg -n "submitOrder\\(|cancelOrder\\(|POST /v1/orders|DELETE /v1/order|UpbitLiveBroker|createUpbitLiveBroker" src/runtime/telegram-inbound-runtime src/infrastructure/telegram src/application/telegram-inbound tests/unit/telegram-inbound.test.ts tests/unit/telegram-inbound-runtime.test.ts tests/integration/telegram-inbound-runtime.test.ts
```

결과:

- `setWebhook|webhook`: public webhook route 없음. 매칭은 notifier/polling adapter JSDoc의 "webhook을 만들지 않는다" 설명뿐이다.
- `/approve|/reject|approval|approve|reject`: `/approve` parser negative test, 기존 alt approval fixture, formatter의 accepted/rejected
  표현만 매칭된다. M20 inbound approval route나 승인 workflow는 없다.
- `submitOrder|cancelOrder|POST /v1/orders|DELETE /v1/order|UpbitLiveBroker`: M20 inbound 변경 경로에서 match 없음.

## 검증

Sub PR 03에서 직접 실행한 검증:

```sh
./scripts/verify docs
pnpm typecheck
pnpm exec vitest run tests/unit/telegram-inbound.test.ts tests/unit/telegram-inbound-runtime.test.ts tests/integration/telegram-inbound-runtime.test.ts
pnpm exec vitest run tests/integration/telegram-inbound-runtime.test.ts
./scripts/verify
```

결과:

- `./scripts/verify docs`: 문서 63개, 매니페스트 80개, 링크 214개 확인
- `pnpm typecheck`: 통과
- 관련 Telegram inbound vitest: 3 files, 17 tests 통과
- fake polling integration 단독 실행: 1 file, 1 test 통과
- `./scripts/verify`: 78 passed / 11 skipped test files, 1280 passed / 113 skipped tests

Sub PR 01/02에서 누적 확인한 검증:

```sh
pnpm typecheck
pnpm exec vitest run tests/unit/telegram-inbound.test.ts tests/unit/telegram-inbound-runtime.test.ts tests/unit/kill-switch-control.test.ts
./scripts/verify
```

최근 결과:

- `pnpm typecheck`: 통과
- 관련 vitest: 3 files, 23 tests 통과
- `./scripts/verify`: 77 passed / 11 skipped test files, 1279 passed / 113 skipped tests
- GitHub check `verify`: Sub PR 01, Sub PR 02 모두 SUCCESS

## 결정 로그

- M20 transport는 public webhook이 아니라 Telegram `getUpdates` polling으로 확정했다.
- inbound는 기본 비활성이며, enabled flag와 owner allowlist가 모두 없으면 시작하지 않는다.
- read-only 명령은 기존 safe status snapshot을 재사용하고 주문 side effect를 만들지 않는다.
- control 명령은 Telegram 자체 승인 workflow가 아니라 기존 kill switch control provider로 제한한다.
- confirmation pending store는 process-local memory다. 재시작 시 pending 확인이 사라지며, 이 경우 실행되지 않는 fail-closed 동작이다.
- dedupe/audit 실패는 provider 실행 전에 중단한다. 운영자는 한국어 reply와 audit reason으로 원인을 확인한다.
- `/approve`, `/reject`, order proposal approval, 승인된 live broker 제출은 M21로 분리한다.

## 남은 리스크와 후속 작업

- Telegram inbound runtime 조립을 실제 long-running worker lifecycle에 붙이는 운영 wiring은 별도 deployment/config 작업에서 확인해야 한다.
- process-local confirmation store는 단일 프로세스 MVP에는 충분하지만, 다중 프로세스 polling으로 확장하면 durable confirmation store가 필요하다.
- M21에서 approval workflow를 열 때는 M20의 allowlist/dedupe/audit/reply redaction invariant를 그대로 재사용해야 한다.
- 사용자가 main 대상 PR 생성 전 중단을 지시했으므로, issue #170 mother branch에서 main PR은 아직 만들지 않는다.
