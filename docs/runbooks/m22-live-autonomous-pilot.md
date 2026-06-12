# M22 Live Autonomous Pilot Runbook

- 작성일: 2026-06-10
- 대상 단계: M22 제한적 완전 자동매매 24시간 pilot
- 기본 market: `KRW-BTC`
- 기본 예산: 1회 `10000` KRW, 일일 자동 주문 notional `30000` KRW, open position notional `30000` KRW
- runner: [`../../scripts/run-m22-live-autonomous-pilot.mjs`](../../scripts/run-m22-live-autonomous-pilot.mjs)
- daemon: [`../../scripts/run-m22-live-autonomous-daemon.mjs`](../../scripts/run-m22-live-autonomous-daemon.mjs)
- local file preparer: [`../../scripts/prepare-m22-live-autonomous-local-files.mjs`](../../scripts/prepare-m22-live-autonomous-local-files.mjs)
- 기준 문서: [`../FEATURE_REQUIREMENTS.md`](../FEATURE_REQUIREMENTS.md), [`../RUNTIME_CONFIG.md`](../RUNTIME_CONFIG.md), [`../RELIABILITY.md`](../RELIABILITY.md), [`../SECURITY.md`](../SECURITY.md), [`../product-specs/upbit-live-autonomous-trading.md`](../product-specs/upbit-live-autonomous-trading.md)

## 목적

M22 pilot의 목적은 수익 검증이 아니라 제한적 소액 자동매매 runtime이 24시간 동안 안전 gate를 우회하지 않았음을 증명하는 것이다.
성공 판정은 다음 0건 조건을 summary와 redacted artifact로 확인해야 한다.

- crash 0회
- unhandled rejection 0회
- risk gate 우회 주문 0건
- reconcile mismatch 0건
- duplicate order 0건
- untracked fill 0건

## 0. 운영 파일 생성

운영 env, key, config, evidence template, 실행 wrapper는 저장소 밖에 둔다. 기본 생성 위치는
`$HOME/vaults/99_운영/seemirai-m22-live-autonomous`다.

```sh
cd /home/lim/code/seemirai
node scripts/prepare-m22-live-autonomous-local-files.mjs --json
```

생성 파일:

- `m22.env`: live guard, evidence id, readiness flag. 기본값은 live 실행을 막는 `0` 또는 빈 값이다.
- `m22.keys.env`: DB, Telegram, Upbit key. 기본값은 빈 값이며 `chmod 600`이다.
- `m22-live-autonomous.config.json`: 저장소 밖 M22 config. `live_autonomous.enabled=true`지만 출금, 선물, 레버리지, 시장가 주문은 닫혀 있다.
- `evidence/operator-arm.md`, `evidence/budget.md`, `evidence/m21-week-gate.md`, `evidence/upbit-key-scope.md`: redacted 근거 template.
- `candidates/m22-candidates.jsonl`: daemon이 읽는 명시 주문 후보 JSONL. 빈 파일이면 주문하지 않는다.
- `run-fixture-smoke.sh`: no-live smoke 실행 wrapper.
- `run-24h-pilot.sh`: 기본 M22 daemon을 runner 뒤에서 실행하는 wrapper.

기존 secret 값을 보존하기 위해 생성기는 기본적으로 파일을 덮어쓰지 않는다. 템플릿을 다시 만들 때만 `--force`를 사용한다.

## Runner 역할

`scripts/run-m22-live-autonomous-pilot.mjs`는 live 주문을 직접 생성하는 daemon이 아니다. 이 runner는 다음을 수행한다.

- 명시 env guard와 evidence/readiness/config를 확인한다.
- 조건이 부족하면 Upbit private client나 broker command를 시작하지 않고 skip 또는 failed artifact를 남긴다.
- 조건이 모두 맞으면 기본 M22 daemon 또는 운영자가 지정한 long-running live autonomous command를 감싸 실행한다.
- 감싼 command가 `SEEMIRAI_M22_PILOT_EVENT_LOG`에 남긴 JSONL event를 closeout 기준으로 집계한다.
- summary JSON, Markdown report, process log를 저장소 밖 artifact 디렉터리에 남긴다.

기본 daemon은 `candidates/m22-candidates.jsonl`에 append된 명시 후보만 처리한다. 후보 파일이 비어 있으면 24시간 동안 heartbeat와
daily report evidence만 남기고 주문을 만들지 않는다. daemon은 strategy signal을 임의 생성하지 않는다.

## 1. 사전 검증

```sh
cd /home/lim/code/seemirai
corepack pnpm install --frozen-lockfile
./scripts/verify
```

runner 자체의 no-live smoke는 다음으로 확인한다.

```sh
"$HOME/vaults/99_운영/seemirai-m22-live-autonomous/run-fixture-smoke.sh"
```

## 2. 저장소 밖 운영 config 준비

`config/paper.json`은 계속 `live_autonomous.enabled=false`인 안전 profile로 유지한다. M22 pilot에는 생성기가 만든 저장소 밖 config를
별도로 둔다.

필수 설정:

```json
{
  "live_autonomous": {
    "mode": "LIVE_AUTONOMOUS_SMALL_BUDGET",
    "enabled": true,
    "allowed_markets": ["KRW-BTC"],
    "max_order_krw": "10000",
    "daily_autonomous_notional_limit_krw": "30000",
    "max_open_position_notional_krw": "30000",
    "max_daily_loss_krw": "10000",
    "max_weekly_loss_krw": "30000",
    "max_price_deviation_bps": "30",
    "require_m21_week_gate_evidence": true,
    "require_m20_inbound_readiness": true,
    "require_reconcile_freshness": true,
    "require_pnl_status_ready": true,
    "require_decision_ledger_ready": true,
    "require_exit_engine_ready": true,
    "require_operator_arm_evidence_id": true,
    "require_budget_evidence_id": true,
    "require_key_scope_evidence_id": true,
    "identifier_prefix": "m22a-",
    "identifier_max_length": 32
  },
  "withdrawal_enabled": false,
  "futures_enabled": false,
  "leverage_enabled": false,
  "market_order_enabled": false,
  "entry_market_order_enabled": false
}
```

## 3. 필수 env와 evidence

secret 원문은 PR body, 문서, artifact에 남기지 않는다. evidence id는 저장소 밖 redacted 증거를 가리키는 안정 식별자만 사용한다.
생성 직후 `m22.env`와 `m22.keys.env`는 안전하게 비어 있거나 `0`으로 잠겨 있다. 실제 운영 전 다음 형태로 채운다.

```sh
vi "$HOME/vaults/99_운영/seemirai-m22-live-autonomous/m22.keys.env"
vi "$HOME/vaults/99_운영/seemirai-m22-live-autonomous/m22.env"
```

`m22.keys.env`에 들어갈 값:

```sh
export SEEMIRAI_DATABASE_URL="postgres://seemirai:<db-password>@127.0.0.1:55432/seemirai"
export SEEMIRAI_TELEGRAM_BOT_TOKEN="<telegram-bot-token>"
export SEEMIRAI_TELEGRAM_CHAT_ID="<telegram-chat-id>"
export SEEMIRAI_UPBIT_ACCESS_KEY="<upbit-access-key>"
export SEEMIRAI_UPBIT_SECRET_KEY="<upbit-secret-key>"
```

`m22.env`에 들어갈 값:

```sh
export SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT=1
export SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON=1
export SEEMIRAI_M22_OPERATOR_ARM_EVIDENCE_ID="file:$HOME/vaults/99_운영/seemirai-m22-live-autonomous/evidence/operator-arm.md"
export SEEMIRAI_M22_BUDGET_EVIDENCE_ID="file:$HOME/vaults/99_운영/seemirai-m22-live-autonomous/evidence/budget.md"
export SEEMIRAI_M22_M21_WEEK_GATE_EVIDENCE_ID="file:$HOME/vaults/99_운영/seemirai-m22-live-autonomous/evidence/m21-week-gate.md"
export SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID="file:$HOME/vaults/99_운영/seemirai-m22-live-autonomous/evidence/upbit-key-scope.md"

export SEEMIRAI_PILOT_PROFILE="PILOT_ORDER_SMOKE"
export SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE=1
export SEEMIRAI_RUN_UPBIT_ORDER_SMOKE=1
export SEEMIRAI_UPBIT_POLICY_SYNC_MARKET="KRW-BTC"
export SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET="KRW-BTC"
export SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW="10000"
export SEEMIRAI_UPBIT_KEY_SCOPE="자산조회,주문조회,주문하기"

export SEEMIRAI_DATABASE_URL="<redacted>"
export SEEMIRAI_TELEGRAM_BOT_TOKEN="<redacted>"

export SEEMIRAI_M22_TELEGRAM_INBOUND_READY=1
export SEEMIRAI_M22_RECONCILE_FRESH=1
export SEEMIRAI_M22_PNL_STATUS_READY=1
export SEEMIRAI_M22_DECISION_LEDGER_READY=1
export SEEMIRAI_M22_EXIT_ENGINE_READY=1
export SEEMIRAI_M22_ARTIFACT_DIR="$HOME/vaults/99_운영/seemirai-m22-live-autonomous/artifacts"
export SEEMIRAI_M22_INITIAL_DAILY_AUTONOMOUS_NOTIONAL_USED_KRW="0"
export SEEMIRAI_M22_INITIAL_OPEN_POSITION_NOTIONAL_KRW="0"
export SEEMIRAI_M22_DAILY_REALIZED_LOSS_KRW="0"
export SEEMIRAI_M22_WEEKLY_REALIZED_LOSS_KRW="0"
```

`PILOT_ORDER_SMOKE`는 Upbit private 주문 권한을 여는 하위 guard이고, M22 운영 모드는 저장소 밖 config의
`live_autonomous.mode=LIVE_AUTONOMOUS_SMALL_BUDGET`가 담당한다. 위 값 중 `SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT`,
`SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON`, `SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE`, `SEEMIRAI_RUN_UPBIT_ORDER_SMOKE`, readiness 5종은
실제 검증을 완료한 뒤에만 `1`로 바꾼다. 단순히 runner preflight를 통과시키기 위해 먼저 켜면 M22 운영 조건을 충족한 것으로 보지
않는다.

## 4. Pilot command event contract

runner는 감싼 command에 다음 env를 주입한다.

```text
SEEMIRAI_M22_PILOT_RUN_ID
SEEMIRAI_M22_PILOT_EVENT_LOG
```

감싼 command는 `SEEMIRAI_M22_PILOT_EVENT_LOG`에 JSONL event를 append해야 한다.

필수 heartbeat:

```json
{"type":"m22_pilot_heartbeat","observedAt":"2026-06-10T00:00:00.000Z","runtimeReady":true,"market":"KRW-BTC"}
```

선택 event:

```json
{"type":"broker_submission","observedAt":"2026-06-10T00:10:00.000Z","market":"KRW-BTC","side":"BUY","idempotencyKey":"m22a-redacted"}
{"type":"order_submitted","observedAt":"2026-06-10T00:10:01.000Z","market":"KRW-BTC","status":"SUBMITTED"}
{"type":"daily_report_generated","observedAt":"2026-06-10T23:59:00.000Z","reportDate":"2026-06-10"}
```

실패 event는 closeout을 실패로 만든다.

```json
{"type":"risk_gate_bypass","observedAt":"2026-06-10T00:00:00.000Z"}
{"type":"reconcile_mismatch","observedAt":"2026-06-10T00:00:00.000Z"}
{"type":"duplicate_order","observedAt":"2026-06-10T00:00:00.000Z"}
{"type":"untracked_fill","observedAt":"2026-06-10T00:00:00.000Z"}
{"type":"unhandled_rejection","observedAt":"2026-06-10T00:00:00.000Z"}
{"type":"crash","observedAt":"2026-06-10T00:00:00.000Z"}
```

## 5. 24시간 실행

기본 실행은 다음 한 줄이다.

```sh
"$HOME/vaults/99_운영/seemirai-m22-live-autonomous/run-24h-pilot.sh"
```

이 wrapper는 내부적으로 다음 daemon을 runner 뒤에서 실행한다.

```sh
node scripts/run-m22-live-autonomous-daemon.mjs \
  --config \
  "$HOME/vaults/99_운영/seemirai-m22-live-autonomous/m22-live-autonomous.config.json" \
  --candidate-file \
  "$HOME/vaults/99_운영/seemirai-m22-live-autonomous/candidates/m22-candidates.jsonl"
```

후보 파일이 비어 있으면 daemon은 주문을 만들지 않는다. 주문 후보를 넣을 때는 한 줄 JSONL을 append한다. 아래 예시는 1회
`10000` KRW 지정가 매수 후보다.

```sh
printf '%s\n' \
  '{"candidateId":"m22-test-001","market":"KRW-BTC","side":"BUY","orderType":"LIMIT","postOnly":true,"requestedPrice":"100000000","requestedQuantity":"0.0001","requestedNotional":"10000","referencePrice":"100000000","reason":"operator-approved-test"}' \
  >> "$HOME/vaults/99_운영/seemirai-m22-live-autonomous/candidates/m22-candidates.jsonl"
```

요청 시간이 끝나면 runner는 감싼 command에 `SIGTERM`을 보내고, process log와 event log를 집계한다. command가 요청 시간 전에
종료되거나 종료 grace 안에 멈추지 않으면 failed summary가 생성된다.

### 5.1 실제 live canary cleanup

실제 주문 API를 호출하는 canary는 기본 daemon에 `--cancel-after-submit`을 붙여 실행한다. 이 옵션은 주문 제출 후 같은 uuid 또는
identifier로 즉시 취소를 요청하고, terminal cancel 상태가 확인될 때까지 짧게 조회한다.

```sh
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

성공 event 흐름은 `broker_submission` → `order_submitted` → `order_cancel_requested` → `order_cancel_submitted` →
`order_cancel_confirmed`다. `order_cancel_failed` 또는 `order_cancel_unconfirmed`가 있으면 runner summary의
`liveOrderCleanupFailureCount`가 0보다 커지고 closeout은 실패해야 한다. 이 경우 새 후보를 넣지 말고 Upbit 웹 또는 private order
lookup으로 같은 uuid/identifier 상태를 수동 확인한다.

## 6. 완료 판정

summary JSON에서 다음을 확인한다.

```text
status == "passed"
checks.closeoutZeroCounters.status == "ok"
metrics.crashCount == 0
metrics.unhandledRejectionCount == 0
metrics.riskGateBypassCount == 0
metrics.reconcileMismatchCount == 0
metrics.duplicateOrderCount == 0
metrics.untrackedFillCount == 0
metrics.liveOrderCleanupFailureCount == 0
metrics.heartbeatCount > 0
```

`--require-daily-report`를 사용한 경우 `checks.dailyReportGenerated.status == "ok"`도 확인한다.

## 7. 실패 시 조치

- `skipped`: `SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT=1`이 없어서 live command를 시작하지 않았다.
- `failed / configSafety`: 저장소 밖 config가 M22 소액 pilot 제한을 벗어났다.
- `failed / evidenceEnv`: operator arm, budget, M21 1주 gate, key scope evidence가 누락됐다.
- `failed / readinessEnv`: M20/M16/M17/M18/M19 readiness 중 하나가 `1`이 아니다.
- `failed / pilotCommand`: command가 없거나 24시간 전에 종료됐다.
- `failed / closeoutZeroCounters`: risk/reconcile/duplicate/untracked/crash 계열 event가 발생했다. 신규 entry를 중지하고 manual review로 전환한다.
