import { describe, expect, it } from "vitest";
import {
  formatLiveOpsBriefing,
  validateLiveOpsBriefingSnapshotSafety,
} from "../../src/application/index.js";
import type { LiveOpsBriefingSnapshot } from "../../src/application/index.js";

const observedAt = "2026-06-25T03:00:00.000Z";

describe("live ops briefing", () => {
  it("formats a Korean-first operational briefing with tracking details separated", () => {
    const briefing = formatLiveOpsBriefing(liveOpsBriefingSnapshot());

    expect(briefing).toContain("상태: 실매매 준비 중");
    expect(briefing).toContain("원인: 최신 판단은 현금 보유이며 시장 데이터는 정상입니다.");
    expect(briefing).toContain("영향: 신규 매수는 HOLD 상태이고 기존 포지션은 관측 중입니다.");
    expect(briefing).toContain("필요 조치: 차단 사유가 해소될 때까지 신규 진입을 열지 마세요.");
    expect(briefing).toContain("매수 조건: 스프레드 정상, 호가 깊이 충분");
    expect(briefing).toContain("매도 조건: 익절 조건 미충족, 손절 조건 미충족");
    expect(briefing).toContain("현금: 사용 가능 120000 KRW");
    expect(briefing).toContain("coin/position: KRW-BTC total 0.002 BTC, available 0.002 BTC 보유");
    expect(briefing).toContain("position scope: KRW-BTC 0.002 전략 보유 (평균단가 60000000 KRW)");
    expect(briefing).toContain("PnL: 실현 1200 KRW, 미실현 -300 KRW, 평가 1000000 KRW");
    expect(briefing).toContain("추적 정보");
    expect(briefing.indexOf("상태:")).toBeLessThan(briefing.indexOf("추적 정보"));
    expect(briefing.indexOf("live_order_capable")).toBeGreaterThan(briefing.indexOf("추적 정보"));
  });

  it("keeps missing values as unavailable observations instead of coercing them to zero", () => {
    const briefing = formatLiveOpsBriefing(liveOpsBriefingSnapshot({
      portfolio: {
        cash: {
          statusLabel: "관측 없음",
          availableKrw: null,
          totalKrw: null,
          observedAt: null,
        },
        balances: [],
        positions: [],
        pnl: {
          statusLabel: "관측 없음",
          realizedKrw: null,
          unrealizedKrw: null,
          equityKrw: null,
          observedAt: null,
        },
        openExposureKrw: null,
        budgetUsedKrw: null,
      },
    }));

    expect(briefing).toContain("현금: 관측 없음");
    expect(briefing).toContain("coin/position: 관측 없음");
    expect(briefing).toContain("PnL: 관측 없음");
    expect(briefing).toContain("예산/노출: 관측 없음");
    expect(briefing).not.toContain("현금: 0 KRW");
    expect(briefing).not.toContain("PnL: 실현 0 KRW");
  });

  it("redacts secret-like and raw provider details before rendering or reporting safety issues", () => {
    const unsafeSnapshot = liveOpsBriefingSnapshot({
      headline: {
        statusLabel: "실매매 준비 중",
        cause: "raw provider payload Authorization: Bearer abc.def.ghi",
        impact: "raw order detail should not be shown",
        action: "telegram_bot_token=123456789:secret 값을 확인하지 마세요.",
      },
      trace: {
        evidenceIds: ["live-ops-status-1"],
        reasonCodes: ["live_order_capable"],
        sourceIds: ["access_key=secret-value"],
      },
    });

    const issues = validateLiveOpsBriefingSnapshotSafety(unsafeSnapshot);
    const briefing = formatLiveOpsBriefing(unsafeSnapshot);

    expect(issues.map((issue) => issue.path)).toEqual([
      "headline.cause",
      "headline.impact",
      "headline.action",
      "trace.sourceIds.0",
    ]);
    expect(briefing).toContain("[비공개]");
    expect(briefing).not.toContain("Authorization");
    expect(briefing).not.toContain("Bearer");
    expect(briefing).not.toContain("raw provider payload");
    expect(briefing).not.toContain("raw order detail");
    expect(briefing).not.toContain("telegram_bot_token");
    expect(briefing).not.toContain("access_key=secret-value");
  });

  it("redacts standalone JWT values and flags sensitive metadata keys", () => {
    const unsafeSnapshot = liveOpsBriefingSnapshot({
      headline: {
        statusLabel: "실매매 준비 중",
        cause: "standalone jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signaturevalue",
        impact: "신규 진입 판단에는 사용하지 않습니다.",
        action: "운영자가 source를 다시 확인하세요.",
      },
      trace: {
        evidenceIds: ["live-ops-status-1"],
        reasonCodes: ["live_order_capable"],
        sourceIds: ["status-summary"],
        metadata: {
          secret_key: "opaque-value",
          rawProviderPayload: {
            nested: true,
          },
        },
      },
    });

    const issues = validateLiveOpsBriefingSnapshotSafety(unsafeSnapshot);
    const briefing = formatLiveOpsBriefing(unsafeSnapshot);

    expect(issues.map((issue) => issue.path)).toEqual([
      "headline.cause",
      "trace.metadata.secret_key",
      "trace.metadata.[비공개]",
    ]);
    expect(briefing).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(briefing).toContain("[비공개]");
  });

  it("redacts colon-formatted secrets and raw payload labels", () => {
    const unsafeSnapshot = liveOpsBriefingSnapshot({
      headline: {
        statusLabel: "실매매 준비 중",
        cause: "api_key: abc123 token: xyz rawProviderPayload raw_order_detail",
        impact: "{\"secret\":\"super-secret\"} 값은 브리핑에 남지 않아야 합니다.",
        action: "운영자가 redacted source를 다시 확인하세요.",
      },
    });

    const issues = validateLiveOpsBriefingSnapshotSafety(unsafeSnapshot);
    const briefing = formatLiveOpsBriefing(unsafeSnapshot);

    expect(issues.map((issue) => issue.path)).toEqual([
      "headline.cause",
      "headline.impact",
    ]);
    expect(briefing).toContain("[비공개]");
    expect(briefing).not.toContain("api_key: abc123");
    expect(briefing).not.toContain("token: xyz");
    expect(briefing).not.toContain("rawProviderPayload");
    expect(briefing).not.toContain("raw_order_detail");
    expect(briefing).not.toContain("super-secret");
  });

  it("redacts unsafe key names from safety issue paths", () => {
    const unsafeKey = "Authorization: Bearer abc.def.ghi";
    const unsafeSnapshot = liveOpsBriefingSnapshot({
      trace: {
        evidenceIds: ["live-ops-status-1"],
        reasonCodes: ["live_order_capable"],
        sourceIds: ["status-summary"],
        metadata: {
          [unsafeKey]: "opaque-value",
        },
      },
    });

    const issues = validateLiveOpsBriefingSnapshotSafety(unsafeSnapshot);
    const serializedIssues = JSON.stringify(issues);

    expect(issues.map((issue) => issue.path)).toEqual(["trace.metadata.[비공개]"]);
    expect(serializedIssues).not.toContain("Authorization");
    expect(serializedIssues).not.toContain("Bearer");
  });

  it("shows available balance separately when coin balance is locked", () => {
    const briefing = formatLiveOpsBriefing(liveOpsBriefingSnapshot({
      portfolio: {
        cash: {
          statusLabel: "조회 완료",
          availableKrw: "120000",
          totalKrw: "125000",
          observedAt,
        },
        balances: [
          {
            market: "KRW-BTC",
            currency: "BTC",
            total: "0.002",
            available: "0",
            statusLabel: "보유",
          },
        ],
        positions: [],
        pnl: {
          statusLabel: "조회 완료",
          realizedKrw: "1200",
          unrealizedKrw: "-300",
          equityKrw: "1000000",
          observedAt,
        },
        openExposureKrw: "120000",
        budgetUsedKrw: "5000",
      },
    }));

    expect(briefing).toContain("coin/position: KRW-BTC total 0.002 BTC, available 0 BTC 보유");
    expect(briefing).not.toContain("KRW-BTC 0.002 BTC 보유");
  });

  it("distinguishes a stopped daemon from missing daemon observations", () => {
    const briefing = formatLiveOpsBriefing(liveOpsBriefingSnapshot({
      runtime: {
        daemonAlive: false,
        runModeLabel: "live armed",
        liveEnabled: true,
        liveArmed: true,
        liveOrderCapable: false,
        readinessGuard: "daemon heartbeat 중단",
      },
    }));

    expect(briefing).toContain("daemon: 중지됨");
    expect(briefing).not.toContain("daemon: 관측 없음");
  });

  it("truncates deterministic briefing text within the Telegram message limit", () => {
    const briefing = formatLiveOpsBriefing(liveOpsBriefingSnapshot({
      market: {
        freshnessLabel: "정상",
        summary: "시장 요약 ".repeat(200),
        observedAt,
      },
    }), {
      maxCharacters: 500,
    });

    expect(briefing.length).toBeLessThanOrEqual(500);
    expect(briefing).toContain("[이후 생략]");
  });
});

function liveOpsBriefingSnapshot(
  overrides: Partial<LiveOpsBriefingSnapshot> = {},
): LiveOpsBriefingSnapshot {
  const base: LiveOpsBriefingSnapshot = {
    schemaVersion: "live_ops_briefing.v1",
    observedAt,
    headline: {
      statusLabel: "실매매 준비 중",
      cause: "최신 판단은 현금 보유이며 시장 데이터는 정상입니다.",
      impact: "신규 매수는 HOLD 상태이고 기존 포지션은 관측 중입니다.",
      action: "차단 사유가 해소될 때까지 신규 진입을 열지 마세요.",
    },
    runtime: {
      daemonAlive: true,
      runModeLabel: "live armed",
      liveEnabled: true,
      liveArmed: true,
      liveOrderCapable: false,
      readinessGuard: "reconcile 확인 대기",
    },
    market: {
      freshnessLabel: "정상",
      summary: "KRW-BTC orderbook과 ticker가 5초 이내에 갱신됐습니다.",
      observedAt,
    },
    decisions: {
      latestCandidate: "최근 후보 없음",
      latestEntryDecision: "HOLD: expected return이 safety buffer를 넘지 못했습니다.",
      latestExitDecision: "EXIT 없음: 보유 포지션이 작고 청산 조건이 없습니다.",
      buyConditions: ["스프레드 정상", "호가 깊이 충분"],
      sellConditions: ["익절 조건 미충족", "손절 조건 미충족"],
      holdReason: "비용 차감 후 기대값 부족",
      blockReason: "reconcile freshness 확인 대기",
    },
    portfolio: {
      cash: {
        statusLabel: "조회 완료",
        availableKrw: "120000",
        totalKrw: "125000",
        observedAt,
      },
      balances: [
        {
          market: "KRW-BTC",
          currency: "BTC",
          total: "0.002",
          available: "0.002",
          statusLabel: "보유",
        },
      ],
      positions: [
        {
          market: "KRW-BTC",
          quantity: "0.002",
          averageEntryPriceKrw: "60000000",
          statusLabel: "전략 보유",
        },
      ],
      pnl: {
        statusLabel: "조회 완료",
        realizedKrw: "1200",
        unrealizedKrw: "-300",
        equityKrw: "1000000",
        observedAt,
      },
      openExposureKrw: "120000",
      budgetUsedKrw: "5000",
    },
    operations: {
      openOrders: "미체결 주문 0건",
      reconcile: "마지막 reconcile 성공",
      risk: "kill switch 정상, manual review 없음",
      alertRetry: "Telegram retry 없음",
    },
    trace: {
      evidenceIds: ["live-ops-status-1", "decision-ledger-7"],
      reasonCodes: ["live_order_capable", "entry_hold_cost_margin"],
      sourceIds: ["status-summary", "decision-ledger"],
    },
  };

  return {
    ...base,
    ...overrides,
  };
}
