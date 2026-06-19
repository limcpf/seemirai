# 런타임 설정

이 문서는 Seemirai runtime을 어떤 안전 경계로 조립하는지 설명한다. `config/paper.json`은 MVP 기본 paper trading profile이며, API key 없이 로딩되어야 한다.

구현 기준:

- schema: `src/runtime/config.ts`
- M21 수동 승인 schema: `src/runtime/live-manual-approval-config.ts`
- M22 제한적 완전 자동매매 schema/guard: `src/runtime/live-autonomous-config.ts`
- registry 활성화 schema: `src/runtime/registry-config.ts`
- risk threshold schema: `src/runtime/risk-config.ts`
- 기본 profile: `config/paper.json`

## 책임

`config/paper.json`은 실행 시 켤 exchange, universe, strategy, rule 조합과 안전 toggle을 정의한다. 가능한 exchange, strategy, rule 목록은 코드 registry가 갖고, config는 그중 활성화할 항목만 고른다.

이 파일은 secret 저장소가 아니다. API key, Telegram token, local control token 같은 값은 git에 커밋하지 않는다.

## 최상위 구조

| 필드 | 허용값 또는 기본값 | 역할 |
| --- | --- | --- |
| `exchange` | `UPBIT` | MVP 거래소 제품 범위 |
| `market` | `KRW_SPOT` | MVP 시장 범위 |
| `mode` | `PAPER_TRADING` | 실거래 주문 없이 paper runtime으로 실행 |
| `live_trading_enabled` | `false` 필수 | 실거래 주문 API 경로 차단 |
| `withdrawal_enabled` | `false` 필수 | 출금 권한과 출금 자동화 차단 |
| `cross_exchange_arbitrage_enabled` | `false` 필수 | 거래소 간 송금/환전 차익거래 차단 |
| `futures_enabled` | `false` 필수 | 선물 범위 차단 |
| `leverage_enabled` | `false` 필수 | 레버리지 범위 차단 |
| `market_order_enabled` | `false` 필수 | 시장가 주문 기본 차단 |
| `entry_market_order_enabled` | `false` 필수 | 신규 진입 시장가 주문 차단 |
| `paper_no_key` | `true` 필수 | paper mode가 API key 없이 시작됨을 보장 |
| `universe` | `KRW-BTC`, `KRW-ETH` | MVP 거래 후보 universe |
| `universe.phase_1_5` | 비활성, 빈 수동 승인 목록 | 최대 3개 알트 수동 승인 config contract와 조건 threshold |
| `llm` | trade signal 생성 불가 | LLM이 매매 판단을 직접 만들지 못하게 제한 |
| `registry` | 정적 registry id 참조 | exchange, strategy, rule 활성화 조합 |
| `strategyParameters` | strategy별 기본 threshold | 전략 후보 생성과 rule 평가에 쓰는 보수적 기준값 |
| `risk` | M5 리스크 한도 threshold | RiskGate 평가와 상태 전이 audit에 쓰는 보수적 계정/노출/손실 한도 |
| `live_manual_approval` | `enabled=false`, `LIVE_ARMED_MANUAL_APPROVAL` | M21 수동 승인 live pilot proposal/config guard |
| `live_autonomous` | `enabled=false`, `LIVE_AUTONOMOUS_SMALL_BUDGET` | M22 제한적 완전 자동매매 config/startup guard |
| `telegram` | `provider_timeout_ms=5000`, optional `chat_id`, `inbound.enabled=false` | Telegram outbound notifier와 M20 inbound polling guard 설정 |
| `secrets` | 기본 `{}` | schema shape만 표현하며 실제 secret은 저장하지 않음 |

## 안전 invariant

MVP 기본 profile에서는 다음 값이 켜져 있으면 안 된다.

```json
{
  "live_trading_enabled": true,
  "withdrawal_enabled": true,
  "cross_exchange_arbitrage_enabled": true,
  "futures_enabled": true,
  "leverage_enabled": true,
  "market_order_enabled": true,
  "entry_market_order_enabled": true,
  "paper_no_key": false
}
```

`assertSafeRuntimeConfig`는 위반 값을 발견하면 runtime config 로딩을 실패시킨다.

## v0.2 Pilot profile guard

구현 기준 후보:

- product spec: [`product-specs/upbit-v0-2-pilot-private-api.md`](./product-specs/upbit-v0-2-pilot-private-api.md)
- 기본 profile: `config/paper.json`
- 기본 runtime guard: `assertSafeRuntimeConfig`

v0.2 pilot은 `config/paper.json`을 실거래 profile로 바꾸지 않는다. `PAPER_NO_KEY`는 계속 `paper_no_key=true`,
`live_trading_enabled=false`, `withdrawal_enabled=false`, `market_order_enabled=false`,
`entry_market_order_enabled=false`로 유지한다.

pilot profile은 env 기반 실행 guard로만 열며, 기본 runtime config의 안전 invariant를 우회해 자동 주문 runtime을 켜는 용도가
아니다. 후속 구현은 별도 `PilotRuntimeConfig` 또는 pilot runner 입력을 두고, 다음 조합을 fail-closed로 검증해야 한다.

| guard | private read smoke | order smoke |
| --- | --- | --- |
| `SEEMIRAI_PILOT_PROFILE=PILOT_READ_ONLY` | 허용 | 금지 |
| `SEEMIRAI_PILOT_PROFILE=PILOT_POLICY_SYNC` | 허용 | 금지 |
| `SEEMIRAI_PILOT_PROFILE=PILOT_ORDER_SMOKE` | 허용 | 조건부 허용 |
| `SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE=1` | 필수 | 필수 |
| `SEEMIRAI_RUN_UPBIT_ORDER_SMOKE=1` | 불필요 | 필수 |
| `SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID` | 필수 | 필수 |
| `SEEMIRAI_UPBIT_POLICY_SYNC_MARKET` | `PILOT_POLICY_SYNC`에서 필수 | order smoke market과 같아야 함 |
| `SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET` | 불필요 | 필수 |
| `SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW` | 불필요 | 필수, 5,000~50,000 KRW |
| `SEEMIRAI_UPBIT_ORDER_SMOKE_PRICE` | 불필요 | 실제 smoke 실행 시 필수 |
| `SEEMIRAI_UPBIT_ORDER_SMOKE_VOLUME` | 불필요 | 실제 smoke 실행 시 필수 |
| `SEEMIRAI_UPBIT_ORDER_SMOKE_IDENTIFIER` | 불필요 | 실제 smoke 실행 시 필수, 32자 이하 고유값 |
| `SEEMIRAI_UPBIT_SMOKE_ARTIFACT_DIR` | 선택 | 선택, 미지정 시 `test-results/upbit-smoke` |

pilot private read smoke는 `자산조회`와 `주문조회` 권한만 요구한다. order smoke는 추가로 `주문하기` 권한을 요구하지만,
`출금조회`, `출금하기`, 입출금 자동화, 선물/레버리지 관련 권한이나 설정이 관찰되면 profile을 시작하지 않는다.

order smoke는 다음 runtime invariant를 모두 만족해야 한다.

- market은 KRW 현물이어야 한다.
- 주문 방향은 KRW 예산 상한으로 노출을 제한할 수 있는 매수(`side=bid`)만 허용한다.
- 주문 유형은 `ord_type=limit`만 허용한다.
- `time_in_force=post_only`가 필수다.
- smoke run의 idempotency key를 Upbit 계정 내 고유하고 32자 이하인 `identifier`로 주문 생성 요청에 포함해야 한다.
- 실제 order smoke test는 운영자가 명시한 `price`, `volume`, `identifier` 없이는 주문 API 호출 전에 fail-closed 한다.
- smoke 총액은 Upbit 최소 주문금액 이상이고 운영자가 설정한 소액 상한 이하이어야 한다.
- 주문 취소와 상태 조회는 같은 smoke run에서 전송한 `identifier`로만 허용한다.
- `PILOT_ORDER_SMOKE`는 전략 worker, paper execution worker, kill switch 자동 주문 흐름을 대체하거나 연결하지 않는다.

`/status` 또는 운영 CLI에 pilot 상태를 노출할 경우 safe summary만 반환한다. 허용 가능한 값은 profile id, guard 충족 여부,
권한 evidence id, 마지막 smoke 시각, 마지막 smoke 상태, redacted correlation id 수준이며, API key 원문, secret key 원문,
JWT, Authorization header, raw order response는 노출하지 않는다.

실제 smoke artifact는 저장 전 access key, secret key, raw Authorization/JWT 포함 여부를 검사한다. 계정 잔고는 통화 목록과
KRW 계정 존재 여부 수준으로 요약하고, 정책/주문 결과는 raw provider payload가 아니라 수수료, 최소/최대 주문금액, 주문 상태
필드만 저장한다.

## M15 UpbitLiveBroker 조립 guard

구현 기준:

- 완료 기록: [`exec-plans/completed/2026-06-02-issue-135-m15-upbit-live-broker.md`](./exec-plans/completed/2026-06-02-issue-135-m15-upbit-live-broker.md)
- live broker contract: `src/infrastructure/upbit/live-broker.ts`
- 기본 paper 조립: `src/runtime/execution-runtime.ts`

M15는 `UpbitLiveBroker` 구현을 추가하지만 기본 `config/paper.json`을 live profile로 승격하지 않는다. `PAPER_NO_KEY` runtime은 계속
`PaperBroker`만 active `BrokerPort`로 조립하고, `DisabledUpbitLiveBroker`는 회귀 guard로 남긴다.

M15 live broker factory는 다음 조건을 모두 만족하는 명시 입력에서만 실제 broker를 생성해야 한다.

| 조건 | 의미 |
| --- | --- |
| pilot/live profile guard | 기본 paper runtime이 아니라 운영자가 선택한 private API 검증 경계 |
| `SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE=1` | private read API 호출 승인 |
| `SEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE=1` | M15 live broker smoke 실행 승인 |
| `SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID` | 저장소 밖 redacted 권한 확인 증거 |
| credential input | access key와 secret key를 env 또는 외부 secret 주입으로만 전달 |

주문 생성 smoke를 실행할 때는 기존 M14 order smoke guard도 함께 요구한다.

- `SEEMIRAI_RUN_UPBIT_ORDER_SMOKE=1`
- `SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET`
- `SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW`
- `SEEMIRAI_UPBIT_ORDER_SMOKE_PRICE`
- `SEEMIRAI_UPBIT_ORDER_SMOKE_VOLUME`
- `SEEMIRAI_UPBIT_ORDER_SMOKE_IDENTIFIER`

`UpbitLiveBroker.submitOrder`는 M15에서 `LIMIT` 주문만 허용한다. 내부 `OrderSubmission.intent.idempotencyKey`는 Upbit
`identifier`로 그대로 전송하며, 1자 이상 32자 이하가 아니면 거래소 호출 전 fail-closed 한다. 자동 truncate/hash는 숨은 충돌을
만들 수 있으므로 M15 범위에서 금지한다.

`time_in_force=post_only`는 우선 지원 대상이고, `post_only`와 `smp_type`이 동시에 설정되면 Upbit 호출 전에 차단한다. `ord_type=price`,
`ord_type=market`, `ord_type=best`는 M15 신규 진입 주문에서 금지한다.

factory, status summary, smoke artifact는 access key, secret key, JWT, Authorization header, raw provider payload를 반환하지 않는다.
허용 가능한 노출 값은 profile id, guard 충족 여부, 권한 evidence id, market, 주문 상태 요약, redacted correlation id, rate-limit
safe summary 수준이다.

## M16 Live Read-Only Reconcile guard

구현 기준:

- 실행 계획: [`exec-plans/completed/2026-06-02-issue-143-m16-live-reconcile.md`](./exec-plans/completed/2026-06-02-issue-143-m16-live-reconcile.md)
- runtime mode label: `LIVE_READ_ONLY_RECONCILE`
- guard env: `SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1`

M16 read-only reconcile runtime은 실계좌 상태를 조회하고 로컬 상태와 대조하지만 주문 side effect를 만들지 않는다.

| 조건 | 의미 |
| --- | --- |
| `SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1` | reconcile worker 시작 승인 |
| 허용 private 권한 | `자산조회`, `주문조회`만 요구 |
| `SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID` | 저장소 밖 redacted 권한 확인 증거 (M15 pilot smoke와 공유) |
| credential input | access key와 secret key를 env 또는 외부 secret 주입으로만 전달 |

**금지 사항:**

- `주문하기` 권한 요구 금지
- `POST /v1/orders`, `DELETE /v1/order` 호출 금지
- 자동 전략 루프에서 live broker 연결 금지
- PnL 계산 금지 (평균단가/PnL은 `계산 불가/수동 검토 필요`로 남긴다)
- closed order는 `start_time`/`end_time` 지정으로 7일 이하 구간 조회, 조회 horizon 밖 또는 identity/fingerprint 불일치 시 자동 복구 금지

**Status summary 기준 (secret-safe):**

reconcile summary는 `/status` 또는 CLI에서 다음 필드를 secret 없이 노출한다.

| 필드 | 설명 |
| --- | --- |
| `lastReconcileAt` | 마지막 reconcile 실행 시각 (ISO 8601) |
| `result` | `SUCCESS`, `MISMATCH_DETECTED`, `FAILED`, `SKIPPED` |
| `mismatchCount` | 감지된 mismatch 수 |
| `openOrderCount` | 현재 open order 수 |
| `balanceStatus` | balance snapshot 상태 (`OK`, `STALE`, `UNAVAILABLE`) |
| `websocketStatus` | private WebSocket 연결 상태 (`CONNECTED`, `DISCONNECTED`, `RECONNECTING`, `DEGRADED`) |
| `actionRequired` | 한국어로 표시된 필요 조치 (`정상`, `불일치 확인 필요`, `수동 검토 필요`) |

내부 식별자(run id, mismatch id, correlation id)는 `추적 정보` 하위 객체에 분리해 보존한다. `/status`와 CLI summary는
mismatch trace detail, raw order detail, fingerprint를 노출하지 않는다. 상세 evidence는 저장소 밖 운영 리포트 또는 보호된 debug
tooling에서 redaction 후 조회한다.

## Phase 1.5 알트 수동 편입 설정

구현 기준:

- schema: `src/runtime/phase-1-5-config.ts`
- evidence contract: `src/domain/phase-1-5.ts`
- 기본 profile: `config/paper.json`

`universe.phase_1_5`는 BTC/ETH phase 1 universe를 유지한 상태에서, 운영자가 근거 snapshot을 확인한 알트만 paper
runtime 후보에 추가하기 위한 config contract다. 기본 profile은 비활성이고 수동 승인 목록이 비어 있으므로 기존
`KRW-BTC`/`KRW-ETH` 동작을 바꾸지 않는다.

```json
{
  "universe": {
    "phase_1_5": {
      "enabled": false,
      "candidate_markets": [],
      "manual_approvals": [],
      "max_manual_approvals": 3,
      "thresholds": {
        "min_listing_age_days": 90,
        "min_30d_avg_trade_value_krw": "10000000000",
        "max_7d_spread_p95_bps": "15",
        "max_expected_slippage_bps": "20",
        "min_depth_krw": "100000000"
      }
    }
  }
}
```

| 필드 | 기본값 | 의미 |
| --- | ---: | --- |
| `enabled` | `false` | phase 1.5 수동 승인 목록을 runtime universe에 반영할지 여부 |
| `candidate_markets` | `[]` | 운영자가 검토할 KRW 알트 후보 목록 |
| `manual_approvals` | `[]` | 승인 시각, 승인자, evidence id, 만료 시각을 가진 수동 승인 목록 |
| `max_manual_approvals` | `3` | 동시에 승인할 수 있는 알트 수 상한 |
| `thresholds.min_listing_age_days` | `90` | 상장 후 최소 경과 일수 |
| `thresholds.min_30d_avg_trade_value_krw` | `10000000000` | 30일 평균 거래대금 최소값 |
| `thresholds.max_7d_spread_p95_bps` | `15` | 최근 7일 spread p95 허용 상한 |
| `thresholds.max_expected_slippage_bps` | `20` | 주문금액 대비 예상 slippage 허용 상한 |
| `thresholds.min_depth_krw` | `100000000` | 주문 후보 검토에 필요한 최소 depth |

config invariant:

- `manual_approvals`는 최대 3개이며 중복 market을 허용하지 않는다.
- `candidate_markets`와 `manual_approvals[].market`은 `KRW-BTC`, `KRW-ETH`를 포함할 수 없다.
- `expires_at`이 있으면 `approved_at`보다 뒤여야 한다.
- threshold 숫자는 음수가 아닌 Decimal string이어야 한다.
- 이 설정은 자동 신규 상장 편입을 열지 않으며, 실제 편입 여부는 후속 evaluator가 market warning/caution, 유동성,
  slippage, depth evidence를 모두 통과한 뒤 audit evidence와 함께 결정한다.
- runtime universe는 수동 승인 config만으로 알트를 열지 않는다. 승인 시각 이후 현재 시각 이하의 `APPROVE` evidence가
  없거나, 최신 evidence가 `REJECT`/`REVOKE`/`EXPIRE`이면 해당 알트는 fail-closed로 phase 1 universe 밖에 둔다.
- `manual_approvals[].evidence_id`가 있으면 같은 id의 승인 evidence를 기준으로 삼고, 더 최신의 다른 `APPROVE` snapshot이
  있어도 기존 승인 근거를 덮어쓰지 않는다. 단 승인 시각 이후의 차단 evidence는 항상 우선한다.
- runtime universe는 현재 조립 중인 exchange id와 일치하는 approval evidence만 인정한다.
- `APPROVE` evidence는 `listing_age`, `market_warning`, `market_caution`, `thirty_day_average_trade_value`,
  `seven_day_spread_p95`, `expected_slippage`, `depth` 조건이 모두 존재하고 통과해야 승인 근거로 인정한다.
- market-data/execution runtime과 `/status`는 `PHASE_1_5_ALT_APPROVAL` audit event를 같은 evidence snapshot으로 읽어
  승인 알트 목록을 해석한다. audit 조회가 실패하거나 evidence가 없으면 승인 알트는 열지 않는다.
- 승인/거부/철회/만료 evidence는 `PHASE_1_5_ALT_APPROVAL` audit event로 남긴다. payload는
  `audit_kind=PHASE_1_5_ALT_APPROVAL`, action, market, threshold snapshot, 조건별 판정, 한국어 상태/필요 조치 문구를 포함한다.
- `/status.runtime.universe.phase15`는 safe summary로 `enabled`, 승인 알트 목록/개수, 후보 목록/개수, 최대 수동 승인 수만 노출한다.
  secret, raw config 전체, operator token은 노출하지 않는다.

## M10 LLM 리스크 보조 설정

구현 기준:

- contract/schema: `src/application/llm-risk-assistant/**`
- Codex OAuth provider: `src/infrastructure/codex-oauth/provider.ts`
- 기본 profile: `config/paper.json`
- gated smoke: `tests/unit/llm-risk-assistant-provider.test.ts`

`llm.enabled`는 LLM 보조 계층 사용 가능 여부를 나타내고, `llm.can_generate_trade_signal`은 반드시 `false`여야 한다.
`assertSafeRuntimeConfig`는 이 값이 `true`인 profile을 부팅 전에 거부한다. 이 invariant는 LLM 결과가 전략 후보, 주문 intent,
주문 허용 판단으로 직접 연결되는 경로를 만들지 않기 위한 최상위 config guard다.

provider 구현은 application port 뒤에 있으며 현재 지원 provider id는 `noop`, `codex_oauth`다. `codex_oauth`는 운영자 로컬
Codex OAuth 세션을 사용하는 owner-operated provider이고, `noop`은 같은 normalized response union을 유지하면서 외부 호출을
만들지 않는 비활성 provider다. provider 선택, timeout, max output bytes는 `LlmRiskAssistantProviderRequest`의 호출 경계에서
명시하며, 기본 `config/paper.json`은 M9 paper runtime 동작을 흔들지 않도록 거래 안전 toggle만 보유한다.

실제 Codex OAuth smoke는 기본 test/CI에서 실행하지 않는다. 운영자가 다음 env를 명시했을 때만 긴 외부 호출을 허용한다.

```sh
SEEMIRAI_RUN_CODEX_LLM_SMOKE=1 corepack pnpm exec vitest run tests/unit/llm-risk-assistant-provider.test.ts
```

provider timeout, invalid JSON, free-form output, output size 초과는 모두 fail-closed failure response로 정규화한다. 실패 response는
audit evidence와 사람 검토 후보로 남길 수 있지만, RiskGate 주문 허용 신호나 strategy candidate를 만들 수 없다.

## M8 HTTP control foundation

구현 기준:

- server/route foundation: `src/interfaces/http-control.ts`
- auth/readiness/status/schema 세부 구현: `src/interfaces/http-control/*.ts`
- 기본 bind: `127.0.0.1`
- 기본 port: `8787`

M8 HTTP control API는 headless worker의 로컬 운영 endpoint다. Sub PR 1에서는 읽기 전용 endpoint와 POST control
endpoint가 공통으로 사용할 인증 guard만 고정한다.

읽기 endpoint:

- `GET /healthz`: process alive만 확인한다. DB, migration, runtime dependency를 확인하지 않는다.
- `GET /readyz`: DB 연결, DB write check, migration version, runtime config loaded 상태를 readiness summary로 반환한다.
  DB write check는 `jobs` 실제 앱 테이블에 rollback 가능한 insert를 수행해 TEMP table 권한만 있는 상태를 ready로 보지 않는다.
- `GET /status`: full config 대신 safe summary만 반환한다. DB write check는 실행하지 않고 read-only 관측에 필요한
  runtime config, DB connection, migration version만 경량 readiness로 확인한다.

`/status` safe summary는 다음 필드만 노출한다.

- runtime: `exchange`, `market`, `mode`, phase 1 universe, phase 1.5 safe summary, live trading toggle, `paperNoKey`
- trading state: current kill switch state, blocked reason, 신규 주문 차단 여부, 수동 검토 필요 여부
- market data: connection status, lag ms, updated time
- paper: `paper_orders`에 연결된 pending paper order count, open position count, 조회 상태의 한국어 label/message/action
- database: `/readyz`에서 write check를 제외한 경량 readiness summary
- alerts: `alert_cooldowns`에서 읽은 last sent/skipped timestamp, 조회 상태의 한국어 label/message/action
- daily report: `jobs`의 `report.daily` 최신 row에서 읽은 last status, report date, next run time, updated time,
  조회 상태의 한국어 label/message/action
- PnL: `pnl_snapshots`의 최신 safe summary에서 평가자산, 실현/미실현 손익, drawdown, snapshot count,
  조회 상태의 한국어 label/message/action. production 실주문 preflight의 손실 증거로 쓰려면 `readStatus=OK`뿐 아니라
  완료 계열 snapshot status와 30초 freshness를 함께 만족해야 하며, `PARTIAL`/manual-review/unavailable snapshot은 0 손실로 보정하지 않는다.

`/status`는 `secrets`, local control token, Telegram token, raw headers, raw order detail, raw position detail을 반환하지 않는다.
kill switch가 `NEW_ORDERS_BLOCKED` 또는 `HARD_STOP` 같은 active 상태여도 `/readyz` 실패로 표현하지 않고
`/status.tradingState`에만 나타낸다.
paper/alerts/daily report 같은 운영 관측 집계가 DB 조회에 실패하면 endpoint 전체를 실패시키지 않고 해당 하위 객체의
`status=unavailable`, `null` 값, 한국어 필요 조치로 낮춘다. 내부 source/reason/idempotency key 같은 추적 정보는 각 하위
객체의 `trace`에 분리해 보존하며 raw provider error, secret, token은 노출하지 않는다.

POST control endpoint는 후속 PR에서 `/kill-switch`를 등록한다. 이 foundation은 `Authorization: Bearer <token>` 검증
함수와 Fastify `preHandler`를 제공하며, POST control endpoint가 활성화된 상태에서 local control token이 없으면 startup
fail한다. 실제 secret 값은 env 또는 외부 secret 주입으로 전달하고 config/document/status에 기록하지 않는다.

M8 Sub PR 2부터 `POST /kill-switch`를 등록할 수 있다. 이 route는 local bearer token을 통과한 요청만 받으며,
request body는 다음 target state로 제한한다.

- `NEW_ORDERS_BLOCKED`
- `HARD_STOP`
- `MANUAL_REVIEW_REQUIRED`
- `NORMAL`

`STRATEGY_PAUSED`는 전역 HTTP control route의 target에서 제외한다. 전략별 pause/resume은 strategy 상태 저장소와
audit evidence가 별도로 확정될 때 별도 endpoint로 다룬다.

`POST /kill-switch`는 `kill_switch_state` durable snapshot을 현재 state와 대조한 뒤 state machine으로 전이를 판단한다.
`HARD_STOP -> NORMAL` 직접 전환은 거부되고, `HARD_STOP -> MANUAL_REVIEW_REQUIRED -> NORMAL` 경로를 요구한다.
허용/거부된 전이 시도는 모두 `audit_events`와 `risk_events`에 correlation id와 함께 남긴다. 허용된 전이는 같은 DB
transaction에서 `kill_switch_state`를 전진시키며, `HARD_STOP`은 pending paper order cancel을 즉시 실행하지 않고
`hard_stop_pending_paper_order_cancel` job으로 예약한다. 이 job payload의 action plan은
`auto_liquidate_open_positions=false`를 유지한다.

P0/P1 원인 mapping은 application layer의 `mapKillSwitchReasonToTargetState`가 제공한다.

| 원인 | target |
| --- | --- |
| `db_write_failure`, `order_idempotency_violation`, `duplicate_order_idempotency_key`, `fill_order_accounting_mismatch`, `risk_limit_calculation_unavailable`, `audit_persistence_failure`, `live_order_api_misuse_detected` | `HARD_STOP` |
| `stale_market_data`, `public_websocket_lag`, `quote_freshness_insufficient`, `transient_external_data_gap`, `live_reconcile_mismatch` | `NEW_ORDERS_BLOCKED` |
| `notification_consecutive_failure`, `notification_failure_threshold_exceeded`, `report_generation_repeated_failure`, `abnormal_state_operator_review_required`, `live_reconcile_identity_conflict` | `MANUAL_REVIEW_REQUIRED` |

## M8 Telegram outbound 알림

구현 기준:

- application policy: `src/application/alerts/index.ts`
- outbound adapter: `src/infrastructure/telegram/notifier.ts`
- durable cooldown repository: `src/infrastructure/db/alert-cooldown.ts`
- runtime config loader: `src/runtime/notification-config.ts`
- runtime control wiring: `src/runtime/notification-runtime.ts`
- M23 lifecycle/trade mapper: `src/application/alerts/live-ops-events.ts`

Telegram 알림은 outbound `sendMessage`만 사용한다. 이 단계는 Telegram webhook, polling, command 수신 route를 만들지
않는다. message format은 Markdown/HTML parse mode 없는 plain text다.
첫 화면에는 한국어 상태/원인/영향/필요 조치를 배치하고, `fingerprint`, audit/risk event id, correlation id 같은 내부 추적
값은 하단 `추적 정보` 섹션에만 둔다. Telegram 단일 message text 제한인 4096자를 넘으면 전송 전에 truncation marker를 붙여
잘라 provider 400으로 알림 전체가 유실되지 않게 한다.

설정 경계:

- alert environment: `SEEMIRAI_ENV` env, fallback `NODE_ENV`, 기본 `local`
- bot token 우선순위: `SEEMIRAI_TELEGRAM_BOT_TOKEN` env, legacy `TELEGRAM_BOT_TOKEN` env, `secrets.telegram_bot_token`
- chat id 우선순위: `SEEMIRAI_TELEGRAM_CHAT_ID` env, legacy `TELEGRAM_CHAT_ID` env, `telegram.chat_id`
- provider timeout: `telegram.provider_timeout_ms`, 기본 `5000`

alert fingerprint는 `environment + run_mode + severity + alert_type + market_or_global + strategy_id_or_global + reason_code`로
만든다. 주문, 체결, 취소처럼 같은 reason이 짧은 시간 안에 반복될 수 있는 alert는 선택 `dedupe_key`를 끝에 붙여 event 단위
전송을 보장한다. severity가 key에 들어가므로 P1 cooldown 중에도 같은 원인의 P0 escalation은 막히지 않는다. 각 세그먼트 안의
`:`는 `%3a`로 escape해 join 구분자와 충돌하지 않게 한다.

cooldown 기본값:

| severity | cooldown | 저장소 |
| --- | --- | --- |
| P0 | 1분 | PostgreSQL `alert_cooldowns` |
| P1 | 5분 | PostgreSQL `alert_cooldowns` |
| P2 | 1시간 | process memory |
| P3 | 6시간 | process memory |

P0/P1 provider failure는 `notification_retry` job 후보 payload와 idempotency key를 만든다. runtime alert dispatch 옵션에
retry queue가 붙어 있으면 같은 실패 경계에서 jobs table에 idempotent하게 예약한다. provider 실패가 연속 3회이거나 첫 실패
이후 10분 이상 이어지면 `notification_consecutive_failure` 또는 `notification_failure_threshold_exceeded` reason code를
반환해 kill switch mapping의 `MANUAL_REVIEW_REQUIRED` 후보로 쓸 수 있게 한다.

`createPaperNoKeyKillSwitchControlProvider`는 Telegram 설정이 있을 때 `POST /kill-switch` provider를 alert dispatch 경로와
함께 조립한다. accepted `HARD_STOP`, `NEW_ORDERS_BLOCKED`, `MANUAL_REVIEW_REQUIRED` 전이는 kill switch state/audit/risk/job
transaction이 commit된 뒤 Telegram/cooldown/audit 알림 경계로 넘어간다. Telegram 설정이 없으면 control provider는 알림 없이
동작하지만, 알림 의존성 누락으로 kill switch state update가 차단되지는 않는다. post-commit alert dispatch 실패는
`alert_dispatch_failed`로 결과 객체에 기록하고 control 전이 성공 자체를 실패로 바꾸지 않는다. 같은 runtime alert dispatch
옵션 객체는 최신 notification failure state를 보존해 연속 실패 threshold가 실제 호출 간 누적되게 한다.

M23 lifecycle/trade event는 `createLiveOpsAlertRequest`가 `live_ops_event` alert payload로 낮추고, runtime은
`dispatchLiveOpsAlert` wrapper로 전송한다. Telegram 연결 성공과 live order capable 시작은 서로 다른 reason/fingerprint를
사용한다. 주문 제출/취소/취소 확인 event는 idempotency key, local order id, broker order id, evidence id, correlation id 순서로
`dedupe_key`를 고른다. 전체/부분 체결 event는 같은 주문 키를 공유할 수 있으므로 evidence id를 우선한다. risk/cost/reconcile
차단 event는 주문 ID가 없거나 attempt id가 매번 달라질 수 있으므로, runtime은 event kind, stable reason code, 세부
failure code로 만든 evidence id를 넣고 mapper는 evidence id, risk event id, audit event id, correlation id 순서로 고른다.
같은 market/strategy에서 여러 live trade event가 5분 안에 발생해도 서로를 cooldown으로 숨기지 않는다. restart/crash/recovery는
반복 자체가 운영 evidence라 restart id 또는 evidence id를 `dedupe_key`로 쓴다. 정상 종료, operator stop,
kill switch, manual review, crash/restart/recovery, Telegram provider 장애 지속, 주문/차단 event는 첫 화면에 한국어 상태, 원인,
영향, 필요 조치와 안전한 차단 사유를 배치하고,
order id, idempotency key, audit/risk/evidence id, event kind, reason code는 `추적 정보`에만 둔다. P0/P1 live event provider
failure는 기존 `notification_retry` job payload와 manual review failure threshold 경로를 그대로 사용하며, wrapper가 같은
alert dispatch 옵션 객체에 `failureState`를 되돌려 저장해 연속 실패를 누적한다.

`LiveAutonomousEntryRuntime`은 `liveOpsAlerts` 옵션이 주입되면 실제 entry 후보 처리 경로에서 `dispatchLiveOpsAlert`를 호출한다.
비용/RiskGate/reconcile/budget 차단은 broker 제출 전 확정된 차단 event로, ExecutionEngine 제출 성공은 `ORDER_SUBMITTED`
event로 전송한다. 반복 차단은 새 attempt id로 cooldown을 우회하지 않도록 주문 제출 event에만 correlation id를 dedupe 후보로
넣고, 차단 event는 stable reason evidence id로 묶는다. 같은 비용 차단 reason은 반복 attempt가 달라도 cooldown으로 묶지만,
예산 거부와 비용 모델 차단, 서로 다른 RiskGate 실패 reason은 별도 Telegram 알림으로 남는다. 수동 점검 event는 reason/evidence별로
서로 다른 P1 cooldown key를 갖는다. broker 제출 불확실성이나 reservation release 실패처럼 주문별 수동 reconcile이 필요한 event는
reservation/attempt evidence까지 cooldown key에 넣는다.

`runExitPaperRuntime`은 `liveOpsAlerts` 옵션이 주입되면 exit broker 제출 성공을 `ORDER_SUBMITTED`, broker snapshot의 `FILLED`와
`PARTIALLY_FILLED`를 각각 전체/부분 체결 event, open 잔량 취소 호출 성공을 `CANCEL_REQUESTED` event로 전송한다.
`createLiveReconcileRuntimeWorker`는 state advancement 후보가 있으면 manual review 전이를 먼저 완료한 뒤 `FILL_CANDIDATE`,
`PARTIALLY_FILLED_CANDIDATE`, `CANCEL_CANDIDATE`를 각각 `ORDER_FILLED`, `ORDER_PARTIALLY_FILLED`, `CANCEL_CONFIRMED` event로
전송한다. 이 dispatch들은 주문 판단, broker submit/cancel, reconcile run 결과를 바꾸지 않는 best-effort 후속 side effect이며,
alert 저장소나 provider 예외가 이미 확정된 차단/제출/취소/reconcile 결과를 rollback하지 않는다.

provider 호출 직전에는 fingerprint 단위 delivery reservation을 먼저 기록한다. 이 atomic gate는 마지막 성공 전송이 cooldown
안에 있거나 기존 reservation이 만료되지 않았으면 provider 호출 없이 `ALERT_COOLDOWN` audit evidence만 남긴다. 이 경계는
같은 장애가 동시에 들어와도 두 요청이 모두 Telegram provider를 호출하는 상황을 막기 위한 것이다. cooldown 기준 시각은
alert 발생 시각이 아니라 reservation/전송 완료 시각을 사용해 지연 처리된 과거 alert가 보호 창을 짧게 만들지 못하게 한다.

## M20 Telegram inbound polling guard

구현 기준:

- application contract: `src/application/telegram-inbound.ts`
- polling adapter: `src/infrastructure/telegram/polling.ts`
- reply adapter: `src/infrastructure/telegram/reply.ts`
- command/polling runtime: `src/runtime/telegram-inbound-runtime.ts`
- runtime config loader: `src/runtime/notification-config.ts`
- durable dedupe store: `src/infrastructure/db/telegram-inbound-dedupe.ts`

M20 inbound는 public webhook endpoint를 만들지 않고 Telegram `getUpdates` polling을 우선 transport로 사용한다. 기본
`config/paper.json`은 `telegram.inbound.enabled=false`이며, config 또는 env에서 명시적으로 켜지 않으면 polling provider를
시작하지 않는다.

설정 경계:

- enable flag: `telegram.inbound.enabled` 또는 `SEEMIRAI_TELEGRAM_INBOUND_ENABLED=1`
- bot token 우선순위: `SEEMIRAI_TELEGRAM_BOT_TOKEN` env, legacy `TELEGRAM_BOT_TOKEN` env, `secrets.telegram_bot_token`
- bot username: `SEEMIRAI_TELEGRAM_INBOUND_BOT_USERNAME` env, fallback `telegram.inbound.bot_username`
- owner chat allowlist: `SEEMIRAI_TELEGRAM_INBOUND_OWNER_CHAT_IDS` env, fallback `telegram.inbound.owner_chat_ids`
- optional owner user allowlist: `SEEMIRAI_TELEGRAM_INBOUND_OWNER_USER_IDS` env, fallback `telegram.inbound.owner_user_ids`
- polling interval: `SEEMIRAI_TELEGRAM_INBOUND_POLLING_INTERVAL_MS`, fallback `telegram.inbound.polling_interval_ms`
- provider long polling timeout: `SEEMIRAI_TELEGRAM_INBOUND_POLLING_TIMEOUT_SECONDS`, fallback `telegram.inbound.polling_timeout_seconds`
- batch limit: `SEEMIRAI_TELEGRAM_INBOUND_MAX_UPDATES_PER_POLL`, fallback `telegram.inbound.max_updates_per_poll`

활성화된 inbound는 bot token과 owner chat allowlist가 모두 있어야 startup guard를 통과한다. owner chat allowlist가 비어 있으면
외부 입력 실행면이 열린 상태로 보므로 polling 시작 전에 fail-closed 한다.
그룹 chat에서 bot mention이 붙은 command는 mention이 없거나 설정된 bot username과 일치할 때만 parser가 인식한다. bot username이
설정되지 않은 상태에서 `/kill@SomeBot` 같은 mention command가 들어오면 다른 bot 대상일 수 있으므로 실행하지 않는다.

Sub PR 01의 inbound foundation은 command parser, allowlist, audit event, jobs table 기반 dedupe store, polling provider
projection을 제공했다. M20 runtime은 여기에 `createTelegramInboundCommandRuntime`과 `createTelegramInboundPollingRuntime`을
더해 조회 명령과 control 명령을 실제 provider 경계에 연결한다.

runtime 처리 기준:

- `/status`, `/positions`, `/pnl`, `/why <market|cash>`, `/orders`, `/risk`는 기존 safe status snapshot을 읽는
  read-only command다. 이 명령들은 `BrokerPort.submitOrder`, live broker submit/cancel, approval workflow로 연결하지 않는다.
- `/pause`, `/resume`, `/kill`은 allowlist, parser, durable dedupe, audit append를 통과한 뒤에도 60초 TTL의 동일 명령
  2단계 확인을 요구한다. TTL은 Telegram message 시각과 현재 처리 시각을 함께 기준으로 삼는다. 첫 번째 명령은 confirmation
  안내만 보내고, 두 번째 동일 명령도 메시지 시각 기준 TTL 안에 있으며 처리 시점에도 fresh할 때만 kill switch control provider를
  호출한다.
- `/pause`는 `NEW_ORDERS_BLOCKED`와 `operator_pause`, `/resume`은 `NORMAL`과 `operator_resume`, `/kill`은
  `HARD_STOP`과 `operator_kill`로만 매핑한다. `HARD_STOP -> NORMAL` 직접 복구 같은 불법 전이는 기존 kill switch state
  machine이 계속 거부한다.
- process-local confirmation pending store는 재시작 시 사라진다. 이 경우 명령은 실행되지 않고 운영자가 다시 확인 명령을 보내야
  하므로 fail-closed 동작이다.
- offset 없이 polling이 시작돼 오래된 backlog control 명령이 한 batch로 들어와도 메시지 시각 기준 확인 가능 시간이 지나 있으면
  `telegram_inbound_control_confirmation_expired`로 보류하고 provider를 호출하지 않는다.
- dedupe 저장소 장애나 audit append 장애가 발생하면 provider 실행 전에 멈추고, 가능한 경우 한국어 reply와
  `TELEGRAM_INBOUND_COMMAND` audit evidence에 실패 reason을 남긴다. raw exception message, provider body, Telegram token은
  결과 객체와 audit metadata에 싣지 않는다.
- Telegram reply는 `sendMessage`만 사용하며 4096자 제한 안으로 잘라 보낸다. reply 결과에는 provider message id와 정규화된
  실패 reason만 남기고 raw provider body는 보존하지 않는다.
- M20은 `/approve`, `/reject`, order proposal approval, 승인된 주문의 live broker 제출, Telegram public webhook endpoint를 만들지
  않는다. 이 경계는 M21 이후 별도 issue에서 다룬다.

## M21 수동 승인 live pilot guard

M21은 자동 주문 후보를 만들 수 있지만, 실제 live 주문 제출은 운영자가 Telegram에서 명시 승인한 proposal만 허용한다. 기본
`config/paper.json`은 계속 `PAPER_NO_KEY` 안전 profile이며, `live_manual_approval.enabled=false`라서 proposal 생성과 approval
submission runtime이 시작되지 않는다.

기본 설정:

```json
{
  "mode": "LIVE_ARMED_MANUAL_APPROVAL",
  "enabled": false,
  "allowed_markets": ["KRW-BTC", "KRW-ETH", "KRW-ETC"],
  "max_order_krw": "10000",
  "daily_approved_notional_limit_krw": "30000",
  "proposal_ttl_seconds": 300,
  "max_price_deviation_bps": "30",
  "require_reconcile_freshness": true,
  "require_m20_inbound_enabled": true
}
```

설정 기준:

- `live_manual_approval` 하위 알 수 없는 key는 load 단계에서 거부한다. 예산·guard key 오타가 기본값으로 조용히 보정되면
  live pilot 안전 상한이 운영 의도와 달라질 수 있기 때문이다.
- `allowed_markets`는 중복 없는 KRW market code 목록이어야 한다. 기본값은 `KRW-BTC`, `KRW-ETH`, `KRW-ETC`다.
- `max_order_krw`는 Upbit KRW 최소 주문금액 이상이어야 하며 기본값은 `10000`이다.
- `daily_approved_notional_limit_krw`는 `max_order_krw` 이상이어야 하며 기본값은 `30000`이다.
- `proposal_ttl_seconds`는 양의 정수이며 기본값은 300초다.
- `max_price_deviation_bps`는 음수가 아닌 Decimal 문자열이며 기본값은 `30` bps다.
- `require_m20_inbound_enabled`와 `require_reconcile_freshness`는 반드시 `true`여야 한다. false 값은 load 단계에서 거부하며,
  bot token/owner allowlist까지 해결된 M20 Telegram inbound readiness와 최신 reconcile 상태가 없으면 runtime guard가
  fail-closed 한다. 단순 `telegram.inbound.enabled=true`만으로는 준비 완료로 보지 않는다.

Proposal contract는 `proposalId`, market, side, price, volume, expected notional KRW, 예산 snapshot, decision ledger id,
risk decision id, cost snapshot, idempotency key, operator-facing summary, `expiresAt`을 포함한다. approval evidence는 proposal
fingerprint를 함께 남겨 stale proposal 재승인과 중복 주문을 broker 호출 전에 차단한다. `expiresAt`은 같은 instant의 다른 ISO
표기가 같은 fingerprint를 만들도록 정규화한다.

Telegram approval runtime 기준:

- `/approve <proposal_id>`와 `/reject <proposal_id>`는 M20 parser/auth/dedupe/audit/reply 경계를 그대로 통과한 뒤 M21 proposal
  store로 전달된다.
- `/reject`는 `REJECTION_RECORDED` evidence만 남기고 broker를 호출하지 않는다. 단 rejection audit projection이 실패하면 성공 응답으로
  숨기지 않고 `REJECTION_AUDIT_FAILED`로 운영자에게 audit/proposal store 점검을 요구한다.
- 만료 상태 전이가 저장됐더라도 `EXPIRATION_RECORDED` audit projection이 실패하면 `PROPOSAL_EXPIRED` 성공으로 숨기지 않고
  `PROPOSAL_EXPIRATION_AUDIT_FAILED`와 reason `m21_expiration_audit_append_failed`로 운영자 점검을 요구한다.
- `/approve`는 `APPROVAL_RECORDED` evidence를 먼저 남긴 뒤 처리 시각 기준 TTL, risk decision, kill switch, reconcile freshness,
  daily budget, market allowlist, order type, `requestedPrice * requestedVolume` 재계산 금액, idempotency key, price deviation을
  재검증한다.
- 제출 직전 재검증은 broker에 실제 전달될 금액이 Upbit KRW 최소 주문금액 5,000원 이상인지, 일일 승인 예산 사용액 snapshot이
  음수가 아닌 유효한 숫자인지도 확인한다. 이 값이 깨져 있으면 예산 계산을 신뢰할 수 없으므로 broker 호출 전에 차단한다.
- proposal이 이미 `APPROVED`이면 crash/restart 또는 audit 후 중단에서 복구 중인 상태로 보고 approval evidence를 proposal store에
  중복 append하지 않는다. 대신 broker 제출 재개 전에 approval audit projection을 먼저 보강하고, 이 audit이 실패하면
  `SUBMISSION_FAILURE_RECORDED`로 닫아 감사되지 않은 승인 상태에서 broker submit으로 넘어가지 않는다. `REJECTED`, `EXPIRED`,
  `SUBMITTED`, `SUBMISSION_FAILED`는 재개 대상이 아니다.
- 재검증이 통과하면 proposal store가 expected status `APPROVED`와 fingerprint를 다시 비교한 뒤
  `SUBMISSION_RECHECK_PASSED` evidence를 기록한다. 이 append가 실패하면 broker 호출로 넘어가지 않는다.
- broker 호출 직전에는 store가 expected status/fingerprint 비교와 일일 승인 예산 선점을 같은 원자 경계에서 처리해야 한다.
  reservation이 실패하거나 예산 한도를 넘으면 `SUBMISSION_FAILURE_RECORDED`로 닫고 `BrokerPort.submitOrder`를 호출하지 않는다.
- 같은 proposal id의 reservation이 이미 있으면 다른 제출 경로가 broker 직전 gate를 선점한 상태로 본다. 이 경우 두 번째 요청은
  proposal을 `SUBMISSION_FAILED`로 닫지 않고, 추가 `BrokerPort.submitOrder` 호출만 막은 뒤 먼저 진행 중인 제출과 reconcile 상태
  확인을 요구한다.
- `SUBMISSION_RECHECK_PASSED` evidence, audit projection, daily budget reservation이 모두 끝난 뒤에만 `BrokerPort.submitOrder`를
  호출하고, broker 성공 결과는 `BROKER_SUBMISSION_RECORDED` evidence로 남긴다.
- approval 또는 재검증 통과 evidence의 audit projection이 실패하면 live broker 호출 전에 `SUBMISSION_FAILURE_RECORDED`로 닫는다.
- broker 호출 자체가 예외를 던지면 거래소 도달 여부를 단정할 수 없으므로 미제출로 기록하지 않는다. 결과는
  `brokerSubmitted=true`, reason `m21_broker_submission_uncertain`, `SUBMISSION_FAILURE_RECORDED` evidence로 남기고 운영자가 reconcile로
  실제 주문 존재 여부를 확인해야 한다.
- broker 불확실 상태를 `SUBMISSION_FAILURE_RECORDED`로 남기는 중 store 예외가 나도 Telegram wrapper까지 raw 예외를 흘리지 않는다.
  이 경우도 `brokerSubmitted=true`, reason `m21_broker_submission_uncertain_evidence_exception`, `broker_submission_state=uncertain`으로
  응답해 운영자가 주문 존재 가능성을 놓치지 않게 한다.
- broker 불확실 상태의 `SUBMISSION_FAILURE_RECORDED` audit projection이 실패하면 원래 `m21_broker_submission_uncertain` 성공적 실패
  처리로 숨기지 않고 reason `m21_broker_submission_uncertain_audit_append_failed`, `audit_status=append_failed`,
  `broker_submission_state=uncertain`을 함께 반환한다.
- 재검증 실패, 만료, 상태/fingerprint mismatch, reservation 실패, broker 불확실 결과는 성공 주문으로 처리하지 않으며, 가능한 경우
  `EXPIRATION_RECORDED` 또는 `SUBMISSION_FAILURE_RECORDED` evidence로 수렴한다.

## M22 제한적 완전 자동매매 guard

M22는 운영자가 명시적으로 arm 한 소액 예산에서만 자동 entry와 exit를 허용한다. 기본 `config/paper.json`은 계속
`PAPER_NO_KEY` 안전 profile이며, `live_autonomous.enabled=false`라서 private client, live broker, autonomous loop가 시작되지 않는다.

기본 설정:

```json
{
  "mode": "LIVE_AUTONOMOUS_SMALL_BUDGET",
  "enabled": false,
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
}
```

설정 기준:

- `live_autonomous` 하위 알 수 없는 key는 load 단계에서 거부한다. guard/evidence key 오타가 기본값으로 조용히 보정되면 live
  side effect가 운영 의도와 달리 열릴 수 있기 때문이다.
- `allowed_markets` 기본값은 `KRW-BTC` 단일이며 중복 없는 KRW market code 목록이어야 한다.
- `max_order_krw`는 Upbit KRW 최소 주문금액 이상이어야 하며 기본값은 `10000`이다.
- `max_order_krw`는 M22 소액 pilot에서 `10000`을 넘길 수 없다. 예산 확대는 M24 범위다.
- `daily_autonomous_notional_limit_krw`는 `max_order_krw` 이상이어야 하며 기본값은 `30000`이다.
- `daily_autonomous_notional_limit_krw`는 M22 소액 pilot에서 `30000`을 넘길 수 없다.
- `max_open_position_notional_krw`는 `max_order_krw` 이상이어야 하며 기본값은 `30000`이다.
- `max_open_position_notional_krw`는 M22 소액 pilot에서 `30000`을 넘길 수 없다.
- `max_weekly_loss_krw`는 `max_daily_loss_krw` 이상이어야 한다.
- `max_price_deviation_bps`는 음수가 아닌 Decimal 문자열이며 기본값은 `30` bps다.
- 모든 `require_*` guard는 반드시 `true`여야 한다. M21 1주 gate, M20 inbound readiness, M16 reconcile freshness, M17 PnL status,
  M18 decision ledger, M19 exit engine, operator arm, budget, key scope evidence 중 하나라도 준비되지 않으면 startup guard가
  private client와 live broker 조립 전에 fail-closed 해야 한다.
- Upbit 공식 주문 생성 문서는 identifier 최대 길이를 64자로 설명하지만 M22는 기존 운영 증거와 source scan 편의를 위해 32자
  보수 제한을 유지한다. 기본 권장 패턴은 `m22a-<13 bytes random hex>`이며 총 31자다.
- `LIMIT + post_only`만 자동 entry로 허용한다. 신규 진입 시장가(`ord_type=price`), 시장가 매도(`ord_type=market`), 최유리 주문
  (`ord_type=best`)은 거래소 호출 전 fail-closed 한다.
- Upbit 주문 생성 문서 기준 `post_only`는 `smp_type`과 함께 사용할 수 없으므로 이 조합은 provider 호출 전에 차단한다.
- 기본 `PAPER_NO_KEY` runtime은 M22 config를 읽는 것만으로 live order API를 호출하지 않는다.

Startup guard와 safe summary 기준:

- 구현 경계는 `evaluateLiveAutonomousRuntimeGuard`, `assertLiveAutonomousRuntimeReady`,
  `createLiveAutonomousRuntimeSafeSummary`다.
- `enabled=true`라도 M21 1주 gate evidence, operator arm evidence, budget evidence, key scope evidence가 모두 있어야 한다.
- M20 Telegram inbound readiness, M16 reconcile freshness, M17 PnL status readiness, M18 decision ledger readiness, M19 exit engine
  readiness가 모두 true여야 한다.
- safe summary는 evidence id 원문을 노출하지 않고 `m21WeekGateEvidenceConfigured`, `operatorArmEvidenceConfigured`,
  `budgetEvidenceConfigured`, `keyScopeEvidenceConfigured` boolean으로만 표시한다.
- guard 실패 결과는 한국어 message/action과 `trace.violations`를 남기지만, private client나 live broker factory를 만들지 않는다.

24시간 pilot runner 기준:

- 실행 절차는 [`runbooks/m22-live-autonomous-pilot.md`](./runbooks/m22-live-autonomous-pilot.md)를 따른다.
- runner는 `scripts/run-m22-live-autonomous-pilot.mjs`이며, `SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT=1`이 없으면 live command를 시작하지
  않고 skipped artifact만 남긴다.
- local file preparer는 `scripts/prepare-m22-live-autonomous-local-files.mjs`이며 기본 위치
  `~/vaults/99_운영/seemirai-m22-live-autonomous`에 `m22.env`, `m22.keys.env`, 저장소 밖 M22 config, evidence template,
  candidate JSONL, no-live smoke wrapper, 24시간 실행 wrapper를 만든다. secret이 들어갈 수 있는 파일은 `0600`, 실행 wrapper는
  `0700`으로 두며 기존 파일은 `--force` 없이는 덮어쓰지 않는다.
- 생성된 `m22.env`의 live guard, private/order smoke guard, readiness 값은 기본 `0`이다. 실제 evidence와 readiness를 확인한 뒤에만
  `1`로 바꿔야 하며, 단순 preflight 통과 목적의 값 변경은 M22 closeout evidence로 인정하지 않는다.
- 기본 daemon은 `scripts/run-m22-live-autonomous-daemon.mjs`이며 `run-24h-pilot.sh`를 인자 없이 실행하면 runner 뒤에서 이 daemon을
  시작한다. daemon은 `candidates/m22-candidates.jsonl`에 append된 명시 후보만 처리하며, 후보 파일이 비어 있으면 heartbeat와
  daily report evidence만 남기고 주문을 만들지 않는다.
- live canary는 daemon에 `--cancel-after-submit`을 추가해 주문 제출 직후 같은 uuid/identifier로 `DELETE /v1/order` 취소를 요청하고,
  `GET /v1/order` polling으로 terminal cancel 상태를 확인해야 한다. `order_cancel_failed` 또는 `order_cancel_unconfirmed` event는
  runner의 `liveOrderCleanupFailureCount`와 closeout failure로 집계한다.
- daemon 후보 JSONL은 `KRW-BTC`, `BUY`, `LIMIT`, `postOnly=true`, `requestedPrice`, `requestedQuantity`,
  `requestedNotional`, `referencePrice`를 포함해야 한다. daemon은 1회 `10000` KRW, 일일 `30000` KRW, open position `30000`
  KRW, Upbit 최소 주문금액 `5000` KRW, 가격 이탈 `30` bps, 일간/주간 손실 상한을 다시 확인한 뒤에만 `POST /v1/orders`를 호출한다.
- live 주문 제출에는 `SEEMIRAI_UPBIT_ACCESS_KEY`, `SEEMIRAI_UPBIT_SECRET_KEY`, `SEEMIRAI_UPBIT_KEY_SCOPE=자산조회,주문조회,주문하기`,
  `SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON=1`이 추가로 필요하다. key scope에 출금, 입출금, 선물, 레버리지, 마진 권한이 보이면 daemon은
  시작하지 않는다.
- runner는 저장소 밖 runtime config에서 `live_autonomous.enabled=true`, `KRW-BTC` 단일 market, 1회 `10000` KRW, 일일 `30000`
  KRW, open position `30000` KRW, identifier 32자 제한, 모든 `require_*` guard true를 확인한다.
- 필수 evidence env는 `SEEMIRAI_M22_OPERATOR_ARM_EVIDENCE_ID`, `SEEMIRAI_M22_BUDGET_EVIDENCE_ID`,
  `SEEMIRAI_M22_M21_WEEK_GATE_EVIDENCE_ID`, `SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID`다. 값 원문은 artifact에 남기지 않는다.
- 필수 readiness env는 `SEEMIRAI_M22_TELEGRAM_INBOUND_READY`, `SEEMIRAI_M22_RECONCILE_FRESH`,
  `SEEMIRAI_M22_PNL_STATUS_READY`, `SEEMIRAI_M22_DECISION_LEDGER_READY`, `SEEMIRAI_M22_EXIT_ENGINE_READY`이며 모두 `1`이어야 한다.
- runner가 감싸는 live command는 `SEEMIRAI_M22_PILOT_EVENT_LOG` JSONL에 `m22_pilot_heartbeat`와 주문/reconcile/report evidence를
  append해야 한다. `risk_gate_bypass`, `reconcile_mismatch`, `duplicate_order`, `untracked_fill`, `crash`,
  `unhandled_rejection` event는 24시간 closeout 실패 조건이다.
- process log는 runner가 redaction한 stdout/stderr 요약만 저장한다. live command는 raw credential, raw provider payload,
  Authorization/JWT, Telegram token을 event log에 쓰면 안 된다.

M23 live-armed 운영 기준:

- Issue #188 M23 운영은 `LIVE_AUTONOMOUS_SMALL_BUDGET`의 기존 M22 소액 제한을 유지한다. `max_order_krw=10000`,
  `daily_autonomous_notional_limit_krw=30000`, `max_open_position_notional_krw=30000`, `KRW-BTC` 단일 기본값은 M23에서 자동으로
  높이지 않는다.
- M23 7일 안정화는 dry-run이나 heartbeat-only가 아니라 실제 주문 API를 호출할 수 있는 설정으로 arm 되어야 한다. 단, 시장 조건이
  gate를 통과하지 못하면 주문이 없어도 되며, 이 경우 후보 없음, gate 차단, 시장 조건 미충족 같은 이유가 daily report와 decision
  evidence에 남아야 한다.
- 운영자가 허용한 손실 ceiling은 누적 realized loss와 미체결 노출 합계 50,000 KRW 미만이다. 이 값은 자동 예산 확대 승인이 아니며,
  ceiling 접근 시 operator stop 또는 kill switch/manual review로 수렴해야 한다.
- status, CLI, Telegram, daily report safe summary는 현재 모드(dry-run, heartbeat-only, live armed, live order capable), live
  enabled, key scope 안전성, readiness, latest heartbeat/reconcile/candidate/decision/order/fill/cancel, budget/exposure/PnL,
  risk block, alert retry 상태를 secret 없이 보여줘야 한다.
- process supervisor/systemd 운영은 root가 아닌 운영 사용자로 실행하고 저장소 밖 env/key 파일을 참조해야 하며, service unit에는 secret
  값을 직접 쓰지 않는다.
  `scripts/run-m23-recovery-drill.mjs`는 restart 전후 event log artifact만 읽어 duplicate live order 방지, reconcile/status/daily
  report 복구, Upbit 장애/market warning/stale data fail-closed evidence, DB backup/restore 결과 또는 blocker 기록을 검증한다.
  이 validator는 기본 CI/PR 검증에서 live API, Telegram provider, DB restore를 직접 호출하지 않는다.
- `scripts/run-m23-stability-closeout.mjs`는 7일 closeout manifest와 저장소 밖 summary artifact만 읽어 7개 이상 24시간 segment,
  daily report, live-armed guard/readiness, decision evidence, recovery drill, source scan, DB backup/restore 결과 또는 blocker를
  집계한다. 이 validator도 기본 CI/PR 검증에서는 fixture smoke만 실행하며 live API, Telegram provider, DB restore를 직접 호출하지 않는다.
- M23 이후 universe, strategy, budget 확대는 M24 범위다. M23 config나 runbook은 BTC 외 market 기본 활성화, 자동 budget 확대,
  market/best order 기본 허용을 열지 않는다.

## Issue #196 production live ops config/env 기준

Issue #196은 M22/M23 pilot runner를 실운영 주경로로 쓰지 않고, `live:ops`와 TUI-first 운영 콘솔을 production 경계로 분리한다.

구현 기준:

- config schema: `src/runtime/live-ops-config.ts`
- DB readiness guard: `src/runtime/live-ops-db-readiness.ts`
- market data collector: `src/runtime/live-ops-market-data.ts`
- analysis/decision pipeline: `src/runtime/live-ops-analysis-decision.ts`
- live execution adapter: `src/runtime/live-ops-live-execution.ts`
- Telegram alert mapper: `src/runtime/live-ops-telegram-alerts.ts`
- CLI/TUI reconcile/PnL/status summary: `scripts/run-live-ops-support.mjs`
- script skeleton: `scripts/run-live-ops.mjs`, `scripts/run-live-ops-tui.mjs`
- 예시 JSON: `config/live-ops.example.json`
- 예시 env: `config/live-ops.env.example`
- 실행 command:
  `corepack pnpm live:ops -- --config <운영-json-path> --env-file <운영-env-path> --tui`
- attach command:
  `corepack pnpm live:ops:tui -- --config <운영-json-path> --env-file <운영-env-path> --attach <run-id|socket|status-source>`

JSON config에는 다음처럼 secret이 아닌 운영 정책만 둔다.

- `mode=LIVE_AUTONOMOUS_SMALL_BUDGET`
- `live_trading_enabled=true`
- `paper_no_key=false`
- `withdrawal_enabled=false`, `futures_enabled=false`, `leverage_enabled=false`
- `market_order_enabled=false`, `entry_market_order_enabled=false`
- universe는 첫 production 단계에서 `KRW-BTC` 단일
- 1회 주문 `10000` KRW, 일일 자동 주문 `30000` KRW, open position `30000` KRW, 운영 중지 ceiling `50000` KRW 미만
- DB readiness, market data, analysis/decision, live execution, reconcile/PnL/status, Telegram, TUI worker는 모두 켜진 정책으로 둔다.

env file에는 credential만 둔다.

- `SEEMIRAI_DATABASE_URL`
- `SEEMIRAI_UPBIT_ACCESS_KEY`
- `SEEMIRAI_UPBIT_SECRET_KEY`
- `SEEMIRAI_TELEGRAM_BOT_TOKEN`
- `SEEMIRAI_TELEGRAM_CHAT_ID`
- `SEEMIRAI_TUI_CONTROL_TOKEN`

production live ops path에서 다음 legacy milestone/test env는 readiness 입력으로 사용하지 않는다.

- `SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT`
- `SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON`
- `SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE`
- `SEEMIRAI_RUN_UPBIT_ORDER_SMOKE`
- `SEEMIRAI_PILOT_PROFILE`
- `SEEMIRAI_M22_*_READY`

`live:ops`/`live:ops:tui`는 config/env contract 검증 이후 DB readiness를 먼저 계산한다. fixture smoke에서는 외부 DB에 연결하지 않고
디스크 migration 기준만 확인하며, 실제 실행에서는 `SEEMIRAI_DATABASE_URL`로 read-only 연결 probe와 `schema_migrations` 적용 이력을
조회한다. pending migration, missing table, unknown applied migration, checksum drift는 live worker boot 전에 fail-closed 한다.

`live:ops -- --tui`와 `live:ops:tui -- --attach ...`는 같은 secret-safe TUI dashboard renderer를 사용한다. 단, attach TUI는 기존 실행
상태를 읽는 화면이므로 non-fixture에서도 foreground boot sequence, Upbit public/private provider, live broker, cleanup lifecycle,
Telegram dispatch를 새로 시작하지 않는다. non-fixture attach 대상은 기존 foreground 실행이 남긴 JSON status source여야 하며, source를
읽지 못하거나 필수 summary 항목이 없으면 정상 dashboard를 합성하지 않고 fail-closed 한다. `--attach` 인자는 `live:ops:tui`에서만 허용하고
foreground `live:ops` 명령에서는 성공 처리하지 않는다. 첫 화면은 모드, 시장, 실주문 가능 여부, DB readiness/schema version, worker 상태,
예산, 최근 관측 상태, 필요 조치를 한국어로 표시하고, env file 경로, credential, raw provider payload, raw config enum은 노출하지 않는다.
fixture smoke dashboard는 외부 DB/provider를 호출하지 않았음을 표시하고, 후속 provider 연결 전에는 신규 실주문이 제출되지 않는 상태로
고정한다.

`LiveOpsMarketDataCollector`는 `UPBIT_PUBLIC` production event source를 기존 DB-backed `MarketDataRuntimeEventStore`에 저장한다.
collector는 config를 다시 `LiveOpsConfig`로 해석하고 KRW-BTC 단일 universe, `upbit_krw_spot` exchange, trade/orderbook/status event
범위를 검증한다. 허용 market 밖 event는 DB write 전에 차단하고, stale/reconnect/disconnect status는 audit/risk evidence로 저장하되
analysis/decision lifecycle로 전진시키지 않는다.

fixture smoke dashboard는 외부 Upbit/DB 호출 없이 collector summary shape를 검증하고 `체결 1 / 호가 1 / 상태 1` 저장 확인을 표시한다.
`LiveOpsAnalysisDecisionPipeline`은 market data collector summary, market event window, feature snapshot, strategy 목록을 같은
runtime 경계에서 묶는다. market data가 준비되지 않았거나 feature 의존 strategy의 feature snapshot이 실패하면 strategy를 평가하지
않고 HOLD/차단 summary로 닫는다. `cleanup_probe`처럼 `requiredFeatures=[]`인 policy는 fresh orderbook만으로 후보를 만들 수 있어야
하므로 feature snapshot 실패를 0으로 보정하지 않고 `live_ops_feature_snapshot_not_required` evidence와 함께 strategy를 평가한다.
feature가 통과하거나 featureless policy 우회 조건이 충족되면 주입된 strategy들을 KRW-BTC/upbit_krw_spot context로 평가하고 order
intent 수, HOLD/BLOCK count, `record_hold_decision` 여부를 secret-safe summary로 반환한다. raw `OrderIntent`는 status/TUI/JSON
summary에 직렬화하지 않고, pipeline 결과 객체의 non-enumerable `orderIntents` 채널 또는 CLI 내부 symbol 채널로 같은 decision tick의
live execution 입력에만 전달한다. 이 pipeline은 DB write, broker 호출, Upbit 호출, Telegram 전송을 하지 않는다.

production cleanup reservation은 저장소 밖 artifact 디렉터리에 attempt 파일을 남기기 전, 같은 날짜의 `reservation-daily-YYYY-MM-DD.lock`
파일을 원자적으로 선점한다. lock 안에서 현재 reservation 파일 집계, open position snapshot, 요청 금액을 다시 합산해 일일 자동 주문 예산을
넘으면 attempt reservation을 만들지 않고 broker 제출 전 fail-closed 한다. lock이 이미 잡혀 있으면 다른 live ops 실행이 예산을 선점 중인
상태로 보고 신규 실주문을 제출하지 않는다. lock 파일에는 `leaseId`, `acquiredAt`, `expiresAt`, `pid`, owner boot id, process start time
lease metadata를 기록한다. 기본 lease TTL은 5분이며, acquire는 temp 파일에 완성된 lease JSON을 쓴 뒤 hard link로 lock path를 선점한다.
후속 실행은 owner process fingerprint가 더 이상 살아 있지 않은 만료 lock만 hard-link claim/CAS 절차로 회수해 같은 날짜 운영이 crash로 영구
차단되지 않게 한다. 이 CAS는 target을 비우기 전에 fingerprint, inode, link count를 확인하므로 fresh lock을 claim 중 target에서 제거하지
않는다. crash로 남은 같은 inode의 orphan claim/tmp hard link는 CAS 전에 정리해 nlink 고착을 풀 수 있다. 기존 버전이나 외부 손상으로 생긴
malformed lock, 필수 lease field가 빠진 valid JSON lock은 파일 mtime 기준 TTL을 지난 뒤에만 같은 CAS 절차로 회수한다. owner boot id 또는
process start time을 lock 생성 시점에 기록할 수 없으면 lock 획득을 중단한다. owner 조회가 권한/환경 문제로 불확실하면 active owner로
fail-closed 하고, zombie 상태가 확인되면 stale owner로 본다.

production preflight private read는 key scope guard 뒤에서만 열린다. `SEEMIRAI_UPBIT_KEY_SCOPE`에 출금/입금, 선물, 레버리지, 마진 또는
알 수 없는 scope가 포함되면 broker/private read runtime 생성 전 단계에서 닫는다. 이 경우 잔고/미체결 주문 조회도 호출하지 않고
live execution의 broker guard 차단으로 수렴한다.

Sub PR 06부터 production `analysis.decision_policy`는 정적 allowlist policy id만 허용한다. 기본 policy는 `cleanup_probe`이며,
config JSON에는 다음 non-secret 값만 둔다.

- `analysis.decision_policy.id=cleanup_probe`
- `analysis.decision_policy.cleanup_probe.max_notional_krw=10000`
- `analysis.decision_policy.cleanup_probe.tick_size_krw=1000`
- `analysis.decision_policy.cleanup_probe.price_offset_ticks=1`
- `analysis.decision_policy.cleanup_probe.quantity_scale=8`
- `analysis.decision_policy.cleanup_probe.expected_loss_bps_of_equity=5`

policy resolver 구현 경계는 `src/runtime/live-ops-decision-policy.ts`다. resolver는 config를 `LiveOpsConfig`로 다시 검증하고,
`cleanup_probe` 같은 허용 policy를 정적 `Strategy[]`로 조립한다. 임의 파일 경로, 동적 import, 원격 plugin, 저장소 밖 strategy 코드는
허용하지 않는다. resolver와 strategy 평가는 DB write, broker 호출, Upbit 호출, Telegram 전송 side effect를 만들지 않는다.

`cleanup_probe`는 수익 전략이 아니라 Issue #206 closeout lifecycle을 증명하기 위한 one-shot probe다. 최신 DB-backed market frame의
orderbook에서 best bid를 읽고, configured tick offset만큼 낮춘 `BUY + LIMIT + POST_ONLY` 후보를 만든다. orderbook이 없거나 가격/수량/
명목금액이 최소 주문금액, 예산, 호가 단위, `KRW-BTC` 단일 universe 조건을 만족하지 못하면 주문 후보 없이 HOLD/BLOCK evidence로 닫는다.
cleanup probe decision key는 같은 날짜 안의 재시작 멱등성을 유지하되, 날짜 scope를 포함해 전날 reservation 파일이 다음 날 신규 cleanup
attempt를 영구 차단하지 않게 한다. production CLI helper는 최신 market heartbeat가 아니라 제출 직전 wall clock에서 날짜 scope를
계산하고, TypeScript `cleanup_probe` strategy는 `StrategyContext.observedAt` 날짜 scope를 key와 metadata에 포함한다.

`LiveOpsLiveExecution`은 analysis/decision safe summary와 내부 order intent 입력, 최신 budget/loss/cost/risk/reconcile snapshot을 기존
`LiveAutonomousEntryRuntime` 요청으로 낮추는 adapter다. analysis가 blocked이거나 BLOCK decision이면 하위 runtime 호출 없이 blocked
summary로 닫고, HOLD로 주문 후보가 0개이면 idle summary로 닫는다. 주문 후보가 있더라도 첫 production 경계에서는 한 tick에 단일
`BUY + LIMIT + post_only` 후보만 허용하고, market allowlist, `upbit_krw_spot`, strategy/risk scope가 맞지 않으면 live autonomous
runtime 호출 전에 fail-closed 한다. public adapter는 strategy의 긴 decision idempotency key를 Upbit identifier 길이에 맞는 stable
`ops-<sha256-prefix>` attempt id로 낮춰 재시작 후 같은 cleanup 후보가 새 random identifier를 만들지 않게 한다.
조건을 통과한 후보는 manual JSONL 없이 `LiveAutonomousEntryRuntime.submitEntryCandidate`로 전달되며, durable budget reservation,
RiskGate 재검증, broker submit, alert dispatch side effect는 해당 하위 runtime 경계에서만 발생한다.

production preflight는 미체결 주문뿐 아니라 현재 `KRW-BTC` 보유 잔고도 reference price로 평가해 `openPositionNotionalKrw`와 RiskGate
`positions`에 포함한다. 보유 잔고가 있는데 평가 기준가가 없으면 open position 한도 과소평가 위험이 있으므로 broker 제출 전 차단한다.
PnL/status worker가 `OK` snapshot을 제공하지 않으면 realized loss를 0으로 보정하지 않고 loss snapshot 결측으로 제출 전 fail-closed 한다.
clean reconcile DB evidence도 production preflight 실행 wall clock 기준 30초 freshness를 넘으면 stale로 보고 같은 tick의 private read
preflight reconcile evidence를 새로 기록한다. market heartbeat 시각은 market data 관측 evidence로만 쓰며, 일일 예산 기준일과 reconcile
freshness 기준일을 대신하지 않는다. recorder가 없거나 갱신 뒤에도 fresh clean evidence가 아니면 reconcile freshness guard가 broker 제출을 닫는다.

cleanup probe는 broker 제출 성공을 최종 성공으로 보지 않는다. 같은 runtime이 받은 주문 uuid로 취소 요청을 보낸 뒤 terminal cancel
polling을 수행하고, cancel 요청 이후 poll이 provider 오류나 rate-limit로 실패해도 summary만 반환하지 않는다. 이 경우 `manual_review_required`
cleanup artifact에 cancel 요청 시각, redacted broker order suffix, terminal 조회 실패 사유, provider-safe `status`/Upbit error name 요약을
남겨 closeout/manual review가 거래소 side effect를 추적할 수 있게 한다. post-cleanup reconcile/PnL/status summary의 `budgetUsedKrw`는
preflight snapshot 값만 쓰지 않고, daily reservation lock 안에서 읽은 최신 일일 reservation 합계와 현재 attempt reservation을 더한 값을
하한으로 사용한다. private read 실패나 malformed 응답 경로도 같은 하한을 보존한다.

fixture smoke dashboard는 analysis/decision을 `보류 / 주문 후보 0 / 전략 1`, live execution을 `후보 없음 / broker 제출 0`으로 표시한다.
reconcile/PnL/status summary는 같은 fixture lifecycle에서 open order, 예산 사용, 노출, PnL 관측 상태를 secret-safe shape로 묶는다.
fixture smoke는 private provider 조회를 수행하지 않고 `대사 정상 / PnL 관측 대기 / open 주문 0 / provider 호출 0`을 TUI 최근 관측에
표시한다. PnL 결측은 실제 0으로 보정하지 않고 `관측 대기`로 남겨 후속 provider arm에서 reconcile/PnL evidence가 연결될 때까지
운영자가 상태 의미를 구분할 수 있게 한다.

`LiveOpsTelegramAlerts`는 Telegram outbound readiness와 live execution summary를 기존 `LiveOpsAlertInput`/`AlertDispatchRequest`로
낮추는 mapper다. startup alert, live order capable alert, order submitted, risk/reconcile block, manual review event를 같은
application alert/cooldown/retry/Telegram formatter 경계에 연결한다. plan 생성은 provider를 호출하지 않으며, 실제 전송은
`dispatchLiveOpsTelegramAlerts`가 `AlertDispatchServiceOptions`를 받은 경우에만 수행한다. provider 전송 실패는 주문/리스크 commit을
되돌리지 않고 dispatch summary의 실패 count와 기존 retry 경계로 수렴한다.

fixture smoke dashboard는 Telegram alert를 `fixture plan / lifecycle 1 / trade 0 / provider 호출 0`으로 표시한다. Upbit public/private
probe, 실제 provider arm, TUI control lifecycle은 후속 범위에서 같은 config/env contract, DB readiness, market data collector,
analysis/decision pipeline, live execution adapter, reconcile/PnL/status summary, Telegram alert mapper 위에 연결한다.

## Issue #206 production live ops 실제 arm 기준

Issue #206은 #196의 fixture-safe production skeleton을 실제 주문 가능한 운영 lifecycle로 전환한다. `--fixture-smoke`는 계속 외부
provider 호출 0회의 contract 검증 경로이고, 운영 실행은 실제 DB와 실제 provider readiness를 계산해야 한다.

실제 arm boot sequence는 다음 순서를 지킨다.

1. config/env validation과 secret redaction logger 준비
2. DB connection, migration/table readiness, schema drift 확인
3. Upbit public market data connection과 `KRW-BTC` freshness 확인
4. Upbit private key/order capability probe와 key scope 확인
5. Telegram startup alert
6. reconcile/PnL/status readiness
7. decision pipeline readiness와 HOLD/order intent evidence
8. live execution arm과 live order capable 전환

broker 조립 전 실패는 private client와 broker를 만들지 않고 fail-closed 한다. broker 조립 이후 장애는 신규 주문 중지,
reconcile/manual review, Telegram/TUI 경고로 수렴한다. 실제 order side effect는 단일 `BUY + LIMIT + post_only` 후보가 market
allowlist, key scope, budget, market data freshness, reconcile freshness, PnL/status, decision ledger, kill switch, Upbit policy,
price deviation guard를 모두 통과한 뒤에만 열린다.

실거래 cleanup closeout은 [`runbooks/live-ops-real-arm-cleanup.md`](./runbooks/live-ops-real-arm-cleanup.md)를 따른다. 이 closeout은
`submit -> cancel requested -> terminal cancel 확인 -> open exposure 0` evidence가 없으면 PASS가 아니다.

Autonomous entry runtime 기준:

- 구현 경계는 `LiveAutonomousEntryRuntime`이며, public entry는 `src/application/live-autonomous-entry-runtime.ts`다.
- runtime은 random `identifier_prefix + 13 bytes hex` identifier를 생성해 Upbit `identifier`와 ExecutionEngine idempotency key로
  같이 사용한다. timestamp-only 또는 단순 증가 identifier는 허용하지 않는다. 기존 attempt 재시도는 새 identifier를 만들지 않고
  기존 identifier를 주입해 중복 live 주문을 막아야 한다.
- 후보는 `BUY + LIMIT + post_only`만 허용하며 `MARKET`, `PRICE`, `BEST`, non-post-only 후보는 durable reservation 전에 차단한다.
- `requested_notional`은 지정가 주문의 실제 `requested_quantity * requested_price`와 일치해야 하며, 예산/최소 주문 검증은 실제
  지정가 notional을 기준으로 한다.
- broker 제출 전 kill switch, reconcile freshness, price deviation, 단일 주문 예산, 일일 자동 notional 사용량, open position
  notional, 일간/주간 KRW 손실 한도를 다시 확인한다.
- 비용과 RiskGate evidence는 현재 identifier가 포함된 order intent fingerprint로 만든 뒤 ExecutionEngine이 다시 검증한다.
- budget reservation은 비용/RiskGate 승인 뒤, broker 제출 직전에 주입된 durable port로만 수행한다. reservation 거부 시 broker
  side effect는 만들지 않는다. reservation 저장 예외는 unhandled rejection으로 전파하지 않고 `MANUAL_REVIEW_REQUIRED` 결과로
  정규화한다.
- 기본 `PAPER_NO_KEY`와 application entry runtime module은 Upbit private client나 `/v1/orders` REST endpoint를 직접 만들지 않는다.

2026-06-10 공식 문서 재확인:

- Upbit 주문 생성 문서는 지정가 주문에서 `time_in_force=post_only`를 허용하고, `post_only`와 `smp_type` 동시 사용을 금지한다.
- Upbit 주문 생성 문서는 시장가 매수 `ord_type=price`, 시장가 매도 `ord_type=market`, 최유리 지정가 `ord_type=best`를 별도 주문
  유형으로 설명한다. M22에서는 이 주문 유형을 자동 entry/exit 기본 경로에 열지 않는다.
- Upbit 주문 생성 문서는 identifier가 계정 전체 주문 기준 고유하고 최대 64자라고 설명한다. M22 runtime은 32자 보수 제한을 유지한다.
- Upbit KRW market info 문서는 최소 주문 가능 금액을 5,000 KRW로 설명한다.
- Upbit rate limit 문서는 Exchange default 그룹을 계정 단위 초당 최대 30회로 설명하고, `Remaining-Req` header의 `sec` 값을
  잔여 요청 수로 보라고 설명한다.

## M9 Paper 매매 이벤트 Telegram 알림

구현 기준:

- paper event mapper: `src/application/alerts/paper-trade-events.ts`
- Telegram formatter: `src/infrastructure/telegram/message-format.ts`
- cooldown/provider failure 경계: `src/application/alerts/index.ts`

paper 주문·체결·취소·재호가·리스크 차단 evidence는 DB commit 또는 broker 결과가 확정된 뒤
`createPaperTradeAlertRequest`로 alert 후보가 된다. 이 mapper는 Telegram provider를 직접 호출하지 않고, 기존
`dispatchAlertWithCooldown`으로 넘길 순수 요청만 만든다. provider 실패는 주문/체결 commit을 되돌리지 않으며, P1 실패는
후속 worker가 사용할 `notification_retry` 후보 payload와 audit evidence로 분리한다.

severity와 전송 정책:

| severity | 정책 | 이벤트 |
| --- | --- | --- |
| P1 | immediate | 슬리피지 임계값 초과, 부분체결 장기화, 취소/재호가 실패, 주문/체결 accounting mismatch, 운영자 확인 필요 |
| P2 | cooldown | paper 주문 제출, paper 부분체결, paper 전체체결, paper 주문 취소, 재호가 완료, 리스크 차단 |
| P3 | summary | 전략 신호 요약, 주문 후보 폐기 요약, 정상 lifecycle 반복 요약 |

paper 매매 이벤트 fingerprint는 기존 alert 규칙과 같은
`environment + run_mode + severity + paper_trade_event + market + strategy_id + reason_code`를 사용한다. P1은 durable
cooldown과 retry 후보 생성 대상이고, P2/P3은 process memory cooldown으로 운영 소음을 줄인다.

Telegram 첫 화면에는 내부 enum/code보다 다음 사용자 문구와 주문 문맥을 먼저 둔다.

- `PAPER` 모드
- market
- strategy id
- side
- 수량
- 지정가 또는 체결가
- 수수료와 슬리피지 가능 값
- 상태, 원인, 영향, 필요 조치

`fingerprint`, order id, idempotency key, correlation id, event kind, reason code는 하단 `추적 정보`에만 둔다. 이 구분은
운영자가 즉시 행동할 내용과 복구·감사용 안정 식별자를 섞지 않기 위한 presentation invariant다.

## M9 Paper decision runner

구현 기준:

- application runner: `src/application/paper-decision-runner.ts`
- fixture/runtime assembly: `src/runtime/paper-decision-runner.ts`
- CLI smoke: `scripts/run-m9-paper-decision-runner.mjs`
- controlled fixture: `tests/fixtures/m9/paper-decision-runner.json`

M9 paper decision runner는 M8 public WebSocket soak와 다른 검증 경계다. WebSocket soak의 `tradeMessages`와
`orderbookMessages`는 시장 데이터 수신 수이며 paper 매매 수가 아니므로, decision runner가 별도로
`feature -> strategy evaluation -> order intent -> CostModel -> RiskGate -> ExecutionEngine -> PaperBroker -> summary`
순서를 실행한다.

runner는 `PaperDecisionInputSource` port를 소비하므로 deterministic fixture뿐 아니라 후속 DB/market-data cursor source로
확장할 수 있다. 기본 fixture smoke는 `PaperBroker`만 조립하고 Upbit private client, live broker, Telegram inbound route를
만들지 않는다. controlled fixture는 최소 1회 paper 주문 제출과 체결을 통과해야 하며, 주문이 0건인 frame도
`holdReasonCounts`, `discardReasonCounts`, `costRejectedCount`, `riskRejectedCount`, `blockingReasonCounts`로 이유가
설명되어야 한다.

summary의 `metrics`는 3일 비교 입력을 위해 다음 필드를 항상 포함한다.

- `strategyEvaluationCount`, `orderCandidateCount`, `orderIntentCount`
- `holdReasonCounts`, `discardReasonCounts`, `blockingReasonCounts`
- `costRejectedCount`, `riskRejectedCount`
- `paperOrderSubmittedCount`, `paperFillCount`, `fillRate`
- `costSummary`, `slippageSummary`
- `liveOrderApiCalls=0`

## M9 Paper trading soak runner

구현 기준:

- 장시간 runner: `scripts/run-m9-paper-trading-soak.mjs`
- decision cycle runtime: `src/runtime/paper-decision-runner.ts`
- smoke test: `tests/soak/m9-paper-trading-soak-script.test.ts`

`run-m9-paper-decision-runner.mjs`는 한 번 실행하고 끝나는 deterministic decision boundary smoke다. 3일 동안 프로세스를
켜놓고 PaperBroker 제출/체결 경계를 반복 검증하려면 `run-m9-paper-trading-soak.mjs`를 사용한다.

기본 실제 실행은 3일(`--days 3`, `--day-ms 86400000`) 동안 유지되며 `SEEMIRAI_RUN_M9_PAPER_TRADING_SOAK=1`이 있어야
시작한다. runner는 Upbit public quotation WebSocket의 orderbook을 계속 수신하고, cycle마다 최신 orderbook을 controlled
decision fixture에 주입해 `feature -> strategy evaluation -> order intent -> CostModel -> RiskGate -> ExecutionEngine ->
PaperBroker` 경계를 반복 실행한다. 이 경로는 Upbit private API, live broker, Telegram inbound route를 만들지 않고
`metrics.liveOrderApiCalls=0`을 summary와 check에 남긴다.

빠른 검증은 네트워크 없이 fixture loop로 실행한다.

```sh
node scripts/run-m9-paper-trading-soak.mjs \
  --fixture-smoke \
  --json \
  --daily-report-generated \
  --days 3 \
  --cycles-per-day 1 \
  --max-cycles 3
```

실제 3일 운영 evidence는 다음처럼 실행한다.

```sh
SEEMIRAI_RUN_M9_PAPER_TRADING_SOAK=1 \
node scripts/run-m9-paper-trading-soak.mjs \
  --daily-report-generated \
  --artifact-dir "$HOME/vaults/99_운영/seemirai-m9-paper/trading-soak"
```

aggregate summary는 전체 3일 metric을 담고, `artifacts.dailySummaryPaths`에는 day별 summary 3개가 들어간다. 3일 비교에는
이 day summary들을 입력한다.

```sh
node scripts/compare-m9-paper-reports.mjs \
  --summary "$HOME/vaults/99_운영/seemirai-m9-paper/trading-soak/"*-day-1-summary.json \
  --summary "$HOME/vaults/99_운영/seemirai-m9-paper/trading-soak/"*-day-2-summary.json \
  --summary "$HOME/vaults/99_운영/seemirai-m9-paper/trading-soak/"*-day-3-summary.json \
  --output "$HOME/vaults/99_운영/seemirai-m9-paper/m9-3day-trading-soak-comparison.md" \
  --json
```

## M9 Notification retry worker

구현 기준:

- retry payload/dispatch contract: `src/application/alerts/index.ts`
- jobs worker runtime: `src/runtime/notification-retry-runtime.ts`, `src/runtime/notification-retry-runtime/service.ts`
- jobs table adapter: `src/infrastructure/db/jobs.ts`

P0/P1 Telegram provider 실패는 `dispatchAlertWithCooldown` 결과에 `notification_retry` plan으로 남는다. PAPER_NO_KEY runtime은
`createRuntimeAlertDispatchOptions`에서 PostgreSQL retry queue를 붙이므로, provider 실패가 발생하면 같은 plan을 jobs table에
예약한다. 이 예약 실패도 원 주문, 리스크, kill switch commit을 되돌리지 않고 `notification_retry_enqueue_failed` evidence로
분리한다.

retry job payload는 worker가 원 alert 요청을 복원할 수 있도록 다음 필드를 포함한다.

- `environment`, `run_mode`, `severity`, `alert_type`, `market`, `strategy_id`, `reason_code`
- `title`, `body`, `fingerprint`, `occurred_at`, `correlation_id`
- formatter와 추적에 필요한 `metadata`

worker는 `job_type=notification_retry`인 due row만 claim한다. claim된 row는 원 payload를 다시 `AlertDispatchRequest`로 복원해
기존 cooldown/provider/audit 경계를 그대로 통과한다. provider 전송 성공 또는 같은 fingerprint의 활성 cooldown hit는 job을
`COMPLETED`로 닫는다. in-flight reservation 또는 reservation race skip은 아직 다른 전송 시도가 끝나지 않은 상태일 수 있어
완료가 아니라 실패 재예약 경로로 넘긴다. provider 실패나 retry payload 오류는 `failJob`으로 넘겨 `run_after`를 dispatch 처리
종료 시각 기준 최소 다음 worker tick 이후로 미루고, claim 시각보다 과거가 되지 않게 보정한다. `max_attempts`를 소진하면 job은
`FAILED`에 고정되고, `notification_retry_manual_review_required` audit evidence와 `notification_consecutive_failure` manual
review reason을 남긴다. provider 전송이 성공한 뒤 cooldown 기록이나 alert audit 저장에서 예외가 발생하면 job을 재예약하지
않고 `COMPLETED`로 닫아 Telegram 중복 전송을 막는다. 이 경우 worker audit 저장소가 살아 있으면
`notification_retry_delivered_after_dispatch_error` evidence에 후처리 오류를 남긴다.

retry worker는 Telegram outbound 재전송만 수행한다. Telegram inbound command, webhook, polling route를 만들지 않고, 실거래
주문 API나 Upbit private API를 호출하지 않는다.

## M8 Daily report

구현 기준:

- application 집계/전송 경계: `src/application/daily-report/`
- PostgreSQL fact repository: `src/infrastructure/db/daily-report/`
- M9 runner/scheduler boundary: `src/runtime/daily-report-runtime.ts`
- outbound adapter: `NotifierPort.sendDailyReport`
- job idempotency: PostgreSQL `jobs.idempotency_key`

daily report 기준일은 KST `YYYY-MM-DD`다. DB timestamp는 UTC로 저장하므로 application은 기준일을
`kst_start_at`, `kst_end_at`, `utc_start_at`, `utc_end_at`으로 변환해 같은 window를 repository, job payload, Telegram
summary에 함께 남긴다. 조회 조건은 `utc_start_at <= timestamp < utc_end_at` half-open window를 사용한다.
standalone repository 조회는 여러 fact table이 같은 MVCC 기준을 보도록 `repeatable read` transaction 안에서 수행한다.

daily report job은 `job_type=report.daily`, `idempotency_key=report.daily:<report_date>`로 예약한다. 현재 `jobs` schema는
`(job_type, report_date)` composite unique key가 아니라 `idempotency_key` unique constraint를 제공하므로, application
contract가 두 값을 key에 함께 넣어 같은 기준일의 중복 생성과 중복 전송을 억제한다. payload에는 KST/UTC window를 저장해
worker retry나 운영 재생이 같은 조회 범위를 사용할 수 있게 한다.

집계 입력:

- `orders`: 기준일 안에 생성된 주문 수와 `order_events`로 복원한 기준일 종료 시점 상태별 건수
- `fills`: 기준일 안 체결 수, 통화별 수수료, 체결 명목 금액, 수수료 비중
- `positions`: 현재 포지션 수와 snapshot 누락 scope의 fallback 손익 snapshot. 현재 snapshot table이므로 `updated_at`으로
  과거 상태를 복원하려고 제외하지 않는다.
- `pnl_snapshots`: strategy/market별 최신 snapshot의 realized PnL과 unrealized PnL. snapshot이 있는 scope는 positions보다
  우선하며, 일부 scope의 snapshot이 없을 때만 positions fallback을 섞는다.
- `audit_events`: `ORDER_CANDIDATE_DISCARDED` payload의 `reason_code`별 폐기 후보 수,
  `PHASE_1_5_ALT_APPROVAL` payload의 action/market별 승인·거부·철회·만료 기록 수
- `risk_events`: `action`, `risk_type`별 차단/리스크 이벤트 수
- `fills` 기준으로 실제 체결된 주문의 `paper_orders.fill_model_json`, `orders.reason_json.cost_snapshot`: 슬리피지, spread 비용,
  취소/재호가 비용이 있는 경우의 체결 품질 metric

리포트 문구는 한국어 사용자 문구를 먼저 보여준다. 내부 status/action/reason code는 괄호나 `metadata` 추적 정보에 남기며,
값이 없으면 임의로 0으로 채우지 않고 `unavailable`로 표시한다. 단, 주문 수, 체결 수, 폐기 후보 수처럼 row 개수를 세는 항목은
데이터가 없을 때 실제 0으로 표시한다. 실현 손익은 `realized PnL`, 추정 손익은 `unrealized PnL` 기반으로 분리 표기한다.

M9부터 daily report 수동 실행과 scheduler 실행은 같은 runner boundary를 사용한다. 두 경로 모두 먼저
`report.daily:<reportDate>` idempotency key로 `jobs` row를 예약하거나 재사용한 뒤, claim된 job에서 report fact 조회와
Telegram 전송을 수행한다. 수동 실행 claim은 `idempotency_key`뿐 아니라 `job_type=report.daily`도 함께 확인해 공용
jobs table의 다른 worker 책임 row를 전이시키지 않는다. 이미 `COMPLETED`인 같은 기준일 job은 수동 실행에서 다시 전송하지
않는다. 같은 기준일 job이 `FAILED`로 소진된 경우에는 운영자 수동 실행만 같은 idempotency key row를 `PENDING`으로 재개해
복구할 수 있다.

runner 결과는 생성과 전송을 분리해 기록한다.

- report fact 조회/집계/formatting 성공: `DAILY_REPORT` audit event, `daily_report_generated`
- Telegram 전송 성공: `NOTIFICATION_DELIVERY` audit event, `daily_report_notification_delivered`
- Telegram provider skip/실패/예외: `NOTIFICATION_DELIVERY` audit event, `daily_report_notification_failed`
- report 생성 실패: `DAILY_REPORT` audit event, `daily_report_generation_failed`, jobs row는 재시도 가능하면 `PENDING`, 한도 초과 시 `FAILED`

Telegram provider 실패는 report 생성 성공을 되돌리지 않는다. provider 실패는 audit evidence로 남기고 claim된 daily report job은
완료 처리해 같은 기준일의 중복 전송을 막는다. provider 호출 이후 notification audit 저장이 실패해도 job을 generation retry로
되돌리지 않고 결과의 `errorMessage`에 남긴다. report 생성 실패만 jobs retry 대상이다. scheduler worker는 `limit`가 1보다
커도 실행 가능한 daily report job을 한 번에 하나씩 claim하고 즉시 실행한다. scheduler 실패 row는 같은 sweep에서 다시
claim하지 않도록 최소 다음 tick 이후로 `run_after`를 미룬다. report 생성 중 audit 저장소 장애처럼 runner가 예외를 던지면
runtime이 `failJob`으로 lock을 해제해 같은 row가 retry 또는 수동 복구 대상으로 남게 한다.

## M8 Paper soak verification

구현 기준:

- soak harness: `scripts/soak-paper-24h.mjs`
- fixture smoke: `tests/soak/paper-soak-script.test.ts`
- stale 차단 fixture: `tests/fixtures/soak/paper-soak-events.json`

24시간 paper soak는 기본 검증에서 자동 실행하지 않는다. `node scripts/soak-paper-24h.mjs`만 실행하면
`SEEMIRAI_RUN_SOAK=1`이 없다는 summary를 남기고 skip한다. CI와 PR 검증은 다음 fixture smoke로 장시간 실행 guard,
실거래 주문 API 0회 근거, stale data 차단 evidence, audit 누락 0건, `/readyz`/`/status`와 `/kill-switch` route 근거를
확인한다.

```sh
node scripts/soak-paper-24h.mjs --fixture-smoke
```

실제 24시간 public quotation WebSocket soak는 운영자가 의도적으로 env를 열 때만 실행한다. control server가 떠 있으면
`--control-url`을 추가해 `GET /readyz`/`GET /status` 200 응답과 `/kill-switch` route guard 근거를 함께 확인한다. 상태
변경이 허용되는 disposable local paper runtime에서는 `--control-drill`과 `--control-token-env`를 추가해 token 없는
`POST /kill-switch` 401 거부, 인증된 전이, pending cancel plan, Telegram dispatch evidence를 같은 correlation id로 확인한다.
24시간 결과를 완료 evidence로 쓰려면 daily report 생성이 끝난 뒤 `--daily-report-generated`를 함께 넘긴다.

```sh
SEEMIRAI_RUN_SOAK=1 node scripts/soak-paper-24h.mjs \
  --duration-ms 86400000 \
  --control-url http://127.0.0.1:8787 \
  --daily-report-generated
```

artifact 기본 위치는 `SEEMIRAI_SOAK_LOG_DIR` 또는 `~/vaults/99_운영/seemirai-soak`다. raw event log, JSON summary, PR 첨부용
Markdown report는 저장소 밖에 남기는 것을 기본으로 하며, raw log를 git에 커밋하지 않는다.

summary의 완료 판단 필드는 다음과 같다.

- `runtimeExceptions`: crash 0회, unhandled rejection 0회
- `liveOrderApiCalls`: 실거래 주문 API 호출 0회와 disabled live broker source guard
- `auditMissing`: stale/reconnect/disconnect 차단 evidence 누락 0건
- `staleDataBlocked`: stale data가 신규 주문 차단 evidence로 연결됐는지
- `readyzEndpoint`, `statusEndpoint`, `killSwitchEndpoint`: source scan 또는 local probe 근거
- `controlMissingTokenRejected`, `killSwitchDrill`: 명시적 control drill 실행 시 token 거부, 전이, pending cancel, Telegram evidence
- `dbWriteFailures`, `notificationFailures`: 운영자가 관측한 실패 건수
- `dailyReportGenerated`: 실제 24시간 soak 완료 시 daily report evidence 포함 여부

3일 paper report 비교는 저장소 밖 summary JSON 3개 이상을 입력으로 받는 별도 도구로 수행한다.

```sh
node scripts/compare-m9-paper-reports.mjs \
  --summary "$HOME/vaults/99_운영/seemirai-soak/day-1-summary.json" \
  --summary "$HOME/vaults/99_운영/seemirai-soak/day-2-summary.json" \
  --summary "$HOME/vaults/99_운영/seemirai-soak/day-3-summary.json" \
  --output "$HOME/vaults/99_운영/seemirai-m9-paper/m9-3day-comparison.md" \
  --json
```

## M6 Execution 안전 설정

구현 기준:

- execution guard: `src/application/execution/execution-engine.ts`
- 기본 profile: `config/paper.json`

M6 `ExecutionEngine`은 runtime config의 실행 관련 안전 toggle을 application layer의 `ExecutionSafetyConfig`로 전달받아
broker 호출 직전에 다시 검증한다. 이 guard는 PaperBroker 구현체가 붙기 전에도 다음 조건을 fail-closed로 유지한다.

- `liveTradingEnabled=false`
- `marketOrderEnabled=false`
- `entryMarketOrderEnabled=false`
- `paperNoKey=true`

`ExecutionEngine`은 비용 snapshot과 RiskGate approval evidence가 현재 주문 intent의 exchange, market, strategy,
side, order type, idempotency key, 수량, 명목 금액, 지정가, limit execution option(`postOnly`, `timeInForce`),
expected loss와 일치할 때만 `BrokerPort.submitOrder`를 호출한다. 비용 snapshot은 `source=cost_model`,
`trade_allowed=true`, `reason_code=cost_margin_ok`이고 `missing_fields`/`invalid_fields`가 없는 증거만 인정한다.
RiskGate approval evidence는 `source=risk_gate`, `approved=true`, `action=ALLOW`, `status=PASS|WARN` 조건을
모두 만족해야 한다. 기본 paper profile에서는 market order와 신규 진입 market order를 broker로 넘기지 않는다. 같은
process 안에서 같은 `idempotencyKey`가 in-flight 상태로 반복 제출되면 fingerprint가 같은 경우에만 broker submit
side effect를 한 번으로 억제하고, fingerprint가 다르면 idempotency key collision으로 fail-closed한다. 성공한 key는
application memory에 계속 보관하지 않는다. DB-backed idempotency와 주문 persistence transaction 경계는
`PostgresExecutionPersistenceRepository`가 담당한다.

## PAPER_NO_KEY execution runtime

구현 기준:

- assembly: `src/runtime/execution-runtime.ts`
- active broker: `src/infrastructure/paper/paper-broker.ts`
- disabled live stub: `src/infrastructure/upbit/disabled-live-broker.ts`
- 기본 worker id: `paper-no-key-execution-worker`

`PAPER_NO_KEY` execution runtime은 `config/paper.json`을 로딩한 뒤 다음 조건을 추가로 검증한다.

- `exchange=UPBIT`, `market=KRW_SPOT`, `mode=PAPER_TRADING`이어야 한다.
- `registry.exchangeId=upbit_krw_spot`이어야 한다.
- `paper_no_key=true`이어야 한다.
- `live_trading_enabled=false`, `market_order_enabled=false`, `entry_market_order_enabled=false`이어야 한다.
- `secrets.upbit_access_key`, `secrets.upbit_secret_key`가 없어야 한다.

runtime assembly는 `ExecutionEngine`에 `PaperBroker`만 연결한다. Upbit live broker는 `DisabledUpbitLiveBroker` stub으로만
노출되며 `submitOrder`, `cancelOrder`, `getOrder`, `listOpenOrders`, `getBalances`가 모두
`UpbitLiveBrokerDisabledError`로 실패한다. 이 stub은 Upbit private REST client를 만들지 않으므로 paper profile에서
실거래 주문/취소/잔고 API 호출이 발생하지 않는다.

hard stop 처리에서 RiskGate가 만든 pending paper order cancel action plan은
`executeHardStopPendingPaperOrderCancels`가 `BrokerPort.cancelOrder`로 실행한다. 이 함수는 action plan의
`autoLiquidateOpenPositions=false`를 다시 확인하고, true가 들어오면 broker side effect 전에 실패한다. 따라서 장애
상황의 자동 조치는 신규 주문 차단과 미체결 paper order 취소에 한정되며, open position 자동 청산은 수행하지 않는다.

## PAPER_NO_KEY market data runtime

구현 기준:

- assembly: `src/runtime/market-data-runtime.ts`
- Upbit public WebSocket endpoint: `wss://api.upbit.com/websocket/v1`
- 기본 consumer id: `paper-no-key-market-data-worker`

`PAPER_NO_KEY` market data runtime은 `config/paper.json`을 로딩한 뒤 다음 조건을 추가로 검증한다.

- `exchange=UPBIT`, `market=KRW_SPOT`, `mode=PAPER_TRADING`이어야 한다.
- `registry.exchangeId=upbit_krw_spot`이어야 한다.
- `paper_no_key=true`이어야 한다.
- `secrets.upbit_access_key`, `secrets.upbit_secret_key`가 없어야 한다.
- WebSocket subscription message에는 `Authorization`, `Bearer`, private path, `myOrder`, `myAsset`, `orders/chance`, `/v1/orders` 후보가 없어야 한다.

runtime assembly는 `universe.phase_1`의 `KRW-BTC`, `KRW-ETH`에 대해 공개 `trade`, `orderbook` subscription만 만든다. 이 단계는
실제 주문, 잔고, 인증 API client를 생성하지 않는다.

market data status event는 다음 방식으로 저장 경계를 지난다.

| status | audit_events | risk_events | 신규 주문 차단 입력 |
| --- | --- | --- | --- |
| `CONNECTED` | `MARKET_DATA_STATUS`, `INFO` | 없음 | false |
| `STALE` | `MARKET_DATA_STATUS`, `WARN` | `stale_market_data`, `BLOCK_NEW_ORDERS` | true |
| `RECONNECTING` | `MARKET_DATA_STATUS`, `WARN` | `market_data_reconnecting`, `BLOCK_NEW_ORDERS` | true |
| `DISCONNECTED` | `MARKET_DATA_STATUS`, `ERROR` | `market_data_disconnected`, `BLOCK_NEW_ORDERS` | true |

M3는 실제 RiskGate state machine을 구현하지 않고 위 차단 입력 신호까지만 만든다. M5 Sub PR 1은 state machine과
threshold config foundation을 제공하고, 실제 주문 차단 적용은 M5 runtime integration 범위다.

## 주문 후보 폐기 Audit

M4는 주문 후보가 실행 단계로 넘어가지 못한 이유를 `AuditLogPort`로 남길 수 있는 application contract와
`audit_events` PostgreSQL append adapter를 제공한다.

저장 기준:

- event type: `ORDER_DECISION`
- severity: `WARN`
- payload marker: `audit_kind=ORDER_CANDIDATE_DISCARDED`
- discard stage: `STRATEGY_DECISION`, `INTENT_CONVERSION`, `COST_DECISION`, `RULE_ENGINE`
- payload 주요 필드: `strategy_id`, `reason_code`, `order_intent`, `strategy_decision`, `intent_conversion`, `cost_decision`, `rule_result`

이 audit event는 실제 주문 제출 근거가 아니라, M5 RiskGate와 M6 ExecutionEngine 이전에 후보가 폐기된 이유를 사람이
추적하기 위한 append-only 기록이다.

Phase 1.5 알트 수동 편입 evidence는 다음 기준으로 저장한다.

- event type: `PHASE_1_5_ALT_APPROVAL`
- severity: 승인은 `INFO`, 거부/철회/만료는 `WARN`
- payload marker: `audit_kind=PHASE_1_5_ALT_APPROVAL`
- action: `APPROVE`, `REJECT`, `REVOKE`, `EXPIRE`
- payload 주요 필드: `status_label`, `operator_action`, `exchange_id`, `market`, `evidence_id`, `thresholds`, `conditions`

이 audit event는 config diff만으로 복원하기 어려운 operator 판단 근거를 보존하기 위한 기록이다. daily report는 이 marker를
읽어 phase 1.5 알트 편입 기록 수를 action과 market별로 표시한다.

## Universe 구조

```json
{
  "universe": {
    "phase_1": ["KRW-BTC", "KRW-ETH"],
    "auto_include_new_listing": false,
    "exclude_warning": true,
    "exclude_caution": true
  }
}
```

- `phase_1`: MVP 기본 거래 후보 market. 현재는 `KRW-BTC`, `KRW-ETH`만 허용한다.
- `auto_include_new_listing`: 신규 상장 자동 편입 금지.
- `exclude_warning`, `exclude_caution`: Upbit 시장경보 또는 주의 상태일 때 신규 진입 차단.

## Registry 구조

```json
{
  "registry": {
    "exchangeId": "upbit_krw_spot",
    "strategies": [
      {
        "id": "trend_following",
        "enabled": true,
        "ruleIds": [
          "universe_allowed",
          "market_warning_absent",
          "spread_ok",
          "depth_sufficient",
          "cost_margin_ok",
          "risk_ok",
          "stop_loss",
          "take_profit"
        ]
      }
    ]
  }
}
```

허용 exchange id:

- `upbit_krw_spot`

허용 strategy id:

- `trend_following`
- `mean_reversion`
- `volatility_breakout`
- `orderbook_imbalance_momentum`
- `liquidity_reversion`

허용 rule id:

- `universe_allowed`
- `market_warning_absent`
- `spread_ok`
- `depth_sufficient`
- `cost_margin_ok`
- `risk_ok`
- `stop_loss`
- `take_profit`

규칙:

- 존재하지 않는 exchange, strategy, rule id는 fail-fast한다.
- `registry`와 `strategies[]`의 알 수 없는 키는 오타로 간주해 fail-fast한다.
- `strategies[].enabled=false`인 strategy는 활성 resolution 결과에서 제외된다.
- `strategies[].ruleIds`는 비어 있으면 안 된다.
- 활성 strategy의 `ruleIds`는 `universe_allowed`, `market_warning_absent`, `spread_ok`, `depth_sufficient`, `cost_margin_ok`, `risk_ok` 차단 rule을 모두 포함해야 한다.
- 같은 strategy id를 중복 선언하면 안 된다.

## Strategy Parameters 구조

구현 기준:

- schema: `src/runtime/strategy-parameters.ts`
- 기본 profile: `config/paper.json`

`strategyParameters`는 strategy id별 threshold를 명시한다. 모든 금융 값은 Decimal로 파싱 가능한 string이어야 하며, JS number는 정밀도와 단위 혼동을 피하기 위해 거부한다. 알 수 없는 strategy id나 threshold key는 오타로 간주해 fail-fast한다.

```json
{
  "strategyParameters": {
    "trend_following": {
      "max_spread_bps": "8",
      "min_depth_krw": "50000000",
      "breakout_lookback_buckets": 20,
      "min_trade_strength": "1.2",
      "min_orderbook_imbalance": "0.08",
      "min_volatility_expansion_bps": "18",
      "min_candle_momentum_bps": "0",
      "min_realized_volatility_bps": "0",
      "max_realized_volatility_bps": "100000",
      "min_volume_spike_ratio": "0",
      "min_trade_direction_imbalance": "0",
      "allowed_market_regimes": ["trend_up", "trend_down", "range", "volatile", "liquidity_stress"],
      "min_cost_adjusted_margin_bps": "0"
    },
    "mean_reversion": {
      "max_spread_bps": "6",
      "min_depth_krw": "70000000",
      "entry_deviation_bps": "25",
      "exit_deviation_bps": "8",
      "stop_loss_bps": "35",
      "min_realized_volatility_bps": "0",
      "max_realized_volatility_bps": "100000",
      "min_abs_vwap_deviation_bps": "0",
      "min_session_liquidity_score": "0",
      "allowed_market_regimes": ["trend_up", "trend_down", "range", "volatile", "liquidity_stress"],
      "min_cost_adjusted_margin_bps": "0"
    },
    "volatility_breakout": {
      "max_spread_bps": "8",
      "min_depth_krw": "50000000",
      "breakout_lookback_buckets": 20,
      "min_volatility_expansion_bps": "18",
      "min_candle_momentum_bps": "0",
      "min_realized_volatility_bps": "0",
      "max_realized_volatility_bps": "100000",
      "min_volume_spike_ratio": "0",
      "allowed_market_regimes": ["trend_up", "trend_down", "range", "volatile", "liquidity_stress"],
      "min_cost_adjusted_margin_bps": "0"
    },
    "orderbook_imbalance_momentum": {
      "max_spread_bps": "7",
      "min_depth_krw": "60000000",
      "min_trade_strength": "1.25",
      "min_orderbook_imbalance": "0.1",
      "min_depth_slope_krw_per_bps": "0",
      "min_depth_change_rate_ratio": "-1",
      "min_trade_direction_imbalance": "0",
      "min_cost_adjusted_margin_bps": "0"
    },
    "liquidity_reversion": {
      "max_spread_bps": "5",
      "min_depth_krw": "90000000",
      "entry_deviation_bps": "18",
      "stop_loss_bps": "30",
      "min_depth_change_rate_ratio": "-1",
      "min_abs_vwap_deviation_bps": "0",
      "min_session_liquidity_score": "0",
      "min_cost_adjusted_margin_bps": "0"
    }
  }
}
```

| strategy | threshold | 기본값 | 단위 | 보수적 조정 방향 |
| --- | --- | ---: | --- | --- |
| `trend_following` | `max_spread_bps` | `8` | bps | 낮출수록 넓은 spread 후보를 더 많이 차단 |
| `trend_following` | `min_depth_krw` | `50000000` | KRW | 높일수록 유동성이 부족한 후보를 더 많이 차단 |
| `trend_following` | `breakout_lookback_buckets` | `20` | feature bucket 수 | 높일수록 짧은 돌파 신호를 덜 신뢰 |
| `trend_following` | `min_trade_strength` | `1.2` | ratio | 높일수록 약한 체결강도 후보를 더 많이 차단 |
| `trend_following` | `min_orderbook_imbalance` | `0.08` | 0~1 ratio | 높일수록 약한 호가 불균형 후보를 더 많이 차단 |
| `trend_following` | `min_volatility_expansion_bps` | `18` | bps | 높일수록 변동성 확장이 약한 추세 후보를 더 많이 차단 |
| `mean_reversion` | `max_spread_bps` | `6` | bps | 낮출수록 넓은 spread 후보를 더 많이 차단 |
| `mean_reversion` | `min_depth_krw` | `70000000` | KRW | 높일수록 유동성이 부족한 후보를 더 많이 차단 |
| `mean_reversion` | `entry_deviation_bps` | `25` | bps | 높일수록 진입 신호를 더 드물게 허용 |
| `mean_reversion` | `exit_deviation_bps` | `8` | bps | 낮출수록 더 빨리 평균 복귀 청산 후보를 만든다 |
| `mean_reversion` | `stop_loss_bps` | `35` | bps | 낮출수록 손절 후보를 더 빨리 만든다 |
| `volatility_breakout` | `max_spread_bps` | `8` | bps | 낮출수록 넓은 spread 후보를 더 많이 차단 |
| `volatility_breakout` | `min_depth_krw` | `50000000` | KRW | 높일수록 유동성이 부족한 후보를 더 많이 차단 |
| `volatility_breakout` | `breakout_lookback_buckets` | `20` | feature bucket 수 | 높일수록 짧은 돌파 신호를 덜 신뢰 |
| `volatility_breakout` | `min_volatility_expansion_bps` | `18` | bps | 높일수록 약한 변동성 확장 후보를 더 많이 차단 |
| `orderbook_imbalance_momentum` | `max_spread_bps` | `7` | bps | 낮출수록 넓은 spread 후보를 더 많이 차단 |
| `orderbook_imbalance_momentum` | `min_depth_krw` | `60000000` | KRW | 높일수록 유동성이 부족한 후보를 더 많이 차단 |
| `orderbook_imbalance_momentum` | `min_trade_strength` | `1.25` | ratio | 높일수록 약한 체결강도 후보를 더 많이 차단 |
| `orderbook_imbalance_momentum` | `min_orderbook_imbalance` | `0.1` | 0~1 ratio | 높일수록 약한 호가 불균형 후보를 더 많이 차단 |
| `liquidity_reversion` | `max_spread_bps` | `5` | bps | 낮출수록 넓은 spread 후보를 더 많이 차단 |
| `liquidity_reversion` | `min_depth_krw` | `90000000` | KRW | 높일수록 유동성이 부족한 후보를 더 많이 차단 |
| `liquidity_reversion` | `entry_deviation_bps` | `18` | bps | 높일수록 진입 신호를 더 드물게 허용 |
| `liquidity_reversion` | `stop_loss_bps` | `30` | bps | 낮출수록 손절 후보를 더 빨리 만든다 |

### M11 feature quality 확장 계약

설계 기준:

- [`docs/design-docs/2026-05-25-feature-quality-calibration.md`](./design-docs/2026-05-25-feature-quality-calibration.md)

M11은 feature 정의, 계산기, parity, strategy integration, calibration report를 sub PR로 나눠 진행한다. Sub PR 1은
runtime 동작을 바꾸지 않고 contract만 고정한다. 실제 schema와 기본 profile 변경은 후속 구현 PR에서 이 계약을 따라
추가한다.

새 threshold는 기존 `strategyParameters.<strategy_id>` 아래에 추가한다. bps, KRW, ratio 값은 Decimal로 파싱 가능한
string이어야 하며, bucket 수와 lookback 개수만 양의 정수 number를 허용한다. 알 수 없는 key는 현재 정책처럼 fail-fast한다.
`allowed_market_regimes`는 비어 있지 않은 known regime string 배열이어야 한다.

M9 #68 운영 관측이 끝나기 전에는 기본 운영 threshold를 더 공격적으로 바꾸지 않는다. Sub PR 2-4는 새 key와 검증을 추가할 수
있지만, #68 데이터가 필요한 기본값 확정은 별도 calibration approval PR에서만 수행한다. #102 Sub PR 5는 #68 원천 artifact를
재검증하고 비활성 profile proposal을 생성하되, 기본 `config/paper.json`을 자동 변경하거나 활성화하지 않는다.

Sub PR 4의 기본 profile은 M11 feature 누락을 fail-closed로 검증하되, 새 threshold 자체는 대부분 `0`, 전체
`allowed_market_regimes`, 또는 매우 넓은 `max_realized_volatility_bps=100000`으로 둔다. `min_depth_change_rate_ratio=-1`은
관측 데이터 없이 depth 감소 후보를 새로 차단하지 않기 위한 보수적 pass-through 기본값이다.

| threshold key | 단위 | 검증 | 보수적 조정 방향 |
| --- | --- | --- | --- |
| `min_candle_momentum_bps` | bps | Decimal string, 0 이상 | 높일수록 약한 momentum 후보를 더 많이 차단 |
| `min_realized_volatility_bps` | bps | Decimal string, 0 이상 | 높일수록 변동성 부족 후보를 더 많이 차단 |
| `max_realized_volatility_bps` | bps | Decimal string, 0 이상 | 낮출수록 급변동 후보를 더 많이 차단 |
| `min_volume_spike_ratio` | ratio | Decimal string, 0 이상 | 높일수록 거래대금 증가가 약한 후보를 더 많이 차단 |
| `min_depth_slope_krw_per_bps` | KRW/bps | Decimal string, 0 이상 | 높일수록 얕은 호가 후보를 더 많이 차단 |
| `min_depth_change_rate_ratio` | ratio | Decimal string | 높일수록 depth 감소 후보를 더 많이 차단 |
| `min_abs_vwap_deviation_bps` | bps | Decimal string, 0 이상 | 높일수록 작은 평균회귀 후보를 더 많이 차단 |
| `min_trade_direction_imbalance` | 0..1 ratio | Decimal string, 0..1 | 높일수록 약한 체결 방향성 후보를 더 많이 차단 |
| `allowed_market_regimes` | enum list | non-empty known regime list | 줄일수록 허용 regime을 축소 |
| `min_session_liquidity_score` | 0..1 ratio | Decimal string, 0..1 | 높일수록 얇은 시간대 후보를 더 많이 차단 |
| `min_cost_adjusted_margin_bps` | bps | Decimal string | 높일수록 비용 차감 후 여유가 작은 후보를 더 많이 차단 |

`cost_adjusted_expected_return_bps`와 `cost_adjusted_margin_bps`는 strategy 설명력과 calibration 비교를 위한 feature다. 실제
주문 제출 허용은 계속 CostModel과 RiskGate가 담당한다.

### #102 calibration proposal closeout

2026-05-31 기준 #102 calibration report는 #68 72시간 paper trading artifact를 다시 읽어 다음 결론으로 닫았다.

- report: `/home/lim/vaults/99_운영/seemirai-m9-paper/m11-threshold-calibration-report.md`
- 비활성 proposal: `/home/lim/vaults/99_운영/seemirai-m9-paper/m11-threshold-calibration-profile-proposal.json`
- 주요 metric: `paperOrderSubmittedCount=2130`, `paperFillCount=2130`, `fillRate=1`, `liveOrderApiCalls=0`
- 비용 판단: `averageMarginBps=-1.333333333333`이라 기본 threshold 완화는 차단한다.
- proposal invariant: `active=false`, `activationRequired=true`, `defaultConfigMutation=false`

따라서 현재 기본 profile은 M11 feature key를 포함하지만 대부분 pass-through 값을 유지한다. 운영 기본 threshold를 바꾸려면
proposal을 그대로 적용하지 말고, 동일 run shape report 전후 비교와 별도 승인 기록을 먼저 남긴다.

M5 runtime integration 이후 `risk_ok` rule은 현재 `riskGateContext`로 RiskGate를 직접 평가한 결과만 실행 승인
근거로 사용한다. `riskGateContext`가 없거나 `RuleContext` 후보와 `riskGateContext.orderIntent`의
exchange/market/idempotency key, 수량, 명목 금액, 지정가, 예상 손실 입력이 다르면 fail-closed 처리하고, 금액 계열
문자열은 Decimal로 정규화해 DB numeric scale 차이를 제거한다. RiskGate가 `approved=true`를 반환할 때만
`risk_gate_approved` PASS가 된다. 후보 fingerprint가 없는 사전 계산 결과는 stale 승인 우회 위험이 있으므로 rule
context와 runtime persistence 입력으로 받지 않는다. M4 `risk_ok_placeholder`는 과거 rule chain 검증용 helper로만
남고, M5 기본 rule 조합은 `createDefaultM5Rules`와 `createRiskOkRule`을 사용한다.

## Risk 구조

구현 기준:

- schema: `src/runtime/risk-config.ts`
- domain contract: `src/domain/risk.ts`
- 기본 profile: `config/paper.json`

`risk.thresholds`는 M5 RiskGate evaluator가 사용할 계정 손실, 주문 크기, 포지션 노출, 연속 손실 기준이다. 모든 금융
비율 값은 bps 단위의 Decimal string이고, 연속 손실 횟수만 양의 정수다.

```json
{
  "risk": {
    "thresholds": {
      "daily_loss_limit_bps": "100",
      "weekly_loss_limit_bps": "300",
      "max_drawdown_bps": "500",
      "max_order_notional_bps_of_equity": "100",
      "max_expected_loss_bps_of_equity": "20",
      "btc_eth_max_position_bps_of_equity": "2000",
      "alt_max_position_bps_of_equity": "500",
      "total_alt_max_position_bps_of_equity": "1500",
      "max_consecutive_strategy_losses": 3
    }
  }
}
```

| threshold | 기본값 | 의미 |
| --- | ---: | --- |
| `daily_loss_limit_bps` | `100` | 일간 손실 -1% 도달 시 신규 주문 차단 |
| `weekly_loss_limit_bps` | `300` | 주간 손실 -3% 도달 시 신규 주문 차단 |
| `max_drawdown_bps` | `500` | MDD -5% 도달 시 신규 주문 차단 |
| `max_order_notional_bps_of_equity` | `100` | 1회 주문 금액을 계정 평가액 1%로 제한 |
| `max_expected_loss_bps_of_equity` | `20` | 1회 예상 손실을 계정 평가액 0.2%로 제한 |
| `btc_eth_max_position_bps_of_equity` | `2000` | BTC/ETH 단일 보유를 계정 평가액 20%로 제한 |
| `alt_max_position_bps_of_equity` | `500` | 단일 알트 보유를 계정 평가액 5%로 제한 |
| `total_alt_max_position_bps_of_equity` | `1500` | 전체 알트 보유를 계정 평가액 15%로 제한 |
| `max_consecutive_strategy_losses` | `3` | 동일 전략 연속 손실 3회에서 전략 중지 후보 |

M5 Sub PR 1은 위 기준을 load 가능한 config와 threshold snapshot contract로 고정했고, Sub PR 3은 실제
RiskGate evaluator를 구현했다. Sub PR 4는 `risk_ok` rule 연결과 `order_events`/`risk_events`/`audit_events`
append 계획을 연결한다. 증거 저장은 주문 상태 전이, kill switch 상태 전이, risk event, audit event를 combined event
store port로 묶어 후속 DB transaction/outbox 구현이 원자성을 보장할 수 있게 한다. `PAUSE_STRATEGY`는 해당 strategy
범위의 정지 계획으로 남기고 전역 kill switch로 승격하지 않는다. `HARD_STOP`은 pending paper order cancel action
plan을 감사 이벤트로 남기지만, 실제 broker cancel 호출과 open position 자동 청산은 M6 이후 별도 실행 경계에서만
다룬다. runtime persistence는 `correlationId`와 `riskGateContext.orderIntent.idempotencyKey`가 같아야 하며,
DB/현재 후보에서 읽은 주문 의도와 `riskGateContext.orderIntent`의 주문 금액/예상 손실 입력도 같아야 한다. 현재 kill
switch action plan이 신규 주문 또는 수동 검토를 요구하면 RiskGate snapshot이 깨끗해도 주문을 승인하지 않는다. 현재
주문 상태에서 RiskGate 승인/거부 상태로 전이할 수 없거나 strategy 손실 snapshot이 주문 strategy와 다르면 runtime은
별도 risk event를 남기고 fail-closed한다. kill switch 전이는 `kill_switch_state` durable snapshot에도 반영해
재시작 후 차단 상태를 복구한다.
strategy 연속 손실 초과는 일간 손실이나 kill switch 같은 더 강한 전역 차단이 함께 발생해도 strategy pause evidence로
함께 남긴다. `STRATEGY_PAUSED` kill switch 상태는 strategy 평가 중지만 표현하고 전역 신규 주문 차단으로 사용하지
않는다. PostgreSQL combined event store는 주문 전이, risk event, audit event를 하나의 transaction으로 저장한다.

## M19 Exit Pilot guard

구현 기준:

- 실행 계획: [`exec-plans/active/2026-06-07-issue-165-subpr-03-verification-closeout-deepseek-handoff.md`](./exec-plans/active/2026-06-07-issue-165-subpr-03-verification-closeout-deepseek-handoff.md)
- guard 구현: `src/runtime/pilot-config/types.ts`, `src/runtime/pilot-config/validation.ts`, `src/runtime/pilot-config/summary.ts`
- guarded buy smoke: `src/runtime/pilot-order-smoke/guard.ts`
- M19 guard test: `tests/unit/m19-exit-pilot-guard.test.ts`

M19 exit pilot은 기존 `PILOT_ORDER_SMOKE` profile 위에서 추가 env guard를 통해 exit 검증 경계를 연다. 기본 `PAPER_NO_KEY` runtime은
계속 live order API 0회를 유지하며, M19 guard가 없는 상태에서는 paper fixture로만 exit rule 검증을 수행한다.

### M19 exit pilot guard env

| guard | 의미 |
| --- | --- |
| `SEEMIRAI_RUN_M19_EXIT_PILOT=1` | M19 exit pilot guard 활성화 |
| `SEEMIRAI_M19_EXIT_PILOT_POSITION_SOURCE` | `EXISTING_SMALL_POSITION` 또는 `PAPER_FIXTURE` |
| `SEEMIRAI_M19_EXIT_PILOT_POSITION_EVIDENCE_ID` | `EXISTING_SMALL_POSITION` 선택 시 필수인 M16 reconcile 또는 운영자 position evidence |
| `SEEMIRAI_M19_EXIT_PILOT_MAX_KRW` | 소액 한도, 5,000~50,000 KRW |
| `SEEMIRAI_M19_EXIT_PILOT_OPERATOR_EVIDENCE_ID` | 저장소 밖 redacted 운영자 확인 증거 |

### M19 guarded buy smoke guard

| guard | 의미 |
| --- | --- |
| `SEEMIRAI_RUN_M19_GUARDED_BUY_SMOKE=1` | 신규 진입 guarded buy smoke 활성화 (기본 off) |
| `SEEMIRAI_M19_GUARDED_BUY_APPROVAL_EVIDENCE_ID` | guarded buy smoke 실행 시 운영자 승인 evidence 필수 |

### M19 guard invariant

- 기본 `PAPER_NO_KEY` runtime은 M19 guard 조회만으로 live API를 호출하지 않는다.
- M19 exit pilot은 명시 env guard 없이 열리지 않는다.
- `EXISTING_SMALL_POSITION` source는 `SEEMIRAI_M19_EXIT_PILOT_POSITION_EVIDENCE_ID`가 없으면 열리지 않는다.
- `SEEMIRAI_RUN_M19_GUARDED_BUY_SMOKE=1`만 켜진 오설정은 일반 order smoke로 낮추지 않고 fail-closed 한다.
- M19 guard가 활성화된 bid smoke는 `sideEffectPossible=false` 결과를 일반 order smoke로 낮추지 않고 API 호출 전 차단한다.
- guarded buy smoke는 `SEEMIRAI_M19_GUARDED_BUY_APPROVAL_EVIDENCE_ID`가 없으면 API 호출 전 fail-closed 한다.
- 매도/축소(side=ask) 경로는 기존 보유 포지션 source를 우선하며, guarded buy 승인과 별도로 허용된다.
- 실제 order/live-broker smoke는 취소 요청 직후 거래소 상태 반영 지연을 흡수하기 위해 같은 주문 UUID/identifier만 짧게
  재조회하고, terminal cancel이 확인되지 않으면 성공으로 올리지 않고 수동 점검으로 남긴다.
- `hard stop` open position 자동 청산은 여전히 금지된다.
- smoke artifact는 access key, secret key, JWT, Authorization header, raw provider payload를 포함하지 않는다.
- operator evidence id와 approval evidence id는 safe summary에서 boolean으로만 노출한다.
- M19 guard 검증 실패는 한국어 violation 목록을 반환한다.

### M19 safe summary

`createM19ExitPilotGuardSafeSummary`는 다음 필드를 secret 없이 노출한다.

| 필드 | 설명 |
| --- | --- |
| `enabled` | M19 guard 활성화 여부 |
| `positionSource` | `EXISTING_SMALL_POSITION` 또는 `PAPER_FIXTURE` |
| `maxKrw` | 소액 한도 KRW |
| `operatorEvidenceConfigured` | 운영자 evidence 존재 여부 (boolean) |
| `positionEvidenceConfigured` | 기존 소액 포지션 evidence 존재 여부 (boolean) |
| `guardedBuySmokeEnabled` | guarded buy smoke 활성화 여부 |
| `guardedBuyApprovalConfigured` | guarded buy 승인 evidence 존재 여부 (boolean) |
| `statusLabel` | 한국어 상태 라벨 |
| `message` / `action` | 한국어 상태 설명과 필요 조치 |
| `trace` | 내부 reason code |

## 변경 절차

설정 구조나 허용 id를 바꾸면 다음을 함께 확인한다.

1. `src/runtime/config.ts` 또는 `src/runtime/registry-config.ts`
2. `src/runtime/strategy-parameters.ts` 또는 `src/runtime/risk-config.ts`
3. `src/application/registry.ts`
4. `config/paper.json`
5. 관련 unit test
6. 이 문서와 기준 설계 문서

검증 명령:

```sh
corepack pnpm typecheck
corepack pnpm test
./scripts/verify
```
