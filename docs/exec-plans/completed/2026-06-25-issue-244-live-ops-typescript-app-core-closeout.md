# Issue #244 Live Ops TypeScript App Core closeout

## 목표

production `live:ops` 실행 경로를 `dist/` build 산출물 기준으로 고정하고, 현재 `.mjs` support script에 몰린 boot/config/provider readiness/market data/decision/execution/reconcile/PnL/status/Telegram/TUI lifecycle을 TypeScript typecheck와 테스트 경계 안으로 순차 이동한다.

## 완료 범위

- `corepack pnpm build`는 `dist/` production 산출물을 생성한다.
- `live:ops`, `live:ops:daemon`, `live:ops:tui`, `live:ops:pnl-closeout` package script는 `dist/runtime/*-cli.js`를 실행한다.
- `src/runtime/live-ops-app-core.ts`와 `src/runtime/live-ops-app-core/`가 foreground/TUI boot lifecycle contract를 제공한다.
- `src/runtime/live-ops-runtime-adapter.ts`와 `src/runtime/live-ops-runtime-adapter/`가 config/env/provider/readiness/market data/decision/execution/reconcile/PnL/status/Telegram/TUI orchestration 입력을 TypeScript 경계에서 조립한다.
- `.mjs` runner는 compatibility/dev convenience entry로, `scripts/run-live-ops-support.mjs`는 production dist app core가 호출하는 side-effect port와 compatibility shim으로 낮췄다.
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

## Sub PR 결과

### Sub PR 01: Build/dist 계약과 thin entry

- PR #246에서 `tsconfig.build.json`과 `package.json` build/prelive script를 추가했다.
- production package script를 `dist/runtime/*-cli.js` 기준으로 전환했다.
- TypeScript dist CLI entry는 기존 `.mjs` support module을 compatibility shim으로 호출한다.
- fixture smoke로 `live:ops`, `live:ops:daemon`, `live:ops:tui`, `live:ops:pnl-closeout --help` package script 경로를 확인했다.

검증:

- `corepack pnpm build` 통과
- `corepack pnpm typecheck` 통과
- 관련 unit test와 full `./scripts/verify` 통과
- dist 기반 fixture smoke 통과
- 신규 TypeScript public type/function에 한국어 JSDoc 포함

### Sub PR 02: Live Ops app core contract

- PR #247에서 TypeScript app core input/output contract를 정의했다.
- boot lifecycle service를 추가하고 foreground/TUI CLI가 app core를 호출하도록 연결했다.
- 기존 runner와 side effect 순서 parity 테스트를 추가했다.

검증:

- config/env validation, DB readiness, provider readiness, market data, analysis/decision, live execution, reconcile/PnL/status, Telegram, TUI 순서가 테스트로 표현된다.
- support script 직접 로직은 새 TypeScript contract 호출로 줄어든다.
- side effect 순서가 기존 fixture smoke와 동등하다.
- `corepack pnpm typecheck`, `corepack pnpm build`, `./scripts/verify docs`, `./scripts/verify` 통과

### Sub PR 03: Runtime adapter 이동

- PR #248에서 config/env validation, DB readiness, market data, analysis/decision, live execution, reconcile/PnL/status, Telegram, TUI worker 연결 입력 조립을 TypeScript runtime adapter 모듈로 이동했다.
- 기존 smoke와 fake provider 회귀 테스트를 유지했다.
- strategy가 broker, Upbit client, DB connection, Telegram dispatcher를 직접 호출하지 않는 invariant를 확인했다.

검증:

- 핵심 Live Ops lifecycle 로직이 TypeScript typecheck 대상 모듈에 있다.
- `.mjs` support에는 핵심 비즈니스/운영 로직이 남지 않는다.
- live order API 호출 조건, risk/reconcile/budget/kill switch guard 의미가 바뀌지 않는다.
- `corepack pnpm typecheck`, `corepack pnpm build`, `./scripts/verify docs`, `./scripts/verify` 통과

### Sub PR 04: 문서, source scan, closeout

- `docs/RUNTIME_CONFIG.md`, `docs/FEATURE_REQUIREMENTS.md`, `docs/README.md`, exec plan index, generated context map에 변경된 build/run 기준을 반영했다.
- source/security scan 결과를 PR 본문에 기록한다.
- active plan closeout을 completed plan으로 이동했다.

검증:

- `./scripts/verify docs` 통과
- `./scripts/verify` 통과
- `git diff --check` 통과
- 새 TypeScript app core/runtime adapter source scan에서 provider 원본 payload, 주문 원본 세부정보, Telegram token, API key, JWT, Authorization header 노출 후보가 없는지 확인

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
rg -n "raw provider|raw_provider|raw order|raw_order|Authorization|JWT|telegram.*token" src/runtime/live-ops-app-core.ts src/runtime/live-ops-app-core src/runtime/live-ops-runtime-adapter.ts src/runtime/live-ops-runtime-adapter
```

## 진행 상태와 결정 로그

- 2026-06-25: Sub PR 01 완료. PR #246에서 build/dist 계약과 dist CLI entry를 추가했고 mother branch에 merge됐다.
- 2026-06-25: Sub PR 02 완료. PR #247에서 TypeScript app core contract와 boot lifecycle 순서 테스트를 추가하고 dist CLI가 app core를 호출하도록 연결했다.
- 2026-06-25: Sub PR 03 완료. PR #248에서 runtime adapter orchestration을 TypeScript service로 옮기고 support shim은 side effect port를 제공하도록 분리했다.
- 2026-06-25: Sub PR 04에서 문서 closeout과 새 TypeScript app core/runtime adapter source scan evidence를 남겼다.
- production 실행은 package script가 먼저 `corepack pnpm build`를 수행하고 `dist/runtime/*-cli.js`를 실행하는 계약으로 고정한다.
- runtime transpiler dependency는 추가하지 않고, `.mjs`는 compatibility/dev convenience 또는 side-effect port 경계로 유지한다.

## 남은 리스크와 후속 처리

- 마지막 final PR은 `main` 대상으로 생성하되 merge하지 않는다.
- final PR은 GitHub checks, unresolved review thread, Codex review reaction을 review drain까지 확인한다.
- trading strategy, risk gate, broker submit/cancel 정책은 이번 issue에서 변경하지 않았다.
