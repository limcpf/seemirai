---
name: project-bootstrap
description: 새 프로젝트에 AGENTS, docs, Codex hooks, GitHub 템플릿, 검증 스크립트, 기본 skills 구조를 적용할 때 사용한다.
---

# project-bootstrap

새 프로젝트에 Codex-native 개발 운영 구조를 적용할 때 사용한다. 목표는 문서 라우터, 기본 docs, Codex hook, GitHub 템플릿, 검증 스크립트, 기본 skill을 한 번에 갖추는 것이다.

## 사용 조건

- 빈 저장소 또는 기존 저장소에 운영 보일러플레이트를 넣어야 한다.
- `AGENTS.md`, `docs`, `.codex`, `.github`, `.agents/skills` 구조가 없거나 오래됐다.
- Codex가 작업 전에 읽을 문서와 완료 기준을 프로젝트마다 일관되게 만들고 싶다.

## 입력

- 프로젝트 이름
- 기본 branch
- GitHub remote 여부
- 주 언어와 package manager
- 현재 검증 명령
- 제품 아이디어 또는 기존 README

입력이 부족하면 저장소 상태에서 보수적으로 추론하고, 모호한 값은 README의 "프로젝트별로 채울 항목"으로 남긴다.

## workflow

1. 현재 파일과 git 상태를 확인한다.
   - `git status --short --branch`
   - `rg --files`
   - `gh repo view --json nameWithOwner,url,defaultBranchRef` 가능한 경우
2. 기존 운영 문서를 보존한다.
   - 기존 `AGENTS.md`, `docs`, `.codex`, `.github`가 있으면 덮어쓰기 전에 차이를 확인한다.
   - 사용자 작성 내용은 삭제하지 않고 병합한다.
3. 기본 구조를 만든다.
   - `AGENTS.md`
   - `README.md`
   - `ARCHITECTURE.md`
   - `docs/README.md`
   - `docs/PRD.md`
   - `docs/FEATURE_REQUIREMENTS.md`
   - `docs/DESIGN.md`
   - `docs/DEVELOPMENT.md`
   - `docs/PLANS.md`
   - `docs/RELIABILITY.md`
   - `docs/SECURITY.md`
   - `docs/QUALITY_SCORE.md`
   - `docs/design-docs/index.md`
   - `docs/design-docs/core-beliefs.md`
   - `docs/product-specs/index.md`
   - `docs/exec-plans/active/README.md`
   - `docs/exec-plans/completed/README.md`
   - `docs/generated/README.md`
   - `docs/generated/context-map.json`
   - `docs/references/README.md`
   - `docs/tech-debt/README.md`
4. Codex 설정과 hook을 만든다.
   - `.codex/config.toml`
   - `.codex/hooks.json`
   - `.codex/hooks/*`
5. GitHub 운영 파일을 만든다.
   - `.github/workflows/verify.yml`
   - `.github/pull_request_template.md`
   - `.github/ISSUE_TEMPLATE/feature.yml`
6. 기본 skill을 설치한다.
   - `project-bootstrap`
   - `prd-writer`
   - `issue-planner`
   - `subpr-orchestrator`
   - `pr-review-drain`
7. 검증 스크립트를 연결한다.
   - `scripts/verify-doc-structure.mjs`
   - `scripts/verify-hooks.mjs`
   - `scripts/verify-github.mjs`
   - `scripts/verify`
   - 언어별 manifest는 실제 프로젝트가 필요할 때만 둔다.
8. `./scripts/verify`를 실행한다.
9. 결과를 요약한다.

## 완료 기준

- 루트 `AGENTS.md`가 짧은 라우터로 동작한다.
- `docs/generated/context-map.json`이 실제 문서와 skill을 가리킨다.
- 문서 인덱스와 링크가 깨지지 않는다.
- hook 설정이 JSON으로 파싱되고 hook command 대상 파일이 존재한다.
- GitHub issue/PR/verify workflow 기본 파일이 있다.
- `./scripts/verify`가 통과한다.

## 최종 요약에 포함할 것

- 생성/수정한 주요 파일
- 프로젝트별로 아직 채워야 하는 문서
- 실행한 검증 명령과 결과
- GitHub remote 또는 기본 branch 확인 결과
- 남은 리스크
