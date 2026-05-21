# M8 Paper 운영 가이드

- 작성일: 2026-05-22
- 대상 단계: M8 운영 가드레일과 paper soak test
- 기본 모드: `PAPER_TRADING`, `PAPER_NO_KEY`
- 기준 문서: [`../RUNTIME_CONFIG.md`](../RUNTIME_CONFIG.md), [`../RELIABILITY.md`](../RELIABILITY.md), [`../SECURITY.md`](../SECURITY.md), [`../exec-plans/active/2026-05-13-mvp-development-plan.md`](../exec-plans/active/2026-05-13-mvp-development-plan.md)

## 현재 가능한 운영 범위

M8에서 바로 운영할 수 있는 것은 실거래 봇이 아니라 paper 운영 검증이다. 현재 기준의 운영은 Upbit public quotation WebSocket,
paper runtime 안전 설정, HTTP control route wiring, Telegram outbound 경계, daily report evidence, live order API 0회 보장을
검증하는 절차다.

가능한 것:

- `KRW-BTC`, `KRW-ETH` public market data 기반 paper soak
- API key 없는 `PAPER_NO_KEY` 안전 설정 검증
- stale market data가 신규 주문 차단 evidence로 연결되는지 fixture smoke로 확인
- live order API 호출 0회 source guard 확인
- `/status`, `/kill-switch` route wiring source scan 또는 local probe
- 24시간 public WebSocket soak summary와 PR 첨부용 Markdown artifact 생성

M8 구현 이후에도 아직 운영하지 않는 것:

- Upbit account/private API 연동
- 실제 잔고 조회, 주문 조회, 주문 생성, 주문 취소
- 출금, 입출금 자동화, 선물, 레버리지
- 단일 production daemon으로 market data, strategy, execution, daily report scheduler를 모두 상시 구동하는 운영
- Telegram inbound command, webhook, polling

## 안전 원칙

- `config/paper.json`의 `live_trading_enabled`, `withdrawal_enabled`, `cross_exchange_arbitrage_enabled`, `futures_enabled`,
  `leverage_enabled`, `market_order_enabled`, `entry_market_order_enabled`는 모두 `false`여야 한다.
- `paper_no_key`는 `true`여야 한다.
- `secrets.upbit_access_key`, `secrets.upbit_secret_key`는 paper profile에 없어야 한다.
- `scripts/soak-paper-24h.mjs`는 Upbit public quotation WebSocket만 사용해야 한다.
- raw event log, JSON summary, PR report artifact는 기본적으로 저장소 밖에 둔다.

## 1. 준비

```sh
cd /home/lim/code/seemirai
corepack pnpm install --frozen-lockfile
```

Node.js는 24 계열이어야 한다.

```sh
node --version
corepack pnpm --version
```

전체 프로젝트 검증은 다음 명령으로 확인한다.

```sh
./scripts/verify
```

문서만 확인할 때는 다음 명령을 사용한다.

```sh
./scripts/verify docs
```

## 2. 로컬 DB 준비

M8 soak fixture smoke는 DB 없이도 돌 수 있지만, paper 운영 경계와 integration evidence를 확인하려면 PostgreSQL + TimescaleDB를
준비한다.

```sh
docker compose up -d postgres
```

기본 접속값:

```text
host: 127.0.0.1
port: 55432
database: seemirai_local
user: seemirai
password: seemirai_local_password
```

DB integration 검증:

```sh
SEEMIRAI_RUN_DB_INTEGRATION=1 corepack pnpm exec vitest run tests/integration
```

백업/복구 smoke는 원본 DB와 복구 DB를 분리해서 실행한다.

```sh
SEEMIRAI_DATABASE_URL=postgres://seemirai:seemirai_local_password@127.0.0.1:55432/seemirai_local \
SEEMIRAI_RESTORE_DATABASE_URL=postgres://seemirai:seemirai_local_password@127.0.0.1:55432/seemirai_restore \
./scripts/db-backup-restore-smoke.sh
```

## 3. Telegram과 control token

M8은 Telegram outbound만 지원한다. webhook, polling, command 수신은 만들지 않는다.

필요한 경우 shell 또는 process manager에서만 주입한다.

```sh
export SEEMIRAI_TELEGRAM_BOT_TOKEN="<redacted>"
export SEEMIRAI_TELEGRAM_CHAT_ID="<redacted>"
export SEEMIRAI_LOCAL_CONTROL_TOKEN="<redacted>"
```

주의:

- token 원문은 문서, PR body, 로그, soak artifact에 남기지 않는다.
- `--control-url` probe는 token 없는 `POST /kill-switch`가 거부되는지만 확인한다.
- control token을 CLI 인자로 넘기지 않는다.

## 4. Fixture smoke

실제 24시간 연결 전에 fixture smoke를 먼저 실행한다.

```sh
node scripts/soak-paper-24h.mjs --fixture-smoke
```

JSON summary가 필요하면:

```sh
node scripts/soak-paper-24h.mjs --fixture-smoke --json
```

기대 결과:

- stale data 신규 주문 차단 evidence가 있다.
- audit 누락이 0건이다.
- live order API 호출이 0회다.
- Telegram inbound route가 없다는 근거가 있다.
- `/status`, `/kill-switch` wiring 근거가 있다.

fixture smoke가 실패하면 24시간 soak를 시작하지 않는다. stale data 차단이나 live API guard 회귀를 먼저 수정한다.

## 5. 24시간 paper soak

실제 24시간 public WebSocket soak는 명시적으로 env를 열 때만 실행한다.

```sh
export SEEMIRAI_RUN_SOAK=1
export SEEMIRAI_SOAK_LOG_DIR=/home/lim/vaults/99_운영/seemirai-soak

node scripts/soak-paper-24h.mjs \
  --duration-ms 86400000 \
  --daily-report-generated
```

local HTTP control server를 별도로 띄운 상태라면 `--control-url`을 추가한다.

```sh
node scripts/soak-paper-24h.mjs \
  --duration-ms 86400000 \
  --control-url http://127.0.0.1:8787 \
  --daily-report-generated
```

기본 artifact 위치:

```text
/home/lim/vaults/99_운영/seemirai-soak
```

완료로 인정할 summary 조건:

- crash 0회
- unhandled rejection 0회
- live order API 호출 0회
- audit 누락 0건
- stale data 신규 주문 차단 확인
- DB write failure 0건
- notification failure 0건
- daily report evidence 포함

`--daily-report-generated` 없이 실제 24시간 soak를 완료하면 daily report evidence가 빠진 상태로 간주한다. MVP 완료 판정에는
daily report evidence가 필요하다.

## 6. 결과 기록

24시간 soak가 끝나면 저장소에는 raw log를 커밋하지 않는다. 대신 다음 정보만 PR 또는 실행 계획 문서에 요약한다.

- 실행 시작/종료 시각
- 실행 명령에서 secret을 제거한 형태
- artifact 디렉터리
- JSON summary 파일명
- Markdown report 파일명
- crash, unhandled rejection, live order API call, audit missing, stale data blocked, DB write failure, notification failure,
  daily report evidence 결과

권장 볼트 위치:

```text
/home/lim/vaults/99_운영/seemirai-soak
/home/lim/vaults/99_운영/seemirai-works
```

## 7. 중단과 복구

중단 시 우선순위:

1. live order API 호출이 0회였는지 확인한다.
2. raw log와 summary artifact가 저장소 밖에 남았는지 확인한다.
3. crash 또는 unhandled rejection이 있으면 summary와 stderr 핵심 원인을 별도 작업 기록에 남긴다.
4. stale data 차단 evidence가 없으면 MVP 완료 증거로 보지 않는다.
5. token 원문이 artifact, PR body, 로그에 들어갔는지 확인하고 발견 시 즉시 폐기/재생성한다.

## 8. M8 구현 후 MVP 완료 증거 체크리스트

- [ ] `corepack pnpm install --frozen-lockfile` 완료
- [ ] `./scripts/verify` 통과
- [ ] `node scripts/soak-paper-24h.mjs --fixture-smoke` 통과
- [ ] `SEEMIRAI_RUN_SOAK=1 node scripts/soak-paper-24h.mjs --duration-ms 86400000 --daily-report-generated` 완료
- [ ] summary에 crash 0회, unhandled rejection 0회, live order API 0회, audit 누락 0건이 기록됨
- [ ] raw log와 summary artifact가 저장소 밖에 저장됨
- [ ] PR 또는 실행 계획 문서에 secret 없는 요약만 기록됨
- [ ] M8 체크박스와 MVP 완료 기준이 현재 증거와 일치하게 갱신됨

## 다음 단계

M8 구현이 merge되었어도 Upbit account/private API를 바로 열지 않는다. account 연동, 자산 조회, 주문 조회, 주문 생성/취소는
paper 운영이 안정화된 뒤 v0.2 pilot product spec에서 별도 승인과 권한 matrix를 기준으로 다룬다.
