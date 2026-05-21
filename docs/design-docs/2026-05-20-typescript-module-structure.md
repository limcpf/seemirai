# TypeScript 모듈 구조 규칙

- 상태: accepted
- 날짜: 2026-05-20
- 관련 문서:
  - [`../../AGENTS.md`](../../AGENTS.md)
  - [`../DESIGN.md`](../DESIGN.md)
  - [`../tech-debt/2026-05-20-large-typescript-module-boundaries.md`](../tech-debt/2026-05-20-large-typescript-module-boundaries.md)

## 배경

HTTP control foundation에서 `src/interfaces/http-control.ts` 하나에 route, schema, auth, readiness, status provider, error helper가 함께 모였다. 파일 하나에 interface, type, class, service, persistence query, 상태 전이 검증, mapper/helper가 섞이면 변경 이유가 다른 코드가 같은 diff에 묶이고, 리뷰와 회귀 추적 비용이 커진다.

단순히 파일을 여러 개로 나누는 것만으로는 충분하지 않다. `http-control-auth.ts`, `http-control-status.ts`처럼 같은 폴더에 prefix 파일을 늘리면 모듈의 소속과 public import 경계가 흐려진다. 저장소 전체에서 같은 기준을 쓰기 위해 TypeScript 모듈 구조 규칙을 공통 지침으로 승격한다.

## 결정

TypeScript 모듈을 새로 만들거나 기존 단일 파일을 분리할 때는 public entry와 같은 이름의 디렉터리에 세부 구현을 둔다.

기본 형태:

```text
src/<boundary>/<module-name>.ts
src/<boundary>/<module-name>/
  types.ts
  <responsibility>.ts
```

기존 public import 경로가 있으면 `src/<boundary>/<module-name>.ts`를 public barrel 또는 얇은 orchestration entry로 유지한다. 세부 구현은 `src/<boundary>/<module-name>/` 아래에 두고, 파일명은 변경 이유가 드러나는 책임 이름을 사용한다.

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
```

새 모듈이라 기존 import 호환성이 필요 없으면 `<module-name>/index.ts`를 public entry로 사용할 수 있다. 다만 이미 배포되었거나 여러 곳에서 import하는 경로를 바꾸는 경우에는 기존 entry 파일을 남기고 migration 경로를 PR 본문에 명시한다.

## 파일명 기준

- `types.ts` 또는 `contracts.ts`: 외부로 노출되는 type/interface, port, error class
- `*.schemas.ts`: HTTP, JSON, config schema
- `*.validation.ts`: 입력 검증, 상태 invariant, mismatch 비교
- `*.policy.ts`: 순수 판단 규칙, threshold 평가, fail-closed 판단
- `*.mapper.ts`: DB row, event payload, evidence payload 변환
- `*.repository.ts`: DB side effect와 transaction 경계
- `*.service.ts`: port 조립과 유스케이스 orchestration

`utils.ts`, `helpers.ts`처럼 책임이 드러나지 않는 공유 파일은 기본적으로 만들지 않는다. 여러 책임이 같은 파일명 후보로 모이면 더 작은 책임 이름으로 나누거나, 실제로 같은 변경 이유를 갖는지 먼저 확인한다.

## 금지와 예외

금지:

- `module-name-auth.ts`, `module-name-status.ts`, `module-name-types.ts`처럼 같은 디렉터리에 prefix 파일을 나열하는 방식
- 기능 변경 PR에 광범위한 구조 분리를 끼워 넣는 방식
- domain/application/infrastructure 의존 방향을 흐리게 만드는 공용 helper 추출

예외:

- 한 유스케이스의 공개 계약과 작은 구현이 함께 있고 변경 이유가 동일한 파일
- 특정 함수 또는 class에만 종속된 짧은 private helper
- 분리해도 테스트 경계와 리뷰 경계가 좋아지지 않고 import graph만 복잡해지는 경우

## 적용 기준

다음 조건 중 둘 이상에 해당하면 같은 이름의 디렉터리 구조로 분리한다.

- public interface/type과 runtime 구현, persistence query, HTTP schema가 한 파일에 있다.
- 상태 전이 또는 fail-closed 판단과 DB side effect 조립이 같은 파일에 있다.
- 순수 계산/검증 로직이 class 내부 orchestration과 섞여 독립 테스트가 어렵다.
- 파일 하나를 고치면 unrelated test가 넓게 흔들려 리뷰 범위가 흐려진다.
- helper가 특정 구현 경계를 넘어 재사용되지만 책임 없는 `utils.ts`로 모일 위험이 있다.

## PR 기준

- 구조 분리 PR은 기본적으로 무동작 변경이어야 한다.
- 기존 public entry export는 유지하거나 migration 경로를 명시한다.
- 새 기능을 추가할 때도 처음부터 이 구조를 적용하되, 불필요한 선행 리팩터링은 별도 PR로 분리한다.
- 비즈니스/시스템/프로그램 흐름을 담는 TypeScript 타입·인터페이스·클래스·서비스·함수는 한국어 JSDoc으로 책임, 호출 경계, 입력/출력 의미, 유지해야 하는 invariant, 외부 side effect 여부를 설명한다.
- 상태 전이, fail-closed, 인증/권한, DB write, audit/risk evidence, 외부 API·job·notification 경계에는 한국어 한 줄 주석으로 해당 분기에서 차단·기록·지연·커밋하는 이유를 남긴다.
- 주석이 함수명이나 타입명을 자연어로 반복하는 수준이면 충분하지 않다. 리뷰어가 운영 리스크와 변경 경계를 이해할 수 있어야 PR 완료로 본다.
- 대규모 후보와 처리 순서는 [`../tech-debt/2026-05-20-large-typescript-module-boundaries.md`](../tech-debt/2026-05-20-large-typescript-module-boundaries.md)에서 추적한다.
