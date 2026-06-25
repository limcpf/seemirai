import type {
  FormatLiveOpsBriefingOptions,
  LiveOpsBriefingBalanceSnapshot,
  LiveOpsBriefingPortfolioSnapshot,
  LiveOpsBriefingSafetyIssue,
  LiveOpsBriefingSnapshot,
} from "./types.js";

const defaultTelegramMaxCharacters = 4096;
const redactedMarker = "[비공개]";
const omittedMarker = "\n[이후 생략]";

const unsafeTextPatterns: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /raw(?:[\s_-]?provider[\s_-]?payload|ProviderPayload)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\{[^\r\n]*?\}|\[[^\r\n]*?\]|[^\s,;]+)/giu, reason: "raw_provider_payload" },
  { pattern: /raw(?:[\s_-]?order[\s_-]?detail|OrderDetail)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\{[^\r\n]*?\}|\[[^\r\n]*?\]|[^\s,;]+)/giu, reason: "raw_order_detail" },
  { pattern: /raw[\s_-]?provider[\s_-]?payload/giu, reason: "raw_provider_payload" },
  { pattern: /raw[\s_-]?order[\s_-]?detail/giu, reason: "raw_order_detail" },
  { pattern: /https:\/\/api\.telegram\.org\/bot[^/\s]+\/[A-Za-z][A-Za-z0-9_]*/giu, reason: "telegram_token_url" },
  { pattern: /\bAuthorization\s*:\s*[^\r\n,;]+/giu, reason: "authorization_header" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, reason: "bearer_token" },
  { pattern: /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/gu, reason: "jwt_token" },
  { pattern: /\b(?:SEEMIRAI_)?TELEGRAM_BOT_TOKEN\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/giu, reason: "telegram_token" },
  { pattern: /(?<![A-Za-z0-9_-])["']?(?:telegram)?botToken["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/giu, reason: "telegram_token" },
  { pattern: /\b(?:SEEMIRAI_)?(?:UPBIT_)?(?:ACCESS|SECRET)_KEY\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/giu, reason: "api_key" },
  { pattern: /\b(?:access|secret)[_-]?key\s*=\s*[^\s,;}]+/giu, reason: "api_key" },
  { pattern: /\b(?:SEEMIRAI_)?DATABASE_URL\s*[:=]\s*postgres(?:ql)?:\/\/[^\s,;}]+/giu, reason: "database_url" },
  { pattern: /postgres(?:ql)?:\/\/[^:\s"']+:[^@\s"']+@[^\s"']+/giu, reason: "database_url" },
  { pattern: /(?<![A-Za-z0-9_-])["']?(?:apiSecret|accessKey|secretKey|upbitAccessKey|upbitSecretKey)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/giu, reason: "secret_like_value" },
  { pattern: /(?<![A-Za-z0-9_-])["']?(?:api[_-]?key|access[_-]?key|secret[_-]?key|telegram_bot_token|token|secret|password|authorization|jwt)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/giu, reason: "secret_like_value" },
  { pattern: /\b(?:api[_-]?key|token|secret)[=/][^\s,;}]+/giu, reason: "secret_like_value" },
];

const unsafeKeyPatterns: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /raw[_-]?provider[_-]?payload/iu, reason: "raw_provider_payload_key" },
  { pattern: /raw[_-]?order[_-]?detail/iu, reason: "raw_order_detail_key" },
  { pattern: /authorization/iu, reason: "authorization_key" },
  { pattern: /jwt/iu, reason: "jwt_key" },
  { pattern: /database[_-]?url/iu, reason: "database_url_key" },
  { pattern: /(?:api[_-]?key|access[_-]?key|secret[_-]?key|token|secret|password|credential)/iu, reason: "secret_key" },
];

/**
 * Live Ops briefing snapshot을 Telegram에 바로 보낼 수 있는 deterministic 한국어 문구로 변환한다.
 *
 * 첫 화면은 상태, 원인, 영향, 필요 조치를 먼저 보여주고 내부 reason/source id는 `추적 정보` 섹션으로 분리한다. 이 함수는
 * formatter이므로 LLM 호출, Telegram dispatch, DB write, broker 호출 side effect를 수행하지 않는다.
 *
 * @param snapshot secret-safe briefing snapshot
 * @param options formatter 길이 제한 옵션
 * @returns Telegram provider 제한에 맞춘 한국어 briefing text
 */
export function formatLiveOpsBriefing(
  snapshot: LiveOpsBriefingSnapshot,
  options: FormatLiveOpsBriefingOptions = {},
): string {
  const lines = [
    "Live Ops 브리핑",
    `관측 시각: ${sanitizeText(snapshot.observedAt)}`,
    "",
    `상태: ${sanitizeText(snapshot.headline.statusLabel)}`,
    `원인: ${sanitizeText(snapshot.headline.cause)}`,
    `영향: ${sanitizeText(snapshot.headline.impact)}`,
    `필요 조치: ${sanitizeText(snapshot.headline.action)}`,
    "",
    "운영 상태",
    `- daemon: ${formatDaemonState(snapshot.runtime.daemonAlive)}`,
    `- 실행 모드: ${sanitizeText(snapshot.runtime.runModeLabel)}`,
    `- 실거래 활성화/무장/주문 가능: ${formatBoolean(snapshot.runtime.liveEnabled)} / ${formatBoolean(snapshot.runtime.liveArmed)} / ${formatBoolean(snapshot.runtime.liveOrderCapable)}`,
    `- readiness guard: ${sanitizeText(snapshot.runtime.readinessGuard)}`,
    "",
    "시장 상태",
    `- freshness: ${sanitizeText(snapshot.market.freshnessLabel)} (${formatNullableText(snapshot.market.observedAt)})`,
    `- 현재 시황: ${sanitizeText(snapshot.market.summary)}`,
    "",
    "판단과 조건",
    `- 최신 후보: ${sanitizeText(snapshot.decisions.latestCandidate)}`,
    `- 최신 entry: ${sanitizeText(snapshot.decisions.latestEntryDecision)}`,
    `- 최신 exit: ${sanitizeText(snapshot.decisions.latestExitDecision)}`,
    `- 매수 조건: ${formatTextList(snapshot.decisions.buyConditions)}`,
    `- 매도 조건: ${formatTextList(snapshot.decisions.sellConditions)}`,
    `- HOLD 이유: ${formatNullableText(snapshot.decisions.holdReason)}`,
    `- BLOCK 이유: ${formatNullableText(snapshot.decisions.blockReason)}`,
    "",
    "wallet/cash/coin",
    `- 현금: ${formatCash(snapshot.portfolio)}`,
    `- coin/position: ${formatCoinPosition(snapshot.portfolio)}`,
    `- position scope: ${formatPositionScope(snapshot.portfolio)}`,
    `- PnL: ${formatPnl(snapshot.portfolio)}`,
    `- 예산/노출: ${formatBudgetExposure(snapshot.portfolio)}`,
    "",
    "최근 주문/차단/알림",
    `- 주문: ${sanitizeText(snapshot.operations.openOrders)}`,
    `- reconcile: ${sanitizeText(snapshot.operations.reconcile)}`,
    `- risk block: ${sanitizeText(snapshot.operations.risk)}`,
    `- alert retry: ${sanitizeText(snapshot.operations.alertRetry)}`,
    "",
    "추적 정보",
    `- evidence: ${formatTextList(snapshot.trace.evidenceIds)}`,
    `- reason: ${formatTextList(snapshot.trace.reasonCodes)}`,
    `- source: ${formatTextList(snapshot.trace.sourceIds)}`,
    `- schema: ${sanitizeText(snapshot.schemaVersion)}`,
  ];

  return truncateForTelegram(lines.join("\n"), options.maxCharacters ?? defaultTelegramMaxCharacters);
}

/**
 * briefing snapshot 안의 raw provider/secret/order detail 후보를 점검한다.
 *
 * formatter가 문자열을 redaction하더라도 source snapshot에 금지 후보가 들어온 사실은 PR DnD와 audit evidence에서 추적해야 한다.
 * 이 함수는 순수 검사만 수행하며 raw 값을 그대로 반환하지 않는다.
 *
 * @param snapshot 검사할 briefing snapshot
 * @returns 안전성 이슈 목록
 */
export function validateLiveOpsBriefingSnapshotSafety(
  snapshot: LiveOpsBriefingSnapshot,
): readonly LiveOpsBriefingSafetyIssue[] {
  return collectSafetyIssues(snapshot, []);
}

function formatCash(portfolio: LiveOpsBriefingPortfolioSnapshot): string {
  const cash = portfolio.cash;
  if (cash.totalKrw === null && cash.availableKrw === null) {
    return sanitizeText(cash.statusLabel);
  }

  // 총액이 관측된 경우 available 결측이나 잠김 현금 때문에 운영자가 실제 현금 규모를 놓치지 않게 한다.
  const total = cash.totalKrw === null
    ? null
    : `총 ${sanitizeText(cash.totalKrw)} KRW`;
  const available = cash.availableKrw === null
    ? "사용 가능 관측 없음"
    : `사용 가능 ${sanitizeText(cash.availableKrw)} KRW`;

  if (total === null) {
    return available;
  }
  return `${total}, ${available}`;
}

function formatCoinPosition(portfolio: LiveOpsBriefingPortfolioSnapshot): string {
  if (portfolio.balances.length === 0 && portfolio.positions.length === 0) {
    return "관측 없음";
  }

  if (portfolio.balances.length > 0) {
    return portfolio.balances.map(formatBalance).join(", ");
  }

  return portfolio.positions
    .map((position) => `${sanitizeText(position.market)} ${formatNullableText(position.quantity)} ${sanitizeText(position.statusLabel)}`)
    .join(", ");
}

function formatBalance(balance: LiveOpsBriefingBalanceSnapshot): string {
  return `${sanitizeText(balance.market)} total ${formatNullableText(balance.total)} ${sanitizeText(balance.currency)}, available ${formatNullableText(balance.available)} ${sanitizeText(balance.currency)} ${sanitizeText(balance.statusLabel)}`;
}

function formatPositionScope(portfolio: LiveOpsBriefingPortfolioSnapshot): string {
  if (portfolio.positions.length === 0) {
    return "관측 없음";
  }
  return portfolio.positions
    .map((position) => {
      const averageEntry = position.averageEntryPriceKrw === null
        ? "평균단가 관측 없음"
        : `평균단가 ${sanitizeText(position.averageEntryPriceKrw)} KRW`;
      return `${sanitizeText(position.market)} ${formatNullableText(position.quantity)} ${sanitizeText(position.statusLabel)} (${averageEntry})`;
    })
    .join(", ");
}

function formatPnl(portfolio: LiveOpsBriefingPortfolioSnapshot): string {
  const { pnl } = portfolio;
  if (pnl.realizedKrw === null && pnl.unrealizedKrw === null && pnl.equityKrw === null) {
    return sanitizeText(pnl.statusLabel);
  }
  return `실현 ${formatNullableKrw(pnl.realizedKrw)}, 미실현 ${formatNullableKrw(pnl.unrealizedKrw)}, 평가 ${formatNullableKrw(pnl.equityKrw)}`;
}

function formatBudgetExposure(portfolio: LiveOpsBriefingPortfolioSnapshot): string {
  if (portfolio.budgetUsedKrw === null && portfolio.openExposureKrw === null) {
    return "관측 없음";
  }
  return `사용 ${formatNullableKrw(portfolio.budgetUsedKrw)}, open exposure ${formatNullableKrw(portfolio.openExposureKrw)}`;
}

function formatTextList(values: readonly string[]): string {
  if (values.length === 0) {
    return "관측 없음";
  }
  return values.map(sanitizeText).join(", ");
}

function formatNullableText(value: string | null): string {
  return value === null ? "관측 없음" : sanitizeText(value);
}

function formatNullableKrw(value: string | null): string {
  return value === null ? "관측 없음" : `${sanitizeText(value)} KRW`;
}

function formatBoolean(value: boolean): string {
  return value ? "예" : "아니오";
}

function formatDaemonState(daemonAlive: boolean): string {
  return daemonAlive ? "작동 중" : "중지됨";
}

function sanitizeText(value: string): string {
  // snapshot 값 내부 줄바꿈은 고정 라벨/섹션 구조를 주입할 수 있으므로 먼저 inline text로 낮춘다.
  let sanitized = value.replace(/[\r\n]+/gu, " ").replace(/[ \t]{2,}/gu, " ");
  for (const { pattern } of unsafeTextPatterns) {
    // 브리핑 표면은 실패 대신 redaction으로 낮춰 운영자가 fallback 문구라도 받을 수 있게 한다.
    sanitized = sanitized.replace(pattern, redactedMarker);
  }
  return sanitized;
}

function truncateForTelegram(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) {
    return text;
  }

  if (maxCharacters <= omittedMarker.length) {
    return omittedMarker.slice(0, maxCharacters);
  }

  return `${text.slice(0, maxCharacters - omittedMarker.length).trimEnd()}${omittedMarker}`;
}

function collectSafetyIssues(value: unknown, path: readonly string[]): readonly LiveOpsBriefingSafetyIssue[] {
  if (typeof value === "string") {
    return collectStringIssues(value, path);
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectSafetyIssues(item, [...path, String(index)]));
  }

  return Object.entries(value).flatMap(([key, entryValue]) => {
    const entryPath = [...path, shouldRedactPathKey(key) ? redactedMarker : key];
    return [
      ...collectKeyIssues(key, entryPath),
      ...collectSafetyIssues(entryValue, entryPath),
    ];
  });
}

function collectStringIssues(value: string, path: readonly string[]): readonly LiveOpsBriefingSafetyIssue[] {
  for (const { pattern, reason } of unsafeTextPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      return [{
        path: path.join("."),
        reason,
        redactedPreview: sanitizeText(value).slice(0, 160),
      }];
    }
  }
  return [];
}

function collectKeyIssues(key: string, path: readonly string[]): readonly LiveOpsBriefingSafetyIssue[] {
  for (const { pattern, reason } of unsafeKeyPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(key)) {
      return [{
        path: path.join("."),
        reason,
        redactedPreview: redactedMarker,
      }];
    }
  }
  return [];
}

function shouldRedactPathKey(key: string): boolean {
  for (const { pattern } of unsafeTextPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(key)) {
      return true;
    }
  }
  return false;
}
