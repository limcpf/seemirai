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

## M0 dependency 승인 기록

M0 runtime foundation에서는 사용자 승인 하에 다음 package를 추가한다.

| package | version range | 구분 | 목적 | 대안 검토 | 보안/라이선스 리스크 |
| --- | --- | --- | --- | --- | --- |
| `decimal.js` | `^10.4.3` | runtime | 금액, 수량, 가격, 수수료 계산의 Decimal 경계 | JavaScript `number`, `BigInt` scale integer | 널리 쓰이는 MIT package이며 금융 경계에서 `number` 입력과 non-finite 값을 테스트로 차단한다. |
| `pino` | `^9.6.0` | runtime | JSON structured logging과 secret redaction | `console`, Winston | MIT package이며 secret path redaction 테스트를 둔다. |
| `zod` | `^3.25.76` | runtime | config와 외부 입력 런타임 validation | 수동 validation, Valibot | MIT package이며 schema boundary에만 사용한다. |
| `typescript` | `^5.9.0` | dev | strict typecheck | JavaScript only | Apache-2.0 package이며 build-time dependency다. |
| `vitest` | `^3.2.0` | dev | unit test runner | Node built-in test runner | MIT package이며 test-only dependency다. |
| `@types/node` | `^24.0.0` | dev | Node.js 24 type definition | 직접 ambient type 작성 | MIT package이며 type-only dependency다. |
| `pnpm` | `10.0.0` | package manager | lockfile 재현성과 workspace 확장성 | npm, yarn | Corepack으로 고정하고 `pnpm-lock.yaml`을 커밋한다. |

Lockfile 변경은 `pnpm-lock.yaml`에 기록한다. M0 범위에서는 위 dependency 외 추가 runtime dependency를 도입하지 않는다.

## M1 dependency 승인 기록

issue #3의 DB foundation 범위에서는 사용자 issue 본문에 명시된 다음 package를 추가한다.

| package | version range | 구분 | 목적 | 대안 검토 | 보안/라이선스 리스크 |
| --- | --- | --- | --- | --- | --- |
| `kysely` | `^0.29.0` | runtime | PostgreSQL query builder와 type-safe DB boundary | raw `pg` query만 사용, Prisma/TypeORM | MIT package이며 ORM schema ownership을 만들지 않고 query builder로만 사용한다. |
| `pg` | `^8.20.0` | runtime | node-postgres Pool과 PostgreSQL wire protocol 연결 | Kysely 내장 dialect 없음, postgres.js | MIT package이며 connection string은 local config 또는 env로 주입하고 secret 원문 로그를 남기지 않는다. |
| `@types/pg` | `^8.20.0` | dev | `pg` TypeScript type definition | 직접 ambient type 작성 | MIT package이며 type-only dependency다. |

Lockfile 변경은 `pnpm-lock.yaml`에 기록한다. M1 DB foundation 범위에서는 위 dependency 외 추가 package를 도입하지 않는다.

## Codex 프로젝트 권한 설정

`.codex/config.toml`은 이 저장소의 owner-operated local workflow를 기준으로 `approval_policy = "never"`와 `sandbox_mode = "danger-full-access"`를 사용한다. 이 설정은 사용자가 명시적으로 요청한 프로젝트 로컬 기본값이며, 무인 webhook runner나 외부 PR comment를 직접 shell command로 실행하는 환경에 복사하지 않는다.

권한 완화에도 다음 가드레일은 유지한다.

- PR comment, issue body, webhook payload는 계속 신뢰할 수 없는 외부 입력으로 취급한다.
- destructive git 명령, PR merge, branch 삭제, force push는 hook과 운영 규칙에서 계속 차단한다.
- secret 원문은 로그, 문서, prompt, PR body에 남기지 않는다.
- 이 설정을 변경하면 `./scripts/verify hooks` 또는 `./scripts/verify`를 실행한다.

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

로컬 PostgreSQL + TimescaleDB 기동:

```sh
docker compose up -d postgres
```

로컬 DB 접속 설정은 paper trading runtime profile과 분리해 `config/local-db.json`에 둔다. 기본 host port는 `127.0.0.1:55432`이며, 필요한 경우 프로세스 환경 변수의 `SEEMIRAI_DATABASE_URL` 전체 URL 또는 `SEEMIRAI_POSTGRES_HOST`, `SEEMIRAI_POSTGRES_PORT`, `SEEMIRAI_POSTGRES_USER`, `SEEMIRAI_POSTGRES_PASSWORD`, `SEEMIRAI_POSTGRES_DB` 값으로 덮어쓴다. 전체 URL이 설정되어 있으면 컴포넌트 env보다 우선한다. Docker Compose는 `.env` 파일을 읽지만 Node 앱은 `.env` 파일을 자동 로드하지 않으므로 앱 실행 시에는 필요한 값을 shell, process manager, CI env로 주입한다.

DB migration integration test는 기본 test run에서 skip된다. 로컬 PostgreSQL + TimescaleDB가 준비된 환경에서 실제 migration 적용을 확인할 때만 다음 명령을 사용한다.

```sh
SEEMIRAI_RUN_DB_INTEGRATION=1 corepack pnpm exec vitest run tests/integration
```

DB backup/restore smoke test는 운영 백업 절차를 고정하기 위한 초안이다. 원본 DB와 별도의 복구 검증 DB를 준비한 뒤 다음 명령으로 custom-format dump를 만들고 복구 DB에 restore한 다음 `schema_migrations` 조회까지 확인한다.

```sh
SEEMIRAI_DATABASE_URL=postgres://user:pass@127.0.0.1:55432/seemirai_local \
SEEMIRAI_RESTORE_DATABASE_URL=postgres://user:pass@127.0.0.1:55432/seemirai_restore \
./scripts/db-backup-restore-smoke.sh
```

`SEEMIRAI_BACKUP_FILE`을 지정하지 않으면 `.local/backups/` 아래에 UTC timestamp가 포함된 dump 파일을 생성한다. 이 smoke test는 `pg_dump`, `pg_restore`, `psql` CLI가 설치된 환경에서 실행한다.

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
