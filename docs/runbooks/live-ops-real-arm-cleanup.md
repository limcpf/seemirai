# Live Ops 실거래 arm cleanup runbook

이 runbook은 Issue #206의 production `live:ops` 경로를 실제 Upbit 주문 가능 상태로 검증하고, 단일 소액 주문을 제출한 뒤 같은
identifier 또는 uuid로 취소해 terminal cancel evidence로 닫는 절차다.

## 사용 조건

- 대상 command: `corepack pnpm live:ops -- --config <운영-json-path> --env-file <운영-env-path> --tui`
- 대상 mode: `LIVE_AUTONOMOUS_SMALL_BUDGET`
- 대상 market: `KRW-BTC`
- 허용 주문: `BUY + LIMIT + post_only`
- 첫 주문 상한: 10,000 KRW
- artifact/evidence 위치: 저장소 밖 redacted 운영 경로. 기본값은 운영 config 파일과 같은 디렉터리의 `artifacts/`이며,
  `SEEMIRAI_LIVE_OPS_REAL_ARM_ARTIFACT_DIR`가 있으면 그 저장소 밖 절대 경로를 우선한다.

## 금지 조건

- 신규 진입 시장가, 시장가 매도, best order
- BTC 외 market 기본 활성화
- 자동 budget 확대
- hard stop open position 자동 시장가 청산
- 출금, 입출금, 선물, 레버리지, 마진, 타인 계정, 신호 판매
- secret 원문, raw Authorization/JWT, raw provider payload, raw order detail 저장

## 사전 점검

다음 조건이 하나라도 빠지면 cleanup run을 시작하지 않는다.

| 항목 | 기준 |
| --- | --- |
| 운영자 arm evidence | 저장소 밖 redacted evidence id가 있고, 오늘 실행할 config/env 경로와 연결되어 있다 |
| key scope | `자산조회`, `주문조회`, `주문하기`만 허용되고 금지 scope가 없다 |
| DB readiness | migration pending, unknown applied migration, checksum drift, missing table이 없다 |
| Upbit public feed | `KRW-BTC` 체결/호가/status가 DB-backed store에 저장되고 stale 상태가 아니다 |
| decision policy | `analysis.decision_policy.id=cleanup_probe`이고 정적 allowlist resolver가 `live_ops_cleanup_probe` strategy를 조립한다 |
| private read | account/order/balance 조회가 가능하고 raw payload 없이 safe summary로 낮아진다 |
| reconcile | 기존 mismatch/manual review가 없고, DB run이 없으면 CLI가 private read preflight evidence를 자동 생성한다 |
| PnL/status | `readStatus=OK`, `CALCULATED` snapshot status, provider read 완료 후 시각 기준 30초 freshness를 모두 만족해야 손실 증거로 쓰고, 결측/오래됨/PARTIAL/status 누락/read-level `OK`/job-level 완료 status는 0으로 보정하지 않는다. preflight 직후 새 row의 1초 이내 future skew만 허용한다 |
| Telegram | startup/live order capable/order/cancel/manual review alert를 owner chat으로 보낼 수 있다 |
| TUI | live armed/order capable, 최신 decision/order/cancel/reconcile/PnL 상태를 secret 없이 보여준다 |
| artifact 경로 | symlink 기준 실제 경로가 저장소 밖이고 secret/raw payload 검사를 통과한다 |

## 실행 절차

1. 저장소 밖 운영 env와 key 파일을 source하지 말고, `--env-file` 경로로만 전달한다.
2. fixture smoke가 아니라 실제 운영 config/env로 foreground TUI를 시작한다.

```sh
corepack pnpm live:ops -- --config <운영-json-path> --env-file <운영-env-path> --tui
```

3. TUI와 Telegram에서 startup alert와 live order capable 전환을 분리해 확인한다.
4. `cleanup_probe` decision policy가 최신 orderbook에서 단일 `KRW-BTC` `BUY + LIMIT + POST_ONLY` 후보를 만들었는지 확인한다.
   주문 후보가 없으면 TUI/JSON의 HOLD/BLOCK reason을 먼저 확인하고 broker 제출로 전진하지 않는다.
5. 단일 `KRW-BTC` 후보가 생성되면 CLI가 private read/reconcile/PnL preflight, cost/risk/reconcile/budget/kill switch guard,
   deterministic budget reservation을 순서대로 통과시킨다. DB에 완료된 reconcile run이 아직 없고 기존 mismatch/manual review도 없으면,
   CLI는 방금 읽은 Upbit private 잔고/미체결 주문 결과를 `live_reconcile_*` 테이블에
   `LIVE_OPS_PRIVATE_READ_PREFLIGHT` evidence로 저장한 뒤 그 row를 다시 읽어 readiness를 판단한다. 이 단계가 하나라도 실패하면
   broker 호출 전에 fail-closed 된다.
6. 주문이 제출되면 CLI가 같은 runtime에서 받은 Upbit uuid로 즉시 취소 요청을 보낸다. 같은 runtime이 만든 uuid가 아니면 취소를
   시도하지 않고 manual review로 격상한다.
7. CLI가 제한된 polling으로 terminal cancel/done 상태를 확인한다. terminal cancel을 확인하지 못하면 open exposure를 0으로 보정하지 않고
   manual review 상태와 필요한 조치를 표시한다.
8. CLI는 저장소 밖 artifact에 다음 safe summary만 남긴다.

```text
submitted_at=<ISO timestamp>
cancel_requested_at=<ISO timestamp>
terminal_checked_at=<ISO timestamp>
market=KRW-BTC
side=BUY
order_type=LIMIT
time_in_force=POST_ONLY
requested_notional_krw<=10000
identifier=<redacted/stable suffix only>
broker_order_id=<redacted/stable suffix only>
terminal_state=CANCEL_CONFIRMED
open_exposure_krw=0
```

9. source/security scan과 artifact redaction 검증을 실행한 뒤 PR/closeout에 결과를 기록한다. 운영자는 secret 원문이나 raw provider
   payload를 별도로 복사하지 않는다.

## CLI가 자동으로 남기는 evidence

`live:ops` production 실행은 cleanup 후보를 실제 broker에 넘기기 전에 같은 attempt id로 reservation artifact를 만든다. reservation은
`ops-` attempt id, market, strategy id, requested notional, budget snapshot, captured timestamp만 포함한다. 같은 attempt id의 reservation이
이미 있으면 중복 실주문을 만들지 않고 broker 호출 전에 차단한다.

DB에 `live_reconcile_runs` 완료 기록이 없는 clean-start 운영 DB에서는 CLI가 actual private read 결과로 preflight reconcile run을 자동 생성한다.
이 run은 기존 M16 장기 reconcile worker를 대체하지 않고, cleanup 주문 제출 직전 계정 잔고와 계정 전체 미체결 주문 상태를 DB-backed evidence로 남기는
부팅 전용 증거다. 기존 DB에 mismatch, failed, running, manual review 상태가 있으면 preflight clean evidence로 덮지 않고 그대로 신규 주문을
차단한다. 기존 clean evidence 뒤에 새 미체결 주문이 생겼거나, preflight 시점에 설정 마켓이 아닌 다른 KRW 마켓의 미체결 주문이 있어도
`MANUAL_REVIEW_REQUIRED`와 `UNTRACKED_EXCHANGE_OPEN_ORDER` evidence로 닫고 신규 cleanup 주문을 제출하지 않는다. 가격 또는 원 주문 수량이 없는
`market`/`best` 계열 미체결 주문도 `remaining_volume` 기반 preflight evidence에 포함되며, TUI/JSON은 preflight run id와 evidence type을 보여줘 운영자가
정리할 DB run을 바로 찾을 수 있어야 한다. 이때 계산 가능한 open exposure와 budget used를 0으로 숨기지 않고, owner Telegram manual-review
alert도 전송되어야 한다. submit 이후 상태 조회에서는 현재 live execution의 broker order id 또는 idempotency key와 일치하는 1건만 tracked
open order로 인정한다.

submit/cancel lifecycle artifact는 terminal cancel 확인 뒤에만 success status가 된다. artifact에는 full access key, secret key, JWT,
Authorization header, Telegram token, DB URL/password, TUI control token, raw provider payload, raw order detail을 쓰지 않는다. uuid와
identifier는 suffix만 남기며, PR/issue에는 이 저장소 밖 artifact 경로와 safe summary만 기록한다.

## Closeout manifest 검증

`scripts/run-live-ops-real-arm-closeout.mjs`는 실제 주문을 제출하지 않는다. 이 스크립트는 운영자가 저장소 밖에서 이미 생성한
redacted manifest와 artifact를 읽어 Issue #206 closeout 기준을 검증한다. 운영 guard가 없으면 실거래 evidence 검증을 건너뛰고
blocker summary만 만든다.

CI/로컬 contract smoke:

```sh
node scripts/run-live-ops-real-arm-closeout.mjs --fixture-smoke --json
```

운영 credential/evidence 부재 blocker 기록:

```sh
node scripts/run-live-ops-real-arm-closeout.mjs --json
```

실제 redacted manifest 검증:

```sh
SEEMIRAI_RUN_LIVE_OPS_REAL_ARM_CLOSEOUT=1 \
  node scripts/run-live-ops-real-arm-closeout.mjs \
  --manifest <저장소-밖-redacted-manifest-json> \
  --json
```

manifest에는 저장소 밖 절대 경로인 `configPath`, `envFilePath`, `operatorArmEvidenceId`, `keyScopeEvidenceId`, `keyScope`,
`artifactPaths`, 주문 lifecycle, reconcile closeout, zero counter, Telegram/TUI evidence, source/security scan,
`finish-readiness-audit` PASS evidence를 포함한다. `command`는 실제 foreground 실행인
`corepack pnpm live:ops -- --config <절대-path> --env-file <절대-path> --tui`만 허용하며 `--help`, `--fixture-smoke`, `--dry-run`,
attach 명령, 추가/중복 인자, shell separator, 상대 `config/env` 경로가 붙은 명령은 closeout 증거가 아니다. `configPath`와 `envFilePath`, manifest 파일
자체는 저장소 밖에 실제 파일로 존재해야 하며 symlink를 따라간 실제 경로도 저장소 밖이어야 한다. config JSON은 실제 foreground wrapper와
같은 허용 key set만 사용할 수 있고, production
`LIVE_AUTONOMOUS_SMALL_BUDGET` contract와 `KRW-BTC` 단일 universe, live trading on, paper/no-risk flags off, small-budget/TUI/Telegram
설정, 정적 `cleanup_probe` decision policy를 만족해야 한다. decision policy config는 임의 파일 경로, 동적 import, 원격 plugin,
저장소 밖 strategy 코드를 실행하게 만들 수 없다. env 파일은 DB, Upbit key, key scope evidence, Telegram, TUI control token 값이 실제로 있어야 하며, key scope는
`자산조회`, `주문조회`, `주문하기` 외 추가 권한이 없어야 한다. env의 `SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID`는 manifest의
`keyScopeEvidenceId`와 같아야 한다. M22/M23 smoke guard나 placeholder 값으로 대체할 수 없고, foreground 실행 당시 shell에 남아 있던
M22/smoke legacy env도 production contract 위반으로 본다. 이 저장소 경계는 validator를 어느 작업 디렉터리에서 실행하더라도 repository
root 기준으로 판정한다. `fixture-*` 같은 fixture credential 값도 fake/dummy/example credential과 동일하게 production evidence로 인정하지 않는다.

`live:ops:tui -- --attach ...`는 기존 foreground 실행이 남긴 JSON status source를 읽는 read-only 화면이다. attach source를 읽지 못하거나
필수 status summary가 없으면 정상 dashboard를 합성하지 않고 실패해야 한다. attach 출력은 운영 중 상태 확인에는 쓸 수 있지만,
foreground boot, Upbit provider arm, broker submit/cancel, Telegram dispatch, cleanup artifact 생성을 새로 수행하지 않으므로 실거래
closeout evidence로 인정하지 않는다.

`keyScope`는 `grantedScopes: ["자산조회", "주문조회", "주문하기"]`, `forbiddenScopesAbsent: ["출금하기"]`,
`withdrawalEnabled: false`처럼 허용 scope와 출금 권한 부재를 redacted safe summary로 기록한다. source/security scan은 실제 `rg -n`
명령으로 repository root에서 runtime source path인 `src/runtime/live-ops-config src/runtime/live-ops-decision-policy
src/runtime/live-ops-live-execution src/runtime/live-ops-analysis-decision src/application/live-autonomous-entry-runtime/service.ts
src/infrastructure/upbit/private-client/client.ts src/infrastructure/upbit/live-broker/service.ts scripts/run-live-ops.mjs
scripts/run-live-ops-support.mjs config`
전체 범위의 금지 주문 경계 전체(`[\x27"]?ord_type[\x27"]?\s*[:=]\s*[\x27"]?price`,
`[\x27"]?ord_type[\x27"]?\s*[:=]\s*[\x27"]?market`, `[\x27"]?ord_type[\x27"]?\s*[:=]\s*[\x27"]?best`,
`[\x27"]?order_type[\x27"]?\s*[:=]\s*[\x27"]?(market|MARKET)`,
`[\x27"]?orderType[\x27"]?\s*[:=]\s*[\x27"]?(market|MARKET)`,
`[\x27"]?withdrawal_enabled[\x27"]?\s*[:=]\s*true`, `[\x27"]?deposit_enabled[\x27"]?\s*[:=]\s*true`,
`\/v1\/deposits`, `\/v1\/withdraws`, `[\x27"]?futures_enabled[\x27"]?\s*[:=]\s*true`,
`[\x27"]?leverage_enabled[\x27"]?\s*[:=]\s*true`, `[\x27"]?market_order_enabled[\x27"]?\s*[:=]\s*true`,
`[\x27"]?entry_market_order_enabled[\x27"]?\s*[:=]\s*true`)와
secret/raw payload 후보 전체(`SEEMIRAI_DATABASE_URL=postgres://...:<password>@...`,
`postgres://...:<password>@...` 또는 `postgresql://...:<password>@...`, Upbit access/secret key literal, Telegram bot token literal,
TUI control token literal, `Authorization: Bearer ...`, `authorization: bearer ...`, `raw_provider_payload`, `rawProviderPayload`,
`raw_order_detail`, `rawOrderDetail`)를 스캔한 증거를 포함해야 한다.
일반 영어 단어 `market`은 정상 market 설정/문서에도 반복되므로 empty-match가 필요한 금지 주문 scan term으로 쓰지 않고,
정상 차단 설정에 반복되는 `market_order` 단독 term도 필수 empty-match scan으로 쓰지 않는다. 금지 scope, 시장가, futures/leverage 같은
도메인 단어도 guard와 문서에 정상적으로 등장하므로, source scan은 단어 자체가 아니라 운영 runtime에서 위험 toggle이 `true`로 열리는
정밀 패턴을 찾는다. secret도 env var 이름, TypeScript property 이름, placeholder 예제가 아니라 실제 값이 하드코딩된 형태만 찾는다.
`withdraw`/`출금`, `deposit`/`입금`, `access_key`/`accessKey`처럼 대체 표기가 있는 검색어는 각 표기를 개별로 포함해야 하며,
`xaccess_key`처럼 검색어 앞뒤에 식별자 문자를 붙인 fake term은 coverage로 인정하지 않는다. source/security scan 명령은
shell의 `RIPGREP_CONFIG_PATH`, `.gitignore`, hidden 기본 필터 영향을 받지 않도록 `--no-config`와 `-uuu` 또는 `--hidden --no-ignore`를 포함해야 한다. 위 runtime source path들은 검색 패턴 문자열이 아니라 `rg` argv의 실제 path operand로 들어가야 하며, `true`,
`echo rg ...`, 일부 토큰만 확인한 명령, 검색어가 아닌 path operand에 금지 패턴 단어를 붙인 명령,
`-q`/`--quiet`, `-l`/`--files-without-match`, `--files`, `-F`/`--fixed-strings`, `-f`/`--file`,
`-P`/`--pcre2`/`--engine=pcre2`, `-w`/`--word-regexp`, `-x`/`--line-regexp`, `-v`/`--invert-match`, `-c`/`--count`/`--count-matches`,
`-m`/`--max-count`, `-M`/`--max-columns`,
`-d`/`--max-depth`, `-I`/`--no-filename`, `--stop-on-nonmatch`, `--ignore`, `--no-hidden`, `-N`/`--no-line-number`, `-r`/`--replace`, `--type-list`, `--pcre2-version`, `-t`/`--type`, `--type-not`,
`--iglob`, `--ignore-file`, `--max-filesize`, `--pre`/`--pre-glob`, `-g`/`--glob`
처럼 출력, 입력, 필수 범위, 정규식 의미를 줄이는 옵션은 인정하지 않는다. source/security scan command에 shell pipe,
redirect, command separator, shell comment(`#`), newline separator, command substitution, shell parameter expansion이 있거나 검색 패턴에서 alternation을 `\|`로 escape해 실제 다중 후보 검색을 하지 않는 경우도
검증 증거로 인정하지 않는다. `-g`가 `-ng'!src/**'`처럼 short-option cluster에 붙어도 exclude glob으로 판정해야 하며,
`--field-match-separator` 같은 값 있는 출력 옵션의 값에 검색어를 넣은 command는 coverage가 아니다. `--` 뒤 토큰은 더 이상 `rg` option으로 세지 않는다.
`-n`/`--line-number`는 quoted 검색 패턴 내부 문자열이 아니라 실제 `rg` argv 옵션이어야 한다. lookaround처럼 `rg`가 parse하지 못해 검색 자체가 실패하는 정규식 패턴도 source coverage 증거가 아니다.
주문 lifecycle timestamp는 validator 실행 시각보다 미래일 수 없고, 같은 주문 chain
증거는 `<redacted>`, `<order-id>`, `<brokerOrderId>` 같은 일반 placeholder가 아니라 identifier 또는 uuid의 안정적인 suffix로 비교할 수 있어야 한다. timestamp는
`2026-06-15T00:00:00.000Z`처럼 시간 성분을 포함해야 하며 날짜만 있는 값이나 `2026-02-30T...`처럼 정규화되는 불가능한 calendar date는 lifecycle 증거가 아니다. artifact safe summary의
중첩 객체와 배열 안의 `status`, `terminalState`/`terminal_state`, 주문 정책 필드(`market`, `side`, `orderType`/`order_type`/`ord_type`, `timeInForce`/`time_in_force`,
`requestedNotionalKrw`/`requested_notional_krw`), lifecycle timestamp, exposure/counter 값은 manifest의 closeout 값과 충돌하면 안 된다.
manifest `run`에 `orderType`, `order_type`, `ord_type` alias가 함께 있으면 모든 값이 `LIMIT`로 일치해야 하며, alias 간 충돌은
운영 주문 정책 증거 실패로 본다. `timeInForce`, `time_in_force` alias도 모두 `POST_ONLY`로 일치해야 한다.
manifest와 artifact는 fixture-only marker(`kind`의 `FIXTURE`, `fixture smoke` 문구)를 포함하면 안 된다. artifact는 parse 가능한 JSON safe summary여야 하며, fixture-only marker는 JSON escape를 decode한 뒤에도 guarded closeout
증거로 쓸 수 없다. 각 artifact마다 성공 status, terminal cancel, 주문 정책, submit/cancel/terminal
timestamp, 같은 주문 suffix, open exposure 0 evidence가 최소 한 closeout record에 있어야 한다. 주문 suffix는 `identifierSuffix`,
`cancelIdentifierSuffix`, `brokerOrderIdSuffix`, `cancelBrokerOrderIdSuffix`뿐 아니라 `identifier`, `cancel_identifier`,
`brokerOrderId`/`broker_order_id`, `cancelBrokerOrderId`/`cancel_broker_order_id` alias도 허용한다. 제공된 identifier pair와 broker order id pair는
각각 누락 없이 같은 suffix로 일치해야 하며, 한 pair가 맞더라도 다른 pair가 충돌하면 같은 주문 chain 증거가 아니다. closeout record의 artifact status는
`passed`, `success`, `ok`, `completed` 같은 명시적 성공 상태만 허용하며 `skipped`, `blocked`, `partial`은 closeout PASS 증거가 아니다.
`TIMEOUT`, `ERROR_TIMEOUT`, `BLOCKED_BY_RISK`, `RISK_BLOCKED`, `MANUAL_REVIEW_REQUIRED`처럼 timeout/failure/manual-review status와 prefix/suffix에 원인 코드가 붙은 wrapper status도 artifact-level failure로 본다.
validator가 안전하게 검사할 수 있는 중첩 depth를 넘은 artifact branch도 조용히 무시하지 않고 실패 evidence로 본다.
주문 closeout이 아닌 provider/market/Telegram safe summary의 일반 `status` 값은 closeout status로 해석하지 않는다.

`artifactPaths`는 symlink를 따라간 실제 경로도 저장소 밖이어야 하며, secret 원문, raw Authorization/Bearer/JWT, Telegram token URL,
database URL/password 원문, `databaseUrl`/`database_url`, `database_password`/`db_password`/`pg_password`, `raw_provider_payload`/`rawProviderPayload`/
`raw_order_detail`/`rawOrderDetail` 같은 raw payload 필드 또는 문자열 로그 없이 redacted safe summary만 가리켜야 한다.
JSON credential 값은 `<redacted>`, `redacted`, `[redacted]` 같은 placeholder와 정확히 일치해야 하며, placeholder 뒤에 원문 일부를
공백, 쉼표, 세미콜론, JSON 조각 형태로 덧붙이면 secret leak으로 본다. env assignment 형태도 placeholder 뒤에 원문이 붙으면 secret leak으로 본다.
`DATABASE_URL` env assignment도 password 포함 여부와 무관하게 DB URL 원문이면 secret leak으로 본다. TUI control token도
`SEEMIRAI_TUI_CONTROL_TOKEN` env assignment와 `tuiControlToken`/`tui_control_token` JSON field 모두 secret 후보로 차단한다.
`KEY: value` 형태의 로그도 env assignment와 같은 secret 후보로 본다. raw text뿐 아니라 JSON string escape를 decode한 key/value도
같은 redaction 기준으로 스캔하므로 `\u003d`, `\u005f` 같은 escape로 env assignment나 raw payload key를 숨길 수 없다.
Telegram URL은 method path가 없어도 `https://api.telegram.org/bot...` 뒤 원문 token이 있으면 실패하며, `<redacted>` 뒤에 raw
token tail이 붙은 URL도 redacted 값으로 보지 않는다. Bearer/JWT와 raw provider/order payload도 placeholder 뒤에 토큰이나 payload
일부가 공백이나 punctuation으로 이어지면 redacted 값으로 보지 않는다. quote로 감싼 `<redacted>` 뒤에 raw payload tail을 붙인
문자열도 redacted 값으로 보지 않는다. 운영 env 값 내부에 `<redacted>`/`redacted`/`[redacted]` 조각이 남아 있으면 실제 credential
evidence가 아니다. `SEEMIRAI_TELEGRAM_BOT_TOKEN` 같은 env 이름 그대로의 JSON field도 secret 후보로 본다. lowercase `bearer`
token과 `eyJ...` 형태의 prefix 없는 compact JWT도 raw secret 후보로 차단한다. `seemiraiUpbitSecretKey`, `seemiraiTelegramBotToken`처럼
SEEMIRAI prefix를 camelCase로 쓴 credential JSON field, `upbit-secret-key` 같은 hyphenated credential JSON field, generic `token` JSON field도 raw secret 후보로 차단한다.
JSON escape를 decode한 뒤 보이는 `raw_provider_payload`/`rawProviderPayload` 같은 raw payload key는 값이 비어 있어도 safe summary에 둘 수 없다.
source/security scan command나 match에 secret 후보가 섞인 경우 validator summary에는 command/pattern/match 원문을 다시 쓰지 않고 count, path, line, label 같은
축약 정보와 redacted marker만 남겨야 한다.

## Closeout 판정

PASS:

- submit -> cancel requested -> terminal cancel 확인이 같은 attempt/identifier chain으로 이어진다.
- open exposure 0, duplicate order 0, reconcile mismatch 0, untracked fill 0, live order cleanup failure 0이 증명된다.
- 운영 config/env 파일과 key scope safe summary가 존재하고, 출금/입금/선물/레버리지 권한이 없음이 증명된다.
- Telegram/TUI/status가 한국어 상태, 원인, 영향, 필요 조치와 추적 정보를 분리해 표시한다.
- secret/raw provider payload 후보가 source scan과 artifact redaction 검사에서 발견되지 않는다.

BLOCKED:

- 운영 credential, key scope evidence, DB, Telegram owner chat, redacted artifact 경로 중 하나가 없다.
- Upbit provider가 주문 결과를 확정하지 못해 manual review가 필요하다.
- cancel terminal 상태를 확인하지 못했다.
- source/security scan에서 secret 또는 금지 주문 경계가 발견됐다.
- closeout validator가 guard skipped 또는 manifest 검증 실패 상태를 반환했다.

## 기록 형식

PR과 issue에는 저장소 밖 artifact의 redacted 경로와 safe summary만 남긴다. access key, secret key, JWT, Authorization header,
Telegram token, raw provider payload, raw order detail은 기록하지 않는다.
