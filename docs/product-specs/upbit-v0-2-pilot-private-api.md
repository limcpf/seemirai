# Upbit v0.2 Pilot Private API 업무 명세

- 상태: draft
- 작성일: 2026-06-01
- 관련 이슈: [#124](https://github.com/limcpf/seemirai/issues/124)
- 기준 문서: [`./upbit-krw-paper-trading-mvp.md`](./upbit-krw-paper-trading-mvp.md), [`../SECURITY.md`](../SECURITY.md), [`../RUNTIME_CONFIG.md`](../RUNTIME_CONFIG.md)

## 1. 목적

v0.2 pilot은 MVP `PAPER_NO_KEY` runtime을 실거래 profile로 바꾸는 작업이 아니다. 목적은 Upbit private API를 안전한 별도 profile에서 검증하고, 운영자가 명시한 최소 금액의 KRW 현물 지정가 주문 생성/취소 smoke까지 증거로 남기는 것이다.

M14 기준:

```text
v0.2 pilot = Upbit KRW 현물 + owner-operated private API + gated small limit order smoke
```

기본 runtime은 계속 API key 없이 시작해야 한다. private API 호출은 명시 profile, env guard, API key scope 확인, 소액 한도, 운영자 승인 guard를 모두 통과해야만 발생한다.

## 2. 비범위

- 기본 `config/paper.json` 또는 `PAPER_NO_KEY` runtime의 실거래 승격
- 무인 실거래 운영
- 시장가 신규 진입
- 출금조회, 출금하기, 입출금 자동화
- 선물, 레버리지, 거래소 간 차익거래
- 타인 계정 연결 또는 신호 판매
- 50,000 KRW 전체를 자동으로 소진하는 테스트
- 수익률 최적화 또는 전략 threshold activation

## 3. 단계

| 단계 | 목적 | 허용 API | 주문 side effect |
| --- | --- | --- | --- |
| `PAPER_NO_KEY` | 기본 MVP paper runtime | 공개 quotation API | 없음 |
| `PILOT_READ_ONLY` | 계정 잔고와 선택적 주문 조회 contract 확인 | `GET /v1/accounts`, `GET /v1/order?uuid=<uuid>` 또는 `GET /v1/order?identifier=<identifier>` | 없음 |
| `PILOT_POLICY_SYNC` | 계정 조건이 반영된 주문 가능 정보 확인 | `GET /v1/orders/chance` | 없음 |
| `PILOT_ORDER_SMOKE` | 최소 금액 지정가 생성/취소 smoke | `POST /v1/orders`, `DELETE /v1/order` | 운영자 승인 guard 통과 시 1회 |

`PILOT_READ_ONLY`의 개별 주문 조회는 운영자가 기존 `uuid` 또는 `identifier`를 명시한 경우에만 실행한다. Upbit 개별 주문 조회는 조회 식별자 하나가 필수이므로, 식별자가 없으면 계정 잔고 조회만 read-only 선행 검증으로 본다. `PILOT_ORDER_SMOKE`는 계정 잔고 조회와 `PILOT_POLICY_SYNC`가 실패하면 시작하지 않는다. 주문 생성 후 취소가 실패하거나 주문 상태를 확인하지 못하면 추가 주문을 시도하지 않고 manual review 상태로 수렴한다.

## 4. API Key 권한 matrix

| 기능 | Upbit 권한 | M14 허용 | 비고 |
| --- | --- | --- | --- |
| 계정 잔고 조회 | `자산조회` | 허용 | read-only smoke와 safe summary에만 사용 |
| 주문 가능 정보 조회 | `주문조회` | 허용 | `orders/chance` 정책 snapshot과 수수료 확인 |
| 개별 주문 조회 | `주문조회` | 허용 | smoke 생성/취소 결과 확인 |
| 주문 생성 | `주문하기` | 조건부 허용 | `PILOT_ORDER_SMOKE`와 별도 order guard 필요 |
| 주문 취소 | `주문하기` | 조건부 허용 | 생성한 smoke 주문 또는 지정한 uuid/identifier만 |
| 출금조회 | `출금조회` | 금지 | key scope에 포함되면 fail-closed |
| 출금하기 | `출금하기` | 금지 | key scope에 포함되면 fail-closed |
| 입금 자동화 | `입금조회`, `입금하기` | 금지 | M14 범위 아님 |

API key는 실제 실행 환경의 outbound 공인 IP allowlist가 등록된 owner-operated key만 사용한다. 사설 IP, 유동 IP, 타인 계정, 출금 권한이 포함된 key는 pilot profile에서 허용하지 않는다.

## 5. 임시 secret 주입

임시 secret 파일 후보:

```text
/home/lim/code/seemirai-worktrees/secrets/m14-pilot.env
```

권장 권한:

```sh
chmod 700 /home/lim/code/seemirai-worktrees/secrets
chmod 600 /home/lim/code/seemirai-worktrees/secrets/m14-pilot.env
```

표준 env:

| env | 의미 | 저장소 기록 가능 여부 |
| --- | --- | --- |
| `SEEMIRAI_UPBIT_ACCESS_KEY` | Upbit access key | 원문 금지 |
| `SEEMIRAI_UPBIT_SECRET_KEY` | Upbit secret key | 원문 금지 |
| `SEEMIRAI_UPBIT_KEY_SCOPE` | 운영자가 Upbit PC 웹에서 확인한 권한 목록 | scope 이름만 가능 |
| `SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID` | 저장소 밖 redacted 권한 확인 증거 ID | 가능 |
| `SEEMIRAI_PILOT_PROFILE` | `PILOT_READ_ONLY`, `PILOT_POLICY_SYNC`, `PILOT_ORDER_SMOKE` | 가능 |
| `SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE` | private smoke 실행 guard | 가능 |
| `SEEMIRAI_RUN_UPBIT_ORDER_SMOKE` | 실주문 smoke 별도 guard | 가능 |
| `SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET` | 첫 smoke market | 가능 |
| `SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW` | 첫 smoke 총액 상한 | 가능 |
| `SEEMIRAI_UPBIT_LOOKUP_ORDER_UUID` | read-only 주문 조회용 기존 주문 uuid | 가능 |
| `SEEMIRAI_UPBIT_LOOKUP_ORDER_IDENTIFIER` | read-only 주문 조회용 기존 주문 identifier | 가능 |

secret 원문은 git diff, 문서, issue/PR 본문, log, audit payload, smoke artifact에 남기지 않는다. 이 경로는 M14 임시 운영 편의 경계이며, 후속 hardening에서는 Docker Compose secrets 또는 운영 secret 저장 방식으로 승격한다.

`SEEMIRAI_UPBIT_KEY_SCOPE`는 API가 검증한 값이 아니라 운영자가 Upbit PC 웹 Open API 관리 화면에서 확인한 결과를 전달하는 수동 증거다. Upbit API Key 목록 조회는 권한 scope를 반환하지 않으므로, private smoke와 order smoke는 `SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID`가 가리키는 저장소 밖 redacted 체크리스트 또는 캡처 요약이 없으면 fail-closed 한다. 증거에는 access key 원문, secret key 원문, 전체 화면 캡처를 저장하지 않고, 허용 권한과 금지 권한 확인 결과만 남긴다.

## 6. 안전 invariant

- `PAPER_NO_KEY`는 API key 없이 로딩되고 private endpoint를 호출하지 않는다.
- pilot profile은 `PAPER_NO_KEY` 기본 profile로 자동 승격되지 않는다.
- `SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE=1` 없이는 private smoke test가 skip된다.
- `SEEMIRAI_RUN_UPBIT_ORDER_SMOKE=1` 없이는 주문 생성/취소 smoke가 skip된다.
- 주문 생성은 KRW 현물 지정가만 허용한다.
- 주문 생성은 `time_in_force=post_only`를 필수로 요구하고, Upbit 응답이나 profile이 이를 지원하지 않으면 skip 또는 fail-closed 한다.
- 신규 진입 시장가 주문, `ord_type=price`, `ord_type=market`, `ord_type=best`는 M14 order smoke에서 금지한다.
- 출금 권한, 시장가 신규 진입, 한도 초과, guard 누락, 인증 실패, 권한 부족, rate limit 차단은 fail-closed 한다.
- 실패한 smoke는 추가 주문을 만들지 않고 manual review evidence를 남긴다.
- raw `Authorization` header, JWT, access key, secret key는 logger redaction과 audit redaction 대상이다.

## 7. 첫 주문 smoke 기준

초기 smoke는 보수적 지정가 생성/취소 경로만 확인한다.

1. `GET /v1/accounts`로 KRW 사용 가능 금액을 확인한다.
2. `GET /v1/orders/chance?market=<market>`로 최소 주문금액, 주문 가능 유형, 수수료, 잔고를 확인한다.
3. 운영자가 명시한 `SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW`가 정책 최소 주문금액 이상이고 총 테스트 예산 50,000 KRW 이하인지 확인한다.
4. 지정가 가격과 수량은 `orders/chance`, public market policy, 운영자 입력을 기준으로 산정한다.
5. `ord_type=limit`, `time_in_force=post_only` 조건을 모두 갖춘 보수적 지정가 주문을 1회 생성한다.
6. 생성 직후 `DELETE /v1/order`로 취소한다.
7. `GET /v1/order`로 생성/취소 상태를 확인한다.
8. 결과 artifact에는 order uuid, market, side, price, volume, cancel status, correlation id, idempotency key, fee/balance 변화 요약만 남긴다.

첫 smoke의 대상 market, 지정가 산정 방식, 최대 KRW 금액은 실행 시점의 잔고와 Upbit 정책 조회 결과를 기준으로 최종 확정한다.

## 8. 공식 문서 확인 기준

2026-06-01 기준 확인한 Upbit Developer Center 문서를 구현 기준으로 사용한다.

- API 이용 준비: https://docs.upbit.com/kr/kr/docs/api-setup
- API Key 발급: https://docs.upbit.com/kr/docs/api-key
- 인증: https://docs.upbit.com/kr/reference/auth
- 요청 수 제한: https://docs.upbit.com/kr/reference/rate-limits
- 계정 잔고 조회: https://docs.upbit.com/kr/reference/get-balance
- 페어별 주문 가능 정보 조회: https://docs.upbit.com/kr/reference/available-order-information
- 개별 주문 조회: https://docs.upbit.com/kr/reference/get-order
- 주문 생성: https://docs.upbit.com/kr/kr/reference/new-order
- 개별 주문 취소 접수: https://docs.upbit.com/kr/kr/reference/cancel-order
- 주문 생성 테스트: https://docs.upbit.com/kr/reference/order-test

Upbit 문서가 변경될 수 있으므로 private API wrapper 변경 전에는 공식 문서를 다시 확인한다.

## 9. Acceptance Criteria

- [ ] v0.2 pilot product spec이 MVP paper trading 문서와 분리되어 있다.
- [ ] 권한 matrix가 read-only, policy sync, order smoke, 금지 권한을 구분한다.
- [ ] 임시 secret 파일 경로와 권한이 문서화되어 있고 secret 원문을 저장소에 두지 않는다.
- [ ] 기본 `PAPER_NO_KEY` runtime이 API key 없이 통과한다.
- [ ] pilot profile은 명시 env/guard 없이는 private API를 호출하지 않는다.
- [ ] 주문 생성/취소 wrapper는 pilot profile, 소액 한도, 지정가 제한, 명시 env guard를 모두 통과해야 호출된다.
- [ ] smoke artifact, log, audit, report에는 secret 원문이나 raw Authorization header가 없다.

## 10. 검증

기본 검증:

```sh
corepack pnpm typecheck
corepack pnpm test
./scripts/verify
```

문서 구조 변경 검증:

```sh
./scripts/verify docs
```

private smoke는 명시 guard가 있을 때만 실행한다.

```sh
set -a
. /home/lim/code/seemirai-worktrees/secrets/m14-pilot.env
set +a
SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE=1 corepack pnpm exec vitest run tests/integration/upbit-private-smoke.test.ts
```

order smoke는 별도 guard가 있을 때만 실행한다.

```sh
set -a
. /home/lim/code/seemirai-worktrees/secrets/m14-pilot.env
set +a
SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE=1 \
SEEMIRAI_RUN_UPBIT_ORDER_SMOKE=1 \
corepack pnpm exec vitest run tests/integration/upbit-order-smoke.test.ts
```
