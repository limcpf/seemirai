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
node scripts/run-m9-paper-decision-runner.mjs --fixture-smoke --json
node scripts/run-m9-paper-trading-soak.mjs --fixture-smoke --json --daily-report-generated --days 3 --cycles-per-day 1 --max-cycles 3
```

`soak-paper-24h.mjs`는 public WebSocket 수신과 운영 안전 가드 smoke다. `tradeMessages`와 `orderbookMessages`는 시장 데이터
수신 수이지 paper 매매 수가 아니다. `run-m9-paper-decision-runner.mjs`는 별도 decision boundary smoke로, deterministic
fixture에서 feature, strategy evaluation, order intent, cost/risk gate, PaperBroker 제출/체결, 비용·슬리피지·체결률·차단
사유 summary를 검증한다. `run-m9-paper-trading-soak.mjs --fixture-smoke`는 장시간 runner가 PaperBroker 주문/체결 cycle을
반복하고 day별 summary를 비교 도구 입력으로 만들 수 있는지 짧게 검증한다.

두 runner의 JSON summary와 Markdown report에는 `metrics.pnlSummary`가 포함된다. 사전 smoke에서는 이 값이
`costSummary`, `slippageSummary`, `fillRate`, `blockingReasonCounts`, `liveOrderApiCalls`와 함께 유지되는지 확인한다.
`pnlSummary`는 운영자가 paper run의 손익 방향을 빠르게 판단하기 위한 관측 metric이며, threshold 자동 변경이나 실거래 전환
근거로 단독 사용하지 않는다.

fixture smoke가 실패하면 M9 운영을 시작하지 않는다. stale data 차단, audit 누락, live order API 0회, Telegram inbound 부재,
control route wiring, controlled paper 주문 제출/체결 경로가 먼저 정상이어야 한다.

## 5. Paper 운영 실행

M9 운영은 두 runner를 분리해서 기록한다.

- `soak-paper-24h.mjs`: public WebSocket 수신과 stale/control/daily report 같은 운영 가드 검증
- `run-m9-paper-trading-soak.mjs`: 3일 동안 프로세스를 켜두고 public orderbook 또는 fixture 입력으로 PaperBroker 주문/체결
  decision cycle을 반복 실행

3일 paper trading soak는 실수로 장시간 실행되지 않도록 별도 env가 필요하다. 이 runner는 Upbit public quotation WebSocket만
열고, cycle마다 최신 orderbook을 decision fixture에 주입해 PaperBroker에만 주문을 제출한다. Upbit private API, live broker,
Telegram inbound, 시장가 신규 진입은 열지 않는다.

```sh
export SEEMIRAI_M9_ARTIFACT_DIR="$HOME/vaults/99_운영/seemirai-m9-paper"

SEEMIRAI_RUN_M9_PAPER_TRADING_SOAK=1 \
node scripts/run-m9-paper-trading-soak.mjs \
  --daily-report-generated \
  --artifact-dir "$SEEMIRAI_M9_ARTIFACT_DIR/trading-soak" \
  --json
```

운영 가드 soak도 별도로 계속 기록한다.

```sh
export SEEMIRAI_RUN_SOAK=1
export SEEMIRAI_SOAK_LOG_DIR="$HOME/vaults/99_운영/seemirai-soak"

for day in 1 2 3; do
  node scripts/soak-paper-24h.mjs \
    --duration-ms 86400000 \
    --daily-report-generated \
    --log-dir "$SEEMIRAI_SOAK_LOG_DIR/day-${day}"
done
```

local HTTP control server를 별도로 띄운 상태라면 `soak-paper-24h.mjs`에 `--control-url`을 추가한다. 상태 변경이 허용되는
disposable runtime에서만 `--control-drill`을 붙인다.

## 6. 진행 중 상태 확인

3일 runner가 실행 중일 때는 artifact 디렉터리를 직접 수정하지 말고 read-only 상태 CLI로 확인한다.

```sh
node scripts/report-m9-paper-soak-status.mjs \
  --artifact-dir "$SEEMIRAI_M9_ARTIFACT_DIR/trading-soak"

node scripts/report-m9-paper-soak-status.mjs \
  --artifact-dir "$SEEMIRAI_M9_ARTIFACT_DIR/trading-soak" \
  --json
```

기본 artifact 위치는 `~/vaults/99_운영/seemirai-m9-paper/trading-soak`다. status CLI는 raw log tail과 summary/report artifact를
읽기만 하며 파일을 생성하거나 수정하지 않는다. `statusCode` 의미는 다음과 같다.

| statusCode | 의미 | 운영 판단 |
| --- | --- | --- |
| `running` | aggregate summary는 아직 없고 raw log 파일 또는 최근 event가 있어 잠정 진행 상태로 본다. | 마지막 이벤트 시각이 실제로 갱신되는지 확인하고 정체돼 있으면 runner 상태를 확인한다. |
| `passed` | aggregate summary가 통과 상태다. | day summary 3개와 3일 비교 report를 evidence validator 입력으로 넘긴다. |
| `failed` | 최근 artifact/summary 실패 신호가 있거나 raw log/day summary를 읽지 못했다. | 실패 check, 파일 권한/손상 여부, raw log 마지막 event를 먼저 확인한다. |
| `skipped` | runner가 안전 guard 때문에 장시간 실행을 시작하지 않았다. | `SEEMIRAI_RUN_M9_PAPER_TRADING_SOAK=1` guard 설정 여부와 의도된 미실행인지 확인한다. |
| `incomplete` | aggregate summary는 통과했지만 기대 day summary 증거가 부족하다. | 누락된 day summary를 확인하고 완료 validator 실행 전 복구 또는 재실행한다. |
| `unknown` | aggregate summary 상태값을 현재 CLI가 완료/실패/스킵으로 분류하지 못했다. | summary schema와 runner version을 확인하고 #68 완료 증거로 쓰지 않는다. |
| `unavailable` | artifact 디렉터리를 읽지 못했거나 현재 run artifact를 찾지 못했다. | 경로, 권한, runner 미실행 여부, artifact 생성 전 상태인지 확인한다. |

local HTTP control server가 떠 있으면 `/status`도 함께 본다.

```sh
curl -sS http://127.0.0.1:8787/status
```

`/status` 해석 기준:

- `tradingState.newOrdersBlocked=true`이면 신규 주문 후보는 차단 상태다. `/readyz` 실패로 보지 않고 trading state로 판단한다.
- `paper.status=ok`이면 pending paper order count와 open position count를 DB에서 읽었다.
- `paper.status=warning` 또는 `unavailable`이면 count 일부 또는 전체가 `null`일 수 있으므로 DB 연결과 migration 상태를 확인한다.
- `alerts.status=ok`이면 `alert_cooldowns`의 마지막 전송/스킵 timestamp를 읽었다.
- `dailyReport.status=warning`이면 마지막 daily report job이 실패/취소됐거나 알 수 없는 상태다. `trace.idempotencyKey`, jobs status, audit event를 확인한다.
- `dailyReport.status=unavailable`이면 daily report job 상태를 신뢰할 수 없다. raw `last_error` 원문은 `/status`에 노출하지 않는다.
- secret, token, raw order detail, raw position detail, raw provider error는 `/status` 응답에 없어야 한다.

## 7. Telegram 매매 이벤트 정책

M9의 Telegram 알림은 outbound 전송만 허용한다. inbound command, webhook, polling은 만들지 않는다.
현재 구현 경계는 `src/application/alerts/paper-trade-events.ts`의 alert 후보 mapper와
`src/infrastructure/telegram/message-format.ts`의 Telegram formatter다. 주문/체결 commit 이후 후보를 만들고, provider 실패는
주문/체결 상태를 되돌리지 않는다.

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

## 8. Notification retry worker

P0/P1 Telegram provider 실패는 `notification_retry` jobs row로 재시도한다. runtime alert dispatch에 retry queue가 연결된
상태에서는 provider 실패가 원 주문/체결/리스크 commit을 되돌리지 않고 같은 idempotency key의 retry job으로 분리된다.

운영 확인 항목:

- `job_type=notification_retry` row만 worker가 claim한다.
- retry payload에는 `environment`, `run_mode`, `severity`, `alert_type`, `reason_code`, `fingerprint`, `occurred_at`,
  `correlation_id`, `metadata`가 있다.
- provider 성공 또는 `alert_cooldown_active` skip은 job을 `COMPLETED`로 닫는다.
- provider 성공 뒤 cooldown 기록이나 alert audit 저장이 실패해도 중복 전송을 막기 위해 job을 `COMPLETED`로 닫고, 가능한 경우
  `notification_retry_delivered_after_dispatch_error` evidence를 확인한다.
- in-flight reservation 또는 reservation race skip은 완료하지 않고 provider 실패와 같은 재예약 경로로 보낸다.
- provider 실패는 dispatch 처리 종료 시각과 claim 시각 중 더 늦은 시각 기준으로 `PENDING` 재예약되며, max attempts 소진 시 `FAILED`와
  `notification_retry_manual_review_required` audit evidence가 남는다.
- retry worker는 Telegram outbound만 수행하고 inbound command, webhook, polling, Upbit private API를 열지 않는다.

대표 검증:

```sh
corepack pnpm exec vitest run tests/unit/alerts.test.ts tests/unit/notification-retry-runtime.test.ts
SEEMIRAI_RUN_DB_INTEGRATION=1 corepack pnpm exec vitest run tests/integration/jobs.test.ts tests/integration/alert-cooldown.test.ts
```

## 9. Control drill

HTTP control server가 떠 있는 날에는 다음을 기록한다.

```sh
curl -sS http://127.0.0.1:8787/readyz
curl -sS http://127.0.0.1:8787/status
```

token 없는 kill switch 요청은 거부되어야 한다.

```sh
curl -sS -X POST http://127.0.0.1:8787/kill-switch \
  -H 'content-type: application/json' \
  -H 'x-correlation-id: m9-control-drill-missing-token' \
  -d '{"targetState":"NEW_ORDERS_BLOCKED","reasonCode":"m9_drill_missing_token"}'
```

상태 변경이 허용되는 disposable local paper runtime에서만 인증된 drill을 실행한다. 이 명령은 실제 `/kill-switch` 전이를
요청하므로, 실행 전 현재 paper 주문과 복구 경로를 확인한다.

```sh
SEEMIRAI_LOCAL_CONTROL_TOKEN="$SEEMIRAI_LOCAL_CONTROL_TOKEN" \
node scripts/soak-paper-24h.mjs \
  --fixture-smoke \
  --control-url http://127.0.0.1:8787 \
  --control-drill \
  --control-drill-correlation-id "m9-control-drill-$(date +%Y%m%d)" \
  --json
```

인증된 drill은 신규 주문 차단 evidence, pending paper order cancel plan, Telegram 알림 dispatch evidence가 같은 correlation id로
추적되어야 한다. `HARD_STOP -> NORMAL` 직접 복구는 금지다.

## 10. 3일 비교 기록

M9 안정화 기준은 3일 연속 paper report 비교로 고정한다.

```sh
node scripts/compare-m9-paper-reports.mjs \
  --summary "$HOME/vaults/99_운영/seemirai-m9-paper/trading-soak/"*-day-1-summary.json \
  --summary "$HOME/vaults/99_운영/seemirai-m9-paper/trading-soak/"*-day-2-summary.json \
  --summary "$HOME/vaults/99_운영/seemirai-m9-paper/trading-soak/"*-day-3-summary.json \
  --output "$HOME/vaults/99_운영/seemirai-m9-paper/m9-3day-trading-soak-comparison.md" \
  --json
```

paper trading soak day summary를 3일 비교 입력으로 사용할 때는 `metrics.costSummary`, `metrics.slippageSummary`,
`metrics.fillRate`, `metrics.blockingReasonCounts`, `metrics.liveOrderApiCalls`, `metrics.pnlSummary`가 모두 같은 shape로
채워져 있어야 한다. daily report artifact와 연결한 운영 summary는 runner 실행 시 `--daily-report-generated`를 함께 남긴다.

`pnlSummary` 해석 기준:

- `totalPnlKrw`: `realizedPnlKrw + unrealizedPnlKrw` 기준 총 손익이다. 음수이면 해당 paper run의 평가 기준 손익이 손실이다.
- `realizedPnlKrw`: 청산된 paper 포지션의 실현손익이다. 매수 수수료는 cost basis에, 매도 수수료는 순수취액에 반영된다.
- `unrealizedPnlKrw`와 `positionMarketValueKrw`: 미청산 포지션을 마지막 평가가로 mark-to-market한 값이다. 평가가가 없거나
  초기 base 잔고처럼 취득가를 알 수 없으면 `null`이며 Markdown report에는 `계산 불가`로 표시된다.
- `totalFeesKrw`: 체결된 모든 paper fill 수수료 합계다. 이 값은 손익 계산에 이미 반영되므로 `totalPnlKrw`에서 다시 차감하지 않는다.
- `totalReturnBps`: 시작 가상 현금 대비 총 손익 bps다. 시작 현금이 0이거나 총 손익을 계산할 수 없으면 `null`이다.
- `submittedOrderCount`와 `filledOrderCount`: 주문 제출 수와 체결된 주문 수다. 한 주문이 여러 호가 level에서 나뉘어 체결되어도
  `filledOrderCount`는 주문 ID 기준으로 중복 제거된다.

| 날짜 | commit | report artifact | crash | live order API | audit missing | notification failure | daily report | 총 손익 KRW | 수수료 KRW | 비용 | 슬리피지 | 체결률 | 주요 차단 사유 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Day 1 |  |  |  | 0 |  |  |  |  |  |  |  |  |  |
| Day 2 |  |  |  | 0 |  |  |  |  |  |  |  |  |  |
| Day 3 |  |  |  | 0 |  |  |  |  |  |  |  |  |  |

완료 인정 조건:

- 3일 모두 report artifact가 있다.
- 3일 모두 live order API 호출이 0회다.
- 3일 모두 crash와 unhandled rejection이 없다.
- daily report evidence가 있다.
- notification failure가 있으면 retry worker 또는 manual review evidence로 수렴한다.
- 비용, 슬리피지, 체결률, 차단 사유, KRW 손익 summary가 같은 포맷으로 비교된다.

## 11. #68 완료 증거 검증과 댓글 초안

3일 runner가 종료되고 day summary 3개와 비교 report가 준비되면 evidence validator를 실행한다. 이 명령도 artifact를 수정하지 않는다.

```sh
node scripts/validate-m9-paper-soak-evidence.mjs \
  --artifact-dir "$SEEMIRAI_M9_ARTIFACT_DIR/trading-soak" \
  --json

node scripts/validate-m9-paper-soak-evidence.mjs \
  --artifact-dir "$SEEMIRAI_M9_ARTIFACT_DIR/trading-soak" \
  --issue-comment
```

comparison report를 기본 위치가 아닌 곳에 만들었다면 명시한다.

```sh
node scripts/validate-m9-paper-soak-evidence.mjs \
  --artifact-dir "$SEEMIRAI_M9_ARTIFACT_DIR/trading-soak" \
  --comparison-report "$SEEMIRAI_M9_ARTIFACT_DIR/m9-3day-trading-soak-comparison.md" \
  --json
```

exit code 의미:

| exit code | statusCode | 운영 판단 |
| --- | --- | --- |
| `0` | `passed` | #68 closeout 후보로 사용할 수 있다. `--issue-comment` 출력을 확인한 뒤 issue #68 댓글에 붙인다. |
| `1` | `failed` | 완료 후 acceptance criteria를 충족하지 못했다. 실패 check, summary, comparison report를 확인하고 #68을 닫지 않는다. |
| `2` | `incomplete` | runner가 아직 끝나지 않았거나 증거가 부족하다. 누락 artifact를 보강한 뒤 다시 실행한다. |

validator가 확인하는 최소 증거:

- aggregate summary와 aggregate report
- Day 1/2/3 summary와 report
- 최신 run의 Day 1/2/3 artifact와 모두 대응되는 3일 comparison report
- `liveOrderApiCalls=0`
- crash/unhandled rejection 0
- daily report evidence
- 비용, 슬리피지, 체결률, 차단 사유 metric
- `pnlSummary`의 총 손익, 실현손익, 미실현손익, 수수료, 수익률 shape
- paper 주문/체결과 hold/discard/blocking reason count

`--issue-comment` 출력은 사람이 먼저 확인한다. 내부 `statusCode`, run prefix, artifact path는 `추적 정보`로 보존하되, secret이나 raw log 원문은
issue 댓글에 붙이지 않는다.

## 12. 결과 기록

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

## 13. Issue #87 Sub PR handoff

- Sub PR 1 / PR #88: M9 artifact discovery/parser와 실시간 상태 CLI를 고정했다.
- Sub PR 2 / PR #89: #68 evidence validator와 Markdown comment generator를 고정했다.
- Sub PR 3 / PR #91: `/status` durable 운영 정보 보강을 고정했다.
- Sub PR 4 / PR #94: 이 runbook과 관련 runtime/reliability 문서를 갱신했다.
- Sub PR 5 / PR #99: mother PR 검증 결과와 #68 연동 사용법을 closeout 형식으로 정리했다.

## 14. Issue #87 closeout 패치노트

Issue #87은 #68 72시간 paper trading 관측을 방해하지 않고, 실행 중 상태 확인과 완료 증거 정리를 read-only 도구로 보강한다.
closeout 댓글이나 mother PR 설명에는 아래 내용을 기준으로 남긴다.

### 새 기능

- `#68 진행 현황 보기`: 실행 중인 M9 paper soak artifact를 읽어 마지막 이벤트 시각, day summary 생성 상태, 최근 실패/스킵 신호를 확인한다.
- `#68 완료 판정하기`: aggregate summary, day summary 3개, day report 3개, 3일 비교 report를 검사해 `passed`, `failed`, `incomplete`로 판정한다.
- `#68 댓글 초안 만들기`: issue #68에 붙일 수 있는 Markdown 요약을 생성한다.
- `운영 status 강화`: `/status`에서 paper 주문/포지션, alert cooldown, daily report job 상태를 한국어 상태/원인/조치와 추적 정보로 분리해 본다.

### 운영자 사용 예시

```sh
node scripts/report-m9-paper-soak-status.mjs \
  --artifact-dir "$HOME/vaults/99_운영/seemirai-m9-paper/72h-paper-trading-soak"

node scripts/report-m9-paper-soak-status.mjs \
  --artifact-dir "$HOME/vaults/99_운영/seemirai-m9-paper/72h-paper-trading-soak" \
  --json

node scripts/compare-m9-paper-reports.mjs \
  --summary "$HOME/vaults/99_운영/seemirai-m9-paper/72h-paper-trading-soak/"*-day-1-summary.json \
  --summary "$HOME/vaults/99_운영/seemirai-m9-paper/72h-paper-trading-soak/"*-day-2-summary.json \
  --summary "$HOME/vaults/99_운영/seemirai-m9-paper/72h-paper-trading-soak/"*-day-3-summary.json \
  --output "$HOME/vaults/99_운영/seemirai-m9-paper/m9-3day-trading-soak-comparison.md" \
  --json

node scripts/validate-m9-paper-soak-evidence.mjs \
  --artifact-dir "$HOME/vaults/99_운영/seemirai-m9-paper/72h-paper-trading-soak" \
  --comparison-report "$HOME/vaults/99_운영/seemirai-m9-paper/m9-3day-trading-soak-comparison.md" \
  --issue-comment

curl -sS http://127.0.0.1:8787/status
```

### Closeout DnD

- #68 runner 동작과 output schema를 바꾸지 않았다.
- threshold/config 기본값, 신규 전략, phase 1.5 알트 편입, Upbit private API, live order API를 열지 않았다.
- read-only CLI와 validator는 artifact를 수정하지 않는다.
- issue/PR/comment에는 secret, token, raw log 원문, raw order detail, raw position detail을 붙이지 않는다.
- #68 완료 판정은 `validate-m9-paper-soak-evidence.mjs --issue-comment` 출력 검토 후 사람이 issue 댓글에 붙인다.

### Mother PR 검증 요약

Mother PR을 main으로 보내기 전 최소 검증은 아래 명령으로 다시 실행한다.

```sh
node scripts/report-m9-paper-soak-status.mjs --help
node scripts/validate-m9-paper-soak-evidence.mjs --help
corepack pnpm typecheck
corepack pnpm vitest run tests/soak/m9-paper-soak-status-script.test.ts tests/soak/m9-paper-soak-evidence-validator.test.ts tests/unit/http-control.test.ts
./scripts/verify docs
git diff --check
./scripts/verify
```

이 검증은 저장소 안 fixture와 문서 구조를 확인한다. 실제 #68 완료 증거는 저장소 밖 artifact 경로에서 validator를 실행해 별도로 남긴다.
