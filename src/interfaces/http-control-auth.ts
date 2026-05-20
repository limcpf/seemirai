import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createErrorResponse, getCorrelationId } from "./http-control-errors.js";
import { UnsafeHttpControlConfigError } from "./http-control-types.js";
import type { LocalControlAuthInput, LocalControlAuthResult } from "./http-control-types.js";

/**
 * POST control endpoint가 켜질 때 local token 누락으로 시작하지 않도록 막는다.
 */
export function assertHttpControlConfig(options: {
  controlPostEndpointsEnabled?: boolean;
  localControlToken?: string;
}): void {
  const violations: string[] = [];

  if (options.controlPostEndpointsEnabled && isBlankToken(options.localControlToken)) {
    // 쓰기형 control route가 무인증으로 열리는 설정은 시작 시점에 바로 차단한다.
    violations.push("local control token is required when POST control endpoints are enabled");
  }

  if (violations.length > 0) {
    throw new UnsafeHttpControlConfigError(violations);
  }
}

/**
 * 후속 POST control route에서 재사용할 local bearer token 검증 함수다.
 *
 * 실패 사유별 status code와 error code를 분리해 운영자가 인증 누락, 형식 오류, token 불일치를 구분할 수 있게 한다.
 */
export function authenticateLocalControlRequest(input: LocalControlAuthInput): LocalControlAuthResult {
  const expectedToken = normalizeToken(input.expectedToken);
  if (expectedToken === undefined) {
    // 보호 route가 token 없이 조립된 상태는 요청자 문제가 아니라 서버 설정 오류로 본다.
    return {
      ok: false,
      statusCode: 500,
      correlationId: input.correlationId,
      code: "local_control_token_not_configured",
      message: "local control token is not configured",
    };
  }

  if (input.authorizationHeader === undefined || input.authorizationHeader.trim() === "") {
    // header 자체가 없으면 credential challenge가 가능한 인증 누락으로 응답한다.
    return {
      ok: false,
      statusCode: 401,
      correlationId: input.correlationId,
      code: "authorization_required",
      message: "Authorization bearer token is required",
    };
  }

  const match = /^Bearer\s+(?<token>.+)$/iu.exec(input.authorizationHeader.trim());
  if (match?.groups?.token === undefined || match.groups.token.trim() === "") {
    // scheme은 대소문자를 허용하되 Bearer token 형식 자체는 엄격하게 유지한다.
    return {
      ok: false,
      statusCode: 401,
      correlationId: input.correlationId,
      code: "invalid_authorization_format",
      message: "Authorization must use Bearer token format",
    };
  }

  if (!constantTimeTokenEquals(match.groups.token, expectedToken)) {
    // token이 존재하지만 일치하지 않으면 인증 시도 실패로 보고 권한 거부를 반환한다.
    return {
      ok: false,
      statusCode: 403,
      correlationId: input.correlationId,
      code: "invalid_local_control_token",
      message: "local control token does not match",
    };
  }

  return {
    ok: true,
    correlationId: input.correlationId,
  };
}

/**
 * Fastify route `preHandler`로 쓸 bearer guard를 만든다.
 *
 * route 등록 시점에 token이 없으면 예외를 던져, 보호 route가 실수로 열린 상태로 부팅되지 않게 한다.
 */
export function createLocalControlAuthPreHandler(expectedToken: string | undefined) {
  const normalizedToken = normalizeToken(expectedToken);
  if (normalizedToken === undefined) {
    throw new UnsafeHttpControlConfigError([
      "local control token is required for protected control routes",
    ]);
  }

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = authenticateLocalControlRequest({
      authorizationHeader: readAuthorizationHeader(request),
      expectedToken: normalizedToken,
      correlationId: getCorrelationId(request),
    });

    if (!result.ok) {
      // route handler로 진입하기 전에 공통 error shape으로 인증 실패를 종료한다.
      return reply.status(result.statusCode).send(
        createErrorResponse({
          correlationId: result.correlationId,
          code: result.code,
          message: result.message,
        }),
      );
    }
  };
}

function readAuthorizationHeader(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" ? authorization : undefined;
}

function isBlankToken(token: string | undefined): boolean {
  return normalizeToken(token) === undefined;
}

function normalizeToken(token: string | undefined): string | undefined {
  if (token === undefined) {
    return undefined;
  }

  const trimmed = token.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * token 비교 시 입력 길이와 byte 단위 비교 시간을 직접 노출하지 않도록 digest끼리 비교한다.
 */
function constantTimeTokenEquals(actual: string, expected: string): boolean {
  return timingSafeEqual(sha256(actual), sha256(expected));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
