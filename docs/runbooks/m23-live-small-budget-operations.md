# M23 live small-budget 7일 운영 runbook

이 runbook은 Issue #188의 `LIVE_AUTONOMOUS_SMALL_BUDGET` 24/7 운영 안정화 절차다. 목적은 수익 검증이 아니라 실제 주문 API를
호출할 수 있는 live-armed 상태에서 운영자가 상태, 판단 이유, 주문/취소/체결/차단, 중지/복구 evidence를 secret 없이 확인할 수
있게 하는 것이다.

## 범위

- 대상 모드: `LIVE_AUTONOMOUS_SMALL_BUDGET`
- 기본 market: `KRW-BTC`
- 1회 주문 상한: `10000` KRW
- 일일 자동 주문 notional 한도: `30000` KRW
- open position notional 한도: `30000` KRW
- 운영 중지 ceiling: 누적 realized loss + 미체결 노출 합계가 50,000 KRW에 도달하기 전
- evidence 위치: 저장소 밖 `~/vaults/99_운영/seemirai-m22-live-autonomous` 또는 운영자가 지정한 동등한 redacted artifact 경로

## 제외 범위

- M24 전략, universe, budget 확대
- BTC 외 market 기본 활성화
- 자동 budget 확대
- 신규 진입 시장가, 시장가 매도, 최유리 주문 기본 허용
- hard stop 시 open position 자동 시장가 청산
- Telegram public webhook endpoint
- 출금, 입출금 자동화, 선물, 레버리지, 마진, 타인 계정, 신호 판매
- LLM 직접 매수/매도 판단

## 사전 점검

다음 항목이 모두 준비되지 않으면 live-armed 7일 안정화를 시작하지 않는다.

| 항목 | 확인 기준 |
| --- | --- |
| 운영자 arm evidence | `SEEMIRAI_M22_OPERATOR_ARM_EVIDENCE_ID`가 저장소 밖 redacted evidence를 가리킨다 |
| budget evidence | `SEEMIRAI_M22_BUDGET_EVIDENCE_ID`가 1회/일일/open notional 제한과 50,000 KRW ceiling을 확인한다 |
| M21 gate evidence | `SEEMIRAI_M22_M21_WEEK_GATE_EVIDENCE_ID`가 수동 승인 운영 gate를 확인한다 |
| key scope evidence | `SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID`와 `SEEMIRAI_UPBIT_KEY_SCOPE`가 `자산조회,주문조회,주문하기`만 포함한다 |
| M20 readiness | Telegram inbound owner allowlist, bot token, read-only/control 경계가 준비됐다 |
| M16 readiness | 최신 reconcile freshness가 pass이고 mismatch가 없다 |
| M17 readiness | PnL/status 조회가 가능하고 결측 원인이 표시된다 |
| M18 readiness | decision ledger와 why summary가 read-only로 조회된다 |
| M19 readiness | exit engine readiness가 pass이고 open position 자동 시장가 청산이 없다 |
| Telegram | 연결 성공 알림을 받을 owner chat이 준비됐다 |
| DB | primary DB 연결, migration 상태, artifact 저장 위치가 확인됐다 |
| backup/restore | disposable restore DB 또는 실행 불가 blocker 기록 위치가 준비됐다 |

## Live-Armed 실행

기본 파일 구조는 M22 runbook의 local file preparer가 만든 저장소 밖 디렉터리를 재사용한다.

```sh
cd /home/lim/code/seemirai
M22_HOME="$HOME/vaults/99_운영/seemirai-m22-live-autonomous"
. "$M22_HOME/m22.env"
. "$M22_HOME/m22.keys.env"
```

7일 stability run은 dry-run이 아니어야 한다. 운영 env는 다음 속성을 만족해야 한다.

```text
SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT=1
SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON=1
SEEMIRAI_PILOT_PROFILE=PILOT_ORDER_SMOKE
SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE=1
SEEMIRAI_RUN_UPBIT_ORDER_SMOKE=1
SEEMIRAI_UPBIT_KEY_SCOPE=자산조회,주문조회,주문하기
SEEMIRAI_M22_TELEGRAM_INBOUND_READY=1
SEEMIRAI_M22_RECONCILE_FRESH=1
SEEMIRAI_M22_PNL_STATUS_READY=1
SEEMIRAI_M22_DECISION_LEDGER_READY=1
SEEMIRAI_M22_EXIT_ENGINE_READY=1
```

현재 M22 기본 daemon은 종료 시점에 `daily_report_generated` marker를 한 번 남긴다. 따라서 7일 closeout을 단일
`604800000`ms runner로 실행하면 7일 연속 daily report evidence를 만들 수 없다. M23 closeout 전에는 supervisor, systemd timer,
또는 운영 wrapper가 아래 24시간 segment를 7회 연속 실행하고 각 segment의 daily report marker와 summary artifact를 확인해야 한다.

systemd로 운영할 경우 [`deploy/systemd/seemirai-m23-live-small-budget.service.example`](../../deploy/systemd/seemirai-m23-live-small-budget.service.example)을
운영 호스트에 복사한 뒤 `User`, `Group`, `WorkingDirectory`, `EnvironmentFile`, `ReadWritePaths`를 실제 운영 계정과 저장소/운영
artifact 경로로 맞춘다. 이 템플릿은 live daemon을 root가 아닌 운영 사용자로 실행하고, secret 값을 직접 담지 않고 저장소 밖 env
파일만 참조하며, `SIGTERM` 정상 종료와 `Restart=always` 재시작 경계를 사용한다. 재시작 후에는 아래 Restart Drill validator로
중복 주문, reconcile/status 복구, daily report marker를 확인한다.

각 24시간 segment 시작 전에는 다음 handoff를 먼저 수행한다.

1. candidate producer를 멈추고 더 이상 기존 JSONL에 append되지 않는지 확인한다.
2. 이전 segment candidate file의 마지막 크기와 SHA-256을 artifact에 기록하고, 다음 segment는 새 JSONL 파일로 rotate한다.
3. 새 candidate file은 비어 있는 상태로 daemon을 먼저 시작한 뒤 producer를 재개한다. daemon 시작 전에 후보를 미리 넣어야 하는
   재현 작업만 `--candidate-start beginning`을 사용한다.
4. M16 reconcile/status로 현재 open order, open exposure, realized loss를 확인하고 아래 env를 최신 safe summary 값으로 갱신한다.
   값을 확인할 수 없으면 segment를 시작하지 않고 manual review로 전환한다.

```text
SEEMIRAI_M22_INITIAL_DAILY_AUTONOMOUS_NOTIONAL_USED_KRW=<latest-safe-daily-notional>
SEEMIRAI_M22_INITIAL_OPEN_POSITION_NOTIONAL_KRW=<latest-safe-open-exposure>
SEEMIRAI_M22_DAILY_REALIZED_LOSS_KRW=<latest-safe-daily-realized-loss>
SEEMIRAI_M22_WEEKLY_REALIZED_LOSS_KRW=<latest-safe-weekly-realized-loss>
```

5. 누적 realized loss와 미체결 노출 합계가 50,000 KRW에 접근하면 다음 segment를 시작하지 않고 operator stop 또는 kill switch로
   전환한다.

```sh
node scripts/run-m22-live-autonomous-pilot.mjs \
  --config "$M22_HOME/m22-live-autonomous.config.json" \
  --duration-ms 86400000 \
  --artifact-dir "$SEEMIRAI_M22_ARTIFACT_DIR" \
  --require-daily-report \
  --pilot-command node \
  -- \
  scripts/run-m22-live-autonomous-daemon.mjs \
  --config "$M22_HOME/m22-live-autonomous.config.json" \
  --candidate-file "$M22_HOME/candidates/m23-segment-YYYY-MM-DD.jsonl" \
  --candidate-start end
```

`--candidate-start`는 `beginning` 또는 `end`만 허용한다. M23 24/7 운영은 새 후보만 따라가야 하므로 segment 재시작 기본값은
`end`다. 과거 후보를 재처리해야 하는 preflight나 재현 작업에서만 `beginning`을 사용한다.

후보 파일이 비어 있으면 현재 M22 daemon은 heartbeat와 종료 시 daily report marker만 남기고 주문을 만들지 않는다. 이 artifact는
post-cleanup preflight로는 사용할 수 있지만, "후보 없음" 또는 "시장 조건 미충족" decision evidence가 추가되기 전에는 M23 7일
closeout PASS 근거로 사용하지 않는다. Sub PR 02-04 구현은 빈 후보일과 gate 차단일도 daily report와 decision evidence로 설명할 수
있게 해야 한다.

## 상태 확인

운영자는 매일 다음을 확인한다.

- runtime alive 여부와 마지막 heartbeat
- 현재 모드: dry-run, heartbeat-only, live armed, live order capable
- live enabled 여부와 주문 가능 여부
- key scope 안전성, forbidden scope 감지 여부
- readiness: M20 inbound, M16 reconcile, M17 PnL, M18 decision ledger, M19 exit engine
- 최신 reconcile 시각과 상태
- 최신 candidate, decision, risk/cost/gate 차단 사유
- 최신 order attempt, 주문 제출/취소/취소 확인/체결/부분체결 상태
- budget used, daily notional, open exposure, realized/unrealized PnL
- kill switch/manual review 상태
- Telegram alert retry/cooldown/manual review 상태

사용자-facing 표면은 한국어 상태, 원인, 영향, 필요 조치를 먼저 보여주고 내부 id, idempotency key, evidence id, fingerprint는
`추적 정보`에 분리해야 한다.

## 중지 절차

정상 종료:

1. supervisor 또는 runner에 `SIGTERM`을 보낸다.
2. 마지막 event log와 summary/report artifact가 생성됐는지 확인한다.
3. open order와 open exposure를 status/reconcile로 확인한다.

Operator stop:

1. Telegram 또는 local control로 pause/kill 절차를 실행한다.
2. 신규 entry가 차단됐는지 status와 audit evidence로 확인한다.
3. Upbit 웹 또는 read-only order lookup으로 미체결 주문 상태를 수동 확인한다.

Kill switch/manual review:

1. 신규 entry가 fail-closed 됐는지 확인한다.
2. pending cancel이 필요한 경우 자동 시장가 청산이 아니라 정책화된 취소 또는 수동 확인으로 진행한다.
3. manual review evidence와 필요한 운영자 조치를 daily report에 남긴다.

손실 ceiling:

- 누적 realized loss + 미체결 노출 합계가 50,000 KRW에 도달하기 전에 operator stop 또는 kill switch/manual review로 전환한다.
- 이 ceiling은 M24 예산 확대 승인이 아니다.

## Restart Drill

restart drill은 다음 조건을 만족해야 한다.

- restart 전후 같은 idempotency key 또는 order attempt가 duplicate live order를 만들지 않는다.
- durable reservation, reconcile snapshot, status summary가 재사용된다.
- 최신 heartbeat와 daily report가 재개된다.
- Telegram에는 restart 감지와 복구 상태가 구분되어 표시된다.

restart 전후 event log가 준비되면 다음 validator를 실행한다. 이 명령은 artifact를 읽는 검증 경계이며 Upbit/Telegram/DB API를
직접 호출하지 않는다.

```sh
SEEMIRAI_RUN_M23_RECOVERY_DRILL=1 \
node scripts/run-m23-recovery-drill.mjs \
  --before-event-log "$M22_HOME/artifacts/m23-before-restart-events.jsonl" \
  --after-event-log "$M22_HOME/artifacts/m23-after-restart-events.jsonl" \
  --backup-restore-status blocked \
  --backup-restore-evidence "restore-db-not-provisioned-YYYY-MM-DD" \
  --artifact-dir "$SEEMIRAI_M22_ARTIFACT_DIR" \
  --json
```

`--backup-restore-status`는 `passed` 또는 `blocked`만 closeout 준비 evidence로 인정한다. `blocked`를 사용할 때는 disposable
restore DB가 없었던 이유, 필요한 권한, 재시도 계획을 `--backup-restore-evidence`가 가리키는 redacted 운영 기록에 남겨야 한다.
CI와 PR 검증에서는 다음 fixture smoke만 실행해 validator contract가 live side effect 없이 동작하는지 확인한다.

```sh
node scripts/run-m23-recovery-drill.mjs --fixture-smoke --json
```

## 장애 Drill

다음 장애는 신규 entry fail-closed와 alert/manual review evidence로 수렴해야 한다.

- Upbit 점검 또는 장애
- market warning/caution
- stale data 또는 WebSocket gap
- REST/API 오류와 rate limit
- Telegram provider 장애 지속
- DB write 또는 audit append 실패
- reconcile mismatch, duplicate order, untracked fill

M23 recovery drill validator는 `upbit_maintenance`, `market_warning`, `stale_data` 세 scenario가 `ENTRY_BLOCKED`,
`NEW_ORDERS_BLOCKED`, `MANUAL_REVIEW_REQUIRED` 중 하나로 수렴하고 alert evidence id를 남겼는지 확인한다. REST/API 오류,
rate limit, Telegram provider 장애, DB write/audit 실패는 closeout에서 같은 형식의 별도 incident/drill evidence로 보강한다.

## DB Backup/Restore Smoke

disposable restore DB가 준비된 경우 다음을 실행한다.

```sh
SEEMIRAI_DATABASE_URL=<source-db> \
SEEMIRAI_RESTORE_DATABASE_URL=<disposable-restore-db> \
./scripts/db-backup-restore-smoke.sh
```

실행할 수 없으면 closeout에 blocker, 필요한 DB 권한, restore target 준비 상태, 재시도 계획을 남긴다. 실행하지 못한 drill을 pass로
표시하지 않는다.

## 7일 closeout

closeout에는 redacted artifact 기준으로 다음을 기록한다.

- 7일 연속 daily report
- live-armed 설정 evidence와 key scope evidence
- candidate 없음, gate 차단, 시장 조건 미충족 등 주문이 없었던 날의 이유 evidence
- 주문 제출/취소/체결/부분체결/차단 event summary
- restart/reconcile/status 복구 evidence
- Telegram lifecycle/trade event alert와 retry/manual review evidence
- DB backup/restore smoke 결과 또는 blocker
- source scan 결과
- crash 0회
- unhandled rejection 0회
- risk gate 우회 주문 0건
- reconcile mismatch 0건
- duplicate order 0건
- untracked fill 0건
- live order cleanup failure 0건

live canary 1회 성공, dry-run, heartbeat-only만으로 M23 완료를 선언하지 않는다.
