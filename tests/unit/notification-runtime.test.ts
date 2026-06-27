import { describe, expect, it } from "vitest";

import type { Database } from "../../src/infrastructure/index.js";
import {
  createRuntimeAlertDispatchOptions,
  loadRuntimeConfig,
} from "../../src/runtime/index.js";

describe("notification runtime assembly", () => {
  it("wires scheduled Telegram briefing config into the runtime alert dispatch boundary", () => {
    const runtimeConfig = loadRuntimeConfig({
      telegram: {
        chat_id: "owner-chat-1",
        provider_timeout_ms: 1_000,
        briefing: {
          scheduled_enabled: true,
          schedule_key: "ops:hourly",
        },
      },
      secrets: {
        telegram_bot_token: "telegram-token-fixture",
      },
    });

    const runtime = createRuntimeAlertDispatchOptions({
      database: {} as Database,
      runtimeConfig,
      env: {
        SEEMIRAI_ENV: "production",
      },
    });

    const plan = runtime?.scheduledTelegramBriefing.plan({
      observedAt: "2026-06-14T00:00:00.000Z",
      briefingText: "Live Ops 브리핑\n상태: 실매매 가능",
      briefingSourceFingerprint: "sha256:briefing-source",
      correlationId: "corr-scheduled-briefing",
    });

    expect(runtime?.scheduledTelegramBriefing.config).toEqual({
      scheduledEnabled: true,
      scheduleKey: "ops:hourly",
    });
    expect(plan).toMatchObject({
      status: "ready",
      ready: true,
      alertCount: 1,
      trace: {
        source: "live_ops_briefing",
        dispatchKind: "scheduled",
        scheduleKey: "ops:hourly",
        briefingSourceFingerprint: "sha256:briefing-source",
      },
    });
    expect(plan?.requests[0]).toMatchObject({
      environment: "production",
      runMode: "paper_trading",
      reasonCode: "scheduled_live_ops_briefing",
      dedupeKey: "ops%3Ahourly:sha256%3Abriefing-source",
      correlationId: "corr-scheduled-briefing",
    });
  });
});
