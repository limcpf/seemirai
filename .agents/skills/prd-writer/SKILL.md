---
name: prd-writer
description: 사용자의 아이디어나 기존 자료를 PRD와 기능 요구사항 문서로 정리하고 acceptance criteria와 open question을 분리할 때 사용한다.
---

# prd-writer

사용자의 아이디어, 기존 README, 회의 메모, issue 초안을 `docs/PRD.md`와 `docs/FEATURE_REQUIREMENTS.md`로 정리할 때 사용한다.

## 사용 조건

- 제품 또는 기능의 목표와 MVP 범위를 정해야 한다.
- 구현 issue를 만들기 전에 acceptance criteria를 분명히 해야 한다.
- 모호한 요구사항을 open question으로 분리해야 한다.

## 읽을 문서

1. `AGENTS.md`
2. `docs/README.md`
3. `docs/PRD.md`
4. `docs/FEATURE_REQUIREMENTS.md`
5. 필요 시 `docs/product-specs/index.md`

## workflow

1. 입력을 정리한다.
   - 문제 정의
   - 대상 사용자
   - 핵심 사용자 흐름
   - MVP 범위
   - 비범위
   - 성공 기준
   - 리스크
   - open questions
2. PRD 초안을 만든다.
   - 제품 판단 기준으로 충분한 수준까지 작성한다.
   - 구현 세부사항은 기능 요구사항이나 설계 문서로 넘긴다.
3. 기능 요구사항으로 분해한다.
   - 기능별 요구사항 ID를 붙인다.
   - 각 요구사항에 acceptance criteria를 둔다.
   - 테스트 요구사항과 문서 갱신 요구사항을 분리한다.
4. 모호한 항목은 구현 범위에 넣지 않는다.
   - open question으로 남긴다.
   - 결정이 필요한 사람이나 다음 행동을 적는다.
5. 문서 라우팅을 갱신한다.
   - 새 product spec이 생기면 `docs/product-specs/index.md`와 `docs/generated/context-map.json`을 갱신한다.
6. `./scripts/verify docs`를 실행한다.

## 작성 기준

- PRD는 "왜 이 제품이 필요한가"와 "무엇을 MVP로 볼 것인가"를 답해야 한다.
- 기능 요구사항은 issue로 분해 가능한 수준이어야 한다.
- Acceptance Criteria는 체크리스트처럼 판정 가능해야 한다.
- 테스트 요구사항은 자동 테스트가 없더라도 수동 확인 절차를 적는다.
- 비범위가 없으면 scope creep이 생기므로 반드시 적는다.

## 완료 기준

- `docs/PRD.md`가 제품 판단 기준으로 충분하다.
- `docs/FEATURE_REQUIREMENTS.md`가 구현 단위로 분해 가능하다.
- 모호한 요구사항은 open question으로 남아 있다.
- 관련 인덱스와 context map이 최신이다.
- `./scripts/verify docs`가 통과한다.

## 최종 요약에 포함할 것

- 정리한 핵심 목표
- MVP 범위와 비범위
- 주요 acceptance criteria
- open question
- 실행한 검증 명령과 결과
