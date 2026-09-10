import * as NodeChildProcess from "node:child_process";

export interface BashResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run an installer script with bash and capture the outcome. Throws a clear
 * error when bash itself is missing so behavior coverage can never pass
 * vacuously on runners without bash.
 */
export function tryBash(
  scriptPath: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): BashResult {
  try {
    const stdout = NodeChildProcess.execFileSync("bash", [scriptPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    // SAFETY: execFileSync throws a bare Error carrying status/stdout/stderr
    // fields; the optional reads immediately below tolerate their absence.
    const failure = error as {
      status?: number;
      stdout?: unknown;
      stderr?: unknown;
      code?: string;
    };
    if (failure.code === "ENOENT") {
      throw new Error("bash is required for installer behavior tests but was not found on PATH", {
        cause: error,
      });
    }
    return {
      status: failure.status ?? 1,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? ""),
    };
  }
}
