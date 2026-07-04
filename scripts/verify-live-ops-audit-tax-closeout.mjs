#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

const contractVersion = "live_ops_audit_tax_closeout.v1";
const requiredEvidence = ["decision_tick", "order", "cancel", "fill", "pnl_snapshot", "audit_event"];
const secretKeyPattern = /(?:authorization|access[_-]?key|api[_-]?key|query[_-]?hash|secret[_-]?key|secret|token|password|jwt|database[_-]?url|db[_-]?password|pg[_-]?password)/iu;
const secretValuePatterns = [
  { label: "authorization bearer literal", pattern: /\bBearer\s+[A-Za-z0-9._/-]+/u },
  { label: "postgres credential url", pattern: /postgres(?:ql)?:\/\/[^:<\s"]+:[^@<\s"]+@/u },
  { label: "compact JWT literal", pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u },
  { label: "telegram bot token literal", pattern: /\b[0-9]{6,}:[A-Za-z0-9_-]{16,}\b/u },
  { label: "OpenAI style secret key literal", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { label: "GitHub token literal", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/u },
  { label: "Slack bot token literal", pattern: /\bxoxb-[A-Za-z0-9-]{20,}\b/u },
];

export function createLiveOpsAuditTaxCloseoutManifest(input = {}) {
  return {
    contractVersion,
    generatedAt: "2026-06-30T00:00:00.000Z",
    source: "fixture_smoke",
    ...input,
    chains: Array.isArray(input.chains) ? input.chains : [createFixtureChain()],
  };
}

export function validateLiveOpsAuditTaxCloseoutManifest(manifest) {
  const chains = Array.isArray(manifest?.chains) ? manifest.chains : [];
  const sourceScan = scanManifestSource(manifest);
  const chainResults = [];
  const missingLinks = [];

  if (manifest?.contractVersion !== contractVersion) {
    missingLinks.push({
      chainId: "manifest",
      evidenceType: "manifest",
      reasonCode: "contract_version_mismatch",
    });
  }
  if (chains.length === 0) {
    missingLinks.push({
      chainId: "manifest",
      evidenceType: "chain",
      reasonCode: "chain_missing",
    });
  }

  for (const chain of chains) {
    const result = validateChain(chain);
    chainResults.push(result);
    missingLinks.push(...result.missingLinks);
  }

  const ready = sourceScan.violations.length === 0 && missingLinks.length === 0;
  return {
    status: ready ? "ready" : "blocked",
    ready,
    summary: ready
      ? {
        statusLabel: "검증 완료",
        message: "세무/감사 closeout evidence가 주문, 취소, 체결, PnL, decision tick을 같은 업무 흐름으로 연결합니다.",
        impact: "운영자는 주문 이후 세무 리포트와 감사 로그가 같은 사건을 가리키는지 재구성할 수 있습니다.",
        action: "운영 closeout에서는 같은 contract shape의 저장소 밖 artifact를 검증한 뒤 보관합니다.",
      }
      : {
        statusLabel: "수동 확인 필요",
        message: "세무/감사 closeout evidence 연결이 끊겼거나 저장하면 안 되는 원본 후보가 포함되어 있습니다.",
        impact: "주문, 취소, 체결, PnL, 판단 이력을 같은 업무 흐름으로 재구성할 수 없습니다.",
        action: "누락된 stable id/correlation id를 보강하고 raw provider/order/secret 후보를 제거한 뒤 다시 검증합니다.",
      },
    contract: {
      version: contractVersion,
      requiredEvidence,
    },
    evidenceCounts: countEvidence(chains),
    chains: chainResults.map(({ missingLinks: _missingLinks, ...chain }) => chain),
    missingLinks,
    sourceScan: {
      status: sourceScan.violations.length === 0 ? "passed" : "failed",
      violations: sourceScan.violations,
    },
    trace: {
      manifestContractVersion: manifest?.contractVersion ?? null,
      chainCount: chains.length,
    },
  };
}

function createFixtureChain() {
  const correlationId = "audit-tax-corr-1";
  return {
    chainId: "audit-tax-chain-1",
    correlationId,
    decisionTick: {
      id: "decision-tick-1",
      dedupeKey: "UPBIT:KRW-BTC:live_ops_cleanup_probe:BUY:2026-06-30T00:00:00.000Z",
      sourceTickId: "live-ops-tick-2026-06-30T00:00:00.000Z",
      decisionKind: "BUY",
      correlationId,
    },
    order: {
      id: "order-1",
      idempotencyKey: "audit-tax-order-1",
      brokerOrderId: "upbit-order-1",
      market: "KRW-BTC",
      strategyId: "live_ops_cleanup_probe",
      correlationId,
    },
    cancellations: [
      {
        id: "cancel-event-1",
        orderId: "order-1",
        idempotencyKey: "cancel:order-1",
        correlationId,
      },
    ],
    fills: [
      {
        id: "fill-1",
        orderId: "order-1",
        fillId: "upbit-fill-1",
        market: "KRW-BTC",
        filledAt: "2026-06-30T00:00:03.000Z",
        correlationId,
      },
    ],
    pnlSnapshots: [
      {
        id: "pnl-1",
        strategyId: "live_ops_cleanup_probe",
        market: "KRW-BTC",
        capturedAt: "2026-06-30T00:00:05.000Z",
        sourceFingerprint: "orders+fills:audit-tax-corr-1",
        sourceTables: ["orders", "fills"],
        correlationId,
      },
    ],
    auditEvents: [
      {
        id: "audit-event-1",
        auditKind: "live_order_flow_closed",
        orderId: "order-1",
        correlationId,
      },
    ],
  };
}

function validateChain(chain) {
  const chainId = stringOr(chain?.chainId, "unknown-chain");
  const links = [];
  const missingLinks = [];
  const decisionTick = chain?.decisionTick;
  const order = chain?.order;
  const cancellations = Array.isArray(chain?.cancellations) ? chain.cancellations : [];
  const fills = Array.isArray(chain?.fills) ? chain.fills : [];
  const pnlSnapshots = Array.isArray(chain?.pnlSnapshots) ? chain.pnlSnapshots : [];
  const auditEvents = Array.isArray(chain?.auditEvents) ? chain.auditEvents : [];

  requireEvidenceStableId(missingLinks, chainId, "decision_tick", decisionTick, ["id", "dedupeKey", "sourceTickId", "correlationId"]);
  requireEvidenceStableId(missingLinks, chainId, "order", order, ["id", "idempotencyKey", "brokerOrderId", "correlationId"]);
  requireNonEmptyCollection(missingLinks, chainId, "cancel", cancellations);
  requireNonEmptyCollection(missingLinks, chainId, "fill", fills);
  requireNonEmptyCollection(missingLinks, chainId, "pnl_snapshot", pnlSnapshots);
  requireNonEmptyCollection(missingLinks, chainId, "audit_event", auditEvents);

  for (const cancellation of cancellations) {
    requireEvidenceStableId(missingLinks, chainId, "cancel", cancellation, ["id", "eventId", "orderEventId", "idempotencyKey", "orderId", "correlationId"]);
  }
  for (const fill of fills) {
    requireEvidenceStableId(missingLinks, chainId, "fill", fill, ["id", "fillId", "exchangeFillId", "orderId", "correlationId"]);
  }
  for (const pnlSnapshot of pnlSnapshots) {
    requirePnlStableId(missingLinks, chainId, pnlSnapshot);
  }
  for (const auditEvent of auditEvents) {
    requireEvidenceStableId(missingLinks, chainId, "audit_event", auditEvent, ["id", "eventId", "orderId", "correlationId"]);
  }

  addRequiredLink({ missingLinks, links, chainId, from: "decision_tick", to: "order", left: decisionTick, right: order });
  for (const cancellation of cancellations) {
    addRequiredLink({ missingLinks, links, chainId, from: "order", to: "cancel", left: order, right: cancellation });
  }
  for (const fill of fills) {
    addRequiredLink({ missingLinks, links, chainId, from: "order", to: "fill", left: order, right: fill });
    for (const pnlSnapshot of pnlSnapshots) {
      addRequiredLink({ missingLinks, links, chainId, from: "fill", to: "pnl_snapshot", left: fill, right: pnlSnapshot });
    }
  }
  for (const auditEvent of auditEvents) {
    addRequiredLink({ missingLinks, links, chainId, from: "order", to: "audit_event", left: order, right: auditEvent });
  }

  return {
    chainId,
    status: missingLinks.length === 0 ? "linked" : "blocked",
    correlationId: stringOr(chain?.correlationId, null),
    links,
    missingLinks,
  };
}

function requireNonEmptyCollection(missingLinks, chainId, evidenceType, collection) {
  if (collection.length > 0) {
    return;
  }
  missingLinks.push({
    chainId,
    evidenceType,
    reasonCode: "evidence_missing",
  });
}

function requireEvidenceStableId(missingLinks, chainId, evidenceType, evidence, keys) {
  if (isRecord(evidence) && keys.some((key) => isNonBlankString(evidence[key]))) {
    return;
  }
  // 세무/감사 evidence는 재시도 후에도 같은 사건을 가리켜야 하므로 저장 전 stable key 부재를 차단한다.
  missingLinks.push({
    chainId,
    evidenceType,
    reasonCode: "stable_or_correlation_id_missing",
  });
}

function requirePnlStableId(missingLinks, chainId, evidence) {
  if (!isRecord(evidence)) {
    requireEvidenceStableId(missingLinks, chainId, "pnl_snapshot", evidence, []);
    return;
  }
  const hasCompositeStableId =
    isNonBlankString(evidence.strategyId) &&
    isNonBlankString(evidence.market) &&
    isNonBlankString(evidence.capturedAt);
  if (
    isNonBlankString(evidence.id) ||
    isNonBlankString(evidence.sourceFingerprint) ||
    isNonBlankString(evidence.correlationId) ||
    hasCompositeStableId
  ) {
    return;
  }
  // PnL hypertable은 단일 generated id가 없을 수 있어 strategy/market/capturedAt 조합도 stable evidence로 인정한다.
  missingLinks.push({
    chainId,
    evidenceType: "pnl_snapshot",
    reasonCode: "stable_or_correlation_id_missing",
  });
}

function addRequiredLink({ missingLinks, links, chainId, from, to, left, right }) {
  if (!isRecord(left) || !isRecord(right)) {
    missingLinks.push({
      chainId,
      evidenceType: `${from}->${to}`,
      reasonCode: "chain_link_missing",
    });
    return;
  }

  const via = findLink(left, right, from, to);
  if (via !== null) {
    links.push({ from, to, via });
    return;
  }

  // 같은 업무 흐름으로 복원할 수 없는 evidence 조합은 세무 closeout에서 성공으로 낮추지 않는다.
  missingLinks.push({
    chainId,
    evidenceType: `${from}->${to}`,
    reasonCode: "chain_link_missing",
  });
}

function findLink(left, right, from, to) {
  if (from === "order" && (to === "cancel" || to === "fill" || to === "audit_event")) {
    if (matchingString(left.id, right.orderId)) {
      return "order_id";
    }
  }
  if (from === "decision_tick" && to === "order") {
    if (matchingString(left.orderIntentIdempotencyKey, right.idempotencyKey)) {
      return "idempotency_key";
    }
    if (matchingSourceTickId(left.sourceTickId, right.idempotencyKey)) {
      return "source_tick_id";
    }
  }
  if (from === "fill" && to === "pnl_snapshot") {
    if (matchingString(left.orderId, right.orderId)) {
      return "order_id";
    }
    if (matchingString(left.fillId, right.fillId) || matchingString(left.id, right.fillId)) {
      return "fill_id";
    }
  }
  if (matchingString(left.correlationId, right.correlationId)) {
    return "correlation_id";
  }
  return null;
}

function countEvidence(chains) {
  return chains.reduce(
    (counts, chain) => ({
      decisionTicks: counts.decisionTicks + (isRecord(chain?.decisionTick) ? 1 : 0),
      orders: counts.orders + (isRecord(chain?.order) ? 1 : 0),
      cancellations: counts.cancellations + (Array.isArray(chain?.cancellations) ? chain.cancellations.length : 0),
      fills: counts.fills + (Array.isArray(chain?.fills) ? chain.fills.length : 0),
      pnlSnapshots: counts.pnlSnapshots + (Array.isArray(chain?.pnlSnapshots) ? chain.pnlSnapshots.length : 0),
      auditEvents: counts.auditEvents + (Array.isArray(chain?.auditEvents) ? chain.auditEvents.length : 0),
    }),
    {
      decisionTicks: 0,
      orders: 0,
      cancellations: 0,
      fills: 0,
      pnlSnapshots: 0,
      auditEvents: 0,
    },
  );
}

function matchingSourceTickId(sourceTickId, idempotencyKey) {
  if (!isNonBlankString(sourceTickId) || !isNonBlankString(idempotencyKey)) {
    return false;
  }
  const normalizedSourceTickId = sourceTickId.trim();
  const normalizedIdempotencyKey = idempotencyKey.trim();
  return normalizedSourceTickId === normalizedIdempotencyKey ||
    normalizedSourceTickId.endsWith(`:${normalizedIdempotencyKey}`);
}

function scanManifestSource(manifest) {
  const violations = [];
  scanNode(manifest, "$", violations);
  return { violations };
}

function scanNode(node, currentPath, violations) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => scanNode(item, `${currentPath}[${index}]`, violations));
    return;
  }
  if (isRecord(node)) {
    for (const [key, value] of Object.entries(node)) {
      const nextPath = `${currentPath}.${key}`;
      if (isRawEvidenceKey(key)) {
        // provider 원본과 주문 원문은 closeout artifact가 아니라 보안 격리 대상이므로 path만 남기고 값은 버린다.
        violations.push({
          path: nextPath,
          reasonCode: "raw_evidence_field_present",
          label: "raw evidence field",
        });
      }
      if (secretKeyPattern.test(key)) {
        violations.push({
          path: nextPath,
          reasonCode: "secret_like_key_present",
          label: "secret-like key",
        });
      }
      scanNode(value, nextPath, violations);
    }
    return;
  }
  if (typeof node !== "string") {
    return;
  }
  for (const { label, pattern } of secretValuePatterns) {
    if (pattern.test(node)) {
      // raw secret 값은 출력하지 않고 위치와 rule만 기록해 evidence 자체가 2차 유출 지점이 되지 않게 한다.
      violations.push({
        path: currentPath,
        reasonCode: "secret_like_value_present",
        label,
      });
    }
  }
}

function parseArgs(argv) {
  const options = {
    fixtureSmoke: false,
    json: false,
    inputPath: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--fixture-smoke") {
      options.fixtureSmoke = true;
    } else if (value === "--json") {
      options.json = true;
    } else if (value === "--input") {
      options.inputPath = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`지원하지 않는 audit/tax closeout 옵션입니다: ${value}`);
    }
  }
  if (options.fixtureSmoke && options.inputPath !== undefined) {
    throw new Error("--input과 --fixture-smoke는 함께 사용할 수 없습니다.");
  }
  return options;
}

async function loadManifest(options) {
  if (options.fixtureSmoke) {
    return createLiveOpsAuditTaxCloseoutManifest();
  }
  if (options.inputPath !== undefined) {
    const content = await readFile(options.inputPath, "utf8");
    return JSON.parse(content);
  }
  // 운영 closeout은 명시 artifact 또는 fixture smoke만 검증해 암묵적인 현재 상태 추정을 막는다.
  throw new Error("--fixture-smoke 또는 --input <manifest.json> 중 하나가 필요합니다.");
}

function renderHumanResult(output) {
  return [
    `상태: ${output.summary.statusLabel}`,
    `메시지: ${output.summary.message}`,
    `chain 수: ${output.trace.chainCount}`,
    `source scan: ${output.sourceScan.status}`,
    `누락 link: ${output.missingLinks.length}`,
  ].join("\n");
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const manifest = await loadManifest(options);
    const result = validateLiveOpsAuditTaxCloseoutManifest(manifest);
    const output = { ...result };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderHumanResult(output)}\n`);
    }
    process.exitCode = result.ready ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRawEvidenceKey(key) {
  const normalized = String(key).replace(/[_-]/gu, "").toLowerCase();
  if (["rawproviderpayload", "rawproviderresponse", "raworderdetail", "raworderpayload", "rawpayload", "rawpayloadjson", "rawupdate"].includes(normalized)) {
    return true;
  }
  return normalized.includes("raw") &&
    (normalized.includes("provider") || normalized.includes("order")) &&
    (normalized.includes("payload") || normalized.includes("detail") || normalized.includes("response"));
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function matchingString(left, right) {
  return isNonBlankString(left) && isNonBlankString(right) && left === right;
}

function stringOr(value, fallback) {
  return isNonBlankString(value) ? value : fallback;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
