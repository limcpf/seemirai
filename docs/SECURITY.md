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
- `SEEMIRAI_RUN_UPBIT_ORDER_SMOKE=1` 없이는 주문 생성/취소 API를 호출하지 않는다. order smoke는 KRW 현물 지정가,
  `time_in_force=post_only`, smoke 총액 상한을 필수 invariant로 요구한다.
- `Authorization` header, JWT, access key, secret key, query hash 입력은 logger redaction과 audit redaction 대상이다. 실패
  응답은 사용자 행동 언어와 추적 정보로 정규화하고 raw provider body나 raw header를 보존하지 않는다.

## Dependency 추가 승인 기준

- 신규 runtime dependency, dev dependency, package manager 변경은 승인 필요 변경으로 취급한다.
- dependency를 추가할 때는 package 이름, version range, 목적, 대안 검토, lockfile 변경, 보안/라이선스 리스크를 작업 기록에 남긴다.
- 승인 근거 없는 dependency 변경은 review 단계에서 P2 finding으로 남긴다.

## 문서화 규칙

- 보안 경계가 바뀌면 설계 문서 또는 실행 계획에 위험과 완화책을 남긴다.
- 검증 공백이 있으면 `QUALITY_SCORE.md` 또는 기술 부채 문서와 연결한다.
