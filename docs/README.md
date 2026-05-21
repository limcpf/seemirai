# 문서 시스템

이 디렉터리는 Codex가 작업 전후로 참조하는 지식 저장소다. 루트 `AGENTS.md`는 이 문서들로 라우팅하고, 실제 판단 기준과 작업 기억은 여기서 관리한다.

## 빠른 라우팅

- 프로젝트 개요와 현재 상태: [`../README.md`](../README.md)
- 문서 구조 탐색, 문서 추가/이동, 인덱스 갱신: [`generated/context-map.json`](./generated/context-map.json), 이 문서
- 제품 목표, MVP 범위, 사용자 시나리오: [`PRD.md`](./PRD.md)
- 기능 요구사항, acceptance criteria, 테스트 요구사항: [`FEATURE_REQUIREMENTS.md`](./FEATURE_REQUIREMENTS.md)
- Upbit KRW paper trading MVP 업무 명세: [`product-specs/upbit-krw-paper-trading-mvp.md`](./product-specs/upbit-krw-paper-trading-mvp.md)
- 로컬 개발 환경과 검증 절차: [`DEVELOPMENT.md`](./DEVELOPMENT.md)
- 런타임 설정 구조, 허용값, 안전 invariant: [`RUNTIME_CONFIG.md`](./RUNTIME_CONFIG.md)
- 운영자가 직접 실행하는 절차와 runbook: [`runbooks/README.md`](./runbooks/README.md)
- 구조 변경, 경계 변경, 새 규칙 도입: [`DESIGN.md`](./DESIGN.md), [`design-docs/index.md`](./design-docs/index.md)
- TypeScript 모듈 파일/폴더 구조 규칙: [`design-docs/2026-05-20-typescript-module-structure.md`](./design-docs/2026-05-20-typescript-module-structure.md)
- DB 테이블 역할과 관계: [`design-docs/2026-05-15-m1-database-schema.md`](./design-docs/2026-05-15-m1-database-schema.md)
- 장시간 작업, 중단 후 재개 필요: [`PLANS.md`](./PLANS.md), [`exec-plans/active/README.md`](./exec-plans/active/README.md)
- 상태 전이, 재시도, 복구, 운영 안정성 변경: [`RELIABILITY.md`](./RELIABILITY.md)
- 토큰, 권한, webhook, 외부 입력, shell command 정책 변경: [`SECURITY.md`](./SECURITY.md)
- 품질 수준 판단과 후속 작업 정리: [`QUALITY_SCORE.md`](./QUALITY_SCORE.md), [`exec-plans/tech-debt-tracker.md`](./exec-plans/tech-debt-tracker.md)
- 사용자가 명시한 기술 부채 기록: [`tech-debt/README.md`](./tech-debt/README.md)

## 디렉터리 책임

- `design-docs/`: 설계 결정과 구조 선택
- `product-specs/`: 사용자 동작 기준과 수용 기준 인덱스
- `exec-plans/`: 진행 중이거나 완료된 실행 계획
- `runbooks/`: 운영자가 직접 실행하거나 재현해야 하는 절차
- `generated/`: 기계가 우선 소비하는 파생 문서와 라우팅 색인
- `references/`: 외부 문서의 로컬 요약
- `tech-debt/`: 사용자가 명시적으로 기록을 지시한 기술 부채 목록

## 운영 원칙

- 문서는 가능한 한 경로별 책임이 분명해야 한다.
- 같은 규칙을 여러 파일에 중복하지 않는다.
- 규칙이 바뀌면 라우터보다 실제 기준 문서를 먼저 수정한다.
- 라우팅 대상 문서는 `docs/generated/context-map.json`에 등록한다.
- 각 하위 폴더는 `index.md` 또는 `README.md`로 후속 문서를 노출한다.
- `docs` 아래 Markdown이 아닌 파일은 `docs/generated/`에만 둔다.
- 문서 구조 변경 후에는 `./scripts/verify docs`를 통과시킨다.
