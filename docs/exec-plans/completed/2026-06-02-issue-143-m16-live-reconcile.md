# Issue #143 M16 실계좌 상태 Reconcile 완료 기록

- 상태: completed
- 작성일: 2026-06-02
- 완료일: 2026-06-03
- 이슈: [#143](https://github.com/limcpf/seemirai/issues/143)
- mother branch: `issue-143-mother`
- runtime mode label: `LIVE_READ_ONLY_RECONCILE`
- Guard env: `SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1`

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

## 완료 요약

M16은 REST snapshot bootstrap, private WebSocket `myOrder`/`myAsset`, append-only reconcile persistence, mismatch diff engine, read-only runtime/status, smoke 검증을 모두 완료했다. 기본 `PAPER_NO_KEY` runtime은 `PaperBroker`만 active broker로 조립하며, live order API 호출 0회 invariant는 유지된다. M16 reconcile runtime은 `자산조회`/`주문조회` 권한만 요구하고 `POST /v1/orders`와 `DELETE /v1/order`를 호출하지 않는다.

## sub PR 목록과 merge 상태

| 순서 | branch | PR | 목표 | 상태 |
| --- | --- | --- | --- | --- |
| 01 | `issue-143/01-m16-plan-contract` | [#144](https://github.com/limcpf/seemirai/pull/144) | M16 실행계획, runtime/security/reliability/product-spec 문서, context map | merged |
| 02 | `issue-143/02-closed-orders-client-mapper` | [#146](https://github.com/limcpf/seemirai/pull/146) | `GET /v1/orders/closed` wrapper, schema, mapper, query/window guard tests | merged |
| 03 | `issue-143-03-subpr` | [#145](https://github.com/limcpf/seemirai/pull/145) | private WebSocket `myOrder`/`myAsset` subscription, schema, reconnect/gap, subscription-first event buffer contract | merged |
| 04 | `issue-143-04-subpr` | [#147](https://github.com/limcpf/seemirai/pull/147) | append-only reconcile tables, repository, idempotent balance/order/position snapshot/evidence 저장 | merged |
| 05 | `issue-143-05-subpr` | [#148](https://github.com/limcpf/seemirai/pull/148) | diff engine, mismatch taxonomy, immutable identity matching, fill recovery idempotency, manual review/fail-closed evidence | merged |
| 06 | `issue-143-06-reconcile-runtime-status` | [#149](https://github.com/limcpf/seemirai/pull/149) | read-only startup guard, worker/service, CLI summary, durable kill switch/risk event 연결 | merged |
| 07 | `issue-143-07-reconcile-smoke` | [#150](https://github.com/limcpf/seemirai/pull/150) | fake integration, gated live read-only/WebSocket smoke, artifact redaction | merged |
| 08 | `issue-143-08-verification-closeout` | [#151](https://github.com/limcpf/seemirai/pull/151) | 전체 검증, 문서 closeout, final PR 준비 | merged |

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

Sub PR 02/03/04는 병렬 진행했고, 05-08은 순차 진행했다.

## 범위

- **REST snapshot bootstrap**: `GET /v1/accounts`, `GET /v1/orders/open`, `GET /v1/orders/closed`, `GET /v1/order?uuid=...` 또는 `GET /v1/order?identifier=...`를 활용한 최초 reconcile snapshot 구현 완료.
- **private WebSocket `myOrder`/`myAsset`**: 구독 성립, 이벤트 버퍼링, REST snapshot 이후 변경 추적과 연결 liveness/gap evidence. WebSocket 단절 시 REST 재bootstrap.
- **read-only reconcile worker**: 주기적 실계좌 상태 대조.
- **포지션 복구**: 재시작 후 open order, balance, position snapshot 복구.
- **mismatch fail-closed**: 거래소/로컬 상태 충돌 시 신규 주문 차단, `risk_events`와 `kill_switch_state` durable snapshot 연결.
- **append-only reconcile persistence**: reconcile run, balance snapshot, exchange order snapshot, position snapshot, mismatch evidence를 `live_reconcile_*` 전용 append-only tables에 저장.
- **로컬 lifecycle 복구 쓰기 경계**: immutable identity fingerprint 일치 시에만 기존 domain repository transaction으로 갱신. `fills` insert는 `live_reconcile_fill_recovery_keys` unique key 선점 후 허용. `positions` 갱신은 authoritative fill 기반일 때만 허용.
- **상태 summary**: 마지막 reconcile 시각, 결과, mismatch 수, open order 수, balance snapshot 상태, WebSocket 상태, 한국어 필요 조치 제공. 내부 식별자는 `추적 정보`로 분리.
- **Guard**: `SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1` env가 있어야 reconcile worker 시작.
- **운영 closeout 보강**: `finish-readiness-audit`는 PR 생성 전 마지막 readiness 감사에 쓰는 workflow로 정리했다. PR 생성 여부는 audit 판정에서 제외하고, 커밋 가능한 상태와 필수 검증 증거를 기준으로 PASS/FAIL/PARTIAL을 낸다.

## 제외 범위 (구현되지 않은 항목)

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

## 검증 결과

### 기본 검증

```sh
pnpm typecheck
```
✅ 통과 (tsc --noEmit 오류 없음)

### 테스트

```sh
pnpm exec vitest run tests/unit/
```
✅ **57 files passed, 812 passed, 1 skipped**

```sh
pnpm exec vitest run tests/integration/
```
✅ **3 passed, 9 skipped (DB 필요), 12 passed, 89 skipped**

```sh
pnpm exec vitest run tests/soak/
```
✅ **7 files passed, 79 passed**

**전체: 67 test files passed, 7 skipped / 903 passed, 90 skipped**

### Targeted M16 tests

```sh
pnpm exec vitest run tests/unit/live-reconcile.test.ts
```
✅ **99 tests passed**

```sh
pnpm exec vitest run tests/unit/live-reconcile-runtime.test.ts
```
✅ **65 tests passed**

```sh
pnpm exec vitest run tests/integration/live-reconcile.test.ts
```
✅ **8 passed, 39 skipped (기본 guard-skip)**

```sh
SEEMIRAI_RUN_DB_INTEGRATION=1 \
SEEMIRAI_DATABASE_URL=postgres://...@127.0.0.1:55432/seemirai_local \
pnpm exec vitest run tests/integration/migrations.test.ts tests/integration/live-reconcile.test.ts
```
✅ **2 files passed, 48 passed**

```sh
pnpm exec vitest run tests/integration/upbit-live-reconcile-smoke.test.ts
```
✅ **1 passed (guard-skip), 3 skipped (`SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1` 미설정)**

### 문서/구조 검증

```sh
node scripts/verify-doc-structure.mjs
```
✅ **통과 (문서 52개, 매니페스트 58개, 링크 179개)**

```sh
node scripts/verify-hooks.mjs
```
✅ **통과 (이벤트 5개, command 5개, mjs 8개)**

```sh
node scripts/verify-github.mjs
```
✅ **통과 (workflow, PR template, issue form 확인)**

### Live order API 0회 Source Scan

- `POST /v1/orders`: 모든 참조는 JSDoc 주석에서만 발견. 실제 API 호출 코드 없음.
  - `src/runtime/pilot-order-smoke/guard.ts` — 주석 (사용자 안내 문구)
  - `src/infrastructure/upbit/private-client/types.ts` — JSDoc (side effect 경계 설명)
  - `src/infrastructure/upbit/live-broker/service.ts` — JSDoc (구현 설명)
- `DELETE /v1/order`: JSDoc 주석에서만 발견. 실제 API 호출 코드 없음.
  - `src/runtime/pilot-order-smoke/guard.ts` — 주석 (사용자 안내 문구)
- reconcile 코드(`src/application/live-reconcile/`)에서 `submitOrder`, `cancelOrder` 호출 없음 확인.

✅ **기본 `PAPER_NO_KEY` runtime live order API 0회 유지 확인**
✅ **M16 read-only runtime `POST /v1/orders`, `DELETE /v1/order` 호출 0회 확인**

### Read-only Reconcile Smoke

- 기본 검증: `tests/integration/upbit-live-reconcile-smoke.test.ts` guard-skip 1개 통과, live smoke 3개 skip.
- 실제 read-only REST smoke: `SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE=1`과 `SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1` guard를 켜고 실행.
- 결과: 계정 조회, 미체결 주문 조회, 종료 주문 7일 window 조회가 secret-safe artifact 저장과 함께 통과했다. 주문 생성/취소 API는 호출하지 않았다.
- artifact 저장 위치: 저장소 밖 `/tmp/seemirai-upbit-smoke-*`.

### WebSocket Smoke

- Private WebSocket smoke: `tests/unit/upbit-private-websocket.test.ts` — unit test로 contract 검증 완료
- 실제 live WebSocket smoke: `SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE_WS_SMOKE=1` guard를 추가로 켜고 targeted 실행.
- 결과: private WebSocket 연결과 `myOrder`/`myAsset` subscription 확인이 secret-safe artifact 저장과 함께 통과했다.
- artifact 저장 위치: 저장소 밖 `/tmp/seemirai-upbit-ws-smoke-only-*`.

## 결정 로그

| 일자 | 결정 |
| --- | --- |
| 2026-06-02 | REST snapshot이 bootstrap source of truth다. private WebSocket `myOrder`/`myAsset`은 구독 성공 후 이벤트를 버퍼링하고 REST snapshot을 잡은 뒤 변경 추적과 연결 liveness/gap evidence에만 사용한다. |
| 2026-06-02 | M16 read-only runtime은 `자산조회`/`주문조회` 권한만 요구하고 `주문하기` 권한을 요구하지 않는다. |
| 2026-06-02 | mismatch는 신규 주문 허용 신호가 아니라 durable fail-closed / manual review evidence로 수렴한다. 차단 상태는 `risk_events`와 `kill_switch_state`에 연결해 주문 경로가 재시작 후에도 읽을 수 있어야 한다. |
| 2026-06-02 | closed order는 `start_time`/`end_time`으로 7일 이하 구간을 나눠 조회한다. 조회 horizon 밖이거나 identity/fingerprint를 확인할 수 없는 주문만 자동 복구하지 않는다. |
| 2026-06-02 | 평균단가/PnL은 M17 범위이므로 근거가 없으면 `계산 불가/수동 검토 필요`로 남긴다. |
| 2026-06-02 | Guard 이름은 `SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1`로 고정한다. |
| 2026-06-02 | private WebSocket은 M16 포함으로 확정한다. |
| 2026-06-02 | M16 persistence는 append-only reconcile 전용 tables에 기록한다. 주문/체결 로컬 복구는 immutable identity fingerprint가 일치한 경우에만 수행한다. `positions` 갱신은 authoritative fill 기반 평균단가를 계산할 수 있을 때만 허용한다. |
| 2026-06-03 | Sub PR 01-07이 모두 mother branch에 merge됐다. Sub PR 08(closeout)에서 전체 검증을 수행하고 문서 정리를 완료한다. |
| 2026-06-03 | closeout 검증 결과: typecheck 통과, unit tests 812 passed, integration 12 passed, soak 79 passed, verify docs/hooks/github 통과, live order API 0회 source scan 확인, 기본 reconcile smoke guard-skip 확인. |
| 2026-06-03 | 추가 closeout 검증 결과: DB integration migrations/live-reconcile 48 tests 통과, Upbit read-only REST live reconcile smoke 통과, Upbit private WebSocket smoke 통과. |
| 2026-06-04 | Sub PR 08 closeout PR #151이 mother branch에 merge된 상태를 완료 기록에 반영했다. `finish-readiness-audit`는 PR 생성 전 audit workflow로 쓰도록 정리하고, PR 미생성 자체는 finding/FAIL/PARTIAL 기준에서 제외하기로 했다. |

## Open Questions (closeout 시점)

- reconcile 주기 기본값을 몇 초로 할지 → 초안 60초, 실제 운영에서 조정 필요
- WebSocket ping/pong liveness interval과 reconnect backoff 기본값 → 구현에 포함됨, 운영에서 조정
- mismatch 발생 시 재시도 간격 → 초안 300초, 3회 초과 시 manual review. 실제 계정에서 검증 필요
- WebSocket 재연결 후 REST 재bootstrap을 항상 수행할지 → 구현은 reconnect discontinuity 시에만 수행
- subscription-first bootstrap에서 버퍼 이벤트 적용 후에도 gap을 의심해야 하는 시간/sequence 기준 → 운영 데이터로만 검증 가능
- `/status` mismatch 상세 노출 범위 → count와 한국어 필요 조치만 제공. 상세 trace는 저장소 밖 운영 리포트로만 조회

## 남은 리스크

1. **PnL 계산**: M17 범위로 남겨두었다. reconcile runtime은 평균단가/PnL을 `계산 불가/수동 검토 필요`로 남기며, balance snapshot을 PnL 근거로 사용하지 않는다.
2. **reconcile 주기와 rate limit**: REST `/v1/accounts`와 `/v1/orders` API가 Exchange 기본 그룹 rate limit을 공유하므로, 실제 운영에서 reconcile 주기 조정이 필요할 수 있다.
3. **WebSocket liveness 장시간 관측**: live smoke는 연결과 subscription을 확인했지만, 조용한 계정에서 `myOrder`/`myAsset` 데이터 메시지 부재가 장시간 지속되는 운영 패턴은 별도 관측이 필요하다.

## 후속 작업

- [x] `SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1`로 실제 live reconcile REST smoke 실행
- [x] `SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE_WS_SMOKE=1`로 실제 private WebSocket smoke 실행
- [x] `SEEMIRAI_RUN_DB_INTEGRATION=1`로 DB migration 및 persistence integration test 실행
- [ ] M17 PnL/포지션 회계 (realized/unrealized PnL, fee/spread/slippage 비용 분해)
- [ ] M18 판단 이유 ledger와 설명 API
- [ ] M19 exit engine (자동 매도, 손절, 익절)
- [ ] Upbit account 기준 reconcile 주기, rate limit 검증

## Final Main PR 사용자 Merge 가이드

closeout branch → `issue-143-mother` PR #151은 merge 완료됐다. 남은 제출 절차는 다음과 같다:

1. `issue-143-mother` → `main` PR 생성
2. GitHub `verify` workflow 통과 확인
3. PR review drain 수행
4. merge 수행

Sub PR 08 및 closeout 보강 변경사항:
- `docs/exec-plans/completed/2026-06-02-issue-143-m16-live-reconcile.md` (신규, 완료 기록)
- `docs/exec-plans/active/2026-06-02-issue-143-m16-live-reconcile.md` (삭제, completed로 이동)
- `docs/exec-plans/active/README.md` (M16 항목 제거)
- `docs/exec-plans/completed/README.md` (M16 항목 추가)
- `docs/generated/context-map.json` (M16 plan 경로 갱신)
- `docs/exec-plans/completed/2026-05-22-post-m8-milestone-plan.md` (M16 상태 completed로 갱신)
- `.agents/skills/finish-readiness-audit/SKILL.md` (PR 생성 전 readiness 감사 기준으로 정리, PR 미생성 자체를 판정에서 제외)
