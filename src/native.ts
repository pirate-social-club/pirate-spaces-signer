export type NativeExecutionConfig =
  | { mode: "binary"; command: string[] }
  | { mode: "cargo_dev_fallback"; command: string[] };

export function resolveNativeExecutionConfig(input: {
  nativeBin: string | null;
  allowNativeBuildFallback: boolean;
  nativeManifestPath: string;
}): NativeExecutionConfig {
  if (input.nativeBin) {
    return {
      mode: "binary",
      command: [input.nativeBin],
    };
  }

  if (input.allowNativeBuildFallback) {
    return {
      mode: "cargo_dev_fallback",
      command: [
        "cargo",
        "run",
        "--quiet",
        "--locked",
        "--manifest-path",
        input.nativeManifestPath,
        "--",
      ],
    };
  }

  throw new Error(
    "Spaces verifier native binary is not configured. Set SPACES_VERIFIER_NATIVE_BIN or explicitly enable SPACES_NATIVE_ALLOW_BUILD_FALLBACK=true for local development.",
  );
}

export function runNative(config: NativeExecutionConfig, args: string[]) {
  return Bun.spawnSync([...config.command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

export function decodeNativeJson<T extends { error?: string }>(
  result: Bun.SpawnSyncReturns<Uint8Array>,
  fallbackErrorMessage = "native verifier failed",
): T {
  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  const stderr = Buffer.from(result.stderr).toString("utf8").trim();
  if (result.exitCode !== 0) {
    throw new Error(stderr || stdout || fallbackErrorMessage);
  }
  const payload =
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}")) ?? stdout;
  let parsed: T;
  try {
    parsed = JSON.parse(payload) as T;
  } catch {
    const details = [stdout && `stdout: ${stdout}`, stderr && `stderr: ${stderr}`]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      details
        ? `${fallbackErrorMessage}: invalid native JSON\n${details}`
        : `${fallbackErrorMessage}: invalid native JSON`,
    );
  }
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  return parsed;
}
