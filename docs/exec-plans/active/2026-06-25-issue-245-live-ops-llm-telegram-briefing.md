# Issue #245 Live Ops LLM Telegram 브리핑 실행 계획

## 목표

운영자가 Telegram에서 `/brief`로 현재 서버 상태, 매수/매도 조건, wallet/cash/coin 상태, 시황, 보유/현금 판단 이유, 최근 주문/차단 이유를 한국어로 확인할 수 있게 한다.

LLM은 deterministic evidence를 사람이 읽기 쉬운 초안으로 낮추는 보조 역할만 한다. LLM 출력은 매수/매도 판단, 목표가, 수량, 주문 허용, broker 호출로 연결하지 않는다.

## 범위

포함:

- `LiveOpsBriefingSnapshot` secret-safe contract.
- LLM 없이 동작하는 deterministic Korean briefing formatter.
- live ops status, PnL/reconcile, decision ledger, market freshness, wallet/coin source 연결.
- LLM input source/result type 확장과 forbidden output fail-closed guard.
- Telegram `/brief` read-only command와 scheduled briefing 기본 비활성/cooldown/fingerprint.
- prompt/audit/source scan redaction evidence.

제외:

- LLM 직접 매수/매도 판단.
- LLM 기반 order candidate 생성, broker submit/cancel, 목표가, 주문 수량.
- Telegram public webhook endpoint.
- 신규 dependency.

## Sub PR 계획

1. **Sub PR 01: briefing snapshot contract와 deterministic formatter**
   - `src/application/live-ops-briefing.ts` public entry와 같은 이름의 하위 디렉터리에 contract/formatter를 둔다.
   - formatter는 상태, 원인, 영향, 필요 조치를 먼저 표시하고 내부 id/reason은 `추적 정보`로 분리한다.
   - missing/stale/unavailable 값은 0으로 보정하지 않는다.
   - raw provider payload, raw order detail, Telegram token, API key/JWT/Authorization 후보는 redaction한다.
   - 검증: `corepack pnpm exec vitest run tests/unit/live-ops-briefing.test.ts`, `corepack pnpm typecheck`, `./scripts/verify docs`.

2. **Sub PR 02: status/wallet/coin/market/decision provider 연결**
   - live ops status, PnL/reconcile, decision ledger why summary, market data freshness, wallet/coin balance projection을 snapshot assembler에 연결한다.
   - 결측 source는 관측 부재로 표현하고 deterministic formatter까지 전파한다.
   - 검증: `tests/unit/live-ops-status.test.ts`, 신규 assembler tests, 관련 provider tests.

3. **Sub PR 03: LLM briefing schema와 guard**
   - `live_ops_status_snapshot` input source와 `live_ops_briefing_draft` result type을 추가한다.
   - LLM prompt는 redacted snapshot만 사용하고 prompt fingerprint/audit/source ids를 저장한다.
   - `BUY`, `SELL`, `INCREASE_POSITION`, 목표가, 주문 수량, 직접 매매 권고는 fail-closed 후 deterministic fallback으로 수렴한다.
   - 검증: `tests/unit/llm-risk-assistant-contract.test.ts`, `tests/unit/llm-risk-assistant-provider.test.ts`, `tests/unit/llm-risk-assistant-audit.test.ts`.

4. **Sub PR 04: Telegram `/brief`와 scheduled dispatch**
   - `/brief`를 owner allowlist 기반 read-only command로 추가한다.
   - 동일 Telegram update/message/command 재전달은 durable dedupe로 중복 dispatch를 만들지 않는다.
   - scheduled briefing은 config 명시 활성화가 있을 때만 켜고 cooldown/fingerprint를 요구한다.
   - Telegram outbound 실패는 trading/reconcile/status 생성 성공을 rollback하지 않는다.
   - 검증: `tests/unit/telegram-inbound.test.ts`, `tests/unit/telegram-inbound-runtime.test.ts`, `tests/unit/live-ops-telegram-alerts.test.ts`.

5. **Sub PR 05: 문서, source scan, closeout**
   - `docs/FEATURE_REQUIREMENTS.md`, `docs/RUNTIME_CONFIG.md`, `docs/SECURITY.md`, `docs/RELIABILITY.md`, 이 실행 계획을 최종 상태로 갱신한다.
   - source scan과 전체 검증을 수행한다.
   - 검증: `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify docs`, `./scripts/verify`, `git diff --check`, issue source scan 명령.

## 결정 로그

- 2026-06-25: issue #245 본문 기준 5개 sub PR 순차 진행으로 확정했다.
- 2026-06-25: scheduled briefing은 기본 비활성으로 두고 `/brief`는 read-only command로만 추가한다.
- 2026-06-25: LLM은 deterministic snapshot 설명 초안으로만 사용하고 unsafe output은 deterministic fallback으로 닫는다.
- 2026-06-25: Sub PR 02 assembler는 provider I/O 없이 `LiveOpsStatusSummary`, decision ledger `WhySummary`, market/portfolio safe projection을 입력으로 받는 순수 조립 경계로 확정했다.

## 남은 이슈

- Sub PR 03에서 LLM schema 확장이 기존 `FR-LLM-001` 비범위와 충돌하지 않도록 문서와 test를 함께 갱신해야 한다.
- Sub PR 04에서 Telegram scheduled dispatch의 config 이름과 cooldown/fingerprint 저장 위치를 확정해야 한다.
