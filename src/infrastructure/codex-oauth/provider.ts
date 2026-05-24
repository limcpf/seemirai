import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  LlmRiskAssistantProviderPort,
  LlmRiskAssistantProviderRequest,
  LlmRiskAssistantProviderResponse,
} from "../../application/index.js";
import {
  createLlmProviderFailure,
  normalizeLlmProviderTextOutput,
} from "../../application/index.js";

export interface CodexOAuthCommandResult {
  finalMessage: string;
  exitCode: number;
  outputTooLarge?: boolean | undefined;
  outputBytes?: number | undefined;
}

export interface CodexOAuthCommandRunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  cwd?: string | undefined;
}

/**
 * Codex CLI 호출을 숨기는 runner port다.
 *
 * 실제 구현은 로컬 Codex OAuth 세션을 사용하지만 token/session 원문을 읽거나 반환하지 않는다. 테스트는 이 port를 fake로
 * 대체해 기본 검증이 외부 LLM 호출을 만들지 않게 한다.
 */
export interface CodexOAuthCommandRunner {
  run(prompt: string, options: CodexOAuthCommandRunOptions): Promise<CodexOAuthCommandResult>;
}

export interface CodexOAuthLlmProviderOptions {
  runner?: CodexOAuthCommandRunner | undefined;
  now?: (() => Date) | undefined;
}

export interface CreateCodexOAuthCommandRunnerOptions {
  executablePath?: string | undefined;
  cwd?: string | undefined;
}

export class CodexOAuthCommandTimeoutError extends Error {
  public constructor() {
    super("Codex OAuth command timed out.");
    this.name = "CodexOAuthCommandTimeoutError";
  }
}

export class CodexOAuthCommandError extends Error {
  public readonly exitCode: number | null;

  public constructor(message: string, exitCode: number | null) {
    super(message);
    this.name = "CodexOAuthCommandError";
    this.exitCode = exitCode;
  }
}

/**
 * 로컬 Codex OAuth 세션을 사용하는 LLM risk assistant provider다.
 *
 * provider는 Codex CLI의 마지막 메시지만 normalized schema로 검증한다. timeout, invalid JSON, free-form output,
 * schema mismatch는 모두 거래 신호 없이 failure evidence로 반환한다.
 */
export class CodexOAuthLlmProvider implements LlmRiskAssistantProviderPort {
  public readonly providerId = "codex_oauth" as const;

  private readonly runner: CodexOAuthCommandRunner;
  private readonly now: () => Date;

  public constructor(options: CodexOAuthLlmProviderOptions = {}) {
    this.runner = options.runner ?? createCodexOAuthCommandRunner();
    this.now = options.now ?? (() => new Date());
  }

  public async generate(
    request: LlmRiskAssistantProviderRequest,
  ): Promise<LlmRiskAssistantProviderResponse> {
    try {
      const commandResult = await this.runner.run(request.prompt, {
        timeoutMs: request.timeout_ms,
        maxOutputBytes: request.max_output_bytes,
      });

      if (commandResult.exitCode !== 0) {
        // Codex CLI 실패는 raw stderr/stdout 없이 provider_error로만 남겨 OAuth 세션 정보가 evidence에 섞이지 않게 한다.
        return createLlmProviderFailure({
          providerId: this.providerId,
          failureClass: "provider_error",
          reasonCode: "codex_oauth_provider_exit_nonzero",
          message: "Codex OAuth provider command failed.",
          failedAt: this.now(),
          metadata: {
            exit_code: commandResult.exitCode,
          },
        });
      }

      if (commandResult.outputTooLarge) {
        // 파일 크기 기준으로 이미 과대 응답이 확인됐으므로 본문을 읽지 않고 fail-closed evidence만 남긴다.
        return createLlmProviderFailure({
          providerId: this.providerId,
          failureClass: "output_too_large",
          reasonCode: "llm_provider_output_too_large",
          message: "LLM provider output exceeded the configured byte limit.",
          failedAt: this.now(),
          metadata: {
            output_bytes: commandResult.outputBytes,
            max_output_bytes: request.max_output_bytes,
          },
        });
      }

      return normalizeLlmProviderTextOutput({
        providerId: this.providerId,
        input: request.input,
        resultType: request.result_type,
        rawOutput: commandResult.finalMessage,
        maxOutputBytes: request.max_output_bytes,
        observedAt: this.now(),
      });
    } catch (error) {
      if (error instanceof CodexOAuthCommandTimeoutError) {
        // provider timeout은 전략 신호 없이 실패 evidence만 남겨 runtime이 신규 주문 허용으로 오인하지 못하게 한다.
        return createLlmProviderFailure({
          providerId: this.providerId,
          failureClass: "timeout",
          reasonCode: "codex_oauth_provider_timeout",
          message: "Codex OAuth provider timed out.",
          failedAt: this.now(),
          metadata: {
            timeout_ms: request.timeout_ms,
          },
        });
      }

      if (error instanceof CodexOAuthCommandError) {
        return createLlmProviderFailure({
          providerId: this.providerId,
          failureClass: "provider_error",
          reasonCode: "codex_oauth_provider_error",
          message: "Codex OAuth provider command failed.",
          failedAt: this.now(),
          metadata: {
            exit_code: error.exitCode,
          },
        });
      }

      throw error;
    }
  }
}

/**
 * Codex CLI 기반 command runner를 만든다.
 *
 * `codex exec`는 `--output-last-message` 파일만 읽어 normalized output으로 사용한다. stdout/stderr는 반환하지 않아
 * prompt나 credential-like 문자열이 application failure evidence로 전파되지 않게 한다.
 */
export function createCodexOAuthCommandRunner(
  options: CreateCodexOAuthCommandRunnerOptions = {},
): CodexOAuthCommandRunner {
  const executablePath = options.executablePath ?? "codex";

  return {
    async run(prompt: string, runOptions: CodexOAuthCommandRunOptions): Promise<CodexOAuthCommandResult> {
      const tempDir = await mkdtemp(path.join(tmpdir(), "seemirai-codex-oauth-"));
      const outputPath = path.join(tempDir, "last-message.txt");

      try {
        const exitCode = await runCodexExecCommand({
          executablePath,
          prompt,
          outputPath,
          timeoutMs: runOptions.timeoutMs,
          cwd: runOptions.cwd ?? options.cwd ?? process.cwd(),
        });
        if (exitCode !== 0) {
          // 인증 실패나 초기 CLI 오류에서는 last-message 파일이 없을 수 있으므로 본문 읽기를 시도하지 않는다.
          return {
            finalMessage: "",
            exitCode,
          };
        }

        return await readCodexLastMessageFile({
          outputPath,
          exitCode,
          maxOutputBytes: runOptions.maxOutputBytes,
        });
      } finally {
        await rm(tempDir, {
          recursive: true,
          force: true,
        });
      }
    },
  };
}

export function createCodexOAuthLlmProvider(
  options: CodexOAuthLlmProviderOptions = {},
): CodexOAuthLlmProvider {
  return new CodexOAuthLlmProvider(options);
}

/**
 * Codex CLI가 남긴 마지막 메시지 파일을 runner 결과로 변환한다.
 *
 * 파일 부재, 권한 오류, I/O 오류는 raw 예외로 전파하지 않고 command failure로 바꾼다. provider는 이 오류를 받아
 * token/session-like 문자열 없는 provider_error evidence만 남긴다.
 */
async function readCodexLastMessageFile(options: {
  outputPath: string;
  exitCode: number;
  maxOutputBytes: number;
}): Promise<CodexOAuthCommandResult> {
  let outputStat: Awaited<ReturnType<typeof stat>>;

  try {
    outputStat = await stat(options.outputPath);
  } catch (error) {
    // exit 0이어도 output file이 없으면 성공 결과를 조립할 수 없으므로 provider failure 경로로 보낸다.
    throw createCodexOAuthOutputAccessError("stat", error);
  }

  if (outputStat.size > options.maxOutputBytes) {
    return {
      finalMessage: "",
      exitCode: options.exitCode,
      outputTooLarge: true,
      outputBytes: outputStat.size,
    };
  }

  try {
    const finalMessage = await readFile(options.outputPath, "utf8");

    return {
      finalMessage,
      exitCode: options.exitCode,
    };
  } catch (error) {
    // stat 이후 read가 실패하는 TOCTOU/권한 오류도 partial response 대신 동일한 failure evidence로 접는다.
    throw createCodexOAuthOutputAccessError("read", error);
  }
}

function createCodexOAuthOutputAccessError(operation: "stat" | "read", error: unknown): CodexOAuthCommandError {
  const causeMessage = error instanceof Error ? error.message : "Unknown output file access error.";

  return new CodexOAuthCommandError(`Codex OAuth output ${operation} failed: ${causeMessage}`, null);
}

function runCodexExecCommand(options: {
  executablePath: string;
  prompt: string;
  outputPath: string;
  timeoutMs: number;
  cwd: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.executablePath,
      [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "-c",
        'approval_policy="never"',
        "--output-last-message",
        options.outputPath,
        "-",
      ],
      {
        cwd: options.cwd,
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    let settled = false;
    let timedOut = false;
    let killTimeout: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      clearTimeout(timeout);

      if (killTimeout !== undefined) {
        clearTimeout(killTimeout);
      }
    };

    const rejectWithCommandError = (error: Error): void => {
      if (settled || timedOut) {
        return;
      }

      settled = true;
      clearTimers();
      reject(new CodexOAuthCommandError(error.message, null));
    };

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      timedOut = true;
      child.kill("SIGTERM");
      // SIGTERM을 무시하는 child가 남으면 다음 provider 호출까지 리소스를 점유하므로 짧은 grace 뒤 강제 종료한다.
      killTimeout = setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 1_000);
    }, options.timeoutMs);

    child.once("error", rejectWithCommandError);
    child.stdin.once("error", rejectWithCommandError);

    child.once("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();

      if (timedOut) {
        reject(new CodexOAuthCommandTimeoutError());
        return;
      }

      resolve(code ?? 1);
    });

    try {
      child.stdin.end(options.prompt);
    } catch (error) {
      rejectWithCommandError(error instanceof Error ? error : new Error("Codex stdin write failed."));
    }
  });
}
