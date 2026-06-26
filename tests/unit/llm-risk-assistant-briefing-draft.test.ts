import { describe, expect, it } from "vitest";
import {
  LLM_RISK_ASSISTANT_SCHEMA_VERSION,
  attachLlmLiveOpsBriefingDraft,
  createLiveOpsBriefingLlmRequest,
  createLlmProviderFailure,
  createLlmProviderSuccess,
  createNoopLlmRiskAssistantProvider,
  formatLiveOpsBriefing,
  type LiveOpsBriefingSnapshot,
  type LlmRiskAssistantResult,
} from "../../src/application/index.js";

const observedAt = "2026-05-23T00:00:00.000Z";

describe("Live Ops LLM briefing draft boundary", () => {
  it("builds a redacted live ops briefing prompt with fingerprint and source ids", () => {
    const snapshot = createBriefingSnapshot({
      headlineCause: "Authorization: Bearer codex-session-raw 때문에 provider가 실패했습니다.",
    });
    const request = createLiveOpsBriefingLlmRequest({
      snapshot,
      requestedAt: observedAt,
      timeoutMs: 5_000,
      maxOutputBytes: 16_000,
      correlationId: "live-ops-briefing-1",
    });
    const serialized = JSON.stringify(request);

    expect(request).toMatchObject({
      result_type: "live_ops_briefing_draft",
      input: {
        source: "live_ops_status_snapshot",
        observed_at: observedAt,
        metadata: {
          snapshot_schema_version: "live_ops_briefing.v1",
          source_ids: ["live_ops_status_summary", "decision_ledger_why_summary"],
          evidence_ids: ["heartbeat-1"],
          reason_codes: ["live_order_capable"],
        },
      },
      correlation_id: "live-ops-briefing-1",
      metadata: {
        prompt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        safety_issue_count: 1,
      },
    });
    expect(request.prompt).toContain("live_ops_briefing_draft");
    expect(request.prompt).toContain("JSON object만 출력");
    expect(serialized).toContain("[비공개]");
    expect(serialized).not.toContain("codex-session-raw");
    expect(serialized).not.toContain("Authorization: Bearer");
  });

  it("preserves generated audit metadata when caller metadata uses the same keys", () => {
    const request = createLiveOpsBriefingLlmRequest({
      snapshot: createBriefingSnapshot(),
      requestedAt: observedAt,
      timeoutMs: 5_000,
      maxOutputBytes: 16_000,
      metadata: {
        prompt_sha256: "caller-prompt",
        source_ids: ["caller-source"],
        evidence_ids: ["caller-evidence"],
        reason_codes: ["caller-reason"],
        safety_issue_count: 999,
      },
    });

    expect(request.metadata).toMatchObject({
      prompt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      source_ids: ["live_ops_status_summary", "decision_ledger_why_summary"],
      evidence_ids: ["heartbeat-1"],
      reason_codes: ["live_order_capable"],
      safety_issue_count: 0,
      caller_metadata: {
        prompt_sha256: "caller-prompt",
        source_ids: ["caller-source"],
        evidence_ids: ["caller-evidence"],
        reason_codes: ["caller-reason"],
        safety_issue_count: 999,
      },
    });
    expect(request.metadata?.prompt_sha256).not.toBe("caller-prompt");
    expect(request.input.metadata).toEqual(request.metadata);
  });

  it("changes source id when briefing content changes with the same trace ids", () => {
    const first = createLiveOpsBriefingLlmRequest({
      snapshot: createBriefingSnapshot({
        headlineCause: "daemon heartbeat를 확인했습니다.",
      }),
      requestedAt: observedAt,
      timeoutMs: 5_000,
      maxOutputBytes: 16_000,
    });
    const second = createLiveOpsBriefingLlmRequest({
      snapshot: createBriefingSnapshot({
        headlineCause: "wallet cash 조회가 지연되었습니다.",
      }),
      requestedAt: observedAt,
      timeoutMs: 5_000,
      maxOutputBytes: 16_000,
    });

    expect(first.input.source_id).not.toBe(second.input.source_id);
  });

  it("attaches a successful LLM briefing draft without exposing action as an order signal", () => {
    const snapshot = createBriefingSnapshot();
    const deterministicText = formatLiveOpsBriefing(snapshot);
    const request = createLiveOpsBriefingLlmRequest({
      snapshot,
      requestedAt: observedAt,
      timeoutMs: 5_000,
      maxOutputBytes: 16_000,
    });
    const result = attachLlmLiveOpsBriefingDraft({
      deterministicText,
      request,
      response: createLlmProviderSuccess({
        providerId: "codex_oauth",
        completedAt: observedAt,
        result: createBriefingDraftResult({
          source_ids: [request.input.source_id],
          summary: "LLM 보조 초안: daemon은 작동 중이며 신규 진입은 차단 상태입니다.",
          recommended_action: "ALERT_ONLY",
          reason_codes: ["live_ops_briefing:operator_summary"],
          requires_human_review: true,
        }),
      }),
    });

    expect(result).toMatchObject({
      status: "attached",
      reasonCode: "llm_live_ops_briefing_draft_attached",
      deterministicText,
      draft: {
        text: "LLM 보조 초안: daemon은 작동 중이며 신규 진입은 차단 상태입니다.",
        providerId: "codex_oauth",
        sourceIds: [request.input.source_id],
        reasonCodes: ["live_ops_briefing:operator_summary"],
        requiresHumanReview: true,
      },
    });
    expect(result.text).toContain("Live Ops 브리핑");
    expect(result.text).toContain("LLM 보조 초안");
    expect(JSON.stringify(result)).not.toContain("recommended_action");
    expectNoOrderInstructionShape(result);
  });

  it("keeps deterministic briefing when the LLM draft contains secret-like text", () => {
    const snapshot = createBriefingSnapshot();
    const deterministicText = formatLiveOpsBriefing(snapshot);
    const request = createLiveOpsBriefingLlmRequest({
      snapshot,
      requestedAt: observedAt,
      timeoutMs: 5_000,
      maxOutputBytes: 16_000,
    });

    const result = attachLlmLiveOpsBriefingDraft({
      deterministicText,
      request,
      response: createLlmProviderSuccess({
        providerId: "codex_oauth",
        completedAt: observedAt,
        result: createBriefingDraftResult({
          source_ids: [request.input.source_id],
          summary: "Authorization: Bearer codex-session-raw 값을 확인하세요.",
          recommended_action: "ALERT_ONLY",
        }),
      }),
    });

    expect(result).toMatchObject({
      status: "deterministic_only",
      reasonCode: "llm_live_ops_briefing_draft_unsafe",
      skippedReason: "unsafe_draft",
      text: deterministicText,
    });
    expect(result.text).not.toContain("Authorization");
    expect(result.text).not.toContain("Bearer");
    expect(result.draft).toBeUndefined();
  });

  it("keeps the attached draft visible inside the Telegram message limit", () => {
    const snapshot = createBriefingSnapshot();
    const deterministicText = `Live Ops 브리핑\n${"상태 확인 ".repeat(600)}`;
    const request = createLiveOpsBriefingLlmRequest({
      snapshot,
      requestedAt: observedAt,
      timeoutMs: 5_000,
      maxOutputBytes: 16_000,
    });

    const result = attachLlmLiveOpsBriefingDraft({
      deterministicText,
      request,
      response: createLlmProviderSuccess({
        providerId: "codex_oauth",
        completedAt: observedAt,
        result: createBriefingDraftResult({
          source_ids: [request.input.source_id],
          summary: `LLM 초안 ${"관측 요약 ".repeat(400)}`,
          recommended_action: "ALERT_ONLY",
        }),
      }),
    });

    expect(result).toMatchObject({
      status: "attached",
    });
    expect(result.text.length).toBeLessThanOrEqual(4096);
    expect(result.text).toContain("LLM 보조 초안");
    expect(result.text).toContain("LLM 초안");
  });

  it("keeps deterministic briefing when the provider fails or returns another result type", () => {
    const snapshot = createBriefingSnapshot();
    const deterministicText = formatLiveOpsBriefing(snapshot);
    const request = createLiveOpsBriefingLlmRequest({
      snapshot,
      requestedAt: observedAt,
      timeoutMs: 5_000,
      maxOutputBytes: 16_000,
    });

    const failed = attachLlmLiveOpsBriefingDraft({
      deterministicText,
      request,
      response: createLlmProviderFailure({
        providerId: "codex_oauth",
        failureClass: "timeout",
        reasonCode: "codex_oauth_provider_timeout",
        message: "timeout",
        failedAt: observedAt,
      }),
    });
    const unsupported = attachLlmLiveOpsBriefingDraft({
      deterministicText,
      request,
      response: createLlmProviderSuccess({
        providerId: "codex_oauth",
        completedAt: observedAt,
        result: createBriefingDraftResult({
          result_type: "daily_report_draft",
          source_ids: [request.input.source_id],
        }),
      }),
    });

    expect(failed).toMatchObject({
      status: "deterministic_only",
      reasonCode: "codex_oauth_provider_timeout",
      skippedReason: "provider_failed",
      text: deterministicText,
    });
    expect(unsupported).toMatchObject({
      status: "deterministic_only",
      reasonCode: "llm_live_ops_briefing_unsupported_result_type",
      skippedReason: "unsupported_result_type",
      text: deterministicText,
    });
    expect(failed.draft).toBeUndefined();
    expect(unsupported.draft).toBeUndefined();
  });

  it("keeps deterministic briefing when the noop provider represents disabled LLM", async () => {
    const snapshot = createBriefingSnapshot();
    const deterministicText = formatLiveOpsBriefing(snapshot);
    const request = createLiveOpsBriefingLlmRequest({
      snapshot,
      requestedAt: observedAt,
      timeoutMs: 5_000,
      maxOutputBytes: 16_000,
    });
    const response = await createNoopLlmRiskAssistantProvider().generate(request);

    const result = attachLlmLiveOpsBriefingDraft({
      deterministicText,
      request,
      response,
    });

    expect(result).toMatchObject({
      status: "deterministic_only",
      reasonCode: "llm_live_ops_briefing_provider_disabled",
      skippedReason: "provider_disabled",
      text: deterministicText,
    });
    expect(result.text).not.toContain("LLM 보조 초안");
    expect(result.draft).toBeUndefined();
  });
});

function createBriefingSnapshot(overrides: {
  headlineCause?: string | undefined;
} = {}): LiveOpsBriefingSnapshot {
  return {
    schemaVersion: "live_ops_briefing.v1",
    observedAt,
    headline: {
      statusLabel: "정상",
      cause: overrides.headlineCause ?? "daemon heartbeat를 확인했습니다.",
      impact: "실거래 주문 가능 상태입니다.",
      action: "리스크 guard와 예산을 계속 관찰하세요.",
    },
    runtime: {
      daemonAlive: true,
      runModeLabel: "live order capable",
      liveEnabled: true,
      liveArmed: true,
      liveOrderCapable: true,
      readinessGuard: "M23 guard 통과",
    },
    market: {
      freshnessLabel: "정상",
      summary: "KRW-BTC 호가 freshness가 정상입니다.",
      observedAt,
    },
    decisions: {
      latestCandidate: "신규 후보 관측 없음",
      latestEntryDecision: "관측 없음",
      latestExitDecision: "관측 없음",
      buyConditions: [],
      sellConditions: [],
      holdReason: "entry guard 대기",
      blockReason: null,
    },
    portfolio: {
      cash: {
        statusLabel: "조회 완료",
        availableKrw: "100000",
        totalKrw: "120000",
        observedAt,
      },
      balances: [],
      positions: [],
      pnl: {
        statusLabel: "조회 완료",
        realizedKrw: "0",
        unrealizedKrw: "0",
        equityKrw: "120000",
        observedAt,
      },
      openExposureKrw: "0",
      budgetUsedKrw: "0",
    },
    operations: {
      openOrders: "미체결 없음",
      reconcile: "정상",
      risk: "신규 주문 허용",
      alertRetry: "대기 없음",
    },
    trace: {
      evidenceIds: ["heartbeat-1"],
      reasonCodes: ["live_order_capable"],
      sourceIds: ["live_ops_status_summary", "decision_ledger_why_summary"],
    },
  };
}

function createBriefingDraftResult(
  override: Partial<LlmRiskAssistantResult> = {},
): LlmRiskAssistantResult {
  return {
    schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
    result_type: "live_ops_briefing_draft",
    source_ids: ["live-ops-status-snapshot-1"],
    summary: "LLM 보조 초안입니다.",
    recommended_action: "NO_ACTION",
    observed_at: observedAt,
    reason_codes: ["live_ops_briefing:draft"],
    requires_human_review: false,
    ...override,
  };
}

function expectNoOrderInstructionShape(value: unknown): void {
  const forbiddenKeys = new Set([
    "orderIntent",
    "orderCandidate",
    "requestedPrice",
    "requestedQuantity",
    "requestedNotional",
    "targetPrice",
    "target_price",
    "positionSize",
    "position_size",
    "side",
    "orderType",
  ]);

  expect(collectKeys(value).filter((key) => forbiddenKeys.has(key))).toEqual([]);
}

function collectKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectKeys(item));
  }
  return Object.entries(value).flatMap(([key, entryValue]) => [key, ...collectKeys(entryValue)]);
}
