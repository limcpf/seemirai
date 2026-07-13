# Issue #188 M23 구현 closeout과 24/7 운영 회고 감사

- 상태: Issue #188 구현 closeout `PASS`, production 24/7 안정성 관측 `PASS`, M23 7일 artifact validator `PARTIAL`
- Issue: [#188](https://github.com/limcpf/seemirai/issues/188)
- 구현 PR: [#194](https://github.com/limcpf/seemirai/pull/194)
- 운영 증거 기준 시각: 2026-07-10 23:36 KST

## 목표

Issue #188이 정의한 M23 live small-budget 운영 기능의 구현 종료 시점과, 이후 production `live:ops:daemon`에서 관측된 24/7 운영
증거를 하나의 문서로 연결한다. 이 문서는 최신 `main` 배포 여부를 Issue #188 종료 조건으로 소급 적용하지 않는다. 대신 이슈가 닫힌
당시의 기준선과 현재 실행 계보를 비교하고, 장기 실행 사실과 당시 closeout validator가 요구한 artifact 충족 여부를 분리해 판정한다.

## 판정 요약

| 판정 대상 | 결과 | 근거 |
| --- | --- | --- |
| Issue #188 구현 범위 | `PASS` | PR #194가 status, Telegram alert, recovery drill, 7일 closeout validator와 관련 문서를 `main`에 병합했다. |
| 실행 버전 계보 | `PASS` | Issue 종료 기준선 `962a5ad`는 production daemon worktree의 관측 HEAD `c837e74`의 ancestor다. 두 커밋 사이는 213커밋이며 후속 production 구현을 포함한다. |
| 24/7 process 안정성 관측 | `PASS` | 2026-06-24 00:02 KST부터 2026-07-10 23:36 KST까지 약 16일 23시간 연속 실행했고 필수 failure counter가 0이다. |
| 실제 주문 가능 arm 전제 | `PASS` | `LIVE_AUTONOMOUS_SMALL_BUDGET`, `KRW-BTC`, credential configured, 자산조회/주문조회/주문하기 scope, broker guard ready를 확인했다. |
| M23 7일 artifact validator | `PARTIAL` | 연속 실행과 DB 시계열은 확인됐지만 7개 daily report, 일별 durable decision evidence, 실제 restart drill, backup/restore artifact가 없다. |

따라서 Issue #188의 GitHub 종료와 구현 완료는 유지한다. 다만 이 결과를 `scripts/run-m23-stability-closeout.mjs`의 실제 manifest
`PASS`로 바꾸어 기록하거나, 이를 근거로 M24 budget/universe 확대를 자동 승인하지 않는다.

## 역사적 기준선

| 시각 | 사건 | 기준 |
| --- | --- | --- |
| 2026-06-14 13:43:43 KST | PR #194 merge commit 생성 | `962a5ad2c5ccf8ac728679ef0ec2df9e0e5841ca` |
| 2026-06-14 13:43:44 KST | PR #194 병합 | `Closes #188` |
| 2026-06-14 13:43:45 KST | Issue #188 종료 | GitHub state `closed`, reason `completed` |
| 2026-06-24 00:02:38 KST | production daemon 시작 | Issue #206 production successor 경로 |
| 2026-06-24 00:06:10 KST | 관측 worktree HEAD `c837e74` 생성 | 직전 `6e44da7` 대비 문서만 변경, 실행 코드 변경 없음 |

`git merge-base --is-ancestor 962a5ad c837e74`는 성공한다. daemon 시작 뒤 4분 후 생성된 `c837e74`는 문서 전용 커밋이므로,
시작 시점의 실행 코드와 현재 worktree 사이에 이 커밋으로 인한 코드 차이는 없다. startup status에 commit SHA가 내장돼 있지는 않아 정확한
loaded tree를 artifact 자체로 증명하지 못한 점은 잔여 provenance 리스크로 남긴다.

최신 `main`과 daemon worktree의 차이, migration 14의 부재, `live_decision_ticks` 미적용은 2026-06-14에 고정된 Issue #188의 구현
종료 조건이 아니다. daemon DB migration 13은 실행 중인 source tree가 기대하는 최신 version 13과 일치한다.

## Production 24/7 증거

저장소 밖 status artifact
`/home/lim/vaults/99_운영/seemirai-live-ops-production/issue-206/artifacts/live-ops-daemon-status.json`에서 secret과 raw provider
payload를 제외한 필드만 확인했다.

운영 상태:

- process 시작: 2026-06-24 00:02:38 KST
- latest tick 관측: 2026-07-10 23:36 KST
- mode: `LIVE_AUTONOMOUS_SMALL_BUDGET` / 사용자 표면 `소액 실운영`
- market: `KRW-BTC`
- fixture smoke: `false`
- broker guard: ready, credential configured, violation 0건
- key scope: 자산조회, 주문조회, 주문하기
- 예산: 1회 10,000 KRW, 일일 30,000 KRW, open position 30,000 KRW, 중지 ceiling 49,999 KRW
- 최신 판단: `HOLD`, 주문 후보 0건, 추적 사유 `autonomous_24x7_entry_signal_weak`
- 최신 tick의 `liveOrderCapable=false`는 disarm이 아니라 주문 후보가 없어 제출 단계가 열리지 않았다는 뜻이다.
- open exposure 0 KRW, budget used 0 KRW, manual review `false`

counter snapshot:

| counter | 값 |
| --- | ---: |
| tick | 363,534 |
| success | 361,863 |
| hold | 361,863 |
| transient failure | 1,665 |
| block | 6 |
| submitted order | 0 |
| manual review | 0 |
| crash | 0 |
| unhandled rejection | 0 |
| duplicate order | 0 |
| reconcile mismatch | 0 |
| untracked fill | 0 |
| live order cleanup failure | 0 |

`transient failure`와 `block`은 0 조건이 아니다. 장기 실행 중 재시도 또는 fail-closed로 회복한 횟수이며, process crash나 manual
review로 수렴하지 않았다.

## 최근 7일 DB 연속성

2026-07-03부터 2026-07-09까지 완료된 7개 KST 날짜를 조회했다. 아래 수치는 redacted aggregate이며 주문 payload, account id,
credential, raw provider body를 포함하지 않는다.

| KST 날짜 | trades | orderbook metrics | audit events | risk events | reconcile completed | orders | fills | daily report jobs | decision frames |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-07-03 | 25,994 | 73,850 | 19,977 | 39 | 2,541 | 0 | 0 | 0 | 0 |
| 2026-07-04 | 23,909 | 70,444 | 18,127 | 64 | 2,503 | 0 | 0 | 0 | 0 |
| 2026-07-05 | 22,558 | 70,303 | 16,855 | 39 | 2,504 | 0 | 0 | 0 | 0 |
| 2026-07-06 | 24,327 | 56,303 | 18,689 | 1,032 | 2,068 | 0 | 0 | 0 | 0 |
| 2026-07-07 | 28,466 | 73,053 | 20,916 | 37 | 2,560 | 0 | 0 | 0 | 0 |
| 2026-07-08 | 28,311 | 72,738 | 20,973 | 56 | 2,545 | 0 | 0 | 0 | 0 |
| 2026-07-09 | 22,846 | 74,855 | 17,349 | 64 | 2,494 | 0 | 0 | 0 | 0 |
| 합계 | 176,411 | 491,546 | 132,886 | 1,331 | 17,215 | 0 | 0 | 0 | 0 |

17,215개 reconcile run은 모두 `COMPLETED`였고 `live_reconcile_mismatch_evidence`는 0건이었다. 1,331개 risk event는 모두
`market_data_disconnected` / `ERROR` / `BLOCK_NEW_ORDERS`로 수렴했다. 이는 데이터 연결 장애가 신규 주문 차단으로 닫힌 실제
fail-closed 증거다.

반면 `report.daily` job과 `decision_ledger_frames`가 7일 모두 0건이다. latest status는 현재 주문하지 않은 이유를 설명하지만 파일이
매 tick 덮어써지므로 일별 durable decision evidence나 daily report를 대체하지 못한다.

## Acceptance trace

| Issue #188 기준 | 판정 | 근거 또는 미충족 항목 |
| --- | --- | --- |
| status/CLI/Telegram/report safe summary 구현 | `PASS` | PR #194 구현과 테스트, 현재 production status의 mode/readiness/heartbeat/decision/budget 표면 |
| live-armed 7일 이상 운영 | `PASS` | 약 16일 23시간 연속 process와 7개 완료 KST 날짜의 DB 시계열 |
| 주문이 없었던 날의 이유 | `PARTIAL` | latest `HOLD` 이유는 확인되지만 일별 durable evidence가 없다. |
| 7일 연속 daily report | `미충족` | `report.daily` job과 실제 M23 segment report가 0건이다. |
| restart 후 reconcile/status/daily report 복구 | `미검증` | process가 시작 뒤 재시작되지 않았고 실제 recovery summary가 없다. |
| Telegram lifecycle/trade event 운영 전송 | `PARTIAL` | mapper/formatter 구현은 완료됐지만 이번 무주문 구간의 lifecycle delivery artifact가 없다. |
| DB backup/restore | `BLOCKED` | `pg_dump`, `pg_restore`, `psql` CLI와 disposable restore DB URL이 준비되지 않았다. |
| 장애 시 신규 entry fail-closed | `PASS` | 1,331개 market data disconnect가 모두 `BLOCK_NEW_ORDERS`로 기록됐다. |
| 필수 failure counter 0 | `PASS` | crash, unhandled rejection, duplicate order, reconcile mismatch, untracked fill, cleanup failure 모두 0이다. |
| 실제 M23 closeout manifest validator | `미충족` | 2026-07-06 fixture smoke만 통과했고 실제 manifest와 7개 segment artifact는 없다. |

## DB backup/restore blocker

2026-07-10 기준 운영 호스트에 `pg_dump`, `pg_restore`, `psql`이 없고 `SEEMIRAI_RESTORE_DATABASE_URL`도 설정되지 않았다.

필요 외부 조건:

- 운영 DB major version과 호환되는 PostgreSQL client 설치
- production과 다른 disposable restore DB 준비
- restore DB에 schema reset, TimescaleDB pre/post restore, migration history 조회가 가능한 권한 부여

재시도 계획:

```sh
SEEMIRAI_DATABASE_URL=<source-db> \
SEEMIRAI_RESTORE_DATABASE_URL=<disposable-restore-db> \
./scripts/db-backup-restore-smoke.sh
```

실행 전에는 `blocked`를 `passed`로 바꾸지 않는다.

## 검증

Issue #188 구현 PR #194는 merge 전 다음 결과를 기록했다.

- `./scripts/verify`: 89 files passed, 11 skipped, 1,452 tests passed, 114 skipped
- Sub PR #189-#193 review drain 완료
- GitHub `verify` pass, unresolved thread 0, Codex clean signal

이 회고 closeout PR에서는 다음 명령을 다시 실행한다.

```sh
corepack pnpm typecheck
corepack pnpm test
./scripts/verify docs
./scripts/verify
git diff --check
```

최종 worktree 검증 결과:

- `./scripts/verify docs` 통과: 문서 76개, 매니페스트 93개, 링크 256개
- `corepack pnpm typecheck` 통과
- `corepack pnpm test` 통과: 108 files passed, 12 skipped, 2,083 tests passed, 116 skipped
- `./scripts/verify` 통과: docs, hooks, GitHub 운영 파일, typecheck, test 전체 성공
- `git diff --check` 통과
- broad source scan에서 이번 diff의 주문/출금/secret 관련 일치는 mode, 금지 정책, redaction 설명뿐이며 secret 원문이나 신규 주문
  side effect는 추가하지 않았다.

실제 24/7 process를 중지하거나 production DB에 write하는 smoke는 이 문서 PR에서 실행하지 않는다.

## 결정 로그

- 2026-07-10: Issue #188 종료 기준은 최신 `main`이 아니라 PR #194 merge commit `962a5ad`와 당시 acceptance criteria로 고정했다.
- 2026-07-10: production successor가 역사적 기준선을 포함하므로 최신 `main`보다 뒤라는 이유만으로 재배포 또는 재시작하지 않는다.
- 2026-07-10: 16일 이상 연속 실행과 필수 failure counter 0을 안정성 관측 증거로 인정한다.
- 2026-07-10: 덮어쓰는 latest status와 DB aggregate를 7개 daily report/decision segment로 소급 변환하지 않는다.
- 2026-07-10: Issue #188 구현 closeout과 M23 실제 artifact validator PASS를 분리한다.

## 남은 리스크와 후속 작업

- daily report scheduler 또는 동등한 production report 경로에서 7개 연속 report artifact를 생성해야 한다.
- 주문이 없는 날의 `HOLD`/`BLOCK` 이유를 일별 durable evidence로 보존해야 한다.
- 실제 process restart 뒤 reconcile/status/report/Telegram 복구 drill을 실행해야 한다.
- DB backup/restore blocker를 해소하고 disposable restore smoke를 실행해야 한다.
- 위 artifact를 실제 manifest로 묶어 `scripts/run-m23-stability-closeout.mjs`를 통과하기 전에는 M23 operational `PASS`와 M24 확대를 선언하지 않는다.
- 다음 daemon 시작 artifact에는 source commit SHA를 포함해 startup provenance를 추정이 아니라 기계적 증거로 남기는 것이 바람직하다.
