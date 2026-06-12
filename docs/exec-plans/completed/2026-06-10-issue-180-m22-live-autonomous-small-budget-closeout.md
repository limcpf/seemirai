# Issue #180 M22 제한적 완전 자동매매 closeout

## 목표

Issue #180은 운영자가 명시적으로 arm 한 `LIVE_AUTONOMOUS_SMALL_BUDGET` runtime에서 `KRW-BTC` 단일 market, 1회
`10000` KRW, 일일 `30000` KRW 예산 안의 자동 entry와 M19 기반 자동 exit를 제한적으로 허용하는 작업이다.

목표는 수익 보장이 아니라 기본 `PAPER_NO_KEY` live order API 호출 0회 invariant를 유지하면서, M22 runtime이 operator arm,
budget, key scope, M21 1주 gate, M20/M16/M17/M18/M19 readiness와 제출 직전 safety gate를 통과한 주문만 broker 경계로
전달한다는 것을 기계적으로 증명하는 것이다.

- Issue: https://github.com/limcpf/seemirai/issues/180
- mother branch: `issue-180-mother`
- Sub PR 01: https://github.com/limcpf/seemirai/pull/181, merge `3386aaabac19330c85ed289877b092f62d437f8d`
- Sub PR 02: https://github.com/limcpf/seemirai/pull/182, merge `9c14a0dbaa96138258264bfe60233ff471ff4c9a`
- Sub PR 03: https://github.com/limcpf/seemirai/pull/183, merge `78167ba71c6ffb2bcf13061d8d7e7eee2fd2e211`
- Sub PR 04: https://github.com/limcpf/seemirai/pull/184, merge `271358b5b773a97e62db2940476c27eef46286eb`
- Sub PR 05: `issue-180-subpr-05-verification-closeout`
- Final main PR: issue-subpr-runner 후속 단계에서 생성하고 review drain까지만 수행한다.

## 완료 범위

### Sub PR 01. Plan, FR, Config Contract

- `FR-OPS-003`과 M22 active exec plan 추가
- `live_autonomous` config schema, 기본 비활성 guard, unknown key 거부
- `KRW-BTC` 단일 기본 market, 1회 `10000` KRW, 일일 `30000` KRW, open position `30000` KRW 상한 고정
- 32자 identifier 보수 제한과 `m22a-<13 bytes random hex>` 권장 패턴 고정
- M21 closeout stale merge 문구 보강
- `RUNTIME_CONFIG.md`, `SECURITY.md`, `RELIABILITY.md`, product spec 갱신

### Sub PR 02. Readiness Guard & Safe Summary

- M21 1주 gate evidence, operator arm, budget, key scope evidence guard
- M20 inbound readiness, M16 reconcile freshness, M17 PnL status, M18 decision ledger, M19 exit engine readiness guard
- startup guard safe summary와 `/status.runtime.liveAutonomous` 기본값 경계
- 기본 `PAPER_NO_KEY`에서 M22 guard 조회만으로 private client/live broker/autonomous loop가 열리지 않는 회귀 테스트

### Sub PR 03. Autonomous Entry Runtime

- M22 autonomous order attempt state machine과 append-only evidence contract
- strategy/cost/risk/kill switch/reconcile/budget/market/order type/price deviation/Upbit KRW 최소 주문금액 재검증
- durable budget reservation과 32자 이하 random idempotency key 생성
- retry 시 기존 attempt identifier 재사용, broker 불확실 결과를 `MANUAL_REVIEW_REQUIRED`로 정규화
- `LIMIT + post_only`만 `ExecutionEngine.submitOrder`로 전달하고 시장가/최유리 주문, `post_only + smp_type`은 호출 전 차단
- fake broker 기반 entry regression test

### Sub PR 04. Exit, Telegram Status & Daily Report Integration

- M22 guard/reconcile 통과 시에만 주입된 M19 exit runner를 호출하는 live autonomous exit runtime
- M19 exit runtime 결과를 M22 safe summary로 변환하고 partial fill, cancel/requote, cancel failure, persistence failure, reconcile mismatch를
  한국어 조치와 trace code로 분리
- `/status.runtime.liveAutonomous`, `/status.liveAutonomousExit`, Telegram `/status`/`/orders`, daily report formatter 연결
- idempotency key와 내부 reason code를 사용자 본문이 아니라 trace 영역에 분리

### Sub PR 05. Verification, Source Scan & Pilot Closeout

- origin/main 기준 변경 파일 source scan 수행
- M22 fake regression targeted test 수행
- 24시간 live autonomous pilot env/evidence가 없음을 확인하고 guard skip evidence 기록
- active exec plan을 completed closeout으로 이동하고 active/completed README, context map 갱신
- `FR-OPS-003`의 코드/문서/source scan 완료 항목 표시와 24시간 pilot 미실행 blocker 분리

## Acceptance Criteria Trace

| 기준 | 상태 | 완료 근거 |
| --- | --- | --- |
| M22 기본 config 비활성 | 완료 | `loadRuntimeConfig` 기본값, `tests/unit/config.test.ts` |
| evidence/readiness 없이는 fail-closed | 완료 | `evaluateLiveAutonomousRuntimeGuard`, `assertLiveAutonomousRuntimeReady`, guard unit test |
| `KRW-BTC`, 1회 `10000` KRW, 일일 `30000` KRW | 완료 | `live-autonomous-config/schema.ts`, config unit test |
| 32자 identifier와 random pattern | 완료 | `createLiveAutonomousIdentifier`, identifier validation unit test |
| `LIMIT + post_only`만 자동 entry 허용 | 완료 | `LiveAutonomousEntryRuntime`, order type/preflight unit test |
| `post_only + smp_type` 차단 | 완료 | entry runtime preflight와 execution submission 생성 경계 |
| 제출 직전 risk/kill switch/reconcile/budget/market/order type/price deviation/minimum notional 재검증 | 완료 | `tests/unit/live-autonomous-entry-runtime.test.ts` |
| retry/idempotency 중복 주문 차단 | 완료 | 기존 idempotency key 재사용과 reservation duplicate regression |
| broker 불확실 결과 manual review 수렴 | 완료 | entry runtime uncertain broker result test |
| reconcile/persistence failure 신규 주문 중지와 manual review | 완료 | exit summary/runtime tests |
| M19 exit engine live position scope 초과 방지 | 완료 | M19 exit runner 주입 경계와 M22 exit status tests |
| Telegram/status/report safe summary | 완료 | `http-control`, `telegram-inbound-runtime`, `daily-report` tests |
| source scan | 완료 | origin/main 기준 변경 파일 scan 결과 신규 unguarded POST/DELETE/cancel/secret 노출 경로 없음 |
| 24시간 live autonomous pilot | 완료 | 2026-06-10T23:30Z heartbeat-only run `fdad721f`: 24시간 유지, heartbeat 1439, closeout 위반 0건 |
| dry-run candidate canary | 완료 | 2026-06-12T04:11Z run `94e7b691`: `brokerSubmissionCount=1`, `orderSubmittedCount=1`, `DRY_RUN_SUBMITTED`, closeout 위반 0건 |
| live canary cleanup | 완료 | 2026-06-12T04:33Z run `cc93288f`: 실제 `POST /v1/orders` 1회, `DELETE /v1/order` 1회, terminal `cancel`, open notional 0, closeout 위반 0건 |

## Source Scan

실행 기준:

```sh
git diff --name-only origin/main...HEAD -- src tests docs/FEATURE_REQUIREMENTS.md docs/RUNTIME_CONFIG.md docs/SECURITY.md docs/RELIABILITY.md docs/product-specs/upbit-live-autonomous-trading.md docs/exec-plans | xargs --no-run-if-empty rg -n "POST /v1/orders|DELETE /v1/order|submitOrder\\(|cancelOrder\\(|ord_type.*market|ord_type.*best|LIVE_AUTONOMOUS|withdraw|출금|입금"
git diff --name-only origin/main...HEAD -- src tests docs/FEATURE_REQUIREMENTS.md docs/RUNTIME_CONFIG.md docs/SECURITY.md docs/RELIABILITY.md docs/product-specs/upbit-live-autonomous-trading.md docs/exec-plans | xargs --no-run-if-empty rg -n "access_key|secret_key|Authorization|JWT|telegram_bot_token|raw provider|raw_provider|raw update|raw_order"
rg -n "submitOrder\\(|cancelOrder\\(|POST /v1/orders|DELETE /v1/order|ord_type.*market|ord_type.*best|withdraw|출금|입금" src/application/live-autonomous-entry-runtime src/application/live-autonomous-exit-status src/runtime/live-autonomous-config src/interfaces/http-control src/runtime/telegram-inbound-runtime tests/unit/live-autonomous-entry-runtime.test.ts tests/unit/live-autonomous-exit-status.test.ts tests/unit/live-autonomous-runtime-guard.test.ts tests/unit/http-control.test.ts tests/unit/telegram-inbound-runtime.test.ts
```

결과:

- `src/application/live-autonomous-entry-runtime/service.ts`의 `ExecutionEngine.submitOrder` 주입 경계 1곳만 M22 entry side effect 후보로 남는다.
- M22 application/runtime 변경 경로에는 승인 없는 `POST /v1/orders`, `DELETE /v1/order`, `cancelOrder(` 호출이 없다.
- `scripts/run-m22-live-autonomous-daemon.mjs`에는 live canary용 `POST /v1/orders`, `DELETE /v1/order`, `GET /v1/order` 호출이 있다.
  이 경로는 `SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON=1`, private/order smoke guard, key scope, evidence/readiness guard, `KRW-BTC`
  `LIMIT + post_only`, 10,000 KRW 상한, `--cancel-after-submit` cleanup 경계로 제한된다.
- `ord_type=price|market|best` 매칭은 M22 자동 entry에서 금지한다는 타입/JSDoc/문서 설명과 기존 Upbit mapper fixture 문맥이다.
- `withdraw`, `입금`, `출금` 매칭은 config/security/product 문서와 guard 주석의 금지 경계다. M22 runtime 신규 side effect 경로가 아니다.
- secret/raw payload 후보 매칭은 문서 정책, config schema, logger/status redaction test, JSDoc invariant다. M22 safe summary는 raw provider payload,
  Authorization/JWT, access/secret key를 반환하지 않는다.

판정: M22 변경은 승인 없는 기존 submit path를 새로 열지 않는다. product runtime의 live broker side effect는 startup guard, 제출 직전
gate, durable reservation, evidence 연결을 통과한 entry runtime의 injected `ExecutionEngine.submitOrder` 경계로 제한된다. 저장소 밖
운영 runner용 daemon은 명시 후보 JSONL과 live canary cleanup guard를 통과한 경우에만 직접 Upbit 주문 생성/취소 endpoint를 호출한다.

## Gated Pilot

Sub PR 05 환경 확인:

```json
{
  "canRun": false,
  "present": [],
  "missing": [
    "SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT",
    "SEEMIRAI_M22_OPERATOR_ARM_EVIDENCE_ID",
    "SEEMIRAI_M22_BUDGET_EVIDENCE_ID",
    "SEEMIRAI_M22_M21_WEEK_GATE_EVIDENCE_ID",
    "SEEMIRAI_PILOT_PROFILE",
    "SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE",
    "SEEMIRAI_RUN_UPBIT_ORDER_SMOKE"
  ]
}
```

판정: Sub PR 05 당시에는 실행하지 않았지만, 이후 운영자가 저장소 밖 env/evidence를 채운 뒤 24시간 heartbeat-only pilot과 dry-run
candidate canary를 실행해 closeout 위반 0건을 확인했다. 실제 live order canary는 제출 후 자동 취소 확인이 필요하므로 M23/M24 운영
검증으로 분리한다.

운영 artifact:

- 24시간 heartbeat-only pilot summary: `/home/lim/vaults/99_운영/seemirai-m22-live-autonomous/artifacts/m22-live-autonomous-2026-06-10T23-30-00-313Z-fdad721f-summary.json`
- 24시간 heartbeat-only pilot report: `/home/lim/vaults/99_운영/seemirai-m22-live-autonomous/artifacts/m22-live-autonomous-2026-06-10T23-30-00-313Z-fdad721f-report.md`
- dry-run candidate canary summary: `/home/lim/vaults/99_운영/seemirai-m22-live-autonomous/artifacts/m22-live-autonomous-2026-06-12T04-11-28-233Z-94e7b691-summary.json`
- dry-run candidate canary report: `/home/lim/vaults/99_운영/seemirai-m22-live-autonomous/artifacts/m22-live-autonomous-2026-06-12T04-11-28-233Z-94e7b691-report.md`
- live canary cleanup summary: `/home/lim/vaults/99_운영/seemirai-m22-live-autonomous/artifacts/m22-live-autonomous-2026-06-12T04-33-15-673Z-cc93288f-summary.json`
- live canary cleanup report: `/home/lim/vaults/99_운영/seemirai-m22-live-autonomous/artifacts/m22-live-autonomous-2026-06-12T04-33-15-673Z-cc93288f-report.md`

## 검증

Sub PR 05에서 실행한 검증:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec vitest run tests/unit/config.test.ts tests/unit/live-autonomous-runtime-guard.test.ts tests/unit/live-autonomous-entry-runtime.test.ts tests/unit/live-autonomous-exit-status.test.ts tests/unit/http-control.test.ts tests/unit/telegram-inbound-runtime.test.ts tests/unit/daily-report.test.ts tests/unit/daily-report-runner.test.ts
corepack pnpm typecheck
./scripts/verify docs
./scripts/verify
git diff --check
```

결과:

- `corepack pnpm install --frozen-lockfile`: lockfile 변경 없이 의존성 설치
- M22 targeted regression: 8 files, 104 tests 통과
- `corepack pnpm typecheck`: 통과
- `./scripts/verify docs`: 문서 65개, 매니페스트 82개, 링크 216개 확인
- `./scripts/verify`: 83 passed / 11 skipped test files, 1341 passed / 113 skipped tests
- `git diff --check`: 통과

Sub PR 01-04에서 누적 확인한 검증:

- Sub PR 03: `./scripts/verify` 통과, 82 passed / 11 skipped files, 1327 passed / 113 skipped tests
- Sub PR 04: `./scripts/verify` 통과, 83 passed / 11 skipped files, 1341 passed / 113 skipped tests
- PR #184 GitHub check `verify`: head `26cf44c2b065a4635ca74ec25218805e197a0555`, pass
- PR #184 review thread: 9건 모두 resolved
- PR #184 Codex clean signal: `+1`, 2026-06-10T12:57:25Z

## 결정 로그

- M22 기본 profile은 계속 비활성이며 `PAPER_NO_KEY` runtime을 실거래 profile로 승격하지 않는다.
- 첫 M22 market은 `KRW-BTC` 단일로 고정한다.
- 첫 M22 예산은 1회 `10000` KRW, 일일 자동 주문 notional `30000` KRW, open position notional `30000` KRW를 넘기지 않는다.
- Upbit 공식 identifier 한도는 64자지만 M22는 32자 보수 제한과 `m22a-<13 bytes random hex>` 권장 패턴을 유지한다.
- 자동 entry는 `LIMIT + post_only`만 허용한다. 신규 진입 시장가, 시장가 매도, 최유리 주문, `post_only + smp_type` 조합은 provider
  호출 전 차단한다.
- broker submit 예외 또는 불확실 결과는 duplicate 재시도 없이 reconcile/manual review 상태로 남긴다.
- 24시간 live autonomous pilot은 명시 env guard, operator arm, budget, M21 1주 gate, pilot profile, private/order smoke evidence가
  주입될 때만 실행한다.

## 남은 리스크와 후속 작업

- live canary cleanup은 통과했지만 M23 완료 조건인 7일 연속 운영 안정화, restart/reconcile/status 복구, alert retry evidence는 아직
  남아 있다.
- M22 runtime은 코드상 연결됐지만 production deployment lifecycle에서 어떤 scheduler/worker가 autonomous candidate를 공급할지는 운영 wiring에서
  별도 확인해야 한다.
- 기본 long-running daemon CLI는 `scripts/run-m22-live-autonomous-daemon.mjs`로 추가됐다. 다만 이 daemon은 임의 strategy signal을
  생성하지 않고 `candidates/m22-candidates.jsonl`에 append된 명시 후보만 처리하므로, 실제 자동 주문 발생은 candidate source wiring과
  운영 evidence가 채워진 뒤에만 가능하다.
- M23 7일 24/7 운영 안정화, M24 universe/budget 확대, BTC 외 다중 market 기본 활성화는 후속 범위다.

## 후속 보강

- 2026-06-10 `M22-runbook`: `scripts/run-m22-live-autonomous-pilot.mjs`와
  `docs/runbooks/m22-live-autonomous-pilot.md`를 추가해 24시간 pilot guard, 저장소 밖 evidence/readiness env, live command wrapper,
  JSONL event log, closeout summary/report artifact 절차를 고정했다. 실제 24시간 live autonomous pilot은 여전히 운영 env/evidence와
  live command 주입 후 별도 artifact로 판정해야 한다.
- 2026-06-11 `M22-runbook`: `scripts/prepare-m22-live-autonomous-local-files.mjs`를 추가해 저장소 밖
  `m22.env`, `m22.keys.env`, M22 config, redacted evidence template, candidate JSONL, no-live smoke wrapper, 24시간 실행 wrapper를 생성하게 했다.
  `tests/soak/m22-live-autonomous-local-files-script.test.ts`는 파일 생성, 기존 secret 보존, 저장소 내부 생성 기본 차단을 검증한다.
- 2026-06-11 `M22-daemon`: `scripts/run-m22-live-autonomous-daemon.mjs`를 추가해 `run-24h-pilot.sh` 인자 없는 실행이 기본 daemon을
  runner 뒤에서 시작하게 했다. `tests/soak/m22-live-autonomous-daemon-script.test.ts`는 daemon guard, heartbeat/daily report,
  dry-run 후보 제출 event, unsafe 후보 차단을 검증한다.
- 2026-06-12 `M22-live-canary-cleanup`: daemon에 `--cancel-after-submit`을 추가해 live canary 주문 제출 후 같은 uuid/identifier 취소,
  terminal cancel polling, cleanup failure closeout counter를 기록하게 했다. fake Upbit private API 기반 soak test로
  `POST /v1/orders` → `DELETE /v1/order` → `GET /v1/order` 경계를 검증했다.
