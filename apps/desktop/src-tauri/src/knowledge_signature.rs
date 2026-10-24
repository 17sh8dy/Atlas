//! Who may tell Atlas what it knows: a signed knowledge pack, from one repository.
//!
//! The pack (docs/PLAN-2.0.3.md §B, §N) is the answer to "what is Nova / Atlas / Replay.GG": the
//! text Atlas quotes. A pack Atlas did not check could put any claim in Atlas's mouth, so, like
//! updates (`update_signature.rs`) and with the same rules:
//!
//! * **One address.** A refreshed pack is fetched only from the pinned Nova-Knowledge release.
//! * **A signature the build can check.** `knowledge-pack.sig` is an Ed25519 signature over a
//!   fixed text that includes the SHA-256 of the pack file's own bytes, so changing one character
//!   of the pack breaks it. The public key is compiled in. **Nothing unsigned is ever used.**
//! * **Its own key.** `atlas-knowledge-1`, not the installer-update key: publishing a pack must
//!   never touch the key that can install software. Anyone with push access to the repository still
//!   cannot make Atlas trust a page, because only the holder of the private key can sign a pack.
//! * **No replay.** A validly signed pack with a lower `seq` than the one already in use is
//!   refused, so an old pack cannot be put back.
//!
//! ## Key provisioning
//!
//! `PUBLIC_KEY_HEX` is printed by `node scripts/knowledge-signing.mjs keygen --out <file outside
//! the repo>`. While it is empty **no pack verifies**: an unprovisioned build uses no knowledge
//! and says so, rather than trusting one. The release script refuses to ship while it is empty.

use base64::Engine as _;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The knowledge-signing public key: 32 bytes, 64 hex characters. **Empty = unprovisioned.**
pub const PUBLIC_KEY_HEX: &str = "9d8a8a268e909f866d012b84f98da555b5cdb3e58649f57080b8432e902dd7d6";
pub const KEY_ID: &str = "atlas-knowledge-1";

pub const PINNED_PACK_URL: &str =
    "https://github.com/17sh8dy/Nova-Knowledge/releases/download/knowledge/knowledge-pack.json";
pub const PINNED_SIG_URL: &str =
    "https://github.com/17sh8dy/Nova-Knowledge/releases/download/knowledge/knowledge-pack.sig";

/// The most a pack may be. The builder enforces the same cap.
pub const MAX_PACK_BYTES: usize = 3 * 1024 * 1024;

/// What a verified pack says about itself; its content is read separately.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedPack {
    pub seq: u64,
    pub built_at: String,
}

fn parsed_https(url: &str) -> Option<reqwest::Url> {
    let u = reqwest::Url::parse(url).ok()?;
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() || u.port().is_some() {
        return None;
    }
    Some(u)
}

/// Is this exactly one of the two pinned addresses?
pub fn url_allowed(url: &str) -> bool {
    let Some(u) = parsed_https(url) else { return false };
    [PINNED_PACK_URL, PINNED_SIG_URL].iter().any(|pin| {
        parsed_https(pin).is_some_and(|p| {
            u.host_str().map(str::to_ascii_lowercase) == p.host_str().map(str::to_ascii_lowercase)
                && u.path() == p.path()
                && u.query().is_none()
                && u.fragment().is_none()
        })
    })
}

/// The text that is signed. `scripts/knowledge-lib.mjs` builds the same text; a shared vector
/// (`tests/fixtures/knowledge-signature-vector.json`) keeps the two in step.
pub fn canonical_payload(key_id: &str, seq: u64, built_at: &str, sha256: &str) -> String {
    format!("atlas-knowledge-v1\nkey={key_id}\nseq={seq}\nbuilt={built_at}\nsha256={sha256}")
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()).collect()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Verify a pack file's bytes against its signature text and `key_hex`. Nothing is stored.
pub fn verify_pack(pack: &[u8], sig_text: &str, key_hex: &str) -> Result<VerifiedPack, String> {
    if key_hex.is_empty() {
        return Err("This copy of Atlas has no knowledge-signing key, so it won't use a knowledge pack.".into());
    }
    let key = hex_decode(key_hex)
        .filter(|k| k.len() == 32)
        .ok_or("This copy of Atlas has a malformed knowledge-signing key.")?;
    if pack.len() > MAX_PACK_BYTES {
        return Err("The knowledge pack is larger than Atlas accepts.".into());
    }

    let sig: Value = serde_json::from_str(sig_text).map_err(|_| "The pack's signature file was not valid.".to_string())?;
    if sig.get("algorithm").and_then(Value::as_str) != Some("ed25519") {
        return Err("The pack uses a signature type Atlas does not accept.".into());
    }
    if sig.get("keyId").and_then(Value::as_str) != Some(KEY_ID) {
        return Err("The pack was signed with a key this copy of Atlas does not know.".into());
    }
    let seq = sig.get("seq").and_then(Value::as_u64).ok_or("The pack's signature has no sequence number.")?;
    let built_at = sig.get("builtAt").and_then(Value::as_str).ok_or("The pack's signature has no build time.")?.to_string();
    let signed_hash = sig.get("sha256").and_then(Value::as_str).ok_or("The pack's signature has no checksum.")?.to_ascii_lowercase();
    let value = sig.get("value").and_then(Value::as_str).ok_or("The pack's signature is missing.")?;
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|_| "The pack's signature is malformed.".to_string())?;

    let payload = canonical_payload(KEY_ID, seq, &built_at, &signed_hash);
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &key)
        .verify(payload.as_bytes(), &sig_bytes)
        .map_err(|_| "The knowledge pack's signature does not check out, so it was ignored.".to_string())?;

    // The signature vouches for a hash; the file in hand must BE that hash.
    if hex_encode(&Sha256::digest(pack)) != signed_hash {
        return Err("The knowledge pack does not match its signature, so it was ignored.".into());
    }

    // What the (now trusted) file says about itself must agree with what was signed.
    let body: Value = serde_json::from_slice(pack).map_err(|_| "The knowledge pack was not valid.".to_string())?;
    if body.get("schema").and_then(Value::as_u64) != Some(1) {
        return Err("The knowledge pack is a format this copy of Atlas does not understand.".into());
    }
    if body.get("seq").and_then(Value::as_u64) != Some(seq) || body.get("keyId").and_then(Value::as_str) != Some(KEY_ID) {
        return Err("The knowledge pack's contents disagree with its signature.".into());
    }
    if body.get("dev").and_then(Value::as_bool) == Some(true) {
        return Err("A development knowledge pack is never used.".into());
    }
    Ok(VerifiedPack { seq, built_at })
}

/// Verify with the compiled-in key.
pub fn verify(pack: &[u8], sig_text: &str) -> Result<VerifiedPack, String> {
    verify_pack(pack, sig_text, PUBLIC_KEY_HEX)
}

/// May a pack with `candidate` as its sequence replace the one in use? Equal or lower never does:
/// a validly signed OLD pack must not be put back.
pub fn is_newer(candidate: u64, in_use: Option<u64>) -> bool {
    in_use.is_none_or(|n| candidate > n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Vector {
        #[serde(rename = "publicKeyHex")]
        public_key_hex: String,
        pack: String,
        sig: Value,
    }

    fn vector() -> Vector {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("knowledge-signature-vector.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("knowledge-signature-vector.json")).unwrap()
    }

    #[test]
    fn the_node_signer_and_this_verifier_build_the_same_signed_text() {
        let v = vector();
        let got = verify_pack(v.pack.as_bytes(), &v.sig.to_string(), &v.public_key_hex).expect("the vector verifies");
        assert_eq!(got.seq, 1000);
    }

    #[test]
    fn one_changed_character_in_the_pack_breaks_it() {
        let v = vector();
        let tampered = v.pack.replacen("\"chunks\":[]", "\"chunks\":[1]", 1);
        assert_ne!(tampered, v.pack);
        assert!(verify_pack(tampered.as_bytes(), &v.sig.to_string(), &v.public_key_hex).is_err());
    }

    #[test]
    fn a_changed_signature_field_breaks_it() {
        let v = vector();
        let mut sig = v.sig.clone();
        sig["seq"] = serde_json::json!(999_999);
        assert!(verify_pack(v.pack.as_bytes(), &sig.to_string(), &v.public_key_hex).is_err());
    }

    #[test]
    fn the_wrong_key_does_not_verify() {
        let v = vector();
        let other = "00".repeat(32);
        assert!(verify_pack(v.pack.as_bytes(), &v.sig.to_string(), &other).is_err());
    }

    #[test]
    fn an_unprovisioned_build_trusts_nothing() {
        let v = vector();
        let err = verify_pack(v.pack.as_bytes(), &v.sig.to_string(), "").unwrap_err();
        assert!(err.contains("no knowledge-signing key"));
    }

    #[test]
    fn a_pack_with_no_signature_is_refused() {
        let v = vector();
        assert!(verify_pack(v.pack.as_bytes(), "{}", &v.public_key_hex).is_err());
        assert!(verify_pack(v.pack.as_bytes(), "not json", &v.public_key_hex).is_err());
    }

    #[test]
    fn a_different_key_id_is_refused() {
        let v = vector();
        let mut sig = v.sig.clone();
        sig["keyId"] = serde_json::json!("atlas-release-1");
        assert!(verify_pack(v.pack.as_bytes(), &sig.to_string(), &v.public_key_hex).is_err());
    }

    #[test]
    fn an_oversize_pack_is_refused_before_anything_else() {
        let v = vector();
        let big = vec![b' '; MAX_PACK_BYTES + 1];
        assert!(verify_pack(&big, &v.sig.to_string(), &v.public_key_hex).unwrap_err().contains("larger"));
    }

    #[test]
    fn an_older_validly_signed_pack_does_not_replace_a_newer_one() {
        assert!(is_newer(5, None));
        assert!(is_newer(6, Some(5)));
        assert!(!is_newer(5, Some(5)));
        assert!(!is_newer(4, Some(5)), "replaying an old signed pack is refused");
    }

    #[test]
    fn only_the_two_pinned_addresses_are_allowed() {
        assert!(url_allowed(PINNED_PACK_URL));
        assert!(url_allowed(PINNED_SIG_URL));
        for bad in [
            "http://github.com/17sh8dy/Nova-Knowledge/releases/download/knowledge/knowledge-pack.json",
            "https://github.com/17sh8dy/Atlas/releases/download/knowledge/knowledge-pack.json",
            "https://evil.example/17sh8dy/Nova-Knowledge/releases/download/knowledge/knowledge-pack.json",
            "https://github.com/17sh8dy/Nova-Knowledge/releases/download/knowledge/knowledge-pack.json?x=1",
            "https://github.com:8443/17sh8dy/Nova-Knowledge/releases/download/knowledge/knowledge-pack.json",
            "https://user@github.com/17sh8dy/Nova-Knowledge/releases/download/knowledge/knowledge-pack.json",
            "https://github.com/17sh8dy/Nova-Knowledge/releases/download/knowledge/other.json",
        ] {
            assert!(!url_allowed(bad), "{bad}");
        }
    }

    #[test]
    fn the_compiled_in_key_is_well_formed() {
        assert_eq!(hex_decode(PUBLIC_KEY_HEX).map(|k| k.len()), Some(32));
    }

    /// If a real pack has been built (`node scripts/build-knowledge.mjs`), it must verify with the
    /// compiled-in key. Skipped when there is none, so a fresh checkout still passes.
    #[test]
    fn the_real_built_pack_verifies_with_the_compiled_in_key_when_one_exists() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..").join("knowledge").join("dist");
        let (Ok(pack), Ok(sig)) = (std::fs::read(dir.join("knowledge-pack.json")), std::fs::read_to_string(dir.join("knowledge-pack.sig"))) else {
            return;
        };
        // A development pack (never signed) is not a release candidate.
        if String::from_utf8_lossy(&pack).contains("\"dev\":true") {
            return;
        }
        let got = verify(&pack, &sig).expect("the pack in knowledge/dist verifies");
        assert!(got.seq > 0);
    }
}
