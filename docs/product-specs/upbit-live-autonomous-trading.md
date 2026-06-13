# Upbit Live Autonomous Trading 로드맵

- 상태: M22 구현 closeout, source scan, 24시간 heartbeat-only pilot, dry-run candidate canary, runner/runbook/local file preparer/기본 daemon 완료. M23/M24 운영 검증은 live canary cleanup과 7일 안정화 evidence부터 진행 (2026-06-12)
- 작성일: 2026-06-01
- 관련 범위: M15 이후 post-MVP 실거래 자율 운용
- 기준 문서: [`../PRD.md`](../PRD.md), [`../FEATURE_REQUIREMENTS.md`](../FEATURE_REQUIREMENTS.md), [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md), [`./upbit-v0-2-pilot-private-api.md`](./upbit-v0-2-pilot-private-api.md), [`../RUNTIME_CONFIG.md`](../RUNTIME_CONFIG.md), [`../RELIABILITY.md`](../RELIABILITY.md), [`../SECURITY.md`](../SECURITY.md)

## 1. 목표

이 로드맵의 목표는 Upbit KRW 현물에서 운영자 본인 계정을 대상으로 24시간 시장을 감시하고, 비용·유동성·리스크·전략 조건을 통과한 경우에만 자동 매수/자동 매도를 수행하며, 운영자가 Telegram으로 현재 상태와 판단 이유를 언제든 조회할 수 있는 실거래 운영 시스템을 단계적으로 만드는 것이다.

시스템은 수익을 보장하지 않는다. 구현 목표는 자동으로 돈을 벌겠다는 약속이 아니라, 다음 불변식을 지키는 운영 가능한 자동매매 시스템이다.

- 모든 주문은 비용 차감 후 기대값, 유동성, 정책, 리스크 게이트를 통과해야 한다.
- 보유, 미보유, 현금 보유, 매수, 매도, 주문 취소 판단은 모두 나중에 설명 가능한 evidence를 남겨야 한다.
- 운영자가 잠들거나 일하는 동안에도 신규 주문 차단, 미체결 주문 복구, kill switch, 알림 재시도, 상태 조회가 동작해야 한다.
- LLM은 주문 판단자가 아니라 공식 입력 요약, 판단 이유 설명, 리포트 초안 보조자다.
- 기본 `PAPER_NO_KEY` runtime은 계속 실거래 주문 API를 호출하지 않아야 한다.

## 2. 현재 경계

M14 v0.2 pilot은 실거래 자동매매가 아니다. M14의 목적은 owner-operated private API profile에서 잔고, 주문 가능 정보, 주문 조회, 소액 지정가 주문 생성/취소 smoke를 guard 뒤에서 검증하는 것이다.

M14 이후에도 다음은 여전히 사실이어야 한다.

- `PAPER_NO_KEY` 기본 runtime은 `live_trading_enabled=false`다.
- `UpbitLiveBroker`는 명시 live profile 없이 조립되지 않는다.
- order smoke는 운영자가 지정한 가격, 수량, identifier로 한 번 주문하고 즉시 취소하는 검증일 뿐 자동 전략 실행이 아니다.
- 출금, 입출금 자동화, 선물, 레버리지, 타인 계정, 신호 판매는 범위 밖이다.

## 3. 비목표

- 수익 보장
- 투자 자문, 세무·법률 판단 자동화
- 타인 자금 운용 또는 신호 판매
- 출금 API 권한, 입출금 자동화
- 선물, 레버리지, 마진, 청산 위험이 있는 포지션
- 거래소 간 송금 기반 차익거래
- 비공식 뉴스, SNS, 커뮤니티, 루머 기반 자동 주문
- LLM이 `BUY`, `SELL`, 목표가, 포지션 크기, 주문 허용 여부를 직접 결정하는 구조
- 신규 진입 시장가 주문 기본 허용
- 장애 상황의 무조건 자동 시장가 청산

## 4. 운영 모드

| 모드 | 목적 | 주문 side effect | 자동성 |
| --- | --- | --- | --- |
| `PAPER_NO_KEY` | 기본 paper trading | 없음 | paper 자동 |
| `PILOT_ORDER_SMOKE` | M14 소액 지정가 생성/취소 검증 | 운영자 입력 1회 | 자동매매 아님 |
| `LIVE_READ_ONLY_RECONCILE` | 실계좌 잔고, 주문, 체결 조회와 로컬 상태 복구 | 없음 | 읽기 전용 |
| `LIVE_ARMED_MANUAL_APPROVAL` | 자동 후보 생성 후 운영자 Telegram 승인으로 주문 | 승인된 주문만 | 반자동 |
| `LIVE_AUTONOMOUS_SMALL_BUDGET` | 단일 또는 제한 universe 소액 자동 매수/매도 | 제한적 허용 | 완전 자동 소액 |
| `LIVE_AUTONOMOUS_SCALED` | 검증된 전략과 운영 evidence 기반 예산 확대 | 제한적 허용 | 완전 자동 확장 |

모드 승격은 config 하나를 바꾸는 것으로 끝나지 않는다. 각 모드는 별도 acceptance criteria, 검증 artifact, 운영자 승인 기록을 요구한다.

## 5. 핵심 사용자 시나리오

### 시나리오 1: 자는 동안 자동 운용

1. 운영자가 `LIVE_AUTONOMOUS_SMALL_BUDGET`을 명시적으로 arm 한다.
2. 시스템이 market data, policy, account state를 동기화한다.
3. 전략이 주문 후보를 만들면 비용 엔진과 리스크 게이트가 먼저 통과 여부를 판단한다.
4. 통과한 후보만 `UpbitLiveBroker`를 통해 지정가 주문으로 제출한다.
5. 부분 체결, 미체결, 취소, 재호가, 청산 판단은 모두 evidence와 PnL snapshot으로 남는다.
6. 오류, stale data, rate limit, reconcile mismatch, 손실 한도 초과가 발생하면 신규 주문을 중지한다.

### 시나리오 2: Telegram으로 현재 상황 조회

1. 운영자가 Telegram에서 `/status`, `/positions`, `/pnl`, `/why KRW-BTC`, `/risk` 같은 명령을 보낸다.
2. 시스템은 허용된 운영자 chat id와 명령 권한을 확인한다.
3. 응답은 한국어로 총자산, 현금, 보유 종목, 미체결 주문, realized/unrealized PnL, 최근 판단 이유, 리스크 상태를 보여준다.
4. 내부 order id, idempotency key, correlation id는 하단 `추적 정보`에 분리한다.

### 시나리오 3: 왜 현금으로 들고 있는지 설명

1. 운영자가 `/why cash` 또는 `/why KRW-ETH`를 묻는다.
2. 시스템은 최근 strategy decision, cost model, risk gate, universe policy, liquidity snapshot을 조회한다.
3. 예를 들어 기대값 부족, 스프레드 과대, 슬리피지 위험, 시세 지연, 손실 한도 접근, 전략 pause 같은 이유를 한국어로 요약한다.
4. 설명은 주문을 새로 만들지 않고 읽기 전용으로만 동작한다.

### 시나리오 4: 수동 중지와 복구

1. 운영자가 Telegram 또는 local control API로 pause, resume, kill switch를 요청한다.
2. 시스템은 명령 권한과 확인 절차를 통과한 요청만 수락한다.
3. kill switch는 신규 주문 차단, 미체결 주문 취소 계획, manual review 상태 전이를 audit/risk evidence와 함께 저장한다.
4. 복구 시에는 거래소 상태와 로컬 상태 reconcile이 먼저 통과해야 한다.

## 6. 필수 capability

### Live broker

- `BrokerPort` contract를 Upbit private API로 구현한다.
- 주문 생성, 취소, 개별 주문 조회, 미체결 주문 조회, 잔고 조회를 지원한다.
- 모든 주문은 계정 내 고유 `identifier`와 내부 idempotency key를 연결해야 한다.
- Upbit `Remaining-Req` header와 API 그룹별 제한을 runtime rate limiter에 반영한다.
- 신규 진입은 지정가 중심으로 시작하고, `post_only` 지원 여부와 self-match prevention 충돌을 검증한다.

### 상태 동기화

- 로컬 `orders`, `order_events`, `fills`, `balances`, `positions`, `pnl_snapshots`는 거래소 상태와 주기적으로 대조한다.
- 프로세스 재시작 후 open order, partial fill, balance, position을 복구한다.
- 거래소와 로컬 snapshot이 충돌하면 신규 주문을 fail-closed 하고 manual review로 수렴한다.

### PnL 회계

- realized PnL과 unrealized PnL을 분리한다.
- 수수료, 스프레드, 슬리피지, 취소/재호가 비용을 가능한 범위에서 분해한다.
- 종목별, 전략별, 일간, 주간, 누적 PnL snapshot을 남긴다.
- 결측은 0으로 대체하지 않고 `계산 불가`와 원인을 표시한다.

### 판단 이유 저장소

- 주문 후보 생성, 폐기, 승인, 제출, 취소, 청산 판단은 모두 append-only evidence를 가진다.
- 현금 보유도 판단 결과로 취급한다.
- 설명 API와 Telegram 응답은 이 evidence를 읽어 한국어 운영자 문구로 요약한다.
- LLM 요약은 deterministic evidence를 대체하지 않는다.

### Exit engine

- 자동매수보다 자동매도와 포지션 축소를 먼저 안전하게 닫는다.
- 손절, 익절, trailing stop, 시간 기반 청산, 전략 exit signal, 리스크 기반 축소를 독립 rule로 구성한다.
- 부분 체결과 미체결 exit 주문은 잔여 수량 기준으로 reconcile 한다.
- 장애 상황의 자동 청산은 기본 동작이 아니라 별도 정책과 검증을 요구한다.

### Telegram inbound 운영

- M20부터 Telegram command 수신은 public webhook endpoint 없이 `getUpdates` polling으로만 연다.
- command 수신은 owner chat/user allowlist, secret redaction, replay/중복 명령 방지, 권한별 확인 절차를 요구한다.
- 조회 명령과 trading control 명령을 분리한다. `/status`, `/positions`, `/pnl`, `/why <market|cash>`, `/orders`, `/risk`는
  read-only이며 주문 side effect를 만들지 않는다.
- `/pause`, `/resume`, `/kill`은 durable dedupe와 audit append 이후에도 60초 TTL의 동일 명령 2단계 확인을 통과해야 전역 kill
  switch control provider로 전달된다.
- 메시지는 Telegram provider 제한을 고려해 요약과 추적 정보를 분리하고, 긴 설명은 분할 또는 축약한다.
- `/approve`, `/reject`, order proposal approval, 승인된 주문의 live broker 제출은 M21 이후 별도 범위다.

## 7. 마일스톤

### M15. `UpbitLiveBroker` 실구현

목표:

- M14 private client를 `BrokerPort` 경계로 끌어올려 실제 broker 구현을 만든다.

범위:

- `submitOrder`, `cancelOrder`, `getOrder`, `listOpenOrders`, `getBalances` 구현
- idempotency key와 Upbit `identifier` 매핑
- 주문 생성/취소/조회 오류 정규화
- rate limit 추적과 backoff
- fake Upbit adapter 기반 테스트
- 기본 runtime에서는 live broker 미조립 유지

제외 범위:

- 자동 전략 실행
- Telegram inbound 명령
- 예산 확대

완료 조건:

- fake broker integration test가 주문 제출, 중복 방지, 취소, 조회, rate limit을 검증한다.
- gated real smoke가 소액 지정가 주문 생성/취소 경로를 통과하거나 guard skip evidence를 남긴다.
- `PAPER_NO_KEY`에서 live order API 호출 0회가 유지된다.

### M16. 실계좌 상태 reconcile

목표:

- 실계좌 잔고, 주문, 체결, 포지션을 로컬 상태와 대조하고 재시작 후 상태를 복구한다.
- REST snapshot을 bootstrap source of truth로 사용한다.
- private WebSocket `myOrder`/`myAsset`은 구독 성공 후 이벤트를 버퍼링하고 REST snapshot을 잡은 뒤 변경 추적과 연결 liveness/gap evidence에만 사용한다.

범위:

- REST snapshot bootstrap: `GET /v1/accounts`, `GET /v1/orders/open`, `GET /v1/orders/closed`, `GET /v1/order?uuid=...` 또는 `GET /v1/order?identifier=...`
- private WebSocket `myOrder` 구독 및 정규화
- private WebSocket `myAsset` 구독, balance 변경 추적, REST bootstrap fallback
- read-only reconcile worker: private WebSocket event buffer 준비 → REST snapshot → buffered event 적용 또는 REST 재bootstrap → diff → append-only persist
- open order, 7일 이하 구간 단위 closed order, partial fill, cancel failure 상태 복구
- balance와 position snapshot 갱신
- mismatch 발생 시 신규 주문 fail-closed, manual review evidence
- M16 전용 append-only reconcile tables에 run, balance snapshot, exchange order snapshot, position snapshot, mismatch evidence 기록
- immutable identity fingerprint가 일치한 주문 lifecycle 복구는 기존 domain repository transaction을 통해 로컬 `orders`/`order_events`/`fills`에 반영하고, 거래소 state는 전이 입력으로 분리
- `fills` 복구 쓰기는 거래소 체결 id와 정규화 fill fingerprint 중 관측 가능한 값을 모두 unique key로 선점해 멱등화
- `positions` 갱신은 authoritative fill price/volume으로 평균단가를 계산할 수 있을 때만 허용하고, 근거가 없으면 append-only position snapshot과 manual review evidence로 남긴다.
- 허용 권한: `자산조회`, `주문조회`만 요구 (`주문하기` 권한 불필요)
- 평균단가/PnL은 M17 범위이므로 `계산 불가/수동 검토 필요`로 남긴다.

완료 조건:

- 프로세스 재시작 후 open order와 position snapshot이 복구된다.
- 거래소와 로컬 상태 충돌 시 manual review evidence가 남고 신규 주문이 차단된다.
- reconcile summary를 `/status` 또는 CLI에서 secret 없이 확인할 수 있다.
- private WebSocket `myOrder`/`myAsset`이 구독-버퍼 기반 bootstrap 이후 변경 추적과 ping/pong·close/error 기반 connection gap detection에 사용된다.
- closed order는 7일 이하 구간으로 나눠 조회하고, 조회 horizon 밖이거나 identity/fingerprint를 확인할 수 없는 주문만 manual review로 남긴다.
- M16 runtime은 `자산조회`/`주문조회` 권한만 요구하고 `주문하기`를 요구하지 않는다.

### M17. PnL/포지션 회계

목표:

- 운영자가 Telegram과 report에서 손익과 보유 상태를 신뢰할 수 있게 한다.

범위:

- realized/unrealized PnL 계산
- fee, spread, slippage, cancel/requote penalty 분해
- 종목별/전략별/일간/주간/누적 snapshot
- 현금과 보유 자산의 평가 금액, 노출 비중
- 결측 source 표시

완료 조건:

- 동일 fixture에서 PnL 계산이 deterministic 하다.
- live read-only reconcile 결과와 PnL snapshot source가 연결된다.
- Telegram/status formatter가 내부 code보다 한국어 상태, 원인, 영향, 필요 조치를 먼저 보여준다.

### M18. 판단 이유 ledger와 설명 API

목표:

- 시스템이 왜 샀는지, 왜 팔았는지, 왜 보유 중인지, 왜 현금인지 설명할 수 있게 한다.

범위:

- strategy decision, order intent, discard reason, cost breakdown, risk decision 저장
- cash hold reason 저장
- `why` query service
- LLM summary는 deterministic evidence를 읽는 보조 계층으로 제한

완료 조건:

- 종목별 최근 판단 이유를 조회할 수 있다.
- 주문 후보 0건 frame도 hold/discard reason count로 설명된다.
- LLM 장애가 설명 생성 실패 evidence로만 남고 주문 판단을 바꾸지 않는다.

### M19. 자동 매도와 포지션 축소 ✅ Sub PR 03 완료

목표:

- 자동매수 전에 포지션을 어떻게 줄이고 닫을지 안전하게 구현한다.

구현 상태 (3개 sub PR):

- Sub PR 01: exit contract, config/policy guard, exit rule engine, position sizing, dust/min-order 차단 완료.
- Sub PR 02: RiskGate, decision ledger, PnL/position context, ExecutionEngine/PaperBroker partial fill/cancel/requote, 신규 진입 중지 완료.
- Sub PR 03 (이번): M19 exit pilot guard, guarded buy smoke 차단, 실제 guarded live broker smoke 성공 증적, hard stop open position 자동 청산 금지 회귀 확인, PAPER_NO_KEY live order API 0회 source scan, 문서 closeout 완료.

M19 Sub PR 03 범위:

- M19 exit pilot guard: `SEEMIRAI_RUN_M19_EXIT_PILOT=1`, position source, 소액 한도, operator evidence id
- `EXISTING_SMALL_POSITION` source: M16 reconcile 또는 운영자 position evidence id가 없으면 fail-closed
- guarded buy smoke: `SEEMIRAI_RUN_M19_GUARDED_BUY_SMOKE=1`, `SEEMIRAI_M19_GUARDED_BUY_APPROVAL_EVIDENCE_ID`
- 매도/축소(side=ask) 우선, 신규 buy smoke는 별도 승인 없이 fail-closed

완료 조건:

- ✅ paper fixture에서 모든 exit rule이 검증된다.
- ✅ live pilot guard가 명시 env, 소액 한도, 운영자 evidence 없이 열리지 않는다.
- ✅ 기존 소액 포지션 source는 M16 reconcile 또는 운영자 position evidence 없이 열리지 않는다.
- ✅ guarded buy smoke가 별도 approval evidence 없이 fail-closed 한다.
- ✅ 운영자가 별도 env를 export한 실제 guarded live broker smoke에서 단일 `post_only` 지정가 주문 생성, 조회, 취소 경로가 통과했다.
- ✅ 장애 상황의 무조건 시장가 청산은 여전히 비활성이다.
- ✅ 기본 PAPER_NO_KEY runtime live order API 호출 0회가 유지된다.
- ✅ `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify` 통과 (2026-06-09 Codex review findings 수정 세션에서 최종 확인: typecheck pass, 전체 verify 75 files passed/11 skipped, 1261 tests passed/113 skipped, verify docs/hooks/github pass, source scan live order API 0회)

### M20. Telegram 양방향 운영 ✅ Sub PR 03 완료

목표:

- 운영자가 Telegram으로 상태를 묻고, 제한된 제어 명령을 실행할 수 있게 한다.

구현 상태 (3개 sub PR):

- Sub PR 01: inbound config/env guard, polling provider, owner allowlist, parser/router, audit event, jobs table dedupe 완료.
- Sub PR 02: read-only command runtime, `/pause`/`/resume`/`/kill` control confirmation, Telegram reply formatter, fail-closed review fixes 완료.
- Sub PR 03: fake polling integration test, source scan, 보안/신뢰성/runtime 문서, closeout 문서 완료.

범위:

- Telegram `getUpdates` polling transport
- owner chat id allowlist
- `/status`, `/positions`, `/pnl`, `/why <market|cash>`, `/orders`, `/risk`
- `/pause`, `/resume`, `/kill` 같은 control 명령의 확인 절차
- inbound command audit
- `SECURITY.md`, `RUNTIME_CONFIG.md`, `RELIABILITY.md` 갱신

완료 조건:

- ✅ 허용되지 않은 chat id의 명령은 무시되고 audit evidence만 남는다.
- ✅ 조회 명령은 주문 side effect를 만들지 않는다.
- ✅ control 명령은 인증, 확인, idempotency를 통과해야 한다.
- ✅ Telegram token, raw header, raw provider body는 저장되지 않는다.
- ✅ 기본 `PAPER_NO_KEY` runtime은 M20 완료 후에도 live order API 호출 0회를 유지한다.

### M21. 수동 승인 live pilot

목표:

- 자동 후보 생성은 켜되 실제 주문은 운영자 승인 뒤에만 실행한다.

범위:

- order proposal Telegram 알림
- 승인/거부 command
- 첫 허용 market 기본값: `KRW-BTC`, `KRW-ETH`, `KRW-ETC`
- 1회 주문 상한 기본값 `10000` KRW, 일일 승인 주문 예산 기본값 `30000` KRW
- proposal TTL 기본값 300초와 price deviation guard 기본값 30 bps
- 승인된 주문만 `UpbitLiveBroker` 제출
- 승인 만료와 중복 승인 방지
- M20 Telegram inbound readiness와 최신 reconcile 상태 필수 startup guard
- 제출 직전 risk gate, kill switch, reconcile freshness, budget, market allowlist, order type, price deviation 재검증
- Upbit KRW 최소 주문금액, 음수가 아닌 일일 예산 사용액 snapshot, 같은 proposal reservation 중복 차단

완료 조건:

- ✅ 승인 없는 live 주문 0건을 config guard, source scan, fake broker integration test로 확인했다.
- ✅ 모든 승인 주문은 proposal, approval, risk decision, broker submission evidence를 가진다.
- ✅ proposal 없이 `/approve`만으로 live order가 생성되지 않는다.
- ✅ expired/rejected/submitted proposal 재승인은 broker 호출 전에 fail-closed 한다.
- ✅ 최소 주문금액 미달, 음수 예산 snapshot, 같은 proposal 동시 제출은 broker 호출 전에 차단한다.
- ✅ 기본 `PAPER_NO_KEY` runtime은 live order API 호출 0회를 유지한다.
- M22 전환 gate: 최소 1주 운영 중 reconcile mismatch, duplicate order, untracked fill이 없어야 다음 단계로 넘어간다.

### M22. 제한적 완전 자동매매

목표:

- 운영자가 명시적으로 arm 한 소액 예산에서 자동 매수와 자동 매도를 허용한다.
- 첫 M22 market 기본값은 `KRW-BTC` 단일로 둔다.
- 첫 M22 예산은 M21 기본값을 유지한다. 1회 주문 상한은 `10000` KRW, 일일 자동 주문 notional 한도는 `30000` KRW다.

범위:

- 단일 market 또는 제한 universe
- 총 예산, 1회 주문, 종목별 노출, 일간/주간 손실 한도
- 자동 exit rule 활성화
- stale data, API 오류, reconcile mismatch, 손실 한도 초과 시 신규 주문 중지
- daily live report와 Telegram status
- M21 1주 gate evidence, operator arm evidence, budget evidence, key scope evidence 기반 startup guard
- M20 inbound, M16 reconcile, M17 PnL status, M18 decision ledger, M19 exit engine readiness 확인
- `LIMIT + post_only` 주문만 자동 entry로 허용하고 시장가/최유리 주문과 `post_only + smp_type` 조합은 거래소 호출 전 차단
- broker 호출 전 durable reservation과 32자 이하 랜덤 identifier/idempotency key 생성
- 24시간 pilot runner와 저장소 밖 artifact 기반 closeout 판정

완료 조건:

- ✅ 24시간 live autonomous pilot에서 crash 0회, unhandled rejection 0회, risk gate 우회 주문 0건, reconcile mismatch 0건을 증명했다.
- ✅ 운영자가 Telegram으로 보유, 현금, PnL, 최근 판단 이유를 조회할 수 있는 기반을 M20-M22 상태 요약과 report formatter에 연결했다.
- ✅ 실패 시 kill switch와 manual review로 수렴하는 M19-M22 runtime 경계를 유지했다.

운영 증거:

- 24시간 heartbeat-only pilot: `/home/lim/vaults/99_운영/seemirai-m22-live-autonomous/artifacts/m22-live-autonomous-2026-06-10T23-30-00-313Z-fdad721f-summary.json`
- dry-run candidate canary: `/home/lim/vaults/99_운영/seemirai-m22-live-autonomous/artifacts/m22-live-autonomous-2026-06-12T04-11-28-233Z-94e7b691-summary.json`
- live canary cleanup: `/home/lim/vaults/99_운영/seemirai-m22-live-autonomous/artifacts/m22-live-autonomous-2026-06-12T04-33-15-673Z-cc93288f-summary.json`

### M23. 24/7 운영 안정화

목표:

- 자는 동안과 업무 중에도 `LIVE_AUTONOMOUS_SMALL_BUDGET`가 실제 주문 API를 호출할 수 있는 live-armed 상태인지 운영자가 즉시 확인할 수 있게 한다.
- 수익 검증이 아니라 live enabled, 주문 가능 여부, 최근 판단/차단/주문/취소/체결 evidence, 중지/복구 상태를 secret 없이 설명 가능한 운영 표면으로 고정한다.
- Issue #188은 M23 운영 안정화만 다룬다. M24 universe/budget 확대는 M23 closeout PASS 이후 별도 issue로 분리한다.

범위:

- 현재 모드 표시: dry-run, heartbeat-only, live armed, live order capable
- health/readiness/status/CLI/Telegram/report safe summary
- latest heartbeat, latest reconcile, latest candidate, latest decision, latest order attempt, latest fill/cancel, risk block, budget/exposure, PnL, alert retry 상태
- Telegram 연결 성공 알림, live order capable 시작 알림, 정상 종료/operator stop/kill switch/manual review/crash/restart 알림
- 주문 제출, 취소 요청, 취소 확인, 체결, 부분체결, risk/cost/reconcile 차단 이벤트 요약 알림
- 7일 live-armed daily report와 "왜 주문이 없었는지" decision evidence
- Docker Compose live profile 또는 systemd/process supervisor 재시작 정책
- restart 후 reconcile/status/daily report/Telegram 상태 복구
- `scripts/run-m23-recovery-drill.mjs`로 restart 전후 event log 기반 duplicate order 방지와 복구 evidence 검증
- DB backup/restore smoke drill
- Upbit 장애, 점검, market warning, stale data, API 오류 fail-closed drill
- 운영자가 직접 arm/stop/kill/manual review/Upbit 웹 확인을 수행할 수 있는 runbook

완료 조건:

- 7일 연속 live small-budget 운영 리포트가 생성된다. 이 run은 dry-run이 아니라 live order API를 호출할 수 있는 설정으로 arm 되어야 한다.
- 주문이 없었던 날도 후보 없음, gate 차단, 시장 조건 미충족, operator stop, kill switch 같은 이유가 daily report와 decision evidence에 남는다.
- status 표면은 live enabled, key scope, readiness, latest reconcile, latest heartbeat, latest candidate, latest decision, latest order attempt, latest fill/cancel, budget used, open exposure, risk block, alert retry 상태를 secret 없이 보여준다.
- Telegram 또는 CLI에서 "지금 돌고 있는가 / 매매 가능한가 / 최근 왜 주문했거나 안 했는가 / 현재 포지션과 현금은 어떤가"를 확인할 수 있다.
- Telegram lifecycle와 trade event 알림은 한국어 상태, 원인, 영향, 필요 조치를 먼저 보여주고 내부 evidence id는 `추적 정보`에 분리한다.
- process 재시작 후 reconcile과 status가 정상 복구된다.
- Telegram P0/P1 알림 실패 retry와 manual review 수렴이 검증된다.
- DB backup/restore smoke drill이 disposable restore DB에서 통과하거나, 실행 불가 시 blocker와 필요한 외부 조건이 closeout에 기록된다.
- Upbit 장애, 점검, market warning, stale data, API 오류가 신규 entry fail-closed와 alert/manual review evidence로 수렴한다.
- 7일 동안 crash 0회, unhandled rejection 0회, risk gate 우회 주문 0건, reconcile mismatch 0건, duplicate order 0건, untracked fill 0건, live order cleanup failure 0건을 증명한다.
- live canary 1회 성공, dry-run, heartbeat-only만으로 M23 완료를 선언하지 않는다.

### M24. 전략 확장과 예산 확대

목표:

- 작은 자동매매가 안정적으로 운용된 뒤 universe와 예산을 제한적으로 확대한다.

범위:

- 알트 최대 3개 수동 편입
- 전략별 capital allocation
- regime별 전략 on/off
- 성과 저하 전략 pause
- paper/live shadow 비교
- 예산 확대 승인 기록

완료 조건:

- 종목 추가 전 paper/live shadow 비교가 통과한다.
- 전략별 PnL과 손실 기여도가 report로 분해된다.
- 예산 확대는 운영자 승인과 rollback plan을 가진다.

초기 live test 손실 ceiling은 운영자가 50,000 KRW까지 허용했지만, 이는 자동 예산 확대 승인이 아니다. M23/M24 live canary는 첫 실행에서
M22 단일 주문 상한 10,000 KRW를 유지했고 terminal cancel과 open notional 0을 확인했다. 이후에도 누적 realized loss와 미체결 노출
합계가 50,000 KRW에 닿기 전에 중지해야 한다.

## 8. 자동 실거래 가능 판정

사용자가 기대한 “알아서 매수하고 알아서 매도”는 M22부터 제한적으로 가능하다. M15-M21은 자동매매를 가능하게 하기 위한 필수 안전 기반이다.

M22 진입 전에는 다음을 모두 만족해야 한다.

- `UpbitLiveBroker`가 `BrokerPort` 기준으로 구현되고 검증됐다.
- 실계좌 상태 reconcile이 재시작과 mismatch 상황을 복구하거나 fail-closed 한다.
- PnL과 position accounting이 Telegram/status/report에서 조회 가능하다.
- 매수뿐 아니라 매도/축소/청산 rule이 paper와 live pilot에서 검증됐다.
- Telegram 조회와 control 명령이 보안 문서와 신뢰성 문서 기준을 충족한다.
- manual approval live pilot에서 승인 없는 주문, 중복 주문, 추적 불가 체결이 0건이다.

## 9. 검증 전략

기본 문서 검증:

```sh
./scripts/verify docs
./scripts/verify
```

구현 마일스톤별 검증:

- unit: mapper, validator, rate limiter, PnL calculator, decision ledger
- integration fake: fake Upbit broker, fake Telegram inbound, fake DB queue
- gated live read-only: accounts, orders/chance, order lookup, reconcile
- gated live order smoke: 소액 지정가 생성/취소
- paper/live parity: 같은 event fixture에서 decision, cost, risk, exit 결과 비교
- soak: 24시간 small-budget live autonomous pilot, 이후 7일 운영 안정화

## 10. Open Questions

- 첫 `LIVE_AUTONOMOUS_SMALL_BUDGET` 대상 market은 Issue #180에서 `KRW-BTC` 단일로 결정했다.
- 첫 live autonomous 예산은 Issue #180에서 M21 기본값 유지로 결정했다. 1회 주문 상한은 `10000` KRW, 일일 자동 주문 notional
  한도는 `30000` KRW다.
- 초기 exit rule 조합을 손절/익절/시간 기반으로 시작할지 trailing stop까지 포함할지 결정해야 한다.
- Telegram inbound는 webhook과 polling 중 하나를 선택해야 한다.
- 배포 위치와 고정 IP, Upbit API key allowlist 운영 방식을 결정해야 한다.

## 11. 공식 문서 확인 기준

2026-06-10 기준 다음 공식 문서를 다시 확인했다.

- Upbit 요청 수 제한: https://docs.upbit.com/kr/reference/rate-limits
- Upbit 주문 생성: https://docs.upbit.com/kr/reference/new-order
- Upbit 주문 취소: https://docs.upbit.com/kr/reference/cancel-order
- Upbit 체결 대기 주문 목록 조회: https://docs.upbit.com/kr/reference/list-open-orders
- Upbit KRW 마켓 주문 가격 단위 / 최소 주문 가능 금액: https://docs.upbit.com/kr/docs/krw-market-info
- Upbit WebSocket 기본 정보: https://docs.upbit.com/kr/v1.5.9/reference/general-info
- Telegram Bot API: https://core.telegram.org/bots/api

확인 결과:

- Upbit 주문 생성 문서는 지정가 주문에서 `time_in_force=post_only`를 허용하고, `post_only`와 `smp_type` 동시 사용을 금지한다.
- Upbit 주문 생성 문서는 identifier가 계정 전체 주문 기준 고유하고 최대 64자라고 설명한다. M22는 기존 코드/문서 결정에 따라
  32자 보수 제한과 `m22a-<13 bytes random hex>` 권장 패턴을 유지한다.
- Upbit KRW market info 문서는 최소 주문 가능 금액을 5,000 KRW로 설명한다.
- Upbit rate limit 문서는 Exchange default 그룹을 계정 단위 초당 최대 30회로 설명하고 `Remaining-Req` header 기반 잔여 요청 수
  확인을 요구한다.
