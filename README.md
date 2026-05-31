# Seemirai

Seemirai는 암호화폐 자동매매에서 AI가 매수와 매도를 직접 지시하는 방식을 피하고, 수수료, 스프레드, 슬리피지, 펀딩비, 전송 비용을 먼저 차감한 뒤에도 기대값이 남는 거래만 통과시키는 비용 우선 거래 시스템이다.

현재 저장소는 Upbit KRW 현물 paper trading MVP 구현과 M8-C 24시간 public WebSocket soak 검증을 완료했으며, `#68` 기준 `M9 paper 운영 베타` 3일 연속 run closeout 증거도 확보했다. 실거래 주문 API는 여전히 비활성이며, 남은 M9 운영 drill/기록 보강을 닫은 뒤 M11 threshold calibration과 phase 1.5/v0.2 준비로 이어간다.

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

## 문서

- [아키텍처](./ARCHITECTURE.md)
- [PRD](./docs/PRD.md)
- [기능 요구사항](./docs/FEATURE_REQUIREMENTS.md)
- [Upbit KRW Paper Trading MVP 업무 명세](./docs/product-specs/upbit-krw-paper-trading-mvp.md)
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
