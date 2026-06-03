---
name: reasonix-codex-review
description: Reasonix, DeepSeek, Aider 같은 구현 에이전트가 작업한 뒤 현재 워크트리의 staged, unstaged, untracked 변경을 Codex가 한국어로 코드 리뷰할 때 사용한다. 버그, 회귀 위험, 요구사항 누락, 과도한 변경, 테스트 누락, 보안/secret 노출 위험을 우선 점검하고 코드는 수정하지 않는 리뷰 전용 workflow다.
---

# reasonix-codex-review

Reasonix 구현 이후 현재 워크트리 변경분을 Codex가 reviewer로만 검토하는 workflow다. 코드를 수정하지 말고, finding과 남은 리스크를 한국어로 보고한다.

## 리뷰 범위

리뷰 대상은 현재 워크트리의 모든 변경이다.

- staged 변경
- unstaged 변경
- untracked 파일과 디렉터리
- 삭제, rename, generated artifact, 문서 변경
- `.runs/`, `.env`, secret 후보처럼 커밋되면 안 되는 산출물

리뷰 중 코드를 수정하지 않는다. formatting, lint fix, test fix, cleanup도 수행하지 않는다. 필요하면 finding 또는 남은 리스크로만 적는다.

## 읽을 문서

1. `AGENTS.md`
2. `ARCHITECTURE.md`
3. 작업과 관련된 `docs/PRD.md`, `docs/FEATURE_REQUIREMENTS.md`, `docs/PLANS.md`, `docs/DEVELOPMENT.md`
4. 관련 handoff, issue, PR 본문, acceptance criteria가 있으면 함께 읽는다.
5. 구현 에이전트 transcript나 report가 있으면 diff와 대조하되, transcript만 믿고 코드 검토를 생략하지 않는다.

## workflow

1. 현재 상태를 수집한다.
   - `git status --short`
   - `git diff --stat`
   - `git diff`
   - `git diff --cached --stat`
   - `git diff --cached`
   - untracked 파일은 `git status --short`로 식별하고, 필요한 경우 파일 내용을 읽는다.
2. 변경 의도를 파악한다.
   - 사용자의 요청, issue, handoff, acceptance criteria와 실제 변경을 대조한다.
   - Reasonix가 허용 범위를 넘어선 파일을 건드렸는지 확인한다.
3. 우선순위대로 finding 후보를 찾는다.
   - 버그
   - 회귀 위험
   - 요구사항 누락
   - 과도한 변경 또는 scope creep
   - 테스트 누락 또는 검증 불충분
   - 보안/secret 노출 위험
4. 추가로 아래 항목을 점검한다.
   - CLI 사용자-facing 메시지, exit code, artifact 경로가 contract와 맞는지
   - staged와 unstaged가 서로 충돌하거나 한쪽만 보면 오판할 변경이 있는지
   - untracked 파일이 빌드 산출물, 로그, `.runs/`, `.env`, token 후보인지
   - generated 문서가 직접 편집됐거나 원천 문서와 불일치하는지
   - 새 의존성이 명시 승인 없이 추가됐는지
   - 테스트가 변경 위험에 비례하는지
5. 검증 명령이 이미 실행된 evidence가 있으면 신뢰성을 판단한다.
   - 필요하면 리뷰 근거 확보를 위해 read-only 성격의 명령과 테스트 명령을 실행할 수 있다.
   - 테스트 실행이 파일을 수정할 가능성이 있으면 실행 전 신중히 판단하고, 수정된 파일이 생기면 리뷰 산출물이 아니라 side effect로 명확히 보고한다.
   - 명령을 실행하지 못했거나 실행하지 않았다면 최종 응답의 남은 리스크에 적는다.
6. finding을 작성한다.
   - findings를 먼저, 심각도 높은 순서로 정리한다.
   - 각 finding은 파일 경로와 라인 번호를 포함한다.
   - 영향과 재현/근거를 짧게 설명한다.
   - 수정 방향은 제안할 수 있지만 코드는 수정하지 않는다.
7. 명시적 문제가 없으면 `명시적 코드 품질 이슈 없음`이라고 말한다.

## severity 기준

- `P0`: secret 노출, 데이터 손실, 실행 불능, 보안상 즉시 차단해야 하는 문제
- `P1`: 주요 기능 실패, contract 위반, 명확한 회귀, merge 전 반드시 수정해야 하는 문제
- `P2`: 특정 조건에서 실패하거나 요구사항/검증이 빠져 후속 회귀 가능성이 큰 문제
- `P3`: 낮은 위험의 누락, 관찰 가능한 유지보수 리스크

스타일 취향, 선호하는 추상화, naming 취향만으로는 finding을 만들지 않는다. 실제 버그, 회귀, 요구사항, 검증, 보안 위험과 연결될 때만 지적한다.

## 출력 형식

한국어로 작성한다. findings가 있으면 아래 형식을 따른다.

```text
Findings
- [P1] <문제 요약> - path/to/file.ts:123
  근거: <diff 또는 코드 근거>
  영향: <사용자/동작/검증 영향>
  제안: <수정 방향, 코드 수정은 하지 않음>

Open Questions / Assumptions
- <필요할 때만>

검증
- 실행: `<command>` -> <결과>
- 미실행: <이유>

남은 리스크
- <필요할 때만>
```

문제가 없으면 첫 줄에 `명시적 코드 품질 이슈 없음`을 포함하고, 실행한 검증과 남은 리스크만 짧게 적는다.

## 금지 사항

- 리뷰 중 파일을 수정하지 않는다.
- finding 없이 style preference만 나열하지 않는다.
- staged diff만 보고 unstaged/untracked를 생략하지 않는다.
- secret 후보 문자열을 최종 응답에 원문으로 길게 인용하지 않는다.
- 사용자가 요청하지 않은 commit, push, PR comment, thread resolve를 수행하지 않는다.
