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

### Sub PR 06: config-driven decision policy와 cleanup probe 전략

- 목표: production `live:ops`에서 strategy/decision source가 비어 있어 readiness가 `live_ops_strategy_decision_source_missing`으로 멈추는
  gap을 닫는다. 장기적으로는 live ops JSON이 허용된 decision policy를 선택하고 runtime이 그 policy를 검증된 `Strategy` 구현체로
  조립하는 구조를 만든다. 동시에 issue #206 closeout을 위한 전용 `cleanup_probe` 전략을 추가해 단일 `BUY + LIMIT + post_only`
  order intent를 만들 수 있게 한다.
- 제외 범위:
  - 실제 Upbit cleanup 주문 제출/취소 실행과 redacted artifact 생성.
  - 수익 목적의 신규 alpha/ML 전략, 자동 budget 확대, BTC 외 market 활성화.
  - 임의 JS/TS 파일 경로, 동적 import, 원격 plugin, 저장소 밖 strategy 코드를 config로 실행하는 기능.
  - 시장가/best order, 시장가 매도, 출금/입출금/선물/레버리지/마진 권한.
- DnD:
  - [x] `config/live-ops.example.json`과 `LiveOpsConfigSchema`가 secret이 아닌 `decision_policy` 선택값을 가진다.
        허용 policy는 정적 allowlist로 제한하고, 알 수 없는 policy나 임의 코드 경로는 config validation 단계에서 fail-closed 한다.
  - [x] runtime에 `LiveOpsDecisionPolicyResolver` 같은 조립 경계를 추가한다. 이 경계는 config를 읽어 검증된 `Strategy[]`와 policy
        evidence를 반환하며 DB write, broker 호출, Upbit 호출, Telegram 전송 side effect를 만들지 않는다.
  - [x] `cleanup_probe` 전략은 issue #206 closeout 전용 deterministic policy로 구현한다. 최신 DB-backed market frame/orderbook과
        config budget을 사용해 단일 `KRW-BTC` `BUY + LIMIT + POST_ONLY` 후보만 만들고, 계산 불확실성, stale frame, 호가/수량/명목금액
        불일치, budget 초과, market mismatch는 `HOLD` 또는 `BLOCK`으로 닫는다.
  - [x] `cleanup_probe` order intent는 `upbit_krw_spot`, `KRW-BTC`, `BUY`, `LIMIT`, `postOnly=true`, `timeInForce=POST_ONLY`,
        `requestedNotional <= 10000`, `expected_loss_bps_of_equity` metadata, stable idempotency key를 포함한다.
  - [x] production CLI의 non-fixture analysis/decision 경로가 placeholder `live_ops_strategy_decision_source_missing` 대신
        `cleanup_probe` decision policy contract를 실행한다. summary에는 후보 count만 남기고, 같은 decision tick의 raw order intent는
        live execution 내부 입력으로만 전달한다. public pipeline도 summary 밖 non-enumerable result channel로 같은 tick의 raw order
        intent를 반환한다. 후보 0개 HOLD는 broker 호출 없이 idle evidence로 닫고, BLOCK decision은 idle이 아니라 blocked analysis로
        fail-closed 한다.
  - [x] `cleanup_probe`는 `requiredFeatures=[]` orderbook-only policy로 동작한다. feature snapshot이 실패해도 0으로 보정하지 않고
        `live_ops_feature_snapshot_not_required` evidence와 함께 평가할 수 있으며, feature 의존 strategy는 feature 실패 시 계속 차단된다.
  - [x] `cleanup_probe` 후보는 summary에 raw intent를 직렬화하지 않고 live execution 내부 입력으로만 전달한다. 실제 CostModel/RiskGate,
        execution/budget/loss/post-submit readiness snapshot이 연결되지 않은 상태에서는 synthetic evidence를 만들지 않고
        `live_ops_entry_runtime_missing`으로 fail-closed 한다.
  - [x] public live execution adapter와 CLI adapter는 긴 strategy decision key를 stable `ops-` attempt id로 낮춘다. 같은 cleanup 후보를
        재평가해도 random identifier를 새로 만들지 않는다.
  - [x] issue #206 closeout validator는 `analysis.decision_policy.cleanup_probe` 표준 키와 값을 허용하고, 임의 strategy path 같은
        추가 키는 계속 차단한다.
  - [x] user-facing CLI/TUI/status 문구는 한국어 상태/원인/영향/필요 조치를 먼저 보여주고, policy id, reason code, idempotency key는
        추적 정보에 분리한다.
  - [x] 새 TypeScript public type/interface/class/function은 한국어 JSDoc을 가진다. 상태 전이, 리스크 차단, idempotency, order intent
        생성, policy fail-closed 분기에는 한국어 한 줄 주석을 남긴다.
  - [x] 관련 문서(`docs/RUNTIME_CONFIG.md`, `docs/RELIABILITY.md`, `docs/SECURITY.md`,
        `docs/runbooks/live-ops-real-arm-cleanup.md`, 이 active plan)를 config-driven decision policy와 cleanup probe 기준으로 갱신한다.
  - [x] 관련 unit/script tests, `corepack pnpm typecheck`, `./scripts/verify`, `git diff --check`가 통과한다.
  - [x] source/security scan에서 시장가/best order, 출금/입금, 선물/레버리지, raw secret, raw provider payload 경로가 새로 열리지 않았음을
        기록한다.
        - 금지 주문/권한 scan은 문서의 금지 경계 설명과 기존 guard/validator 코드에서만 매칭됐다.
        - secret/raw payload scan은 redaction 문서, 기존 credential loader/validator, private provider 구현 경계에서만 매칭됐다.
        - 신규 `src/runtime/live-ops-decision-policy/**` 경로는 private order API, Authorization/Bearer/JWT, raw provider/order payload,
          market/best/withdraw/deposit/futures/leverage side effect를 열지 않는다.

### Sub PR 07: production entry runtime과 cleanup submit/cancel 연결

- 목표: 현재 production `live:ops`가 `cleanup_probe` order intent 생성 뒤 `live_ops_entry_runtime_missing`으로 멈추는 gap을 닫는다.
  foreground command 한 번으로 읽기 전용 상태 확인, deterministic budget reservation, Upbit 소액 `BUY + LIMIT + POST_ONLY` 제출, 같은
  주문 uuid 취소 요청, terminal cancel 확인, redacted artifact 기록까지 이어지는 cleanup lifecycle을 조립한다.
- 제외 범위:
  - BTC 외 market 활성화, 자동 budget 확대, 수익 목적 신규 alpha 전략.
  - 시장가/best order, 시장가 매도, hard-stop open position 자동 청산.
  - 출금/입금, 선물/레버리지/마진, raw provider payload 저장, secret 원문 artifact 저장.
  - final main PR merge. final main PR은 review drain까지만 수행한다.
- DnD:
  - [x] production boot sequence가 DB readiness -> Upbit public market data -> cleanup_probe decision -> private read/reconcile/PnL preflight
        -> live execution submit -> same-order cancel -> terminal cancel verification -> post private read/status/Telegram 순서를 지킨다.
  - [x] production live execution이 `entryRuntime`, broker port, durable budget reservation, execution status, post-submit readiness,
        budget/loss snapshot을 synthetic evidence 없이 실제 config/env/DB/private read 기반으로 조립한다.
  - [x] durable reservation은 stable `ops-` attempt id와 requested notional을 저장소 밖 artifact 경로에 기록하고, 같은 attempt 재실행에서
        duplicate live order를 만들지 않고 fail-closed 한다.
  - [x] Upbit private broker는 `SEEMIRAI_UPBIT_ACCESS_KEY`/`SEEMIRAI_UPBIT_SECRET_KEY`로 JWT를 생성하되 Authorization/JWT/raw payload를
        summary, Telegram, artifact, error trace에 남기지 않는다.
  - [x] broker 제출은 `KRW-BTC`, `BUY`, `LIMIT`, `POST_ONLY`, `requested_notional <= 10000`, `identifier <= 32` guard를 통과한 단일
        cleanup 후보만 허용한다.
  - [x] submit 성공 뒤 같은 runtime이 받은 Upbit uuid만 취소할 수 있고, terminal cancel/done 상태를 제한된 polling으로 확인하지 못하면
        manual review로 격상한다.
  - [x] JSON/TUI/Telegram safe summary는 한국어 상태/원인/영향/필요 조치를 먼저 보여주고, attempt id, redacted uuid/identifier suffix,
        artifact path는 추적 정보로 분리한다.
  - [x] cleanup artifact는 저장소 밖 JSON safe summary로만 남기며 secret-like key, raw provider payload, raw order detail, Authorization,
        Bearer/JWT, DB URL/password, Telegram token, TUI control token을 포함하지 않는다.
  - [x] `docs/runbooks/live-ops-real-arm-cleanup.md`가 “운영자가 수동 artifact를 만드는 절차”가 아니라 production CLI가 자동 생성하는
        cleanup artifact와 closeout manifest 검증 절차를 설명한다.
  - [x] 관련 unit/script tests, `corepack pnpm typecheck`, `./scripts/verify`, `git diff --check`가 통과한다.

### Sub PR 08: preflight private read reconcile evidence

- 목표: 실제 운영 DB에 `live_reconcile_runs` 완료 기록이 없으면 production `live:ops`가 Upbit private read를 성공해도
  `reconcile_not_run`으로 fail-closed 되는 gap을 닫는다. 운영 command 한 번이 잔고/미체결 주문 private read 결과를 기존
  `live_reconcile_*` 테이블에 preflight reconcile evidence로 append-only 저장하고, 그 evidence를 다시 읽어 broker 제출 전
  readiness를 판단하게 한다.
- 제외 범위:
  - 기존 M16 장기 reconcile worker 대체.
  - mismatch/manual review가 이미 있는 DB 상태를 preflight clean evidence로 덮어쓰기.
  - raw provider payload, secret, Authorization/JWT, Telegram token, DB URL 원문 저장.
  - BTC 외 market, 시장가/best order, 출금/입금/선물/레버리지/마진 권한.
- DnD:
  - [ ] production preflight가 DB reconcile status `SKIPPED` + `reconcile_not_run`일 때만 actual private read 결과를
        `LIVE_OPS_PRIVATE_READ_PREFLIGHT` run으로 저장한다.
  - [ ] balance snapshot은 `live_reconcile_balance_snapshots`에 REST source로 저장하고, 저장 실패 시 broker 제출 전 fail-closed 한다.
  - [ ] preflight 시점에 설정 마켓 밖의 다른 KRW 마켓까지 포함한 계정 전체 open order가 있으면 `MANUAL_REVIEW_REQUIRED` run과
        `UNTRACKED_EXCHANGE_OPEN_ORDER` mismatch evidence로 닫고 신규 cleanup 주문을 제출하지 않는다.
  - [ ] 기존 DB reconcile이 clean이어도 현재 private read에서 계정 전체 open order가 발견되면 새 preflight manual-review evidence를
        append하고 신규 cleanup 주문을 제출하지 않는다.
  - [ ] 가격 또는 원 주문 수량이 없는 `market`/`best` 계열 open order도 `remaining_volume` 기반 preflight evidence로 저장하며,
        notional 계산 실패로 `preflight-failed`에만 머물지 않는다.
  - [ ] preflight manual-review summary는 계산 가능한 open exposure/budget used를 0으로 숨기지 않고 TUI/JSON에 보존한다.
  - [ ] submitted/cancel_requested 상태의 계정 전체 open order는 현재 liveExecution의 broker order id 또는 idempotency key와 일치하는 1건만
        tracked로 인정하고, 다른 open order가 함께 있으면 manual review로 차단한다.
  - [ ] 기존 DB reconcile mismatch, failed, running, manual review 상태는 새 preflight clean evidence로 덮지 않고 그대로 차단한다.
  - [ ] 저장된 preflight run을 다시 읽은 뒤에만 `reconcileFresh=true`와 post-submit reconcile readiness가 열릴 수 있다.
  - [ ] TUI/JSON은 live execution blocked 상태를 `후속 연결 대기`로 숨기지 않고 한국어 차단 사유, stable check code, preflight run id와
        `UNTRACKED_EXCHANGE_OPEN_ORDER` evidence type을 보여준다.
  - [ ] preflight `MANUAL_REVIEW_REQUIRED`는 owner Telegram trade alert 경계로도 전송된다.
  - [ ] 관련 unit/script tests, `corepack pnpm typecheck`, `./scripts/verify`, `git diff --check`가 통과한다.

### Sub PR 09: cleanup closeout evidence gap 보강

- 목표: final PR review에서 발견된 cleanup closeout evidence gap을 닫는다. closeout validator timestamp alias, cleanup Telegram lifecycle
  event, duplicate identifier recovery 주문 cleanup 소유권을 보강한다.
- 제외 범위:
  - 새로운 전략, budget 확대, BTC 외 market 활성화.
  - 실제 운영 credential 노출 또는 저장소 안 artifact 생성.
  - final main PR merge.
- DnD:
  - [x] closeout validator가 `terminalCancelConfirmedAt` 성공 evidence를 허용하되 실패/manual review artifact에는 cancel confirmed alias를
        남기지 않는다.
  - [x] cleanup Telegram event가 submit, cancel requested, cancel confirmed lifecycle을 순서대로 표현한다.
  - [x] duplicate identifier로 복구한 주문도 현재 runtime의 submitted order id로 기록해 같은 주문을 즉시 취소/terminal 확인할 수 있다.
  - [x] 관련 unit tests, `corepack pnpm typecheck`, `./scripts/verify`, `git diff --check`가 통과한다.

### Sub PR 10: attach read-only와 pre-submit budget/balance guard

- 목표: final PR review에서 발견된 attach side effect와 pre-submit guard gap을 닫는다. `live:ops:tui -- --attach`는 read-only viewer로 고정하고,
  KRW 가용잔고 누락/0원은 broker 제출 전 risk gate에서 차단하며, file budget reservation은 일일 예산 집계를 atomic lock 안에서 선점한다.
- 제외 범위:
  - foreground cleanup submit/cancel lifecycle 변경.
  - 새로운 TUI control daemon/socket protocol.
  - budget 상한 확대, BTC 외 market 활성화, 시장가/best order 허용.
  - final main PR merge.
- DnD:
  - [x] non-fixture attach TUI가 실제 JSON status source를 읽고, source 부재나 필수 summary 누락은 fail-closed 하며, production runtime,
        Upbit public/private provider, broker, cleanup lifecycle, Telegram dispatch를 새로 열지 않는다.
  - [x] foreground `live:ops` 명령은 `--attach`를 production boot 성공으로 처리하지 않는다.
  - [x] KRW balance row 누락, 0원, 요청금액 미만은 adapter pre-submit risk infrastructure signal로 fail-closed 되고 entryRuntime/broker 호출
        0회를 유지한다.
  - [x] durable file reservation은 같은 날짜 lock 안에서 current reservation aggregate와 open position snapshot을 재합산하고, 일일 예산 초과나
        lock busy 상태면 attempt 파일 생성 없이 broker 제출 전 차단한다.
  - [x] 관련 운영 문서가 attach read-only와 daily budget reservation invariant를 설명한다.
  - [x] 관련 unit tests, `corepack pnpm typecheck`, `./scripts/verify docs`, `./scripts/verify`, `git diff --check`가 통과한다.

### Sub PR 11: daily budget lock lease recovery

- 목표: final PR review에서 발견된 stale daily reservation lock gap을 닫는다. live ops process가 lock 획득 뒤 crash/SIGKILL/reboot로
  종료되어도 같은 날짜 운영이 `live_ops_daily_budget_lock_busy`에 영구 고착되지 않도록 lock lease metadata와 stale recovery를 추가한다.
- 제외 범위:
  - DB/advisory lock 도입, 별도 daemon/socket lifecycle.
  - budget 상한 확대, BTC 외 market 활성화, market/best order 허용.
  - final main PR merge.
- DnD:
  - [x] daily reservation lock 파일에 `leaseId`, `acquiredAt`, `expiresAt`, `pid`, owner boot id/process start time, source metadata를 기록한다.
  - [x] fresh lock은 기존처럼 busy로 fail-closed 하고 broker 호출 전 차단한다.
  - [x] 만료됐더라도 owner process fingerprint가 살아 있는 lock은 회수하지 않고 broker 호출 전 busy로 fail-closed 한다.
  - [x] owner가 사라진 만료 stale lock만 quarantine rename/CAS 절차로 회수한 뒤 같은 날짜 reservation을 재획득할 수 있다.
  - [x] JSON write 전 crash로 생긴 malformed lock은 파일 mtime 기준 TTL 이후 CAS 절차로 회수한다.
  - [x] 관련 운영 문서가 lease TTL, owner fingerprint, stale lock recovery invariant를 설명한다.
  - [x] 관련 unit tests, `corepack pnpm typecheck`, `./scripts/verify docs`, `./scripts/verify`, `git diff --check`가 통과한다.

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
- 2026-06-15: guarded closeout manifest는 실제 존재하는 저장소 밖 config/env 파일, 출금 권한이 없는 key scope safe summary, 실제
  `rg -n` source/security scan 명령, 미래가 아닌 주문 lifecycle timestamp, placeholder가 아닌 같은 주문 identifier/uuid suffix를 요구한다.
- 2026-06-15: closeout validator는 추가/중복 인자 없는 정확한 `live:ops` command, symlink realpath 기준 저장소 밖 config/env/artifact,
  artifact safe summary와 manifest closeout 값의 일치, database password redaction도 검증한다.
- 2026-06-15: guarded manifest 파일 자체도 저장소 밖이어야 하며, source/security scan은 `src scripts config docs` 전체 범위의 실제
  `rg -n` 실행 증거여야 한다. 중첩 artifact summary와 `raw_provider_payload`/`raw_order_detail` 필드도 차단한다.
- 2026-06-15: repository root 기준 저장소 경계, 배열 안 artifact record, `skipped`/`blocked` artifact status, redaction placeholder 뒤 원문
  secret도 closeout validator 차단 대상이다.
- 2026-06-15: closeout validator는 production config/env contract, 절대 config/env command 경로, parse 가능한 JSON artifact,
  artifact 주문 정책 필드, Bearer/JWT 독립 노출, camelCase raw payload, source scan 필수 패턴 전체도 차단 대상으로 본다.
- 2026-06-15: closeout validator는 foreground wrapper의 config allowed-key contract, ambient legacy env, source scan 제외 glob,
  빈 artifact, snake_case artifact 정책 필드, artifact lifecycle timestamp 충돌도 차단 대상으로 본다.
- 2026-06-15: closeout validator는 env assignment redaction tail, 붙여 쓴 source scan 제외 glob, artifact 주문 suffix/alias 충돌,
  env extra key scope/evidence id mismatch를 차단하고, non-closeout provider status는 오탐으로 실패시키지 않는다.
- 2026-06-15: closeout validator는 source scan 필수 경로를 실제 `rg` argv operand로 판정하고 brace exclude glob,
  `terminal_state` alias 충돌, 직접 `identifier`/`broker_order_id` artifact alias, TUI control token redaction까지 검증한다.
- 2026-06-15: closeout validator는 source scan coverage를 실제 검색 패턴 기준으로 판정하고, snake_case DB password,
  문자열 raw provider/order payload, 깊게 중첩된 artifact closeout 충돌도 차단한다.
- 2026-06-15: closeout validator는 출력 억제/파일 목록/without-match/preprocessor ripgrep 옵션, 모든 exclude glob,
  Bearer placeholder 뒤 raw token tail도 차단한다.
- 2026-06-15: closeout validator는 source scan의 repository root 실행 위치와 대문자 `ACCESS_KEY`/`SECRET_KEY` 검색,
  ripgrep type/ignore 제외 옵션, raw payload placeholder tail, artifact `ord_type` 충돌도 차단한다.
- 2026-06-15: closeout validator는 `--max-count`와 include glob으로 검색을 줄인 source scan, artifact wrapper failure status,
  colon-form secret log, fixtureSmoke false 오탐, snake_case order id placeholder도 검증한다.
- 2026-06-15: closeout validator는 붙여 쓴 `-m0`/`-m=0`, `-t`/`--type`, `--iglob`, `-F`/`--fixed-strings`처럼 source/security
  scan의 검색 범위나 패턴 의미를 줄이는 ripgrep 옵션도 차단한다.
- 2026-06-15: closeout validator는 `-f`/`--file`, `-v`/`--invert-match`, `--max-depth`, `--max-filesize` source scan,
  punctuation tail secret leak, Telegram base token URL, fixture-only artifact marker, hyphen/camelCase order id placeholder,
  failure status code variant, source scan raw match 원문 재노출도 차단한다.
- 2026-06-15: closeout validator는 manifest `run.ord_type` alias 충돌, Telegram placeholder tail, JSON string escape로 숨긴
  secret assignment, prefix 없는 compact JWT/lowercase bearer, PCRE2 no-match scan, shell redirection/pipe, fake env credential,
  escaped alternation pattern, `--files` source scan도 차단한다.
- 2026-06-15: closeout validator는 `rg --no-config` 없는 source scan, `-x`/`--line-regexp`, command substitution,
  JSON escape로 숨긴 secret/raw payload key, `SEEMIRAI_TELEGRAM_BOT_TOKEN` JSON field, raw payload placeholder punctuation tail도
  차단한다.
- 2026-06-15: closeout validator는 hidden/ignored source를 보지 않는 scan, `-w`/`--word-regexp`, shell parameter expansion,
  quoted raw payload placeholder tail, redacted placeholder 조각이 섞인 env 값, 깊게 중첩된 decoded JSON secret도 차단하고,
  주문 closeout field가 없는 provider/Telegram identifier는 주문 record로 오인하지 않는다.
- 2026-06-15: closeout validator는 SEEMIRAI camelCase credential JSON field, `-M`/`--max-columns`, `--stop-on-nonmatch`,
  date-only lifecycle timestamp, 충돌하는 주문 suffix pair, `time_in_force` alias 충돌, parse 실패 정규식 source scan도 차단한다.
- 2026-06-15: closeout validator는 source scan shell comment/newline, traversal override(`--ignore`, `--no-hidden`),
  replacement option, metadata-only rg mode, `-N`/`--no-line-number` line evidence 제거도 차단한다.
- 2026-06-15: closeout validator는 quoted pattern 속 line-number 가짜 증거, hyphenated/generic token JSON credential field,
  `MANUAL_REVIEW_REQUIRED` artifact status, JSON escape로 숨긴 fixture marker도 차단한다.
- 2026-06-15: closeout validator는 `-d`/`-I` rg 옵션, source scan raw label 재노출, manifest fixture marker,
  placeholder 뒤 JSON tail, timestamp-only non-order artifact 오탐, source scan 대체 표기와 TUI/DB credential coverage 누락도 검증한다.
- 2026-06-15: closeout validator는 count-only source scan, prefixed fake search term, source scan command 원문 재노출,
  깊은 artifact record 누락, `TIMEOUT` wrapper status, decoded camelCase credential key, password 없는 DB URL 원문도 차단한다.
- 2026-06-15: closeout validator는 값 있는 `rg` 출력 옵션, clustered `-g` exclude glob, `--` 뒤 traversal 가짜 증거,
  live:ops command shell separator, fixture credential, 불가능한 calendar date, decoded raw payload key, suffix형 blocked status도 차단한다.
- 2026-06-16: Sub PR 06은 실제 실거래 cleanup artifact 부재만 남은 상태로 간주하지 않는다. production `live:ops` readiness가
  `live_ops_strategy_decision_source_missing`으로 멈춘 원인을 first-class gap으로 보고, config-driven decision policy resolver와
  `cleanup_probe` strategy를 추가해 decision source를 명시적으로 연결한다.
- 2026-06-16: decision policy config는 허용된 정적 policy id만 고른다. config가 임의 파일 경로, 동적 import, 원격 plugin, 저장소 밖
  strategy 코드를 실행하게 만드는 구조는 보안/재현성 문제로 제외한다.
- 2026-06-16: `cleanup_probe`는 수익 전략이 아니라 issue #206 closeout lifecycle을 증명하기 위한 deterministic one-shot probe다.
  주문 후보 생성은 `BUY + LIMIT + post_only`, small budget, fresh market frame, same-tick order intent 전달 조건 안에서만 허용한다.
- 2026-06-18: production `live:ops`는 기존 DB reconcile run이 없을 때 actual Upbit private read 결과를 preflight reconcile evidence로
  먼저 저장한다. 단, 기존 mismatch/manual review/failed/running 상태는 preflight clean evidence로 덮지 않는다.
- 2026-06-18: `live:ops:tui -- --attach ...`는 read-only viewer다. attach 명령은 기존 JSON status source를 읽어야 하고, source를 읽지
  못하면 fail-closed 한다. attach 경로는 foreground boot sequence나 Upbit provider, broker, cleanup lifecycle, Telegram dispatch를 새로
  시작하지 않는다. foreground `live:ops` 명령의 `--attach`는 성공 처리하지 않는다.
- 2026-06-18: cleanup budget reservation은 attempt id 파일 생성 전에 같은 날짜 lock을 잡고, lock 안에서 reservation aggregate와 open
  position snapshot을 다시 합산해 일일 자동 주문 예산을 선점한다.
- 2026-06-18: daily reservation lock은 `leaseId`/`acquiredAt`/`expiresAt`/`pid`와 owner boot id/process start time lease metadata를
  기록한다. fresh lock은 동시 실행 보호로 유지하고, owner fingerprint가 사라진 만료 stale lock만 quarantine rename/CAS 절차로 회수해
  crash/reboot 이후 같은 날짜 운영이 영구 차단되지 않게 한다. malformed lock은 파일 mtime 기준 TTL 이후 같은 CAS 절차로 회수한다.

## 남은 이슈

- Sub PR 11 완료 후 final main PR #218의 stale lock review finding을 다시 drain해야 한다.
- 실제 운영 credential, key scope evidence, operator arm evidence, redacted artifact 경로는 저장소 밖 운영 vault에 있어야 한다.
- 실제 주문 제출/취소 closeout은 저장소 밖 운영 config/env로 foreground `live:ops`를 실행한 뒤 자동 생성 artifact와 closeout manifest로
  검증한다.
