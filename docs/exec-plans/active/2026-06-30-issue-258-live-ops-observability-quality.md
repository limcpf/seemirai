# Issue #258 Live Ops 운영 관측성·전략 품질 강화 실행 계획

## 목표

Post-M23 Live Ops 운영에서 주문이 없던 tick도 정상 decision evidence로 남기고, 전략 feature와 threshold 품질을 DB 기반으로 검증 가능하게 만든다. 최종 완료는 live decision tick, DB-backed feature provider, calibration report, status/TUI 문구 분리, daemon hardening, audit/tax evidence contract가 모두 연결된 뒤 판단한다.

## 범위

- Sub PR 01: live decision history persistence contract, HOLD 1분 bucket dedupe, secret-free JSONB 저장, 저장 실패 degraded status.
- Sub PR 02: autonomous feature provider를 DB-backed source로 전환하고 missing/stale feature fail-closed 기준을 보강한다.
- Sub PR 03: threshold calibration report runner와 report artifact contract를 추가한다.
- Sub PR 04: status/TUI/CLI 문구를 사용자 행동 언어와 내부 추적 정보로 분리한다.
- Sub PR 05: daemon retention, stale status, alert retry/manual-review hardening을 보강한다.
- Sub PR 06: audit/tax evidence contract, closeout manifest, 전체 source scan과 문서 closeout을 완료한다.

## 작업 단계

- [x] Sub PR 01 DB schema와 repository contract를 추가한다.
- [x] Sub PR 01 live execution/CLI 경계에서 decision tick write를 연결하고 실패를 degraded evidence로 격리한다.
- [x] Sub PR 01 단위 테스트, migration 테스트, gated integration 테스트를 추가한다.
- [ ] Sub PR 01 PR 생성, review drain, mother branch merge를 완료한다.
- [x] Sub PR 02 DB-backed feature provider 구현과 회귀 검증을 완료한다.
- [ ] Sub PR 03 calibration report runner 구현과 artifact 검증을 완료한다.
- [ ] Sub PR 04 status/TUI wording separation을 구현하고 사용자-facing fixture를 검증한다.
- [ ] Sub PR 05 daemon 운영 안정성 hardening과 alert/retry 검증을 완료한다.
- [ ] Sub PR 06 audit/tax closeout contract와 전체 검증을 완료한다.

## 검증 방법

- `corepack pnpm exec vitest run tests/unit/live-ops-scripts.test.ts tests/unit/live-decision-history.test.ts tests/unit/live-ops-live-execution.test.ts tests/integration/live-decision-history.test.ts tests/unit/migration-runner.test.ts tests/unit/live-ops-runtime-adapter.test.ts tests/unit/live-ops-app-core.test.ts`
- `corepack pnpm typecheck`
- `./scripts/verify docs`
- Sub PR별 GitHub checks와 `pr-review-drain` review/reaction 상태 확인.

## 결정 로그

- 2026-06-30: `live_decision_ticks`는 append 위주의 decision tick 기록 테이블로 두고, retention은 repository/service 경계에서 명시 호출한다.
- 2026-06-30: `HOLD` decision은 같은 exchange/market/strategy/reason의 1분 bucket dedupe를 사용해 HOLD flood를 줄인다. `BUY`, `SELL`, `BLOCK`은 source tick scope dedupe를 유지한다.
- 2026-06-30: decision history write 실패는 주문 후보를 재시도하거나 보정하지 않고 status/TUI degraded evidence로만 남긴다.
- 2026-06-30: feature snapshot, threshold, trace JSONB에는 raw provider payload, raw order detail, secret-like key/string을 저장하지 않는다.
- 2026-06-30: autonomous feature provider는 `trades`와 `orderbook_snapshots` DB window를 우선 읽고, sample 부족·stale·오염 feature는 주문 후보 전 fail-closed로 닫는다. public tick fallback은 DB snapshot이 없을 때만 degraded source로 기록한다.

## 남은 이슈

- Sub PR 01은 PR 생성과 review drain 전이다.
- Sub PR 02는 PR 생성과 review drain 전이다.
- 실제 DB integration은 `SEEMIRAI_RUN_DB_INTEGRATION=1`이 있을 때만 실행된다.
- calibration report와 audit/tax evidence는 후속 sub PR에서 별도 contract로 닫아야 한다.
