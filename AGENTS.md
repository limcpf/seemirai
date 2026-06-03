# 루트 작업 라우터

이 문서는 저장소 전체 규칙을 길게 설명하는 매뉴얼이 아니라, Codex가 어떤 문서를 먼저 읽어야 하는지 정하는 진입점이다.

## 항상 먼저 읽을 문서

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- 현재 작업 경로와 가장 가까운 `AGENTS.md`

## 작업 유형별 추가로 읽을 문서

- 문서 구조 탐색, 문서 추가/이동, 인덱스 갱신: [`docs/README.md`](./docs/README.md), [`docs/generated/context-map.json`](./docs/generated/context-map.json)
- 제품 판단, MVP 범위, 사용자 시나리오: [`docs/PRD.md`](./docs/PRD.md)
- 기능 구현, acceptance criteria, 테스트 요구사항: [`docs/FEATURE_REQUIREMENTS.md`](./docs/FEATURE_REQUIREMENTS.md)
- 구조 변경, 경계 변경, 새 규칙 도입: [`docs/DESIGN.md`](./docs/DESIGN.md), [`docs/design-docs/index.md`](./docs/design-docs/index.md)
- 장시간 작업, 중단 후 재개 가능한 작업: [`docs/PLANS.md`](./docs/PLANS.md), [`docs/exec-plans/active/README.md`](./docs/exec-plans/active/README.md)
- 상태 전이, 재시도, 복구, 운영 안정성 변경: [`docs/RELIABILITY.md`](./docs/RELIABILITY.md)
- 토큰, 권한, webhook, 외부 입력, shell command 정책 변경: [`docs/SECURITY.md`](./docs/SECURITY.md)
- 품질 수준 판단이나 후속 작업 정리: [`docs/QUALITY_SCORE.md`](./docs/QUALITY_SCORE.md), [`docs/exec-plans/tech-debt-tracker.md`](./docs/exec-plans/tech-debt-tracker.md)
- 사용자가 명시한 기술 부채 기록: [`docs/tech-debt/README.md`](./docs/tech-debt/README.md)

## Codex-native 운영 skill

- 새 프로젝트 구조 생성: [`.agents/skills/project-bootstrap/SKILL.md`](./.agents/skills/project-bootstrap/SKILL.md)
- PRD와 기능 요구사항 작성: [`.agents/skills/prd-writer/SKILL.md`](./.agents/skills/prd-writer/SKILL.md)
- GitHub issue 작성과 생성: [`.agents/skills/issue-planner/SKILL.md`](./.agents/skills/issue-planner/SKILL.md)
- issue 기준 sub PR 순차 개발과 임시 mother merge 운영: [`.agents/skills/issue-subpr-runner/SKILL.md`](./.agents/skills/issue-subpr-runner/SKILL.md)
- issue 단위 mother/sub PR 운영: [`.agents/skills/subpr-orchestrator/SKILL.md`](./.agents/skills/subpr-orchestrator/SKILL.md)
- PR 리뷰 drain: [`.agents/skills/pr-review-drain/SKILL.md`](./.agents/skills/pr-review-drain/SKILL.md)
- Reasonix 구현 후 워크트리 코드 리뷰: [`.agents/skills/reasonix-codex-review/SKILL.md`](./.agents/skills/reasonix-codex-review/SKILL.md)
- 개발 마무리 전 완료 가능 상태 감사: [`.agents/skills/finish-readiness-audit/SKILL.md`](./.agents/skills/finish-readiness-audit/SKILL.md)

## 저장소 공통 규칙

- 항상 Plan을 먼저 세우고 작업한다.
- 모든 답변과 작업 요약은 한국어로 작성한다.
- 비즈니스/시스템/프로그램 흐름을 표현하는 TypeScript 타입·인터페이스·클래스·서비스·함수는 반드시 한국어 JSDoc을 작성한다. JSDoc에는 단순 이름 풀이가 아니라 책임, 호출 경계, 입력/출력 의미, 유지해야 하는 invariant, 외부 side effect 여부를 포함한다.
- 상태 전이, 리스크 차단, 인증/권한, 재시도/idempotency, DB write, audit/risk evidence, 외부 API·job·notification 같은 핵심 분기에는 반드시 한국어 한 줄 주석을 남긴다. 주석은 “무엇을 하는가”보다 “왜 이 분기에서 차단/기록/지연/커밋하는가”를 설명한다.
- 새 비즈니스 로직을 추가하거나 기존 로직을 수정할 때 주석 보강을 완료 조건에 포함한다. 주석이 함수명 반복, 타입명 번역, 구현 줄별 설명에 그치면 완료로 보지 않는다.
- 사용자에게 직접 보이는 문구는 한국어를 우선하고, 내부 enum/code/reason code/영문 도메인 용어를 첫 화면에 그대로 노출하지 않는다. HTTP 응답, Telegram·리포트·CLI·status 출력은 사용자 행동 언어로 상태·원인·영향·필요 조치를 먼저 설명하고, 안정적인 내부 식별자는 `추적 정보`나 debug/detail 영역에 분리해 보존한다.
- TypeScript 모듈을 새로 만들거나 분리할 때는 public entry와 같은 이름의 디렉터리에 세부 구현을 두는 구조를 기본으로 한다. 상세 기준은 [`docs/design-docs/2026-05-20-typescript-module-structure.md`](./docs/design-docs/2026-05-20-typescript-module-structure.md)를 따른다.
- 사용자가 명시하지 않은 신규 의존성 추가는 피한다.
- 관련 없는 파일은 수정하지 않는다.
- 변경은 가능한 한 최소 범위로 유지한다.
- 반복해서 참조해야 하는 결정, 규칙, 작업 기억은 저장소 안의 문서로 남긴다.
- 큰 작업은 `main`에서 직접 진행하지 않고, 별도 branch와 git worktree에서 수행한다.
- Codex의 자연어 완료 선언만으로 완료 판정을 하지 않는다.
- 완료 판정은 테스트, lint, build, 문서 검증, GitHub checks, PR review 상태 같은 기계적 증거로 확인한다.

## Review guidelines

- findings를 먼저, 심각도 높은 순서로 정리한다.
- 스타일 취향보다 버그, 회귀, 위험한 가정, 누락된 검증을 우선한다.
- 근거가 있으면 파일 경로와 라인 번호를 적는다.
- 명시적 문제가 없으면 그 사실과 남은 리스크만 짧게 적는다.
- 리뷰 본문은 한국어로 작성한다.

## 문서 운영 규칙

- `AGENTS.md`는 짧은 라우터로 유지하고, 상세 규칙은 `docs/` 또는 skill로 분리한다.
- 설계 결정은 `docs/design-docs/`에 기록한다.
- 사용자 동작 기준과 수용 기준은 `docs/PRD.md`, `docs/FEATURE_REQUIREMENTS.md`, 필요 시 `docs/product-specs/`에 기록한다.
- 실제 실행 계획은 `docs/exec-plans/active/`와 `docs/exec-plans/completed/`에서 관리한다.
- 사람이 직접 편집하지 않는 파생 문서는 `docs/generated/`에만 둔다.
- 문서 라우팅 대상 파일을 추가하거나 이동하면 관련 `index.md`/`README.md`와 `docs/generated/context-map.json`을 함께 갱신한다.

## 완료 기준

- 변경과 직접 관련된 검증을 수행하거나, 검증 수단이 없으면 그 사실을 명시한다.
- 규칙이나 운영 방식이 바뀌면 관련 문서를 함께 갱신한다.
- 문서 구조가 바뀌면 `./scripts/verify docs` 또는 `node scripts/verify-doc-structure.mjs`를 통과시킨다.
- hook 또는 Codex 설정이 바뀌면 `./scripts/verify hooks` 또는 `node scripts/verify-hooks.mjs`를 통과시킨다.
- GitHub template 또는 workflow가 바뀌면 `./scripts/verify github` 또는 `node scripts/verify-github.mjs`를 통과시킨다.
- 장시간 작업이었다면 실행 계획 문서 상태를 현재 결과에 맞게 갱신한다.
