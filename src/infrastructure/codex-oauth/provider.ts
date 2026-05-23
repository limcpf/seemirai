import { mkdtemp, readFile, rm } from "node:fs/promises";
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
        const finalMessage = await readFile(outputPath, "utf8");

        if (Buffer.byteLength(finalMessage, "utf8") > runOptions.maxOutputBytes) {
          return {
            finalMessage,
            exitCode,
          };
        }

        return {
          finalMessage,
          exitCode,
        };
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
        "--ask-for-approval",
        "never",
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
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGTERM");
      reject(new CodexOAuthCommandTimeoutError());
    }, options.timeoutMs);

    child.once("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      reject(new CodexOAuthCommandError(error.message, null));
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve(code ?? 1);
    });

    child.stdin.end(options.prompt);
  });
}
