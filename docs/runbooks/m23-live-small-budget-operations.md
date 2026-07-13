# M23 live small-budget 7일 운영 runbook

이 runbook은 Issue #188의 `LIVE_AUTONOMOUS_SMALL_BUDGET` 24/7 운영 안정화 절차다. 목적은 수익 검증이 아니라 실제 주문 API를
호출할 수 있는 live-armed 상태에서 운영자가 상태, 판단 이유, 주문/취소/체결/차단, 중지/복구 evidence를 secret 없이 확인할 수
있게 하는 것이다.

Issue #206 production `live:ops` 실제 arm과 단일 submit/cancel cleanup 절차는 [`live-ops-real-arm-cleanup.md`](./live-ops-real-arm-cleanup.md)를
따른다. 이 runbook의 7일 안정화는 cleanup evidence 이후 장기 운영 안정화를 닫는 기준으로 유지한다.

Issue #188 merge 뒤 도입된 production successor도 역사적 기준선 commit을 포함하고, 같은 mode/budget/key scope/fail-closed
invariant를 증명하면 장기 process 안정성의 보조 증거로 사용할 수 있다. 이 경우에도 덮어쓰는 latest status나 DB aggregate를 7개
daily report와 일별 decision segment로 소급 변환하지 않는다. successor evidence 해석과 2026-07-10 회고 결과는
[`2026-07-10-issue-188-m23-live-ops-retrospective-closeout.md`](../exec-plans/completed/2026-07-10-issue-188-m23-live-ops-retrospective-closeout.md)를
따른다.

Issue #267 successor 전환은
[`2026-07-14-issue-267-production-baseline-m23-actual-closeout.md`](../exec-plans/active/2026-07-14-issue-267-production-baseline-m23-actual-closeout.md)를
따른다. 기존 daemon uptime과 DB aggregate는 pre-deploy baseline으로만 보존하고, migration 14와 source provenance가 확인된 새
startup 이후 완료된 KST 날짜부터 actual 7일 window를 계산한다. Issue #267은 아래 `Issue #267 production daemon 실행`의
`live:ops:daemon`만 사용한다. Issue #188 historical M22 runner/env/candidate 절차에서 만든 artifact는 #267 window에 포함하지 않는다.

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

## Issue #188 historical 사전 점검

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

## Issue #267 successor 전환 gate

다음 중지 전 gate가 모두 확인되기 전에는 기존 production daemon에 종료 신호를 보내지 않는다.

| 항목 | 확인 기준 |
| --- | --- |
| historical baseline | #206 cleanup artifact와 #188 구현 closeout을 변경하지 않고 참조한다. |
| pre-deploy snapshot | daemon 시작/관측 시각, source worktree HEAD, migration 13, failure counters, open order/exposure 0을 redacted artifact로 고정한다. |
| rollout source | Sub PR 02까지 병합된 `issue-267-mother`의 40자리 source SHA를 기록한다. |
| config provenance | 운영 config 원문 대신 `sha256:<hex>` fingerprint만 startup/status에 남긴다. |
| migration preflight | migration 14 파일/checksum과 DB pending 상태를 확인하고 backup/restore 명령과 저장 위치를 준비한다. |
| rollback | migration 14를 인식하는 rollback source SHA 또는 검증된 pre-migration restore 절차를 기록한다. |

open order 또는 exposure가 하나라도 있으면 daemon을 멈추지 않고 operator stop/manual review로 전환한다. 0이 확인되면 신규 entry를
차단하고 같은 조회를 다시 통과한 뒤에만 `SIGTERM`을 보낸다. 정상 종료 후 terminal status와 daemon write 정지를 확인한 시점부터
중지 후 migration gate를 진행한다. 이 gate에서는 migration 직전 backup과 disposable restore preflight를 만들고 migration 14를
적용한 다음 새 daemon을 시작한다. startup/status의 source SHA, config/env fingerprint, expected/applied migration version이 rollout
입력과 다르면 신규 entry를 열지 않는다. 새 daemon에서 `live_decision_ticks` write와 `live_ops_db_window` source를 확인하고 실제
restart/recovery 및 disposable restore DB smoke를 통과한 뒤에만 7일 evidence window를 시작한다.

successor 7일 window에는 pre-deploy daemon 날짜를 포함하지 않는다. manifest `day`는 daily report `reportDate` 및 durable decision
evidence의 KST day와 같아야 하며, 해당 KST window가 종료된 뒤 생성된 artifact여야 한다. latest status나 aggregate query로 누락
artifact를 소급 생성하지 않는다.

Issue #267 actual manifest는 기존 Issue #188 blocker 호환 규칙을 사용하지 않는다. backup/restore `blocked`는 실패이며, startup과
각 segment의 source SHA, config/env fingerprint, expected/applied migration 14가 일치해야 한다. `scripts/run-m23-stability-closeout.mjs`는
Issue #267 manifest에서 이 계약, 각 segment 실행 구간이 daemon startup보다 앞서지 않는지, 완료 KST report/decision day를 직접
검증한다.

migration 14 적용 뒤에는 migration 13까지만 아는 pre-deploy source가 DB readiness에서 차단될 수 있다. rollback은 migration 14
파일/checksum을 포함하는 검증된 source SHA로 실행한다. pre-migration backup 복원은 successor가 broker side effect를 만들기
전까지만 허용한다. 현재 daemon을 정상 종료하고 private read/reconcile로 open order/exposure 0과 terminal 상태를 다시 확인하며,
post-migration DB를 별도 backup으로 보존한 뒤 schema/version 일치를 확인해야 한다. successor가 한 번이라도 주문/체결 side effect를
만들었거나 open order/exposure가 남아 있으면 pre-migration restore를 금지하고 migration 14 호환 source로 복구한다.

## Issue #267 production daemon 실행

Issue #267 successor는 M22 pilot wrapper, 수동 candidate JSONL, `SEEMIRAI_RUN_M22_*`, `SEEMIRAI_RUN_UPBIT_*_SMOKE`,
`SEEMIRAI_PILOT_PROFILE`을 사용하지 않는다. production 명령은 명시 source SHA, config/env fingerprint, expected/applied migration 14를
startup 전에 검증하며 source worktree가 dirty이면 시작하지 않는다.

배포 SHA와 저장소 밖 config/env/status 경로를 고정한 뒤 production package entry로 실행한다.

```sh
cd <issue-267-successor-worktree>
ISSUE_267_HOME="$HOME/vaults/99_운영/seemirai-live-ops-production/issue-267"
SOURCE_SHA="$(git rev-parse HEAD)"
RUN_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"

corepack pnpm live:ops:daemon -- \
  --config "$ISSUE_267_HOME/live-ops.config.json" \
  --env-file "$ISSUE_267_HOME/live-ops.env" \
  --source-commit-sha "$SOURCE_SHA" \
  --startup-artifact-file "$ISSUE_267_HOME/artifacts/live-ops-daemon-startup-$SOURCE_SHA-$RUN_ID.json" \
  --status-file "$ISSUE_267_HOME/artifacts/live-ops-daemon-status.json" \
  --tui
```

`--source-commit-sha`와 `--startup-artifact-file`은 successor production 실행의 필수 계약이다. `SOURCE_SHA`는 Sub PR 02까지
병합된 40자리 rollout SHA와 같아야 한다. startup/status provenance가 이 값과 다르거나 migration 14가 아니면 process를
live-armed로 재개하지 않는다. `RUN_ID`는 같은 SHA로 재시작할 때도 기존 create-only artifact와 충돌하지 않게 실행마다 새로 만든다.
7일 입력은 이 daemon과 DB scheduler가 자동 생성한 completed KST daily report,
`live_decision_ticks`, immutable day artifact만 사용한다. latest status 복사본, M22 pilot summary, 수동 candidate artifact는 #267
actual evidence가 아니다.

### 2026-07-14 실제 rollout 기준선

Issue #267 production은 다음 기준선으로 실행 중이다.

| 항목 | 실제 값 |
| --- | --- |
| production home | `~/vaults/99_운영/seemirai-live-ops-production/issue-267` |
| source SHA | `3d48665967b79fbbbf59dd316ec30f61662df12e` |
| startup artifact | `artifacts/live-ops-daemon-startup-3d48665967b79fbbbf59dd316ec30f61662df12e-ee053bc3-1fef-455f-abcd-bfa9fb877840.json` |
| latest status | `artifacts/live-ops-daemon-status.json` |
| supervisor PID | `artifacts/live-ops-daemon.pid` |
| pre-migration rollback backup | `backups/pre-migration-13-20260713t195156015z.dump` |
| post-migration backup | `backups/post-migration-14-20260713t200208187z.dump` |
| rollout summary | `artifacts/production-rollout-summary-20260713T201628533Z.json` |

config는 `live-ops.config.json`, env는 `live-ops.env`에 두며 startup/status에는 각각 secret-free SHA-256 fingerprint만 남긴다.
pre/post-migration backup은 PostgreSQL 16 client와 disposable DB에서 migration 13/14 및 TimescaleDB extension 복원을 각각
통과했다. disposable DB는 증거 생성 뒤 제거했으며 dump와 redacted verification artifact는 보존한다.

현재 host에서는 shell session 종료와 독립된 supervisor가 필요하므로 `setsid -f`로 package entry를 시작하고 내부 shell이 자기
PID를 `live-ops-daemon.pid`에 기록한 뒤 `corepack pnpm live:ops:daemon`으로 `exec`한다. PID, log, status, backup, artifact는
운영 계정만 읽도록 mode `600`을 유지한다. 중지할 때는 먼저 durable kill switch를 `NEW_ORDERS_BLOCKED`로 전이하고 private
open order/exposure 0을 확인한 뒤 daemon leaf에 `SIGTERM`을 보낸다.

현재 rollout source는 signal 종료 시 status file을 terminal payload로 바꾸는 handler가 없으므로 process tree exit와 status write
정지를 별도 terminal artifact로 확인한다. stale `running` status만으로 process 생존을 주장하지 않고 PID 생존, 마지막 write 시각,
private exposure를 함께 대조한다.

첫 successor run의 public market data disconnect는 다음 tick에서 복구됐지만 actual window의 failure counter 0 조건에는 포함할 수
없다. 해당 run은 `pre-window-daemon-terminal-20260713T201212198Z.json`으로 보존했다. 첫 KST counter boundary 전에도 failure
counter가 하나라도 증가하면 신규 주문 차단, private open order 0, exposure ceiling을 재확인한 뒤 같은 rollout source로 clean
restart하고 새 startup artifact를 사용한다. startup 당일은 full KST day가 아니므로 2026-07-14를 제외하고
2026-07-15~2026-07-21을 7개 후보 날짜로 사용한다. earliest closeout은 `2026-07-22T00:00:00+09:00`이다.

### Issue #267 일별 evidence scheduler

7일 뒤 latest status와 DB aggregate를 소급 변환하지 않는다. `scripts/run-m23-production-day-closeout.mjs`는 완료된 KST 하루마다
daemon 연속 실행/PID/heartbeat, 현재 config/env 원문 fingerprint와 startup provenance 일치, KST 시작/종료 counter delta, 대상
strategy의 full-day durable decision, 실제 broker 제출/guarded decision/terminal cleanup 또는 SELL 재호가 counter와 BUY entry
reservation 일치, Upbit private open
order/BTC exposure, KST day 종료 뒤 생성된 daily report와 Telegram delivery audit을 검증한다. daily report에는 같은 closeout 시점의
M23 후보/판단/주문/노출 상태를 포함한다. 검증된 summary는
`production-day-YYYY-MM-DD.json` create-only artifact로 기록한다. 실패 시 final day 파일을 점유하지 않고 실패 분류만 별도
artifact로 남긴다.

Sub PR 04가 mother branch에 merge된 뒤 첫 day boundary 전에 daemon failure counter를 다시 확인한다. 모두 0이면 daemon을 유지하고,
0이 아니면 위 clean restart 절차를 수행한다. 그 다음 현재 status가 가리키는 startup artifact로 scheduler를 별도 session에서 실행한다.

```sh
cd /home/lim/code/seemirai-worktrees/issue-267-mother
ISSUE_267_HOME="$HOME/vaults/99_운영/seemirai-live-ops-production/issue-267"
SOURCE_SHA="3d48665967b79fbbbf59dd316ec30f61662df12e"
STARTUP_FILE="$(node -e 'const fs=require("node:fs"); const p=process.argv[1]; process.stdout.write(JSON.parse(fs.readFileSync(p,"utf8")).startupArtifactFilePath)' "$ISSUE_267_HOME/artifacts/live-ops-daemon-status.json")"
SCHEDULER_RUN_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
umask 077
corepack pnpm build

setsid -f env \
  SEEMIRAI_RUN_M23_PRODUCTION_DAY_SCHEDULER=1 \
  SEEMIRAI_RUN_M23_PRODUCTION_DAY_CLOSEOUT=1 \
  node scripts/run-m23-production-day-scheduler.mjs \
  --first-day 2026-07-15 \
  --day-count 7 \
  --config "$ISSUE_267_HOME/live-ops.config.json" \
  --env-file "$ISSUE_267_HOME/live-ops.env" \
  --daemon-status-file "$ISSUE_267_HOME/artifacts/live-ops-daemon-status.json" \
  --startup-artifact-file "$STARTUP_FILE" \
  --daemon-pid-file "$ISSUE_267_HOME/artifacts/live-ops-daemon.pid" \
  --artifact-dir "$ISSUE_267_HOME/artifacts" \
  --expected-source-commit-sha "$SOURCE_SHA" \
  --scheduler-status-file "$ISSUE_267_HOME/artifacts/production-day-scheduler-status.json" \
  --scheduler-event-log-file "$ISSUE_267_HOME/logs/production-day-scheduler-events.jsonl" \
  --scheduler-pid-file "$ISSUE_267_HOME/artifacts/production-day-scheduler.pid" \
  --json \
  >> "$ISSUE_267_HOME/logs/production-day-scheduler-$SCHEDULER_RUN_ID.log" 2>&1
```

scheduler는 시작 시 daemon status/startup provenance와 supervisor PID를 먼저 확인한다. 각 KST day 시작과 종료 60초 안에
append-only daemon counter boundary를 남기고, 종료 60초 뒤 closeout을 시도한다. closeout 실패는 5분 간격으로 day별 최대 36회
재시도한다. 기존 report 생성은 `report.daily:<reportDate>`, 전달 복구는 `report.daily.delivery_recovery:<reportDate>` key를
사용하므로 process 재시작이나 수동 재실행이 Telegram 중복 전송으로 이어지지 않는다. 재시도 한도를 소진하면 다음 날짜로 넘어가지
않고 `failed`로 닫는다. 각 실패 시도는 provider 이전 precondition 실패도 별도 immutable failure artifact로 남긴다. 주간 손실은
`--first-day`부터 현재 기준일 직전까지 같은 source/config/env/migration provenance로 통과한 연속 day artifact만 합산한다. 같은
날짜의 일반 daily report가 먼저 완료됐으면 closeout actor/correlation이 있는 별도 recovery job으로 M23 상태 report를 한 번 전달한다.
boundary capture는 경계 직후의 status file write까지 확인해 경계를 걸친 tick의 counter를 이전 day에 포함한다. SELL cleanup의 제출
개수는 제출 시각, realized loss는 실제 `filledAt` KST day를 사용한다. artifact 경로는 symlink 실제 대상도 repository 밖이어야 한다.

```sh
cat "$ISSUE_267_HOME/artifacts/production-day-scheduler-status.json"
tail -n 20 "$ISSUE_267_HOME/logs/production-day-scheduler-events.jsonl"
kill -0 "$(cat "$ISSUE_267_HOME/artifacts/production-day-scheduler.pid")"
```

운영자가 scheduler만 중지할 때는 위 PID에 `SIGTERM`을 보낸다. 이 신호는 거래 daemon에 전달되지 않는다. status가 `stopped`인지
확인한 뒤 기존 PID 파일을 run ID가 포함된 evidence 이름으로 이동하고 같은 고정 PID 경로로 재실행한다. 고정 create-only PID
파일은 두 scheduler가 동시에 같은 Telegram report 경계를 호출하지 못하게 막는다. `production-day-YYYY-MM-DD.json`이 이미
`passed`면 closeout은 현재 source/config/env/migration provenance와 daemon counter boundary 일치를 먼저 확인한다. 모두 같을 때만
provider와 Telegram을 다시 호출하지 않고 기존 immutable artifact를 재사용한다.

## Issue #188 historical Live-Armed 실행

이 절의 M22 runner/env/candidate 절차는 Issue #188 historical 입력을 재현하기 위한 호환 경로다. Issue #267 successor 배포나
7일 actual window에는 사용하지 않는다.

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
운영 호스트에 복사한 뒤 `User`, `Group`, `WorkingDirectory`, `Environment=SEEMIRAI_M23_SEGMENT_ENV`, `ReadWritePaths`를 실제 운영
계정과 저장소/운영 artifact 경로로 맞춘다. 이 템플릿은 live daemon을 root가 아닌 운영 사용자로 실행하고, secret 값을 직접 담지
않으며, `run-24h-pilot.sh` wrapper가 저장소 밖 shell-format `m22.env`, `m22.keys.env`, `m23-segment.env`를 source하게 한다.
systemd `EnvironmentFile`은 `export`/조건문이 있는 shell env를 해석하지 못하므로 이 service에서는 사용하지 않는다. 정상 24시간
완료는 새 candidate 파일 rotate와 daily/open exposure env 갱신 handoff 뒤 supervisor 또는 timer가 다음 segment를 시작해야 하므로
`Restart=on-failure`로 실패 종료만 즉시 복구한다. system service에서는 `%h`가 운영 사용자 홈이 아니라 system manager 기준으로
해석될 수 있으므로 `/home/<운영사용자>/...` 같은 명시 경로를 사용한다. 재시작 후에는 아래 Restart Drill validator로 중복 주문,
reconcile/status 복구, daily report marker를 확인한다.

각 24시간 segment 시작 전에는 다음 handoff를 먼저 수행한다.

1. candidate producer를 멈추고 더 이상 기존 JSONL에 append되지 않는지 확인한다.
2. 이전 segment candidate file의 마지막 크기와 SHA-256을 artifact에 기록하고, 다음 segment는 새 JSONL 파일로 rotate한다.
3. 새 candidate file은 비어 있는 상태로 daemon을 먼저 시작한 뒤 producer를 재개한다. daemon 시작 전에 후보를 미리 넣어야 하는
   재현 작업만 `--candidate-start beginning`을 사용한다.
4. systemd service를 쓰면 `m23-segment.env`를 갱신해 `SEEMIRAI_M23_SEGMENT_CANDIDATE_FILE`이 이번 segment 전용 JSONL을 가리키게 한다.
   이 파일은 systemd `EnvironmentFile` 형식이 아니라 wrapper가 source하는 shell 형식이다.

```sh
export SEEMIRAI_M23_SEGMENT_CANDIDATE_FILE="$M22_HOME/candidates/m23-segment-YYYY-MM-DD.jsonl"
export SEEMIRAI_M23_SEGMENT_CANDIDATE_START="end"
```

5. M16 reconcile/status로 현재 open order, open exposure, realized loss를 확인하고 아래 env를 최신 safe summary 값으로 갱신한다.
   값을 확인할 수 없으면 segment를 시작하지 않고 manual review로 전환한다.

```text
SEEMIRAI_M22_INITIAL_DAILY_AUTONOMOUS_NOTIONAL_USED_KRW=<latest-safe-daily-notional>
SEEMIRAI_M22_INITIAL_OPEN_POSITION_NOTIONAL_KRW=<latest-safe-open-exposure>
SEEMIRAI_M22_DAILY_REALIZED_LOSS_KRW=<latest-safe-daily-realized-loss>
SEEMIRAI_M22_WEEKLY_REALIZED_LOSS_KRW=<latest-safe-weekly-realized-loss>
```

6. 누적 realized loss와 미체결 노출 합계가 50,000 KRW에 접근하면 다음 segment를 시작하지 않고 operator stop 또는 kill switch로
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
- durable reservation, reconcile snapshot, stable status summary evidence id가 재사용된다.
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

M23 recovery drill validator는 `upbit_maintenance`, `market_warning`, `stale_data`, `api_error` 네 scenario가
`ENTRY_BLOCKED`, `NEW_ORDERS_BLOCKED`, `MANUAL_REVIEW_REQUIRED` 중 하나로 수렴하고 alert evidence id를 남겼는지 확인한다.
Telegram provider 장애, DB write/audit 실패는 closeout에서 같은 형식의 별도 incident/drill evidence로 보강한다.

## DB Backup/Restore Smoke

disposable restore DB가 준비된 경우 다음을 실행한다.

```sh
SEEMIRAI_DATABASE_URL=<source-db> \
SEEMIRAI_RESTORE_DATABASE_URL=<disposable-restore-db> \
./scripts/db-backup-restore-smoke.sh
```

Issue #188 historical closeout에서 실행할 수 없으면 blocker, 필요한 DB 권한, restore target 준비 상태, 재시도 계획을 남긴다.
실행하지 못한 drill을 실제 restore 성공으로 표시하지 않는다. Issue #267 actual closeout은 blocker 호환을 사용하지 않으므로
disposable restore DB smoke가 실제로 통과하지 않으면 `PASS`가 아니다.

## 7일 closeout

closeout에는 redacted artifact 기준으로 다음을 기록한다.

- 7일 연속 daily report
- 각 segment의 startedAt/reportDate와 manifest day 일치 evidence
- 각 segment의 daemon heartbeat와 pilot command 정상 종료 evidence
- live-armed 설정 evidence와 key scope evidence
- 누적 realized loss와 미체결 노출 합계가 50,000 KRW 미만이라는 숫자 evidence
- candidate 없음, gate 차단, 시장 조건 미충족 등 주문이 없었던 날의 이유 evidence
- 주문 제출/취소/체결/부분체결/차단 event summary
- restart/reconcile/status 복구 evidence
- Telegram lifecycle/trade event alert와 retry/manual review evidence
- DB backup/restore smoke 결과. Issue #188 historical manifest만 blocker 기록을 허용하고, Issue #267은 `passed` 결과를 요구한다.
- source scan 결과
- crash 0회
- unhandled rejection 0회
- risk gate 우회 주문 0건
- reconcile mismatch 0건
- duplicate order 0건
- untracked fill 0건
- live order cleanup failure 0건

7일 closeout은 저장소 밖 manifest로 집계한다. manifest는 raw secret이 아니라 redacted evidence id와 artifact 경로만 포함해야 한다.
다음 예시는 Issue #188 historical 호환 형식이며 Issue #267 actual manifest로 사용하지 않는다.

```json
{
  "issue": 188,
  "mode": "LIVE_AUTONOMOUS_SMALL_BUDGET",
  "liveArmedEvidenceId": "m23-live-armed-YYYY-MM-DD",
  "keyScopeEvidenceId": "m23-key-scope-YYYY-MM-DD",
  "operatorArmEvidenceId": "m23-operator-arm-YYYY-MM-DD",
  "budgetEvidenceId": "m23-budget-YYYY-MM-DD",
  "segments": [
    {
      "day": "YYYY-MM-DD",
      "summaryPath": "m23-segment-YYYY-MM-DD-summary.json",
      "decisionEvidenceId": "m23-decision-YYYY-MM-DD",
      "dailyReportEvidenceId": "m23-daily-report-YYYY-MM-DD",
      "alertEvidenceIds": ["m23-alert-lifecycle-YYYY-MM-DD", "m23-alert-trade-YYYY-MM-DD"]
    }
  ],
  "recoveryDrillSummaryPath": "m23-recovery-summary.json",
  "backupRestore": {
    "status": "blocked",
    "evidenceId": "m23-db-restore-blocker-YYYY-MM-DD",
    "blockerReason": "disposable restore DB 미준비",
    "requiredOperatorAction": "restore target DB와 권한 준비",
    "retryPlanEvidenceId": "m23-db-restore-retry-plan-YYYY-MM-DD"
  },
  "sourceScan": {
    "evidenceId": "m23-source-scan-YYYY-MM-DD",
    "liveOrderApiGuarded": true,
    "marketBestOrderDefaultOpened": false,
    "withdrawalOrDepositPathOpened": false,
    "rawSecretExposure": false
  }
}
```

Issue #267 actual manifest는 다음 provenance/day 필드를 추가한다. 아래 provenance object는 startup artifact, manifest, segment record,
segment summary에서 byte 값 기준으로 같아야 한다.

```json
{
  "issue": 267,
  "mode": "LIVE_AUTONOMOUS_SMALL_BUDGET",
  "startupArtifactPath": "live-ops-daemon-startup-<source-sha>.json",
  "runtimeProvenance": {
    "sourceCommitSha": "<40자리-lowercase-git-sha>",
    "configFingerprint": "sha256:<64자리-lowercase-hex>",
    "envFingerprint": "sha256:<64자리-lowercase-hex>",
    "expectedMigrationVersion": 14,
    "appliedMigrationVersion": 14
  },
  "segments": [
    {
      "day": "YYYY-MM-DD",
      "summaryPath": "production-day-YYYY-MM-DD.json",
      "decisionEvidenceId": "decision-YYYY-MM-DD",
      "decisionEvidenceDay": "YYYY-MM-DD",
      "dailyReportEvidenceId": "daily-report-YYYY-MM-DD",
      "alertEvidenceIds": ["alert-YYYY-MM-DD"],
      "runtimeProvenance": {
        "sourceCommitSha": "<40자리-lowercase-git-sha>",
        "configFingerprint": "sha256:<64자리-lowercase-hex>",
        "envFingerprint": "sha256:<64자리-lowercase-hex>",
        "expectedMigrationVersion": 14,
        "appliedMigrationVersion": 14
      }
    }
  ],
  "recoveryDrillSummaryPath": "m23-recovery-summary.json",
  "backupRestore": {
    "status": "passed",
    "evidenceId": "db-backup-restore-YYYY-MM-DD"
  }
}
```

각 Issue #267 segment summary는 `input=live_ops_daemon_day`, `status=passed`, `startedAt`, `finishedAt`, `reportDate`,
`dailyReportGeneratedAt`, `decisionEvidenceDay`, `decisionEvidenceGeneratedAt`, 같은 `runtimeProvenance`를 포함한다. 실행 window는 해당
KST day 전체를 덮어야 하고 report/decision 생성 시각은 KST day 종료 이후여야 한다. `productionDaemonWindow`, `configSafety`,
`dbReadiness`, `heartbeat` check가 모두 `ok`가 아니면 actual closeout은 실패한다.

manifest와 7개 segment summary, recovery drill summary가 준비되면 다음 validator를 실행한다.

```sh
SEEMIRAI_RUN_M23_STABILITY_CLOSEOUT=1 \
node scripts/run-m23-stability-closeout.mjs \
  --manifest "$M22_HOME/artifacts/m23-stability-closeout-manifest.json" \
  --artifact-dir "$SEEMIRAI_M22_ARTIFACT_DIR" \
  --json
```

CI와 PR 검증에서는 실제 7일 운영을 시작하지 않고 fixture smoke만 실행한다.

```sh
node scripts/run-m23-stability-closeout.mjs --fixture-smoke --json
```

`scripts/run-m23-stability-closeout.mjs`의 Issue #188 historical 경로는 7개 이상의 서로 다른 day segment, 각 segment의 24시간 정상
종료, daily report, live-armed guard/readiness, decision evidence, closeout failure counter 명시적 0건, recovery drill,
DB backup/restore 결과 또는 blocker, source scan, raw secret 후보를 함께 확인한다. Issue #267 guarded 경로는 production
`live:ops:daemon` provenance, 완료 KST daily report/day decision evidence 일치와 `backupRestore.status=passed`를 추가로 강제한다.
7일 artifact가 없거나 manifest가 6일 이하이면 closeout은 실패다.

live canary 1회 성공, dry-run, heartbeat-only만으로 M23 완료를 선언하지 않는다.

production successor가 7일 이상 연속 실행됐더라도 actual manifest 입력을 충족하지 않으면 결과는 보조 안정성 evidence와 formal
artifact closeout으로 분리한다. process uptime과 failure counter 0은 전자를 뒷받침하지만 daily report, 일별 decision evidence,
restart/recovery, backup/restore 입력을 생략하게 하지는 않는다.
