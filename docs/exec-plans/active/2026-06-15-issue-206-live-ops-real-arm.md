# Issue #206 Live Ops 실거래 arm 실행 계획

## 목표

`corepack pnpm live:ops -- --config <운영-json-path> --env-file <운영-env-path> --tui` production 경로가 실제 DB, Upbit public/private API,
Telegram, TUI를 같은 lifecycle로 조립하고, 조건을 통과한 단일 `KRW-BTC` 주문 후보가 `UpbitLiveBroker.submitOrder`까지 도달할 수
있는 상태를 만든다.

완료 근거는 dashboard readiness나 fixture smoke가 아니다. 실제 운영 credential과 redacted artifact가 준비된 환경에서 소액
`BUY + LIMIT + post_only` 주문을 제출하고, 같은 Upbit `identifier` 또는 uuid로 취소 요청과 terminal cancel 확인까지 닫은 evidence를
남기는 것이 최종 closeout 기준이다.

## 범위

- production `live:ops` boot sequence의 실제 provider arm
- 실제 Upbit public market data와 DB freshness 연결
- decision pipeline의 실제 market frame 기반 HOLD/order intent evidence
- `LiveOpsLiveExecution`에서 `LiveAutonomousEntryRuntime`과 `UpbitLiveBroker` 조립
- private read reconcile/PnL/status safe summary
- 실제 Telegram startup/live capable/order/cancel/manual review alert dispatch
- TUI 실제 운영 화면과 최소 5초 이하 status 갱신
- 실거래 cleanup submit/cancel terminal evidence와 redaction/source scan closeout

## 제외 범위

- BTC 외 market 기본 활성화
- 자동 budget 확대
- 신규 진입 시장가, 시장가 매도, best order 기본 허용
- hard stop 시 open position 자동 시장가 청산
- 출금, 입출금 자동화, 선물, 레버리지, 마진, 타인 계정, 신호 판매
- Web 백오피스와 Telegram public webhook endpoint
- LLM 직접 매수/매도 판단
- secret 원문이나 raw provider payload를 issue, PR, log, artifact, TUI, Telegram, status에 기록하는 작업

## Sub PR 계획

### Sub PR 01: 실제 arm contract와 runbook 기준

- 목표: #196 fixture 중심 완료 기준과 #206 실제 실거래 evidence 기준을 문서로 분리한다.
- 제외 범위: 실제 provider 호출 코드, DB schema 변경, live order side effect.
- DnD:
  - [ ] issue #206 전체 AC와 sub PR DnD가 이 계획에 기록되어 있다.
  - [ ] `docs/FEATURE_REQUIREMENTS.md`, runtime/reliability/security/product spec/runbook이 실제 실거래 evidence 기준을 가리킨다.
  - [ ] 새 runbook과 active plan이 `docs/README.md`, `docs/runbooks/README.md`, `docs/exec-plans/active/README.md`,
        `docs/generated/context-map.json`에 등록되어 있다.
  - [ ] `./scripts/verify docs`가 통과한다.

### Sub PR 02: 실제 provider boot와 DB-backed market data

- 목표: fixture smoke가 아닌 운영 실행에서 DB readiness 이후 Upbit public feed와 DB freshness를 실제로 계산한다.
- 제외 범위: broker 제출, private order side effect, Telegram 실제 전송.
- DnD:
  - [ ] boot sequence가 config/env validation -> DB/migration readiness -> Upbit public market data connection 순서를 지킨다.
  - [ ] `KRW-BTC` 체결/호가/status가 DB-backed store에 저장되고 freshness가 TUI/JSON에 표시된다.
  - [ ] stale/reconnect/disconnect는 신규 주문 전진을 차단하는 audit/risk evidence로 남는다.
  - [ ] provider 장애와 DB readiness 실패가 한국어 상태/원인/영향/필요 조치로 fail-closed 된다.
  - [ ] 관련 unit/integration/script smoke, `corepack pnpm typecheck`, `./scripts/verify`가 통과한다.

### Sub PR 03: decision에서 live execution과 broker 조립

- 목표: 실제 market frame 기반 decision이 manual JSONL 없이 `LiveAutonomousEntryRuntime.submitEntryCandidate`로 이어지고,
  guard를 통과한 단일 후보만 `UpbitLiveBroker` 경계까지 도달하게 한다.
- 제외 범위: 실제 cleanup 주문 실행, Telegram 실제 발송 closeout, 7일 안정화.
- DnD:
  - [ ] order intent가 없으면 HOLD/후보 없음 evidence를 남기고 broker 호출 0회를 유지한다.
  - [ ] 단일 `BUY + LIMIT + post_only` 후보만 live autonomous entry runtime으로 전달된다.
  - [ ] mode, market allowlist, key scope, budget, market data freshness, reconcile freshness, PnL/status, decision ledger, kill switch,
        Upbit policy, price deviation guard가 broker 호출 전에 fail-closed 된다.
  - [ ] idempotency key와 Upbit identifier가 durable reservation 이전에 고정되고 restart 재시도에서 duplicate order를 만들지 않는다.
  - [ ] 관련 unit/integration/script smoke, `corepack pnpm typecheck`, `./scripts/verify`가 통과한다.

### Sub PR 04: reconcile/PnL/status와 Telegram 실제 연결

- 목표: private read reconcile/PnL/status와 Telegram lifecycle/trade alert를 실제 provider 기준으로 연결한다.
- 제외 범위: 실제 cleanup 주문 실행과 completed closeout 이동.
- DnD:
  - [ ] private read path가 account/order/balance 상태를 secret-safe summary로 낮춘다.
  - [ ] open order, open exposure, budget used, realized/unrealized PnL, latest reconcile, mismatch/manual review 상태가 TUI/JSON에 표시된다.
  - [ ] startup, live order capable, order submitted, cancel requested/confirmed, risk/reconcile block, manual review alert가 실제 owner chat으로
        전송 가능한 dispatch 경계에 연결된다.
  - [ ] Telegram 실패는 주문/리스크 commit을 되돌리지 않고 retry/manual review summary로 수렴한다.
  - [ ] 관련 unit/integration/script smoke, `corepack pnpm typecheck`, `./scripts/verify`가 통과한다.

### Sub PR 05: 실거래 cleanup closeout

- 목표: 실제 `KRW-BTC` 소액 주문 제출/취소/terminal cancel evidence로 issue #206을 닫을 수 있게 한다.
- 제외 범위: final main PR merge.
- 현재 상태: Sub PR 01-04는 `issue-206-mother`에 merge됐다. Sub PR 05에서는 closeout validator와 blocker 기록을 추가한다.
  현재 세션과 issue 댓글에는 운영자가 명시한 저장소 밖 config/env/evidence 경로가 없어 실제 주문 제출/취소 cleanup은 시작하지 않는다.
- DnD:
  - [ ] 운영자가 명시한 저장소 밖 config/env/evidence 경로로 단일 cleanup run이 실행된다.
  - [ ] submit -> cancel requested -> terminal cancel 확인 -> open exposure 0 순서가 redacted artifact에 남는다.
  - [ ] crash 0회, unhandled rejection 0회, duplicate order 0건, reconcile mismatch 0건, untracked fill 0건, live order cleanup failure 0건이
        증명된다.
  - [x] source/security scan 결과와 artifact redaction 검증 결과가 PR/closeout에 기록될 수 있도록
        `scripts/run-live-ops-real-arm-closeout.mjs` validator를 추가한다.
  - [x] active plan은 completed closeout으로 이동되거나, 외부 credential/evidence 부재 시 blocker와 필요한 운영자 조치를 명시한다.
  - [ ] `finish-readiness-audit` 기준 PASS 또는 명시적 PARTIAL/FAIL 근거를 남긴다.

## 검증 방법

공통 검증:

```sh
corepack pnpm typecheck
corepack pnpm test
./scripts/verify
git diff --check
```

문서 전용 sub PR:

```sh
./scripts/verify docs
git diff --check
```

운영 smoke:

```sh
corepack pnpm live:ops -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --tui
corepack pnpm live:ops:tui -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --attach fixture
```

실거래 cleanup 검증은 `docs/runbooks/live-ops-real-arm-cleanup.md`의 redaction/credential 조건을 충족한 운영 환경에서만 실행한다.
redacted closeout manifest 검증은 다음 명령으로 수행한다.

```sh
SEEMIRAI_RUN_LIVE_OPS_REAL_ARM_CLOSEOUT=1 \
  node scripts/run-live-ops-real-arm-closeout.mjs \
  --manifest <저장소-밖-redacted-manifest-json> \
  --json
```

## 결정 로그

- 2026-06-15: issue #206의 완료 근거는 fixture smoke, heartbeat-only, dashboard readiness가 아니라 실제 submit/cancel terminal evidence다.
- 2026-06-15: 기본 market은 `KRW-BTC` 단일이고, 첫 실거래 주문 상한은 기존 small-budget 기준인 10,000 KRW를 유지한다.
- 2026-06-15: 신규 진입은 `BUY + LIMIT + post_only`만 허용한다.
- 2026-06-15: secret 원문, raw Authorization/JWT, raw provider payload, raw order detail은 저장소와 PR/issue 표면에 남기지 않는다.
- 2026-06-15: final main PR은 생성/갱신과 review drain까지만 수행하고 merge하지 않는다.
- 2026-06-15: Sub PR 05 closeout validator는 실제 주문 API를 호출하지 않고, 운영자가 저장소 밖에서 만든 redacted manifest/artifact만
  검증한다. guard가 없으면 skipped/blocker summary만 남긴다.

## 남은 이슈

- 실제 운영 credential과 redacted artifact 위치는 저장소 밖에서 준비되어야 한다.
- 실제 주문 제출/취소는 Sub PR 05에서 운영자 arm evidence가 확인된 뒤에만 실행한다.
- 현재 세션에는 `SEEMIRAI_*`, `UPBIT_*`, `TELEGRAM_*` 운영 env 값이 없고 issue #206 댓글에도 운영 config/env/evidence 경로가 없다.
  운영자는 저장소 밖 config/env, key scope evidence, operator arm evidence, redacted artifact 경로를 준비한 뒤 closeout manifest 검증을
  다시 실행해야 한다.
