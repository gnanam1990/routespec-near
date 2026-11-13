//! RouteSpec release certificate: field rules and the exact bytes an attester signs.
//!
//! This crate has no dependencies. The registry contract uses it on chain and the host tests
//! use it against the shared vectors in `vectors/certificate-v1.json`, which the TypeScript
//! implementation (`packages/registry`) must reproduce byte for byte.
//!
//! Signing payload (UTF-8, every line ends with one `\n`, no other whitespace):
//!
//! ```text
//! routespec.certificate/1
//! registry:<registry account id>
//! project:<project key>
//! bundle:sha256:<64 hex>
//! verdict:<PASS|FAIL|REVIEW|NOT_RUN>
//! corpus:sha256:<64 hex>
//! artifact:sha256:<64 hex>
//! commit:<40 or 64 hex>
//! timestamp:<milliseconds since the Unix epoch, decimal, no leading zero>
//! ```
//!
//! Every field has a closed character set that excludes `\n` and `:` ambiguity cannot arise
//! because each line has a fixed prefix and the fields are validated before encoding, so two
//! different certificates never share a payload. The registry account id is part of the payload:
//! a signature for one registry (or one network) is not valid for another.

/// Domain tag: the first line of every signing payload.
pub const PAYLOAD_DOMAIN: &str = "routespec.certificate/1";

/// A signed timestamp may be at most this far ahead of the block time.
pub const MAX_FUTURE_SKEW_MS: u64 = 10 * 60 * 1000;
/// A signed timestamp may be at most this old when the certificate is published.
pub const MAX_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1000;
/// Largest timestamp accepted: the largest integer every JSON reader represents exactly.
pub const MAX_TIMESTAMP_MS: u64 = 9_007_199_254_740_991;

pub const MAX_PROJECT_LEN: usize = 96;
pub const MAX_LABEL_LEN: usize = 64;
pub const MAX_REASON_LEN: usize = 120;

/// Gate verdicts a certificate can carry. The numeric value is the stored form.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Verdict {
    Pass = 0,
    Fail = 1,
    Review = 2,
    NotRun = 3,
}

impl Verdict {
    pub fn parse(s: &str) -> Option<Verdict> {
        match s {
            "PASS" => Some(Verdict::Pass),
            "FAIL" => Some(Verdict::Fail),
            "REVIEW" => Some(Verdict::Review),
            "NOT_RUN" => Some(Verdict::NotRun),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Pass => "PASS",
            Verdict::Fail => "FAIL",
            Verdict::Review => "REVIEW",
            Verdict::NotRun => "NOT_RUN",
        }
    }

    pub fn from_u8(v: u8) -> Option<Verdict> {
        match v {
            0 => Some(Verdict::Pass),
            1 => Some(Verdict::Fail),
            2 => Some(Verdict::Review),
            3 => Some(Verdict::NotRun),
            _ => None,
        }
    }
}

/// Why a certificate was refused. `code()` is the stable text the contract panics with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CertificateError {
    Registry,
    Project,
    BundleDigest,
    Verdict,
    CorpusDigest,
    ArtifactDigest,
    Commit,
    Timestamp,
    TimestampFuture,
    TimestampStale,
}

impl CertificateError {
    pub fn code(self) -> &'static str {
        match self {
            CertificateError::Registry => "RSREG_FIELD_INVALID:registry",
            CertificateError::Project => "RSREG_FIELD_INVALID:project",
            CertificateError::BundleDigest => "RSREG_FIELD_INVALID:bundle_digest",
            CertificateError::Verdict => "RSREG_FIELD_INVALID:verdict",
            CertificateError::CorpusDigest => "RSREG_FIELD_INVALID:corpus_digest",
            CertificateError::ArtifactDigest => "RSREG_FIELD_INVALID:artifact_digest",
            CertificateError::Commit => "RSREG_FIELD_INVALID:commit",
            CertificateError::Timestamp => "RSREG_FIELD_INVALID:timestamp_ms",
            CertificateError::TimestampFuture => "RSREG_TIMESTAMP_FUTURE",
            CertificateError::TimestampStale => "RSREG_TIMESTAMP_STALE",
        }
    }
}

/// The certificate as text fields, exactly as they appear in the signing payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CertificateFields<'a> {
    pub registry: &'a str,
    pub project: &'a str,
    pub bundle_digest: &'a str,
    pub verdict: &'a str,
    pub corpus_digest: &'a str,
    pub artifact_digest: &'a str,
    pub commit: &'a str,
    pub timestamp_ms: u64,
}

fn is_lower_hex(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// NEAR account id shape: 2 to 64 characters of `a-z 0-9 . _ -`, separators never first, last,
/// or doubled.
pub fn is_account_id(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 2 || b.len() > 64 {
        return false;
    }
    let mut previous_separator = true;
    for &c in b {
        let separator = c == b'.' || c == b'_' || c == b'-';
        if separator {
            if previous_separator {
                return false;
            }
        } else if !(c.is_ascii_lowercase() || c.is_ascii_digit()) {
            return false;
        }
        previous_separator = separator;
    }
    !previous_separator
}

/// Project key: 1 to 96 characters of `a-z 0-9 . _ / -`, starting with a letter or digit.
pub fn is_project_key(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > MAX_PROJECT_LEN {
        return false;
    }
    if !(b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) {
        return false;
    }
    b.iter()
        .all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'_' || c == b'/' || c == b'-')
}

/// `sha256:` followed by exactly 64 lowercase hex characters.
pub fn is_digest(s: &str) -> bool {
    match s.strip_prefix("sha256:") {
        Some(hex) => hex.len() == 64 && is_lower_hex(hex),
        None => false,
    }
}

/// A git commit id: 40 (SHA-1) or 64 (SHA-256) lowercase hex characters.
pub fn is_commit(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && is_lower_hex(s)
}

/// Printable ASCII without control characters, 1 to `max` characters (labels and reasons).
pub fn is_plain_text(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

/// The seven encodings of the eight Ed25519 points of small order, compared without the sign bit
/// (the list libsodium blocks). They include the non-canonical encodings `p` and `p + 1`.
const SMALL_ORDER_ENCODINGS: [[u8; 32]; 7] = [
    [0; 32],
    [
        1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ],
    [
        0x26, 0xe8, 0x95, 0x8f, 0xc2, 0xb2, 0x27, 0xb0, 0x45, 0xc3, 0xf4, 0x89, 0xf2, 0xef, 0x98, 0xf0, 0xd5, 0xdf,
        0xac, 0x05, 0xd3, 0xc6, 0x33, 0x39, 0xb1, 0x38, 0x02, 0x88, 0x6d, 0x53, 0xfc, 0x05,
    ],
    [
        0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b, 0x76, 0x0d, 0x10, 0x67, 0x0f, 0x2a, 0x20,
        0x53, 0xfa, 0x2c, 0x39, 0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac, 0x03, 0x7a,
    ],
    small_order_high(0xec),
    small_order_high(0xed),
    small_order_high(0xee),
];

const fn small_order_high(first: u8) -> [u8; 32] {
    let mut out = [0xff; 32];
    out[0] = first;
    out[31] = 0x7f;
    out
}

/// Whether 32 Ed25519 public-key bytes encode a point of small order. Such a key has no secret:
/// with cofactorless verification (NEAR's `ed25519_verify`, OpenSSL) a signature made of a
/// small-order `R` and `s = 0` verifies for any message, so anyone could sign for it.
pub fn is_small_order_key(key: &[u8; 32]) -> bool {
    SMALL_ORDER_ENCODINGS
        .iter()
        .any(|bad| key[..31] == bad[..31] && (key[31] & 0x7f) == bad[31])
}

fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    }
}

/// The 32 bytes of a `sha256:<hex>` digest; `None` unless `is_digest` holds.
pub fn digest_bytes(s: &str) -> Option<[u8; 32]> {
    if !is_digest(s) {
        return None;
    }
    let hex = &s.as_bytes()[7..];
    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = (nibble(hex[2 * i])? << 4) | nibble(hex[2 * i + 1])?;
    }
    Some(out)
}

/// `sha256:<hex>` for 32 digest bytes.
pub fn digest_text(bytes: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(71);
    s.push_str("sha256:");
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 15) as usize] as char);
    }
    s
}

/// Check every field. The first failing field is reported.
pub fn validate(f: &CertificateFields<'_>) -> Result<Verdict, CertificateError> {
    if !is_account_id(f.registry) {
        return Err(CertificateError::Registry);
    }
    if !is_project_key(f.project) {
        return Err(CertificateError::Project);
    }
    if !is_digest(f.bundle_digest) {
        return Err(CertificateError::BundleDigest);
    }
    let verdict = Verdict::parse(f.verdict).ok_or(CertificateError::Verdict)?;
    if !is_digest(f.corpus_digest) {
        return Err(CertificateError::CorpusDigest);
    }
    if !is_digest(f.artifact_digest) {
        return Err(CertificateError::ArtifactDigest);
    }
    if !is_commit(f.commit) {
        return Err(CertificateError::Commit);
    }
    if f.timestamp_ms == 0 || f.timestamp_ms > MAX_TIMESTAMP_MS {
        return Err(CertificateError::Timestamp);
    }
    Ok(verdict)
}

/// The exact bytes the attester signs. Fails when any field is invalid.
pub fn signing_payload(f: &CertificateFields<'_>) -> Result<Vec<u8>, CertificateError> {
    validate(f)?;
    let mut s = String::with_capacity(512);
    s.push_str(PAYLOAD_DOMAIN);
    s.push('\n');
    for (name, value) in [
        ("registry", f.registry),
        ("project", f.project),
        ("bundle", f.bundle_digest),
        ("verdict", f.verdict),
        ("corpus", f.corpus_digest),
        ("artifact", f.artifact_digest),
        ("commit", f.commit),
    ] {
        s.push_str(name);
        s.push(':');
        s.push_str(value);
        s.push('\n');
    }
    s.push_str("timestamp:");
    s.push_str(&f.timestamp_ms.to_string());
    s.push('\n');
    Ok(s.into_bytes())
}

/// The signed timestamp must be close to the time of publication: not more than
/// `MAX_FUTURE_SKEW_MS` ahead of `now_ms` and not more than `MAX_AGE_MS` behind it.
pub fn check_timestamp(timestamp_ms: u64, now_ms: u64) -> Result<(), CertificateError> {
    if timestamp_ms > now_ms.saturating_add(MAX_FUTURE_SKEW_MS) {
        return Err(CertificateError::TimestampFuture);
    }
    if now_ms.saturating_sub(timestamp_ms) > MAX_AGE_MS {
        return Err(CertificateError::TimestampStale);
    }
    Ok(())
}
