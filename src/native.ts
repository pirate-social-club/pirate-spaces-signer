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
        "--offline",
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
  const parsed = JSON.parse(stdout) as T;
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  return parsed;
}
