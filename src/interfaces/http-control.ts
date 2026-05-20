import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { assertHttpControlConfig, createLocalControlAuthPreHandler } from "./http-control/auth.js";
import {
  DEFAULT_HTTP_CONTROL_HOST,
  DEFAULT_HTTP_CONTROL_PORT,
  UnsafeHttpControlConfigError,
} from "./http-control/types.js";
import type { HttpControlListenOptions, HttpControlServerOptions } from "./http-control/types.js";
import { createErrorResponse, getCorrelationId, getErrorStatusCode, toErrorMessage } from "./http-control/errors.js";
import { createKillSwitchControlRouteHandler } from "./http-control/kill-switch.js";
import type { KillSwitchControlRequestBody } from "./http-control/kill-switch.js";
import { healthzRouteOptions, killSwitchRouteOptions, readyzRouteOptions, statusRouteOptions } from "./http-control/schemas.js";

export { assertHttpControlConfig, authenticateLocalControlRequest, createLocalControlAuthPreHandler } from "./http-control/auth.js";
export { createControlReadinessProvider, createDatabaseControlReadinessProvider } from "./http-control/readiness.js";
export { createDatabaseControlStatusProvider } from "./http-control/status.js";
export {
  DEFAULT_HTTP_CONTROL_HOST,
  DEFAULT_HTTP_CONTROL_PORT,
  UnsafeHttpControlConfigError,
} from "./http-control/types.js";
export type {
  ControlOverallStatus,
  ControlReadinessCheckResult,
  ControlReadinessProvider,
  ControlReadinessStatus,
  ControlReadinessSummary,
  ControlStatusProvider,
  ControlStatusSnapshot,
  CreateDatabaseControlStatusProviderOptions,
  CreateDatabaseReadinessProviderOptions,
  HttpControlListenOptions,
  HttpControlServerOptions,
  LocalControlAuthInput,
  LocalControlAuthResult,
} from "./http-control/types.js";
export { createKillSwitchControlRouteHandler } from "./http-control/kill-switch.js";
export type { KillSwitchControlRequestBody } from "./http-control/kill-switch.js";

/**
 * M8 HTTP control API의 최소 Fastify server를 만든다.
 *
 * Sub PR 1은 읽기 전용 health/readiness/status endpoint와 POST control endpoint가 쓸 공통 bearer guard만 고정한다.
 * kill switch 상태 전이 실행은 후속 PR에서 이 foundation 위에 얹는다.
 *
 * - `/healthz`: 프로세스 생존 확인만 수행한다.
 * - `/readyz`: DB, migration, runtime config처럼 worker 기동에 필요한 의존성을 판단한다.
 * - `/status`: trading state와 운영 snapshot을 secret 없이 반환한다.
 */
export function createHttpControlServer(options: HttpControlServerOptions): FastifyInstance {
  const controlPostEndpointsEnabled =
    options.controlPostEndpointsEnabled === true || options.killSwitchControlProvider !== undefined;
  assertHttpControlConfig({
    ...options,
    controlPostEndpointsEnabled,
  });

  if (controlPostEndpointsEnabled && options.killSwitchControlProvider === undefined) {
    throw new UnsafeHttpControlConfigError([
      "kill switch control provider is required when POST control endpoints are enabled",
    ]);
  }

  const server = Fastify({
    logger: options.logger ?? false,
  });

  server.setErrorHandler((error, request, reply) => {
    const statusCode = getErrorStatusCode(error);
    // 5xx에서는 내부 예외 message를 숨기고 correlation id만 남겨 로그 추적 경계를 유지한다.
    return reply.status(statusCode).send(
      createErrorResponse({
        correlationId: getCorrelationId(request),
        code: statusCode >= 500 ? "internal_error" : "bad_request",
        message: statusCode >= 500 ? "internal server error" : toErrorMessage(error),
      }),
    );
  });

  // healthz는 DB 장애와 분리된 process liveness만 확인해 supervisor restart 오판을 줄인다.
  server.get("/healthz", healthzRouteOptions, async (request) => ({
    status: "ok",
    service: "seemirai",
    check: "process",
    timestamp: new Date().toISOString(),
    uptimeSeconds: process.uptime(),
    correlationId: getCorrelationId(request),
  }));

  server.get("/readyz", readyzRouteOptions, async (_request, reply) => {
    const readiness = await options.readinessProvider.check();
    // critical readiness 실패는 traffic과 worker 기동 차단을 위해 HTTP 503으로 드러낸다.
    return reply.status(readiness.ready ? 200 : 503).send(readiness);
  });

  server.get("/status", statusRouteOptions, async (request) => {
    const snapshot = await options.statusProvider.getStatus();
    // status는 거래 차단 상태를 포함하되 readiness 실패와 독립적으로 관측 가능해야 한다.
    return {
      status: "ok",
      correlationId: getCorrelationId(request),
      ...snapshot,
    };
  });

  if (options.killSwitchControlProvider !== undefined) {
    server.post<{ Body: KillSwitchControlRequestBody }>(
      "/kill-switch",
      {
        ...killSwitchRouteOptions,
        preHandler: createLocalControlAuthPreHandler(options.localControlToken),
      },
      createKillSwitchControlRouteHandler(options.killSwitchControlProvider),
    );
  }

  return server;
}

/**
 * HTTP server listen 기본값을 고정한다.
 */
export function getHttpControlListenOptions(
  options: HttpControlListenOptions = {},
): Required<HttpControlListenOptions> {
  return {
    host: options.host ?? DEFAULT_HTTP_CONTROL_HOST,
    port: options.port ?? DEFAULT_HTTP_CONTROL_PORT,
  };
}
