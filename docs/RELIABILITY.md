# 신뢰성 기준

## 목적

Codex-native 운영은 Codex, Git, GitHub, shell command, 문서 상태를 연결한다. 이 문서는 반복 실행, 실패 복구, 중복 처리, 관측 가능성을 일관되게 적용하기 위한 기준이다.

## 기본 규칙

- 외부 side effect 전후로 현재 상태를 문서, GitHub issue/PR, commit message 중 적절한 위치에 남긴다.
- 재시도 가능 작업은 중복 실행 시 부작용이 없는지 먼저 판단한다.
- 모든 loop는 종료 조건과 최대 반복 기준을 가진다.
- command 실행 결과는 cwd, exit code, 핵심 stdout/stderr, duration을 요약할 수 있어야 한다.
- Codex sub-agent 작업은 파일 소유권과 DnD가 분명해야 한다.
- 상태 전이나 운영 규칙이 바뀌면 `docs/FEATURE_REQUIREMENTS.md` 또는 설계 문서를 함께 갱신한다.

## Idempotency 기준

- 같은 issue number와 repo는 같은 active 작업 흐름으로 수렴해야 한다.
- 이미 생성된 branch, worktree, PR은 검증 후 재사용하거나 명시적으로 정리한다.
- 같은 review comment/thread는 중복 처리하지 않는다.
- 같은 commit SHA는 같은 phase의 결과로 한 번만 기록한다.

## 복구 기준

- 중단 후 재개 시 `AGENTS.md`, `docs/README.md`, issue/PR 본문, 현재 branch, `git status`를 먼저 확인한다.
- dirty worktree가 발견되면 다음 단계로 넘어가지 않고 commit, cleanup, blocked 중 하나로 수렴시킨다.
- push 후 PR 생성 전 중단된 작업은 remote branch head를 확인한 뒤 PR 생성 또는 기존 PR 연결을 수행한다.
- merge conflict 중 중단된 작업은 conflict marker 상태를 다시 읽고 conflict resolution phase로 재개한다.
- Codex thread resume 실패 시 새 thread를 시작하려면 git clean 상태와 마지막 artifact 기반 prompt 재구성이 가능해야 한다.

## 관측 가능성 기준

- 장시간 작업 요약에는 issue, branch, worktree, PR URL, 검증 명령, 남은 리스크가 있어야 한다.
- 실패한 검증 로그는 다음 Codex prompt에 전달 가능한 수준으로 요약한다.
- review finding은 어떤 commit으로 처리됐는지 추적 가능해야 한다.

## Issue #196 production live ops 신뢰성 기준

- `live:ops` boot sequence는 env/config validation, redaction/logger, DB connection, migration/table readiness, TUI initial render,
  Upbit public/private probe, Telegram startup alert, market data freshness, reconcile/PnL/decision/exit readiness,
  live order capable 전환 순서로 진행한다.
- production path는 `SEEMIRAI_M22_*_READY` 같은 boolean env를 readiness로 사용하지 않는다. readiness는 DB schema, migration state,
  worker heartbeat, provider probe, market data freshness, reconcile/PnL/decision ledger 상태에서 계산한다.
- boot sequence가 broker 조립 전 실패하면 private client와 live broker를 만들지 않고 한국어 상태/원인/영향/필요 조치를 출력한다.
- broker 조립 이후 장애는 신규 주문 중지, reconcile/manual review, Telegram P0/P1, TUI 경고로 수렴한다.
- foreground TUI와 attach TUI는 같은 secret-safe summary renderer를 사용하되, attach TUI는 기존 status source를 읽는 read-only 경로로
  남긴다. attach 명령은 foreground boot sequence, Upbit public/private provider, live broker, cleanup lifecycle, Telegram dispatch를
  새로 시작하지 않는다. non-fixture attach source를 읽지 못하거나 필수 status summary 항목이 없으면 정상 dashboard를 합성하지 않고
  fail-closed 하며, foreground `live:ops` 명령의 `--attach` 인자는 성공 처리하지 않는다. 첫 화면은 DB readiness, worker 상태, 예산,
  필요 조치를 보여주고 credential/raw provider payload/raw config enum을 표시하지 않는다. TUI 종료 시 daemon 계속 실행/안전 종료/attach
  detach 정책은 후속 control lifecycle sub PR과 runbook에서 명시한다.
- DB readiness guard는 `schema_migrations`를 생성하거나 migration을 자동 적용하지 않는다. pending migration, missing table,
  unknown applied migration, checksum drift는 운영자가 migration apply 또는 schema drift 확인을 끝낼 때까지 live boot를 차단한다.
- market data collector는 허용 production market 밖 event를 DB write 전에 차단한다. stale/reconnect/disconnect status는 DB-backed
  audit/risk evidence로 저장하되, analysis/decision 및 신규 실주문 lifecycle로 전진시키지 않는다.
- analysis/decision pipeline은 market data 미준비와 feature 실패를 0값으로 보정하지 않는다. 해당 경우 strategy 평가를 열지 않고
  HOLD/차단 summary를 남기며, order intent가 없으면 live execution으로 전진하지 않는다.
- live execution adapter는 analysis summary와 order intent 수가 어긋나거나 복수 후보가 들어오면 broker runtime을 호출하지 않는다.
  단일 `BUY + LIMIT + post_only` 후보만 기존 `LiveAutonomousEntryRuntime` 요청으로 낮추며, budget reservation과 broker submit side
  effect는 하위 runtime이 반환한 attempt 결과로만 확정한다. 하위 runtime 예외는 제출 여부를 단정하지 않고 manual review summary로
  수렴한다.
- budget reservation은 attempt id 파일만으로 완료하지 않는다. 같은 날짜 reservation lock을 먼저 잡고, lock 안에서 현재 reservation
  집계와 open position snapshot을 합산해 일일 자동 주문 예산을 다시 확인한 뒤 attempt 파일을 만든다. lock이 busy이거나 예산 초과가
  확인되면 broker 호출 전 fail-closed 한다. lock 파일은 lease id, owner boot id, process start time을 포함하고 기본 5분 TTL이 지났더라도
  owner process fingerprint가 살아 있으면 회수하지 않는다. acquire는 temp 파일에 완성된 lease JSON을 쓴 뒤 hard link로 lock path를
  선점해 lock path에 부분 JSON이 노출되지 않게 한다. stale 회수와 release는 lock 파일을 먼저 quarantine path로 `rename`한 뒤 lease
  fingerprint를 재확인하는 CAS 절차로 수행해 다른 프로세스가 방금 만든 fresh lock을 지우지 않는다. fresh lock은 동시 실행 보호로 유지해 같은
  날짜 budget oversubscription을 막고, owner가 사라진 stale lock 또는 TTL이 지난 legacy malformed lock은 crash/reboot 이후 운영 복구를
  위해 제거할 수 있다.
- reconcile/PnL/status summary는 live execution 이후 같은 lifecycle에서 계산하되, fixture smoke에서는 private provider 조회를 수행하지
  않는다. open order, 예산 사용, 노출은 safe placeholder로 표시하고 PnL 결측은 0으로 보정하지 않고 `관측 대기`로 남겨 실제
  reconcile/PnL evidence 연결 전까지 운영자가 상태 의미를 오해하지 않게 한다.
- Telegram alert mapper는 startup, live order capable, 주문 제출, 차단, manual review event를 provider 호출 전 `LiveOpsAlertInput`으로
  낮춘다. fixture smoke는 alert plan만 만들고 provider 전송 0회를 유지하며, 실제 dispatch 실패는 주문/리스크 commit을 되돌리지 않고
  notification retry/manual review summary로 격리한다.
- fixture smoke는 외부 provider와 DB에 연결하지 않고, 디스크 migration 기준을 secret-safe summary로 노출한다. 후속 sub PR은 각 boot 단계별
  fixture smoke와 integration evidence를 추가해야 한다.

## Issue #206 production live ops 실제 arm 신뢰성 기준

- `live:ops` 실제 arm은 config/env validation, DB readiness, Upbit public market data, Upbit private capability probe, Telegram startup,
  reconcile/PnL/status, decision readiness, live execution arm 순서로 전진한다.
- boot sequence가 broker 조립 전에 실패하면 private client와 live broker를 만들지 않는다. 이 실패는 한국어 상태/원인/영향/필요 조치로
  TUI/CLI에 표시해야 한다.
- market data freshness, reconcile freshness, PnL/status, decision ledger, kill switch 중 하나라도 최신 evidence가 아니면 broker 제출로
  전진하지 않는다.
- decision policy resolver는 config의 정적 allowlist policy id만 strategy로 조립한다. 알 수 없는 policy, 임의 코드 경로, 동적 import,
  저장소 밖 strategy 입력은 HOLD로 가장하지 않고 startup/config 또는 strategy decision 경계에서 fail-closed 한다.
- `cleanup_probe`는 같은 market data tick의 orderbook에서 단일 order intent만 만들며, analysis safe summary의 `orderIntentCount`와
  live execution 내부 입력으로 전달되는 order intent 배열이 다르면 broker 제출로 전진하지 않는다. raw order intent는 status/TUI/JSON
  summary에 직렬화하지 않고, public pipeline도 non-enumerable result channel로만 같은 tick 후보를 전달한다.
- `cleanup_probe`처럼 `requiredFeatures=[]`인 policy는 fresh orderbook만 요구하므로 feature snapshot 실패를 0으로 보정하지 않고
  `live_ops_feature_snapshot_not_required` evidence와 함께 평가할 수 있다. feature 의존 strategy는 feature 실패 시 계속 fail-closed 한다.
- strategy가 `BLOCK`을 반환하면 주문 후보 없음 idle이 아니라 analysis blocked로 수렴해야 하며, live execution은 broker runtime을 호출하지 않는다.
- 같은 order attempt나 idempotency key로 재시작하는 경우 새 Upbit identifier를 만들지 않는다. broker submit 결과가 불확실하면 재주문하지
  않고 reconcile/manual review로 수렴한다. public live execution adapter는 긴 decision key를 stable `ops-` attempt id로 낮춰 같은 cleanup
  후보가 재평가되어도 동일 identifier chain을 유지한다.
- submit 이후 cancel requested와 terminal cancel 확인은 같은 attempt/identifier chain으로 연결되어야 하며, open exposure 0,
  duplicate order 0건, reconcile mismatch 0건, untracked fill 0건이 closeout evidence에 포함되어야 한다.
- production `live:ops` clean-start DB에 완료된 reconcile run이 없으면, broker 제출 전 actual Upbit private read 결과를
  `LIVE_OPS_PRIVATE_READ_PREFLIGHT` run으로 `live_reconcile_*` 테이블에 append-only 저장한 뒤 같은 DB provider로 다시 읽어
  reconcile freshness를 판단한다. 기존 mismatch/manual review/failed/running 상태는 preflight clean evidence로 덮지 않으며, preflight
  시점에 설정 마켓 밖의 다른 KRW 마켓을 포함한 계정 전체 미체결 주문이 있으면 `UNTRACKED_EXCHANGE_OPEN_ORDER` mismatch와
  `MANUAL_REVIEW_REQUIRED`로 닫아 신규 cleanup 주문을 차단한다. 기존 DB evidence가 clean이어도 현재 private read에서 계정 전체 open order가
  확인되면 새 manual-review preflight run을 append하고, 가격 또는 원 주문 수량이 없는 `market`/`best` 계열 open order도 `remaining_volume`
  기반 evidence로 남겨 차단한다. submitted 또는 cancel requested lifecycle의 계정 전체 open order는 현재 live execution identity와 일치하는
  1건만 tracked로 인정하며, preflight manual-review summary는 계산 가능한 노출 금액과 owner Telegram manual-review alert를 보존한다.
- Telegram 전송 실패는 주문/리스크 commit을 되돌리지 않고 retry/manual review summary로 격리한다.
- 실제 cleanup run은 저장소 밖 redacted artifact에만 기록하고, issue/PR에는 safe summary와 artifact 경로만 남긴다.

## M23 restart/recovery drill 신뢰성 기준

- M23 recovery drill은 restart 전후 event log를 같은 restart id로 묶어야 하며, 감지와 복구 Telegram/status evidence가 모두 있어야 한다.
- restart 후 같은 idempotency key 또는 order attempt가 다시 `broker_submission`으로 기록되면 duplicate live order로 보고 closeout
  실패로 처리한다.
- recovery evidence에는 reconcile mismatch 0건, live ops status 복구, heartbeat 재개, daily report marker 재생성이 포함되어야 한다.
- Upbit 점검/장애, market warning/caution, stale data/WebSocket gap drill은 신규 entry fail-closed와 alert/manual review evidence로
  수렴해야 한다.
- DB backup/restore smoke는 disposable restore DB에서 통과하거나, 실행 불가 blocker와 필요한 권한/재시도 계획을 남겨야 한다.
- recovery drill validator는 artifact를 읽는 검증 경계이며, CI/PR 기본 검증에서 live order API, Telegram provider, DB restore를
  직접 호출하지 않는다.

## M20 Telegram inbound 신뢰성 기준

- inbound polling loop는 기본 비활성이며, enabled config/env와 owner allowlist guard를 모두 통과한 뒤에만 시작한다.
- Telegram `getUpdates` response는 raw provider payload를 저장하지 않고 update id, message id, chat id, user id, text 같은 최소
  command projection으로 줄인다. audit에는 text와 raw chat/user id를 남기지 않는다.
- command parser는 `/status`, `/positions`, `/pnl`, `/why <market|cash>`, `/orders`, `/risk`, `/pause`, `/resume`, `/kill`만
  인식한다. unknown/malformed command는 exception이 아니라 한국어 안내와 `TELEGRAM_INBOUND_COMMAND` audit evidence로 수렴한다.
- owner chat allowlist가 비어 있거나 sender가 allowlist 밖이면 read-only 명령도 handler로 넘기지 않는다.
- parser/auth를 통과한 command는 handler 실행 전에 `telegram.inbound.v1:*` idempotency key를 만들고 기존 `jobs` table unique
  constraint로 한 번만 선점한다. duplicate이면 조회/control side effect 없이 duplicate audit evidence만 남긴다.
- dedupe row는 실행할 worker job이 아니라 command receipt이므로 `job_type=telegram.inbound.command`, `status=COMPLETED`,
  `max_attempts=1`로 남긴다. 일반 worker는 job type scope 없이 jobs table을 claim하면 안 된다.
- dedupe 저장이 실패하면 같은 control 명령 재전달을 안전하게 막을 수 없으므로 provider 실행 전에 중단한다. 이 경우 audit
  evidence는 `DEDUPE_FAILED`/`telegram_inbound_dedupe_failed`로 남기며, 사용자에게는 중복 실행 보호 상태를 기록하지 못해 명령을
  보류했다는 한국어 reply를 보낸다.
- audit append가 실패하면 운영자가 사후 추적할 evidence가 없으므로 read-only 조회와 control 명령 모두 provider 실행 전에
  중단한다. 가능하면 Telegram reply로 감사 기록 실패와 필요한 조치를 안내한다.
- `/pause`, `/resume`, `/kill`은 같은 chat/user가 같은 command를 60초 TTL 안에 한 번 더 보내야 실행된다. TTL은 Telegram
  message 시각 기준으로 판정하고, 처리 시점에도 두 번째 메시지가 fresh해야 한다. 오래된 backlog control 명령은
  `CONFIRMATION_EXPIRED`/`telegram_inbound_control_confirmation_expired`로 보류하며 provider 실행으로 이어지지 않는다.
  pending confirmation은 process-local memory에만 있고 재시작 시 사라지므로, 재시작은 control 실행으로 이어지지 않는다.
- polling runtime `start()` loop는 provider contract 밖 예외를 loop 경계에서 흡수하고 다음 tick을 예약한다. `runOnce()` 결과에는
  raw update, raw text, raw chat id를 포함하지 않고 update count, next offset, handler result summary만 남긴다.

## M21 수동 승인 live pilot 신뢰성 기준

- proposal은 `PROPOSED`에서 시작하고 `APPROVED`, `REJECTED`, `EXPIRED`, `SUBMITTED`, `SUBMISSION_FAILED` 중 하나로만 전이한다.
  `APPROVED`는 broker 제출 전 crash/restart에서 재개 가능한 중간 상태이고, `REJECTED`, `EXPIRED`, `SUBMITTED`,
  `SUBMISSION_FAILED`는 닫힌 상태이며 재승인이나 재제출을 허용하지 않는다.
- `APPROVED` 재개는 broker submit으로 바로 넘어가지 않는다. runtime은 approval audit projection을 먼저 보강하고, 이 보강이
  실패하면 `SUBMISSION_FAILED`로 닫아 감사되지 않은 승인 상태에서 주문 side effect가 발생하지 않게 한다.
- proposal fingerprint는 market, side, limit price, volume, expected notional, 예산 snapshot, decision ledger id, risk decision id,
  cost snapshot, idempotency key, expires_at을 기준으로 만든다. expires_at은 같은 instant의 ISO 표기 차이가 fingerprint mismatch를
  만들지 않도록 정규화하며, fingerprint mismatch는 stale approval로 보고 broker 호출 전에 차단한다.
- 같은 proposal id 또는 idempotency key는 중복 live order를 만들 수 없다. Telegram update/message 재전달은 M20 dedupe를 먼저
  통과해야 하며, proposal 상태 전이는 durable append-only evidence로 남긴 뒤 현재 상태와 일치할 때만 전진한다.
- M21 startup guard는 `telegram.inbound.enabled` flag만 보지 않고, bot token과 owner allowlist까지 해결된 M20 inbound readiness를
  입력으로 받아야 한다. M20 inbound readiness와 reconcile freshness는 config opt-out으로 낮출 수 없는 필수 guard다.
- proposal TTL은 Telegram message 시각이 아니라 approval 처리 시각으로 판단한다. backlog에 쌓인 approval command가 처리 시점에
  이미 만료됐으면 `EXPIRED` evidence로 수렴하고 제출하지 않는다.
- 만료 상태 전이가 저장됐어도 `EXPIRATION_RECORDED` audit projection이 실패하면 만료 성공으로 응답하지 않는다. runtime은
  `PROPOSAL_EXPIRATION_AUDIT_FAILED`와 `m21_expiration_audit_append_failed`를 반환해 audit/proposal store 점검을 요구한다.
- approval evidence가 있어도 제출 직전 risk gate, kill switch, reconcile freshness, budget, market allowlist, order type, price
  deviation을 재검증한다. budget guard는 broker에 넘길 `requestedPrice * requestedVolume`을 다시 계산해 proposal
  `expectedNotionalKrw`와 일치하고 한도 이하인지 확인한다. broker 제출 금액은 Upbit KRW 최소 주문금액 5,000원 이상이어야 하며,
  일일 승인 예산 사용액 snapshot은 음수가 아닌 유효한 숫자여야 한다. 재검증 실패는 `SUBMISSION_FAILED` evidence로 남기고 live
  broker에 위임하지 않는다.
- `SUBMISSION_RECHECK_PASSED` evidence가 proposal store와 audit projection에 append된 뒤에만 broker submit으로 넘어간다. Telegram
  duplicate command는 M20 dedupe에서 닫고, proposal store는 expected status와 fingerprint를 비교해 stale approval race를 차단한다.
- recheck pass evidence append는 expected status `APPROVED`와 fingerprint를 함께 비교해야 한다. fingerprint만 맞고 상태가 이미
  닫힌 proposal에는 broker 직전 evidence를 추가하지 않는다.
- daily budget은 recheck snapshot 확인만으로 끝내지 않고 broker 호출 직전 durable reservation으로 선점한다. store 구현체는
  expected status/fingerprint 비교와 `dailyApprovedNotionalUsedKrw + 이미 선점된 금액 + 제출 금액 <= daily limit` 검사를 같은
  원자 경계에서 처리해야 하며, reservation 실패 또는 예산 초과는 broker 호출 전 `SUBMISSION_FAILED`로 수렴한다.
- 같은 proposal id의 reservation은 한 번만 허용한다. 같은 proposal reservation이 이미 있으면 다른 제출 경로가 broker 직전 gate를
  선점한 상태로 보고, 두 번째 요청은 proposal 상태를 실패로 닫지 않은 채 추가 broker 호출만 차단해야 한다.
- broker submission 결과는 proposal, approval, risk decision, broker submission evidence chain으로 추적 가능해야 한다. audit
  append나 submission evidence 저장에 실패하면 주문 성공으로 취급하지 않는다.
- broker submit 예외는 provider에 도달하지 않았다는 보장이 아니므로 `brokerSubmitted=false`로 기록하지 않는다. 이 경우
  `m21_broker_submission_uncertain`과 `broker_submission_state=uncertain`을 남기고 같은 proposal 재승인을 막은 뒤 수동 reconcile로
  실제 거래소 주문 존재 여부를 확인한다.
- broker submit 예외 이후 `SUBMISSION_FAILURE_RECORDED` 저장까지 실패해도 Telegram handler까지 raw exception을 전파하지 않는다.
  결과는 `APPROVAL_SUBMISSION_FAILED`, `brokerSubmitted=true`, `m21_broker_submission_uncertain_evidence_exception`으로 정규화해
  운영자가 불확실 제출을 놓치지 않게 한다.
- broker submit 예외 이후 `SUBMISSION_FAILURE_RECORDED` 저장은 성공했지만 audit projection이 실패해도 성공적 실패 처리로 숨기지
  않는다. 결과는 `APPROVAL_SUBMISSION_FAILED`, `brokerSubmitted=true`,
  `m21_broker_submission_uncertain_audit_append_failed`, `audit_status=append_failed`로 남긴다.
- `/reject`는 broker side effect를 만들지 않지만 operator decision audit chain의 일부다. rejection 상태 전이 후 audit projection이
  실패하면 `REJECTION_AUDIT_FAILED`로 응답하고 성공 거부로 숨기지 않는다.

## RiskGate append-only 기준

- `risk_ok`는 현재 `riskGateContext`를 평가한 실제 RiskGate 승인 결과가 있을 때만 PASS가 될 수 있다.
- `risk_ok`와 runtime persistence는 현재 주문 후보 식별자와 RiskGate `orderIntent` 식별자, 수량, 명목 금액, 지정가, 예상 손실 입력이 다르면 fail-closed한다. 금액과 예상 손실 문자열은 DB numeric scale 차이를 피하기 위해 Decimal로 정규화해 비교한다.
- runtime persistence는 DB/현재 후보에서 읽은 주문 의도와 top-level 예상 손실 입력을 별도 입력으로 받아 RiskGate context와 다시 대조한다.
- RiskGate가 주문 후보를 거부하면 주문 상태 전이는 `order_events`, 차단 원인은 `risk_events`, 사람이 추적할 판단 근거는 `audit_events`에 append-only로 남긴다.
- RiskGate runtime이 현재 주문 상태에서 `RISK_APPROVED` 또는 `RISK_REJECTED`로 전이할 수 없으면 승인 우회가 아니라 `risk_events`에 불법 상태 전이 원인을 남기고 fail-closed한다.
- RiskGate 증거 저장은 주문 전이, kill switch 전이, 리스크 원인, 감사 근거를 하나의 combined event store port로 넘기며, PostgreSQL 구현은 하나의 DB transaction으로 원자성을 보장한다.
- 허용된 주문 상태 전이는 `order_events` append와 같은 transaction에서 `orders.status`/`orders.updated_at` snapshot을 갱신하되, DB의 현재 상태가 event의 `fromState`와 같을 때만 전진시킨다. 거부된 전이는 event log에만 남긴다.
- 현재 kill switch action plan이 신규 주문 차단 또는 수동 검토를 요구하면 현재 RiskGate snapshot이 PASS여도 주문 상태를 `RISK_REJECTED`로 기록한다.
- kill switch 전이는 audit event뿐 아니라 `kill_switch_state` durable snapshot에도 같은 transaction으로 반영해 프로세스 재시작 후 차단 상태를 복구한다.
- `PAUSE_STRATEGY`는 해당 strategy 범위의 정지 action plan으로만 남기며 전역 kill switch로 승격하지 않는다.
- `STRATEGY_PAUSED` kill switch 상태는 strategy 평가 중지를 표현할 뿐 전역 신규 주문 차단으로 해석하지 않는다.
- strategy 연속 손실 snapshot의 `strategyId`는 주문 후보의 strategy id와 일치해야 하며, 다르면 수동 검토 필요 상태로 fail-closed한다.
- strategy 연속 손실 초과는 더 강한 전역 차단 action에 묻혀도 별도 strategy pause evidence로 남긴다.
- `HARD_STOP`은 kill switch를 더 강한 상태로만 전이시키며 pending paper order 취소 계획을 감사 이벤트로 남긴다.
- `HARD_STOP` action plan은 open position 자동 청산을 항상 금지한다. 실제 pending order cancel 호출은 M6
  `executeHardStopPendingPaperOrderCancels` 경계에서 `BrokerPort.cancelOrder`로만 수행하며, 실행 직전에도
  `autoLiquidateOpenPositions=false`를 재검증한다.
- HTTP control의 `POST /kill-switch`는 target state를 `NEW_ORDERS_BLOCKED`, `HARD_STOP`,
  `MANUAL_REVIEW_REQUIRED`, `NORMAL`으로 제한한다. `HARD_STOP -> NORMAL` 직접 복구는 거부하고, 허용/거부된 요청은
  모두 `audit_events`와 `risk_events`에 남긴다.
- HTTP control에서 허용된 kill switch 전이는 `kill_switch_state` snapshot, audit evidence, risk evidence,
  `HARD_STOP` pending cancel job을 하나의 DB transaction으로 저장한다. pending cancel job은 후속 실행 경계를 남길 뿐
  route handler 안에서 broker cancel side effect를 수행하지 않는다.
- P0 원인 mapping은 `db_write_failure`, idempotency 위반, fill/order accounting mismatch, risk 계산 불능,
  audit persistence failure, live order API 오사용을 `HARD_STOP`으로, stale/lag/freshness/data gap을
  `NEW_ORDERS_BLOCKED`로, 알림/리포트 반복 실패와 운영자 판단 필요 상태를 `MANUAL_REVIEW_REQUIRED`로 수렴시킨다.

## Alert delivery 신뢰성 기준

- alert fingerprint는 환경, 실행 모드, severity, alert type, market, strategy, reason code를 모두 포함한다.
- severity가 fingerprint에 포함되므로 낮은 등급 알림의 cooldown은 P0 escalation을 막지 않는다.
- P0/P1 cooldown은 `alert_cooldowns` PostgreSQL row로 보존해 프로세스 재시작 후에도 중복 Telegram 전송을 억제한다.
- Telegram message는 내부 enum/code를 첫 줄에 그대로 노출하지 않고 한국어 사용자 문구로 상태, 원인, 영향, 필요 조치를
  먼저 보여준다. `fingerprint`, correlation id, audit/risk event id는 복구 추적을 위해 하단 `추적 정보` 섹션에 보존한다.
- P0/P1 provider 호출 전에는 `delivery_reserved_until`을 atomic하게 잡아 같은 fingerprint의 동시 요청을 직렬화한다.
- provider 실패나 notifier 예외가 발생하면 `delivery_reserved_until`을 즉시 해제해 같은 fingerprint의 실제 재시도와 추가 실패
  evidence가 reservation 만료까지 막히지 않게 한다.
- reservation 거부 직후 최신 state에 cooldown/lease 차단 사유가 없으면, 다른 요청의 release와 경합한 것으로 보고 한 번
  재예약한다. 재예약도 실패하면 예외 대신 `alert_reservation_race` skip evidence를 남겨 알림 처리 루프를 중단하지 않는다.
- P2/P3 cooldown은 M8 Sub PR 3 범위에서 process memory로 제한한다. 재시작 후 낮은 등급 알림이 다시 전송될 수 있는 점은
  의도한 trade-off이며, durable 저장소 확장은 후속 요구가 있을 때 별도 변경으로 다룬다.
- cooldown hit는 provider 호출 없이 `last_skipped_at`과 `ALERT_COOLDOWN` audit event를 남긴다.
- provider 전송 성공만 `last_sent_at`을 갱신하고 `NOTIFICATION_DELIVERY` audit event를 남긴다. `last_sent_at`은 alert 발생
  시각이 아니라 provider 전송 완료 시각 기준이며, out-of-order update가 들어와도 뒤로 가지 않는다.
- notifier adapter가 예외를 던져도 alert dispatch는 `notification_provider_exception` 실패 결과로 정규화해 audit,
  retry 후보, failure threshold 평가를 같은 경로로 수행한다.
- P0/P1 provider failure는 `notification_retry` job 후보를 만들고, runtime retry queue가 연결된 경우 같은 idempotency key로
  jobs table에 예약한다. retry job 예약 실패는 `notification_retry_enqueue_failed` evidence로 남기되 원 업무 commit을
  rollback하지 않는다.
- notification retry worker는 `job_type=notification_retry`만 claim해야 한다. 공용 jobs table에서 job type 조건 없이 claim하면
  daily report, policy sync 같은 다른 worker 책임 row를 실행할 수 있으므로 merge-blocking 결함으로 본다.
- notification retry worker는 claim과 실행을 한 건 단위로 반복한다. 배치 전체를 먼저 RUNNING으로 바꾸면 중간 crash 때 아직
  provider 호출하지 않은 row가 재claim되지 않으므로 금지한다.
- retry provider 전송 성공 또는 같은 fingerprint의 활성 cooldown hit(`alert_cooldown_active`)는 retry job을 `COMPLETED`로
  닫는다. in-flight reservation이나 reservation race로 막힌 경우는 다른 실행이 끝나지 않은 상태일 수 있으므로 완료 처리하지
  않고 실패 경로로 재예약한다. provider 실패와 deferred reservation은 dispatch 처리 종료 시각을 기준으로 `failJob` 재예약
  시각을 계산하고, claim 시각보다 과거가 되지 않게 보정한다. max attempts를 소진하면 `FAILED`와
  `notification_retry_manual_review_required` audit evidence를 남겨 manual review로 수렴한다.
- retry worker는 provider 전송 성공을 runtime-local notifier adapter로 추적한다. 전송 성공 뒤 cooldown 기록이나 alert audit
  저장에서 예외가 발생하면 같은 Telegram message를 다시 보내지 않도록 job을 `COMPLETED`로 닫고, 가능한 경우
  `notification_retry_delivered_after_dispatch_error` evidence만 남긴다.
- retry worker의 audit 저장 실패는 이미 발생한 provider side effect나 job 상태 전이를 재시도하지 않는다. 이 장애는 audit 누락
  리스크로 남기고 Telegram 재전송 중복을 만들지 않는다.
- provider 실패가 연속 3회이거나 첫 실패 이후 10분 이상 지속되면 kill switch mapping에서 `MANUAL_REVIEW_REQUIRED` 후보로
  쓰는 reason code를 반환한다.
- runtime kill switch alert dispatch는 같은 `alertDispatch` 옵션 객체에 최신 failure state를 저장해 provider 실패 누적을
  호출 간 유지한다.
- fingerprint 세그먼트 안의 `:`는 join 구분자와 충돌하지 않도록 `%3a`로 escape한다. 서로 다른 market/strategy/reason 조합이
  같은 cooldown row를 공유해 오억제되는 상황을 막기 위한 규칙이다.
- Telegram 설정이 있는 runtime kill switch control provider는 accepted 전이를 DB transaction commit 이후 alert dispatch로
  연결한다. Telegram side effect는 kill switch durable update transaction 안에 넣지 않는다.
- post-commit alert dispatch가 cooldown/audit/provider 경계에서 실패해도 이미 commit된 kill switch 전이를 5xx로 바꾸지 않고,
  결과 객체에 `alert_dispatch_failed` reason code만 기록한다.
- paper 매매 이벤트 알림 후보는 주문·체결·취소·리스크 evidence가 확정된 뒤 생성한다. mapper는 alert 요청만 만들고 broker
  side effect나 DB write를 수행하지 않아, Telegram provider 장애가 이미 commit된 주문/체결 상태를 되돌리지 않는다.
- paper 매매 이벤트 P1은 durable cooldown과 `notification_retry` 후보 대상이며, P2 lifecycle 알림과 P3 요약 알림은 process
  memory cooldown으로 묶는다. 정상 lifecycle 반복은 단건 즉시 전송보다 summary 정책으로 낮춰 운영 소음을 제한한다.
- paper 매매 이벤트 Telegram 메시지는 `PAPER`, market, strategy, side, 수량, 가격/비용, 상태·원인·영향·필요 조치를 먼저
  표시하고, order id, idempotency key, correlation id, event kind, reason code는 하단 `추적 정보`에만 둔다.

## Daily report 신뢰성 기준

- daily report 기준일은 KST `YYYY-MM-DD`이며, DB 조회는 해당 날짜를 UTC half-open window로 변환한
  `utcStartAt <= timestamp < utcEndAt` 조건만 사용한다. summary와 job payload에는 KST/UTC window를 함께 남겨 재실행 시
  같은 범위를 재현할 수 있게 한다.
- daily report fact 조회는 standalone repository 호출에서 `repeatable read` transaction으로 묶어 `orders`, `fills`,
  `risk_events`, `pnl_snapshots` 같은 여러 table이 같은 MVCC snapshot을 바라보게 한다. 이미 열린 transaction을 넘기는
  호출자는 그 transaction의 snapshot 경계를 책임진다.
- daily report job은 `job_type=report.daily`와 `report_date`를 합친 `report.daily:<reportDate>` idempotency key로
  예약한다. scheduler 재시작, 수동 재실행, worker retry가 같은 기준일을 다시 예약해도 기존 `jobs` row를 재사용해야 한다.
- PnL snapshot이 기준일 안에 있으면 strategy/market별 최신 snapshot만 손익 합계에 반영한다. 같은 전략의 과거 snapshot을
  모두 더하면 손익이 중복 집계되므로 최신 snapshot 선택은 리포트 invariant다. strategy id와 market code는 문자열 결합
  key가 아니라 각각의 scope로 구분해 구분자 충돌이 손익 scope를 섞지 않게 한다. snapshot이 일부 scope에만 있으면
  snapshot이 없는 scope만 positions current snapshot으로 보강한다.
- realized PnL과 estimated PnL은 같은 숫자로 합치지 않는다. realized는 확정 손익, estimated는 미실현 손익 기준으로 분리하고
  source가 `pnl_snapshots`인지 `positions` fallback인지 표시한다.
- 주문 상태별 집계는 `orders.status` 현재 snapshot을 그대로 읽지 않고, accepted `order_events`를 기준으로 report window
  종료 직전 상태를 복원한다. 같은 timestamp의 accepted event는 UUID가 아니라 주문 lifecycle 순서로 정렬한다. event evidence가
  없는 주문만 현재 snapshot을 fallback으로 사용한다.
- positions는 현재 snapshot table이므로 `updated_at < reportEnd` 컷오프로 제외하지 않는다. 과거 시점 복원이 불가능한 fallback
  source라는 점은 report source label과 문서에 남기고, PnL snapshot이 있으면 해당 scope에서는 positions를 대체한다.
- fee, slippage, spread, cancel/requote penalty는 가능한 값만 분리 집계한다. 체결 품질 payload가 없으면 해당 metric은
  `unavailable`로 남기며, 결측을 0으로 대체하지 않는다. 체결 품질 평균은 `fills.filled_at`이 기준일 window에 들어온 실제
  체결 주문만 대상으로 하며, 미체결/취소/리스크 거부 주문의 예상 비용 snapshot은 평균 모집단에 넣지 않는다.
- 주문 후보 폐기는 `audit_events.payload_json.audit_kind=ORDER_CANDIDATE_DISCARDED`인 row만 `reason_code`별로 집계한다.
  일반 audit event를 섞으면 폐기 사유가 과대 집계되므로 payload kind 확인은 필수다.
- Telegram daily report 전송은 집계가 끝난 뒤 `NotifierPort.sendDailyReport`에서만 발생한다. DB fact 조회와 집계가 성공한
  사실, provider 전송 성공/실패는 job/audit에서 분리해 추적해야 한다.
- M9 daily report runner는 수동 실행과 scheduler 실행 모두 `report.daily:<reportDate>` idempotency key를 먼저 예약하거나
  재사용한 뒤 claim된 job만 실행한다. 같은 기준일 job이 이미 `COMPLETED`이면 수동 실행은 provider를 다시 호출하지 않는다.
  같은 기준일 job이 `FAILED`로 소진됐으면 운영자 수동 실행만 같은 row를 `PENDING`으로 재개해 복구할 수 있다.
- scheduler worker는 `job_type=report.daily`만 claim해야 하며, 수동 실행의 idempotency-key claim도 같은 job type 조건을
  함께 강제해야 한다. 공용 jobs table에는 policy sync, notification retry 같은 다른 작업도 들어오므로 daily report worker가
  다른 job type을 실행하면 운영 side effect가 섞일 수 있다.
- scheduler worker는 여러 건을 처리하더라도 claim과 실행을 한 건 단위로 반복해야 한다. 배치 전체를 먼저 `RUNNING`으로
  바꾸면 중간 crash 때 아직 실행하지 않은 row가 재claim되지 않으므로, 다음 job은 이전 job의 최종 전이 이후에만 claim한다.
- scheduler worker가 generation failure row를 `PENDING`으로 되돌릴 때는 같은 sweep에서 같은 row가 즉시 재claim되지 않도록
  `run_after`를 최소 다음 tick 이후로 미룬다. 실패 row가 attempt를 한 번에 소진하면 다른 due job 처리도 굶길 수 있다.
- daily report runner가 audit 저장소 장애처럼 예외를 던져도 runtime은 claim된 job을 `failJob` 경계로 넘겨 lock을 해제해야
  한다. 이 전이가 실패하지 않는 한 같은 idempotency key는 retry 또는 수동 복구 대상으로 남아야 한다.
- report 생성 실패와 Telegram provider 실패는 서로 다른 failure class다. fact 조회, 집계, formatting 실패는
  `daily_report_generation_failed` audit evidence와 jobs retry/FAILED 상태로 남긴다. Telegram provider 실패나 notifier 예외는
  `daily_report_notification_failed` audit evidence로 남기되, deterministic report 생성 성공을 되돌리거나 같은 기준일을
  반복 전송하지 않는다.
- Telegram 전송 성공 이후 notification audit 저장이 실패해도 이미 발생한 provider side effect를 retry하지 않는다. 이 장애는
  runner 결과의 error message와 job completion evidence로 추적하고, audit 저장소 복구는 별도 운영 조치로 다룬다.

## M10 LLM 리스크 보조 신뢰성 기준

- LLM provider 호출은 거래 실행 경로의 선행 조건이 아니다. provider timeout, invalid JSON, free-form output, output size 초과,
  command failure는 모두 실패 evidence로만 남기고 strategy candidate, broker call, 주문 허용 RiskGate evaluation을 만들지 않는다.
- `codex_oauth`와 `noop` provider는 같은 normalized response union을 반환해야 한다. provider 교체는 application contract와
  RiskGate mapper 출력의 의미를 바꾸지 않아야 하며, provider별 raw 응답은 경계 밖으로 새지 않아야 한다.
- RiskGate mapper는 `notice_risk_classification`과 공식 입력 source만 안전 신호로 축약한다. `CANCEL_PENDING`은 직접 취소 실행이
  아니라 사람 확인 후보로 남겨 주문 lifecycle과 idempotency 경계를 우회하지 않는다.
- LLM audit 저장은 append-only evidence다. audit 저장 실패는 별도 장애로 다루며, LLM 결과를 주문 허용 신호로 보정하거나
  deterministic 업무 성공을 되돌리는 근거가 될 수 없다.
- LLM daily report draft는 deterministic daily report 옆의 보조 텍스트다. provider 실패, 비일간 리포트 result, order-like metadata는
  draft attachment에서 제외하고 원본 report notification payload를 유지한다.
- 실제 Codex OAuth smoke는 `SEEMIRAI_RUN_CODEX_LLM_SMOKE=1`이 있을 때만 실행한다. 기본 검증은 fake runner와 deterministic fixture로
  fail-closed contract를 확인해 CI가 외부 provider 지연에 묶이지 않게 한다.

## Paper soak 신뢰성 기준

- 24시간 paper soak harness는 기본 실행에서 장시간 public WebSocket 연결을 시작하지 않는다. `SEEMIRAI_RUN_SOAK=1`이 없으면
  skip summary와 PR 첨부용 Markdown report만 남겨 CI와 로컬 기본 검증이 장시간 작업으로 멈추지 않게 한다.
- fixture smoke는 stale market data status event가 신규 주문 차단 evidence와 audit evidence로 연결되는지 검증한다. 이 smoke가
  실패하면 24시간 실행 전에도 stale data 차단 회귀로 보고 PR을 닫지 않는다.
- live order API 호출 0회는 soak runtime의 실제 호출 카운트와 `PAPER_NO_KEY` execution runtime source scan을 함께 기록한다.
  source scan은 `ExecutionEngine -> PaperBroker` 조립과 disabled live broker fail-closed 메서드를 확인한다.
- `/status`와 `/kill-switch`는 기본적으로 source scan으로 route 등록 근거를 확인한다. 운영자가 `--control-url`을 넘기면
  `/status` 200 응답과 token 없는 `/kill-switch` 거부 응답을 실제 local control server에서 확인한다. `/status`의
  paper/alerts/daily report durable 조회 실패는 endpoint 실패가 아니라 하위 `unavailable` 상태와 한국어 필요 조치로 남긴다.
- 24시간 soak 완료 summary에는 crash 0회, unhandled rejection 0회, live order API 0회, audit 누락 0건, stale data 차단,
  DB write failure 0건, notification failure 0건, daily report 생성 여부가 들어가야 한다.
- raw event log와 summary artifact는 기본적으로 저장소 밖 `SEEMIRAI_SOAK_LOG_DIR` 또는 `~/vaults/99_운영/seemirai-soak`에 남긴다.
  raw log는 재현과 PR evidence 확인용이며 git commit 대상이 아니다.

## M16 Live Reconcile 신뢰성 기준

- REST snapshot이 reconcile의 bootstrap source of truth다. private WebSocket `myOrder`/`myAsset`은 구독 성공 후 이벤트 버퍼를
  열고 REST snapshot을 잡은 뒤 변경 추적과 연결 liveness/gap evidence에만 사용한다. 버퍼를 열 수 없거나 구독과 snapshot 사이
  공백을 확인할 수 없으면 초기 reconcile을 성공으로 기록하지 않고 REST 재bootstrap 또는 manual review로 수렴한다.
  WebSocket 단절 시 REST fallback/bootstrap으로 상태를 재조회한다.
- reconcile mismatch가 발견되면 신규 주문을 fail-closed 하고 M16 전용 append-only reconcile tables에 mismatch evidence를 남긴다.
  같은 transaction에서 `risk_events`에 `live_reconcile_mismatch` 차단 근거를 append하고 `kill_switch_state`를
  `NEW_ORDERS_BLOCKED` 또는 `MANUAL_REVIEW_REQUIRED`로 전진시켜 RiskGate/주문 경로가 재시작 후에도 차단 상태를 읽게 한다.
  mismatch를 0으로 자동 복구하지 않는다. 주문/체결 로컬 복구 쓰기는 immutable identity fingerprint가 일치한 경우에만 기존
  domain repository transaction에서 수행하고, 거래소 state는 적용할 전이 입력으로 분리한다. 같은 reconcile run의 append-only
  evidence를 함께 남기며, `fills` insert는 거래소 체결 id와 정규화 fill fingerprint 중 관측 가능한 값을 모두 unique key로
  선점해 멱등화한다. mismatch evidence는 `evidence_fingerprint` unique key로 중복 append를 차단한다.
  `positions` 갱신은 authoritative fill price/volume으로 평균단가를 계산할 수 있을 때만 허용한다.
- idempotent run: 같은 reconcile worker가 중복 실행되어도 같은 시각의 같은 snapshot을 다시 조회해 동일한 mismatch 결과를
  반환한다. reconcile 실행 자체는 run idempotency key와 snapshot/evidence fingerprint로 중복 기록을 차단한다.
- closed order 조회는 `start_time`/`end_time`을 지정해 7일 이하 구간으로 나눠 수행한다. 설정된 조회 horizon 밖이거나
  identity/fingerprint를 확인할 수 없는 주문만 manual review로 남긴다. 불완전한 evidence는 mismatch count에 포함하되
  `복구 불가/수동 검토 필요`로 분류한다.
- private WebSocket gap/reconnect 기준:
  - `myOrder`와 `myAsset` 데이터 메시지 부재는 정상 대기 상태일 수 있으므로 STALE 전이 조건으로 쓰지 않는다.
  - 연결 liveness는 ping/pong 실패, close/error, 인증 실패, reconnect discontinuity로 판단한다.
  - WebSocket 재연결 시 REST bootstrap을 다시 실행해 snapshot 기준점을 갱신한 뒤 새로운 변경 이벤트부터 추적을 재개한다.
  - WebSocket 재연결 실패가 3회 연속이면 WebSocket만 `DEGRADED`로 표시하고 manual review evidence를 남긴다. REST/auth 조회가
    가능한 동안 reconcile worker는 REST-only degraded mode로 계속 실행한다.
- reconcile worker 실패(rate limit 초과, API 5xx, network error)는 최대 3회 재시도한다. 3회 초과 시 reconcile worker를
  중지하고 manual review로 수렴한다. 이 중지 기준은 REST/private read path 실패에만 적용하며, WebSocket 단독 장애에는 적용하지 않는다.
- reconcile summary(/status, CLI)는 마지막 reconcile 시각, 결과, mismatch 수, open order 수, balance snapshot 상태,
  WebSocket 상태, 필요한 조치를 한국어로 제공한다. 내부 식별자는 `추적 정보`로 분리한다.
- PnL 계산은 M17 범위이므로 reconcile 단계에서는 `계산 불가/수동 검토 필요`로 남긴다. balance snapshot을 PnL 근거로
  사용하지 않는다.

## M19 Exit Pilot 신뢰성 기준

- M19 exit pilot 기본 검증은 실제 live side effect 없이 paper fixture, guard negative test, source scan으로 닫을 수 있다. 실제
  smoke가 실행되지 않았으면 pass로 둔갑시키지 않고 skip/fail-closed 사유와 필요한 운영자 조치를 closeout과 PR 본문에 남긴다.
- `PAPER_NO_KEY` live order API 0회는 source scan과 disabled live broker 경계를 함께 확인한다. `submitOrder`, `cancelOrder`,
  `createLimitOrder` 후보가 발견되면 해당 호출이 M14/M15/M19 guard 뒤에 있는지 확인하고, 확인할 수 없으면 blocker로 취급한다.
- M19 guarded buy smoke가 `SKIPPED` 또는 `FAILED_CLOSED`이면 일반 order smoke 성공 경로로 낮추지 않는다. M19 guard가 활성화된
  bid smoke는 `PASSED`이고 side effect 가능성이 확인된 경우에만 추가 소액 한도 검증 뒤 주문 생성 경계로 넘어간다.
- Upbit cancel 직후 조회가 일시적으로 open 상태를 반환할 수 있으므로, 실제 order/live-broker smoke는 같은 UUID 또는 identifier만
  짧게 재조회해 terminal cancel을 확인한다. 제한 횟수 안에 `CANCELED` 또는 provider `cancel` 상태가 확인되지 않으면 성공으로
  올리지 않고 `MANUAL_REVIEW_REQUIRED` 또는 실패 evidence로 남긴다.
- `EXISTING_SMALL_POSITION` source는 M16 reconcile 또는 운영자 position evidence id가 있어도 실제 포지션 존재를 자동 추정하지
  않는다. 실행 직전 운영자가 market, 수량, 소액 한도, 기존 포지션 상태를 확인해야 하며, 불확실하면 paper fixture 검증으로만
  수렴한다.
- `hard stop`은 M19 이후에도 open position 자동 청산을 만들지 않는다. M19 exit pilot 실패, cancel 미확인, reconcile mismatch는
  신규 진입 중지와 manual review evidence로 수렴하며, 자동 시장가 청산으로 복구하지 않는다.

## M22 제한적 완전 자동매매 신뢰성 기준

- M22 startup guard는 config flag만 보지 않는다. operator arm, budget, key scope, M21 1주 gate evidence와 M20/M16/M17/M18/M19
  readiness provider가 모두 통과해야 private client와 live broker 조립으로 넘어갈 수 있다.
- autonomous order attempt는 `CANDIDATE_CREATED`, `COST_APPROVED`, `RISK_APPROVED`, `RESERVED`, `SUBMITTED`, `REJECTED`,
  `BLOCKED`, `RECONCILE_REQUIRED`, `MANUAL_REVIEW_REQUIRED` 상태를 append-only evidence로 남긴다. 상태 전이 evidence가
  저장되지 않으면 다음 단계로 전진하지 않는다.
- broker 호출 전 durable reservation은 idempotency key와 order attempt id를 같은 원자 경계에서 선점해야 한다. 이미 선점된
  attempt는 추가 broker 호출 없이 기존 제출/reconcile 상태 확인으로 안내한다.
- 제출 직전 risk gate, kill switch, reconcile freshness, budget, market allowlist, order type, price deviation, Upbit KRW 최소
  주문금액을 다시 검증한다. 후보 생성 시점의 pass 결과만으로 broker에 위임하지 않는다.
- broker submit 예외는 거래소 도달 여부를 단정할 수 없으므로 미제출로 기록하지 않는다. 결과는 `RECONCILE_REQUIRED` 또는
  `MANUAL_REVIEW_REQUIRED` evidence로 정규화하고, 같은 idempotency key 재시도는 중복 live order를 만들지 않아야 한다.
- reconcile mismatch, duplicate order, untracked fill, persistence failure는 신규 entry 중지와 manual review evidence로 수렴한다.
  hard stop 또는 mismatch 복구가 open position 자동 시장가 청산을 만들면 안 된다.
- M19 exit engine을 M22에 연결할 때 exit intent는 현재 live position scope를 초과할 수 없다. partial fill, cancel/requote 실패,
  cancel terminal state 미확인은 신규 entry 중지와 manual review로 수렴한다.
- M22 live canary는 제출 후 자동 cleanup이 없는 주문을 성공으로 보지 않는다. `--cancel-after-submit`으로 같은 uuid/identifier를 취소하고,
  제한 횟수 안에 terminal cancel을 확인하지 못하면 `order_cancel_unconfirmed`와 manual review evidence를 남기며 runner closeout을 실패시킨다.
- 24시간 live autonomous pilot closeout은 crash 0회, unhandled rejection 0회, risk gate 우회 주문 0건, reconcile mismatch 0건,
  duplicate order 0건, untracked fill 0건, live order cleanup failure 0건을 source scan과 redacted artifact로 함께 확인해야 한다.

## M23 24/7 live small-budget 운영 신뢰성 기준

- M23 7일 안정화는 dry-run이나 heartbeat-only가 아니라 live order API를 호출할 수 있는 `LIVE_AUTONOMOUS_SMALL_BUDGET` 설정으로
  arm 된 상태여야 한다. 주문이 없었던 날도 candidate 없음, gate 차단, 시장 조건 미충족, operator stop, kill switch 같은 이유를
  decision evidence와 daily report에 남긴다.
- live canary 1회 성공, 24시간 heartbeat-only, dry-run candidate canary는 M23 preflight 근거일 뿐 closeout 근거가 아니다. M23
  closeout은 7일 연속 daily report와 live-armed 설정 evidence를 요구한다.
- restart drill은 기존 order attempt, durable reservation, reconcile snapshot, status summary를 재사용해야 하며, 재시작 때문에
  duplicate live order를 만들면 merge-blocking 실패로 본다.
- Telegram lifecycle 알림은 연결 성공, live order capable 시작, 정상 종료, operator stop, kill switch, manual review, crash/restart를
  구분한다. 알림 실패는 P0/P1 retry evidence와 manual review 수렴 상태로 남긴다.
- 주문 제출, 취소 요청, 취소 확인, 체결, 부분체결, risk/cost/reconcile 차단 이벤트는 audit/risk/decision evidence 확정 이후
  알림 후보가 되어야 한다. 알림 provider 실패가 이미 확정된 주문·취소·차단 상태를 rollback하면 안 된다.
- 7일 stability closeout은 crash 0회, unhandled rejection 0회, risk gate 우회 주문 0건, reconcile mismatch 0건, duplicate order
  0건, untracked fill 0건, live order cleanup failure 0건을 redacted artifact로 확인해야 한다.
- 7일 stability closeout manifest는 `scripts/run-m23-stability-closeout.mjs`로 검증한다. 서로 다른 7개 day segment, 각 24시간
  runner 정상 종료, daily report, live-armed guard/readiness, decision evidence, recovery drill, source scan, DB backup/restore 결과
  또는 blocker가 없으면 closeout을 실패로 남긴다.
- DB backup/restore smoke drill은 disposable restore DB에서 실행한다. 외부 DB 조건이 없어 실행할 수 없으면 closeout에 blocker와
  필요한 운영자 조치를 남기고 pass로 둔갑시키지 않는다.
- 누적 realized loss와 미체결 노출 합계가 50,000 KRW에 닿기 전에 operator stop 또는 kill switch/manual review로 수렴한다. 이
  ceiling은 M24 예산 확대 승인이 아니다.

## M18 Decision Ledger 신뢰성 기준

- decision ledger는 append-only 저장소다. frame과 evidence는 insert만 수행하며 update, delete는 구현하지 않는다.
- 같은 `dedupe_key` 또는 `evidence_fingerprint` 충돌은 중복 append 없이 기존 row를 재사용하거나 `inserted=false` 결과로 반환한다. 기존 row를 update해 최신 summary처럼 덮어쓰지 않는다.
- ledger write 실패는 이미 발생한 broker/order side effect를 재시도하지 않는다. write 실패는 주문 허용 신호로 보정하지 않으며, 실패 evidence를 runner result, audit/risk evidence 또는 ledger failure summary에 남긴다.
- `decision_ledger_frames`와 `decision_ledger_evidence`는 `audit_events`, `risk_events`, `orders`, `pnl_snapshots`와 stable id 또는 correlation id만 연결한다. raw provider payload, raw order detail, secret 후보, Authorization/JWT/API key는 payload_json과 trace_json에 저장하지 않는다. payload_json과 trace_json은 JSONB에 안전하게 저장 가능한 JSON value만 허용한다.
- `/status` 하위 `why` summary는 read-only다. 별도 write/control endpoint를 만들지 않으며, route handler 안에서 DB write side effect를 수행하지 않는다.
- why summary는 사용자-facing 한국어 상태/원인/영향/필요 조치를 먼저 배치하고, 내부 식별자는 `trace`에 분리한다. 현금 보유 사유도 내부 reason code map을 직접 노출하지 않고 한국어 label/count 목록으로 표현한다. DB 조회 실패 시 endpoint 전체를 실패시키지 않고 해당 하위 객체의 `readStatus`를 `UNAVAILABLE`로 낮추며, 실패 section에도 한국어 안내와 필요한 조치를 남긴다.
- LLM summary는 deterministic evidence를 대체하지 않는다. LLM provider timeout, invalid JSON, output size 초과, provider 장애는 `EXPLANATION_FAILURE` evidence로만 저장하며, 주문 판단을 변경하지 않는다. `EXPLANATION_FAILURE`는 category `EXPLANATION_FAILED`와만 조합하고, 다른 evidence kind는 설명 실패 category를 갖지 않는다.
- LLM output에 `BUY`, `SELL`, `INCREASE_POSITION`, 목표가, 포지션 크기, 주문 허용 의미가 포함되면 fail-closed로 차단하고 요약 attachment에서 제외한다.
- decision ledger contract version은 `m18.decision_ledger.v1`이며, contract 변경 시 version을 명시적으로 올린다.

## 검증 규칙

- 자동 테스트가 없으면 수동 검증 절차라도 남긴다.
- 검증 수단이 전혀 없으면 그 공백을 `QUALITY_SCORE.md` 또는 기술 부채 문서에 등록한다.
