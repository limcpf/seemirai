# 핵심 운영 원칙

## 상태

accepted

## 원칙

- Codex가 매번 같은 판단 순서로 움직일 수 있게 라우터와 context map을 유지한다.
- workflow는 skill이 담당하고, hook은 위험 행동 차단과 검증 누락 방지에 집중한다.
- 큰 변경은 GitHub issue, mother branch, sub PR, worktree로 나눠 리뷰 가능한 의미 단위로 만든다.
- Codex의 자연어 완료 선언만으로 완료 판정을 내리지 않는다.
- 완료는 검증 명령, GitHub checks, unresolved thread 없음, clean signal, 작업 tree 상태로 확인한다.
- 사람이 최종 merge 판단을 유지한다.

## 설계 영향

- `AGENTS.md`는 짧은 라우터로 유지한다.
- 상세 정책은 `docs/`와 `.agents/skills/`에 둔다.
- 새 문서와 skill은 context map 또는 README에서 찾을 수 있게 한다.
