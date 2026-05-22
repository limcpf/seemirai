# M9 Paper 운영 베타 Runbook

- 작성일: 2026-05-22
- 대상 단계: M9 Paper 운영 베타
- 기준 issue: [#51](https://github.com/limcpf/seemirai/issues/51)
- 기본 모드: `PAPER_TRADING`, `PAPER_NO_KEY`
- 기준 문서: [`m8-paper-operations-guide.md`](./m8-paper-operations-guide.md), [`../RUNTIME_CONFIG.md`](../RUNTIME_CONFIG.md), [`../RELIABILITY.md`](../RELIABILITY.md), [`../exec-plans/active/2026-05-22-post-m8-milestone-plan.md`](../exec-plans/active/2026-05-22-post-m8-milestone-plan.md)

## 목적

M9는 M8-C의 24시간 paper soak를 한 번 통과한 뒤 끝내는 단계가 아니다. 같은 절차를 운영자가 반복 실행하고, daily report와
Telegram outbound 알림을 근거로 3일 연속 paper 운영 상태를 비교할 수 있게 만드는 단계다.

## 운영 범위

가능한 것:

- `PAPER_NO_KEY` 기반 public market data, paper execution, HTTP control, Telegram outbound, daily report 운영 절차 조립
- DB migration, backup/restore smoke, fixture smoke, 24시간 paper run 결과 기록
- `report.daily:<reportDate>` 기준 daily report 수동/스케줄 실행 경계 검증
- paper 매매 이벤트 Telegram 알림 정책 검증
- `/status`, `/readyz`, `/kill-switch` 운영 drill
- 3일 연속 paper report 비교

아직 열지 않는 것:

- Upbit account/private API 연동
- 실거래 주문, 실거래 주문 조회, 실거래 잔고 조회
- Telegram inbound command, webhook, polling
- 신규 전략 확장
- phase 1.5 알트 편입

## 안전 invariant

- `config/paper.json`의 live trading, withdrawal, futures, leverage, market order 관련 toggle은 모두 꺼져 있어야 한다.
- `paper_no_key`는 `true`여야 한다.
- Upbit access key와 secret key는 M9 paper profile에 주입하지 않는다.
- Telegram token과 local control token은 shell, process manager, secret manager에서만 주입한다.
- raw log, JSON summary, Telegram 전송 payload 원문은 저장소에 커밋하지 않는다.
- M9 검증 중 live order API 호출은 0회여야 한다.

## 1. 준비

```sh
cd <repo_root>
corepack pnpm install --frozen-lockfile
node --version
corepack pnpm --version
./scripts/verify
```

`<repo_root>`는 Seemirai 저장소를 checkout한 경로다. Node.js는 24 계열이어야 한다.

M8-C 24시간 soak가 끝난 뒤 다음 값을 M9 운영 기록에 연결한다.

- 실행 commit
- 실행 시작/종료 시각
- artifact 디렉터리
- JSON summary 파일명
- Markdown report 파일명
- crash, unhandled rejection, live order API call, audit missing, stale data blocked, DB write failure, notification failure,
  daily report evidence 결과

## 2. Secret과 local env 주입

secret 원문은 문서나 PR body에 남기지 않는다. 운영 shell에서만 주입한다.

```sh
export SEEMIRAI_ENV="local"
export SEEMIRAI_RUN_SOAK=1
export SEEMIRAI_TELEGRAM_BOT_TOKEN="<redacted>"
export SEEMIRAI_TELEGRAM_CHAT_ID="<redacted>"
export SEEMIRAI_LOCAL_CONTROL_TOKEN="<redacted>"
export SEEMIRAI_SOAK_LOG_DIR="$HOME/vaults/99_운영/seemirai-soak"
export SEEMIRAI_M9_ARTIFACT_DIR="$HOME/vaults/99_운영/seemirai-m9-paper"
```

운영자가 별도 env 파일을 쓴다면 파일은 저장소 밖에 둔다.

```sh
set -a
. "$HOME/vaults/99_운영/seemirai-secrets/m9-paper.env"
set +a
```

## 3. DB 준비와 복구 smoke

```sh
docker compose up -d postgres
SEEMIRAI_RUN_DB_INTEGRATION=1 corepack pnpm exec vitest run tests/integration
```

백업/복구 smoke는 원본 DB와 복구 DB를 분리한다.

```sh
if ! docker compose exec -T postgres psql -U seemirai -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = 'seemirai_restore'" | grep -q 1; then
  docker compose exec -T postgres createdb -U seemirai seemirai_restore
fi

SEEMIRAI_DATABASE_URL=postgres://seemirai:seemirai_local_password@127.0.0.1:55432/seemirai_local \
SEEMIRAI_RESTORE_DATABASE_URL=postgres://seemirai:seemirai_local_password@127.0.0.1:55432/seemirai_restore \
./scripts/db-backup-restore-smoke.sh
```

## 4. 사전 smoke

실제 24시간 운영 전에 fixture smoke를 실행한다.

```sh
node scripts/soak-paper-24h.mjs --fixture-smoke --json
```

fixture smoke가 실패하면 M9 운영을 시작하지 않는다. stale data 차단, audit 누락, live order API 0회, Telegram inbound 부재,
control route wiring 근거가 먼저 정상이어야 한다.

## 5. Paper 운영 실행

M9의 최종 daily runner와 scheduler command는 issue #51 후속 sub PR에서 고정한다. 이 runbook의 현재 기준은 M8-C soak harness와
M9 운영 기록 포맷을 연결하는 것이다.

```sh
export SEEMIRAI_RUN_SOAK=1
export SEEMIRAI_SOAK_LOG_DIR="$HOME/vaults/99_운영/seemirai-soak"

node scripts/soak-paper-24h.mjs \
  --duration-ms 86400000 \
  --daily-report-generated
```

local HTTP control server를 별도로 띄운 상태라면 `--control-url`을 추가한다.

```sh
node scripts/soak-paper-24h.mjs \
  --duration-ms 86400000 \
  --control-url http://127.0.0.1:8787 \
  --daily-report-generated
```

## 6. Telegram 매매 이벤트 정책

M9의 Telegram 알림은 outbound 전송만 허용한다. inbound command, webhook, polling은 만들지 않는다.

즉시 전송 P1:

- 슬리피지 임계값 초과
- 부분체결 장기화 또는 잔량 방치
- 취소/재호가 실패
- 주문/체결 accounting mismatch 후보
- 운영자 확인이 필요한 리스크 차단

cooldown 적용 P2:

- paper 주문 제출
- paper 부분체결
- paper 전체체결
- paper 주문 취소/재호가 완료
- 리스크 차단

요약 전용 P3:

- 전략 신호
- 주문 후보 폐기 다건 요약
- 정상 lifecycle 반복 이벤트

모든 메시지는 첫 줄에 한국어 상태를 먼저 둔다. 내부 enum, fingerprint, order id, idempotency key, correlation id는 하단
`추적 정보`에 둔다.

최소 포함 정보:

- `PAPER` 모드
- market
- strategy id
- side
- 수량
- 지정가 또는 체결가
- 수수료/슬리피지 가능 값
- order id 또는 idempotency key
- correlation id

## 7. Control drill

HTTP control server가 떠 있는 날에는 다음을 기록한다.

```sh
curl -sS http://127.0.0.1:8787/readyz
curl -sS http://127.0.0.1:8787/status
```

token 없는 kill switch 요청은 거부되어야 한다.

```sh
curl -sS -X POST http://127.0.0.1:8787/kill-switch \
  -H 'content-type: application/json' \
  -d '{"targetState":"NEW_ORDERS_BLOCKED","reason":"m9_drill_missing_token"}'
```

token 있는 drill은 신규 주문 차단 evidence, pending paper order cancel plan, Telegram 알림 evidence가 같은 correlation id로
추적되어야 한다. `HARD_STOP -> NORMAL` 직접 복구는 금지다.

## 8. 3일 비교 기록

M9 안정화 기준은 3일 연속 paper report 비교로 고정한다.

| 날짜 | commit | report artifact | crash | live order API | audit missing | notification failure | daily report | 비용 | 슬리피지 | 체결률 | 주요 차단 사유 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Day 1 |  |  |  | 0 |  |  |  |  |  |  |  |
| Day 2 |  |  |  | 0 |  |  |  |  |  |  |  |
| Day 3 |  |  |  | 0 |  |  |  |  |  |  |  |

완료 인정 조건:

- 3일 모두 report artifact가 있다.
- 3일 모두 live order API 호출이 0회다.
- 3일 모두 crash와 unhandled rejection이 없다.
- daily report evidence가 있다.
- notification failure가 있으면 retry worker 또는 manual review evidence로 수렴한다.
- 비용, 슬리피지, 체결률, 차단 사유가 같은 포맷으로 비교된다.

## 9. 결과 기록

저장소에는 raw log를 커밋하지 않는다. PR 또는 실행 계획 문서에는 다음만 남긴다.

- 실행 시작/종료 시각
- secret을 제거한 실행 명령
- artifact 디렉터리
- JSON summary 파일명
- Markdown report 파일명
- Telegram 전송 성공/실패 요약
- 3일 비교표
- 남은 리스크와 후속 조치

권장 저장 위치:

```text
$HOME/vaults/99_운영/seemirai-soak
$HOME/vaults/99_운영/seemirai-m9-paper
$HOME/vaults/99_운영/seemirai-works
```

## 10. Sub PR handoff

- Sub PR 2: daily report 수동 runner와 scheduler boundary를 고정한다.
- Sub PR 3: paper 매매 이벤트 Telegram 알림 mapper, formatter, cooldown/요약 정책을 구현한다.
- Sub PR 4: P0/P1 notification retry worker를 jobs table 기반으로 구현한다.
- Sub PR 5: control drill과 3일 report 비교 결과로 M9 완료 상태를 정리한다.
