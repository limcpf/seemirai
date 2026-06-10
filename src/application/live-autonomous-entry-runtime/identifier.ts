import { randomBytes } from "node:crypto";
import type { LiveAutonomousEntryRuntimeConfig } from "./types.js";

/**
 * M22 autonomous entry identifier suffix에 사용할 random byte 수다.
 *
 * 13 bytes는 26자리 lower hex 문자열이 되며, 기본 prefix `m22a-`와 합쳐도 32자 보수 한도 안에 들어간다.
 */
export const LIVE_AUTONOMOUS_ENTRY_IDENTIFIER_RANDOM_BYTES = 13;
const LIVE_AUTONOMOUS_ENTRY_IDENTIFIER_MAX_LENGTH = 32;

/**
 * M22 autonomous entry identifier random suffix 생성기다.
 *
 * 기본 구현은 `crypto.randomBytes(13).toString("hex")`를 사용한다. 테스트는 결정론적 generator를 주입할 수 있으며,
 * 반환값은 lower hex 문자열이어야 한다.
 */
export type LiveAutonomousIdentifierRandomHexGenerator = (bytes: number) => string;

/**
 * M22 autonomous entry identifier 정책 위반 오류다.
 *
 * identifier는 Upbit 주문 `identifier`와 ExecutionEngine idempotency key로 동시에 쓰이므로 길이와 문자 집합이 깨지면
 * broker 제출 전에 중단해야 한다.
 */
export class UnsafeLiveAutonomousIdentifierError extends Error {
  public readonly violations: readonly string[];

  public constructor(violations: readonly string[]) {
    super(`안전하지 않은 M22 autonomous identifier: ${violations.join(", ")}`);
    this.name = "UnsafeLiveAutonomousIdentifierError";
    this.violations = violations;
  }
}

/**
 * M22 autonomous entry용 random identifier를 만든다.
 *
 * timestamp나 단순 증가값을 쓰면 재시작/중복 제출에서 충돌할 수 있으므로 13 bytes random hex suffix를 강제한다. 이 함수는
 * 로컬 난수 생성 외 외부 side effect가 없으며, 반환값은 `identifier_max_length`와 M22 보수 한도 32자를 모두 만족해야 한다.
 */
export function createLiveAutonomousIdentifier(
  config: Pick<LiveAutonomousEntryRuntimeConfig, "identifier_prefix" | "identifier_max_length">,
  randomHex: LiveAutonomousIdentifierRandomHexGenerator = defaultRandomHex,
): string {
  const suffix = randomHex(LIVE_AUTONOMOUS_ENTRY_IDENTIFIER_RANDOM_BYTES);
  const identifier = `${config.identifier_prefix}${suffix}`;
  const violations = validateLiveAutonomousIdentifier(config, identifier);

  if (violations.length > 0) {
    throw new UnsafeLiveAutonomousIdentifierError(violations);
  }

  return identifier;
}

/**
 * M22 autonomous entry identifier가 재사용 가능한 안전한 값인지 검증한다.
 *
 * retry caller가 기존 attempt identifier를 주입할 때도 생성기와 같은 prefix, 13 bytes lower hex suffix, 32자 한도를 요구해
 * Upbit identifier와 ExecutionEngine idempotency key가 같은 정책을 유지하게 한다.
 */
export function validateLiveAutonomousIdentifier(
  config: Pick<LiveAutonomousEntryRuntimeConfig, "identifier_prefix" | "identifier_max_length">,
  identifier: string,
): readonly string[] {
  const suffix = identifier.startsWith(config.identifier_prefix)
    ? identifier.slice(config.identifier_prefix.length)
    : "";

  return collectIdentifierViolations(config, suffix, identifier);
}

function collectIdentifierViolations(
  config: Pick<LiveAutonomousEntryRuntimeConfig, "identifier_prefix" | "identifier_max_length">,
  suffix: string,
  identifier: string,
): string[] {
  const violations: string[] = [];

  if (!identifier.startsWith(config.identifier_prefix)) {
    violations.push("M22 identifier는 runtime identifier_prefix로 시작해야 합니다");
  }

  if (!/^[a-f0-9]{26}$/u.test(suffix)) {
    violations.push("M22 identifier suffix는 13 bytes lower hex여야 합니다");
  }

  if (!/^[a-z0-9-]+[a-f0-9]{26}$/u.test(identifier)) {
    violations.push("M22 identifier는 lowercase prefix와 random hex suffix만 사용할 수 있습니다");
  }

  if (identifier.length > config.identifier_max_length || identifier.length > LIVE_AUTONOMOUS_ENTRY_IDENTIFIER_MAX_LENGTH) {
    violations.push("M22 identifier는 32자 보수 한도와 runtime max length를 넘을 수 없습니다");
  }

  return violations;
}

function defaultRandomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
