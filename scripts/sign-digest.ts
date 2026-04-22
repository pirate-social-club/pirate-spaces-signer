#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { rpc } from "../src/json-rpc";
import {
  type NativeExecutionConfig,
  resolveNativeExecutionConfig,
  runNative,
  decodeNativeJson,
} from "../src/native";
import { ensureAtPrefix } from "../src/labels";

type Options = {
  space: string;
  digest: string;
  wallet: string;
  walletDir: string | null;
  spacesDataDir: string | null;
  rpcUrl: string;
  rpcAuthToken: string | null;
  rpcCookiePath: string | null;
  network: string;
  nativeBin: string | null;
  outpoint: string | null;
  allowNativeBuildFallback: boolean;
};

type RpcOutPoint = {
  txid: string;
  vout: number;
};

type RpcFullSpaceOut = {
  txid: string;
  n: number;
};

type WalletLocation = {
  walletDir: string;
  walletJsonPath: string;
};

function usage(exitCode = 1): never {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  bun scripts/sign-digest.ts --space @pirate --digest <hex> [options]

Signs a Pirate Spaces verification digest with the current root key from a local Spaces wallet.

Options:
  --space LABEL             Required. Top-level space label, with or without @
  --digest HEX              Required. 32-byte lowercase or 0x-prefixed hex digest
  --wallet NAME             Wallet label. Default: default
  --wallet-dir PATH         Wallet directory, or a wallet JSON file beside wallet.db
  --spaces-data-dir PATH    Base spaced data dir; used to derive wallet dir as <dir>/wallets/<wallet>
  --rpc-url URL             spaced RPC URL. Default: $SPACED_RPC_URL or http://127.0.0.1:7225
  --rpc-auth-token TOKEN    Precomputed Basic auth token for spaced RPC
  --rpc-cookie PATH         Cookie file used to derive Basic auth token
  --network NAME            Bitcoin network for wallet load. Default: mainnet
  --native-bin PATH         Prebuilt spaces-verifier-native binary to use
  --outpoint TXID:VOUT      Skip RPC owner lookup and sign for this outpoint directly
  -h, --help                Show this help text
`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    space: "",
    digest: "",
    wallet: process.env.SPACES_WALLET?.trim() || "default",
    walletDir: process.env.SPACES_WALLET_DIR?.trim() || null,
    spacesDataDir: process.env.SPACES_DATA_DIR?.trim() || null,
    rpcUrl: process.env.SPACED_RPC_URL?.trim() || "http://127.0.0.1:7225",
    rpcAuthToken: process.env.SPACED_RPC_AUTH_TOKEN?.trim() || null,
    rpcCookiePath: process.env.SPACED_RPC_COOKIE?.trim() || null,
    network: process.env.SPACES_NETWORK?.trim() || "mainnet",
    nativeBin: process.env.SPACES_VERIFIER_NATIVE_BIN?.trim() || null,
    outpoint: null,
    allowNativeBuildFallback: ["1", "true", "yes", "on"].includes(
      String(process.env.SPACES_NATIVE_ALLOW_BUILD_FALLBACK || "").trim().toLowerCase(),
    ),
  };

  for (let index = 0; index < argv.length; ) {
    const arg = argv[index];
    const value = argv[index + 1];

    switch (arg) {
      case "--space":
        options.space = value ?? "";
        index += 2;
        break;
      case "--digest":
        options.digest = value ?? "";
        index += 2;
        break;
      case "--wallet":
        options.wallet = value ?? options.wallet;
        index += 2;
        break;
      case "--wallet-dir":
        options.walletDir = value ?? options.walletDir;
        index += 2;
        break;
      case "--spaces-data-dir":
        options.spacesDataDir = value ?? options.spacesDataDir;
        index += 2;
        break;
      case "--rpc-url":
        options.rpcUrl = value ?? options.rpcUrl;
        index += 2;
        break;
      case "--rpc-auth-token":
        options.rpcAuthToken = value ?? options.rpcAuthToken;
        index += 2;
        break;
      case "--rpc-cookie":
        options.rpcCookiePath = value ?? options.rpcCookiePath;
        index += 2;
        break;
      case "--network":
        options.network = value ?? options.network;
        index += 2;
        break;
      case "--native-bin":
        options.nativeBin = value ?? options.nativeBin;
        index += 2;
        break;
      case "--outpoint":
        options.outpoint = value ?? null;
        index += 2;
        break;
      case "-h":
      case "--help":
        usage(0);
        break;
      default:
        console.error(`unknown argument: ${arg}`);
        usage();
    }
  }

  return options;
}

function normalizeDigest(value: string): string {
  return value.trim().replace(/^0x/i, "").toLowerCase();
}

function resolveWalletLocation(options: Options): WalletLocation {
  if (options.walletDir) {
    const explicitWalletPath = path.resolve(options.walletDir);
    if (existsSync(explicitWalletPath) && statSync(explicitWalletPath).isFile()) {
      return {
        walletDir: path.dirname(explicitWalletPath),
        walletJsonPath: explicitWalletPath,
      };
    }
    return {
      walletDir: explicitWalletPath,
      walletJsonPath: path.join(explicitWalletPath, "wallet.json"),
    };
  }
  if (!options.spacesDataDir) {
    throw new Error("missing wallet location: set --wallet-dir or --spaces-data-dir");
  }
  const directWalletDir = path.join(options.spacesDataDir, "wallets", options.wallet);
  if (existsSync(directWalletDir)) {
    return {
      walletDir: directWalletDir,
      walletJsonPath: path.join(directWalletDir, "wallet.json"),
    };
  }

  const networkWalletDir = path.join(options.spacesDataDir, options.network, "wallets", options.wallet);
  if (existsSync(networkWalletDir)) {
    return {
      walletDir: networkWalletDir,
      walletJsonPath: path.join(networkWalletDir, "wallet.json"),
    };
  }

  return {
    walletDir: directWalletDir,
    walletJsonPath: path.join(directWalletDir, "wallet.json"),
  };
}

function validateWalletLocation(location: WalletLocation): WalletLocation {
  const walletDbPath = path.join(location.walletDir, "wallet.db");
  const walletJsonName = path.basename(location.walletJsonPath);
  if (!existsSync(location.walletJsonPath)) {
    throw new Error(`wallet JSON not found: ${location.walletJsonPath}`);
  }
  let walletJson: unknown;
  try {
    walletJson = JSON.parse(readFileSync(location.walletJsonPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`failed to parse ${walletJsonName}: ${message}`);
  }
  if (
    typeof walletJson !== "object" ||
    walletJson == null ||
    typeof (walletJson as { descriptor?: unknown }).descriptor !== "string" ||
    typeof (walletJson as { blockheight?: unknown }).blockheight !== "number" ||
    typeof (walletJson as { label?: unknown }).label !== "string"
  ) {
    throw new Error(`${walletJsonName} must contain descriptor, blockheight, and label`);
  }
  if (!existsSync(walletDbPath)) {
    throw new Error(`wallet.db not found next to ${walletJsonName}: ${location.walletDir}`);
  }
  return location;
}

function getRpcAuthToken(options: Options): string | null {
  if (options.rpcAuthToken) {
    return options.rpcAuthToken;
  }
  if (!options.rpcCookiePath) {
    return null;
  }
  const cookie = readFileSync(options.rpcCookiePath, "utf8").trim();
  return Buffer.from(cookie).toString("base64");
}

async function spacedRpc<T>(options: Options, method: string, params: unknown[]): Promise<T> {
  const authToken = getRpcAuthToken(options);
  return rpc<T>(options.rpcUrl, authToken, method, params);
}

async function resolveOutpoint(options: Options, space: string): Promise<string> {
  if (options.outpoint) {
    return options.outpoint;
  }

  try {
    const owner = await spacedRpc<RpcOutPoint | null>(options, "getspaceowner", [space]);
    if (owner?.txid != null && typeof owner.vout === "number") {
      return `${owner.txid}:${owner.vout}`;
    }
  } catch {
    // Fall through to getspace for older or narrower RPC surfaces.
  }

  const spaceout = await spacedRpc<RpcFullSpaceOut | null>(options, "getspace", [space]);
  if (spaceout?.txid != null && typeof spaceout.n === "number") {
    return `${spaceout.txid}:${spaceout.n}`;
  }

  throw new Error(`space not found or current owner outpoint unavailable for ${space}`);
}

function resolveNativeConfig(options: Options): NativeExecutionConfig {
  const nativeManifestPath = path.join(import.meta.dir, "..", "native", "Cargo.toml");
  return resolveNativeExecutionConfig({
    nativeBin: options.nativeBin,
    allowNativeBuildFallback: options.allowNativeBuildFallback,
    nativeManifestPath,
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const space = ensureAtPrefix(options.space);
  const digest = normalizeDigest(options.digest);

  if (!/^@[a-z0-9-]+$/.test(space)) {
    throw new Error("space must be a top-level label like @pirate");
  }
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("digest must be a 32-byte hex string");
  }

  const nativeConfig = resolveNativeConfig(options);
  const walletLocation = validateWalletLocation(resolveWalletLocation(options));
  const outpoint = await resolveOutpoint(options, space);
  const parsed = decodeNativeJson(
    runNative(nativeConfig, [
      "sign-digest",
      walletLocation.walletDir,
      options.network,
      outpoint,
      digest,
      walletLocation.walletJsonPath,
    ]),
    "native signer failed",
  ) as Record<string, unknown>;

  console.log(JSON.stringify({
    ...parsed,
    space,
    wallet: options.wallet,
    wallet_dir: walletLocation.walletDir,
    wallet_json: walletLocation.walletJsonPath,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "spaces digest signing failed");
  process.exit(1);
});
