# 개발 환경 구성

## 목적

- 새 개발자가 로컬 설정, 검증 명령, GitHub 운영 흐름을 빠르게 찾을 수 있게 한다.
- 구현 전 단계에서도 문서 하네스와 검증 루틴을 먼저 고정한다.

## 보일러플레이트 런타임

- 제품 runtime과 검증 harness는 Node.js 24 LTS를 기준으로 한다.
- `.nvmrc`는 `24`, `package.json`의 `engines.node`는 `>=24 <25`로 고정한다.
- 패키지 매니저는 pnpm 10 계열을 사용하고 `pnpm-lock.yaml`을 커밋한다.
- Corepack이 있는 환경에서는 `corepack pnpm ...` 형태로 pnpm을 실행할 수 있다.
- 실제 프로젝트 의존성을 추가할 때는 `docs/SECURITY.md`의 dependency 승인 기준을 따른다.

## Seemirai MVP 런타임

- 제품 runtime은 Node.js 24 LTS와 TypeScript strict를 기준으로 한다.
- 패키지 매니저는 pnpm을 사용하고 lockfile을 커밋한다.
- TypeScript는 `strict`, `allowJs=false`, `noImplicitAny`, `exactOptionalPropertyTypes`를 켠다.
- 테스트 runner는 Vitest를 사용한다.
- 기본 설정은 `config/paper.json`에서 시작하고 Zod schema로 검증한다.
- 기본 paper profile은 API key 없이 로딩되어야 하며 실거래, 출금, 거래소 간 차익거래, 선물, 시장가 주문은 모두 비활성이다.
- 금액, 수량, 가격, 수수료 계산 경계는 Decimal 기반 유틸을 통해 문자열 또는 Decimal 입력만 허용한다.
- logger는 Pino JSON log를 사용하고 Upbit key, Telegram token, local control token 후보를 redaction한다.
- DB는 PostgreSQL + TimescaleDB를 기준으로 한다.
- Redis와 BullMQ는 MVP 필수 구성에서 제외하고, 비동기 작업은 PostgreSQL `jobs` table 기반 queue로 시작한다.
- 배포 기준은 Ubuntu 24.04 LTS + Docker Compose다.
- 상세 결정은 [`design-docs/2026-05-13-mvp-runtime-architecture.md`](./design-docs/2026-05-13-mvp-runtime-architecture.md)를 따른다.

## 로컬 시작

의존성 설치:

```sh
corepack pnpm install --frozen-lockfile
```

타입 검사:

```sh
corepack pnpm typecheck
```

테스트:

```sh
corepack pnpm test
```

## 환경 변수

- 실제 `.env` 파일과 secret 값은 커밋하지 않는다.
- `.env.example`은 커밋 가능하다.
- GitHub token, OpenAI/Codex 인증 값은 로그나 Codex prompt에 원문으로 넣지 않는다.

## 로컬 산출물

- `.local/`: 로컬 DB, command log, agent artifact
- `.worktrees/`: issue 또는 sub PR 작업용 git worktree
- `.codex/tmp/`: hook state
- `node_modules/`, `dist/`, `coverage/`, `test-results/`: 생성 산출물

위 경로는 커밋하지 않는다.

## 검증

문서 구조 검증:

```sh
./scripts/verify docs
```

hook 설정 검증:

```sh
./scripts/verify hooks
```

GitHub 템플릿과 workflow 검증:

```sh
./scripts/verify github
```

프로젝트 코드 검증:

```sh
./scripts/verify project
```

전체 검증:

```sh
./scripts/verify
```

전체 검증은 문서, hook, GitHub 운영 파일, 프로젝트 `typecheck`, 프로젝트 `test`를 함께 실행한다.

## 작업 브랜치와 worktree

권장 기본 흐름:

```sh
git switch main
git pull --ff-only
git switch -c issue-12-mother
git push -u origin issue-12-mother
git worktree add ../issue-12-01-foundation -b issue-12/01-foundation issue-12-mother
```

규칙:

- `main`에서는 mutating command를 실행하지 않는다.
- sub PR은 mother branch에서 갈라진다.
- 병렬 sub PR은 파일 소유권이 겹치지 않을 때만 진행한다.
- lockfile, context map, 문서 인덱스처럼 충돌이 쉬운 파일은 한 PR의 책임으로 둔다.
