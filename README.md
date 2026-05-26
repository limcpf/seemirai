# Seemirai

Seemirai는 Upbit KRW 현물 시장에서 실거래 전에 자동 주문 엔진, 비용 모델, 리스크 게이트, 알림, 감사 로그가 안전하게 동작하는지 검증하는 paper trading 시스템이다. 목표는 AI가 매수와 매도를 직접 지시하게 만드는 것이 아니라, 수수료, 스프레드, 슬리피지, 유동성, 손실 한도 같은 비용과 위험을 먼저 차감한 뒤에도 기대값이 남는 거래 후보만 통과시키는 것이다.

현재 MVP는 `PAPER_TRADING` 전용이다. 기본 설정에서는 실거래 주문, 출금, 거래소 간 차익거래, 선물, 레버리지, 타인 계정 운용을 활성화하지 않는다.

## 프로젝트 개요

- 거래소: Upbit KRW 현물
- 기본 모드: paper trading
- 1차 대상 종목: `KRW-BTC`, `KRW-ETH`
- 런타임: Node.js 24 LTS, TypeScript, pnpm
- 저장소: PostgreSQL + TimescaleDB 기준 설계
- 검증: Vitest, 문서 구조 검증, GitHub 운영 파일 검증
- 운영 경계: 실거래 전 paper trading, 리스크 차단, Telegram 알림, 감사 로그

핵심 흐름:

```text
Upbit 공개 시장 데이터
  -> 원천 이벤트와 정규화 이벤트 저장
  -> 피처 계산과 전략 후보 생성
  -> 비용 차감
  -> 리스크 게이트
  -> paper broker 가상 주문/체결
  -> 감사 로그, 알림, 운영 리포트
```

## 기본 사용 방법

필수 전제:

- Node.js 24 LTS
- Corepack 또는 pnpm 10
- 로컬 검증용 shell 환경
- DB 통합 검증을 실행할 경우 PostgreSQL + TimescaleDB

의존성 설치:

```sh
corepack pnpm install --frozen-lockfile
```

기본 검증:

```sh
corepack pnpm typecheck
corepack pnpm test
./scripts/verify
```

문서만 검증:

```sh
./scripts/verify docs
```

GitHub workflow, PR template, issue form만 검증:

```sh
./scripts/verify github
```

기본 paper profile은 `config/paper.json`에서 시작한다. 이 profile은 API key 없이 로딩되어야 하며, 실거래 주문 API와 출금 권한을 요구하지 않는다.

## 폐쇄망 설치와 릴리즈 패키지

폐쇄망 설치는 GitHub Release에 업로드되는 단일 올인원 패키지를 기준으로 한다. 패키지는 네트워크 차단 상태에서도 의존성 설치와 기본 검증을 수행할 수 있도록 로컬 의존성 저장소 또는 동등한 offline cache를 포함해야 한다.

폐쇄망 릴리즈 번들의 기준 구조:

```text
maven/
repository/
  corepack/
    corepack.tgz
  pnpm-store/
workspace/
  mvnw
  mvnw.cmd
```

프로젝트는 Node/pnpm 기반이므로 `workspace/mvnw.cmd`는 Maven 빌드를 새로 도입하는 목적이 아니라, 폐쇄망 사용자가 기대하는 wrapper 진입점에서 검증 가능한 bootstrap 명령으로 연결하는 호환 계층이다. Unix 계열 환경에서는 동등한 bootstrap 진입점도 함께 제공한다.

릴리즈 자산에는 checksum 또는 해시 파일을 포함하고, secret, token, raw credential, `.env` 원문을 포함하지 않는다. 생성, 업로드, 폐쇄망 설치 절차는 [폐쇄망 릴리즈 번들 운영 runbook](./docs/runbooks/offline-release.md)을 따른다.

## 보안과 운영 경계

기본 안전값:

```yaml
mvp:
  exchange: UPBIT
  market: KRW_SPOT
  mode: PAPER_TRADING
  live_trading_enabled: false
  withdrawal_enabled: false
  cross_exchange_arbitrage_enabled: false
  futures_enabled: false
```

운영자가 확인해야 할 보안 경계:

- secret, token, API key, `.env` 원문은 저장소와 릴리즈 패키지에 포함하지 않는다.
- 실거래 주문 API는 MVP 기본 경로에서 호출하지 않는다.
- LLM은 공식 공지, 정책, 시장경보 리스크 분류에만 사용하고 주문 판단에는 사용하지 않는다.
- Telegram token과 local control token은 환경 변수나 외부 secret 주입으로만 전달한다.
- PR comment, issue body, webhook payload는 신뢰할 수 없는 외부 입력으로 취급한다.
- `force push`, branch 삭제, 보호 규칙 우회 merge는 기본 운영에서 금지한다.

## 문서와 운영 가이드

- [아키텍처](./ARCHITECTURE.md)
- [제품 요구사항](./docs/PRD.md)
- [기능 요구사항](./docs/FEATURE_REQUIREMENTS.md)
- [개발 환경과 검증 절차](./docs/DEVELOPMENT.md)
- [보안 가드레일](./docs/SECURITY.md)
- [런타임 설정](./docs/RUNTIME_CONFIG.md)
- [운영 runbook](./docs/runbooks/README.md)
- [문서 시스템](./docs/README.md)

처음 합류한 개발자는 [온보딩 문서](./docs/ONBOARDING.md)를 먼저 읽고, 구조 변경이나 새 문서 추가 전에는 [문서 시스템](./docs/README.md)과 [context map](./docs/generated/context-map.json)을 함께 확인한다.

## 제작자 정보

- 저장소: `limcpf/seemirai`
- 제작자 및 운영자: `limcpf`
- 프로젝트 언어: 한국어 사용자 문서, TypeScript 런타임

문제 제보, 기능 요청, 운영 개선 제안은 GitHub issue로 기록한다. 보안과 secret 관련 내용은 공개 issue나 PR 본문에 원문 값을 포함하지 않는다.
