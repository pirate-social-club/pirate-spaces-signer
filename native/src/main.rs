use std::{env, fs, path::Path, process::ExitCode, str::FromStr};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::json;
use spaces_protocol::{bitcoin::OutPoint, slabel::SLabel};
use spaces_veritas::{Value, Veritas};
use spaces_wallet::{
    WalletConfig, WalletDescriptors, SpacesWallet,
    bitcoin::{
        Network,
        secp256k1::{Message, Secp256k1},
    },
    export::WalletExport,
};

fn normalize_hex(input: &str) -> &str {
    input
        .strip_prefix("0x")
        .or_else(|| input.strip_prefix("0X"))
        .unwrap_or(input)
}

fn decode_hex<const N: usize>(input: &str, label: &str) -> Result<[u8; N], String> {
    let bytes = hex::decode(normalize_hex(input))
        .map_err(|error| format!("invalid {label} hex: {error}"))?;
    let arr: [u8; N] = bytes
        .try_into()
        .map_err(|_| format!("{label} must be {N} bytes"))?;
    Ok(arr)
}

fn output_json(value: serde_json::Value) -> ExitCode {
    println!(
        "{}",
        serde_json::to_string(&value).expect("serializing verifier json output")
    );
    ExitCode::SUCCESS
}

fn inspect(root_label: &str, proof_base64: &str, anchor_hex: &str) -> Result<serde_json::Value, String> {
    let anchor = decode_hex::<32>(anchor_hex, "anchor")?;
    let proof = BASE64
        .decode(proof_base64)
        .map_err(|error| format!("invalid proof base64: {error}"))?;

    let mut veritas = Veritas::new();
    veritas.add_anchor(anchor);

    let verified = veritas
        .verify_proof(&proof)
        .map_err(|error| format!("proof verification failed: {error:?}"))?;

    let canonical = if root_label.starts_with('@') {
        root_label.to_owned()
    } else {
        format!("@{root_label}")
    };
    SLabel::from_str(&canonical).map_err(|error| format!("invalid root label: {error}"))?;

    let proved_outpoint = verified
        .iter()
        .find_map(|(_, value)| {
            match value {
                Value::Outpoint(outpoint) => Some(outpoint),
                _ => None,
            }
        });

    let proof_root_hash = hex::encode(verified.root());

    Ok(json!({
        "root_key_proof_verified": proved_outpoint.is_some(),
        "proved_outpoint": proved_outpoint.map(|outpoint| outpoint.to_string()),
        "root_pubkey": serde_json::Value::Null,
        "proof_root_hash": proof_root_hash,
        "failure_reason": serde_json::Value::Null,
    }))
}

fn verify_schnorr(
    digest_hex: &str,
    signature_hex: &str,
    pubkey_hex: &str,
) -> Result<serde_json::Value, String> {
    let digest = decode_hex::<32>(digest_hex, "digest")?;
    let signature = decode_hex::<64>(signature_hex, "signature")?;
    let pubkey = decode_hex::<32>(pubkey_hex, "pubkey")?;

    let verified = Veritas::new().verify_schnorr(&pubkey, &digest, &signature);

    Ok(json!({
        "valid_signature": verified,
        "failure_reason": if verified { serde_json::Value::Null } else { json!("invalid_signature") },
    }))
}

fn load_wallet(wallet_dir: &Path, network_name: &str) -> Result<SpacesWallet, String> {
    let wallet_json = fs::read_to_string(wallet_dir.join("wallet.json"))
        .map_err(|error| format!("failed to read wallet export: {error}"))?;
    let export = serde_json::from_str::<WalletExport>(&wallet_json)
        .map_err(|error| format!("failed to parse wallet export: {error}"))?;
    let internal_descriptor = export
        .change_descriptor()
        .ok_or_else(|| String::from("wallet export is missing a change descriptor"))?;
    let normalized_network = network_name.trim().to_ascii_lowercase();
    let canonical_network = match normalized_network.as_str() {
        "mainnet" => "bitcoin",
        other => other,
    };
    let network = Network::from_str(canonical_network)
        .map_err(|error| format!("invalid network: {error}"))?;

    SpacesWallet::new(WalletConfig {
        name: export.label.clone(),
        data_dir: wallet_dir.to_path_buf(),
        start_block: export.blockheight,
        network,
        genesis_hash: None,
        space_descriptors: WalletDescriptors {
            external: export.descriptor(),
            internal: internal_descriptor,
        },
    })
    .map_err(|error| format!("failed to load wallet: {error}"))
}

fn sign_digest(
    wallet_dir: &str,
    network_name: &str,
    outpoint_str: &str,
    digest_hex: &str,
) -> Result<serde_json::Value, String> {
    let outpoint = OutPoint::from_str(outpoint_str)
        .map_err(|error| format!("invalid outpoint: {error}"))?;
    let digest = decode_hex::<32>(digest_hex, "digest")?;
    let wallet_path = Path::new(wallet_dir);
    let mut wallet = load_wallet(wallet_path, network_name)?;
    let utxo = wallet
        .get_utxo(outpoint)
        .ok_or_else(|| String::from("wallet does not control the requested root outpoint"))?;
    let keypair = wallet
        .get_taproot_keypair(utxo.keychain, utxo.derivation_index)
        .map_err(|error| format!("could not derive taproot keypair: {error}"))?;
    let inner_keypair = keypair.to_keypair();
    let (pubkey, _) = inner_keypair.x_only_public_key();

    let secp = Secp256k1::new();
    let message = Message::from_digest(digest);
    let signature = secp.sign_schnorr(&message, &inner_keypair);

    Ok(json!({
        "algorithm": "bip340_schnorr",
        "digest": hex::encode(digest),
        "outpoint": outpoint.to_string(),
        "pubkey": hex::encode(pubkey.serialize()),
        "signature": signature.to_string(),
        "valid_signature": true,
        "wallet_dir": wallet_path.display().to_string(),
    }))
}

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let Some(command) = args.next() else {
        eprintln!("usage: spaces-verifier-native <inspect|verify-schnorr|sign-digest> ...");
        return ExitCode::FAILURE;
    };

    let result = match command.as_str() {
        "inspect" => {
            let Some(root_label) = args.next() else {
                return ExitCode::FAILURE;
            };
            let Some(proof_base64) = args.next() else {
                return ExitCode::FAILURE;
            };
            let Some(anchor_hex) = args.next() else {
                return ExitCode::FAILURE;
            };
            inspect(&root_label, &proof_base64, &anchor_hex)
        }
        "verify-schnorr" => {
            let Some(digest_hex) = args.next() else {
                return ExitCode::FAILURE;
            };
            let Some(signature_hex) = args.next() else {
                return ExitCode::FAILURE;
            };
            let Some(pubkey_hex) = args.next() else {
                return ExitCode::FAILURE;
            };
            verify_schnorr(&digest_hex, &signature_hex, &pubkey_hex)
        }
        "sign-digest" => {
            let Some(wallet_dir) = args.next() else {
                return ExitCode::FAILURE;
            };
            let Some(network_name) = args.next() else {
                return ExitCode::FAILURE;
            };
            let Some(outpoint) = args.next() else {
                return ExitCode::FAILURE;
            };
            let Some(digest_hex) = args.next() else {
                return ExitCode::FAILURE;
            };
            sign_digest(&wallet_dir, &network_name, &outpoint, &digest_hex)
        }
        _ => Err(format!("unknown command: {command}")),
    };

    match result {
        Ok(value) => output_json(value),
        Err(error) => output_json(json!({
            "error": error,
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspect_example_proof_smoke_test() {
        let anchor_hex = "a44ad8bca3184798d75f69b9c50bfbc67dd1bcf550a9ce3a943ff6501ab60693";
        let proof_base64 = "AQEAAouXDhe+rJKxqcvRzRIthc2QkNuPDt34M2NmW8nLoqk0AQACD5+x6CJLkmxgKPTyS0Nq9Ci03Lev9Fm20W+kyCzvewMBAAEAAvNWZU+az0t38K0pMm5Ny5fWGFZskajtKZ+On2Z4PkGqAQACXb+CBVIEjx7wDHZbG/FWKuczR8WgyHSelZBwXIzjflIBAAJo/bDo+osV3y5G7AGeMv6i/LMbCozs2tk3jUg0+0L8nwEAAQABAAEAAiMCqoVnipJoF4xoNhz7owXgN+ozXdgce3MZX/M7WCXOAG4seB00O3x87+y2CM1e1uZhmTkmmkyUwyjxv/IronYzADcBAQdtZW1wb29sAfzA3gEAAPuaAiJRIHj13+6+2Wc7tWB+ZswSvzvEKCzhUjuwUsQyFJX0f8SHAklClIvNFftzNbqMoAe7bdDpm4pnWyU6o+abgq+22xEgAiNAa7W4k9sjy7lYKzZtx1ag2VVcz+XzwDLPZU02XiIDAqh+BDASBJSQYgMZPd/BAgbND21I/8FFfcpHsJqqsb4lAnHXQmQvzKYfAhWXtBD687lb4qqZudMBPZY0UQsqNWBC";

        let value = inspect("@mempool", proof_base64, anchor_hex).expect("inspect proof");

        assert!(value["root_key_proof_verified"].is_boolean());
        assert_eq!(
            value["proof_root_hash"],
            json!("a44ad8bca3184798d75f69b9c50bfbc67dd1bcf550a9ce3a943ff6501ab60693")
        );
    }
}
