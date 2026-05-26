# 폐쇄망 릴리즈 번들 운영 runbook

이 문서는 Seemirai 폐쇄망 설치용 올인원 릴리즈 번들을 생성, 업로드, 검증, 설치하는 절차를 정리한다.

## 산출물

GitHub Release에는 다음 두 파일을 같은 릴리즈에 올린다.

- `seemirai-offline-<version>.tar.gz`: 폐쇄망 설치용 archive
- `seemirai-offline-<version>.tar.gz.sha256`: archive 무결성 확인용 checksum

archive 내부 기준 구조:

```text
seemirai-offline-<version>/
  maven/
  repository/
    corepack/
      corepack.tgz
    pnpm-store/
  workspace/
    mvnw
    mvnw.cmd
```

`workspace/mvnw`와 `workspace/mvnw.cmd`는 Maven을 새로 도입하는 스크립트가 아니라, 폐쇄망 사용자가 기대하는 wrapper 진입점에서 Node/pnpm bootstrap을 실행하는 호환 계층이다.
`repository/corepack/corepack.tgz`는 신규 폐쇄망 호스트의 Corepack cache가 비어 있어도 pnpm 실행본을 로컬에서 설치하기 위한 package manager archive다.

## 보안 경계

- 릴리즈 번들은 Git index/object snapshot에서만 생성한다. 더티 워킹트리 파일, untracked 파일, `git add -N` intent-to-add 파일은 릴리즈 입력으로 보지 않는다.
- `.git` 메타데이터가 없는 소스 디렉터리에서는 번들 생성을 중단한다. Git 추적 여부를 알 수 없는 디스크 순회 fallback은 사용하지 않는다.
- `.env`, `.env.*`, `.git`, `node_modules`는 archive에 포함하지 않는다. 단, `.env.example`은 예시 파일로 허용한다.
- `repository/corepack/corepack.tgz`와 `repository/pnpm-store/`를 함께 배포해 Corepack package manager 다운로드와 npm registry 접근을 모두 차단한 상태에서도 bootstrap이 가능해야 한다.
- secret, token, API key, raw credential은 릴리즈 산출물과 PR/issue 본문에 원문으로 남기지 않는다.
- 기본 운영 모드는 `PAPER_TRADING`이며, live order와 withdrawal 권한은 릴리즈 설치 절차에서 요구하지 않는다.

## 자동 릴리즈

태그 push 기준 자동 실행:

```sh
git tag v0.1.0
git push origin v0.1.0
```

수동 실행 기준:

1. GitHub Actions에서 `Offline Release` workflow를 선택한다.
2. `tag`에 이미 존재하는 릴리즈 태그를 입력한다.
3. `package_name`은 비워두면 `seemirai-offline-<tag without v>`로 생성된다.
4. workflow는 입력 tag를 checkout한 뒤 그 revision과 release target SHA가 일치하는지 확인한다.
5. workflow가 archive, checksum, forbidden entry scan, offline bootstrap smoke를 통과하면 GitHub Release asset을 생성하거나 갱신한다.

workflow는 공식 action만 사용한다.

- `actions/checkout`
- `actions/setup-node`
- `actions/upload-artifact`
- GitHub hosted runner의 `gh` CLI

## 로컬 릴리즈 생성

릴리즈 산출물을 로컬에서 재현할 때는 먼저 index snapshot이 의도한 상태인지 확인한다.

```sh
git status --short
```

의도한 변경이 commit 또는 staged 상태인지 확인한 뒤 bundle을 생성한다.

```sh
node scripts/build-offline-release.mjs \
  --output-dir .local/releases \
  --package-name seemirai-offline-smoke
```

checksum을 확인한다.

```sh
(cd .local/releases && sha256sum -c seemirai-offline-smoke.tar.gz.sha256)
```

archive 경계 검사를 수행한다.

```sh
tar -tzf .local/releases/seemirai-offline-smoke.tar.gz \
  | grep -E '(^|/)\.env($|\.)|(^|/)node_modules($|/)|(^|/)\.git($|/)' \
  | grep -Ev '(^|/)\.env\.example$'
```

위 명령이 아무 항목도 출력하지 않아야 한다.

Corepack cache를 비운 상태의 bootstrap smoke를 수행한다.

```sh
node -e "const fs=require('fs'); fs.rmSync('.local/offline-smoke',{recursive:true,force:true}); fs.mkdirSync('.local/offline-smoke',{recursive:true});"
tar -xzf .local/releases/seemirai-offline-smoke.tar.gz -C .local/offline-smoke
COREPACK_HOME="$PWD/.local/offline-smoke/corepack-empty" \
  .local/offline-smoke/seemirai-offline-smoke/workspace/mvnw
```

## 폐쇄망 설치

네트워크가 가능한 환경에서 GitHub Release asset 두 개를 내려받은 뒤 폐쇄망 환경으로 전달한다.

폐쇄망 Linux/macOS 환경:

```sh
sha256sum -c seemirai-offline-<version>.tar.gz.sha256
tar -xzf seemirai-offline-<version>.tar.gz
cd seemirai-offline-<version>/workspace
./mvnw
```

폐쇄망 Windows 환경:

```bat
certutil -hashfile seemirai-offline-<version>.tar.gz SHA256
tar -xzf seemirai-offline-<version>.tar.gz
cd seemirai-offline-<version>\workspace
mvnw.cmd
```

Windows에서는 `certutil` 출력의 SHA256 값이 `.sha256` 파일의 값과 같은지 비교한다.

wrapper는 다음을 수행한다.

- `corepack install -g --cache-only ../repository/corepack/corepack.tgz`
- `corepack pnpm install --offline --frozen-lockfile --store-dir ../repository/pnpm-store`
- `corepack pnpm typecheck`
- `corepack pnpm test`

## 실패 시 확인할 항목

- checksum 실패: asset 전송 중 변조 또는 손상이므로 archive와 `.sha256` 파일을 다시 전달한다.
- Corepack 단계 실패: `repository/corepack/corepack.tgz`가 archive에 포함됐는지 확인하고 release workflow의 `Build offline release bundle` 로그를 확인한다.
- `--offline` 설치 실패: `repository/pnpm-store`가 archive에 포함됐는지 확인하고 release workflow의 `Build offline release bundle` 로그를 확인한다.
- `.git 메타데이터` 오류: 릴리즈 생성은 Git checkout에서만 수행한다. 폐쇄망 설치 환경에서 bundle을 다시 생성하지 않는다.
- forbidden entry scan 실패: `.env`, `.env.*`, `.git`, `node_modules`가 포함된 archive는 배포하지 않는다.
- live order 관련 설정 요구: 폐쇄망 smoke는 paper/default 검증 경로이며, live order API key와 withdrawal 권한을 요구하면 안 된다.

## 완료 증거

릴리즈 PR 또는 운영 기록에는 다음을 남긴다.

- archive 파일명과 checksum 파일명
- GitHub Actions run URL 또는 로컬 생성 명령
- checksum 검증 결과
- forbidden entry scan 결과
- offline bootstrap smoke 결과
- 남은 리스크와 수동 확인 항목
