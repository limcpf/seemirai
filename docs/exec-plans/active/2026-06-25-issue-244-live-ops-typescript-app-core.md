# Issue #244 Live Ops TypeScript App Core 실행 계획

## 목표

production `live:ops` 실행 경로를 `dist/` build 산출물 기준으로 고정하고, 현재 `.mjs` support script에 몰린 boot/config/provider readiness/market data/decision/execution/reconcile/PnL/status/Telegram/TUI lifecycle을 TypeScript typecheck와 테스트 경계 안으로 순차 이동한다.

## 범위

- `corepack pnpm build`는 `dist/` production 산출물을 생성한다.
- `live:ops`, `live:ops:daemon`, `live:ops:tui`, `live:ops:pnl-closeout` package script는 `dist/runtime/*-cli.js`를 실행한다.
- `.mjs` runner와 support는 후속 sub PR에서 compatibility shim 또는 dev convenience entry로 낮춘다.
- 기존 Telegram/status/reconcile/risk/budget/broker side effect 의미는 바꾸지 않는다.
- 신규 runtime transpiler dependency는 추가하지 않는다.

## 제외 범위

- trading strategy 변경
- risk gate 의미 변경
- broker submit/cancel 정책 변경
- Telegram public webhook endpoint
- Web dashboard
- 신규 runtime dependency
- 시장가/최유리 주문 허용 확대
- LLM 직접 매수/매도 판단

## Sub PR 계획

### Sub PR 01: Build/dist 계약과 thin entry

- `tsconfig.build.json`과 `package.json` build script를 추가한다.
- production package script를 `dist/runtime/*-cli.js` 기준으로 전환한다.
- TypeScript dist CLI entry는 기존 `.mjs` support module을 compatibility shim으로만 호출한다.
- fixture smoke로 `live:ops`, `live:ops:daemon`, `live:ops:tui`, `live:ops:pnl-closeout --help`가 package script 경유로 동작하는지 확인한다.

DnD:

- `corepack pnpm build` 통과
- `corepack pnpm typecheck` 통과
- 관련 unit test 통과
- dist 기반 fixture smoke 통과
- 신규 TypeScript public type/function에 한국어 JSDoc 포함

### Sub PR 02: Live Ops app core contract

- TypeScript app core input/output contract를 정의한다.
- boot lifecycle service skeleton을 추가한다.
- 기존 runner와 side effect 순서 parity 테스트를 추가한다.
- `.mjs` support가 TypeScript core contract를 호출하도록 첫 연결을 만든다.

DnD:

- config/env validation, DB readiness, provider readiness, market data, analysis/decision, live execution, reconcile/PnL/status, Telegram, TUI 순서가 테스트로 표현된다.
- support script 직접 로직은 새 TypeScript contract 호출로 줄어든다.
- side effect 순서가 기존 fixture smoke와 동등하다.

### Sub PR 03: Runtime adapter 이동

- config/env validation, DB readiness, market data, analysis/decision, live execution, reconcile/PnL/status, Telegram, TUI worker 연결을 TypeScript 모듈로 이동한다.
- 기존 smoke와 fake provider 회귀 테스트를 유지한다.
- strategy가 broker, Upbit client, DB connection, Telegram dispatcher를 직접 호출하지 않는 invariant를 확인한다.

DnD:

- 핵심 Live Ops lifecycle 로직이 TypeScript typecheck 대상 모듈에 있다.
- `.mjs` support에는 핵심 비즈니스/운영 로직이 남지 않는다.
- live order API 호출 조건, risk/reconcile/budget/kill switch guard 의미가 바뀌지 않는다.

### Sub PR 04: 문서, source scan, closeout

- `ARCHITECTURE.md`, `docs/DESIGN.md`, `docs/RUNTIME_CONFIG.md`, `docs/FEATURE_REQUIREMENTS.md` 중 변경된 build/run 기준을 반영한다.
- source/security scan 결과를 PR 본문에 기록한다.
- active plan closeout을 완료 상태로 갱신하거나 completed plan으로 이동한다.

DnD:

- `./scripts/verify docs` 통과
- `./scripts/verify` 통과
- `git diff --check` 통과
- source scan에서 raw provider payload, raw order detail, Telegram token, API key, JWT, Authorization header 노출 후보가 없는지 확인

## 순서와 병렬성

기본은 순차 진행한다. Sub PR 01이 build/run 계약을 고정해야 이후 이동 작업의 실행 기준이 선다. Sub PR 02는 app core contract를 고정하고, Sub PR 03은 충돌 가능성이 큰 runtime 이동을 단일 흐름으로 진행한다. Sub PR 04는 마지막 검증과 문서 closeout이다.

## 검증 방법

기본 검증:

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
./scripts/verify docs
./scripts/verify
git diff --check
```

fixture smoke:

```sh
corepack pnpm live:ops -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --tui
corepack pnpm live:ops:daemon -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --duration-ms 1000 --tui
corepack pnpm live:ops:tui -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --attach fixture
```

source scan:

```sh
rg -n "run-live-ops-support|submitOrder\\(|cancelOrder\\(|Authorization|JWT|telegram.*token|raw provider|raw_provider|raw_order" scripts src tests docs
```

## 진행 상태

- 2026-06-25: Sub PR 01 완료. PR #246에서 build/dist 계약과 dist CLI entry를 추가했고 mother branch에 merge됐다.
- 2026-06-25: Sub PR 02 진행 중. TypeScript app core contract와 boot lifecycle 순서 테스트를 추가하고 dist CLI가 app core를 호출하도록 연결한다.

## 남은 이슈

- Sub PR 02에서 compatibility shim 뒤의 TypeScript app core contract를 확정해야 한다.
- Sub PR 03에서 거대 `.mjs` support script의 lifecycle 로직을 TypeScript 모듈로 이동해야 한다.
- 마지막 final PR은 main 대상으로 생성하되 merge하지 않는다.
