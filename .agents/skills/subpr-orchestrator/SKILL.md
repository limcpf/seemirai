---
name: subpr-orchestrator
description: GitHub issue 하나를 mother branch에서 운영하고, 변경량이 커서 리뷰가 불편할 때만 여러 sub PR/worktree로 나눌 때 사용한다.
---

# subpr-orchestrator

GitHub issue 하나를 mother branch에서 실제 작업 가능한 흐름으로 운영하고, 변경량이 커서 리뷰가 불편할 때만 여러 sub PR로 나눌 때 사용한다.

## 사용 조건

- issue가 하나의 PR로 리뷰하기 클 가능성이 있다.
- 변경량을 리뷰 가능한 PR 단위로 나눌지 판단해야 한다.
- 단일 PR로 충분하면 sub PR 없이 mother branch에서 직접 작업한다.
- 병렬 가능한 작업을 Codex sub-agent와 worktree로 나눌 필요가 있다.
- 순차 의존성이 있는 PR을 mother branch 기준으로 안전하게 이어가야 한다.

## 핵심 원칙

- 목적은 사용자가 PR 변경사항을 편하게 리뷰할 수 있게 PR 크기를 조절하는 것이다.
- sub PR은 필수가 아니라 수단이다. 2개 이상으로 나눌 실익이 없으면 만들지 않는다.
- merge는 사용자의 책임이다. 이 skill 수행 중 Codex는 `git merge`, `gh pr merge`, branch delete 같은 merge/정리 명령을 실행하지 않는다.
- 선행 PR이 필요한 순차 작업은 사용자가 merge를 완료했다고 확인한 뒤 mother branch를 최신화하고 이어간다.

## 읽을 문서

1. `AGENTS.md`
2. `docs/README.md`
3. issue 본문과 댓글
4. `docs/PRD.md`
5. `docs/FEATURE_REQUIREMENTS.md`
6. `docs/PLANS.md`
7. 관련 설계 문서와 product spec

## workflow

1. issue와 문서를 읽는다.
   - 목적
   - acceptance criteria
   - DnD
   - 테스트 요구사항
   - 문서 갱신 요구사항
2. 현재 Git 상태를 확인한다.
   - `git status --short --branch`
   - `git remote -v`
   - `gh repo view`
3. mother branch를 만든다.
   - 기준 branch를 최신화한다.
   - 예: `git switch main && git pull --ff-only`
   - 예: `git switch -c issue-12-mother`
   - 예: `git push -u origin issue-12-mother`
4. 작업 분할 방식을 결정한다.
   - 단일 PR로 충분하면 "single PR mode"로 진행한다.
   - 리뷰가 어려울 정도로 변경량이 크면 "sub PR mode"로 진행한다.
   - 판단 근거를 변경 파일 범위, 예상 diff 크기, 리뷰 위험도 기준으로 기록한다.
5. sub PR mode일 때 sub PR 계획을 확정한다.
   - 각 sub PR의 목표
   - 제외 범위
   - 파일 소유권
   - DnD
   - 검증 명령
   - 의존성
6. sub PR mode일 때 병렬 가능성을 판단한다.
   - 서로 다른 파일 또는 모듈을 수정하면 병렬 가능하다.
   - 공통 schema, 핵심 타입, 상태 전이, 문서 인덱스, lockfile을 동시에 만지면 순차 진행한다.
   - 한 PR의 출력이 다른 PR의 입력이면 순차 진행한다.
7. single PR mode일 때 mother branch에서 직접 구현한다.
   - 별도 sub branch나 worktree를 만들지 않는다.
   - 관련 검증을 실행한다.
   - commit/push 후 mother branch에서 PR을 생성한다.
   - 필요한 경우 해당 PR에 `$pr-review-drain`을 실행한다.
8. sub PR mode일 때 worktree를 만든다.
   - 예: `git worktree add ../issue-12-01-foundation -b issue-12/01-foundation issue-12-mother`
9. 병렬 sub PR은 Codex sub-agent에 위임한다.
   - worker에게 파일 소유권을 명시한다.
   - 다른 agent가 있음을 알리고, 다른 변경을 되돌리지 말라고 지시한다.
   - 각 worker는 변경 파일과 검증 결과를 한국어로 요약해야 한다.
10. 로컬 통합과 검증을 수행한다.
   - 각 worktree에서 검증 명령 실행
   - commit
   - push
   - PR 생성
11. 각 PR에 `$pr-review-drain`을 실행한다.
12. 순차 PR은 사용자가 선행 PR을 merge한 뒤 mother branch를 최신화하고 다음 branch/worktree를 만든다.

## sub-agent 지시 템플릿

```text
너는 issue #<number>의 Sub PR <n>을 담당한다.
소유 파일 범위는 <paths> 이다.
다른 agent가 <other paths>를 수정할 수 있으므로 해당 파일은 건드리지 않는다.
Acceptance Criteria는 아래와 같다.
작업 후 변경 파일과 검증 결과를 한국어로 요약해라.
```

## 완료 기준

- mother branch가 존재한다.
- single PR mode 또는 sub PR mode 판단 근거가 기록됐다.
- single PR mode라면 mother branch PR URL과 검증 결과가 기록됐다.
- sub PR mode라면 sub PR 계획에 목표, 제외 범위, DnD, 검증 명령이 있다.
- sub PR mode라면 병렬 가능성과 순차 의존성이 표시됐다.
- sub PR mode라면 각 sub PR의 branch/worktree/PR URL이 기록됐다.
- 생성한 각 PR은 관련 검증을 통과했다.
- 각 PR은 review drain clean 조건을 충족했거나 남은 리스크가 명시됐다.
- Codex가 merge를 수행하지 않았고, 필요한 merge는 사용자에게 넘겼다.

## 최종 요약에 포함할 것

- issue URL
- mother branch
- 작업 모드 판단: single PR mode 또는 sub PR mode
- 생성한 PR URL
- sub PR mode일 때 sub PR 목록과 PR URL
- 병렬/순차 실행 결과
- 검증 명령과 결과
- review drain 상태
- 사용자가 직접 merge해야 하는 PR
- 남은 리스크
