import { describe, expect, it } from "vitest";
import {
  createLiveOrderApprovalAuditEvent,
} from "../../src/application/index.js";
import {
  createLiveOrderApprovalEvidenceSnapshot,
  createLiveOrderProposalFingerprint,
  evaluateLiveOrderProposalTransition,
} from "../../src/domain/index.js";
import type {
  LiveOrderProposalContract,
} from "../../src/domain/index.js";
import {
  UnsafeLiveManualApprovalRuntimeConfigError,
  assertLiveManualApprovalRuntimeReady,
  evaluateLiveManualApprovalRuntimeGuard,
  loadRuntimeConfig,
} from "../../src/runtime/index.js";

const observedAt = "2026-06-10T00:00:00.000Z";

describe("M21 live order approval contract", () => {
  it("creates a stable proposal fingerprint from canonical order, budget, cost, and risk evidence", () => {
    const first = createProposal({
      requestedPrice: "100000.0",
      requestedVolume: "0.1000",
      expectedNotionalKrw: "10000.00",
      costSnapshot: {
        trade_allowed: true,
        b: "2",
        a: "1",
      },
    });
    const second = createProposal({
      requestedPrice: "100000",
      requestedVolume: "0.1",
      expectedNotionalKrw: "10000",
      costSnapshot: {
        a: "1",
        b: "2",
        trade_allowed: true,
      },
    });

    expect(createLiveOrderProposalFingerprint(first)).toBe(createLiveOrderProposalFingerprint(second));
  });

  it("rejects duplicate or closed-state proposal transitions before submission side effects", () => {
    expect(
      evaluateLiveOrderProposalTransition({
        proposalId: "proposal-001",
        fromStatus: "PROPOSED",
        toStatus: "APPROVED",
        reasonCode: "operator_approved",
        occurredAt: observedAt,
      }),
    ).toMatchObject({
      accepted: true,
      fromStatus: "PROPOSED",
      toStatus: "APPROVED",
    });

    expect(
      evaluateLiveOrderProposalTransition({
        proposalId: "proposal-001",
        fromStatus: "APPROVED",
        toStatus: "APPROVED",
        reasonCode: "duplicate_approval",
        occurredAt: observedAt,
      }),
    ).toMatchObject({
      accepted: false,
      reasonCode: "duplicate_approval",
    });

    expect(
      evaluateLiveOrderProposalTransition({
        proposalId: "proposal-001",
        fromStatus: "SUBMITTED",
        toStatus: "APPROVED",
        reasonCode: "stale_approval_replay",
        occurredAt: observedAt,
      }),
    ).toMatchObject({
      accepted: false,
      fromStatus: "SUBMITTED",
      toStatus: "APPROVED",
    });
  });

  it("creates approval audit evidence without leaking raw Telegram or secret metadata", () => {
    const evidence = createLiveOrderApprovalEvidenceSnapshot({
      proposal: createProposal(),
      evidenceKind: "APPROVAL_RECORDED",
      proposalStatus: "APPROVED",
      occurredAt: observedAt,
      reasonCode: "operator_approved",
      actorHash: "telegram-user-hash",
      metadata: {
        safeReason: "operator confirmed",
        raw_text: "/approve proposal-001",
        nested: {
          token: "secret-token",
        },
      },
    });
    const auditEvent = createLiveOrderApprovalAuditEvent({
      evidence,
      correlationId: "approval-correlation-001",
    });

    expect(auditEvent).toMatchObject({
      eventType: "LIVE_ORDER_APPROVAL",
      severity: "INFO",
      reasonCode: "operator_approved",
      correlationId: "approval-correlation-001",
      metadata: {
        audit_kind: "LIVE_ORDER_APPROVAL",
        evidence_kind: "APPROVAL_RECORDED",
        proposal_id: "proposal-001",
        actor_hash: "telegram-user-hash",
        safe_metadata: {
          safeReason: "operator confirmed",
          raw_text: "[REDACTED]",
          nested: {
            token: "[REDACTED]",
          },
        },
      },
    });
    expect(JSON.stringify(auditEvent.metadata)).not.toContain("/approve proposal-001");
    expect(JSON.stringify(auditEvent.metadata)).not.toContain("secret-token");
  });
});

describe("M21 live manual approval runtime guard", () => {
  it("fails closed when the config is disabled, M20 inbound is missing, or reconcile is stale", () => {
    const disabled = evaluateLiveManualApprovalRuntimeGuard({
      config: loadRuntimeConfig({}),
      reconcileFresh: true,
      observedAt,
    });
    expect(disabled).toMatchObject({
      ready: false,
      violations: ["M21 수동 승인 live pilot 설정이 비활성입니다"],
    });

    const inboundMissing = evaluateLiveManualApprovalRuntimeGuard({
      config: loadRuntimeConfig({
        live_manual_approval: {
          enabled: true,
        },
      }),
      reconcileFresh: true,
      observedAt,
    });
    expect(inboundMissing).toMatchObject({
      ready: false,
      violations: ["M21 수동 승인 live pilot에는 M20 Telegram inbound 활성화가 필요합니다"],
    });

    const staleReconcile = evaluateLiveManualApprovalRuntimeGuard({
      config: loadRuntimeConfig({
        live_manual_approval: {
          enabled: true,
        },
        telegram: {
          inbound: {
            enabled: true,
            owner_chat_ids: ["123"],
          },
        },
      }),
      reconcileFresh: false,
      observedAt,
    });
    expect(staleReconcile).toMatchObject({
      ready: false,
      violations: ["M21 수동 승인 live pilot에는 최신 reconcile 상태가 필요합니다"],
    });
  });

  it("returns ready config only after explicit M21, M20 inbound, and reconcile guards pass", () => {
    const config = loadRuntimeConfig({
      live_manual_approval: {
        enabled: true,
        allowed_markets: ["KRW-BTC", "KRW-ETH"],
      },
      telegram: {
        inbound: {
          enabled: true,
          owner_chat_ids: ["123"],
        },
      },
    });

    expect(
      assertLiveManualApprovalRuntimeReady({
        config,
        reconcileFresh: true,
        observedAt,
      }),
    ).toMatchObject({
      enabled: true,
      allowed_markets: ["KRW-BTC", "KRW-ETH"],
    });

    expect(() =>
      assertLiveManualApprovalRuntimeReady({
        config: loadRuntimeConfig({}),
        reconcileFresh: true,
        observedAt,
      }),
    ).toThrow(UnsafeLiveManualApprovalRuntimeConfigError);
  });
});

function createProposal(overrides: Partial<LiveOrderProposalContract> = {}): LiveOrderProposalContract {
  return {
    proposalId: "proposal-001",
    status: "PROPOSED",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    side: "BUY",
    orderType: "LIMIT",
    requestedPrice: "100000",
    requestedVolume: "0.1",
    expectedNotionalKrw: "10000",
    idempotencyKey: "m21-proposal-001",
    decisionLedgerId: "decision-ledger-001",
    riskDecisionId: "risk-decision-001",
    costSnapshot: {
      trade_allowed: true,
      cost_bps: "10",
    },
    budget: {
      configuredMaxOrderKrw: "10000",
      dailyApprovedNotionalLimitKrw: "30000",
      dailyApprovedNotionalUsedKrw: "0",
      capturedAt: observedAt,
    },
    operatorFacingSummary: {
      title: "승인이 필요한 주문 후보입니다.",
      body: "KRW-BTC 지정가 매수 후보가 비용과 리스크 기준을 통과했습니다.",
      action: "/approve proposal-001 또는 /reject proposal-001 로 처리해 주세요.",
    },
    proposedAt: observedAt,
    expiresAt: "2026-06-10T00:05:00.000Z",
    ...overrides,
  };
}
