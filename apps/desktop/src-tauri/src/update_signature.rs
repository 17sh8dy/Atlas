//! Who may tell Atlas to install something: a signed manifest, from one repository.
//!
//! Before this module an update was trusted because it came from `github.com` and its hash
//! matched the hash in a manifest that came from the same place, with both checks made on values
//! the webview supplied. Anyone with a GitHub account could publish a "release" that satisfied
//! that. Now:
//!
//! * **One repository.** The manifest is fetched from exactly the pinned address, and the
//!   installer it names must live under that repository's release-download path
//!   (`PINNED_DOWNLOAD_PREFIX`), not merely on `github.com`.
//! * **A signature the build can check.** The manifest carries an Ed25519 signature over a fixed
//!   text built from its own fields (`canonical_payload`: product, version, address, SHA-256,
//!   size, notes…). The matching public key is compiled into the program. Nothing is accepted,
//!   fetched or installed from a manifest that does not verify.
//! * **The program decides, not the webview.** A verified manifest is kept here; the download must
//!   be exactly the address in it, and the installer is run only if the file's own measured
//!   SHA-256 equals the *signed* one and its version is the signed one — whatever hash or version
//!   the caller passes.
//! * **No downgrades.** A signed manifest for a version that is not newer than the running one is
//!   not installed (a replayed old, validly signed release).
//!
//! ## Key provisioning
//!
//! `PUBLIC_KEY_HEX` is the release key (atlas-release-1); its private half is kept off this repo
//! (`node scripts/update-signing.mjs keygen --out <private key file outside the repo>`) and pastes
//! the printed public key here. While it is empty **no manifest verifies**: an unprovisioned
//! build fails closed and tells the person to reinstall from the website. `scripts/release.mjs`
//! refuses to publish while it is empty, so a build that cannot verify updates is never shipped as
//! one that claims to.
//!
//! ## What this does not do
//!
//! It does not code-sign the installer (Authenticode needs a certificate; a "valid" Windows
//! signature is still reported and an invalid one still refused). It does not protect copies of
//! Atlas that already exist and run the old updater: they will accept an unsigned update from the
//! pinned host as before, so the first installation of a version with this module is manual.
//! Both are written up in `docs/NATIVE-AUTHORIZATION-INVENTORY.md`.

use std::sync::Mutex;

use base64::Engine as _;
use serde_json::Value;

/// The release-signing public key: 32 bytes, 64 hex characters. **Empty = unprovisioned.**
pub const PUBLIC_KEY_HEX: &str = "bd9280f1507c55bd453b7580693fa147d35aa2e76f5fbace16d0b82881689e18";
/// Which key signed it, for the day there are two.
pub const KEY_ID: &str = "atlas-release-1";

pub const PINNED_MANIFEST_URL: &str =
    "https://github.com/17sh8dy/Atlas/releases/latest/download/latest.json";
pub const PINNED_DOWNLOAD_PREFIX: &str = "https://github.com/17sh8dy/Atlas/releases/download/";

/// What a verified manifest authorises, and nothing more.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    pub product: String,
    pub version: String,
    pub download_url: String,
    pub sha256: String,
    pub size_bytes: u64,
}

static VERIFIED: Mutex<Option<Verified>> = Mutex::new(None);

pub fn current() -> Option<Verified> {
    VERIFIED.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Drop any verified record (a new check starts from nothing).
pub fn forget() {
    store(None);
}

fn store(v: Option<Verified>) {
    *VERIFIED.lock().unwrap_or_else(|e| e.into_inner()) = v;
}

// ---- pinning ---------------------------------------------------------------------------

fn parsed_https(url: &str) -> Option<reqwest::Url> {
    let u = reqwest::Url::parse(url).ok()?;
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() || u.port().is_some() {
        return None;
    }
    Some(u)
}

/// The manifest is fetched from exactly one address.
pub fn manifest_url_allowed(url: &str) -> bool {
    match (parsed_https(url), parsed_https(PINNED_MANIFEST_URL)) {
        (Some(a), Some(b)) => {
            a.host_str().map(str::to_ascii_lowercase) == b.host_str().map(str::to_ascii_lowercase)
                && a.path().eq_ignore_ascii_case(b.path())
                && a.query().is_none()
                && a.fragment().is_none()
        }
        _ => false,
    }
}

/// An installer must live under the pinned repository's release-download path.
pub fn download_url_allowed(url: &str) -> bool {
    let Some(u) = parsed_https(url) else { return false };
    let Some(pin) = parsed_https(PINNED_DOWNLOAD_PREFIX) else { return false };
    u.host_str().map(str::to_ascii_lowercase) == pin.host_str().map(str::to_ascii_lowercase)
        && u.path().to_ascii_lowercase().starts_with(&pin.path().to_ascii_lowercase())
        && !u.path().contains("..")
        && !u.path().contains("%2e")
        && !u.path().contains("%2E")
        && u.query().is_none()
        && u.fragment().is_none()
}

// ---- the signed text -------------------------------------------------------------------------

/// The text that is signed. Built from the manifest's own fields, so a change to any of them
/// changes the text. `scripts/update-signing.mjs` builds the same text; a shared test vector
/// (`tests/fixtures/update-signature-vector.json`) keeps the two in step.
#[allow(clippy::too_many_arguments)]
pub fn canonical_payload(
    product: &str,
    version: &str,
    download_url: &str,
    sha256: &str,
    size_bytes: u64,
    mandatory: bool,
    minimum_version: &str,
    published_at: &str,
    notes: &[String],
) -> String {
    format!(
        "atlas-update-v1\nproduct={product}\nversion={version}\nurl={download_url}\nsha256={sha256}\nsize={size_bytes}\nmandatory={mandatory}\nmin={minimum_version}\npublished={published_at}\nnotes={}",
        notes.join("\u{1f}")
    )
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok())
        .collect()
}

/// Verify a manifest's text against `key_hex`. Nothing is stored; the caller decides.
pub fn verify_manifest_text(text: &str, key_hex: &str) -> Result<Verified, String> {
    if key_hex.is_empty() {
        return Err("This copy of Atlas has no update-signing key, so it can't check updates and won't install them. Download the newest version from the website instead.".into());
    }
    let key = hex_decode(key_hex)
        .filter(|k| k.len() == 32)
        .ok_or("This copy of Atlas has a malformed update-signing key, so it won't install updates.")?;

    let v: Value = serde_json::from_str(text).map_err(|_| "The update information was not valid JSON.".to_string())?;
    let s = |k: &str| v.get(k).and_then(Value::as_str);
    let product = s("product").ok_or("The update information does not name a product.")?.trim().to_ascii_lowercase();
    let version = s("version").ok_or("The update information has no version.")?.trim().to_string();
    let url = s("downloadUrl").ok_or("The update information has no download address.")?.to_string();
    let sha = s("sha256").ok_or("The update information has no checksum.")?.to_ascii_lowercase();
    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("The update's checksum is malformed.".into());
    }
    let size = v.get("sizeBytes").and_then(Value::as_u64).unwrap_or(0);
    let mandatory = v.get("mandatory").and_then(Value::as_bool).unwrap_or(false);
    let min = s("minimumVersion").unwrap_or("").to_string();
    let published = s("publishedAt").unwrap_or("").to_string();
    let notes: Vec<String> = v
        .get("releaseNotes")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|n| n.as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    let sig = v.get("signature").ok_or("This update is not signed, so it was ignored.")?;
    if sig.get("algorithm").and_then(Value::as_str) != Some("ed25519") {
        return Err("This update uses a signature type Atlas does not accept.".into());
    }
    if sig.get("keyId").and_then(Value::as_str) != Some(KEY_ID) {
        return Err("This update was signed with a key this copy of Atlas does not know.".into());
    }
    let value = sig.get("value").and_then(Value::as_str).ok_or("The update's signature is missing.")?;
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|_| "The update's signature is malformed.".to_string())?;

    let payload = canonical_payload(&product, &version, &url, &sha, size, mandatory, &min, &published, &notes);
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &key)
        .verify(payload.as_bytes(), &sig_bytes)
        .map_err(|_| "This update's signature does not check out, so it was ignored.".to_string())?;

    if !download_url_allowed(&url) {
        return Err("This update points outside Atlas's own releases, so it was ignored.".into());
    }
    Ok(Verified { product, version, download_url: url, sha256: sha, size_bytes: size })
}

/// Verify with the compiled-in key and remember the result (or forget a previous one).
pub fn verify_and_store(text: &str) -> Result<Verified, String> {
    store(None);
    let v = verify_manifest_text(text, PUBLIC_KEY_HEX)?;
    store(Some(v.clone()));
    Ok(v)
}

// ---- deciding to install ---------------------------------------------------------------------

fn version_tuple(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.split(['-', '+']).next()?;
    let mut it = core.split('.');
    let t = (
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
    );
    if it.next().is_some() {
        return None;
    }
    Some(t)
}

/// Is `candidate` strictly newer than `running`? Unparseable versions are never newer.
pub fn is_newer(candidate: &str, running: &str) -> bool {
    match (version_tuple(candidate), version_tuple(running)) {
        (Some(c), Some(r)) => c > r,
        _ => false,
    }
}

/// May the installer that was just measured be run? Everything compared is the *signed* record
/// against the *measured* file; what the caller passed is only cross-checked.
pub fn authorize_install(
    verified: Option<&Verified>,
    measured_sha256: &str,
    measured_version: Option<&str>,
    requested_version: &str,
    running_version: &str,
) -> Result<(), String> {
    let Some(v) = verified else {
        return Err("This update has not been verified, so it was not installed.".into());
    };
    if !measured_sha256.eq_ignore_ascii_case(&v.sha256) {
        return Err("The downloaded installer is not the one that was signed. Not installing.".into());
    }
    if measured_version != Some(v.version.as_str()) {
        return Err("The installer's version is not the signed version. Not installing.".into());
    }
    if requested_version != v.version {
        return Err("That is not the version that was verified. Not installing.".into());
    }
    if !is_newer(&v.version, running_version) {
        return Err("That is not newer than the version you have, so it was not installed.".into());
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn set_verified_for_test(v: Option<Verified>) {
    store(v);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    struct Key {
        pair: Ed25519KeyPair,
        public_hex: String,
    }

    fn key() -> Key {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let public_hex: String = pair.public_key().as_ref().iter().map(|b| format!("{b:02x}")).collect();
        Key { pair, public_hex }
    }

    const SHA: &str = "a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const URL: &str = "https://github.com/17sh8dy/Atlas/releases/download/v2.0.0/Atlas_2.0.0_x64-setup.exe";

    fn manifest(k: &Key, mutate: impl FnOnce(&mut serde_json::Value)) -> String {
        let notes = vec!["One".to_string(), "Two".to_string()];
        let payload = canonical_payload("atlas", "2.0.0", URL, SHA, 1234, false, "", "2026-10-14T00:00:00Z", &notes);
        let sig = base64::engine::general_purpose::STANDARD.encode(k.pair.sign(payload.as_bytes()).as_ref());
        let mut v = serde_json::json!({
            "product": "atlas", "version": "2.0.0", "downloadUrl": URL, "sha256": SHA,
            "sizeBytes": 1234, "releaseNotes": notes, "mandatory": false,
            "publishedAt": "2026-10-14T00:00:00Z",
            "signature": { "algorithm": "ed25519", "keyId": KEY_ID, "value": sig }
        });
        mutate(&mut v);
        v.to_string()
    }

    #[test]
    fn a_correctly_signed_manifest_verifies_and_says_what_it_authorises() {
        let k = key();
        let v = verify_manifest_text(&manifest(&k, |_| {}), &k.public_hex).unwrap();
        assert_eq!((v.version.as_str(), v.sha256.as_str(), v.size_bytes), ("2.0.0", SHA, 1234));
        assert_eq!(v.download_url, URL);
    }

    #[test]
    fn changing_any_signed_field_breaks_the_signature() {
        let k = key();
        let cases: Vec<(&str, serde_json::Value)> = vec![
            ("version", serde_json::json!("2.0.1")),
            ("sha256", serde_json::json!("b".repeat(64))),
            ("sizeBytes", serde_json::json!(9999)),
            ("mandatory", serde_json::json!(true)),
            ("releaseNotes", serde_json::json!(["Free money"])),
            ("publishedAt", serde_json::json!("2030-01-01T00:00:00Z")),
            ("product", serde_json::json!("other")),
            ("minimumVersion", serde_json::json!("1.0.0")),
            ("downloadUrl", serde_json::json!("https://github.com/17sh8dy/Atlas/releases/download/v2.0.0/Other.exe")),
        ];
        for (field, value) in cases {
            let text = manifest(&k, |m| {
                m[field] = value.clone();
            });
            let err = verify_manifest_text(&text, &k.public_hex).unwrap_err();
            assert!(err.contains("signature"), "{field}: {err}");
        }
    }

    #[test]
    fn a_manifest_signed_by_another_key_is_refused() {
        let signer = key();
        let other = key();
        let err = verify_manifest_text(&manifest(&signer, |_| {}), &other.public_hex).unwrap_err();
        assert!(err.contains("signature"), "{err}");
    }

    #[test]
    fn an_unsigned_or_oddly_signed_manifest_is_refused() {
        let k = key();
        let unsigned = manifest(&k, |m| {
            m.as_object_mut().unwrap().remove("signature");
        });
        assert!(verify_manifest_text(&unsigned, &k.public_hex).unwrap_err().contains("not signed"));
        let rsa = manifest(&k, |m| m["signature"]["algorithm"] = serde_json::json!("rsa"));
        assert!(verify_manifest_text(&rsa, &k.public_hex).is_err());
        let wrong_id = manifest(&k, |m| m["signature"]["keyId"] = serde_json::json!("someone-else"));
        assert!(verify_manifest_text(&wrong_id, &k.public_hex).is_err());
        let junk = manifest(&k, |m| m["signature"]["value"] = serde_json::json!("not base64 !!"));
        assert!(verify_manifest_text(&junk, &k.public_hex).is_err());
        assert!(verify_manifest_text("not json", &k.public_hex).is_err());
    }

    #[test]
    fn a_build_with_no_key_verifies_nothing() {
        let k = key();
        let err = verify_manifest_text(&manifest(&k, |_| {}), "").unwrap_err();
        assert!(err.contains("no update-signing key"), "{err}");
        assert!(PUBLIC_KEY_HEX.is_empty() || PUBLIC_KEY_HEX.len() == 64, "a provisioned key is 32 bytes of hex");
    }

    #[test]
    fn a_signed_manifest_cannot_point_outside_the_pinned_repository() {
        let k = key();
        for url in [
            "https://github.com/someone-else/Atlas/releases/download/v2.0.0/Atlas.exe",
            "https://github.com/17sh8dy/Atlas-evil/releases/download/v2.0.0/Atlas.exe",
            "https://github.com.evil.example/17sh8dy/Atlas/releases/download/v2.0.0/Atlas.exe",
            "http://github.com/17sh8dy/Atlas/releases/download/v2.0.0/Atlas.exe",
            "https://objects.githubusercontent.com/17sh8dy/Atlas/releases/download/v2.0.0/Atlas.exe",
            "https://github.com/17sh8dy/Atlas/releases/download/../../../evil/Atlas.exe",
        ] {
            // Signed correctly over the hostile address: the pin still refuses it.
            let notes = vec!["x".to_string()];
            let payload = canonical_payload("atlas", "2.0.0", url, SHA, 1, false, "", "", &notes);
            let sig = base64::engine::general_purpose::STANDARD.encode(k.pair.sign(payload.as_bytes()).as_ref());
            let text = serde_json::json!({
                "product": "atlas", "version": "2.0.0", "downloadUrl": url, "sha256": SHA,
                "sizeBytes": 1, "releaseNotes": notes,
                "signature": { "algorithm": "ed25519", "keyId": KEY_ID, "value": sig }
            })
            .to_string();
            assert!(verify_manifest_text(&text, &k.public_hex).is_err(), "{url}");
            assert!(!download_url_allowed(url), "{url}");
        }
        assert!(download_url_allowed(URL));
    }

    #[test]
    fn the_manifest_address_is_pinned_exactly() {
        assert!(manifest_url_allowed(PINNED_MANIFEST_URL));
        assert!(manifest_url_allowed("https://GITHUB.com/17sh8dy/atlas/releases/latest/download/latest.json"));
        for bad in [
            "https://github.com/other/Atlas/releases/latest/download/latest.json",
            "https://github.com/17sh8dy/Atlas/releases/latest/download/latest.json?x=1",
            "https://github.com/17sh8dy/Atlas/releases/latest/download/other.json",
            "http://github.com/17sh8dy/Atlas/releases/latest/download/latest.json",
            "https://evil.example/17sh8dy/Atlas/releases/latest/download/latest.json",
            "https://user@github.com/17sh8dy/Atlas/releases/latest/download/latest.json",
        ] {
            assert!(!manifest_url_allowed(bad), "{bad}");
        }
    }

    fn verified() -> Verified {
        Verified {
            product: "atlas".into(),
            version: "2.0.0".into(),
            download_url: URL.into(),
            sha256: SHA.into(),
            size_bytes: 1234,
        }
    }

    #[test]
    fn install_runs_only_the_signed_file_and_only_when_it_is_newer() {
        let v = verified();
        assert!(authorize_install(Some(&v), SHA, Some("2.0.0"), "2.0.0", "1.0.10").is_ok());
        // Nothing verified yet.
        assert!(authorize_install(None, SHA, Some("2.0.0"), "2.0.0", "1.0.10").is_err());
        // A different file, even with a matching name and version.
        let other = "c".repeat(64);
        assert!(authorize_install(Some(&v), &other, Some("2.0.0"), "2.0.0", "1.0.10").unwrap_err().contains("not the one"));
        // The installer's own version disagrees with the signed one.
        assert!(authorize_install(Some(&v), SHA, Some("1.9.9"), "2.0.0", "1.0.10").is_err());
        assert!(authorize_install(Some(&v), SHA, None, "2.0.0", "1.0.10").is_err());
        // The caller names a different version than was verified.
        assert!(authorize_install(Some(&v), SHA, Some("2.0.0"), "3.0.0", "1.0.10").is_err());
        // A validly signed but old or equal release (a replay) is not a downgrade path.
        assert!(authorize_install(Some(&v), SHA, Some("2.0.0"), "2.0.0", "2.0.0").is_err());
        assert!(authorize_install(Some(&v), SHA, Some("2.0.0"), "2.0.0", "2.1.0").is_err());
    }

    #[test]
    fn version_comparison_is_numeric_not_textual() {
        assert!(is_newer("1.0.10", "1.0.9"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(!is_newer("1.0.9", "1.0.10"));
        assert!(!is_newer("not.a.version", "1.0.0"));
        assert!(is_newer("2.0.0-beta", "1.0.0"));
    }

    /// The vector `scripts/update-signing.mjs` produced with a throwaway key: the Node signer and
    /// this verifier agree on the signed text byte for byte.
    #[test]
    fn a_manifest_signed_by_the_node_tool_verifies_here() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("update-signature-vector.json");
        let raw = std::fs::read_to_string(&path).expect("update-signature-vector.json");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let key_hex = v["publicKeyHex"].as_str().unwrap();
        let manifest = v["manifest"].to_string();
        let ok = verify_manifest_text(&manifest, key_hex).unwrap();
        assert_eq!(ok.version, v["manifest"]["version"].as_str().unwrap());
        // And the same text with one byte changed does not.
        let tampered = manifest.replace("\"version\":\"", "\"version\":\"9");
        assert!(verify_manifest_text(&tampered, key_hex).is_err());
    }
}
