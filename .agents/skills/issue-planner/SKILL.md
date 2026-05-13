---
name: issue-planner
description: PRD, 기능 요구사항, 개발 일정 문서를 읽고 구현 가능한 GitHub issue 초안 또는 issue 생성까지 수행할 때 사용한다.
---

# issue-planner

PRD, 기능 요구사항, 개발 일정 문서를 읽고 GitHub issue를 작성하거나 생성할 때 사용한다.

## 사용 조건

- 다음에 구현할 작업을 issue로 만들고 싶다.
- issue가 너무 커서 sub PR 계획과 병렬 가능성 판단이 필요하다.
- Codex가 구현하기 전에 목적, 범위, DnD, 검증 명령을 issue에 고정해야 한다.

## 읽을 문서

1. `AGENTS.md`
2. `docs/README.md`
3. `docs/PRD.md`
4. `docs/FEATURE_REQUIREMENTS.md`
5. `docs/PLANS.md`
6. `docs/exec-plans/active/README.md`
7. 필요 시 관련 `docs/design-docs/*`, `docs/product-specs/*`

## workflow

1. 현재 제품/개발 상태를 확인한다.
   - PRD의 MVP 범위
   - 기능 요구사항의 미완료 항목
   - active plan 또는 tech-debt tracker
   - 기존 open issue 중 중복 여부
2. 다음 issue 후보를 고른다.
   - 사용자의 우선순위가 있으면 따른다.
   - 없으면 foundation, 위험도, dependency 순서로 판단한다.
3. issue 초안을 작성한다.
   - 목적
   - 배경
   - 구현 범위
   - 제외 범위
   - Acceptance Criteria
   - Definition of Done
   - 테스트 요구사항
   - 문서 갱신 요구사항
   - 예상 sub PR 분할
   - 병렬 가능성 판단
   - 완료 후 검증 명령
4. sub PR 계획을 포함한다.
   - foundation
   - persistence
   - runtime
   - integration
   - verification
   - 해당하지 않는 항목은 제외한다.
5. 생성 전 초안을 사용자에게 보여준다.
6. 승인 후 `gh issue create`로 생성한다.
   - repository와 label을 확인한다.
   - issue URL을 최종 요약에 포함한다.

## 좋은 issue 기준

- 하나의 목적을 가진다.
- acceptance criteria가 구현과 리뷰의 기준이 된다.
- 제외 범위가 분명하다.
- 테스트와 문서 갱신 요구가 있다.
- 예상 sub PR이 리뷰 가능한 의미 단위다.
- 병렬 가능한 작업과 순차 의존성이 구분되어 있다.

## 완료 기준

- issue 초안이 구현 가능한 수준이다.
- 사용자가 승인한 경우 GitHub issue가 생성됐다.
- issue 본문에 DnD와 검증 명령이 포함됐다.
- 생성한 issue URL이 기록됐다.

## 최종 요약에 포함할 것

- 생성한 issue URL 또는 초안 위치
- 핵심 acceptance criteria
- 예상 sub PR 계획
- 병렬/순차 판단
- 남은 open question
