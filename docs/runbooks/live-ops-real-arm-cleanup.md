# Live Ops 실거래 arm cleanup runbook

이 runbook은 Issue #206의 production `live:ops` 경로를 실제 Upbit 주문 가능 상태로 검증하고, 단일 소액 주문을 제출한 뒤 같은
identifier 또는 uuid로 취소해 terminal cancel evidence로 닫는 절차다.

## 사용 조건

- 대상 command: `corepack pnpm live:ops -- --config <운영-json-path> --env-file <운영-env-path> --tui`
- 대상 mode: `LIVE_AUTONOMOUS_SMALL_BUDGET`
- 대상 market: `KRW-BTC`
- 허용 주문: `BUY + LIMIT + post_only`
- 첫 주문 상한: 10,000 KRW
- evidence 위치: 저장소 밖 redacted 운영 경로

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
| private read | account/order/balance 조회가 가능하고 raw payload 없이 safe summary로 낮아진다 |
| reconcile | mismatch 0건, untracked fill 0건, open order와 open exposure가 설명 가능하다 |
| PnL/status | 결측은 0으로 보정하지 않고 원인과 필요한 조치를 표시한다 |
| Telegram | startup/live order capable/order/cancel/manual review alert를 owner chat으로 보낼 수 있다 |
| TUI | live armed/order capable, 최신 decision/order/cancel/reconcile/PnL 상태를 secret 없이 보여준다 |

## 실행 절차

1. 저장소 밖 운영 env와 key 파일을 source하지 말고, `--env-file` 경로로만 전달한다.
2. fixture smoke가 아니라 실제 운영 config/env로 foreground TUI를 시작한다.

```sh
corepack pnpm live:ops -- --config <운영-json-path> --env-file <운영-env-path> --tui
```

3. TUI와 Telegram에서 startup alert와 live order capable 전환을 분리해 확인한다.
4. 단일 `KRW-BTC` 후보가 생성되면 cost/risk/reconcile/budget/kill switch guard evidence가 모두 통과했는지 확인한다.
5. 주문이 제출되면 artifact에 다음 safe summary만 남긴다.

```text
submitted_at=<ISO timestamp>
market=KRW-BTC
side=BUY
order_type=LIMIT
time_in_force=POST_ONLY
requested_notional_krw<=10000
identifier=<redacted/stable suffix only>
broker_order_id=<redacted/stable suffix only>
```

6. 같은 Upbit `identifier` 또는 uuid로 취소 요청을 보낸다.
7. terminal cancel 상태, open exposure 0, duplicate order 0, reconcile mismatch 0, manual review 0을 확인한다.
8. source/security scan과 artifact redaction 검증을 실행한 뒤 PR/closeout에 결과를 기록한다.

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
attach 명령, 추가/중복 인자, 상대 `config/env` 경로가 붙은 명령은 closeout 증거가 아니다. `configPath`와 `envFilePath`, manifest 파일
자체는 저장소 밖에 실제 파일로 존재해야 하며 symlink를 따라간 실제 경로도 저장소 밖이어야 한다. config JSON은 실제 foreground wrapper와
같은 허용 key set만 사용할 수 있고, production
`LIVE_AUTONOMOUS_SMALL_BUDGET` contract와 `KRW-BTC` 단일 universe, live trading on, paper/no-risk flags off, small-budget/TUI/Telegram
설정을 만족해야 한다. env 파일은 DB, Upbit key, key scope evidence, Telegram, TUI control token 값이 실제로 있어야 하며, key scope는
`자산조회`, `주문조회`, `주문하기` 외 추가 권한이 없어야 한다. env의 `SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID`는 manifest의
`keyScopeEvidenceId`와 같아야 한다. M22/M23 smoke guard나 placeholder 값으로 대체할 수 없고, foreground 실행 당시 shell에 남아 있던
M22/smoke legacy env도 production contract 위반으로 본다. 이 저장소 경계는 validator를 어느 작업 디렉터리에서 실행하더라도 repository
root 기준으로 판정한다.

`keyScope`는 `grantedScopes: ["자산조회", "주문조회", "주문하기"]`, `forbiddenScopesAbsent: ["출금하기"]`,
`withdrawalEnabled: false`처럼 허용 scope와 출금 권한 부재를 redacted safe summary로 기록한다. source/security scan은 실제 `rg -n`
명령으로 repository root에서 `src scripts config docs` 전체 범위의 금지 주문 경계 전체(`ord_type`, market/best 주문, 출금/입금,
leverage/futures/margin)와 secret/raw payload 후보 전체(access/secret key, 대문자 `ACCESS_KEY`/`SECRET_KEY`,
Authorization/Bearer, JWT, Telegram token, raw provider/order payload)를 스캔한 증거를 포함해야 한다. source/security scan 명령은
shell의 `RIPGREP_CONFIG_PATH` 영향을 받지 않도록 `--no-config`를 포함해야 한다. `src scripts config docs`는 검색 패턴 문자열이 아니라 `rg` argv의 실제 path operand로 들어가야 하며, `true`,
`echo rg ...`, 일부 토큰만 확인한 명령, 검색어가 아닌 path operand에 금지 패턴 단어를 붙인 명령,
`-q`/`--quiet`, `-l`/`--files-without-match`, `--files`, `-F`/`--fixed-strings`, `-f`/`--file`,
`-P`/`--pcre2`/`--engine=pcre2`, `-x`/`--line-regexp`, `-v`/`--invert-match`, `-m`/`--max-count`, `-t`/`--type`, `--type-not`,
`--iglob`, `--ignore-file`, `--max-depth`, `--max-filesize`, `--pre`/`--pre-glob`, `-g`/`--glob`
처럼 출력, 입력, 필수 범위, 정규식 의미를 줄이는 옵션은 인정하지 않는다. source/security scan command에 shell pipe,
redirect, command separator, command substitution이 있거나 검색 패턴에서 alternation을 `\|`로 escape해 실제 다중 후보 검색을 하지 않는 경우도
검증 증거로 인정하지 않는다.
주문 lifecycle timestamp는 validator 실행 시각보다 미래일 수 없고, 같은 주문 chain
증거는 `<redacted>`, `<order-id>`, `<brokerOrderId>` 같은 일반 placeholder가 아니라 identifier 또는 uuid의 안정적인 suffix로 비교할 수 있어야 한다. artifact safe summary의
중첩 객체와 배열 안의 `status`, `terminalState`/`terminal_state`, 주문 정책 필드(`market`, `side`, `orderType`/`order_type`/`ord_type`, `timeInForce`/`time_in_force`,
`requestedNotionalKrw`/`requested_notional_krw`), lifecycle timestamp, exposure/counter 값은 manifest의 closeout 값과 충돌하면 안 된다.
manifest `run`에 `orderType`, `order_type`, `ord_type` alias가 함께 있으면 모든 값이 `LIMIT`로 일치해야 하며, alias 간 충돌은
운영 주문 정책 증거 실패로 본다.
artifact는 parse 가능한 JSON safe summary여야 하며, fixture-only marker(`kind`의 `FIXTURE`, `fixture smoke` 문구)는 guarded closeout
증거로 쓸 수 없다. 각 artifact마다 성공 status, terminal cancel, 주문 정책, submit/cancel/terminal
timestamp, 같은 주문 suffix, open exposure 0 evidence가 최소 한 closeout record에 있어야 한다. 주문 suffix는 `identifierSuffix`,
`cancelIdentifierSuffix`, `brokerOrderIdSuffix`, `cancelBrokerOrderIdSuffix`뿐 아니라 `identifier`, `cancel_identifier`,
`brokerOrderId`/`broker_order_id`, `cancelBrokerOrderId`/`cancel_broker_order_id` alias도 허용한다. closeout record의 artifact status는
`passed`, `success`, `ok`, `completed` 같은 명시적 성공 상태만 허용하며 `skipped`, `blocked`, `partial`은 closeout PASS 증거가 아니다.
`ERROR_TIMEOUT`, `BLOCKED_BY_RISK`처럼 실패 prefix에 원인 suffix가 붙은 wrapper status도 artifact-level failure로 본다.
주문 closeout이 아닌 provider/market/Telegram safe summary의 일반 `status` 값은 closeout status로 해석하지 않는다.

`artifactPaths`는 symlink를 따라간 실제 경로도 저장소 밖이어야 하며, secret 원문, raw Authorization/Bearer/JWT, Telegram token URL,
database password 원문, `database_password`/`db_password`/`pg_password`, `raw_provider_payload`/`rawProviderPayload`/
`raw_order_detail`/`rawOrderDetail` 같은 raw payload 필드 또는 문자열 로그 없이 redacted safe summary만 가리켜야 한다.
JSON credential 값은 `<redacted>`, `redacted`, `[redacted]` 같은 placeholder와 정확히 일치해야 하며, placeholder 뒤에 원문 일부를
공백, 쉼표, 세미콜론, JSON 조각 형태로 덧붙이면 secret leak으로 본다. env assignment 형태도 placeholder 뒤에 원문이 붙으면 secret leak으로 본다. TUI control token도
`SEEMIRAI_TUI_CONTROL_TOKEN` env assignment와 `tuiControlToken`/`tui_control_token` JSON field 모두 secret 후보로 차단한다.
`KEY: value` 형태의 로그도 env assignment와 같은 secret 후보로 본다. raw text뿐 아니라 JSON string escape를 decode한 key/value도
같은 redaction 기준으로 스캔하므로 `\u003d`, `\u005f` 같은 escape로 env assignment나 raw payload key를 숨길 수 없다.
Telegram URL은 method path가 없어도 `https://api.telegram.org/bot...` 뒤 원문 token이 있으면 실패하며, `<redacted>` 뒤에 raw
token tail이 붙은 URL도 redacted 값으로 보지 않는다. Bearer/JWT와 raw provider/order payload도 placeholder 뒤에 토큰이나 payload
일부가 공백이나 punctuation으로 이어지면 redacted 값으로 보지 않는다. `SEEMIRAI_TELEGRAM_BOT_TOKEN` 같은 env 이름 그대로의
JSON field도 secret 후보로 본다. lowercase `bearer` token과 `eyJ...` 형태의 prefix 없는 compact JWT도 raw secret 후보로 차단한다.
source/security scan이 secret match를 찾은 경우 validator summary에는 match 원문을 다시 쓰지 않고 count, path, line, label 같은
축약 정보만 남겨야 한다.

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
