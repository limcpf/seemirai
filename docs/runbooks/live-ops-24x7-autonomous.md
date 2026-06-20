# Live Ops 24/7 자동 매수/매도 runbook

이 runbook은 Issue #206 확장 범위의 production `live:ops`를 “한 번 submit/cancel 하는 cleanup probe”가 아니라, 제한 예산 안에서
24/7로 매수, 보유, 매도 판단을 반복하는 운영 경로로 닫기 위한 기준이다.

## 목표

- 운영자는 저장소 밖 config/env 파일만 준비하면 `corepack pnpm live:ops:daemon -- --config <운영-json-path> --env-file <운영-env-path> --tui`
  한 줄로 자동 매수/보유/매도 loop를 시작할 수 있어야 한다.
- 실행 전에 별도 fixture manifest, hand-written evidence, 수동 JSONL 후보 파일을 요구하지 않는다.
- runtime은 필요한 artifact, status summary, decision ledger, order lifecycle, Telegram alert를 자동 생성한다.
- 시스템은 수익을 보장하지 않는다. 완료 기준은 “자동으로 수익이 난다”가 아니라 “24/7로 entry/exit 판단과 risk fail-closed가 반복 가능하다”이다.

## 허용 범위

| 항목 | 기준 |
| --- | --- |
| market | `KRW-BTC` 단일 |
| mode | `LIVE_AUTONOMOUS_SMALL_BUDGET` |
| entry order | `BUY + LIMIT + POST_ONLY` |
| exit order | `SELL + LIMIT + POST_ONLY` |
| 1회 주문 상한 | 10,000 KRW |
| 일일 자동 주문 notional | 30,000 KRW |
| open position notional | 30,000 KRW |
| 운영 중지 ceiling | realized loss + open exposure가 50,000 KRW에 닿기 전 |
| API key scope | `자산조회`, `주문조회`, `주문하기`만 허용 |

## 금지 범위

- 시장가 신규 진입, 시장가 매도, best order 기본 허용.
- BTC 외 market 기본 활성화, 자동 budget 확대.
- hard stop 상황에서 open position을 무조건 시장가 청산하는 동작.
- 출금, 입출금 자동화, 선물, 레버리지, 마진, 타인 계정, 신호 판매.
- LLM이 `BUY`, `SELL`, 목표가, 포지션 크기를 직접 결정하는 구조.
- secret 원문, raw Authorization/JWT, raw provider payload, raw order detail 저장.

## 전략 원칙

초기 production strategy는 “유명 투자자의 이름을 흉내 내는 전략”이 아니라, 장기적으로 검증된 운용 원칙을 작은 deterministic rule로
분해해 조립한다.

- 추세추종 원칙: 강한 흐름에는 작게 진입하되, 손실이 작을 때 빠르게 인정한다.
- 평균회귀 원칙: 과매도 bounce 후보는 유동성/스프레드/수수료를 차감한 뒤에만 진입한다.
- 리스크 우선 원칙: 포지션 크기는 기대수익보다 손실 한도, open exposure, stale data 여부가 먼저 제한한다.
- 현금 보유 원칙: 조건이 약하면 아무 주문도 내지 않고 HOLD evidence를 남긴다.
- 매도 우선 원칙: 보유 포지션이 있으면 entry보다 exit 평가를 먼저 수행한다.

초기 구현은 정적 allowlist strategy registry를 사용한다. 운영 config는 strategy id와 parameter만 선택할 수 있고, 임의 파일 경로,
동적 import, 원격 plugin, 저장소 밖 strategy 코드를 실행할 수 없다.

## 24/7 loop 동작

1. config/env 검증, legacy env 차단, key scope guard를 통과한다.
2. DB migration/readiness를 확인한다.
3. Upbit public market data를 읽고 stale이면 주문을 만들지 않는다.
4. Upbit private read로 계정 전체 open order, balance, position source를 확인한다.
5. 기존 open order나 mismatch가 있으면 신규 entry/exit를 중지하고 manual review로 닫는다.
6. PnL/status가 stale 또는 partial이면 새 주문을 만들지 않는다.
7. `autonomous_24x7` 분석은 key scope guard를 통과한 뒤 private read preflight의 balance/open order/PnL/reconcile snapshot으로 position context를 만든다.
8. 보유 포지션이 있으면 exit policy를 먼저 평가한다.
9. 보유 포지션이 없거나 추가 진입이 허용되면 entry policy를 평가한다.
10. order intent는 cost/risk/budget/reconcile/kill switch guard를 통과해야 한다.
11. 통과한 단일 intent만 broker submit으로 전진한다.
12. 미체결 SELL 주문은 bounded timeout 안에서 cancel/requote 또는 manual review로 닫는다. autonomous BUY는 cleanup probe처럼 즉시 취소하지 않는다.
13. 매 tick마다 decision ledger, status summary, Telegram alert 후보, redacted artifact를 자동 생성한다.
14. daemon 시작 후 startup Telegram 후보는 첫 성공 tick에만 만들고, idle tick마다 반복 전송하지 않는다.

daemon loop는 1회성 cleanup probe가 아니다. 명시한 `--duration-ms`나 `--max-ticks`가 없으면 계속 반복하며, HOLD/차단/수동 확인/일시
실패별로 다른 sleep을 둔다. 기본 tick 간격은 1초이고, 차단은 5초, 수동 확인은 30초, provider/DB 일시 실패는 5초 후 재시도한다.

production에서 `--status-file`을 지정하지 않으면 config 파일이 있는 디렉터리의 `artifacts/live-ops-daemon-status.json`을 출력 상태로
자동 생성한다. 이 파일은 실행 전 준비물이 아니며, 감시자나 operator가 최신 counter를 읽기 위한 결과물이다. 성공 tick 뒤 provider/DB
일시 실패가 발생해도 같은 status file은 `transient_failure`, 최신 counter, 최신 error로 갱신되어 직전 정상 tick 상태로 남지 않는다.
`live:ops:tui --attach <status-json>`은 foreground summary뿐 아니라 daemon status의 top-level `latestSummary`도 읽는다.

## Entry DnD

- [x] `live:ops:daemon`은 hand-written evidence나 fixture manifest 없이 config/env만으로 시작한다.
- [x] `cleanup_probe`와 별개인 production entry strategy allowlist가 있다.
- [x] entry strategy는 `HOLD`, `BLOCK`, `ORDER_INTENT`를 구분하고 모두 decision ledger에 남긴다.
- [x] entry intent는 `KRW-BTC`, `BUY`, `LIMIT`, `POST_ONLY`, 10,000 KRW 이하만 허용한다.
- [x] 외부 feature provider가 아직 붙지 않아도 fresh public tick의 reference-price edge로 entry feature를 자동 산출한다.
- [x] orderbook spread가 좁다는 사실만으로는 BUY 후보를 만들지 않고, 기준가 대비 실제 edge가 약하면 HOLD evidence로 닫는다.
- [x] autonomous BUY intent는 preflight 기반 CostModel/RiskGate/runtime evidence가 붙은 뒤에만 entry runtime으로 전달된다.
- [x] autonomous BUY runtime identifier는 원본 strategy decision key가 아니라 preflight tick scope를 포함한 `ops-` attempt id를 사용한다.
- [x] autonomous BUY Cost/Risk evidence 검증은 원본 decision key가 아니라 runtime `ops-` attempt id와 일치해야 한다.
- [x] autonomous BUY 제출 성공은 cleanup lifecycle로 즉시 취소하지 않고, 후속 reconcile/PnL/status loop로 넘긴다.
- [x] stale market data, stale PnL, reconcile mismatch, open order, budget 초과, kill switch는 broker 호출 전에 차단한다.
- [x] production 제출 경계는 analysis preflight를 재사용하지 않고 private provider preflight를 제출 직전에 다시 읽는다.

## Exit DnD

- [x] 보유 포지션이 있으면 entry보다 exit 평가가 먼저 실행된다.
- [x] exit 평가 대상 수량은 지갑 BTC 전체가 아니라 UTC 날짜가 바뀌어도 runtime이 자동 생성한 strategy reservation 기록으로 소유 범위를 확인한 수량으로 제한한다.
- [x] requested quantity가 없는 구형 reservation은 wallet 관측값과 reserved notional/current price로 strategy-owned 수량을 복원한다.
- [x] FILLED autonomous SELL closeout artifact는 runtime이 자동 기록하고, 해당 수량은 strategy-owned 수량에서 차감한다.
- [x] FILLED SELL cleanup은 BUY lot을 FIFO로 소진하며, 완전 청산된 과거 BUY 평균단가는 새 포지션 평균 진입가에서 제외한다.
- [x] strategy 소유 기록이 없는 지갑 BTC 잔고는 자동 SELL로 축소하지 않고 수동 점검이 필요한 BLOCK으로 닫는다.
- [x] exit policy는 take profit, stop loss, trailing stop, max holding time, risk reduction rule을 독립 rule로 가진다.
- [x] trailing stop은 현재 tick 가격만 보지 않고, runtime position state에 보존된 high-water price 기준으로 판단한다.
- [x] 25,000 KRW risk-reduction 기준보다 작은 소액 보유분도 take profit, stop loss, trailing stop, max holding time 조건이면 SELL 후보를 만든다.
- [x] exit intent는 보유 수량 이하의 `SELL + LIMIT + POST_ONLY`만 허용한다.
- [x] exit intent의 position scope는 제출 직전 fresh private preflight의 strategy-owned scope와 일치해야 하며, stale scope는 broker 제출 전에 차단한다.
- [x] exit 미체결은 bounded cancel/requote 정책으로 닫고, terminal 확인 실패는 manual review로 격상한다.
- [x] exit submit 이후 상태 조회가 실패하면 broker order id를 보존한 manual review summary로 닫는다.
- [x] exit 재호가 attempt는 취소된 주문과 같은 strategy decision key를 쓰더라도 preflight tick scope가 다른 runtime identifier를 사용한다.
- [x] 이미 terminal cancel/no-fill로 확인된 SELL은 다시 취소하지 않고 재호가 대기 또는 수동 점검으로 닫는다.
- [x] exit 체결 또는 cancel/requote 확인 뒤에는 private read, reconcile, PnL status를 다시 읽어 포지션과 open order 상태를 확인한다.
- [x] autonomous preflight PnL/status와 PnL closeout은 cleanup probe scope가 아니라 `live_ops_autonomous_24x7_core` scope를 사용한다.
- [x] DB position row가 아직 없으면 같은 preflight tick의 artifact-owned position snapshot을 PnL closeout 원가 source로 주입한다. 같은 지갑에 수동 BTC가 섞여도 strategy-owned 수량만 주입한다.
- [x] FILLED autonomous SELL closeout artifact는 matched entry average price, entry cost notional, realized PnL을 기록하며 원가 basis가 없으면 manual review로 닫는다.
- [x] hard stop은 신규 주문 차단과 manual review를 만들 수 있지만, 시장가 자동 청산을 만들지 않는다.

SELL 후보의 전체 보유 수량이 1회 주문 상한을 넘으면 daemon은 시장가로 한 번에 던지지 않는다. strategy가 10,000 KRW 이하 chunk를
만들고 `position_effect=REDUCE`로 남긴 뒤, 체결 또는 취소 재호가 결과에 따라 다음 tick에서 잔여 수량을 다시 판단한다.

## Strategy 교체성 DnD

- [x] strategy interface는 entry/exit 후보 생성과 설명 metadata를 분리한다.
- [x] strategy는 broker, Upbit client, DB connection, Telegram dispatcher를 직접 호출하지 않는다.
- [x] 새 strategy는 registry allowlist와 config schema에 추가된 뒤에만 선택할 수 있다.
- [x] strategy parameter는 JSON config에 secret 없이 저장된다.
- [x] strategy별 unit test와 paper/live shadow fixture가 없으면 production allowlist에 추가하지 않는다.

## 운영 명령

선택 smoke:

```sh
corepack pnpm live:ops:daemon -- \
  --config <운영-json-path> \
  --env-file <운영-env-path> \
  --duration-ms 60000 \
  --fixture-smoke \
  --tui
```

이 smoke는 provider/order side effect 없이 loop contract만 검증한다. 실제 24/7 운영 전에 사람이 따로 fixture manifest나 evidence 파일을
만들 필요는 없다.

실제 24/7 운영:

```sh
corepack pnpm live:ops:daemon -- \
  --config <운영-json-path> \
  --env-file <운영-env-path> \
  --tui
```

감시자가 읽을 상태 파일을 고정하려면 다음처럼 지정한다.

```sh
corepack pnpm live:ops:daemon -- \
  --config <운영-json-path> \
  --env-file <운영-env-path> \
  --status-file <운영-status-json-path> \
  --tui
```

`--fixture-smoke`는 개발 검증용이며 production 실행의 필수 준비물이 아니다. 실제 운영 명령은 저장소 밖 config/env만 요구하고,
artifact/status/report는 runtime이 자동으로 만든다.

## 중지 기준

- cancel terminal 확인 실패.
- untracked fill 또는 reconcile mismatch.
- PnL 계산 불가 상태에서 포지션 또는 open order가 있음.
- duplicate order attempt 감지.
- realized loss + open exposure가 50,000 KRW에 접근.
- Telegram owner alert가 반복 실패하고 operator가 상태를 확인할 수 없음.
- Upbit 점검, market warning, stale market data가 freshness 기준을 초과.

## 완료 기준

- `live:ops:daemon` fixture smoke가 외부 provider/order side effect 없이 loop contract를 검증한다.
- fake provider integration이 entry 성공, exit 성공, HOLD, BLOCK, cancel/requote 실패, manual review를 모두 검증한다.
- production config/env 실행은 hand-written evidence 없이 시작하고, broker submit 전 모든 guard를 자동 평가한다.
- runtime은 저장소 밖 artifact directory에 entry reservation, exit closeout, autonomous position state를 자동 유지하며 운영자가 별도 evidence 파일을 만들지 않는다.
- attach TUI는 daemon top-level `transient_failure`가 있으면 stale `latestSummary` 준비 상태보다 실패 상태를 우선 표시한다.
- 24시간 run summary는 crash 0회, unhandled rejection 0회, duplicate order 0건, reconcile mismatch 0건, untracked fill 0건,
  live order cleanup failure 0건을 자동 산출한다.
- final PR은 current head 기준 Codex clean signal, GitHub checks pass, unresolved thread 0개를 만족한다.
