# Issue #196 Live Ops 원클릭 앱 실행 계획

## 목표

`corepack pnpm live:ops -- --config <운영-json-path> --env-file <운영-env-path> --tui` 한 줄로 DB readiness, Upbit market data,
analysis/decision, live execution, reconcile/PnL/status, Telegram, TUI 운영 콘솔을 같은 lifecycle 아래 시작하는 production 경로를 만든다.

완료 기준은 Web UI가 아니라 TUI-first 운영 콘솔이다. 수익 보장이나 예산 확대가 아니라, 실거래가 발생할 수 있는 운영 표면을 안전하게
만들고 주문이 없을 때도 DB/Telegram/TUI에서 이유를 설명 가능하게 만드는 것이 목표다.

## 범위

- production live ops config/env contract
- DB/migration readiness
- foreground/attach TUI 운영 콘솔
- DB-backed market data collector
- analysis/decision pipeline
- live execution integration
- Telegram lifecycle/trade alert
- legacy M22/M23 pilot 경계 정리와 closeout

## Sub PR 계획

1. Foundation, FR, config/env contract
2. DB readiness와 migration guard
3. TUI 운영 콘솔 shell과 safe summary contract
4. DB-backed market data collector
5. Analysis/decision pipeline 연결
6. Live execution integration
7. Telegram lifecycle/trade alert 통합
8. Legacy cleanup, docs, closeout

## 현재 상태

- Sub PR 01 완료: `LiveOpsConfig` contract, secret env loader, legacy env detector, `live:ops`/`live:ops:tui` skeleton, safe fixture를 추가했다.
- Sub PR 02 완료: DB readiness를 env boolean이 아니라 read-only DB connection probe와 `schema_migrations`/디스크 migration state로 계산한다.
- Sub PR 03 완료: `live:ops -- --tui`와 `live:ops:tui -- --attach ...`가 같은 secret-safe TUI dashboard 첫 화면을 출력한다.
- Sub PR 04 완료: production live ops market data collector가 DB-backed store contract로 trade/orderbook/status를 저장하고 TUI summary에
  저장 확인을 표시한다.
- Sub PR 05 완료: analysis/decision pipeline이 market data/feature/strategy 평가를 묶고 HOLD/order intent summary를 TUI에 표시한다.
- Sub PR 06 완료: live execution adapter가 단일 `BUY + LIMIT + post_only` 후보만 기존 live autonomous entry runtime 요청으로 낮추고,
  HOLD/차단/복수 후보에서는 broker runtime 호출 0회를 유지한다.
- Sub PR 07 진행 중: Telegram alert mapper가 startup/live order capable/trade block/order submitted event를 기존 live ops alert
  dispatch request로 낮추고 fixture TUI에는 provider 호출 0회 plan을 표시한다.
- fixture smoke는 외부 DB/provider를 호출하지 않는다. 실제 실행은 pending migration, missing table, unknown applied migration, checksum drift에서
  fail-closed 한다.

## 검증 방법

Sub PR 01:

```sh
corepack pnpm exec vitest run tests/unit/live-ops-config.test.ts tests/unit/live-ops-scripts.test.ts --reporter=verbose
corepack pnpm typecheck
./scripts/verify docs
```

Sub PR 02:

```sh
corepack pnpm exec vitest run tests/unit/live-ops-db-readiness.test.ts tests/unit/live-ops-scripts.test.ts --reporter=verbose
corepack pnpm typecheck
./scripts/verify docs
```

Sub PR 03:

```sh
corepack pnpm exec vitest run tests/unit/live-ops-scripts.test.ts --reporter=verbose
corepack pnpm live:ops -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --tui
corepack pnpm live:ops:tui -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --attach fixture
corepack pnpm typecheck
./scripts/verify docs
```

Sub PR 04:

```sh
corepack pnpm exec vitest run tests/unit/live-ops-market-data.test.ts tests/unit/live-ops-scripts.test.ts --reporter=verbose
corepack pnpm live:ops -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --tui
corepack pnpm live:ops:tui -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --attach fixture
corepack pnpm typecheck
./scripts/verify docs
```

Sub PR 05:

```sh
corepack pnpm exec vitest run tests/unit/live-ops-analysis-decision.test.ts tests/unit/live-ops-scripts.test.ts --reporter=verbose
corepack pnpm live:ops -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --tui
corepack pnpm live:ops:tui -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --attach fixture
corepack pnpm typecheck
./scripts/verify docs
```

Sub PR 06:

```sh
corepack pnpm exec vitest run tests/unit/live-ops-live-execution.test.ts tests/unit/live-ops-scripts.test.ts --reporter=verbose
corepack pnpm live:ops -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --tui
corepack pnpm live:ops:tui -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --attach fixture
corepack pnpm typecheck
./scripts/verify docs
```

Sub PR 07:

```sh
corepack pnpm exec vitest run tests/unit/live-ops-telegram-alerts.test.ts tests/unit/live-ops-scripts.test.ts --reporter=verbose
corepack pnpm live:ops -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --tui
corepack pnpm live:ops:tui -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --attach fixture
corepack pnpm typecheck
./scripts/verify docs
```

최종 closeout:

```sh
corepack pnpm typecheck
corepack pnpm test
./scripts/verify docs
./scripts/verify
git diff --check
```

## 결정 로그

- 2026-06-14: production config와 credential env를 분리한다. JSON에는 secret-like key를 허용하지 않는다.
- 2026-06-14: M22/M23 milestone smoke/readiness env는 production readiness로 사용하지 않는다.
- 2026-06-14: 첫 production market은 `KRW-BTC` 단일, 1회 `10000` KRW, 일일/open `30000` KRW, 운영 중지 ceiling `50000` KRW 미만으로 고정한다.
- 2026-06-14: TUI는 필수 1차 백오피스이며 Web UI는 제외 범위다.
- 2026-06-14: DB readiness는 migration table 생성/자동 apply를 하지 않는다. 실제 실행은 read-only schema state를 기준으로 차단하고,
  fixture smoke는 외부 DB 연결 없이 디스크 migration 기준만 확인한다.
- 2026-06-14: foreground TUI와 attach TUI의 첫 화면은 같은 dashboard renderer를 사용하고, credential/raw provider payload/raw config enum을
  노출하지 않는다.
- 2026-06-14: market data collector는 KRW-BTC/upbit_krw_spot event만 DB-backed store로 통과시키고, stale/reconnect/disconnect는
  저장 후 신규 실주문 전진을 차단한다.
- 2026-06-14: analysis/decision pipeline은 market data/feature 실패를 HOLD/차단 summary로 닫고, 성공 시 주입 strategy의 order intent
  수만 live execution sub PR로 넘길 계약으로 고정한다.
- 2026-06-14: live execution adapter는 manual JSONL을 요구하지 않고 analysis order intent를 `LiveAutonomousEntryRuntime` 요청으로
  변환한다. 단일 `BUY + LIMIT + post_only` 후보만 전진시키며, 후보 없음/차단/복수 후보는 broker runtime 호출 전에 닫는다.
- 2026-06-14: Telegram alert mapper는 provider 호출 전 startup/live order capable/trade event plan을 만들고, fake notifier dispatch로
  기존 `LiveOpsAlertInput`/cooldown/retry 경계와 연결되는지 검증한다.

## 남은 이슈

- TUI control confirmation과 종료/attach lifecycle 정책.
- market data DB freshness와 strategy/decision evidence 연결.
- live execution path의 실제 provider 조립, duplicate order restart recovery evidence, gated canary cleanup.
- Telegram 실제 startup/live order capable alert evidence.
- production runbook과 closeout artifact 정리.
