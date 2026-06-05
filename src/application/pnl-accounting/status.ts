import type { NumericString } from "../../domain/index.js";

export type PnLAccountingStatusReadStatus = "OK" | "NOT_FOUND" | "UNAVAILABLE";

/**
 * PnL 회계 snapshot에서 읽은 운영 상태 summary다.
 *
 * `/status` endpoint나 daily report, Telegram 알림이 공통으로 읽을 수 있는
 * 최소한의 durable PnL 정보만 포함한다. 모든 금액은 KRW Decimal 문자열이며,
 * snapshot이 없으면 null이다. `readStatus`는 빈 테이블과 DB 조회 실패를 구분해 운영자가 실제 장애를
 * "아직 snapshot 없음"으로 오해하지 않게 하는 상태 축이다.
 */
export interface PnLAccountingStatus {
  /** 최신 snapshot 조회 결과 상태 */
  readStatus: PnLAccountingStatusReadStatus;
  /** 마지막 snapshot 캡처 시각 */
  latestCapturedAt: string | null;
  /** 최근 평가자산 (KRW). snapshot이 없으면 null */
  latestEquityKrw: NumericString | null;
  /** 최근 실현 손익 (KRW) */
  latestRealizedPnlKrw: NumericString | null;
  /** 최근 미실현 손익 (KRW) */
  latestUnrealizedPnlKrw: NumericString | null;
  /** 최근 최대 낙폭 (bps) */
  latestDrawdownBps: NumericString | null;
  /** snapshot source (payload_json에서 추출). 확인 불가면 null */
  latestSource: string | null;
  /** snapshot 상태 (payload_json에서 추출). 확인 불가면 null */
  latestStatus: string | null;
  /** snapshot 개수 (집계 기준). snapshot이 없으면 0 */
  snapshotCount: number;
  /** 조회 실패 또는 빈 결과의 내부 추적 reason */
  reason: string;
}

/**
 * PnL 회계 status provider다.
 *
 * DB 또는 fixture에서 최신 PnL snapshot을 읽어 운영 상태를 반환한다.
 * DB 접근 실패 시 `readStatus=UNAVAILABLE`로 낮추고 예외를 던지지 않는다.
 */
export interface PnLAccountingStatusProvider {
  getStatus(): Promise<PnLAccountingStatus>;
}
