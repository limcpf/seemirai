# Issue #267 production baseline 전환과 M23 actual closeout 실행 계획

- Issue: [#267](https://github.com/limcpf/seemirai/issues/267)
- mother branch: `issue-267-mother`
- 상태: Sub PR 01 mother merge 완료, Sub PR 02 runtime provenance 검증 중
- 시작일: 2026-07-14

## 목표

Issue #206의 실제 provider arm/cleanup 증적과 Issue #188의 구현 종료 기준선을 변경하지 않고, PR #265 계보의 decision history와
DB-backed feature를 production에 배포한다. 새 배포는 source commit SHA, secret-free config/env fingerprint, migration version을
startup/status evidence로 남기고, 배포 뒤 7개 연속 완료 KST 날짜의 daily report와 durable decision evidence를 실제 M23
validator 입력으로 사용한다.

완료 판정은 daemon 재시작이나 7일 uptime만으로 하지 않는다. migration 14, 실제 restart/recovery, disposable DB backup/restore,
failure counter 0, actual manifest `PASS`가 모두 필요하다.

## 기준선 분리

| 기준 | 고정 원칙 | 사용 범위 |
| --- | --- | --- |
| Issue #206 historical cleanup | 기존 submit/cancel terminal artifact와 당시 source 계보를 수정하거나 재생성하지 않는다. | 실제 provider arm 선행 증거 |
| Issue #188 구현 closeout | PR #194 merge commit `962a5ad`를 구현 종료 기준으로 유지한다. | 역사적 구현 완료 판정 |
| pre-deploy daemon | 중지 전에 시작/관측 시각, source worktree HEAD, migration 13, counters, open order/exposure를 redacted artifact로 고정한다. | successor 전환 전 상태 비교 |
| Issue #267 successor | Sub PR 02까지 mother branch에 병합된 명시 SHA와 migration 14를 배포한다. | 새 7일 evidence window의 source of truth |

pre-deploy 상태를 최신 기능의 실행 증거로 소급 변환하지 않는다. successor의 7일 evidence window는 migration 14와 provenance가
확인된 새 daemon startup 이후 처음 완료된 KST 날짜부터 시작한다.

## Sub PR 계획

### Sub PR 01. Baseline contract

- branch: `issue-267/01-baseline-contract`
- 목표: 역사적 기준선, successor 배포 gate, rollback/closeout DnD를 문서로 고정한다.
- 제외 범위: runtime 코드, production process 중지, migration/DB write, 실제 backup/restore.
- DnD:
  - [x] #206/#188/pre-deploy/successor 기준이 분리돼 있다.
  - [x] 4개 sub PR의 파일 책임, 순서, 검증, merge gate가 기록돼 있다.
  - [x] migration 전 backup, restart fail-closed, 7일 신규 window, M24 확대 금지가 명시돼 있다.
  - [x] `./scripts/verify docs`, `git diff --check`가 통과한다.

### Sub PR 02. Runtime provenance

- branch: `issue-267/02-runtime-provenance`
- 선행 조건: Sub PR 01 mother merge.
- 목표: daemon startup/status와 Issue #267 actual manifest에 source SHA, config/env fingerprint, migration version을 secret 없이 남긴다.
- 파일 책임: `scripts/run-live-ops-daemon*.mjs`, `scripts/run-m23-stability-closeout.mjs`, 관련 `src/runtime/` contract,
  단위/soak 테스트, runtime/reliability/security 문서.
- 제외 범위: production migration 실행, daemon 재시작, 7일 closeout 판정.
- DnD:
  - [x] production source SHA는 40자리 Git commit으로 검증되고 현재 clean 배포 tree와 일치한다.
  - [x] config/env fingerprint는 입력 원문 없이 각각 `sha256:<hex>`만 저장한다.
  - [x] migration version은 DB readiness가 관측한 expected/applied version을 보존한다.
  - [x] startup artifact와 최신 status가 같은 provenance를 가진다.
  - [x] provenance 생성 실패 또는 source/config/env/migration 불일치는 live startup/tick을 fail-closed 한다.
  - [x] Issue #267 actual manifest는 startup provenance와 각 segment provenance의 일치를 검증한다.
  - [x] Issue #267 actual manifest는 backup/restore `blocked`를 `PASS` 입력으로 인정하지 않는다.
  - [x] manifest `day`, daily report `reportDate`, decision evidence KST day가 일치하고 완료된 KST window인지 검증한다.
  - [x] 관련 unit/script 테스트, typecheck, 전체 verify가 통과한다.

### Sub PR 03. Production rollout

- branch: `issue-267/03-production-rollout`
- 선행 조건: Sub PR 02 mother merge와 clean review drain.
- 목표: pre-deploy baseline을 고정하고 migration 14와 successor daemon restart/recovery를 실제 production에서 검증한다.
- 파일 책임: rollout/recovery runbook, active plan 상태, 저장소 밖 redacted operational artifact.
- 제외 범위: threshold/profile 변경, BTC 외 market, 예산 확대, 과거 artifact 재작성.
- DnD:
  - [ ] 기존 daemon 정상 중지 전 open order/exposure, failure counter, migration 13 baseline이 저장됐다.
  - [ ] daemon 신규 write 차단과 정상 종료 뒤 migration 전 backup을 만들었고 migration 14 pending/checksum drift가 없다.
  - [ ] 새 daemon이 명시 source SHA/config/env fingerprint/migration 14로 시작됐다.
  - [ ] `live_decision_ticks` write와 `live_ops_db_window` 우선 사용이 실제 DB/status에서 확인됐다.
  - [ ] restart 뒤 reconcile/status/report/Telegram이 복구되고 duplicate live order가 0이다.
  - [ ] disposable restore DB backup/restore smoke가 통과한다.

### Sub PR 04. Actual closeout

- branch: `issue-267/04-actual-closeout`
- 선행 조건: successor startup 이후 7개 연속 완료 KST 날짜.
- 목표: actual manifest를 `PASS`로 닫고 closeout 문서와 기술 부채 상태를 갱신한다.
- 파일 책임: completed closeout, M23/M24 plan, requirements/product/runbook, index/context map, tech debt tracker.
- 제외 범위: M24 budget/universe 확대 승인.
- DnD:
  - [ ] 7개 날짜 모두 daily report와 durable decision evidence가 있다.
  - [ ] crash, unhandled rejection, duplicate order, reconcile mismatch, untracked fill, cleanup failure가 0이다.
  - [ ] 실제 recovery drill과 backup/restore evidence가 manifest에 연결돼 있다.
  - [ ] guarded actual validator가 `PASS`다.
  - [ ] 전체 typecheck/test/verify와 finish-readiness-audit가 통과한다.

## Rollout gate

1. pre-deploy daemon 상태와 #206 cleanup artifact를 redacted baseline으로 저장한다.
2. source SHA, config/env fingerprint, 현재 migration 13, open order/exposure 0, rollback commit을 교차 확인한다. open order 또는 exposure가
   있으면 daemon을 중지하지 않고 operator stop/manual review로 전환한다.
3. 신규 entry를 차단하고 open order/exposure 0을 다시 확인한 뒤에만 기존 daemon에 `SIGTERM`을 보낸다.
4. terminal status와 daemon write 정지를 확인해 중지 후 migration gate를 연다.
5. daemon write가 멈춘 상태에서 migration 직전 DB backup을 만들고 disposable restore preflight로 복구 가능성을 확인한다.
6. migration 14를 적용하고 pending/checksum drift가 없는지 확인한다.
7. Sub PR 02가 병합된 mother SHA로 build한 daemon을 같은 config/env와 보수적 budget으로 시작한다.
8. startup/status provenance, decision history, DB-backed feature source를 확인한다.
9. 실제 restart drill과 backup/restore smoke를 닫은 뒤 7일 evidence window를 시작한다.

어느 단계든 source/migration 불일치, open order, mismatch, untracked fill, Telegram owner alert 장기 실패가 확인되면 신규 entry를
재개하지 않는다. migration 14 적용 뒤 rollback source는 migration 14 파일/checksum을 포함하고 readiness를 통과하는 명시 SHA여야 한다.
migration 13까지만 아는 pre-deploy source를 migration 14 DB에 직접 실행하지 않는다. pre-migration backup 복원은 successor가 broker
side effect를 만들기 전까지만 허용한다. current daemon 정상 종료, private read/reconcile 기준 open order/exposure 0과 terminal 상태,
post-migration DB 별도 backup을 모두 확인한 뒤 복원하고 schema/version 일치를 검증한다. successor 주문/체결 side effect가 한 번이라도
있었거나 open order/exposure가 남아 있으면 restore를 금지하고 migration 14 호환 source로 복구한다.

## 검증 방법

```sh
corepack pnpm typecheck
corepack pnpm test
./scripts/verify docs
./scripts/verify
git diff --check
```

운영 검증은 저장소 밖 redacted artifact만 사용한다.

```sh
SEEMIRAI_RUN_M23_STABILITY_CLOSEOUT=1 \
  node scripts/run-m23-stability-closeout.mjs \
  --manifest <저장소-밖-redacted-manifest> \
  --json

SEEMIRAI_DATABASE_URL=<source-db> \
SEEMIRAI_RESTORE_DATABASE_URL=<disposable-restore-db> \
  ./scripts/db-backup-restore-smoke.sh
```

## 결정 로그

- 2026-07-14: Issue 본문의 4개 sub PR 분할을 순차 실행 계획으로 채택했다.
- 2026-07-14: 기존 16일 이상 uptime은 역사적 보조 증거로 유지하고 successor의 7일 daily/decision window에 포함하지 않는다.
- 2026-07-14: production rollout source는 Sub PR 02까지 병합된 `issue-267-mother`의 명시 SHA로 고정한다.
- 2026-07-14: migration 14 적용과 production restart는 Sub PR 02 review drain/merge 전에는 실행하지 않는다.
- 2026-07-14: actual M23 validator `PASS` 전에는 M24 profile, universe, budget을 확대하지 않는다.
- 2026-07-14: 기존 validator의 backup blocker 허용과 startedAt 기반 day 판정은 Issue #267 actual contract로 사용하지 않는다.

## 남은 이슈

- production 호스트의 PostgreSQL client와 disposable restore DB 준비 상태를 Sub PR 03에서 다시 확인해야 한다.
- 7개 연속 완료 KST 날짜는 successor startup 이후 실제 시간 경과가 필요하다.
- Sub PR별 review drain clean signal과 mother merge 결과를 이 문서에 계속 기록한다.
