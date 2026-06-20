import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Decimal } from "decimal.js";
import pg from "pg";

const { Pool: PgPool } = pg;
const defaultMarket = "KRW-BTC";
const defaultStrategyId = "live_ops_cleanup_probe";
const defaultMaxReconcileAgeMs = 30_000;
const dbConnectionTimeoutMs = 5_000;

export function parseLiveOpsPnlCloseoutArgs(argv) {
  const options = {
    envFilePath: undefined,
    market: defaultMarket,
    strategyId: defaultStrategyId,
    maxReconcileAgeMs: defaultMaxReconcileAgeMs,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--env-file":
        options.envFilePath = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--market":
        options.market = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--strategy-id":
        options.strategyId = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--max-reconcile-age-ms":
        options.maxReconcileAgeMs = Number(readArgValue(argv, index, arg));
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`알 수 없는 인자입니다: ${arg}`);
    }
  }

  return options;
}

export async function runLiveOpsPnlCloseoutCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const clock = io.clock ?? (() => new Date().toISOString());
  const options = parseLiveOpsPnlCloseoutArgs(argv);
  if (options.help) {
    stdout.write(formatLiveOpsPnlCloseoutHelp());
    return 0;
  }
  if (!hasMeaningfulValue(options.envFilePath)) {
    throw new Error("--env-file 경로가 필요합니다.");
  }
  if (!Number.isFinite(options.maxReconcileAgeMs) || options.maxReconcileAgeMs <= 0) {
    throw new Error("--max-reconcile-age-ms는 양수여야 합니다.");
  }

  const env = parseLiveOpsPnlCloseoutEnvFile(await readFile(options.envFilePath, "utf8"));
  const databaseUrl = env.SEEMIRAI_DATABASE_URL;
  if (!hasMeaningfulValue(databaseUrl)) {
    throw new Error("env file에 SEEMIRAI_DATABASE_URL이 필요합니다.");
  }

  const pool = createLiveOpsPnlCloseoutPostgresPool(databaseUrl);
  try {
    const result = await runLiveOpsPnlCloseout({
      pool,
      market: options.market,
      strategyId: options.strategyId,
      capturedAt: clock(),
      maxReconcileAgeMs: options.maxReconcileAgeMs,
    });
    stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatLiveOpsPnlCloseoutResult(result));
    if (result.status !== "ready") {
      stderr.write(`live:ops PnL closeout 실패: ${result.message}\n`);
      return 1;
    }
    return 0;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export function createLiveOpsPnlCloseoutRunner({
  pool,
  market = defaultMarket,
  strategyId = defaultStrategyId,
  clock = () => new Date().toISOString(),
  maxReconcileAgeMs = defaultMaxReconcileAgeMs,
} = {}) {
  return {
    async refreshPreflightPnl(input = {}) {
      return runLiveOpsPnlCloseout({
        pool,
        market: input.market ?? market,
        strategyId: input.strategyId ?? strategyId,
        capturedAt: input.observedAt ?? input.capturedAt ?? clock(),
        balanceSnapshot: input.balanceSnapshot,
        reconcileStatus: input.reconcileStatus,
        referencePrice: input.referencePrice,
        maxReconcileAgeMs,
      });
    },
  };
}

export async function runLiveOpsPnlCloseout({
  pool,
  market = defaultMarket,
  strategyId = defaultStrategyId,
  capturedAt = new Date().toISOString(),
  balanceSnapshot,
  reconcileStatus,
  referencePrice,
  maxReconcileAgeMs = defaultMaxReconcileAgeMs,
} = {}) {
  if (pool === undefined || pool === null) {
    throw new Error("PostgreSQL pool이 필요합니다.");
  }
  const normalizedMarket = normalizeMarket(market);
  const normalizedStrategyId = normalizeStrategyId(strategyId);
  const normalizedCapturedAt = normalizeIsoTimestamp(capturedAt, "capturedAt");

  const source = await loadLiveOpsPnlCloseoutSource({
    pool,
    market: normalizedMarket,
    strategyId: normalizedStrategyId,
    capturedAt: normalizedCapturedAt,
    balanceSnapshot,
    reconcileStatus,
    referencePrice,
    maxReconcileAgeMs,
  });
  if (source.status !== "ready") {
    return {
      status: "blocked",
      inserted: false,
      strategyId: normalizedStrategyId,
      market: normalizedMarket,
      capturedAt: normalizedCapturedAt,
      reasonCode: source.reasonCode,
      message: source.message,
      trace: source.trace,
    };
  }

  const snapshot = buildLiveOpsPnlSnapshot({
    market: normalizedMarket,
    strategyId: normalizedStrategyId,
    capturedAt: normalizedCapturedAt,
    source,
  });
  const persisted = await persistLiveOpsPnlSnapshot({ pool, snapshot });
  return {
    status: "ready",
    inserted: persisted.inserted,
    strategyId: normalizedStrategyId,
    market: normalizedMarket,
    capturedAt: normalizedCapturedAt,
    equityKrw: snapshot.equity,
    realizedPnlKrw: snapshot.realizedPnl,
    unrealizedPnlKrw: snapshot.unrealizedPnl,
    drawdownBps: snapshot.drawdownBps,
    sourceFingerprint: snapshot.sourceFingerprint,
    message: persisted.inserted
      ? "PnL closeout snapshot을 저장했습니다. 이제 같은 운영 tick에서 live:ops 손실 guard가 계산 완료 row를 읽을 수 있습니다."
      : "동일 source fingerprint의 PnL closeout snapshot이 이미 있어 재사용합니다.",
    trace: {
      latestReconcileRunId: source.reconcile.runId,
      latestReconcileAt: source.reconcile.finishedAt,
      referencePriceSource: source.referencePriceSource,
      sourceTables: snapshot.payload_json.trace.sourceTables,
    },
  };
}

async function loadLiveOpsPnlCloseoutSource({
  pool,
  market,
  strategyId,
  capturedAt,
  balanceSnapshot,
  reconcileStatus,
  referencePrice,
  maxReconcileAgeMs,
}) {
  const reconcile = reconcileStatus === undefined
    ? await readLatestReconcile(pool)
    : normalizeInjectedReconcile(reconcileStatus);
  const cleanReconcileBlock = validateCleanReconcile(reconcile, capturedAt, maxReconcileAgeMs);
  if (cleanReconcileBlock !== undefined) {
    return cleanReconcileBlock;
  }

  const balances = balanceSnapshot === undefined
    ? await readReconcileBalances(pool, reconcile.runId)
    : normalizeInjectedBalances(balanceSnapshot);
  if (balances.length === 0) {
    return blockedSource("pnl_closeout_balance_missing", "실계좌 잔고 snapshot이 없어 PnL closeout을 만들지 않습니다.", {
      latestReconcileRunId: reconcile.runId,
    });
  }

  const [position, fillsCount, latestPnlStatus, history] = await Promise.all([
    readCurrentPosition(pool, { market, strategyId }),
    readFillCount(pool, { market, strategyId }),
    readLatestPnlSnapshotStatus(pool, { market, strategyId, capturedAt }),
    readPnlSnapshotHistory(pool, { market, strategyId, capturedAt }),
  ]);
  const latestPnlStatusBlock = validateLatestPnlSnapshotStatus(latestPnlStatus);
  if (latestPnlStatusBlock !== undefined) {
    // 최신 manual-review/partial row를 새 CALCULATED row로 가리면 손실 guard가 실제 차단 사유를 잃는다.
    return latestPnlStatusBlock;
  }
  const baseCurrency = readMarketBaseCurrency(market);
  const krwBalance = findBalance(balances, "KRW");
  if (krwBalance === undefined) {
    return blockedSource(
      "pnl_closeout_krw_balance_missing",
      "KRW 잔고 snapshot이 없어 PnL closeout을 만들지 않습니다.",
      { latestReconcileRunId: reconcile.runId },
    );
  }
  const baseBalance = findBalance(balances, baseCurrency);
  const positionQuantity = position === undefined ? new Decimal(0) : new Decimal(position.quantity);
  if (positionQuantity.gt(0) && baseBalance === undefined) {
    // position source만 있고 거래소 base 잔고 source가 없으면 평가액을 0으로 낮춰 주문 한도를 열 수 있다.
    return blockedSource(
      "pnl_closeout_base_balance_missing_for_position",
      "strategy position 수량은 있지만 거래소 base 잔고 snapshot이 없어 PnL closeout을 만들지 않습니다.",
      { baseCurrency, positionQuantity: positionQuantity.toFixed() },
    );
  }
  const baseTotal = readBalanceTotal(baseBalance);
  if (position === undefined && fillsCount > 0) {
    // 체결 기반 실현손익을 복원할 source가 없으면 0원 closeout으로 회계 결측을 덮지 않는다.
    return blockedSource(
      "pnl_closeout_position_missing_for_fills",
      "체결 이력은 있지만 strategy position snapshot이 없어 실현 손익을 0으로 만들지 않습니다.",
      { fillsCount },
    );
  }
  if (position === undefined && baseTotal.gt(0)) {
    // 실계좌 보유분의 원가/실현손익 source가 없으면 평가액만 있는 snapshot을 계산 완료로 남기지 않는다.
    return blockedSource(
      "pnl_closeout_position_missing_for_balance",
      "실계좌 base 잔고는 있지만 strategy position snapshot이 없어 PnL closeout을 만들지 않습니다.",
      { baseCurrency, baseTotal: baseTotal.toFixed() },
    );
  }
  if (position !== undefined && positionQuantity.eq(0) && baseTotal.gt(0)) {
    // 0수량 position row는 보유분 원가 source가 아니므로 실계좌 BTC 잔고를 정상 PnL로 닫지 않는다.
    return blockedSource(
      "pnl_closeout_position_quantity_zero_for_balance",
      "실계좌 base 잔고는 있지만 strategy position 수량이 0이라 PnL closeout을 만들지 않습니다.",
      { baseCurrency, baseTotal: baseTotal.toFixed() },
    );
  }

  const resolvedReferencePrice = await resolveLiveOpsPnlCloseoutReferencePrice({
    pool,
    market,
    capturedAt,
    referencePrice,
    maxReconcileAgeMs,
    required: baseTotal.gt(0) || positionQuantity.gt(0),
  });
  if (resolvedReferencePrice.status !== "ready") {
    // 보유 수량이 있는데 fresh 기준가가 없으면 open position과 drawdown을 과소평가할 수 있어 차단한다.
    return blockedSource(
      resolvedReferencePrice.reasonCode,
      resolvedReferencePrice.message,
      resolvedReferencePrice.trace,
    );
  }

  const krwTotal = readBalanceTotal(krwBalance);
  const baseMarketValue = resolvedReferencePrice.value === undefined
    ? new Decimal(0)
    : baseTotal.mul(resolvedReferencePrice.value.price);
  const equity = krwTotal.plus(baseMarketValue);
  const realizedPnl = position === undefined ? new Decimal(0) : new Decimal(position.realized_pnl);
  const unrealizedPnl = computeUnrealizedPnl({ position, referencePrice: resolvedReferencePrice.value?.price });
  const drawdownBps = computeDrawdownBps(equity, history);

  return {
    status: "ready",
    reconcile,
    balances,
    position,
    fillsCount,
    equity: equity.toFixed(),
    realizedPnl: realizedPnl.toFixed(),
    unrealizedPnl: unrealizedPnl.toFixed(),
    drawdownBps,
    referencePrice: resolvedReferencePrice.value?.price.toFixed() ?? null,
    referencePriceSource: resolvedReferencePrice.value?.source ?? null,
    baseCurrency,
    krwTotal: krwTotal.toFixed(),
    baseTotal: baseTotal.toFixed(),
  };
}

async function readLatestReconcile(pool) {
  const result = await pool.query(`
    WITH latest_run AS (
      SELECT id, status, started_at, finished_at, correlation_id
      FROM live_reconcile_runs
      ORDER BY started_at DESC
      LIMIT 1
    ),
    counts AS (
      SELECT
        (SELECT count(*)::int FROM live_reconcile_balance_snapshots WHERE run_id = latest_run.id) AS balance_snapshot_count,
        (
          SELECT count(*)::int
          FROM live_reconcile_exchange_order_snapshots
          WHERE run_id = latest_run.id
            AND upper(status) IN ('OPEN', 'ACCEPTED', 'WAIT', 'WATCH')
            AND (remaining_quantity IS NULL OR remaining_quantity > 0)
        ) AS open_order_count,
        (SELECT count(*)::int FROM live_reconcile_mismatch_evidence WHERE run_id = latest_run.id) AS mismatch_count
      FROM latest_run
    )
    SELECT latest_run.*, counts.*
    FROM latest_run
    CROSS JOIN counts
  `);
  const row = result.rows[0];
  if (row === undefined) {
    return {
      runId: null,
      status: "NOT_FOUND",
      finishedAt: null,
      mismatchCount: null,
      openOrderCount: null,
      balanceSnapshotCount: null,
    };
  }
  return {
    runId: row.id,
    status: row.status,
    finishedAt: toIsoString(row.finished_at ?? row.started_at),
    mismatchCount: numberRowValue(row.mismatch_count),
    openOrderCount: numberRowValue(row.open_order_count),
    balanceSnapshotCount: numberRowValue(row.balance_snapshot_count),
  };
}

function normalizeInjectedReconcile(summary) {
  const trace = isRecord(summary.trace) ? summary.trace : {};
  return {
    runId: hasMeaningfulValue(trace.runId) ? String(trace.runId) : null,
    status: summary.result === "SUCCESS" ? "COMPLETED" : String(summary.result ?? "UNAVAILABLE"),
    finishedAt: hasMeaningfulValue(summary.lastReconcileAt) ? toIsoString(summary.lastReconcileAt) : null,
    mismatchCount: nullableNumber(summary.mismatchCount),
    openOrderCount: nullableNumber(summary.openOrderCount),
    balanceSnapshotCount: summary.balanceStatus === "OK" ? 1 : null,
  };
}

function validateCleanReconcile(reconcile, capturedAt, maxReconcileAgeMs) {
  if (reconcile.runId === null && reconcile.status === "NOT_FOUND") {
    return blockedSource("pnl_closeout_reconcile_missing", "완료된 reconcile evidence가 없어 PnL closeout을 만들지 않습니다.", {});
  }
  const clean = reconcile.status === "COMPLETED"
    && reconcile.mismatchCount === 0
    && reconcile.openOrderCount === 0
    && Number(reconcile.balanceSnapshotCount ?? 0) > 0;
  if (!clean) {
    return blockedSource(
      "pnl_closeout_reconcile_not_clean",
      "reconcile에 미체결 주문, mismatch, 또는 잔고 결측이 남아 PnL closeout을 만들지 않습니다.",
      {
        latestReconcileRunId: reconcile.runId,
        latestReconcileStatus: reconcile.status,
        openOrderCount: reconcile.openOrderCount,
        mismatchCount: reconcile.mismatchCount,
        balanceSnapshotCount: reconcile.balanceSnapshotCount,
      },
    );
  }
  if (!isFreshTimestamp(reconcile.finishedAt, capturedAt, maxReconcileAgeMs)) {
    return blockedSource(
      "pnl_closeout_reconcile_stale",
      "reconcile evidence가 현재 closeout 시점보다 오래되어 PnL closeout을 만들지 않습니다.",
      {
        latestReconcileRunId: reconcile.runId,
        latestReconcileAt: reconcile.finishedAt,
        maxReconcileAgeMs,
      },
    );
  }
  return undefined;
}

async function readReconcileBalances(pool, runId) {
  if (!hasMeaningfulValue(runId)) {
    return [];
  }
  const result = await pool.query(`
    SELECT currency, available, locked, total, captured_at, source
    FROM live_reconcile_balance_snapshots
    WHERE run_id = $1
    ORDER BY currency, captured_at DESC, source
  `, [runId]);
  return selectLatestBalancesByCurrency(result.rows.map(normalizeBalanceRow));
}

function normalizeInjectedBalances(balanceSnapshot) {
  if (!Array.isArray(balanceSnapshot?.balances)) {
    return [];
  }
  return selectLatestBalancesByCurrency(balanceSnapshot.balances.map((balance) => normalizeBalanceRow({
    currency: balance.currency,
    available: balance.available,
    locked: balance.locked,
    total: balance.total ?? new Decimal(String(balance.available ?? 0)).plus(String(balance.locked ?? 0)).toFixed(),
    captured_at: balance.updatedAt ?? balanceSnapshot.capturedAt,
    source: balance.source,
  })));
}

function normalizeBalanceRow(row) {
  const available = normalizeNonNegativeDecimal(row.available, "balance.available");
  const locked = normalizeNonNegativeDecimal(row.locked, "balance.locked");
  const total = row.total === null || row.total === undefined
    ? new Decimal(available).plus(locked).toFixed()
    : normalizeNonNegativeDecimal(row.total, "balance.total");
  return {
    currency: String(row.currency ?? "").toUpperCase(),
    available,
    locked,
    total,
    capturedAt: hasMeaningfulValue(row.captured_at) ? toIsoString(row.captured_at) : null,
    source: hasMeaningfulValue(row.source) ? String(row.source).toUpperCase() : null,
  };
}

function selectLatestBalancesByCurrency(balances) {
  const selected = new Map();
  for (const balance of balances) {
    if (!hasMeaningfulValue(balance.currency)) {
      continue;
    }
    const current = selected.get(balance.currency);
    if (current === undefined || compareBalanceSnapshotRecency(balance, current) > 0) {
      selected.set(balance.currency, balance);
    }
  }
  return [...selected.values()].sort((left, right) => left.currency.localeCompare(right.currency));
}

function compareBalanceSnapshotRecency(left, right) {
  const leftTime = timestampSortKey(left.capturedAt);
  const rightTime = timestampSortKey(right.capturedAt);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return balanceSourcePriority(left.source) - balanceSourcePriority(right.source);
}

async function readCurrentPosition(pool, { market, strategyId }) {
  const result = await pool.query(`
    SELECT strategy_id, market, quantity, average_entry_price, realized_pnl, unrealized_pnl, updated_at
    FROM positions
    WHERE exchange = 'upbit_krw_spot'
      AND market = $1
      AND strategy_id = $2
    LIMIT 1
  `, [market, strategyId]);
  const row = result.rows[0];
  if (row === undefined) {
    return undefined;
  }
  return {
    strategy_id: String(row.strategy_id),
    market: String(row.market),
    quantity: normalizeNonNegativeDecimal(row.quantity, "position.quantity"),
    average_entry_price: normalizeNonNegativeDecimal(row.average_entry_price, "position.average_entry_price"),
    realized_pnl: normalizeDecimal(row.realized_pnl),
    unrealized_pnl: normalizeDecimal(row.unrealized_pnl),
    updated_at: hasMeaningfulValue(row.updated_at) ? toIsoString(row.updated_at) : null,
  };
}

async function readFillCount(pool, { market, strategyId }) {
  const result = await pool.query(`
    SELECT count(*)::int AS count
    FROM fills
    INNER JOIN orders ON orders.id = fills.order_id
    WHERE fills.exchange = 'upbit_krw_spot'
      AND fills.market = $1
      AND orders.strategy_id = $2
  `, [market, strategyId]);
  return numberRowValue(result.rows[0]?.count);
}

async function readLatestReferencePrice(pool, market) {
  const result = await pool.query(`
    SELECT best_bid_price, best_ask_price, bucket_at
    FROM orderbook_metrics
    WHERE exchange = 'upbit_krw_spot'
      AND market = $1
    ORDER BY bucket_at DESC
    LIMIT 1
  `, [market]);
  const row = result.rows[0];
  if (row === undefined || !isPositiveDecimalString(row.best_bid_price) || !isPositiveDecimalString(row.best_ask_price)) {
    return undefined;
  }
  return {
    price: new Decimal(row.best_bid_price).plus(row.best_ask_price).div(2),
    source: "orderbook_metrics",
    observedAt: hasMeaningfulValue(row.bucket_at) ? toIsoString(row.bucket_at) : null,
  };
}

async function resolveLiveOpsPnlCloseoutReferencePrice({
  pool,
  market,
  capturedAt,
  referencePrice,
  maxReconcileAgeMs,
  required,
}) {
  if (!required) {
    return { status: "ready", value: undefined };
  }
  if (isPositiveDecimalString(referencePrice)) {
    return {
      status: "ready",
      value: { price: new Decimal(normalizeDecimal(referencePrice)), source: "market_data_preflight", observedAt: capturedAt },
    };
  }
  const latestReferencePrice = await readLatestReferencePrice(pool, market);
  if (latestReferencePrice === undefined) {
    return {
      status: "blocked",
      reasonCode: "pnl_closeout_reference_price_missing",
      message: "보유 수량 평가에 필요한 최신 기준가가 없어 PnL closeout을 만들지 않습니다.",
      trace: { market },
    };
  }
  if (!isFreshTimestamp(latestReferencePrice.observedAt, capturedAt, maxReconcileAgeMs)) {
    return {
      status: "blocked",
      reasonCode: "pnl_closeout_reference_price_stale",
      message: "보유 수량 평가 기준가가 현재 closeout 시점보다 오래되어 PnL closeout을 만들지 않습니다.",
      trace: {
        market,
        referencePriceAt: latestReferencePrice.observedAt,
        maxReconcileAgeMs,
      },
    };
  }
  return { status: "ready", value: latestReferencePrice };
}

async function readLatestPnlSnapshotStatus(pool, { market, strategyId, capturedAt }) {
  const result = await pool.query(`
    SELECT strategy_id, market, captured_at, payload_json ->> 'status' AS payload_status
    FROM pnl_snapshots
    WHERE (market = $2 OR market IS NULL)
      AND (
        strategy_id = $1
        OR strategy_id IS NULL
        OR strategy_id IN ('global', 'aggregate')
      )
      AND captured_at <= $3
    ORDER BY captured_at DESC, (strategy_id = $1) DESC, (market = $2) DESC
    LIMIT 1
  `, [strategyId, market, capturedAt]);
  const row = result.rows[0];
  if (row === undefined) {
    return undefined;
  }
  return {
    strategyId: hasMeaningfulValue(row.strategy_id) ? String(row.strategy_id) : null,
    market: hasMeaningfulValue(row.market) ? String(row.market) : null,
    capturedAt: hasMeaningfulValue(row.captured_at) ? toIsoString(row.captured_at) : null,
    status: hasMeaningfulValue(row.payload_status) ? String(row.payload_status) : null,
  };
}

function validateLatestPnlSnapshotStatus(latestPnlStatus) {
  if (latestPnlStatus === undefined || latestPnlStatus.status === "CALCULATED") {
    return undefined;
  }
  return blockedSource(
    "pnl_closeout_latest_status_not_ready",
    "최신 PnL snapshot이 계산 완료 상태가 아니어서 새 closeout snapshot으로 차단 사유를 덮지 않습니다.",
    {
      latestPnlStrategyId: latestPnlStatus.strategyId,
      latestPnlMarket: latestPnlStatus.market,
      latestPnlCapturedAt: latestPnlStatus.capturedAt,
      latestPnlStatus: latestPnlStatus.status,
    },
  );
}

async function readPnlSnapshotHistory(pool, { market, strategyId, capturedAt }) {
  const result = await pool.query(`
    SELECT equity, captured_at
    FROM pnl_snapshots
    WHERE strategy_id = $1
      AND (market = $2 OR market IS NULL)
      AND captured_at < $3
      AND payload_json ->> 'status' = 'CALCULATED'
    ORDER BY captured_at DESC
    LIMIT 100
  `, [strategyId, market, capturedAt]);
  return result.rows.map((row) => ({
    equity: normalizeNonNegativeDecimal(row.equity, "pnl_snapshot.equity"),
    capturedAt: hasMeaningfulValue(row.captured_at) ? toIsoString(row.captured_at) : null,
  }));
}

function buildLiveOpsPnlSnapshot({ market, strategyId, capturedAt, source }) {
  const sourceFingerprint = computeSourceFingerprint({ market, strategyId, capturedAt, source });
  const payload = {
    status: "CALCULATED",
    source: "live_ops_pnl_closeout_preflight",
    sourceFingerprint,
    cashKrw: source.krwTotal,
    missingReasons: [],
    balances: {
      krwTotal: source.krwTotal,
      [source.baseCurrency]: source.baseTotal,
    },
    positionDetail: source.position === undefined
      ? {
          market,
          quantity: "0",
          averageEntryPrice: null,
          marketValueKrw: "0",
          unrealizedPnlKrw: "0",
        }
      : {
          market,
          quantity: source.position.quantity,
          averageEntryPrice: source.position.average_entry_price,
          marketValueKrw: source.referencePrice === null
            ? "0"
            : new Decimal(source.position.quantity).mul(source.referencePrice).toFixed(),
          unrealizedPnlKrw: source.unrealizedPnl,
        },
    trace: {
      latestReconcileRunId: source.reconcile.runId,
      latestReconcileAt: source.reconcile.finishedAt,
      sourceTables: [
        "live_reconcile_runs",
        "live_reconcile_balance_snapshots",
        "positions",
        "fills",
        "orderbook_metrics",
        "pnl_snapshots",
      ],
      referencePriceSource: source.referencePriceSource,
    },
  };
  return {
    strategy_id: strategyId,
    market,
    captured_at: capturedAt,
    equity: normalizeNonNegativeDecimal(source.equity, "snapshot.equity"),
    realizedPnl: normalizeDecimal(source.realizedPnl),
    unrealizedPnl: normalizeDecimal(source.unrealizedPnl),
    drawdownBps: normalizeNonNegativeDecimal(source.drawdownBps, "snapshot.drawdown_bps"),
    sourceFingerprint,
    payload_json: payload,
  };
}

async function persistLiveOpsPnlSnapshot({ pool, snapshot }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lockKey = [
      snapshot.captured_at,
      snapshot.strategy_id,
      snapshot.market ?? "",
      snapshot.sourceFingerprint,
    ].join("|");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
    const existing = await client.query(`
      SELECT strategy_id, market, captured_at
      FROM pnl_snapshots
      WHERE strategy_id = $1
        AND market = $2
        AND captured_at = $3
        AND payload_json ->> 'sourceFingerprint' = $4
      LIMIT 1
    `, [
      snapshot.strategy_id,
      snapshot.market,
      snapshot.captured_at,
      snapshot.sourceFingerprint,
    ]);
    if (existing.rows[0] !== undefined) {
      await client.query("COMMIT");
      return { inserted: false };
    }

    // PnL snapshot은 broker 제출 guard가 읽는 audit evidence이므로 clean source 확인 뒤 append-only로만 기록한다.
    await client.query(`
      INSERT INTO pnl_snapshots (
        strategy_id,
        market,
        captured_at,
        equity,
        realized_pnl,
        unrealized_pnl,
        drawdown_bps,
        payload_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      RETURNING strategy_id, market, captured_at
    `, [
      snapshot.strategy_id,
      snapshot.market,
      snapshot.captured_at,
      snapshot.equity,
      snapshot.realizedPnl,
      snapshot.unrealizedPnl,
      snapshot.drawdownBps,
      JSON.stringify(snapshot.payload_json),
    ]);
    await client.query("COMMIT");
    return { inserted: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function computeUnrealizedPnl({ position, referencePrice }) {
  if (position === undefined || new Decimal(position.quantity).eq(0)) {
    return new Decimal(0);
  }
  if (referencePrice === undefined || referencePrice === null) {
    throw new Error("ReferencePriceRequiredForOpenPosition");
  }
  return new Decimal(position.quantity).mul(new Decimal(referencePrice).minus(position.average_entry_price));
}

function computeDrawdownBps(currentEquity, history) {
  if (currentEquity.lte(0)) {
    return "0";
  }
  let peak = currentEquity;
  for (const snapshot of history) {
    const equity = new Decimal(snapshot.equity);
    if (equity.gt(peak)) {
      peak = equity;
    }
  }
  if (peak.lte(0) || currentEquity.gte(peak)) {
    return "0";
  }
  return peak.minus(currentEquity).div(peak).mul(10_000).toFixed(6).replace(/\.?0+$/u, "");
}

function computeSourceFingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify({
      market: value.market,
      strategyId: value.strategyId,
      capturedAt: value.capturedAt,
      reconcileRunId: value.source.reconcile.runId,
      reconcileAt: value.source.reconcile.finishedAt,
      balances: value.source.balances.map((balance) => [
        balance.currency,
        balance.available,
        balance.locked,
        balance.total,
      ]),
      position: value.source.position ?? null,
      equity: value.source.equity,
      realizedPnl: value.source.realizedPnl,
      unrealizedPnl: value.source.unrealizedPnl,
      drawdownBps: value.source.drawdownBps,
    }))
    .digest("hex");
}

function blockedSource(reasonCode, message, trace) {
  return {
    status: "blocked",
    reasonCode,
    message,
    trace,
  };
}

function parseLiveOpsPnlCloseoutEnvFile(content) {
  const env = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalIndex = normalized.indexOf("=");
    if (equalIndex <= 0) {
      continue;
    }
    const key = normalized.slice(0, equalIndex).trim();
    const value = stripEnvQuotes(normalized.slice(equalIndex + 1).trim());
    env[key] = value;
  }
  return env;
}

function stripEnvQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function createLiveOpsPnlCloseoutPostgresPool(databaseUrl) {
  return new PgPool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: dbConnectionTimeoutMs,
    max: 2,
    idleTimeoutMillis: 1_000,
    allowExitOnIdle: true,
  });
}

function formatLiveOpsPnlCloseoutHelp() {
  return `Usage:
  corepack pnpm live:ops:pnl-closeout -- --env-file <path> [--market KRW-BTC] [--strategy-id live_ops_cleanup_probe] [--json]

Purpose:
  live:ops 제출 전 clean reconcile/balance source로 CALCULATED PnL snapshot을 append-only 생성합니다.
  secret 원문, DB URL, raw provider payload는 출력하지 않습니다.
`;
}

function formatLiveOpsPnlCloseoutResult(result) {
  const lines = [
    "Seemirai Live Ops PnL Closeout",
    `상태: ${result.status === "ready" ? "준비 완료" : "차단"}`,
    `시장: ${result.market}`,
    `전략: ${result.strategyId}`,
    `캡처 시각: ${result.capturedAt}`,
    `메시지: ${result.message}`,
  ];
  if (result.status === "ready") {
    lines.push(
      `실현 손익: ${result.realizedPnlKrw} KRW`,
      `미실현 손익: ${result.unrealizedPnlKrw} KRW`,
      `평가 자산: ${result.equityKrw} KRW`,
      `저장: ${result.inserted ? "신규 snapshot" : "기존 snapshot 재사용"}`,
    );
  } else {
    lines.push(`추적 정보: reason=${result.reasonCode}`);
  }
  return `${lines.join("\n")}\n`;
}

function readArgValue(argv, index, arg) {
  const value = argv[index + 1];
  if (!hasMeaningfulValue(value) || String(value).startsWith("--")) {
    throw new Error(`${arg} 값이 필요합니다.`);
  }
  return value;
}

function normalizeMarket(value) {
  if (!hasMeaningfulValue(value) || !/^[A-Z]{2,10}-[A-Z0-9]{2,20}$/u.test(String(value))) {
    throw new Error("market은 예: KRW-BTC 형식이어야 합니다.");
  }
  return String(value);
}

function normalizeStrategyId(value) {
  if (!hasMeaningfulValue(value) || !/^[a-z0-9_:-]{1,80}$/u.test(String(value))) {
    throw new Error("strategy-id는 비어 있지 않은 stable 식별자여야 합니다.");
  }
  return String(value);
}

function readMarketBaseCurrency(market) {
  const [, base] = market.split("-");
  return base;
}

function findBalance(balances, currency) {
  return balances.find((balance) => balance.currency === currency);
}

function readBalanceTotal(balance) {
  if (balance === undefined) {
    return new Decimal(0);
  }
  return new Decimal(balance.total);
}

function normalizeIsoTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) {
    throw new Error(`${label}은 ISO timestamp여야 합니다.`);
  }
  return date.toISOString();
}

function toIsoString(value) {
  return normalizeIsoTimestamp(value, "timestamp");
}

function isFreshTimestamp(sourceAt, observedAt, maxAgeMs) {
  if (!hasMeaningfulValue(sourceAt)) {
    return false;
  }
  const sourceMs = Date.parse(String(sourceAt));
  const observedMs = Date.parse(String(observedAt));
  if (!Number.isFinite(sourceMs) || !Number.isFinite(observedMs)) {
    return false;
  }
  const ageMs = observedMs - sourceMs;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

function timestampSortKey(value) {
  if (!hasMeaningfulValue(value)) {
    return Number.NEGATIVE_INFINITY;
  }
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function balanceSourcePriority(source) {
  switch (String(source ?? "").toUpperCase()) {
    case "REST":
      return 2;
    case "WS":
      return 1;
    default:
      return 0;
  }
}

function nullableNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function numberRowValue(value) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function normalizeDecimal(value) {
  if (!isDecimalString(value)) {
    throw new Error("decimal value가 유효하지 않습니다.");
  }
  return new Decimal(String(value)).toFixed();
}

function normalizeNonNegativeDecimal(value, label) {
  if (!isNonNegativeDecimalString(value)) {
    throw new Error(`${label}은 0 이상 decimal이어야 합니다.`);
  }
  return new Decimal(String(value)).toFixed();
}

function isDecimalString(value) {
  if (value === null || value === undefined) {
    return false;
  }
  try {
    const decimal = new Decimal(String(value));
    return decimal.isFinite();
  } catch {
    return false;
  }
}

function isPositiveDecimalString(value) {
  return isDecimalString(value) && new Decimal(String(value)).gt(0);
}

function isNonNegativeDecimalString(value) {
  return isDecimalString(value) && new Decimal(String(value)).gte(0);
}

function hasMeaningfulValue(value) {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
