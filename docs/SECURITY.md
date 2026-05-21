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
- Telegram message text는 provider 제한인 4096자 안으로 잘라 보낸다. 긴 장애 문맥의 전체 원문은 Telegram provider 요청
  body나 audit metadata에 그대로 남기지 않는다.

## Dependency 추가 승인 기준

- 신규 runtime dependency, dev dependency, package manager 변경은 승인 필요 변경으로 취급한다.
- dependency를 추가할 때는 package 이름, version range, 목적, 대안 검토, lockfile 변경, 보안/라이선스 리스크를 작업 기록에 남긴다.
- 승인 근거 없는 dependency 변경은 review 단계에서 P2 finding으로 남긴다.

## 문서화 규칙

- 보안 경계가 바뀌면 설계 문서 또는 실행 계획에 위험과 완화책을 남긴다.
- 검증 공백이 있으면 `QUALITY_SCORE.md` 또는 기술 부채 문서와 연결한다.
