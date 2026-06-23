# Issue #206 Live Ops 실거래 arm 실행 계획

## 목표

`corepack pnpm live:ops -- --config <운영-json-path> --env-file <운영-env-path> --tui` production 경로가 실제 DB, Upbit public/private API,
Telegram, TUI를 같은 lifecycle로 조립하고, 조건을 통과한 단일 `KRW-BTC` 주문 후보가 `UpbitLiveBroker.submitOrder`까지 도달할 수
있는 상태를 만든다.

완료 근거는 dashboard readiness나 fixture smoke가 아니다. 실제 운영 credential과 redacted artifact가 준비된 환경에서 소액
`BUY + LIMIT + post_only` 주문을 제출하고, 같은 Upbit `identifier` 또는 uuid로 취소 요청과 terminal cancel 확인까지 닫은 evidence를
남기는 것이 최종 closeout 기준이다.

2026-06-20 확장: 사용자가 요구한 “24/7 자동 매매”는 cleanup canary가 아니라 자동 매수, 보유, 매도 판단이 모두 포함된 daemon loop여야
한다. 따라서 이 계획은 기존 real-arm cleanup 위에 `live:ops:daemon`과 production entry/exit strategy allowlist를 추가한다. 실행 전
수동 fixture manifest, hand-written evidence, JSONL 후보 파일을 요구하지 않고, runtime이 decision evidence와 artifact를 자동 생성해야 한다.

## 범위

- production `live:ops` boot sequence의 실제 provider arm
- 실제 Upbit public market data와 DB freshness 연결
- decision pipeline의 실제 market frame 기반 HOLD/order intent evidence
- `LiveOpsLiveExecution`에서 `LiveAutonomousEntryRuntime`과 `UpbitLiveBroker` 조립
- private read reconcile/PnL/status safe summary
- 실제 Telegram startup/live capable/order/cancel/manual review alert dispatch
- TUI 실제 운영 화면과 최소 5초 이하 status 갱신
- 실거래 cleanup submit/cancel terminal evidence와 redaction/source scan closeout
- 24/7 daemon loop, entry/exit strategy registry, 보유 포지션 우선 exit 평가, bounded cancel/requote/manual-review 수렴

## 제외 범위

- BTC 외 market 기본 활성화
- 자동 budget 확대
- 신규 진입 시장가, 시장가 매도, best order 기본 허용
- hard stop 시 open position 자동 시장가 청산
- 출금, 입출금 자동화, 선물, 레버리지, 마진, 타인 계정, 신호 판매
- Web 백오피스와 Telegram public webhook endpoint
- LLM 직접 매수/매도 판단
- secret 원문이나 raw provider payload를 issue, PR, log, artifact, TUI, Telegram, status에 기록하는 작업
- 수익 보장, 투자 자문, 타인 자금 운용, 신호 판매

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
  - [x] acquire는 temp 파일에 완성된 lease JSON을 쓴 뒤 hard link로 lock path를 선점해 부분 JSON lock을 만들지 않는다.
  - [x] fresh lock은 기존처럼 busy로 fail-closed 하고 broker 호출 전 차단한다.
  - [x] 만료됐더라도 owner process fingerprint가 살아 있는 lock은 회수하지 않고 broker 호출 전 busy로 fail-closed 한다.
  - [x] owner가 사라진 만료 stale lock만 hard-link claim/CAS 절차로 회수한 뒤 같은 날짜 reservation을 재획득할 수 있다.
  - [x] CAS는 target을 비우기 전에 fingerprint, inode, link count를 확인해 fresh lock을 claim 중 target에서 제거하지 않는다.
  - [x] crash로 남은 같은 inode orphan claim/tmp hard link는 CAS 전에 정리해 nlink 고착을 풀 수 있다.
  - [x] 기존 버전이나 외부 손상으로 생긴 malformed lock과 필수 lease field가 빠진 valid JSON lock은 파일 mtime 기준 TTL 이후 CAS 절차로 회수한다.
  - [x] owner boot id 또는 process start time을 lock 생성 시점에 기록할 수 없으면 lock 획득을 중단한다.
  - [x] owner 조회가 권한/환경 문제로 불확실하면 active owner로 fail-closed 하고, zombie 상태가 확인되면 stale owner로 본다.
  - [x] 관련 운영 문서가 lease TTL, owner fingerprint, stale lock recovery invariant를 설명한다.
  - [x] 관련 unit tests, `corepack pnpm typecheck`, `./scripts/verify docs`, `./scripts/verify`, `git diff --check`가 통과한다.

### Sub PR 12: final review guard 보강

- 목표: final PR review에서 발견된 세 P2 gap을 닫는다. 금지 key scope에서는 preflight private read도 열지 않고, cancel 요청 이후 poll
  실패는 cleanup artifact로 남기며, post-cleanup status summary는 현재 durable reservation notional을 budget used에 반영한다.
- 제외 범위:
  - 신규 전략, budget 확대, BTC 외 market 활성화.
  - Upbit 주문 유형 확대, 시장가/best order, 출금/입금/선물/레버리지/마진 권한 허용.
  - final main PR merge.
- DnD:
  - [x] `SEEMIRAI_UPBIT_KEY_SCOPE`에 출금/입금/선물/레버리지/마진 또는 알 수 없는 scope가 포함되면 `listOpenOrders`/`getBalances`를
        호출하기 전에 broker guard 차단으로 수렴한다.
  - [x] cancel 요청 성공 뒤 terminal poll이 provider 오류나 rate-limit로 실패해도 generic catch로 빠지지 않고
        `manual_review_required` cleanup artifact에 cancel evidence와 실패 사유를 남긴다.
  - [x] cleanup submit/cancel 이후 reconcile/PnL/status summary의 `budgetUsedKrw`는 preflight snapshot만 사용하지 않고 현재
        durable reservation 반영값을 하한으로 사용한다.
  - [x] 관련 운영 문서가 scope guard 순서, cancel poll failure artifact, post-reservation budget used invariant를 설명한다.
  - [x] 관련 unit tests와 `git diff --check`가 통과한다.

### Sub PR 13: risk/freshness final guard 보강

- 목표: final PR review에서 발견된 추가 risk/readiness gap을 닫는다. 기존 BTC 보유 포지션을 예산과 RiskGate 입력에 반영하고,
  PnL non-OK 상태를 0 손실로 보정하지 않으며, clean reconcile evidence에도 freshness 범위를 적용하고, cleanup probe attempt id를 날짜별로 분리한다.
- 제외 범위:
  - hard-stop 청산, 시장가 매도, BTC 외 market 활성화.
  - budget 한도 확대, 신규 전략 추가.
  - final main PR merge.
- DnD:
  - [x] `KRW-BTC` 보유 잔고가 있으면 reference price로 평가해 `openPositionNotionalKrw`와 RiskGate `positions`에 포함한다.
  - [x] 보유 포지션 평가 기준가가 없으면 open position 과소평가를 막기 위해 broker 제출 전 fail-closed 한다.
  - [x] PnL/status provider가 `OK` snapshot을 주지 않으면 realized loss를 0으로 보정하지 않고 loss snapshot 결측으로 차단한다.
  - [x] clean reconcile evidence도 preflight 실행 wall clock 기준 30초 freshness를 넘으면 stale로 보고 같은 tick의 private read preflight evidence를 기록한다.
  - [x] cleanup probe decision key는 실행 wall clock 날짜 scope를 포함해 전날 reservation 파일이 다음 날 attempt를 영구 차단하지 않게 한다.
  - [x] 관련 운영 문서와 unit tests가 위 invariant를 설명하고 검증한다.

### Sub PR 14: PnL/source scan/cleanup key final guard 보강

- 목표: final PR review에서 발견된 PnL snapshot 정책과 closeout source scan 오탐, TypeScript cleanup probe idempotency scope gap을 닫는다.
- 제외 범위:
  - 신규 전략, budget 확대, BTC 외 market 활성화.
  - 시장가/best order, 출금/입금/선물/레버리지/마진 권한 허용.
  - final main PR merge.
- DnD:
  - [x] closeout validator의 필수 unsafe source scan family에서 일반 영어 단어 `market`과 정상 설정에서 나오는 `market_order`를 제거하고,
        `"?ord_type"?\s*[:=]\s*"?price|market|best` 계열과 `"?order_type"?\s*[:=]\s*"?(market|MARKET)`, `시장가`처럼
        실제 주문 payload/artifact 경계에 가까운 term만 empty-match coverage로 요구한다.
  - [x] production preflight PnL loss snapshot은 `readStatus=OK`와 숫자 realized PnL만으로 열리지 않고, `CALCULATED` snapshot
        status와 provider read 완료 후 시각 기준 30초 freshness를 함께 요구한다.
  - [x] `OK`, `SUCCESS`, `COMPLETE`, `COMPLETED`, `PARTIAL`, `MANUAL_REVIEW_REQUIRED`, `UNAVAILABLE`, status 누락 같은 PnL snapshot
        status는 손실 증거로 쓰지 않고 `ready=false`로 낮춰 broker 제출 전 loss guard에서 차단한다.
  - [x] preflight 시작 직후 PnL worker가 새 row를 쓰는 정상 경합은 stale로 보지 않도록 1초 이내 future skew만 허용한다.
  - [x] TypeScript `cleanup_probe` strategy는 날짜 placeholder key만 만들고, production preflight가 실제 reservation wall-clock 날짜로
        `strategy:date:exchange:market:side:price:qty:notional` key를 확정해 자정 경계 중복 주문을 막는다.
  - [x] runtime 날짜 scope 보정은 기존 `costSnapshot.trade_allowed=false`나 `riskApproval.approved=false` 같은 명시 차단 evidence를
        승인 evidence로 덮어쓰지 않는다. 같은 주문 후보의 날짜 key만 runtime preflight key로 갱신하고, 가격/수량/마켓이 다른 stale
        `order_intent` evidence는 보존해 broker guard에서 차단한다.
  - [x] runtime evidence 보정은 기존 malformed/stale CostModel snapshot 객체가 있으면 `trade_allowed=true` 같은 승인 기본값을
        합성하지 않고 broker guard가 차단하게 둔다.
  - [x] file budget reservation의 `reservedAt`과 일일 사용량 집계 날짜는 오래된 request observedAt이 아니라 실제 `reserve()`
        실행 wall clock으로 확정한다.
  - [x] terminal cancel/no-fill cleanup은 새 체결이 없다는 closeout evidence가 있으므로 stale `CALCULATED` PnL row만으로
        manual review를 열지 않는다. 단, `PARTIAL`/manual-review snapshot status는 계속 수동 확인 대상으로 둔다.
  - [x] closeout source/security scan은 단일따옴표 주문 payload, Upbit live broker adapter 경로, 입출금 endpoint/toggle,
        raw Postgres credential URL, quoted Authorization bearer literal, camelCase raw provider/order payload field도 필수 coverage로 요구한다.
  - [x] closeout source/security scan은 Upbit private JWT auth module, Upbit private mapper normalization 경로, legacy
        `TELEGRAM_BOT_TOKEN=123:...` raw token literal도 필수 coverage로 요구한다.
  - [x] closeout source scan은 Upbit private client의 `{ key: "ord_type", value: "..." }` 주문 payload 표현도
        `price|market|best` 금지 후보로 요구한다.
  - [x] closeout source scan은 한국어 user-facing/source 문자열에서 `시장가 ... 허용/활성/enabled/true` 형태의 위험 문구도
        금지 후보로 요구하되, mapper의 정상 차단 메시지는 오탐하지 않는다.
  - [x] 관련 운영 문서와 unit/soak tests가 위 invariant를 설명하고 검증한다.

### Sub PR 15: PnL closeout runner와 live:ops preflight 자동 refresh

- 목표: Sub PR 14의 `CALCULATED` PnL freshness guard가 운영 DB에서 row 부재만으로 영구 차단되는 gap을 닫는다. 운영자가 수동 JSON 증적을
  만들지 않아도 production `live:ops`가 fresh clean reconcile/balance source를 확보한 뒤 `live_ops_cleanup_probe` PnL closeout snapshot을
  append-only로 생성하고, 같은 tick에서 다시 읽어 loss guard를 판단하게 한다. 필요하면 같은 기능을 독립 CLI로도 실행할 수 있게 한다.
- 제외 범위:
  - 실제 주문 제출/취소 lifecycle 변경, budget 상한 확대, BTC 외 market 활성화.
  - PARTIAL/manual-review PnL row를 새 0원 snapshot으로 덮는 자동 복구.
  - raw provider payload, secret, DB URL, Authorization/JWT 출력 또는 artifact 저장.
- DnD:
  - [x] `corepack pnpm live:ops:pnl-closeout -- --env-file <운영-env-path> --market KRW-BTC --strategy-id live_ops_cleanup_probe --json`
        명령이 추가되고, 실제 주문 API나 Telegram provider를 호출하지 않는다.
  - [x] runner는 fresh clean reconcile, balance snapshot, strategy position/fill 요약, 최신 reference price, 기존 PnL history만으로
        `pnl_snapshots` row를 계산하며 `payload_json.status=CALCULATED`, `source=live_ops_pnl_closeout_preflight`,
        `sourceFingerprint`를 저장한다.
  - [x] `captured_at + strategy_id + market + sourceFingerprint` 기준 advisory lock/SELECT/INSERT 순서로 append-only idempotency를 보장한다.
  - [x] open order, 잔량 미확인 open order, mismatch/manual review, stale reconcile, 최신 PnL status 미완료, cleanup/global/aggregate
        not-ready PnL, 체결 이력 또는 BTC 잔고 대비 position snapshot 결측/0수량, position 수량 대비 BTC balance row 결측/수량 불일치,
        양수 position 평균단가 0, stale/결측 기준가는 새 PnL row 없이 blocked result로 닫는다.
  - [x] production reconcile provider도 잔량이 null인 open order를 미체결 주문으로 집계해 runner와 live readiness가 같은 source 기준으로
        차단한다.
  - [x] 같은 reconcile run 안의 중복 balance row는 currency별 최신 snapshot만 closeout 입력으로 사용한다.
  - [x] production `live:ops` preflight는 PnL 결측 또는 stale `CALCULATED` row를 만나면 runner를 자동 호출하고 provider를 다시 읽는다.
        최신 row가 PARTIAL/manual-review/status 미완료이면 자동 row로 가리지 않고 기존 loss guard 차단을 유지한다.
  - [x] runbook, runtime config, reliability, feature requirements, source scan path, active plan이 새 CLI와 자동 refresh invariant를 설명한다.
  - [x] 관련 unit tests, soak closeout source-path tests, `corepack pnpm typecheck`, `./scripts/verify docs`, `./scripts/verify`,
        `git diff --check`가 통과한다.

### Sub PR 16: attach read-only 원본 live-order-capable 표시 보존

- 목표: final PR review에서 발견된 attach 표시 gap을 닫는다. `live:ops:tui -- --attach ...`는 새 provider/broker/Telegram side effect를
  열지 않되, status source에 기록된 원본 foreground `liveOrderCapable` 값은 TUI/JSON summary에 그대로 보여준다.
- 제외 범위:
  - attach 화면에서 신규 실주문 submit/cancel, provider boot, Telegram dispatch를 시작하는 변경.
  - TUI control daemon/socket protocol 추가.
- DnD:
  - [x] non-fixture attach loader가 source summary의 `liveExecution.liveOrderCapable`을 `false`로 덮어쓰지 않는다.
  - [x] attach read-only 여부는 실행 형태/필요 조치로 구분하고, 원본 실주문 가능 여부 표시는 유지한다.
  - [x] attach source의 `liveExecution.liveOrderCapable`이 boolean이 아니면 문자열 truthy 오표시를 막기 위해 fail-closed 한다.
  - [x] 관련 unit test, 문서 검증, `git diff --check`, `corepack pnpm typecheck`, `./scripts/verify`가 통과한다.

### Sub PR 17: 24/7 자동 매수/매도 DnD와 운영 contract

- 목표: cleanup canary와 진짜 24/7 자동매매의 gap을 문서와 DnD로 명확히 닫는다.
- 제외 범위:
  - 코드 구현, DB migration, live order side effect.
  - 수익 보장, 투자 자문, BTC 외 market, budget 확대.
- DnD:
  - [x] `docs/FEATURE_REQUIREMENTS.md`에 `live:ops:daemon` 24/7 entry/exit acceptance criteria가 있다.
  - [x] `docs/runbooks/live-ops-24x7-autonomous.md`가 config/env만으로 실행하는 운영 명령, entry/exit DnD, strategy 교체성,
        중지 기준을 설명한다.
  - [x] `docs/RUNTIME_CONFIG.md`, `docs/RELIABILITY.md`, `docs/SECURITY.md`, product spec, docs/runbook index/context map이
        cleanup canary와 24/7 daemon을 구분한다.
  - [x] DnD가 실행 전 fixture/evidence 파일 요구를 금지하고 runtime 자동 artifact 생성을 요구한다.
  - [x] 문서 검증과 `git diff --check`가 통과한다.

### Sub PR 18: 24/7 strategy registry와 entry/exit policy core

- 목표: production allowlist strategy를 cleanup probe와 분리하고, 유명 투자 원칙에서 가져온 추세추종, 평균회귀, 리스크 우선,
  현금 보유, 매도 우선 원칙을 deterministic rule 조합으로 구현한다.
- 제외 범위:
  - broker submit, daemon loop, DB migration.
  - LLM/뉴스/SNS 기반 주문 판단.
- DnD:
  - [x] strategy interface가 entry/exit 후보 생성과 설명 metadata를 분리한다.
  - [x] strategy는 broker, Upbit client, DB, Telegram을 직접 호출하지 않는다.
  - [x] allowlist registry는 동적 import/임의 path/원격 plugin을 거부한다.
  - [x] 보유 포지션이 있으면 exit evaluation plan이 entry보다 먼저 나온다.
  - [x] exit rules는 take profit, stop loss, trailing stop, max holding time, risk reduction을 독립 rule로 가진다.
  - [x] entry rules는 조건 미충족 시 HOLD evidence를 남긴다.
  - [x] 관련 unit tests, typecheck, docs verify, `./scripts/verify`, `git diff --check`가 통과한다.

### Sub PR 19: position lifecycle와 SELL 실행 경계

- 목표: `FLAT -> ENTERING -> OPEN -> EXITING -> CLOSED` lifecycle과 `SELL + LIMIT + POST_ONLY` execution guard를 production live ops에
  연결한다.
- 제외 범위:
  - 시장가 매도, hard-stop 자동 청산, budget 확대.
- DnD:
  - [x] 보유 수량 이하 SELL intent만 exit runtime 경계로 전달된다.
  - [x] SELL 후보는 entry runtime으로 우회하지 않고 `exit_cost_model` evidence와 RiskGate evidence를 자동 생성한다.
  - [x] SELL 후보의 긴 strategy decision key는 Upbit-safe `ops-` attempt id로 낮추고 원본 decision key는 metadata에 보존한다.
  - [x] `SELL + LIMIT + POST_ONLY`, `position_effect=REDUCE|EXIT`, exit reason/rule, position scope가 없으면 exit runtime 호출 전에 차단한다.
  - [x] exit runtime 결과가 불확실하면 manual review summary로 수렴한다.
  - [x] 관련 unit/integration tests, typecheck, `./scripts/verify`, `git diff --check`가 통과한다.

### Sub PR 20: live:ops daemon loop와 24시간 summary

- 목표: 한 줄 명령으로 24/7 loop를 실행하고, entry/exit/HOLD/BLOCK/manual-review를 반복 평가하며 24시간 summary를 자동 산출한다.
- 제외 범위:
  - final main PR merge.
- DnD:
  - [x] `corepack pnpm live:ops:daemon -- --config <path> --env-file <path> --tui`가 production loop를 시작한다.
  - [x] 실행 전 fixture manifest, hand-written evidence, 수동 JSONL 후보 파일이 필요 없다.
  - [x] `--fixture-smoke --duration-ms 1000` smoke가 외부 provider/order side effect 없이 loop contract를 검증한다.
  - [x] loop는 success/HOLD/BLOCK/manual-review/transient failure별 sleep/backoff 정책을 가진다.
  - [x] entry/exit open order는 bounded cancel/requote 또는 manual review로 수렴한다.
  - [x] terminal 확인 실패, partial fill, untracked fill은 신규 주문 차단과 manual review evidence를 만든다.
  - [x] TUI/Telegram/status가 보유/매도 판단 이유와 필요한 조치를 한국어로 표시한다.
  - [x] 24시간 summary가 crash, unhandled rejection, duplicate order, reconcile mismatch, untracked fill, live order cleanup failure counter를
        자동 집계한다.
  - [x] 관련 script tests, typecheck, `./scripts/verify`, `git diff --check`가 통과한다.

### Sub PR 21: final review drain runtime guard 보강

- 목표: final main PR review에서 발견된 24/7 자동매매 차단 항목을 실제 runtime invariant와 CLI contract로 닫는다.
- 제외 범위:
  - budget 상한 확대, BTC 외 market 활성화, 시장가/best order, 수동 증적 파일 또는 fixture manifest 요구.
  - final main PR merge.
- DnD:
  - [x] `autonomous_24x7` strategy는 포지션 snapshot 결측을 0수량 무포지션으로 보정하지 않고 `BLOCK`으로 fail-closed 한다.
  - [x] `autonomous_24x7` strategy는 비용 차감 마진, 추세 강도, 평균회귀 할인 피처를 `requiredFeatures`로 선언하고, feature snapshot 실패 시
        주문 후보 없이 차단된다.
  - [x] SELL 후보도 BUY와 동일하게 kill switch와 reconcile freshness guard를 통과해야 exit runtime/broker side effect 경계가 열린다.
  - [x] production CLI config contract는 정적 allowlist 안의 `autonomous_24x7` 운영 JSON을 허용하고, 임의 strategy path나 unknown key는
        계속 차단한다.
  - [x] `STRATEGY_PAUSED` kill switch state는 strategy evaluation 차단으로만 해석하고 전역 신규 주문 차단으로 낮추지 않는다.
  - [x] preflight PnL closeout은 주입된 기준가도 market heartbeat timestamp 기준 freshness를 통과해야 CALCULATED row를 만들 수 있다.
  - [x] 관련 unit/script tests, `corepack pnpm exec tsc --noEmit`, `./scripts/verify docs`, `./scripts/verify`, `git diff --check`가 통과한다.

### Sub PR 22: daemon/SELL final review runtime 보강

- 목표: final main PR review에서 추가로 발견된 daemon status, Telegram startup 반복, SELL post-submit status gap을 runtime invariant로 닫는다.
- 제외 범위:
  - budget 상한 확대, BTC 외 market 활성화, 시장가/best order, 수동 증적 파일 또는 fixture manifest 요구.
  - final main PR merge.
- DnD:
  - [x] `live:ops:daemon`은 성공 tick 뒤 실패 tick이 발생해도 같은 status file에 `transient_failure`와 최신 counters/error를 즉시 기록한다.
  - [x] daemon 반복 실행은 startup Telegram 후보를 매 idle tick마다 다시 만들지 않고, 첫 성공 tick 이후 runtime config에서 startup alert를
        비활성화한다.
  - [x] SELL submit 이후 `getOrder` poll 오류는 broker order id와 submitted order evidence를 보존한 `MANUAL_REVIEW_REQUIRED` 결과로 닫는다.
  - [x] SELL `FILLED`와 `CANCELED_FOR_REQUOTE`/`exit_requote_ready` 상태는 generic pending이 아니라 private read/reconcile/PnL status 확인
        대상으로 포함된다.
  - [x] 관련 unit/script tests, `corepack pnpm exec tsc --noEmit`, `./scripts/verify docs`, `./scripts/verify`, `git diff --check`가 통과한다.

### Sub PR 23: autonomous analysis/runtime final review 보강

- 목표: final main PR review에서 추가로 발견된 autonomous 24/7 분석 차단, BUY runtime evidence, daemon attach/status, SELL 재호가/terminal cancel gap을 닫는다.
- 제외 범위:
  - budget 상한 확대, BTC 외 market 활성화, 시장가/best order, 저장소 밖 strategy code, 수동 증적 파일 또는 fixture manifest 요구.
  - final main PR merge.
- DnD:
  - [x] production CLI analysis는 `autonomous_24x7` policy를 cleanup 전용 BLOCK으로 닫지 않고, broker guard 뒤 private read preflight로 position context를 만든다.
  - [x] autonomous BUY intent는 preflight 기반 CostModel/RiskGate/runtime evidence를 갖춘 뒤 entry runtime으로 전달된다.
  - [x] autonomous BUY runtime identifier는 원본 strategy decision key를 직접 쓰지 않고 preflight tick scope를 포함한 `ops-` attempt id로 낮춘다.
  - [x] autonomous BUY Cost/Risk evidence 검증은 원본 decision key가 아니라 runtime `ops-` attempt id와 일치한다.
  - [x] autonomous BUY 제출 성공은 bounded fill/cancel closeout으로 닫는다. FILLED면 entry fill artifact를 남기고, no-fill/cancel이면 다음 tick 재호가로 넘긴다.
  - [x] FILLED entry closeout이 없는 신규 autonomous BUY reservation은 예산 선점 evidence일 뿐 strategy-owned position으로 승격하지 않는다.
  - [x] production execution은 analysis 단계 preflight를 broker 제출 근거로 재사용하지 않고, private provider가 있으면 제출 직전 preflight를 다시 읽는다.
  - [x] autonomous SELL intent의 position scope는 제출 직전 fresh private preflight의 strategy-owned scope와 일치해야 broker로 전진한다.
  - [x] feature provider가 비어 있는 production public tick에서도 기준가 대비 실제 edge가 있으면 entry 후보를 만들 수 있지만, tight spread만으로는 BUY 후보를 만들지 않는다.
  - [x] 지갑 BTC 잔고는 FILLED entry closeout과 strategy reservation 소유 기록 없이는 `autonomous_24x7` 포지션으로 간주하지 않고 BLOCK으로 닫는다.
  - [x] requested quantity가 없는 구형 reservation은 wallet 관측값과 reserved notional/current price로 strategy-owned 수량을 복원한다. 단, FILLED SELL closeout 뒤에는 수동 BTC로 되살리지 않는다.
  - [x] FILLED autonomous SELL closeout은 runtime이 저장소 밖 artifact로 자동 기록하고 strategy-owned 수량에서 차감해, 종료된 reservation이 수동 BTC를 다시 소유한 것처럼 보이지 않게 한다.
  - [x] FILLED SELL cleanup은 BUY lot을 FIFO로 소진하며, 완전 청산된 과거 BUY lot의 평균단가는 새 포지션 평균 진입가에서 제외한다.
  - [x] autonomous position high-water state는 tick 간 보존되어 trailing stop이 현재 tick의 `max(entry,current)` 보정으로 무력화되지 않는다.
  - [x] autonomous analysis/execution preflight PnL provider와 PnL closeout runner는 cleanup probe scope가 아니라 `live_ops_autonomous_24x7_core` scope를 사용한다.
  - [x] autonomous scope PnL provider는 해당 scope row가 없을 때 global/aggregate row를 재사용하지 않고, 같은 scope closeout runner가 계산하게 둔다.
  - [x] autonomous PnL closeout은 DB position row가 없더라도 같은 preflight tick의 artifact-owned position snapshot을 원가 source로 주입할 수 있다.
        수동 BTC가 같은 지갑에 섞여도 strategy-owned 수량만 주입한다.
  - [x] FILLED autonomous SELL closeout artifact는 matched entry average price, entry cost notional, realized PnL을 기록하고 원가 basis가 없으면 manual review로 닫는다.
  - [x] 25,000 KRW risk-reduction 기준보다 작은 strategy-owned 보유분도 take-profit/stop-loss/trailing/max-holding 조건이면 SELL 후보를 만든다.
  - [x] daemon status file의 top-level `latestSummary`는 `live:ops:tui --attach` source로 읽힌다.
  - [x] daemon status file의 top-level `transient_failure`는 attach 화면에서 stale `latestSummary`보다 우선해 blocked 상태로 표시된다.
  - [x] daemon tick status payload도 실제 `statusFilePath`를 보존한다.
  - [x] SELL 재호가 runtime identifier는 같은 strategy decision key라도 preflight tick scope가 다르면 달라진다.
  - [x] 이미 terminal cancel/no-fill로 확인된 SELL은 두 번째 cancel 요청 없이 재호가 대기 또는 수동 점검으로 닫는다.
  - [x] 관련 unit/script tests, `corepack pnpm exec tsc --noEmit`, `./scripts/verify docs`, `./scripts/verify`, `git diff --check`가 통과한다.

### Sub PR 24: final live execution ownership guard 보강

- 목표: final main PR review에서 발견된 SELL 제출 직전 strategy ownership 오인 위험을 닫는다.
- 제외 범위:
  - 수동 BTC 자동 매도, strategy ownership 없는 aggregate/account snapshot fallback, final main PR merge.
- DnD:
  - [x] SELL 제출 직전 position snapshot은 exchange, market, `strategyId`가 명시적으로 같은 경우에만 strategy-owned 수량으로 인정한다.
  - [x] `strategyId` 없는 aggregate/account snapshot의 generic 수량 alias는 자동 SELL 근거가 되지 않는다.
  - [x] CLI risk snapshot은 autonomous ownership preflight가 확인한 owned quantity만 `strategyId`와 `strategy_owned_quantity`로 전달한다.
  - [x] 관련 live execution/script tests, `corepack pnpm exec tsc --noEmit`, `git diff --check`, `./scripts/verify`가 통과한다.

### Sub PR 25: daemon startup Telegram retry 보강

- 목표: startup Telegram alert가 provider 실패 또는 partial failure tick에서 소비되어 이후 복구 알림을 놓치는 문제를 닫는다.
- 제외 범위:
  - Telegram credential 변경, 알림 채널 추가, final main PR merge.
- DnD:
  - [x] startup alert는 `telegramAlert.ready=true`인 tick 뒤에만 consumed 처리된다.
  - [x] startup Telegram 실패/partial failure tick은 다음 tick에서 startup alert를 다시 계획한다.
  - [x] 수동 evidence 파일 없이 daemon fixture smoke가 3 tick 이상 startup retry contract를 검증한다.
  - [x] 관련 script tests, daemon fixture smoke, `corepack pnpm exec tsc --noEmit`, `git diff --check`, `./scripts/verify`가 통과한다.

### Sub PR 26: daemon status terminal record 보강

- 목표: daemon 첫 실패와 제한 실행 완료 상태가 status file에 남지 않아 24/7 운영 attach가 stale 상태를 보는 문제를 닫는다.
- 제외 범위:
  - status 파일 외부 포맷 대규모 변경, fixture smoke 기본 artifact 생성 강제, final main PR merge.
- DnD:
  - [x] 첫 daemon tick이 `loadInputs()` 단계에서 실패해도 non-fixture 기본 status file에 `transient_failure` payload를 기록한다.
  - [x] `--max-ticks`/`--duration-ms` 제한 실행이 정상 종료되면 status file도 `completed` terminal payload로 갱신한다.
  - [x] fixture smoke는 `--status-file`을 명시하지 않는 한 기본 운영 status file을 만들지 않는다.
  - [x] 관련 script tests, daemon fixture smoke, `corepack pnpm exec tsc --noEmit`, `git diff --check`, `./scripts/verify`가 통과한다.

### Sub PR 27: autonomous exit/risk/feature guard 보강

- 목표: final main PR review에서 발견된 autonomous exit 우선순위, risk-reducing SELL, required feature 계약 누락을 닫는다.
- 제외 범위:
  - budget 상한 확대, BTC 외 market 활성화, 시장가/best order, final main PR merge.
- DnD:
  - [x] `autonomous_24x7` position snapshot은 음수 수량과 보유 중 평균단가 결측을 `BLOCK`으로 닫는다.
  - [x] 보유 포지션이 있으면 stop-loss, max-holding, trailing stop, take-profit exit가 risk reduction보다 먼저 평가된다.
  - [x] required entry feature 결측은 ready HOLD가 아니라 operator-visible `BLOCK`으로 닫힌다.
  - [x] daily/weekly loss, MDD, consecutive loss, 노출 초과 같은 신규 BUY 차단 사유는 risk-reducing SELL을 막지 않는다.
  - [x] `position_effect`와 `positionEffect` alias 모두 risk-reducing SELL intent로 인정한다.
  - [x] `trend_strength_bps`, `mean_reversion_discount_bps`는 기본 M11 feature calculator와 feature quality 설계 문서 계약에 모두 반영된다.
  - [x] 관련 feature/live execution/decision tests, `corepack pnpm exec tsc --noEmit`, `./scripts/verify docs`, `git diff --check`, `./scripts/verify`가 통과한다.

### Sub PR 28: runner closeout 문서 정합성

- 목표: active exec plan이 실제 subPR #24-#27과 final PR review-drain 운영 절차를 최신 상태로 반영하게 한다.
- 제외 범위:
  - runtime code 변경, config/env 변경, final main PR merge.
- DnD:
  - [x] active exec plan에 subPR #24-#27 DnD와 runner closeout 절차가 기록된다.
  - [x] "final review drain 남음" 같은 stale 상태 문구를 final PR 최신 head에서 재확인해야 하는 runner 종료 절차로 바꾼다.
  - [x] 문서 전용 변경이며 `./scripts/verify docs`, `git diff --check`, `./scripts/verify`가 통과한다.

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
- 2026-06-15: guarded manifest 파일 자체도 저장소 밖이어야 하며, source/security scan은 runtime source path
  `src/runtime/live-ops-config.ts src/runtime/live-ops-config src/runtime/live-ops-decision-policy.ts
  src/runtime/live-ops-decision-policy src/runtime/live-ops-live-execution.ts src/runtime/live-ops-live-execution
  src/runtime/live-ops-analysis-decision.ts src/runtime/live-ops-analysis-decision
  src/application/live-autonomous-entry-runtime/service.ts
  src/infrastructure/upbit/private-client.ts src/infrastructure/upbit/private-client/client.ts
  src/infrastructure/upbit/private-mappers.ts
  scripts/run-live-ops.mjs scripts/run-live-ops-support.mjs scripts/run-live-ops-pnl-closeout.mjs
  scripts/run-live-ops-pnl-closeout-support.mjs config` 전체 범위의 실제 `rg -n` 실행 증거여야 한다.
  validator/runbook 자체의 정밀 regex 문구가 운영 source scan 결과에 섞이면 manifest evidence와 실제 출력이 어긋나므로 docs와
  closeout validator 파일은 필수 empty-match 범위에서 제외한다. 금지 scope/시장가/futures/leverage 단어 자체는 guard와 문서에
  정상 등장하므로, source scan은 broad term 대신 위험 toggle `true`와 raw 주문 payload alias를 찾는 정밀 패턴으로 제한한다.
  중첩 artifact summary와 `raw_provider_payload`/`raw_order_detail` 필드도 차단한다.
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
- 2026-06-20: Sub PR 16으로 attach read-only 화면은 새 주문 side effect를 열지 않는다는 실행 형태를 표시하되, 원본 foreground status의
  live-order-capable 값은 덮어쓰지 않고 그대로 보여주도록 보강한다. review drain 보강으로 attach source의 `liveOrderCapable`이 boolean이
  아니면 정상 dashboard로 낮추지 않고 fail-closed 한다.
- 2026-06-18: cleanup budget reservation은 attempt id 파일 생성 전에 같은 날짜 lock을 잡고, lock 안에서 reservation aggregate와 open
  position snapshot을 다시 합산해 일일 자동 주문 예산을 선점한다.
- 2026-06-18: daily reservation lock은 `leaseId`/`acquiredAt`/`expiresAt`/`pid`와 owner boot id/process start time lease metadata를
  기록한다. acquire는 temp 파일에 완성된 lease JSON을 쓴 뒤 hard link로 lock path를 선점한다. fresh lock은 동시 실행 보호로 유지하고,
  owner fingerprint가 사라진 만료 stale lock만 hard-link claim/CAS 절차로 회수해 crash/reboot 이후 같은 날짜 운영이 영구 차단되지 않게 한다.
  CAS는 target을 비우기 전에 fingerprint, inode, link count를 확인한다. crash로 남은 같은 inode orphan claim/tmp hard link는 CAS 전에
  정리해 nlink 고착을 풀 수 있다. 기존 malformed lock과 필수 lease field가 빠진 valid JSON lock은 파일 mtime 기준 TTL 이후 같은 CAS 절차로
  회수한다. owner boot id 또는 process start time을 lock 생성 시점에 기록할 수 없으면 lock 획득을 중단한다. owner 조회가 권한/환경 문제로
  불확실하면 active owner로 fail-closed 하고, zombie 상태가 확인되면 stale owner로 본다.
- 2026-06-19: final review guard 보강은 key scope guard를 preflight private read 앞에 둔다. cancel 요청 이후 terminal poll 실패도
  redacted cleanup artifact로 남기고, post-cleanup status summary의 budget used는 현재 durable reservation 반영값을 하한으로 사용한다.
- 2026-06-19: Sub PR 13의 reconcile freshness, daily budget day, cleanup probe 날짜 scope는 market heartbeat가 아니라 실행 wall clock을
  기준으로 계산한다. heartbeat는 market data 관측 evidence로 보존하되 자정 경계의 attempt id와 preflight readiness 판단을 대신하지 않는다.
- 2026-06-19: Sub PR 14는 closeout source/security scan의 empty-match 필수 term에서 generic `market`과 정상 설정에서 나오는
  `market_order`를 제외한다. 운영 source scan은 정상 market config/doc 문자열 때문에 실패하지 않도록 `"?ord_type"?\s*[:=]\s*"?price`,
  `"?ord_type"?\s*[:=]\s*"?market`, `"?ord_type"?\s*[:=]\s*"?best`, `"?order_type"?\s*[:=]\s*"?(market|MARKET)`,
  `시장가`처럼 실제 주문 payload/artifact 경계에 가까운 term을 사용한다.
- 2026-06-19: production preflight PnL loss snapshot은 OK row라도 `CALCULATED` status와 provider read 완료 후 시각 기준 30초
  freshness를 통과해야 손실 증거로 쓰며, status 누락, read-level `OK`, job/reconcile 계층 완료 status는 not-ready로 본다. preflight
  시작 직후 쓰인 PnL row를 위해 1초 이내 future skew만 허용하고, cleanup probe의 실제 key 날짜는 runtime preflight wall clock에서 확정한다.
- 2026-06-19: Sub PR 14 review drain 보강으로 cleanup runtime evidence 보정은 기존 cost/risk 차단값을 보존한다. terminal cancel/no-fill
  closeout은 stale `CALCULATED` PnL row를 수동 점검으로 승격하지 않지만, 계산 미완료 PnL status는 정상 closeout으로 낮추지 않는다.
- 2026-06-19: Sub PR 14 review drain 2차 보강으로 cleanup runtime evidence 보정은 같은 후보의 분석일 key를 runtime 날짜 key로
  바꾸는 경우에만 `order_intent`를 갱신한다. 다른 가격/수량/마켓 stale approval은 현재 후보 approval로 재작성하지 않고
  broker guard가 차단하게 둔다. PnL freshness는 provider read 완료 후 시각을 기준으로 판단한다. closeout source/security scan은
  단일따옴표 주문 payload, `/v1/withdraws`, raw `postgres://user:pass@...`/`postgresql://user:pass@...` credential URL,
  `src/infrastructure/upbit/live-broker/service.ts`도 필수 coverage로 본다.
- 2026-06-19: Sub PR 14 review drain 3차 보강으로 runtime 날짜 정규화가 이미 보존된 `metadata.analysis_idempotency_key`를
  다시 runtime key로 덮어쓰지 않게 한다. closeout source/security scan은 `"authorization": "Bearer ..."`와
  `authorization: 'Bearer ...'`처럼 key/value에 따옴표가 붙은 raw bearer literal도 필수 coverage로 본다. runbook의 source scan
  path operand는 validator의 `config/live-ops.example.json`, `config/live-ops.env.example` 요구값과 정확히 맞춘다.
- 2026-06-19: Sub PR 14 review drain 4차 보강으로 source scan 필수 path operand에 Upbit JWT 생성 module
  `src/infrastructure/upbit/private-client/auth.ts`와 private response normalization 경계 `src/infrastructure/upbit/private-mappers`를
  추가한다. Telegram dispatcher가 legacy `TELEGRAM_BOT_TOKEN` env fallback을 지원하므로 `TELEGRAM_BOT_TOKEN=123:...` literal도
  raw token source scan 필수 coverage로 본다.
- 2026-06-19: Sub PR 14 review drain 5차 보강으로 Upbit private client의 query/body param 배열 표현
  `{ key: "ord_type", value: "price|market|best" }`도 금지 주문 payload source scan 필수 coverage로 본다.
- 2026-06-19: Sub PR 14 review drain 6차 보강으로 한국어 `시장가` coverage를 복원하되, 정상 차단/수동검토 문구를
  빈 출력 위반으로 만들지 않도록 `시장가[^\r\n]*(허용|활성|enabled|true)` 위험 문구 패턴으로 제한한다.
- 2026-06-19: Sub PR 14 review drain 7차 보강으로 file budget reservation은 실제 reserve 시점의 wall clock 날짜로
  `reservedAt`과 일일 사용량을 확정한다. cleanup runtime evidence 보정은 기존 CostModel snapshot 객체가 malformed/stale이면
  승인 기본값을 채우지 않고 guard 차단으로 남긴다.
- 2026-06-19: Sub PR 14 review drain 8차 보강으로 production preflight가 확정한 cleanup runtime `observedAt`과 날짜 key를
  live execution submit 직전 wall clock으로 다시 정규화하지 않는다. UTC 자정 경계에서 Cost/Risk `order_intent` evidence와
  entry runtime request가 서로 다른 날짜 key를 갖지 않도록 preflight 시각을 intent metadata에 보존한다.
- 2026-06-19: Sub PR 14 review drain 9차 보강으로 cleanup runtime evidence 보정은 기존 RiskGate snapshot 객체가 partial/malformed면
  `approved=true`, `ALLOW`, `PASS` 같은 승인 기본값을 합성하지 않는다. closeout source/security scan 필수 operand에는
  `src/runtime/live-ops-*.ts` public entry 파일도 포함해 runtime barrel 파일의 raw secret/금지 주문 literal 누락을 막는다.
- 2026-06-19: Sub PR 14 review drain 10차 보강으로 첫 cleanup 전 `live_ops_cleanup_probe` PnL row가 없으면 global/aggregate
  `CALCULATED` snapshot을 손실 guard fallback으로 허용한다. 단 cleanup 전용 PnL row가 생긴 뒤에는 그 scope를 우선해 not-ready row가
  오래된 global 계산 완료 row에 가려지지 않게 한다. closeout source/security scan에는 Upbit private barrel entry 파일과
  `accessKey`/`secretKey` property literal 하드코딩 패턴도 필수 coverage로 추가한다.
- 2026-06-19: Sub PR 14 review drain 11차 보강으로 cleanup 전용 PnL row가 아직 없을 때는 fallback row 안에서 최신 `PARTIAL`
  snapshot보다 `CALCULATED` snapshot을 먼저 선택한다. cleanup 전용 row가 생긴 뒤에는 계속 cleanup scope를 최우선으로 본다.
  closeout source/security scan에는 `order_type`/`orderType`의 `PRICE`/`BEST` 표현, raw compact JWT literal과 `jwt` field,
  snake_case `access_key`/`secret_key` property literal 하드코딩 패턴도 필수 coverage로 추가한다.
- 2026-06-20: Sub PR 15 review drain 보강으로 production reconcile provider와 PnL closeout runner가 잔량 null open order를 같은 미체결
  주문으로 집계한다. runner는 position 수량과 거래소 BTC balance 수량이 다르거나 양수 position 평균단가가 0이면 원가/보유 source 불일치로
  보고 `CALCULATED` PnL snapshot을 만들지 않는다.
- 2026-06-20: Sub PR 21 final review drain 보강으로 `autonomous_24x7`은 position snapshot 결측을 무포지션으로 보정하지 않는다.
  required feature가 없거나 snapshot이 실패하면 주문 후보를 만들지 않고 차단한다. SELL 후보도 kill switch와 reconcile freshness guard를
  통과해야 exit runtime으로 넘어간다. CLI contract는 정적 allowlist의 `autonomous_24x7` 설정만 허용하며, `STRATEGY_PAUSED`는 전역
  신규 주문 차단이 아니라 strategy evaluation pause로 해석한다. PnL closeout의 주입 기준가는 market heartbeat timestamp freshness를
  통과해야 한다.
- 2026-06-21: Sub PR 22 final review drain 보강으로 daemon 실패 tick은 status file을 최신 실패 payload로 갱신한다. daemon은 첫 성공
  tick 이후 startup Telegram alert를 반복 생성하지 않는다. SELL exit runtime은 post-submit poll 오류를 broker order id가 있는 수동 점검
  결과로 닫고, SELL 체결/재호가 상태는 private read/reconcile/PnL status 확인 대상으로 포함한다.
- 2026-06-21: Sub PR 23 final review drain 보강으로 production CLI analysis는 `autonomous_24x7` policy를 cleanup 전용 BLOCK으로
  닫지 않고 private read preflight position context로 entry/exit를 평가한다. autonomous BUY는 CostModel/RiskGate/runtime evidence를
  붙여 entry runtime으로 전달하고 bounded fill/cancel closeout으로 닫는다. daemon status `latestSummary` attach, tick payload
  `statusFilePath`, SELL 재호가 runtime identifier scope, terminal cancel no-fill 재취소 방지를 추가한다. 추가 review drain으로
  public tick bootstrap feature, strategy reservation 기반 position ownership, 소액 포지션 take-profit/stop-loss/trailing/max-holding
  exit를 보강해 지갑 수동 BTC 자동 매도와 영구 HOLD를 차단한다.
- 2026-06-20: Sub PR 23 추가 review drain 보강으로 autonomous BUY도 preflight tick scope를 포함한 `ops-` attempt id를 사용한다.
  production execution은 analysis preflight를 제출 근거로 재사용하지 않고 private provider preflight를 다시 읽는다. 구형 reservation은
  wallet 관측값으로 소유 수량을 복원하고, FILLED SELL cleanup은 BUY lot을 FIFO로 차감해 닫힌 매수분 평균단가를 제외한다. autonomous PnL
  closeout은 같은 tick의 artifact-owned position snapshot을 DB position fallback으로 주입한다.
- 2026-06-20: Sub PR 23 추가 review drain 2차 보강으로 autonomous BUY evidence 검증은 runtime `ops-` key를 사용하고, autonomous SELL은
  fresh preflight의 strategy-owned position scope와 intent scope가 일치할 때만 제출된다. SELL fill closeout은 entry 원가와 realized PnL을
  artifact에 기록하며, mixed wallet에서는 strategy-owned 수량만 PnL snapshot으로 주입한다.
- 2026-06-20: Sub PR 23 추가 review drain 3차 보강으로 autonomous BUY reservation은 FILLED entry closeout이 있어야 open lot으로 승격된다.
  production entry runtime은 post-only BUY를 bounded fill/cancel closeout으로 닫고, no-fill reservation과 SELL 뒤 닫힌 legacy reservation은
  수동 BTC를 strategy-owned 포지션으로 되살리지 않는다. autonomous PnL scope 조회는 global/aggregate row로 fallback하지 않는다.
- 2026-06-21: Sub PR 24 final review drain 보강으로 SELL 제출 직전 position snapshot은 명시적 `strategyId`가 같은 strategy-owned
  수량만 인정한다. `strategyId` 없는 aggregate/account snapshot의 generic 수량은 수동 BTC나 다른 전략 보유분을 포함할 수 있으므로 자동
  SELL 근거가 되지 않는다.
- 2026-06-21: Sub PR 25 final review drain 보강으로 startup Telegram alert는 provider 실패나 partial failure tick에서 소비되지 않는다.
  owner chat 전송이 성공한 tick 뒤에만 startup alert를 suppress해 24/7 daemon 시작 알림이 일시 장애에 묻히지 않게 한다.
- 2026-06-21: Sub PR 26 final review drain 보강으로 daemon은 첫 tick 실패도 status file에 기록하고, 제한 실행 정상 종료도 `completed`
  terminal payload로 남긴다. fixture smoke는 status file을 명시하지 않으면 기본 운영 status file을 만들지 않는다.
- 2026-06-21: Sub PR 27 final review drain 보강으로 autonomous position snapshot invalid 값은 무포지션 entry로 보정하지 않는다.
  exit rule은 risk reduction보다 손절/익절/트레일링/max-holding을 먼저 평가하고, 신규 BUY 차단용 손실/노출 한도 reason은
  risk-reducing SELL을 막지 않는다. 기본 M11 feature calculator와 feature quality 설계 문서가 `trend_strength_bps`,
  `mean_reversion_discount_bps` 계약을 공유한다.
- 2026-06-21: Sub PR 28 runner closeout 문서 보강으로 active exec plan은 Sub PR 24-27까지의 DnD와 final PR review-drain 종료 절차를
  기록한다. 이 subPR은 runtime 동작, 운영 config/env, credential, final main PR merge를 변경하지 않는다.

## 남은 이슈

- 실제 운영 credential, key scope evidence, operator arm evidence, redacted artifact 경로는 저장소 밖 운영 vault에 있어야 한다.
- 실제 주문 제출/취소 closeout은 저장소 밖 운영 config/env로 foreground `live:ops`를 실행한 뒤 자동 생성 artifact와 closeout manifest로
  검증한다.
- final main PR #218은 runner 규칙상 merge하지 않는다. 마지막 subPR이 mother에 merge된 뒤 최신 head 기준 GitHub checks, unresolved
  thread, Codex `+1` 또는 no-major-issues review를 다시 확인하고 결과를 `/home/lim/vaults/99_운영/seemirai-reviews/PR-218.md`에
  갱신한다.

## Main merge 이후 후속 개선 backlog

2026-06-23 기준 issue #206 main merge 이후 운영 점검에서 production DB에는 최근 market data가 정상 저장됐고, 최신 DB trade/orderbook
값으로 재계산한 entry feature와 status file의 `autonomous_24x7_entry_signal_weak` 판단값이 일치했다. 따라서 즉시 확인된 문제는
provider/broker arm 장애가 아니라 24/7 운영을 길게 가져가기 위한 관측성, feature 품질, 전략 보정, SELL 검증, 운영 화면, daemon 운영화
개선이다.

### Follow-up 01: live 판단 이력 DB 저장

- 목표: `live:ops`와 `live:ops:daemon`의 HOLD/BUY/SELL/BLOCK 판단을 status JSON에만 남기지 않고 DB에 append-only 또는 time-series로
  남긴다.
- 근거: 2026-06-23 점검에서 `strategy_signals`는 0건이었지만 status file에는 최신 `autonomous_24x7` HOLD 판단과 feature/threshold
  값이 존재했다. 운영자가 나중에 "왜 안 샀나", "왜 팔았나"를 DB에서 조회하려면 판단 이력이 durable해야 한다.
- DnD:
  - [ ] live decision tick마다 strategy id, market, decision kind, reason, feature snapshot, threshold, order intent count가 secret-free DB row로 저장된다.
  - [ ] HOLD 기록은 저장 폭주를 막기 위해 dedupe, sampling, bucket, retention 중 하나 이상의 정책을 가진다.
  - [ ] 저장 실패는 broker submit을 보정하거나 재시도 주문을 만들지 않고, TUI/status에 관측성 degraded 상태로 표시된다.
  - [ ] DB row에는 raw provider payload, credential, Telegram token, DB URL, Upbit JWT가 저장되지 않는다.
  - [ ] 관련 unit/integration/script smoke, `corepack pnpm typecheck`, `./scripts/verify`가 통과한다.

### Follow-up 02: DB-backed feature 강화

- 목표: production entry/exit 판단이 단일 public tick fallback에 머물지 않고 DB window에서 candle momentum, realized volatility,
  volume spike, depth slope, VWAP deviation, trade direction imbalance 같은 feature를 계산해 사용한다.
- 근거: 2026-06-23 최신 운영 tick은 `feature_source=live_ops_cli_public_tick_weak`, `trend_strength_bps=0`,
  `mean_reversion_discount_bps=3.916...`, `cost_adjusted_margin_bps=0`이었다. DB에는 최근 15분 `trades=150`,
  `orderbook_metrics=449`가 있었으므로 더 풍부한 feature를 계산할 수 있다.
- DnD:
  - [ ] live CLI/daemon이 DB window 기반 `autonomousFeatures`를 만들고 strategy에 전달한다.
  - [ ] feature freshness, 최소 sample 수, market mismatch, stale candle/orderbook window는 후보 생성 전 fail-closed 된다.
  - [ ] 기존 public tick fallback은 cold-start 또는 feature degraded 상태로 명시되고, fallback 사용 여부가 status/DB 판단 이력에 남는다.
  - [ ] M11 feature calculator와 live CLI feature key contract가 `trend_strength_bps`, `mean_reversion_discount_bps`,
        `cost_adjusted_margin_bps`를 동일 의미로 유지한다.
  - [ ] fixture manifest나 수동 evidence 파일 없이 운영 DB만으로 feature smoke를 재현할 수 있다.

### Follow-up 03: 전략 threshold calibration

- 목표: 실제 KRW-BTC 운영 DB window와 paper/live shadow 비교를 사용해 `autonomous_24x7` entry/exit threshold 후보를 보수적으로
  산출하고, config 변경 전후 기대 주문 빈도와 비용 차감 결과를 비교한다.
- 근거: 2026-06-23 제한 실행은 143 tick 모두 HOLD였고, 최신 tick은 `min_entry_margin_bps=10`,
  `mean_reversion_discount_bps=30`을 넘지 못했다. threshold를 무작정 낮추면 거의 모든 작은 눌림에 매수하는 전략이 되므로 calibration
  evidence가 필요하다.
- DnD:
  - [ ] 최근 운영 DB window에서 현재 threshold와 후보 threshold의 주문 후보 수, 예상 spread/cost, drawdown proxy를 비교한다.
  - [ ] calibration 산출물은 기본값을 즉시 바꾸지 않고 비활성 proposal 또는 별도 config patch로 남긴다.
  - [ ] threshold 후보는 최소 주문금액, 수수료, spread, slippage proxy, daily budget, max open position budget을 모두 차감한다.
  - [ ] 공격적 완화는 예상 비용 차감 마진이 음수이거나 drawdown proxy가 악화되면 자동 rejection으로 남긴다.
  - [ ] 검증 명령과 비교 결과가 PR 본문 또는 closeout 문서에 요약된다.

### Follow-up 04: SELL 경로 실운영 검증

- 목표: 자동전략이 실제로 소유한 BTC 포지션이 있을 때 stop-loss, take-profit, trailing stop, max holding time, risk reduction SELL
  판단과 post-only sell submit/cancel/requote closeout을 운영 경로에서 검증한다.
- 근거: 2026-06-23 reconcile에는 자동전략 소유 BTC 포지션이 없었고 `positions`도 비어 있어 SELL 분기는 운영 DB에서 아직 재현되지 않았다.
- DnD:
  - [ ] SELL은 strategy-owned position snapshot과 fresh private read preflight가 일치할 때만 후보를 만든다.
  - [ ] 수동 BTC, 다른 전략 포지션, generic account balance는 자동 SELL 근거로 쓰지 않는다.
  - [ ] SELL 후보는 kill switch, reconcile freshness, PnL freshness, open order, idempotency guard를 통과해야 submit된다.
  - [ ] SELL fill/cancel/requote 결과는 realized PnL, remaining position, reservation closeout, Telegram trade alert와 함께 확인된다.
  - [ ] SELL post-submit poll 실패는 broker order id가 있으면 수동 점검으로 닫고 중복 SELL을 만들지 않는다.

### Follow-up 05: TUI/status 문구 분리

- 목표: 운영 화면에서 "실주문 가능 여부"와 "이번 tick 주문 후보 존재 여부"를 분리해 broker/provider arm 문제와 전략 HOLD를 혼동하지 않게 한다.
- 근거: 2026-06-23 status file에서 broker guard는 ready이고 violations는 없었지만 주문 후보가 없어 `liveOrderCapable=false`,
  "실주문 가능: 아니오"처럼 보일 수 있었다. 이 문구는 operator에게 provider 미연결처럼 오해될 수 있다.
- DnD:
  - [ ] TUI/status는 provider/broker arm, key scope, live trading enabled, 이번 tick order intent count를 별도 필드와 한국어 문구로 표시한다.
  - [ ] 주문 후보 없음은 "브로커 불가"가 아니라 "이번 tick 후보 없음"으로 표시한다.
  - [ ] BLOCK, HOLD, ORDER_INTENT, submitted/canceled/manual review 상태가 서로 다른 색인과 필요 조치를 가진다.
  - [ ] attach read-only 화면은 원본 foreground status와 attach 실행 형태를 구분하되 live-order-capable 값을 덮어쓰지 않는다.
  - [ ] 관련 status/TUI snapshot 테스트와 script smoke가 통과한다.

### Follow-up 06: 24/7 daemon 운영 안정화

- 목표: `live:ops:daemon`을 제한 실행이 아니라 장기 운영 단위로 배치할 수 있게 process supervision, status retention, alerting,
  restart policy를 문서와 runtime 경계에서 정리한다.
- 근거: 2026-06-23 점검 대상 daemon은 143 tick을 성공 처리하고 제한 실행 종료로 `completed` terminal payload를 남겼다. 장기 운영에서는
  의도한 `completed`와 비정상 중단, transient failure, stale status file을 구분해야 한다.
- DnD:
  - [ ] duration/max tick 없는 24/7 실행과 제한 smoke 실행의 status 문구와 closeout 기준이 분리된다.
  - [ ] systemd 또는 tmux/supervisor 기준 runbook이 status file, log, restart, stop, emergency halt 절차를 포함한다.
  - [ ] daemon heartbeat stale, crash count, unhandled rejection, transient failure, duplicate order, reconcile mismatch가 alert 조건으로 연결된다.
  - [ ] status file rotation 또는 retention 정책이 있어 장기 실행 중 파일 비대화와 마지막 상태 유실을 막는다.
  - [ ] 재시작 후 daily budget reservation, open position, outstanding order, Telegram startup alert가 중복 side effect 없이 복구된다.
