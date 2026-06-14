# Seemirai

Seemirai는 암호화폐 자동매매에서 AI가 매수와 매도를 직접 지시하는 방식을 피하고, 수수료, 스프레드, 슬리피지, 펀딩비, 전송 비용을 먼저 차감한 뒤에도 기대값이 남는 거래만 통과시키는 비용 우선 거래 시스템이다.

현재 저장소는 Upbit KRW 현물 paper trading MVP, M9 paper 운영 베타, M11 전략/피처 품질 보강, M22 제한적 완전 자동매매 기반을 거쳐 M23 `LIVE_AUTONOMOUS_SMALL_BUDGET` 24/7 운영 안정화 단계에 있다. 기본 `config/paper.json`은 계속 API key 없는 안전 profile로 유지하며, 실거래 운영은 저장소 밖 env/key/config/evidence를 갖춘 운영자가 명시적으로 arm 한 소액 한도에서만 진행한다. M24 전략, universe, 예산 확대는 M23 7일 closeout PASS 이후 별도 issue로 분리한다.

## 핵심 원칙

- 모든 거래 후보는 비용 차감 후 기대값이 최소 안전마진을 초과해야 한다.
- 전략보다 리스크 엔진과 자동 정지장치를 먼저 설계한다.
- LLM은 공지, 뉴스, 리포트 요약에만 사용하고 직접 주문 판단에는 사용하지 않는다.
- 시장가 주문은 원칙적으로 제한하고, 메이커 지정가와 부분체결 관리, 취소와 재호가를 기본 실행 방식으로 둔다.
- 24/7 시장 특성을 전제로 UTC/KST 리셋, 거래소 장애, API 지연, 유동성 급감에 대응한다.

## MVP 확정 방향

MVP는 Upbit KRW 현물 기반 paper trading 시스템으로 확정한다. 목표는 수익 극대화가 아니라 실거래 전 자동 주문 엔진, 비용 모델, 리스크 게이트, 알림, 감사 로그가 실제 시장 데이터에서 사고 없이 작동하는지 검증하는 것이다.

기본 운영 모드:

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

대상 종목은 1차로 `KRW-BTC`, `KRW-ETH`만 포함한다. 알트코인은 phase 1.5에서 시장경보, 거래대금, 스프레드, 슬리피지 기준을 통과한 최대 3개만 수동 편입한다.

MVP에서 반드시 검증해야 하는 조건은 다음과 같다.

- 비용 기반 동적 안전마진
- 계정, 종목, 유동성, 일간/주간 손실, 연속 손실 기준의 주문 차단
- Upbit WebSocket 중심 시장 데이터 수집과 REST 기반 정책 조회
- 이벤트 기반 백테스트와 paper trading
- 가상 주문, 가상 체결, 가상 잔고, 전략별 PnL 기록
- Telegram P0 알림과 신규 주문 차단
- LLM을 공식 Upbit 공지/정책/시장경보 리스크 분류기로만 사용

선물, 김치프리미엄을 이용한 실제 거래소 간 차익거래, 레버리지, 시장가 신규 진입, 출금/송금 자동화, 온체인/소셜/뉴스 기반 자동 주문, 완전 무인 운영은 MVP 범위가 아니다.

## 현재 운영 단계

M23 운영 목표는 수익 검증이 아니라 실제 주문 API를 호출할 수 있는 live-armed 상태에서 시스템이 7일 동안 사고 없이 관측, 차단, 중지, 복구, 보고 evidence를 남기는지 확인하는 것이다.

운영 한도는 다음 값을 기본 ceiling으로 둔다.

- 모드: `LIVE_AUTONOMOUS_SMALL_BUDGET`
- 기본 market: `KRW-BTC`
- 1회 주문 상한: `10000` KRW
- 일일 자동 주문 notional 한도: `30000` KRW
- open position notional 한도: `30000` KRW
- 운영 중지 기준: 누적 realized loss와 미체결 노출 합계가 `50000` KRW에 도달하기 전 operator stop 또는 kill switch/manual review 전환
- key scope: `자산조회,주문조회,주문하기`만 허용
- 제외: BTC 외 market 기본 활성화, 자동 예산 확대, 신규 시장가 진입, 자동 시장가 청산, 출금/입출금 자동화, 선물/레버리지, LLM 직접 주문 판단

## 운영 방법

M23 24/7 실거래 안정화는 [M23 live small-budget 7일 운영 runbook](./docs/runbooks/m23-live-small-budget-operations.md)을 따른다. runbook의 핵심 순서는 다음과 같다.

1. 저장소 밖 운영 디렉터리 `~/vaults/99_운영/seemirai-m22-live-autonomous` 또는 동등한 redacted artifact 경로를 준비한다.
2. `m22.env`, `m22.keys.env`, M23 segment env, live autonomous config, candidate JSONL, artifact directory가 운영 호스트의 비공개 경로에 있는지 확인한다.
3. operator arm evidence, budget evidence, M21 gate evidence, key scope evidence를 준비한다.
4. M20 Telegram owner/read-only/control 경계, M16 reconcile freshness, M17 PnL/status, M18 decision ledger, M19 exit engine readiness가 모두 pass인지 확인한다.
5. DB migration, primary DB 연결, backup/restore smoke 실행 환경 또는 실행 불가 blocker 기록 위치를 확인한다.
6. candidate producer를 segment 단위로 rotate하고, 각 24시간 segment 시작 전 open order, open exposure, realized loss safe summary를 최신 값으로 갱신한다.
7. `scripts/run-m22-live-autonomous-pilot.mjs`가 `scripts/run-m22-live-autonomous-daemon.mjs`를 24시간 실행하도록 시작한다.
8. systemd를 쓰는 운영 호스트에서는 [M23 systemd service 예시](./deploy/systemd/seemirai-m23-live-small-budget.service.example)를 실제 사용자, 작업 디렉터리, env 경로, artifact 경로에 맞게 조정한다.
9. 24시간 segment를 7회 연속 운영하고, 각 segment의 daily report marker, summary artifact, decision evidence, alert evidence를 확인한다.
10. 정상 종료, operator stop, kill switch/manual review, crash/restart, Upbit 장애, market warning, stale data, API 오류는 모두 신규 entry fail-closed와 audit/report evidence로 수렴시킨다.
11. restart drill과 DB backup/restore smoke 또는 blocker evidence를 남긴다.
12. 7일 manifest를 작성한 뒤 `scripts/run-m23-stability-closeout.mjs`로 closeout을 검증한다.

후보가 없거나 시장 조건이 맞지 않아 주문이 없었던 날도 완료 근거가 되려면 candidate 없음, gate 차단, 시장 조건 미충족, operator stop, kill switch 같은 이유가 daily report와 decision evidence에 남아야 한다.

## 상태 확인과 보고

운영자는 다음 표면으로 현재 상태를 확인한다.

- HTTP `/status`: runtime, live enabled, key scope, readiness, heartbeat, reconcile, PnL, budget/exposure, risk block, alert retry, M23 `liveOps` safe summary를 secret 없이 확인한다.
- Telegram `/status`: M23 실매매 운영 상태와 주문 가능 여부를 한국어 상태, 원인, 영향, 필요 조치 중심으로 확인한다.
- Telegram `/positions`, `/pnl`, `/why`, `/orders`, `/risk`: 포지션, 손익, 최근 판단 이유, 주문/취소/체결, 리스크 차단 상태를 조회한다.
- Telegram lifecycle/trade alert: 연결 확인, 실주문 가능 시작, 정상 종료, operator stop, kill switch, manual review, crash/restart/recovery, 주문 제출, 취소 요청/확인, 체결/부분체결, cost/risk/reconcile 차단을 받는다.
- daily report: 기준일별 주문, 체결, 손익, 비용/체결 품질, 폐기/차단, M23 live 운영 상태를 받는다.
- 운영 artifact: 24시간 segment summary, event log, daily report evidence, recovery drill summary, DB backup/restore 결과 또는 blocker, source scan 결과를 저장소 밖 redacted 경로에 남긴다.

7일 closeout은 다음 조건을 모두 기계적으로 확인해야 한다.

- 서로 다른 7개 이상 연속 day segment
- 각 segment의 24시간 정상 종료와 daily report evidence
- live-armed guard/readiness evidence
- 주문이 없었던 날의 decision evidence
- restart/reconcile/status/daily report 복구 evidence
- Telegram lifecycle/trade alert와 retry/manual review evidence
- DB backup/restore smoke 결과 또는 blocker와 재시도 계획
- source scan 결과와 raw secret 노출 후보 없음
- crash, unhandled rejection, risk gate 우회 주문, reconcile mismatch, duplicate order, untracked fill, live order cleanup failure가 모두 0건

## 문서

- [아키텍처](./ARCHITECTURE.md)
- [PRD](./docs/PRD.md)
- [기능 요구사항](./docs/FEATURE_REQUIREMENTS.md)
- [Upbit KRW Paper Trading MVP 업무 명세](./docs/product-specs/upbit-krw-paper-trading-mvp.md)
- [Upbit 실거래 자율 운용 로드맵](./docs/product-specs/upbit-live-autonomous-trading.md)
- [M23 live small-budget 7일 운영 runbook](./docs/runbooks/m23-live-small-budget-operations.md)
- [M23 systemd service 예시](./deploy/systemd/seemirai-m23-live-small-budget.service.example)
- [런타임 설정 기준](./docs/RUNTIME_CONFIG.md)
- [신뢰성과 복구 기준](./docs/RELIABILITY.md)
- [보안 기준](./docs/SECURITY.md)
- [문서 시스템](./docs/README.md)

## 로컬 개발

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
./scripts/verify
```

기본 paper profile은 `config/paper.json`에 있으며 API key 없이 로딩되어야 한다.

## 참고 출처

- Kraken: [What makes crypto 24/7/365?](https://www.kraken.com/learn/what-makes-crypto-24-7-365)
- Upbit: [거래 데이터 기준 시간](https://support.upbit.com/hc/ko/articles/900006049666-%EA%B1%B0%EB%9E%98-%EB%8D%B0%EC%9D%B4%ED%84%B0-%EA%B8%B0%EC%A4%80-%EC%8B%9C%EA%B0%84%EC%9D%80-%EC%96%B8%EC%A0%9C%EC%9D%B8%EA%B0%80%EC%9A%94), [거래 수수료](https://support.upbit.com/hc/ko/articles/900006143046-%EA%B1%B0%EB%9E%98-%EC%88%98%EC%88%98%EB%A3%8C%EB%8A%94-%EC%96%BC%EB%A7%88%EC%9D%B8%EA%B0%80%EC%9A%94), [요청 수 제한](https://docs.upbit.com/kr/reference/rate-limits)
- Binance: [Spot Trading Fee Rate](https://www.binance.com/en/fee/trading), [Futures Fee Structure](https://www.binance.com/en/support/faq/detail/360033544231), [Futures Funding Rates](https://www.binance.com/en/support/faq/detail/360033525031)
