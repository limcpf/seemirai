# M23/M24 live ops and scaled canary 실행 계획

## 목표

M22 제한적 자동매매 closeout 이후 M23 24/7 운영 안정화와 M24 전략 확장/예산 확대를 실제 live evidence로 검증한다.
첫 live test는 수익 검증이 아니라 주문 생성, 조회, 취소, reconcile/manual review 수렴이 모두 같은 uuid/identifier 경계에서 닫히는지
확인하는 canary다.

Issue #188은 이 계획 중 M23 24/7 live small-budget 운영 안정화와 실시간 상태 가시성을 구현한다. M24 universe, strategy, budget
확대는 M23 closeout PASS 이후 별도 issue로 진행한다.

운영자가 허용한 손실 ceiling은 50,000 KRW다. 이 값은 자동 예산 확대 승인이 아니며, realized loss와 미체결 노출 합계가 이 값에
도달하기 전에 live test를 중지한다.

## 현재 상태

- M22 24시간 heartbeat-only pilot 통과: `fdad721f`, heartbeat 1439, closeout 위반 0건.
- M22 dry-run candidate canary 통과: `94e7b691`, `brokerSubmissionCount=1`, `orderSubmittedCount=1`, `DRY_RUN_SUBMITTED`.
- `scripts/run-m22-live-autonomous-daemon.mjs`는 `--cancel-after-submit` 옵션으로 live canary 주문 제출 후 같은 uuid/identifier 취소와
  terminal cancel 확인을 수행한다.
- M23 live canary cleanup 통과: `cc93288f`, 10,000 KRW `LIMIT + post_only` 주문 제출 1회, 취소 요청 1회, terminal `cancel` 확인,
  `openPositionNotionalKrw=0`, `liveOrderCleanupFailureCount=0`.
- Issue #188 Sub PR 01에서 `FR-OPS-004`와 M23 전용 runbook contract를 고정한다.
- Issue #188 Sub PR 02에서 `/status.liveOps`, Telegram `/status`, daily report가 공유하는 M23 live ops safe summary 표면을 추가한다.
- Issue #188 Sub PR 03에서 M23 Telegram lifecycle/trade alert mapper와 formatter를 추가해 연결 성공, live order capable 시작,
  중지/수동 점검/crash/restart/recovery, 주문/취소/체결/차단 event를 기존 cooldown/retry/manual review 경로에 연결한다.

## 범위

- M23: live canary cleanup, 24시간 post-cleanup preflight, 실제 주문 가능 live-armed 7일 안정화, process 재시작/reconcile/status 복구,
  Telegram lifecycle/trade event 알림, alert/daily report evidence.
- M24: paper/live shadow 비교, 전략별 PnL/손실 기여도 report, 운영자 승인 기반 universe/budget 확대 계획. M23에서는 계획과 분리
  결정만 남기고 구현하지 않는다.

## 제외 범위

- 출금, 입출금 자동화, 선물, 레버리지, 마진.
- BTC 외 market 자동 활성화와 예산 확대의 즉시 live 적용.
- 시장가/최유리 주문 기본 허용.
- 50,000 KRW ceiling을 넘는 자동 손실 허용.

## 단계

1. M22 문서 closeout 반영
   - 24시간 heartbeat-only artifact와 dry-run candidate canary artifact를 `FEATURE_REQUIREMENTS`, product spec, completed closeout에 기록한다.
   - `./scripts/verify docs`와 `./scripts/verify`로 문서/코드 검증을 완료한다.

2. M23 live canary cleanup ✅ 2026-06-12 통과
   - `KRW-BTC`, `LIMIT + post_only`, 10,000 KRW 이하 단일 후보만 사용한다.
   - `--cancel-after-submit`으로 제출 직후 취소 요청과 terminal cancel 확인을 남긴다.
   - 성공 기준: `brokerSubmissionCount=1`, `orderSubmittedCount=1`, `liveOrderCleanupFailureCount=0`, manual review 0건.

3. M23 24시간 post-cleanup pilot
   - live canary cleanup 통과 후 candidate source를 비워 heartbeat/daily report 안정성을 다시 확인한다.
   - process restart 후 reconcile/status가 정상 복구되는지 확인한다.
   - 이 단계는 preflight이며 M23 완료 근거가 아니다.

4. M23 7일 운영 안정화
   - dry-run이 아니라 live order API를 호출할 수 있는 설정으로 `LIVE_AUTONOMOUS_SMALL_BUDGET`를 arm 한다.
   - 실제 주문이 없어도 후보 없음, gate 차단, 시장 조건 미충족 같은 이유가 decision evidence와 daily report에 남아야 한다.
   - 7일 연속 daily report, Telegram lifecycle/trade event 알림, P0/P1 alert retry evidence를 모은다.
   - crash, unhandled rejection, risk gate 우회 주문, reconcile mismatch, duplicate order, untracked fill, cleanup failure가 모두 0건이어야 한다.
   - 누적 realized loss와 미체결 노출 합계가 50,000 KRW에 도달하기 전에 운영을 중지한다.

5. M24 shadow 비교와 확대 승인
   - 알트 최대 3개 수동 편입 전 paper/live shadow 비교를 먼저 통과시킨다.
   - 전략별 PnL과 손실 기여도를 report로 분해한다.
   - universe 또는 budget 확대는 operator approval evidence와 rollback plan을 문서화한 뒤 별도 canary로 실행한다.
   - 이 단계는 Issue #188 범위 밖이며 별도 issue에서 시작한다.

## 검증 명령

```sh
corepack pnpm exec vitest run tests/soak/m22-live-autonomous-daemon-script.test.ts tests/soak/m22-live-autonomous-pilot-script.test.ts --reporter=verbose
corepack pnpm typecheck
./scripts/verify docs
./scripts/verify
```

## live canary 명령

```sh
cd /home/lim/code/seemirai
M22_HOME="$HOME/vaults/99_운영/seemirai-m22-live-autonomous"
. "$M22_HOME/m22.env"

node scripts/run-m22-live-autonomous-pilot.mjs \
  --config "$M22_HOME/m22-live-autonomous.config.json" \
  --duration-ms 120000 \
  --artifact-dir "$SEEMIRAI_M22_ARTIFACT_DIR" \
  --require-daily-report \
  --pilot-command node \
  -- \
  scripts/run-m22-live-autonomous-daemon.mjs \
  --config "$M22_HOME/m22-live-autonomous.config.json" \
  --candidate-file "$M22_HOME/candidates/m22-candidates.jsonl" \
  --candidate-start beginning \
  --cancel-after-submit \
  --cancel-confirmation-attempts 5 \
  --cancel-confirmation-ms 1000
```

## 완료 조건

- M23는 7일 연속 live small-budget 운영 리포트, restart/reconcile/status 복구, alert retry/manual review 수렴 evidence가 있어야 완료다.
- M23 closeout은 실제 주문 가능 live-armed 설정 evidence를 요구한다. live canary 1회 성공, dry-run, heartbeat-only만으로 완료를 선언하지 않는다.
- 주문이 없었던 날도 candidate 없음, gate 차단, 시장 조건 미충족, operator stop, kill switch 같은 이유가 evidence로 남아야 한다.
- M24는 paper/live shadow 비교, 전략별 PnL/손실 기여도 report, operator approval과 rollback plan이 있어야 완료다.
- live canary 1회 성공만으로 M23/M24 완료를 선언하지 않는다.

## 최신 live canary artifact

- summary: `/home/lim/vaults/99_운영/seemirai-m22-live-autonomous/artifacts/m22-live-autonomous-2026-06-12T04-33-15-673Z-cc93288f-summary.json`
- report: `/home/lim/vaults/99_운영/seemirai-m22-live-autonomous/artifacts/m22-live-autonomous-2026-06-12T04-33-15-673Z-cc93288f-report.md`
- event log: `/home/lim/vaults/99_운영/seemirai-m22-live-autonomous/artifacts/m22-live-autonomous-2026-06-12T04-33-15-673Z-cc93288f-events.jsonl`
