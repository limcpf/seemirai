# Issue #180 M22 제한적 완전 자동매매 실행 계획

## 목표

Issue #180은 운영자가 명시적으로 arm 한 `LIVE_AUTONOMOUS_SMALL_BUDGET` runtime에서 `KRW-BTC` 단일 market, 1회 `10000` KRW,
일일 `30000` KRW 예산 안의 자동 매수와 자동 매도를 제한적으로 허용한다.

목표는 수익 보장이 아니라 24시간 live autonomous pilot에서 crash 0회, unhandled rejection 0회, risk gate 우회 주문 0건,
reconcile mismatch 0건을 기계적으로 증명하는 것이다. 기본 `PAPER_NO_KEY` runtime은 M22 이후에도 live order API 호출 0회를
유지해야 한다.

## 범위

- M22 feature requirements와 config contract
- startup readiness guard와 secret-safe summary
- autonomous order attempt state machine, durable reservation, random idempotency key
- entry runtime의 cost/risk/kill switch/reconcile/budget/order type 재검증
- M19 exit engine 기반 exit integration
- Telegram/status/daily report safe summary
- source scan, gated live pilot skip/pass evidence, closeout

제외 범위:

- M23 7일 24/7 운영 안정화
- M24 strategy/universe/budget 확대
- BTC 외 다중 market 기본 활성화
- 신규 진입 시장가, 시장가 매도, 최유리 주문 기본 허용
- hard stop 시 open position 자동 시장가 청산
- Telegram public webhook endpoint
- 출금, 입출금 자동화, 선물, 레버리지, 마진, 타인 계정, 신호 판매
- LLM 직접 매수/매도 판단
- 신규 runtime dependency

## Sub PR 계획

### Sub PR 01. Plan, FR, Config Contract

- 상태: 완료
- branch: `issue-180-subpr-01-plan-config`
- PR: https://github.com/limcpf/seemirai/pull/181
- merge: `3386aaabac19330c85ed289877b092f62d437f8d`
- DnD:
  - `FR-OPS-003` 추가
  - M22 active exec plan 작성
  - `live_autonomous` config schema와 기본 비활성 guard 추가
  - `KRW-BTC` 단일 기본값, 1회 `10000` KRW, 일일 `30000` KRW, 32자 identifier 제한 고정
  - M21 closeout stale merge 문구 보강
  - runtime/security/reliability/product 문서 갱신
  - `./scripts/verify docs`, targeted config test 통과

### Sub PR 02. Readiness Guard & Safe Summary

- 상태: 완료
- branch: `issue-180-subpr-02-readiness-guard`
- PR: https://github.com/limcpf/seemirai/pull/182
- merge: `9c14a0dbaa96138258264bfe60233ff471ff4c9a`
- DnD:
  - M21 1주 gate evidence guard
  - operator arm/budget/key scope evidence guard
  - M20/M16/M17/M18/M19 readiness guard
  - secret-safe runtime summary
  - 기본 `PAPER_NO_KEY` live order API 0회 회귀 테스트

### Sub PR 03. Autonomous Entry Runtime

- 상태: 완료
- branch: `issue-180-subpr-03-autonomous-entry`
- PR: https://github.com/limcpf/seemirai/pull/183
- merge: `78167ba71c6ffb2bcf13061d8d7e7eee2fd2e211`
- DnD:
  - autonomous order attempt state machine
  - strategy/cost/risk/kill switch/reconcile/budget 재검증
  - durable reservation과 random idempotency key generation
  - retry 시 기존 attempt identifier 재사용
  - 수량×가격 기준 지정가 notional 검증과 KRW 손실 한도 preflight
  - `LIMIT + post_only` live broker submission 경계
  - fake broker integration test
- 로컬 검증: 2026-06-10 `./scripts/verify` 통과, 82 passed / 11 skipped files, 1327 passed / 113 skipped tests

### Sub PR 04. Exit, Telegram Status & Daily Report Integration

- 상태: 진행 중
- branch: `issue-180-subpr-04-exit-status-report`
- DnD:
  - M19 exit engine live autonomous 연결
  - partial fill/cancel/requote/reconcile mismatch handling
  - Telegram/status/report safe summary
  - user-facing Korean formatter와 trace 분리
- 진행:
  - M22 guard/reconcile 통과 시에만 주입된 M19 exit runner를 호출하는 live autonomous exit orchestration 경계 추가
  - M19 exit runtime 결과와 M16 reconcile summary를 M22 live autonomous exit safe summary로 낮추는 application 모듈 추가
  - `/status.runtime.liveAutonomous`, `/status.liveAutonomousExit`, Telegram `/status`/`/orders`, daily report formatter 연결
  - partial fill 후 cancel/requote, cancel 실패, reconcile mismatch를 한국어 조치와 trace code로 분리
- 로컬 검증: 2026-06-10 `./scripts/verify` 통과, 83 passed / 11 skipped files, 1336 passed / 113 skipped tests

### Sub PR 05. Verification, Source Scan & 24h Pilot Closeout

- 상태: 대기
- DnD:
  - source scan
  - fake integration regression
  - gated live pilot guard skip 또는 24시간 pilot 실행 evidence
  - closeout 문서와 completed plan index/context map 갱신
  - `./scripts/verify`와 final readiness 감사

## 결정 로그

- 2026-06-10: 첫 M22 market 기본값은 `KRW-BTC` 단일로 고정한다.
- 2026-06-10: 첫 M22 예산은 M21 기본값을 유지한다. 1회 주문 상한 `10000` KRW, 일일 자동 주문 notional 한도 `30000` KRW.
- 2026-06-10: M22 config contract는 1회 주문 상한 `10000` KRW, 일일 자동 주문 notional 한도 `30000` KRW, open position
  notional 한도 `30000` KRW를 초과하는 설정을 load 단계에서 거부한다. 예산 확대는 M24 범위다.
- 2026-06-10: Upbit 공식 주문 생성 문서의 identifier 최대 길이는 64자지만, M22는 32자 보수 제한을 유지한다.
- 2026-06-10: M22 권장 identifier 패턴은 `m22a-<13 bytes random hex>`로 둔다. timestamp-only 또는 단순 증가값은 금지한다.
- 2026-06-10: 자동 entry는 `LIMIT + post_only`만 허용하고, 시장가/최유리 주문과 `post_only + smp_type`은 provider 호출 전 차단한다.

## 공식 문서 재확인

- Upbit 주문 생성: `https://docs.upbit.com/kr/reference/new-order`
- Upbit 주문 취소: `https://docs.upbit.com/kr/reference/cancel-order`
- Upbit 체결 대기 주문 목록 조회: `https://docs.upbit.com/kr/reference/list-open-orders`
- Upbit 요청 수 제한: `https://docs.upbit.com/kr/reference/rate-limits`
- Upbit KRW 마켓 주문 가격 단위 / 최소 주문 가능 금액: `https://docs.upbit.com/kr/docs/krw-market-info`

2026-06-10 확인 결과:

- 지정가 주문은 `time_in_force=post_only`를 사용할 수 있지만 `smp_type`과 함께 사용할 수 없다.
- 시장가 매수 `ord_type=price`, 시장가 매도 `ord_type=market`, 최유리 지정가 `ord_type=best`는 M22 기본 자동 주문 유형에서 제외한다.
- identifier는 Upbit 공식 한도 64자보다 보수적인 32자를 유지한다.
- KRW 최소 주문 가능 금액은 5,000 KRW다.
- Exchange default rate limit은 계정 단위 초당 최대 30회이며 `Remaining-Req` header를 추적해야 한다.

## 검증 방법

Sub PR별 기본 검증:

```sh
corepack pnpm typecheck
corepack pnpm exec vitest run tests/unit/config.test.ts
./scripts/verify docs
git diff --check
```

전체 closeout 검증:

```sh
corepack pnpm typecheck
corepack pnpm test
./scripts/verify docs
./scripts/verify
git diff --check
rg -n "POST /v1/orders|DELETE /v1/order|submitOrder\\(|cancelOrder\\(|ord_type.*market|ord_type.*best|LIVE_AUTONOMOUS|withdraw|출금|입금" src tests docs
rg -n "access_key|secret_key|Authorization|JWT|telegram_bot_token|raw provider|raw_provider|raw update|raw_order" src tests docs
```

## 남은 이슈

- M21 1주 gate evidence id와 실제 운영 artifact는 저장소 밖 redacted evidence로 주입해야 한다.
- 24시간 live autonomous pilot은 명시 env guard와 외부 secret/evidence가 있을 때만 실행한다.
