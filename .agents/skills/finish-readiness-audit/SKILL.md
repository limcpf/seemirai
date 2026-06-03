---
name: finish-readiness-audit
description: 개발 마무리, PR 준비, milestone closeout, issue 완료 전 현재 Git 브랜치와 staged/unstaged/untracked 워크트리가 목표, acceptance criteria, Definition of Done 기준으로 넘겨도 되는 상태인지 한국어로 감사할 때 사용한다. 파일을 수정하지 않고 PASS/FAIL/PARTIAL 판정, blocking/non-blocking finding, 검증 결과, 커밋/PR 준비 상태를 보고하는 리뷰 전용 workflow다.
---

# finish-readiness-audit

개발 마무리 시점에 현재 브랜치와 워크트리가 목표 기준으로 완료 가능한지 감사하는 workflow다. 어떤 파일도 수정하지 말고, 증거 수집과 판정만 수행한다.

## 감사 대상

- 현재 Git 브랜치와 upstream/base 관계
- 현재 워크트리의 staged, unstaged, untracked 변경
- 사용자가 지정한 목표, milestone, issue, PRD, handoff, Definition of Done
- 실행된 테스트, lint, build, 문서 검증, hook/GitHub 검증 결과
- `.runs/`, `.env`, local log 같은 커밋 제외 대상과 secret 노출 위험

로컬 산출물은 검증 증거로만 사용한다. `.runs/`나 `.env`를 커밋 대상 변경으로 취급하지 않는다.

## 금지 사항

- 파일을 수정하지 않는다.
- formatting, lint fix, cleanup, commit, push, PR comment를 수행하지 않는다.
- secret 원문을 최종 응답에 인용하지 않는다.
- staged diff만 보고 unstaged/untracked를 생략하지 않는다.
- 검증 실패를 숨기거나 "대체로 괜찮음"으로 완화하지 않는다.

## 읽을 문서

1. `AGENTS.md`
2. `docs/README.md`
3. `docs/generated/context-map.json`
4. 목표와 관련된 `docs/PRD.md`, `docs/FEATURE_REQUIREMENTS.md`, `docs/PLANS.md`, `docs/DEVELOPMENT.md`
5. 관련 issue, handoff, contract JSON, active/completed exec plan, review checklist
6. PR이 있으면 PR 본문과 checks, unresolved thread

## workflow

1. 상태를 수집한다.
   - `git status --short --branch`
   - `git branch --show-current`
   - `git rev-parse --show-toplevel`
   - 필요 시 `git log --oneline --decorate -n 20`
2. 기준 브랜치를 추론한다.
   - 사용자가 지정한 base가 있으면 우선한다.
   - PR이 있으면 PR base를 사용한다.
   - issue sub PR worktree면 관련 mother branch를 우선한다.
   - 추론 실패 시 `origin/main` 또는 현재 branch upstream을 후보로 두고, 불확실성을 기록한다.
3. diff를 확인한다.
   - 기준 브랜치를 알면 `git diff --stat <base>...HEAD`와 필요한 committed diff를 확인한다.
   - 커밋 전 변경이 있으면 `git diff --stat`, `git diff`, `git diff --cached --stat`, `git diff --cached`를 확인한다.
   - untracked 파일은 `git status --short`로 식별하고 필요한 파일만 읽는다.
4. 목표와 완료 기준을 확정한다.
   - 사용자 요청, issue, milestone, handoff, contract, PRD, feature requirements를 대조한다.
   - 목표가 불명확하면 감사 판정은 `PARTIAL` 또는 `FAIL`로 두고 open question을 남긴다.
5. 판정 기준별로 감사한다.
   - 목표 또는 issue 요구사항 충족 여부
   - acceptance criteria와 Definition of Done 충족 여부
   - 비목표 또는 다음 milestone 범위 침범 여부
   - 커밋 제외 대상, secret, local config, generated artifact 노출 여부
   - 테스트, lint, build, 문서 검증, hook/GitHub 검증 통과 여부
   - 변경 범위와 리뷰 가능성
   - branch/upstream/base 관계와 PR 준비 상태
6. 검증 명령을 실행한다.
   - 명확한 검증 명령이 있으면 실행하고 결과를 기록한다.
   - 문서/skill/hook/GitHub template/project 검증 설정/lockfile 변경이 있으면 `./scripts/verify`를 실행한다.
   - milestone contract가 있으면 관련 hygiene/self-check 명령을 실행한다. base 추론이 불확실하면 명시 base 사용 여부를 기록한다.
   - 외부 API key나 네트워크가 필요한 smoke는 secret을 출력하지 않고, 실행 여부와 결과만 기록한다.
7. 최종 판정을 낸다.
   - `PASS`: blocking finding 없음, 필수 검증 통과, 목표/DoD 충족, 커밋 제외 대상 없음.
   - `PARTIAL`: 핵심 구현은 대체로 충족하지만 검증 일부 미실행, base 불확실, non-blocking 리스크가 남음.
   - `FAIL`: blocking finding, 필수 검증 실패, 목표/DoD 미충족, secret/local artifact 커밋 위험, 비목표 침범.

## 추가 감사 포인트

- branch가 올바른 worktree/issue/milestone에 있는지 확인한다.
- branch가 base보다 behind인지, force-push나 rebase 필요성이 있는지 확인한다.
- staged와 unstaged가 서로 다른 의도를 섞고 있지 않은지 확인한다.
- untracked 파일이 실제 커밋 대상인지, 누락된 구현 파일인지, 로컬 산출물인지 분류한다.
- generated 문서를 직접 수정했으면 원천 문서와 검증 명령이 맞는지 확인한다.
- 검증 명령이 통과해도, 검증이 finding을 잡을 수 없는 영역이면 별도 리스크로 남긴다.
- review cleanup 후 기존 finding이 실제로 해소됐는지 재확인한다.
- `.env`는 ignore 여부만 확인하고 값을 읽거나 출력하지 않는다.

## 출력 형식

한국어로 작성한다. 아래 순서를 지킨다.

```text
1. 최종 판정: PASS / FAIL / PARTIAL

2. Blocking findings
- [P1] <반드시 고쳐야 하는 항목> - path/to/file:line
  근거:
  영향:
  필요 조치:

3. Non-blocking findings
- [P2/P3] <남은 리스크 또는 개선 권장> - path/to/file:line

4. DnD 체크리스트
- [PASS] 목표 또는 issue 요구사항을 확인했다. 근거:
- [PASS] 현재 브랜치와 워크트리 상태를 확인했다. 근거:
- [PASS] 변경 diff를 기준 브랜치 또는 현재 워크트리 기준으로 확인했다. 근거:
- [PASS] acceptance criteria와 Definition of Done을 항목별로 판정했다. 근거:
- [PASS] 비목표 침범 여부를 확인했다. 근거:
- [PASS] 커밋 제외 대상 파일, secret, 로컬 설정 노출 여부를 확인했다. 근거:
- [PASS] 필요한 검증 명령을 실행했거나 실행하지 못한 이유를 기록했다. 근거:
- [PASS] 최종 PASS / FAIL / PARTIAL 판정을 남겼다. 근거:

5. 실행한 검증 명령과 결과
- `<command>` -> <결과>

6. 커밋/PR 준비 상태
- <준비 여부와 이유>

7. 권장 다음 액션
- <구체적 다음 행동>
```

finding이 없으면 `Blocking findings`에 `없음`이라고 쓴다. `PASS` 판정이라도 미실행 검증, live smoke 미수행, base 추론 불확실성 같은 잔여 리스크가 있으면 `Non-blocking findings`에 남긴다.

## 판정 강도

- PASS를 남발하지 않는다. 모든 blocking 조건과 필수 검증이 해소됐을 때만 PASS다.
- 사용자가 "마무리 가능?"이라고 물으면 PR/commit 가능한 상태까지 본다.
- 목표 문서가 없고 사용자의 한 문장 목표만 있으면 그 목표를 기준으로 감사하되, 문서 기준 부족을 명시한다.
- local-only 산출물이 ignore되어 있더라도, 커밋 후보에 올라와 있으면 blocking으로 본다.
