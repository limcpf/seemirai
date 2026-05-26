# issue #90 README/폐쇄망 릴리즈 번들 완료 기록

## 목표

issue #90의 README/문서 정비와 폐쇄망용 올인원 릴리즈 번들 기준을 완료하고, GitHub Release workflow와 로컬 오프라인 설치 smoke 증거를 남긴다.

## 실제 변경 범위

- 루트 `README.md`를 Seemirai 프로젝트 기준 한국어 단일 문서로 정리했다.
- 폐쇄망 번들 구조를 `maven/`, `repository/`, `workspace/`, `workspace/mvnw`, `workspace/mvnw.cmd` 기준으로 구현했다.
- `scripts/build-offline-release.mjs`로 Git index snapshot 기반 archive와 checksum을 생성한다.
- `.github/workflows/offline-release.yml`로 tag push 또는 manual dispatch 기준 GitHub Release asset 생성/갱신 절차를 추가했다.
- `docs/runbooks/offline-release.md`에 로컬 생성, checksum, forbidden entry scan, 폐쇄망 설치 절차, 실패 시 확인 항목을 문서화했다.
- 문서 라우팅 대상인 `docs/README.md`, `docs/runbooks/README.md`, `docs/generated/context-map.json`을 갱신했다.

## sub PR 기록

- PR #92: `$issue-subpr-runner` skill 추가와 운영 라우팅 등록.
- PR #93: README foundation과 문서 라우팅 정리.
- PR #95: 오프라인 번들 생성 스크립트와 단위 검증 추가.
- PR #96: GitHub Release workflow와 runbook 추가.
- Final PR: `issue-90-mother`를 `main` 대상으로 올리고 review drain까지만 수행한다. merge는 사용자가 수행한다.

## 오프라인 검증 증거

실행 기준:

```sh
node scripts/build-offline-release.mjs \
  --output-dir .local/releases \
  --package-name seemirai-offline-issue-90-smoke
```

결과:

- archive: `.local/releases/seemirai-offline-issue-90-smoke.tar.gz`
- checksum: `.local/releases/seemirai-offline-issue-90-smoke.tar.gz.sha256`
- archive size: 22M
- SHA256: `64a72229a0e835be9cac5e194c46c7a4a2c5e3bdfd62b0cb1522c08c85c655cd`

checksum 검증:

```sh
sha256sum -c seemirai-offline-issue-90-smoke.tar.gz.sha256
```

결과:

```text
seemirai-offline-issue-90-smoke.tar.gz: OK
```

archive 구조 확인:

```text
seemirai-offline-issue-90-smoke/repository/pnpm-store/
seemirai-offline-issue-90-smoke/repository/corepack/corepack.tgz
seemirai-offline-issue-90-smoke/workspace/mvnw
seemirai-offline-issue-90-smoke/workspace/package.json
seemirai-offline-issue-90-smoke/workspace/mvnw.cmd
seemirai-offline-issue-90-smoke/maven/README.txt
```

forbidden entry scan:

```sh
tar -tzf .local/releases/seemirai-offline-issue-90-smoke.tar.gz \
  | grep -E '(^|/)\.env($|\.)|(^|/)node_modules($|/)|(^|/)\.git($|/)' \
  | grep -Ev '(^|/)\.env\.example$'
```

결과: 금지 항목 출력 없음.

offline bootstrap smoke:

```sh
node -e "const fs=require('fs'); fs.rmSync('.local/offline-smoke',{recursive:true,force:true}); fs.mkdirSync('.local/offline-smoke',{recursive:true});"
tar -xzf .local/releases/seemirai-offline-issue-90-smoke.tar.gz -C .local/offline-smoke
.local/offline-smoke/seemirai-offline-issue-90-smoke/workspace/mvnw
```

결과:

- `corepack install -g --cache-only ../repository/corepack/corepack.tgz` 통과.
- `corepack pnpm install --offline --frozen-lockfile --store-dir ../repository/pnpm-store` 통과.
- `COREPACK_HOME`을 `.local/offline-smoke/corepack-empty`로 격리한 상태에서 `Adding pnpm@10.0.0 to the cache...`가 먼저 실행됐다.
- install 로그에서 `downloaded 0`, `reused 119`로 offline store 사용을 확인했다.
- `corepack pnpm typecheck` 통과.
- `corepack pnpm test` 통과: 48 files passed, 7 skipped / 465 tests passed, 45 skipped.

Windows `mvnw.cmd`는 Linux runner에서 직접 실행하지 않았고, archive 존재와 단위 테스트로 내용과 경로를 확인했다.

## 최종 검증

- `./scripts/verify docs`: 통과.
- `./scripts/verify github`: 통과.
- `./scripts/verify`: 통과.
- 각 sub PR은 `$pr-review-drain` 후 Codex clean signal과 GitHub checks를 확인하고 mother branch에 merge했다.

## 결정 로그

- 릴리즈 번들은 워킹트리 디스크 순회가 아니라 Git index/object snapshot에서 생성한다.
- 수동 release workflow 입력은 `refs/tags/<tag>`로 한정한다.
- tag push workflow checkout은 큐잉 후 태그 이동 위험을 피하기 위해 `github.sha`에 고정한다.
- Maven-style wrapper는 Maven 빌드 도입이 아니라 폐쇄망 사용자 호환 진입점으로 유지한다.

## 남은 리스크

- 실제 GitHub Release asset 발행은 tag push 또는 manual workflow 실행 시 수행된다.
- Windows `mvnw.cmd`는 Linux 환경에서 실행하지 않았으므로, Windows shell 실기 검증은 release 운영 시 수동 확인 대상으로 남긴다.
