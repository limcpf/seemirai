# Issue #143 M16 실계좌 상태 Reconcile 실행 계획

- 상태: active
- 작성일: 2026-06-02
- 이슈: [#143](https://github.com/limcpf/seemirai/issues/143)
- mother branch: `issue-143-mother`
- runtime mode label: `LIVE_READ_ONLY_RECONCILE`
- Guard 후보: `SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1`

## 목표

M15 `UpbitLiveBroker` contract 검증이 완료된 상태에서, 실계좌 잔고·주문·체결·포지션을 로컬 상태와 대조하고 재시작 후 상태를 복구할 수 있는 read-only reconcile runtime을 만든다. M16은 주문 side effect를 만들지 않으며, mismatch는 신규 주문 허용 신호가 아니라 durable fail-closed / manual review evidence로 수렴한다.

## 기준 문서

- [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md)
- [`../../PRD.md`](../../PRD.md)
- [`../../FEATURE_REQUIREMENTS.md`](../../FEATURE_REQUIREMENTS.md)
- [`../../product-specs/upbit-live-autonomous-trading.md`](../../product-specs/upbit-live-autonomous-trading.md)
- [`../../RUNTIME_CONFIG.md`](../../RUNTIME_CONFIG.md)
- [`../../SECURITY.md`](../../SECURITY.md)
- [`../../RELIABILITY.md`](../../RELIABILITY.md)
- [`../../design-docs/2026-05-15-m1-database-schema.md`](../../design-docs/2026-05-15-m1-database-schema.md)
- [`../completed/2026-06-02-issue-135-m15-upbit-live-broker.md`](../completed/2026-06-02-issue-135-m15-upbit-live-broker.md)

## 현재 상태

- M15 `UpbitLiveBroker`는 완료됐고 기본 `PAPER_NO_KEY` runtime은 계속 `PaperBroker`만 active broker로 조립한다.
- `UpbitLiveBroker`는 명시 pilot/live profile, env guard, scope evidence, credential input이 있을 때만 생성된다.
- 기본 runtime에서 live order API 호출 0회 invariant는 유지된다.
- M15는 `listOpenOrders`에서 `wait`와 `watch` 상태를 함께 조회한다.
- M15 duplicate identifier 복구로 회수한 기존 주문은 M16 reconcile 전까지 재시작 복구 취소를 열지 않는다.
- 아직 M16 reconcile worker, private WebSocket, append-only persistence, mismatch diff engine은 구현되지 않았다.

## 범위

- **REST snapshot bootstrap**: `GET /v1/accounts`, `GET /v1/orders/open`, `GET /v1/orders/closed`, `GET /v1/orders/:uuid`를 활용해 최초 reconcile snapshot을 만든다. REST snapshot이 reconcile의 source of truth다.
- **private WebSocket `myOrder`/`myAsset`**: snapshot 이후 변경 추적과 stale/gap evidence에만 사용한다. WebSocket이 primary source of truth가 아니다.
- **read-only reconcile worker**: 주기적으로 실계좌 상태를 로컬 상태와 대조한다.
- **포지션 복구**: 재시작 후 open order, balance, position snapshot을 복구한다.
- **mismatch fail-closed**: 거래소와 로컬 상태 충돌 시 신규 주문을 차단하고 manual review evidence를 남긴다.
- **append-only reconcile persistence**: reconcile run, balance snapshot, exchange order snapshot, mismatch evidence를 M16 전용 append-only reconcile tables에 저장한다.
- **상태 summary**: 마지막 reconcile 시각, 결과, mismatch 수, open order 수, balance snapshot 상태, WebSocket 상태, 필요한 조치를 한국어로 제공하고 내부 식별자는 `추적 정보`로 분리한다.
- **Guard**: `SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1` env가 있어야 reconcile worker가 시작된다.
- **허용 private 권한**: `자산조회`, `주문조회`만 요구한다. `주문하기` 권한은 요구하지 않는다.

## 제외 범위 (명시적 금지)

- 자동 전략 루프에서 `UpbitLiveBroker`로 주문 제출
- M17 realized/unrealized PnL 회계 (평균단가/PnL은 `계산 불가/수동 검토 필요`로 남긴다)
- M18 판단 이유 ledger와 설명 API
- M19 exit engine (자동 매도, 손절, 익절)
- M20 Telegram inbound command
- M21 수동 승인 live pilot
- M22 운영자 승인 없는 자동 실거래
- `POST /v1/orders`, `DELETE /v1/order` 호출 경로 생성
- `UpbitLiveBroker`를 자동 전략 루프와 연결
- 출금, 입출금 자동화, 선물, 레버리지, 타인 계정
- 시장가 신규 진입, `ord_type=price`, `ord_type=market`, `ord_type=best` 허용
- 신규 의존성 추가
- 자동 주문 루프, PnL 계산, Telegram inbound, autonomous live trading

## 공식 문서 확인 기준

2026-06-02 기준 다음 Upbit 공식 문서를 전제로 한다. 구현 전 변경 여부를 다시 확인한다.

- **Closed order 조회 window**: Upbit `GET /v1/orders/closed`는 최근 7일 이내 체결 완료 주문만 조회 가능하다. 이 window 밖 주문은 자동 복구하지 않고 manual review로 남긴다. ([Upbit API 문서](https://docs.upbit.com/kr/reference/order-info))
- **Private WebSocket endpoint**: `{host}:{port}/websocket/v1/private`로 `myOrder`와 `myAsset` 구독이 가능하다. 인증은 JWT 또는 query hash 방식이며, REST API key와 동일한 권한 범위를 가진다.
- **`myAsset` 최초 수신 지연**: WebSocket 연결 직후 `myAsset` snapshot이 즉시 전송되지 않을 수 있다. snapshot 대신 REST `/v1/accounts`로 bootstrap한 뒤 WebSocket을 변경 추적으로만 사용한다.
- **요청 수 제한**: REST `/v1/accounts`와 `/v1/orders` API는 Exchange 기본 그룹 rate limit을 공유한다. reconcile 주기는 이 제한을 고려해 설계한다.

## sub PR 계획

| 순서 | branch | 목표 | DnD | 의존성 |
| --- | --- | --- | --- | --- |
| 1 | `issue-143/01-m16-plan-contract` | M16 실행계획, runtime/security/reliability/product-spec 문서, context map | `./scripts/verify docs` 통과 | 없음 |
| 2 | `issue-143/02-closed-orders-client-mapper` | `GET /v1/orders/closed` wrapper, schema, mapper, query/window guard tests | `tests/unit/upbit-private-client.test.ts`, `tests/unit/upbit-private-mappers.test.ts` 통과 | 01 |
| 3 | `issue-143/03-private-websocket-client` | private WebSocket `myOrder`/`myAsset` subscription, schema, reconnect/gap contract | `tests/unit/upbit-private-websocket.test.ts` 통과 | 01 |
| 4 | `issue-143/04-reconcile-persistence` | append-only reconcile tables, repository, idempotent snapshot/evidence 저장 | migration/integration tests 통과 | 01 |
| 5 | `issue-143/05-reconcile-engine` | diff engine, mismatch taxonomy, manual review/fail-closed evidence 후보 | `tests/unit/live-reconcile.test.ts` 통과 | 02, 03, 04 |
| 6 | `issue-143/06-reconcile-runtime-status` | read-only guard, worker/service, CLI 또는 `/status` summary, source scan | runtime/status/source scan tests 통과 | 05 |
| 7 | `issue-143/07-reconcile-smoke` | fake integration, gated live read-only/WebSocket smoke, artifact redaction | guard skip/fake flow/secret scan 통과 | 06 |
| 8 | `issue-143/08-verification-closeout` | 전체 검증, 문서 closeout, final PR 준비 | `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify` 통과 | 07 |

sub PR 의존성 그래프:

```text
01 (plan contract)
 ├─ 02 (closed orders REST)
 ├─ 03 (private WebSocket)
 └─ 04 (persistence)
    └─ 05 (diff engine)
       └─ 06 (runtime/status)
          └─ 07 (smoke)
             └─ 08 (closeout)
```

Sub PR 02/03/04는 01 merge 뒤 파일 소유권이 분리되어 병렬 진행 가능하다. 05는 02/03/04의 REST mapper, WebSocket event contract, persistence contract를 입력으로 받으므로 순차 진행한다.

## DnD (Definition of Done)

각 sub PR의 merge 조건:

- `corepack pnpm typecheck` 통과
- 해당 범위 targeted tests 통과
- `./scripts/verify docs` 통과 (문서 변경 시)
- GitHub `verify` workflow 통과
- unresolved thread 0건
- Codex clean signal
- `PAPER_NO_KEY` runtime live order API 0회 source scan 유지 확인

## 검증 방법

문서 검증:

```sh
./scripts/verify docs
```

기본 검증:

```sh
corepack pnpm typecheck
corepack pnpm test
./scripts/verify
```

예상 targeted tests:

```sh
corepack pnpm exec vitest run tests/unit/upbit-private-client.test.ts
corepack pnpm exec vitest run tests/unit/upbit-private-mappers.test.ts
corepack pnpm exec vitest run tests/unit/upbit-private-websocket.test.ts
corepack pnpm exec vitest run tests/unit/reconcile-diff-engine.test.ts
corepack pnpm exec vitest run tests/unit/reconcile-worker.test.ts
corepack pnpm exec vitest run tests/unit/http-control-status.test.ts
```

## 결정 로그

| 일자 | 결정 |
| --- | --- |
| 2026-06-02 | REST snapshot이 bootstrap source of truth다. private WebSocket `myOrder`/`myAsset`은 snapshot 이후 변경 추적과 stale/gap evidence에만 사용한다. |
| 2026-06-02 | M16 read-only runtime은 `자산조회`/`주문조회` 권한만 요구하고 `주문하기` 권한을 요구하지 않는다. |
| 2026-06-02 | mismatch는 신규 주문 허용 신호가 아니라 durable fail-closed / manual review evidence로 수렴한다. |
| 2026-06-02 | closed order 조회 window(7일) 밖 주문은 자동 복구하지 않는다. |
| 2026-06-02 | 평균단가/PnL은 M17 범위이므로 근거가 없으면 `계산 불가/수동 검토 필요`로 남긴다. |
| 2026-06-02 | Guard 이름은 `SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1`로 고정한다. |
| 2026-06-02 | private WebSocket은 M16 포함으로 확정한다. sub PR 03에서 `myOrder`/`myAsset` contract를 함께 구현한다. |
| 2026-06-02 | M16 persistence는 append-only reconcile 전용 tables로 설계하고, `orders`/`positions` 직접 수정 없이 mismatch evidence만 기록한다. |

## Open Questions

- reconcile 주기 기본값을 몇 초로 할지 (REST rate limit 고려, 초안 60초)
- `myAsset` 최초 수신 타임아웃 기본값 (초안 10초, 이후 REST fallback)
- mismatch 발생 시 재시도 간격 (초안 300초, 3회 초과 시 manual review)
- WebSocket 재연결 시 기존 `myOrder`/`myAsset` snapshot을 폐기하고 REST 재bootstrap할지
- `/status` reconcile summary에 포함할 mismatch 상세 수준 (초안: count + 가장 최근 mismatch 5건)

## Guard 요약 (다음 sub PR이 반드시 지켜야 할 경계)

| Guard | 값 | 적용 시점 |
| --- | --- | --- |
| `SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1` | env 있어야 reconcile worker 시작 | sub PR 07 |
| 허용 private 권한 | `자산조회`, `주문조회`만 | sub PR 03, 04, 05 |
| 금지 권한 | `주문하기` 요구, 출금, 입출금 자동화, 선물, 레버리지 | sub PR 03 |
| `POST /v1/orders` 호출 금지 | 어떤 경로로도 live order API 호출 금지 | sub PR 07 |
| mismatch 시 fail-closed | 신규 주문 차단, manual review | sub PR 07, 08 |
| closed order window | 7일 초과 주문은 자동 복구 금지 | sub PR 03, 06 |
| PnL 계산 금지 | 평균단가/PnL은 `계산 불가/수동 검토 필요` | sub PR 06, 08 |
