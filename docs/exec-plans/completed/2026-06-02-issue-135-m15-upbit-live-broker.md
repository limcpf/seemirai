# Issue #135 M15 UpbitLiveBroker 완료 기록

- 상태: completed
- 작성일: 2026-06-02
- 완료일: 2026-06-02
- 이슈: [#135](https://github.com/limcpf/seemirai/issues/135)
- mother branch: `issue-135-mother`

## 목표

M14 v0.2 pilot에서 만든 Upbit private API client와 guard를 `BrokerPort` 경계로 끌어올려 `UpbitLiveBroker`를 구현한다. M15는 자동매매 전환 단계가 아니며, 기본 `PAPER_NO_KEY` runtime은 계속 `PaperBroker`만 조립하고 live order API 호출 0회를 유지해야 한다.

## 기준 문서

- [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md)
- [`../../PRD.md`](../../PRD.md)
- [`../../FEATURE_REQUIREMENTS.md`](../../FEATURE_REQUIREMENTS.md)
- [`../../product-specs/upbit-v0-2-pilot-private-api.md`](../../product-specs/upbit-v0-2-pilot-private-api.md)
- [`../../product-specs/upbit-live-autonomous-trading.md`](../../product-specs/upbit-live-autonomous-trading.md)
- [`../../RUNTIME_CONFIG.md`](../../RUNTIME_CONFIG.md)
- [`../../SECURITY.md`](../../SECURITY.md)
- [`../../RELIABILITY.md`](../../RELIABILITY.md)
- [`../../design-docs/2026-05-20-typescript-module-structure.md`](../../design-docs/2026-05-20-typescript-module-structure.md)

## 현재 상태

- M14 #124는 완료됐고 PR #132와 closeout PR #134가 `main`에 병합됐다.
- issue #135 mother branch에는 M15 `UpbitLiveBroker` core, guarded runtime factory, fake/gated smoke, closeout 문서가 반영됐다.
- 기본 `PAPER_NO_KEY` runtime은 `ExecutionEngine -> PaperBroker`만 active broker로 조립하고, live order API 호출 0회 source scan을 유지한다.
- 실제 Upbit private/order/live broker smoke는 운영자 secret과 명시 guard가 있을 때만 실행한다.

## 완료 요약

- `GET /v1/orders/open` private client wrapper, schema, mapper, query hash/rate-limit 검증을 추가했다.
- `UpbitLiveBroker`가 `BrokerPort`의 `submitOrder`, `cancelOrder`, `getOrder`, `listOpenOrders`, `getBalances`를 구현한다.
- `submitOrder`는 LIMIT, 1~32자 identifier, exchange/market 일치, post-only smoke invariant를 거래소 호출 전에 fail-closed 한다.
- duplicate identifier 복구는 현재 제출 intent와 fingerprint를 대조하고, M15 smoke wrapper는 복구 조회 주문을 같은 run 취소 evidence로 취급하지 않는다.
- guarded runtime factory는 `PILOT_ORDER_SMOKE`, private/order smoke guard, key scope evidence, 허용 scope, KRW market, 소액 budget, `upbit_krw_spot` exchange id를 모두 요구한다.
- fake integration smoke는 BrokerPort full flow와 artifact redaction을 검증하며, real smoke는 `SEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE=1`와 기존 M14 private/order guard가 모두 있을 때만 실행된다.

## 범위

- M15 실행계획과 runtime/security guard 문서를 고정한다.
- Upbit private client에 `GET /v1/orders/open` wrapper를 추가한다.
- open orders payload schema와 mapper를 추가해 `BrokerOrder` 목록으로 정규화한다.
- `UpbitLiveBroker`를 별도 모듈로 추가하고 `BrokerPort`의 `submitOrder`, `cancelOrder`, `getOrder`, `listOpenOrders`, `getBalances`를 구현한다.
- `submitOrder`는 `OrderSubmission.intent.orderType=LIMIT`만 허용하고 내부 idempotency key를 Upbit `identifier`로 그대로 매핑한다.
- identifier는 1자 이상 32자 이하만 허용하고 자동 truncate/hash를 만들지 않는다.
- `time_in_force=post_only`를 우선 지원하며 `post_only + smp_type` 충돌은 거래소 호출 전 fail-closed 한다.
- live broker factory는 명시 pilot/live 입력, env guard, scope evidence, credential input이 있을 때만 생성한다.
- fake private client 또는 fake fetch adapter 기반 테스트로 broker 5개 method, idempotency, rate-limit trace, 사용자 행동 문구를 검증한다.
- gated real smoke는 guard가 없으면 skip 또는 fail-closed evidence만 남긴다.

## 제외 범위

- 기본 `PAPER_NO_KEY` runtime의 실거래 profile 승격
- 자동 전략 루프에서 `UpbitLiveBroker`로 주문 제출
- M16 실계좌 reconcile worker
- M17 realized/unrealized PnL 회계
- M18 판단 이유 ledger와 설명 API
- M19 exit engine
- M20 Telegram inbound command
- M21 수동 승인 live pilot
- M22 운영자 승인 없는 자동 실거래
- 신규 의존성 추가
- 출금/입출금 자동화, 선물, 레버리지, 타인 계정, 신호 판매
- 시장가 신규 진입, `ord_type=price`, `ord_type=market`, `ord_type=best` 기본 허용

## 공식 문서 확인 기록

2026-06-02 구현 전 Upbit 공식 문서를 다시 확인했다.

- 체결 대기 주문 목록 조회: `GET /v1/orders/open`, `market`, `state` 또는 `states[]`, `page`, `limit`, `order_by`를 사용하고 `state`와 `states[]`는 동시에 쓰지 않는다. `wait`와 `watch` 상태를 조회할 수 있으며 Exchange 기본 그룹 rate limit과 `주문조회` 권한을 요구한다.
- 주문 생성: `POST /v1/orders`는 JSON body를 사용해야 하며, `identifier`는 계정 전체에서 고유하고 최대 32자다. `time_in_force=post_only`는 `smp_type`과 함께 사용할 수 없다.
- 요청 수 제한: REST 응답의 `Remaining-Req` header로 `group`, `sec`를 확인하며, Exchange 기본 그룹과 주문 생성 그룹은 별도 그룹으로 관리된다.

## sub PR 계획

| 순서 | branch | 목표 | DnD | 상태 |
| --- | --- | --- | --- | --- |
| 1 | `issue-135/01-m15-plan-contract` | M15 실행계획, runtime/security 문서, context map | `./scripts/verify docs` 통과 | merged, PR #136 |
| 2 | `issue-135/02-open-orders-client-mapper` | `/v1/orders/open` wrapper, schema, mapper, query hash/rate-limit tests | private client/mapper targeted tests 통과 | merged, PR #137 |
| 3 | `issue-135/03-live-broker-core` | `UpbitLiveBroker` core와 idempotency/fail-closed 정책 | `BrokerPort` 5개 method fake client tests 통과 | merged, PR #138 |
| 4 | `issue-135/04-live-broker-runtime-guard` | live broker factory와 기본 `PAPER_NO_KEY` live API 0회 guard | runtime/source scan tests 통과 | merged, PR #139 |
| 5 | `issue-135/05-live-broker-smoke` | fake integration, gated real smoke, artifact redaction | guard skip, fake full flow, secret scan 통과 | merged, PR #140 |
| 6 | `issue-135/06-verification-closeout` | 전체 검증, 문서 closeout, final PR 준비 | `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify` 통과 | completed in closeout |

## 검증 방법

기본 검증:

```sh
corepack pnpm typecheck
corepack pnpm test
./scripts/verify
```

문서 구조 변경:

```sh
./scripts/verify docs
```

예상 targeted tests:

```sh
corepack pnpm exec vitest run tests/unit/upbit-private-client.test.ts
corepack pnpm exec vitest run tests/unit/upbit-private-mappers.test.ts
corepack pnpm exec vitest run tests/unit/upbit-live-broker.test.ts
corepack pnpm exec vitest run tests/unit/execution-runtime.test.ts
corepack pnpm exec vitest run tests/integration/upbit-live-broker-smoke.test.ts
```

## 결정 로그

- 2026-06-02: issue #135 본문 계획을 그대로 sub PR 기준으로 사용한다.
- 2026-06-02: `listOpenOrders` 기본 상태 조회는 `wait`와 `watch`를 함께 조회하는 방향으로 시작한다. 예약 주문 대기까지 같은 open order surface에서 관측하기 위해서다.
- 2026-06-02: idempotency key는 자동 hash/truncate 없이 Upbit `identifier`로 그대로 전송한다. 길이 초과는 거래소 호출 전 fail-closed 한다.
- 2026-06-02: M15 factory와 smoke guard 이름은 `SEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE=1`로 시작하되, 실제 주문 생성은 기존 M14 `SEEMIRAI_RUN_UPBIT_ORDER_SMOKE=1`와 운영자 price/volume/identifier guard를 함께 요구한다.
- 2026-06-02: duplicate identifier 복구로 회수한 기존 주문은 M15 guarded smoke runtime의 cancel allow-list에 올리지 않는다. M16 reconcile 전에는 재시작 복구 취소를 열지 않는다.
- 2026-06-02: real live broker smoke에서 submit 성공 후 조회/검증 실패가 나면 같은 runtime broker order id로 cleanup cancel을 먼저 시도하고, submit 응답이 없으면 M14 smoke identifier cleanup으로만 내려간다.

## 검증 결과

- Sub PR 1-5는 각 PR에서 GitHub `verify`, unresolved thread 0, 현재 head 기준 Codex clean signal을 확인한 뒤 mother branch에 merge했다.
- closeout branch에서 `./scripts/verify docs`를 통과해 실행 계획 이동, 인덱스, context map 링크가 깨지지 않았음을 확인했다.
- closeout branch에서 `./scripts/verify`를 통과해 docs/hooks/github/typecheck/test 검증을 모두 확인했다.

## 남은 이슈와 후속 범위

- 실제 Upbit private/order smoke는 운영자 secret과 명시 guard가 있을 때만 실행한다.
- M16 reconcile 전까지 `UpbitLiveBroker`는 주문 submit/cancel/get/list/balance contract 검증과 gated smoke에 한정하고, 재시작 복구나 포지션 회계는 열지 않는다.
- final main PR은 생성 후 review drain까지만 수행하고 merge하지 않는다.
