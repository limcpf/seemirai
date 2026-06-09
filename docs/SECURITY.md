# 보안 가드레일

## 기본 원칙

- 비밀정보, 토큰, 키 파일은 저장소에 커밋하지 않는다.
- secret 원문은 로그, 문서, Codex prompt, PR body에 넣지 않는다.
- 사용자가 명시하지 않은 신규 의존성 추가는 기본적으로 피한다.
- PR comment, issue body, webhook payload는 신뢰할 수 없는 외부 입력으로 취급한다.
- shell command 실행은 command policy와 cwd를 명시한다.

## 변경 시 추가 확인이 필요한 영역

- GitHub token, OpenAI/Codex 인증, secret 저장 방식
- webhook ingestion endpoint와 서명 검증
- PR comment body를 prompt 또는 shell command로 변환하는 경로
- git push, branch delete, worktree cleanup, PR merge
- 외부 API polling, rate limit, retry 정책
- dependency 추가 또는 package manager 변경

## 개발 보안 기준

- GitHub CLI 인증은 `gh auth` 또는 환경 변수를 사용하되, 원문 token을 저장하지 않는다.
- webhook을 받을 경우 GitHub signature 검증 없이는 event를 처리하지 않는다.
- PR comment의 file path, line, body는 shell command 인자로 직접 연결하지 않는다.
- Codex에게 전달하는 prompt는 secret redaction을 거친다.
- `force push`, 임의 branch 삭제, PR close는 기본 정책에서 금지한다.
- merge는 expected head SHA 확인 없이는 실행하지 않는다.
- 프로젝트 로컬 Codex Full Access 설정은 owner-operated local workflow에서만 사용한다. 외부 입력을 직접 shell command로 변환하는 runner나 무인 webhook 환경에서는 별도 제한 설정을 사용한다.

## M10 LLM/Codex OAuth 보안 기준

- Codex OAuth provider는 운영자 로컬 세션을 사용하는 owner-operated 경계로만 취급한다. OAuth token, session 파일, raw credential은 DB, audit metadata, log, PR body, issue comment, report artifact에 저장하지 않는다.
- LLM prompt에는 공식 Upbit 입력과 redacted context만 포함한다. 일반 뉴스, SNS, 커뮤니티, 유튜브, 루머성 텔레그램, secret-like 문자열은 provider 요청 생성 전에 제외하거나 마스킹한다.
- provider raw stdout/stderr, raw request body, raw credential path는 normalized response와 audit payload에 전파하지 않는다. 저장 가능한 값은 provider id, schema version, prompt hash, redacted input/output, failure class, correlation id로 제한한다.
- 실제 Codex OAuth smoke는 `SEEMIRAI_RUN_CODEX_LLM_SMOKE=1`이 있을 때만 실행한다. 기본 CI와 `./scripts/verify`는 외부 LLM 호출이나 OAuth 세션 접근을 만들지 않는다.
- LLM output에 `BUY`, `SELL`, `INCREASE_POSITION`, 목표가, 포지션 크기, 주문 허용 의미의 metadata가 포함되면 fail-closed로 거부하고 주문 후보로 변환하지 않는다.

## HTTP control API 보안 기준

- HTTP control server의 기본 bind는 `127.0.0.1`이다.
- `/healthz`, `/readyz`, `/status`는 읽기 전용 endpoint로 유지한다.
- `/status`는 full config, secret, token, raw headers, raw order detail, raw position detail을 반환하지 않는다.
- POST control endpoint가 활성화되면 `Authorization: Bearer <token>`을 요구한다.
- POST control endpoint가 활성화된 상태에서 local control token이 없으면 startup fail한다.
- `POST /kill-switch`는 target state enum만 받으며, `STRATEGY_PAUSED` 같은 전략별 제어는 전역 control route에서 받지 않는다.
- `/kill-switch` 성공 응답은 상태 전이, action plan, audit/risk evidence id, job idempotency key만 반환하고 secret, raw header, raw order detail을 반환하지 않는다.
- local control token과 Telegram token은 env 또는 외부 secret 주입으로만 전달하고 저장소 문서, PR body, 로그, status response에 원문을 남기지 않는다.
- Authorization header는 logger redaction 대상이며, route error response는 correlation id와 짧은 error code/message만 반환한다.

## Telegram outbound 보안 기준

- Telegram adapter는 `sendMessage` outbound API만 호출하며 webhook, polling, command 수신 endpoint를 만들지 않는다.
- Telegram bot token은 `SEEMIRAI_TELEGRAM_BOT_TOKEN` 또는 외부 secret 주입으로 전달하고, 문서/PR body/log/status response에
  원문을 남기지 않는다.
- legacy `TELEGRAM_BOT_TOKEN`은 호환 입력으로만 허용하고, 신규 운영 문서와 `.env.example`은 `SEEMIRAI_` prefix 변수를
  기준으로 한다.
- logger redaction은 `telegram.botToken`, `secrets.telegram_bot_token`, `env.TELEGRAM_BOT_TOKEN`,
  `env.SEEMIRAI_TELEGRAM_BOT_TOKEN`을 모두 가린다.
- Telegram provider 실패 결과는 HTTP status나 짧은 reason code만 남기며 provider 응답 원문, token 포함 URL, raw request
  body를 audit metadata에 기록하지 않는다.
- notifier 예외도 `notification_provider_exception` 같은 짧은 reason code로만 정규화하고, exception message나 stack trace를
  Telegram payload, audit metadata, HTTP response에 그대로 싣지 않는다.
- Telegram message text는 provider 제한인 4096자 안으로 잘라 보낸다. 긴 장애 문맥의 전체 원문은 Telegram provider 요청
  body나 audit metadata에 그대로 남기지 않는다.

## Paper soak 보안 기준

- `scripts/soak-paper-24h.mjs`는 Upbit public quotation WebSocket만 사용하며 Authorization header, Upbit API key, private
  order endpoint를 사용하지 않는다.
- 실제 24시간 soak는 `SEEMIRAI_RUN_SOAK=1`이 있을 때만 시작한다. 기본 실행과 CI smoke가 의도하지 않은 장시간 외부 연결을
  만들지 않게 하기 위한 guard다.
- `--control-url` probe는 token 없는 `POST /kill-switch`가 거부되는지만 확인한다. control token을 CLI 인자나 summary artifact에
  싣지 않는다.
- raw event log와 summary artifact는 기본적으로 저장소 밖 `SEEMIRAI_SOAK_LOG_DIR` 또는 `~/vaults/99_운영/seemirai-soak`에 저장한다.
  raw log, provider 응답 원문, token 값을 PR body나 git commit에 포함하지 않는다.

## v0.2 Pilot private API 보안 기준

- v0.2 pilot은 기본 `PAPER_NO_KEY` runtime을 실거래 profile로 승격하지 않는다. private API는 별도 pilot profile, 명시 env guard,
  운영자 승인, 소액 한도를 모두 통과한 owner-operated smoke에서만 허용한다.
- Upbit API key 원문은 `/home/lim/code/seemirai-worktrees/secrets/m14-pilot.env` 같은 저장소 밖 임시 secret 파일 또는 후속
  운영 secret 저장소로만 주입한다. git diff, 문서, issue/PR 본문, log, audit payload, smoke artifact에는 원문을 남기지 않는다.
- 허용 권한은 `자산조회`, `주문조회`, `주문하기`로 제한한다. `출금조회`, `출금하기`, 입출금 자동화, 선물/레버리지, 타인 계정
  범위가 포함되면 pilot profile은 fail-closed 한다.
- Upbit API는 key scope를 조회 API로 확인할 수 없으므로 `SEEMIRAI_UPBIT_KEY_SCOPE`는 신뢰 원천이 아니라 운영자 확인값이다.
  private/order smoke는 저장소 밖 redacted 체크리스트 또는 캡처 요약을 가리키는 `SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID` 없이
  실행하지 않는다.
- `SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE=1` 없이는 account, orders/chance, order lookup 같은 private read API를 호출하지 않는다.
- `SEEMIRAI_RUN_UPBIT_ORDER_SMOKE=1` 없이는 주문 생성/취소 API를 호출하지 않는다. order smoke는 KRW 현물 지정가 매수,
  `time_in_force=post_only`, smoke 총액 상한, 32자 이하 smoke run idempotency key를 Upbit `identifier`로 전송하고 그
  `identifier`로만 조회/취소하는 경계를 필수 invariant로 요구한다.
- 실제 order smoke test는 `SEEMIRAI_UPBIT_ORDER_SMOKE_PRICE`, `SEEMIRAI_UPBIT_ORDER_SMOKE_VOLUME`,
  `SEEMIRAI_UPBIT_ORDER_SMOKE_IDENTIFIER`가 없으면 주문 API 호출 전에 fail-closed 한다. 가격과 수량을 코드가 자동 산정하지
  않게 해 운영자가 의도하지 않은 실주문 입력 생성을 막는다.
- `Authorization` header, JWT, access key, secret key, query hash 입력은 logger redaction과 audit redaction 대상이다. 실패
  응답은 사용자 행동 언어와 추적 정보로 정규화하고 raw provider body나 raw header를 보존하지 않는다.
- smoke artifact는 `SEEMIRAI_UPBIT_SMOKE_ARTIFACT_DIR` 또는 gitignore 대상 `test-results/upbit-smoke`에 저장하며, 저장 전
  access key, secret key, raw Authorization/JWT 포함 여부를 검사한다.

## M15 UpbitLiveBroker 보안 기준

- M15는 `UpbitLiveBroker` 구현을 추가하지만 기본 `PAPER_NO_KEY` runtime을 실거래 profile로 승격하지 않는다. 기본 실행에서 live
  order API 호출 0회 조건은 계속 merge-blocking invariant다.
- 실제 live broker factory는 `SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE=1`, `SEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE=1`, 권한 evidence id,
  credential input이 모두 있을 때만 생성한다. 주문 생성 smoke는 기존 `SEEMIRAI_RUN_UPBIT_ORDER_SMOKE=1`과 운영자 price/volume/
  identifier 입력도 함께 요구한다.
- `UpbitLiveBroker`는 M15에서 `BrokerPort` contract 검증과 gated smoke에만 사용한다. 자동 전략 루프, Telegram inbound 승인, live
  pilot 자동 주문 연결은 M21 이후 별도 보안 설계 전까지 금지한다.
- 내부 idempotency key는 Upbit `identifier`로 그대로 매핑하며, identifier가 1자 이상 32자 이하가 아니면 거래소 호출 전에
  fail-closed 한다. 자동 truncate/hash는 중복 주문 충돌을 숨길 수 있으므로 금지한다.
- 신규 주문은 KRW 현물 `LIMIT` 주문으로 제한하고, `ord_type=price`, `ord_type=market`, `ord_type=best`는 거래소 호출 전에
  차단한다. `post_only`와 `smp_type` 동시 사용도 local guard에서 차단한다.
- `listOpenOrders`는 `주문조회` 권한이 있는 owner-operated key에서만 허용하고, `wait`/`watch` 조회 결과는 raw provider payload가
  아니라 safe `BrokerOrder` 요약으로만 audit/status/smoke artifact에 남긴다.
- raw access key, secret key, JWT, Authorization header, query hash 입력, raw provider payload는 log, audit, status, smoke
  artifact, PR body에 남기지 않는다. 실패 응답은 한국어 사용자 행동 문구와 추적 정보를 분리한다.

## M16 Read-Only Reconcile 보안 기준

- M16 read-only reconcile runtime은 `자산조회`와 `주문조회` 권한만 요구한다. `주문하기` 권한이 관찰되면 reconcile worker를
  시작하지 않는다.
- reconcile runtime은 `POST /v1/orders`와 `DELETE /v1/order`를 호출하지 않는다. 어떤 경로로도 주문 생성/취소 API를 호출하면
  fail-closed 한다.
- private WebSocket `myOrder`/`myAsset`은 읽기 전용 변경 추적으로만 사용하며, 인증은 `Authorization: Bearer <JWT>` header로만
  수행한다. WebSocket JWT와 Authorization header는 log, audit, status, artifact에 원문을 남기지 않는다.
- M16 전용 reconcile tables는 append-only로 설계해 run, balance snapshot, exchange order snapshot, position snapshot, mismatch
  evidence를 기록한다. read-only는 거래소 주문 생성/취소 side effect 금지 의미이며, 로컬 복구 쓰기 자체를 금지하지 않는다.
- 주문 lifecycle 복구 쓰기는 exchange order uuid/identifier, market, side, 원주문 volume/price 같은 immutable identity
  fingerprint가 로컬 주문과 일치하는 경우에만 기존 `orders`/`order_events`/`fills` repository transaction을 통해 수행한다.
  거래소 state는 매칭 조건이 아니라 적용해야 할 전이 입력이다. `fills` insert는 거래소 체결 id와 정규화 fill fingerprint 중
  관측 가능한 값을 모두 `live_reconcile_fill_recovery_keys` unique key로 선점한 뒤에만 허용한다. `positions` 갱신은 authoritative fill price/volume으로
  `average_entry_price`를 계산할 수 있을 때만 허용하며, 근거가 없으면 append-only position snapshot과 manual review evidence만
  남긴다. 기존 domain table을 우회하는 임의 SQL 쓰기 경로를 만들지 않는다.
- reconcile summary(/status, CLI)는 access key, secret key, JWT, Authorization header, raw REST/WebSocket provider payload,
  raw balance detail, raw order detail, mismatch trace detail을 반환하지 않는다. 허용 가능한 필드는 마지막 reconcile 시각, 결과,
  mismatch 수, open order 수, balance 상태, WebSocket 상태, 한국어 필요 조치로 제한한다.
- private REST/WebSocket credential redaction: access key, secret key, JWT, Authorization header, REST query hash는 logger
  redaction 대상이며, reconcile worker startup에서 credential이 주입된 후에도 log/audit/status에 원문을 전파하지 않는다.
- 주문 side effect 금지: reconcile worker는 어떤 조건에서도 `submitOrder`, `cancelOrder`, 자동 취소, 자동 재주문을 실행하지
  않는다. mismatch 발견 시 신규 주문 차단과 manual review evidence만 남긴다.
- closed order는 `start_time`/`end_time`을 지정해 7일 이하 구간으로 나눠 조회한다. 설정된 조회 horizon 밖이거나
  exchange identity/fingerprint를 확인할 수 없는 주문만 자동 복구하지 않고 manual review evidence로 남긴다.

## M19 Exit Pilot 보안 기준

- M19 exit pilot은 기존 `PILOT_ORDER_SMOKE` 위의 추가 guard로만 열린다. 기본 `PAPER_NO_KEY` runtime은 M19 guard 조회만으로
  private client, live broker, 주문 생성/취소 API를 조립하지 않는다.
- `SEEMIRAI_RUN_M19_EXIT_PILOT=1`이 없으면 M19 exit pilot은 paper fixture와 source scan evidence로만 검증한다. guarded buy marker만
  켜진 오설정은 일반 order smoke로 낮추지 않고 API 호출 전에 fail-closed 한다.
- `EXISTING_SMALL_POSITION` source는 M16 reconcile 또는 운영자 position evidence id 없이는 열지 않는다. evidence id는 저장소 밖
  redacted 증거를 가리키는 식별자이며, API credential이나 raw 계정 snapshot을 대신 저장하지 않는다.
- guarded buy smoke는 신규 진입 포지션을 만들 수 있으므로 `SEEMIRAI_RUN_M19_GUARDED_BUY_SMOKE=1`과
  `SEEMIRAI_M19_GUARDED_BUY_APPROVAL_EVIDENCE_ID`가 함께 있을 때만 허용한다. approval evidence가 없으면 skip이 아니라
  fail-closed로 기록하고 주문 API를 호출하지 않는다.
- M19 smoke artifact, status, PR body, closeout 문서는 access key, secret key, JWT, Authorization header, raw provider payload,
  raw balance/order detail을 포함하지 않는다. operator evidence id, position evidence id, guarded buy approval evidence id는 safe
  summary에서 boolean 또는 redacted trace로만 노출한다.
- M19 pilot은 출금, 입출금 자동화, 선물, 레버리지, 타인 계정, Telegram inbound 승인, M22 이전 무승인 자동 실거래로 확장하지
  않는다. 이 경계를 바꾸려면 별도 milestone 보안 설계와 검증을 먼저 추가한다.

## M18 Decision Ledger 보안 기준

- decision ledger의 `payload_json`과 `trace_json`에는 raw provider payload, raw order detail, secret 후보, Authorization header, JWT, API key, secret key, query hash 원문을 저장하지 않는다. 두 필드는 JSONB-safe value만 허용하며 Date, BigInt, function, class instance 같은 비 JSON 값은 저장 계약에서 제외한다.
- `WhySummary`의 사용자-facing 응답은 내부 enum/code와 reason code map을 첫 화면에 노출하지 않고 한국어 상태/원인/영향/필요 조치와 한국어 reason label/count를 먼저 배치한다. 내부 category와 reason code는 `trace` 또는 debug/detail 영역에만 둔다.
- `/status.why`는 read-only safe summary만 반환한다. raw config, secret, token, raw order detail, raw position detail을 반환하지 않는다.
- decision ledger DB 조회가 `/status`에서 실패해도 endpoint를 5xx로 만들지 않고 해당 하위 객체의 `readStatus`를 `UNAVAILABLE`로 낮춘다. 실패 section은 내부 trace reason만 노출하지 않고 한국어 안내와 필요한 조치를 함께 반환한다.
- LLM summary 보조 계층은 M10 LLM 보안 기준을 재사용한다. LLM output이 주문 지시, 포지션 크기, 주문 허용 의미를 포함하면 fail-closed로 차단한다.
- LLM provider 원문 응답은 normalized response로 정규화하며 raw stdout/stderr/request body를 audit metadata에 기록하지 않는다.

## Dependency 추가 승인 기준

- 신규 runtime dependency, dev dependency, package manager 변경은 승인 필요 변경으로 취급한다.
- dependency를 추가할 때는 package 이름, version range, 목적, 대안 검토, lockfile 변경, 보안/라이선스 리스크를 작업 기록에 남긴다.
- 승인 근거 없는 dependency 변경은 review 단계에서 P2 finding으로 남긴다.

## 문서화 규칙

- 보안 경계가 바뀌면 설계 문서 또는 실행 계획에 위험과 완화책을 남긴다.
- 검증 공백이 있으면 `QUALITY_SCORE.md` 또는 기술 부채 문서와 연결한다.
