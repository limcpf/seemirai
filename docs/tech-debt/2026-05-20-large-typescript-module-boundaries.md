# 큰 TypeScript 단일 파일의 책임 분리

상태: open

## 배경

현재 코드베이스에는 하나의 TypeScript 파일 안에 interface, type, class, service 구현, persistence query, 상태 전이 검증, mapper/helper가 함께 들어간 파일이 여럿 있다. 파일 길이 자체보다 더 큰 문제는 변경 이유가 다른 책임들이 같은 diff에 묶여 리뷰와 회귀 추적 비용이 커진다는 점이다.

HTTP control foundation에서는 `src/interfaces/http-control.ts`가 route, schema, auth, readiness, status provider, error helper를 모두 포함하면서 이 문제가 먼저 드러났다. 해당 파일은 이번 sub PR에서 HTTP control 범위 안에서만 분리한다. 프로젝트 전반의 유사 문제는 별도 리팩터링 부채로 관리한다.

## 대표 후보

2026-05-20 기준 큰 단일 파일 후보:

| 파일 | 대략 라인 수 | 섞인 책임 |
| --- | ---: | --- |
| `src/application/risk/risk-gate.ts` | 950 | risk rule 평가, threshold parsing, exposure projection, evaluation 생성 helper |
| `src/application/risk/risk-gate-runtime.ts` | 924 | runtime fail-closed 평가, kill switch transition, audit/event persistence input 생성, action plan 생성 |
| `src/infrastructure/paper/paper-broker.ts` | 904 | broker port 구현, balance mutation, idempotency, fill simulation 조립, orderbook 선택, decimal helper |
| `src/infrastructure/db/execution-persistence.ts` | 898 | repository, row mapper, state transition event 생성, broker evidence 검증, decimal/string 비교 helper |
| `src/application/strategies/strategy-variants.ts` | 843 | 여러 strategy factory, entry guard, feature reader, order decision 생성 |
| `src/application/backtest/backtest-orchestrator.ts` | 795 | replay state, strategy/cost/risk/execution 조립, orderbook history, clone/normalization helper |
| `src/application/execution/execution-engine.ts` | 794 | submission orchestration, safety validation, evidence 생성, mismatch comparison helper |

## 분리 기준

분리 대상은 단순히 긴 파일이 아니라 다음 조건 중 둘 이상에 해당하는 파일이다.

- public interface/type과 runtime 구현, persistence query, HTTP schema가 한 파일에 있다.
- 상태 전이 또는 fail-closed 판단과 DB side effect 조립이 같은 파일에 있다.
- 순수 계산/검증 로직이 class 내부 orchestration과 섞여 독립 테스트가 어렵다.
- 파일 하나를 고치면 unrelated test가 넓게 흔들려 리뷰 범위가 흐려진다.
- helper가 특정 구현 경계를 넘어 재사용되지만 `utils.ts` 형태로 의미 없이 모일 위험이 있다.

분리하지 않아도 되는 경우:

- 한 유스케이스의 공개 계약과 작은 구현이 함께 있고 변경 이유가 동일하다.
- private helper가 짧고 한 함수 또는 class에만 종속된다.
- 분리하면 import graph만 복잡해지고 테스트 경계가 좋아지지 않는다.

## 권장 구조

큰 단일 파일을 쪼갤 때는 flat prefix 파일을 늘리는 방식보다, 기존 public entry와 같은 이름의 디렉터리에 세부 구현을 모은다.

기본 형태:

```text
src/<boundary>/<module-name>.ts
src/<boundary>/<module-name>/
  types.ts
  <responsibility>.ts
```

기준:

- 기존 import 경로가 이미 쓰이고 있으면 `<module-name>.ts`를 public barrel 또는 얇은 orchestration entry로 유지한다.
- 세부 구현은 `<module-name>/` 아래에 두고, 내부 import는 `./<module-name>/<file>.js` 또는 폴더 내부 `./<file>.js` 형태로 제한한다.
- `module-name-auth.ts`, `module-name-status.ts`처럼 같은 디렉터리에 prefix 파일을 여러 개 늘리지 않는다.
- 새 모듈이라 public 경로 호환성이 필요 없으면 `<module-name>/index.ts`를 사용할 수 있지만, 기존 경로를 바꾸는 경우 migration 경로를 PR 본문에 명시한다.

예시:

```text
src/interfaces/http-control.ts
src/interfaces/http-control/
  auth.ts
  errors.ts
  readiness.ts
  schemas.ts
  status.ts
  types.ts

src/infrastructure/db/execution-persistence.ts
src/infrastructure/db/execution-persistence/
  evidence-validation.ts
  event-mapper.ts
  row-mapper.ts
  transition-policy.ts
  types.ts
```

세부 파일명은 다음과 같은 책임 이름을 우선 사용한다.

- `types.ts` 또는 `contracts.ts`: 외부로 노출되는 type/interface, port, error class
- `*.validation.ts`: 입력 검증, 상태 invariant, mismatch 비교
- `*.policy.ts`: 순수 판단 규칙, threshold 평가
- `*.mapper.ts`: DB row, event payload, evidence payload 변환
- `*.repository.ts`: DB side effect와 transaction 경계
- `*.service.ts`: port 조립과 유스케이스 orchestration
- `*.schemas.ts`: HTTP 또는 JSON schema

`utils.ts`처럼 책임 이름이 없는 파일로 이동하는 것은 피한다. 파일명은 해당 모듈의 변경 이유를 드러내야 한다.

## 권장 처리 순서

1. `src/infrastructure/db/execution-persistence.ts`
   - row mapper, state transition event 생성, broker evidence 검증을 분리한다.
   - DB transaction을 담당하는 repository class는 얇게 유지한다.
2. `src/infrastructure/paper/paper-broker.ts`
   - balance mutation, order state 생성, orderbook 선택, decimal helper를 분리한다.
   - broker class는 port method orchestration에 집중시킨다.
3. `src/application/risk/risk-gate-runtime.ts`
   - runtime fail-closed 평가, kill switch transition, audit/event append input mapper, action plan을 분리한다.
4. `src/application/risk/risk-gate.ts`
   - threshold parsing, exposure projection, infrastructure signal 평가를 별도 policy/mapper로 분리한다.
5. `src/application/execution/execution-engine.ts`
   - submission validation, evidence 생성, mismatch comparison을 분리한다.
6. `src/application/strategies/strategy-variants.ts`
   - strategy별 factory 파일로 분리하고 공통 entry guard/feature reader만 공유한다.
7. `src/application/backtest/backtest-orchestrator.ts`
   - replay state/history 관리와 execution 조립을 분리한다.

## 수용 기준

- 각 리팩터링 PR은 기본적으로 무동작 변경이어야 한다.
- 기존 public barrel export는 유지하거나 migration 경로를 명시한다.
- 같은 PR에서 기능 변경과 구조 분리를 섞지 않는다.
- 기존 테스트가 그대로 통과해야 하며, 분리된 순수 로직에는 필요한 경우 직접 단위 테스트를 추가한다.
- 상태 전이, fail-closed, DB side effect 경계는 한국어 JSDoc과 핵심 분기 주석으로 의도를 남긴다.

## 리스크

- 파일 이동만으로도 import 경로가 넓게 바뀌어 PR 리뷰 비용이 커질 수 있다.
- persistence와 runtime action plan은 상태 전이 의미가 강하므로, 기능 변경과 섞이면 회귀 원인을 찾기 어렵다.
- 순수 helper를 과도하게 공유하면 domain/application/infrastructure 의존 방향이 흐려질 수 있다.

따라서 이 부채는 기능 PR 중간에 끼워 넣기보다, 모듈별 무동작 리팩터링 sub PR로 순차 처리한다.
