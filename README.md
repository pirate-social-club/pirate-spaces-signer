# Pirate Spaces Signer

Sign a Pirate-issued Spaces namespace verification digest with the wallet that owns a root Space.

This does not run Pirate's verifier service. It only signs a one-time challenge locally.

## Usage

```bash
bun install
SPACES_NATIVE_ALLOW_BUILD_FALLBACK=true bun scripts/sign-digest.ts \
  --space @pirate \
  --digest <digest> \
  --wallet-dir <path-to-spaces-wallet> \
  --network mainnet
```

Copy the `signature` value from the JSON output and paste it into Pirate.

## Options

```text
--space LABEL             Required. Top-level space label, with or without @
--digest HEX              Required. 32-byte lowercase or 0x-prefixed hex digest
--wallet NAME             Wallet label. Default: default
--wallet-dir PATH         Explicit wallet directory containing wallet.json and wallet.db
--spaces-data-dir PATH    Base spaced data dir; used to derive wallet dir as <dir>/wallets/<wallet>
--rpc-url URL             spaced RPC URL. Default: $SPACED_RPC_URL or http://127.0.0.1:7225
--rpc-auth-token TOKEN    Precomputed Basic auth token for spaced RPC
--rpc-cookie PATH         Cookie file used to derive Basic auth token
--network NAME            Bitcoin network for wallet load. Default: mainnet
--native-bin PATH         Prebuilt spaces-verifier-native binary to use
--outpoint TXID:VOUT      Skip RPC owner lookup and sign for this outpoint directly
```
