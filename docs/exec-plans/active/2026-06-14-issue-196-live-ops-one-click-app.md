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

- Sub PR 01 진행 중.
- `LiveOpsConfig` contract, secret env loader, legacy env detector, `live:ops`/`live:ops:tui` skeleton, safe fixture를 추가한다.
- Sub PR 01은 외부 provider를 호출하지 않는다. DB/provider/TUI lifecycle은 후속 sub PR에서 닫는다.

## 검증 방법

Sub PR 01:

```sh
corepack pnpm exec vitest run tests/unit/live-ops-config.test.ts tests/unit/live-ops-scripts.test.ts --reporter=verbose
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

## 남은 이슈

- DB readiness probe와 migration apply mode 연결.
- TUI foreground/attach lifecycle과 control confirmation.
- market data DB freshness와 strategy/decision evidence 연결.
- live execution path의 duplicate order 방지와 gated canary cleanup.
- Telegram 실제 startup/live order capable alert evidence.
- production runbook과 closeout artifact 정리.
