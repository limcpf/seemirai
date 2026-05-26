# Seemirai 온보딩

이 문서는 처음 합류한 개발자가 Seemirai의 아키텍처와 프로그램 흐름을 빠르게 잡기 위한 안내서다. 최종 설계 기준은 [`../ARCHITECTURE.md`](../ARCHITECTURE.md), 런타임 결정은 [`design-docs/2026-05-13-mvp-runtime-architecture.md`](./design-docs/2026-05-13-mvp-runtime-architecture.md), 로컬 실행과 검증은 [`DEVELOPMENT.md`](./DEVELOPMENT.md)를 따른다.

## 한 문장 모델

Seemirai는 Upbit KRW 현물 시장에서 실거래 주문 없이 paper trading으로 전략, 비용, 리스크, 실행 품질, 감사 로그를 검증하는 단일 프로세스 모듈러 모놀리스다. 시스템의 중심은 예측 모델이 아니라 비용 차감 후에도 기대값이 남고 리스크 게이트를 통과한 주문 후보만 실행 경계로 넘기는 흐름이다.

## 먼저 읽을 순서

1. [`../ARCHITECTURE.md`](../ARCHITECTURE.md): 제품 범위, 핵심 경계, 데이터 흐름, 의존성 방향
2. [`RUNTIME_CONFIG.md`](./RUNTIME_CONFIG.md): `config/paper.json`의 안전 invariant와 runtime 활성화 방식
3. [`design-docs/2026-05-13-mvp-runtime-architecture.md`](./design-docs/2026-05-13-mvp-runtime-architecture.md): worker, DB, queue, broker, 상태 전이 결정
4. [`design-docs/2026-05-20-typescript-module-structure.md`](./design-docs/2026-05-20-typescript-module-structure.md): TypeScript 파일과 폴더 배치 규칙
5. [`DEVELOPMENT.md`](./DEVELOPMENT.md): 로컬 설치, 테스트, 검증 명령

## 코드 경계

```text
src/
  domain/          외부 시스템을 모르는 순수 도메인 타입, 비용, 주문, 상태 기계
  application/     전략, 리스크, 실행, 알림, 보고서 유스케이스와 port
  infrastructure/  PostgreSQL, Upbit, Telegram, PaperBroker 같은 외부 구현체
  interfaces/      HTTP control API 같은 외부 진입점
  runtime/         config와 registry로 worker, repository, adapter를 조립
  shared/          Decimal, logger처럼 경계가 분명한 공통 기반
```

의존성 방향은 `domain -> application -> infrastructure -> runtime/interfaces`로 읽으면 된다. `domain`은 외부 시스템을 몰라야 하고, `application`은 구체 구현보다 port를 기준으로 판단해야 한다. `infrastructure`는 외부 API와 DB 구현체를 담고, `runtime`은 이 구현체들을 config와 registry로 연결한다.

## 프로그램 흐름

```text
config/paper.json
  -> runtime config 검증
  -> registry에서 exchange, strategy, rule 활성화
  -> market data 수집 또는 fixture event source 준비
  -> 원천/정규화 market event 저장
  -> feature 계산
  -> strategy decision 생성
  -> cost model과 rule 평가
  -> risk gate와 runtime fail-closed 평가
  -> execution engine이 BrokerPort 호출
  -> PaperBroker가 가상 주문/체결 생성
  -> execution persistence가 주문, 상태 전이, evidence 저장
  -> audit, risk event, Telegram alert, daily report 후보 생성
```

MVP 기본 profile은 `PAPER_TRADING`이고 `paper_no_key=true`여야 한다. 실거래 주문, 출금, 거래소 간 차익거래, 선물, 레버리지, 신규 진입 시장가 주문은 기본적으로 차단된다. 이 값들은 `src/runtime/config.ts`와 `src/runtime/risk-config.ts` 계층에서 fail-fast로 검증한다.

## 주문 후보 lifecycle

전략은 주문을 직접 제출하지 않는다. 전략은 `StrategyDecision` 또는 주문 의도를 만들고, 비용과 리스크를 통과한 후보만 실행 계층으로 넘어간다.

```text
Strategy
  -> CostModel
  -> RiskGate
  -> ExecutionEngine
  -> BrokerPort
  -> PaperBroker
  -> ExecutionPersistence
```

주문 상태는 append-only event log와 durable snapshot을 함께 사용한다. `HARD_STOP`, stale market data, DB write failure, duplicate idempotency key, accounting mismatch 같은 조건은 신규 주문 차단 또는 수동 검토 상태로 이어진다. 상태 전이를 바꿀 때는 [`RELIABILITY.md`](./RELIABILITY.md)와 DB schema 문서를 같이 확인해야 한다.

## 주요 수정 지점

| 작업 | 먼저 볼 경로 |
| --- | --- |
| 전략 후보 생성 또는 threshold | `src/application/strategies/`, `src/application/features/`, `config/paper.json` |
| 비용 계산 | `src/domain/cost.ts`, `src/application/rules/` |
| 리스크 차단 | `src/application/risk/`, `src/runtime/risk-config.ts` |
| 주문 제출 흐름 | `src/application/execution/`, `src/application/ports/broker-port.ts` |
| paper 체결 시뮬레이션 | `src/infrastructure/paper/`, `src/application/execution/paper-fill-simulator.ts` |
| 주문/체결 persistence | `src/infrastructure/db/execution-persistence.ts`, `src/infrastructure/db/execution-persistence/` |
| Upbit public data | `src/infrastructure/upbit/`, `src/application/ports/market-data-port.ts` |
| Telegram outbound alert | `src/application/alerts/`, `src/infrastructure/telegram/`, `src/runtime/notification-runtime.ts` |
| HTTP control | `src/interfaces/http-control.ts`, `src/interfaces/http-control/` |
| backtest | `src/application/backtest/`, `tests/fixtures/backtest/` |
| 운영 보고서 | `src/application/daily-report/`, `src/infrastructure/db/daily-report/` |

## 모듈 구조 관례

기존 public import 경로가 있는 TypeScript 모듈은 entry 파일을 유지하고, 세부 구현을 같은 이름의 디렉터리에 둔다.

```text
src/application/risk/risk-gate.ts
src/application/risk/risk-gate/
  types.ts
  threshold-parser.ts
  result-policy.ts
```

`utils.ts`나 `helpers.ts`처럼 책임이 드러나지 않는 공유 파일은 만들지 않는다. 파일을 나눌 때는 변경 이유가 분명한 이름을 쓰고, 기능 변경과 구조 분리를 같은 PR에 섞지 않는다.

## 테스트와 검증

기본 로컬 검증은 다음 순서로 충분하다.

```sh
corepack pnpm install --frozen-lockfile
./scripts/verify
```

좁은 변경은 관련 unit test를 먼저 실행하고 마지막에 전체 검증을 통과시킨다. 문서 구조를 바꾸면 `./scripts/verify docs`, hook을 바꾸면 `./scripts/verify hooks`, GitHub template 또는 workflow를 바꾸면 `./scripts/verify github`를 포함해야 한다.

DB integration test는 기본 검증에서 skip된다. 로컬 PostgreSQL + TimescaleDB를 띄운 뒤 명시적으로 실행한다.

```sh
SEEMIRAI_RUN_DB_INTEGRATION=1 corepack pnpm exec vitest run tests/integration
```

## 안전하게 변경하는 기준

- 사용자에게 직접 보이는 문구는 한국어 행동 언어를 먼저 쓴다.
- 내부 enum, reason code, fingerprint, correlation id는 `추적 정보`나 detail 영역에 분리한다.
- business flow, state transition, DB write, audit/risk evidence, 외부 API 경계에는 한국어 JSDoc과 핵심 분기 주석을 남긴다.
- 신규 dependency는 사용자가 명시하지 않으면 추가하지 않는다.
- 실거래 주문 API가 호출되는 경로를 만들지 않는다.
- LLM은 리스크 보조와 요약에만 쓰며 매매 신호나 주문 허용 판단을 직접 만들 수 없다.

## 흐름을 따라 디버깅하는 방법

1. 후보가 만들어졌는지 `strategy`와 `feature` 계층을 본다.
2. 후보가 폐기됐으면 cost/rule/risk evidence를 확인한다.
3. 후보가 승인됐는데 주문이 없으면 `ExecutionEngine` validation과 idempotency evidence를 본다.
4. paper 주문 상태가 이상하면 `PaperBroker` 결과와 `execution-persistence` state event를 같이 본다.
5. 운영자 알림이 누락됐으면 alert fingerprint, cooldown, notification retry job을 확인한다.
6. daily report가 맞지 않으면 report aggregation과 DB snapshot 기준 시각을 확인한다.

## PR 작성 전 체크

- public entry import 경로가 유지됐는가?
- 변경한 책임과 테스트 범위가 PR 본문에 드러나는가?
- 관련 문서 라우팅 또는 context map 갱신이 필요한가?
- `./scripts/verify` 또는 더 좁은 검증 명령의 통과 결과가 있는가?
- review drain이 필요한 PR이면 현재 head 기준 Codex clean signal과 unresolved thread 0개를 확인했는가?
