# Issue #245 Live Ops LLM Telegram briefing closeout

## 목표

운영자가 Telegram에서 `/brief`로 현재 서버 상태, 매수/매도 조건, wallet/cash/coin 상태, 시황, 보유/현금 판단 이유, 최근 주문/차단 이유를 한국어로 확인할 수 있게 했다.

LLM은 deterministic evidence를 사람이 읽기 쉬운 초안으로 낮추는 보조 역할만 한다. LLM 출력은 매수/매도 판단, 목표가, 수량, 주문 허용, broker 호출로 연결하지 않는다.

## 완료 범위

- `LiveOpsBriefingSnapshot` secret-safe contract와 deterministic Korean formatter를 추가했다.
- status, PnL/reconcile, decision ledger, market freshness, wallet/coin source를 briefing snapshot assembler에 연결했다.
- LLM input source `live_ops_status_snapshot`과 result type `live_ops_briefing_draft`를 추가하고 unsafe output fail-closed guard를 고정했다.
- Telegram inbound `/brief`를 owner allowlist 기반 read-only command로 추가했다.
- scheduled briefing은 기본 비활성이고 명시 활성화 시 cooldown/fingerprint/delivery reservation을 사용한다.
- CLI scheduled briefing 경로도 env opt-in/opt-out, durable cooldown, wallet-aware source fingerprint, priority alert isolation, nested failure status 노출을 통과한다.
- prompt/audit/source scan redaction evidence와 문서 closeout을 남겼다.

## 제외 범위

- LLM 직접 매수/매도 판단
- LLM 기반 order candidate 생성, broker submit/cancel, 목표가, 주문 수량
- Telegram public webhook endpoint
- 신규 dependency
- live trading strategy, risk gate, broker submit/cancel 정책 변경

## Sub PR 결과

### Sub PR 01: briefing snapshot contract와 deterministic formatter

- PR #251에서 `src/application/live-ops-briefing.ts` public entry와 `live-ops-briefing/` 하위 구현을 추가했다.
- formatter는 상태, 원인, 영향, 필요 조치를 먼저 표시하고 내부 id/reason/source는 `추적 정보`로 분리한다.
- missing/stale/unavailable 값은 0으로 보정하지 않고 관측 부재로 표시한다.
- raw provider payload, raw order detail, Telegram token, API key/JWT/Authorization 후보 redaction을 테스트로 고정했다.

### Sub PR 02: status/wallet/coin/market/decision provider 연결

- PR #252에서 live ops status, PnL/reconcile, decision ledger why summary, market data freshness, wallet/coin balance projection을 snapshot assembler에 연결했다.
- 결측 source는 관측 부재로 표현하고 deterministic formatter까지 전파한다.
- side 근거 없는 decision은 매수/매도 조건으로 단정하지 않는다.

### Sub PR 03: LLM briefing schema와 guard

- PR #253에서 `live_ops_status_snapshot` input source와 `live_ops_briefing_draft` result type을 추가했다.
- LLM prompt는 redacted snapshot만 사용하고 prompt fingerprint/audit/source ids를 저장한다.
- `BUY`, `SELL`, `INCREASE_POSITION`, 목표가, 주문 수량, 직접 매매 권고는 fail-closed 후 deterministic fallback으로 수렴한다.
- provider 실패, disabled provider, source mismatch, unsupported result type, unsafe draft는 deterministic briefing을 유지한다.

### Sub PR 04: Telegram `/brief`와 scheduled dispatch

- PR #254에서 `/brief`를 owner allowlist, durable dedupe, audit 경계를 재사용하는 read-only command로 추가했다.
- 기본 `/brief` provider는 `/status` safe snapshot을 `LiveOpsBriefingSnapshot` formatter로 낮춘다.
- scheduled briefing config는 `telegram.briefing.scheduled_enabled`와 `SEEMIRAI_TELEGRAM_BRIEFING_SCHEDULED_ENABLED`로 확정했다.
- `SEEMIRAI_TELEGRAM_BRIEFING_SCHEDULED_ENABLED=0`은 JSON 활성 설정보다 우선하는 명시 비활성 override다.
- CLI production 경로는 `alert_cooldowns` 기반 durable scheduled briefing cooldown/reservation을 사용한다.
- source fingerprint는 schedule key와 briefing source evidence를 포함하고, 기준가 tick 변화만으로 cooldown을 우회하지 않으며, wallet/cash/coin 변화는 본문 변경으로 반영한다.
- lifecycle/trade 우선순위 알림은 scheduled briefing 지연/실패를 기다리지 않는다.
- scheduled briefing 실패는 trading/reconcile/status 생성 성공을 rollback하지 않고 nested status와 TUI/status text에 남긴다.

### Sub PR 05: 문서, source scan, closeout

- `docs/FEATURE_REQUIREMENTS.md`, `docs/RUNTIME_CONFIG.md`, `docs/SECURITY.md`, `docs/RELIABILITY.md`, exec plan index, generated context map을 최종 상태로 갱신한다.
- issue #245 source scan과 전체 검증을 PR 본문에 기록한다.
- 이 closeout 문서는 final main PR 생성 전 mother branch에 merge되는 마지막 sub PR이다.

## Acceptance trace

- `/brief` read-only command, owner allowlist, durable dedupe: `tests/unit/telegram-inbound.test.ts`, `tests/unit/telegram-inbound-runtime.test.ts`
- 현재 서버/daemon, readiness, buy/sell condition, wallet/cash/coin, PnL, market freshness, recent decision/order/reconcile/risk/alert retry 한국어 briefing: `tests/unit/live-ops-briefing.test.ts`, `tests/unit/live-ops-briefing-assembler.test.ts`
- LLM disabled/timeout/schema fail/unsafe output deterministic fallback: `tests/unit/llm-risk-assistant-briefing-draft.test.ts`, `tests/unit/llm-risk-assistant-provider.test.ts`
- LLM prompt/result contract와 forbidden trade output rejection: `tests/unit/llm-risk-assistant-contract.test.ts`, `tests/unit/llm-risk-assistant-audit.test.ts`
- scheduled briefing 기본 비활성, cooldown/fingerprint, durable CLI cooldown, env override, priority alert isolation: `tests/unit/live-ops-telegram-alerts.test.ts`, `tests/unit/live-ops-scripts.test.ts`, `tests/unit/notification-runtime.test.ts`
- raw provider/order/secret redaction: `tests/unit/live-ops-briefing.test.ts`, source scan

## 검증 방법

Sub PR 05와 final main PR은 다음 검증으로 완료 판정한다.

```sh
corepack pnpm typecheck
corepack pnpm test -- --reporter=dot
corepack pnpm build
./scripts/verify docs
./scripts/verify
git diff --check
```

Source scan:

```sh
rg -n "BUY|SELL|INCREASE_POSITION|target price|목표가|매수하세요|매도하세요|submitOrder\\(|cancelOrder\\(" src tests docs
rg -n "access_key|secret_key|Authorization|JWT|telegram_bot_token|raw provider|raw_provider|raw update|raw_order|raw message" src tests docs
```

위 broad scan은 domain/test fixture의 합법적 주문/secret guard 표현도 잡으므로 PR 본문에는 issue #245가 추가/변경한 briefing, LLM, Telegram inbound/scheduled dispatch 경계에서 신규 주문 side effect나 secret 원문 노출이 없는지 분류 결과를 함께 기록한다.

Sub PR 05 로컬 검증 결과:

- `./scripts/verify docs` 통과: 문서 74개, 매니페스트 91개, 링크 248개 확인
- `git diff --check` 통과
- `corepack pnpm typecheck` 통과
- `corepack pnpm build` 통과
- `corepack pnpm test -- --reporter=dot` 통과: 105 files passed, 11 skipped, 2019 passed, 114 skipped
- `./scripts/verify` 통과: docs/hooks/github/typecheck/test 통과
- source scan: issue #245 소유 briefing/LLM/Telegram runtime 모듈에서 신규 order side effect 검색 0건. LLM 금지어와 secret 후보는 schema guard, redaction 로직, 테스트 fixture에서만 확인.

## 결정 로그

- 2026-06-25: issue #245 본문 기준 5개 sub PR 순차 진행으로 확정했다.
- 2026-06-25: scheduled briefing은 기본 비활성으로 두고 `/brief`는 read-only command로만 추가한다.
- 2026-06-25: LLM은 deterministic snapshot 설명 초안으로만 사용하고 unsafe output은 deterministic fallback으로 닫는다.
- 2026-06-25: Sub PR 02 assembler는 provider I/O 없이 `LiveOpsStatusSummary`, decision ledger `WhySummary`, market/portfolio safe projection을 입력으로 받는 순수 조립 경계로 확정했다.
- 2026-06-25: Sub PR 03 LLM briefing draft는 `live_ops_status_snapshot`/`live_ops_briefing_draft` contract와 redacted deterministic briefing prompt만 사용하며, provider 실패, unsafe output, source mismatch는 deterministic fallback으로 수렴한다.
- 2026-06-26: Sub PR 04 `/brief`는 owner allowlist/dedupe/audit 경계를 재사용하는 read-only command로 확정했다.
- 2026-06-26: scheduled briefing config 이름은 `telegram.briefing.scheduled_enabled`, env override는 `SEEMIRAI_TELEGRAM_BRIEFING_SCHEDULED_ENABLED`, cooldown fingerprint segment는 `telegram.briefing.schedule_key`/`SEEMIRAI_TELEGRAM_BRIEFING_SCHEDULE_KEY`로 확정했다. 저장은 기존 `AlertDispatchRequest`와 `alert_cooldowns` 경계를 재사용한다.
- 2026-06-27: CLI scheduled briefing은 env `0` 비활성 override, durable cooldown reservation, wallet-aware fingerprint, 기준가-only cooldown 유지, nested failure text status를 포함해 review drain을 통과했다.

## 남은 리스크와 후속 작업

- 마지막 final PR은 `main` 대상으로 생성하되 이 runner 세션에서는 merge하지 않는다.
- final PR은 GitHub checks, unresolved review thread, Codex clean signal까지 review drain을 완료해야 한다.
- 실제 Telegram provider와 저장소 밖 credential을 사용하는 운영 smoke는 기본 CI에서 실행하지 않는다. 운영자는 배포 환경에서 별도 guard와 redacted evidence로 확인한다.
