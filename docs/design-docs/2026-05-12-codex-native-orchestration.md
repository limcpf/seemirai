# Codex-native 오케스트레이션 운영 결정

## 상태

accepted

## 배경

개인 또는 소규모 팀의 개발 운영 자동화 목적에서는 별도 오케스트레이션 서버를 직접 운영하는 비용이 크다. 현재 필요한 흐름인 PRD 작성, issue 세분화, mother branch 생성, sub PR 분할, worktree 운영, Codex sub-agent 병렬 작업, PR 생성, review drain은 Codex와 GitHub 도구만으로도 수행 가능하다.

## 결정

이 저장소는 별도 서버보다 Codex-native 보일러플레이트를 우선한다.

- `AGENTS.md`는 문서 라우터로 유지한다.
- `docs/`는 Codex가 작업 전후로 참조하는 지식 저장소로 둔다.
- `.agents/skills/`는 반복 가능한 운영 절차를 고정한다.
- `.codex/hooks/`는 위험 명령 차단과 검증 누락 방지에 집중한다.
- GitHub issue/PR/Actions는 작업 단위와 리뷰 상태의 system of record로 사용한다.

## 대안

- 별도 오케스트레이션 서버: queue, lease, retry, crash recovery, webhook 기반 자동 반응에는 강하지만 개인 생산성 도구로는 유지 비용이 크다.
- 순수 프롬프트 운영: 가볍지만 문서 라우팅, 검증, 재개 가능성이 약하다.

## 영향

- 새 프로젝트는 이 구조를 복사하고 `project-bootstrap` skill로 프로젝트명과 검증 명령을 맞춘다.
- 실제 서버가 필요한 반복 문제가 확인되기 전까지는 문서/skill/hook을 먼저 개선한다.
- 팀 단위 공유, 24시간 queue 처리, webhook 자동 시작, audit/SLA가 필요해지면 서버 제품화 범위를 다시 정한다.

## 후속 작업

- 실제 프로젝트 하나에 적용해 PRD 작성부터 PR drain까지 end-to-end로 검증한다.
- 반복 운영 중 서버가 필요한 지점을 `docs/tech-debt/README.md` 또는 별도 design doc에 모은다.
