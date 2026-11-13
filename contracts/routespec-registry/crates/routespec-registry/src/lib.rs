//! RouteSpec release-certificate registry (near-sdk 5.30.1).
//!
//! The registry keeps two things:
//!
//! - attester keys: Ed25519 public keys the owner account has enrolled, and may revoke;
//! - certificates: an append-only log. A certificate is accepted only with a valid Ed25519
//!   signature from an enrolled, unrevoked attester over the payload defined in
//!   `routespec-certificate` (bundle digest, gate verdict, corpus digest, client artifact digest,
//!   commit and timestamp, bound to this registry account and a project key).
//!
//! The contract holds no funds and moves none: it has no payable method, creates no promise and
//! never transfers. Any account may submit a certificate, because the attester's signature is
//! the authority; the submitting account only pays gas. Nothing is ever updated or deleted: a
//! revocation is recorded next to the attester and every certificate keeps the time it was
//! published, so a reader can tell whether it predates the revocation.
//!
//! Every refusal is a panic with a stable `RSREG_*` code.

use near_sdk::json_types::Base64VecU8;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{env, near, AccountId, CurveType, PanicOnDefault, PublicKey};
use routespec_certificate as cert;

pub const CONTRACT_NAME: &str = "routespec-registry";
pub const CONTRACT_VERSION: &str = "1.0.0";

/// The owner can enrol at most this many attester keys (revoked keys count: nothing is deleted).
pub const MAX_ATTESTERS: u32 = 64;
/// At most this many certificates (one per attester) for one bundle digest.
pub const MAX_CERTIFICATES_PER_BUNDLE: usize = 8;
/// Largest page a view returns.
pub const MAX_PAGE: u32 = 50;

fn fail(code: &str) -> ! {
    env::panic_str(code)
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Attester {
    label: String,
    enrolled_at_ms: u64,
    enrolled_block_height: u64,
    revoked_at_ms: Option<u64>,
    revoked_block_height: Option<u64>,
    revocation_reason: Option<String>,
    certificates: u32,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Certificate {
    project: String,
    bundle_digest: [u8; 32],
    verdict: u8,
    corpus_digest: [u8; 32],
    artifact_digest: [u8; 32],
    commit: String,
    timestamp_ms: u64,
    attester: [u8; 32],
    signature: [u8; 64],
    published_at_ms: u64,
    published_block_height: u64,
}

/// The certificate fields an attester signs, as submitted to `publish`.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
pub struct CertificateInput {
    pub project: String,
    pub bundle_digest: String,
    pub verdict: String,
    pub corpus_digest: String,
    pub artifact_digest: String,
    pub commit: String,
    pub timestamp_ms: u64,
}

#[near(serializers = [json])]
pub struct CertificateView {
    pub id: u32,
    pub registry: AccountId,
    pub project: String,
    pub bundle_digest: String,
    pub verdict: String,
    pub corpus_digest: String,
    pub artifact_digest: String,
    pub commit: String,
    pub timestamp_ms: u64,
    pub attester: String,
    pub signature: Base64VecU8,
    pub published_at_ms: u64,
    pub published_block_height: u64,
    /// The attester's state when the view was read (not when the certificate was published).
    pub attester_revoked: bool,
    pub attester_revoked_at_ms: Option<u64>,
}

#[near(serializers = [json])]
pub struct AttesterView {
    pub public_key: String,
    pub label: String,
    pub enrolled_at_ms: u64,
    pub enrolled_block_height: u64,
    pub revoked: bool,
    pub revoked_at_ms: Option<u64>,
    pub revoked_block_height: Option<u64>,
    pub revocation_reason: Option<String>,
    pub certificates: u32,
}

#[near(serializers = [json])]
pub struct RegistryInfo {
    pub contract: String,
    pub version: String,
    pub payload_domain: String,
    pub owner_id: AccountId,
    pub attesters: u32,
    pub certificates: u32,
    pub max_future_skew_ms: u64,
    pub max_age_ms: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    owner_id: AccountId,
    attesters: IterableMap<[u8; 32], Attester>,
    certificates: Vector<Certificate>,
    by_bundle: LookupMap<[u8; 32], Vec<u32>>,
    project_counts: LookupMap<String, u32>,
    by_project: LookupMap<(String, u32), u32>,
}

/// The 32 key bytes of an Ed25519 public key; any other curve is refused.
fn ed25519_bytes(key: &PublicKey) -> [u8; 32] {
    if key.curve_type() != CurveType::ED25519 {
        fail("RSREG_KEY_NOT_ED25519");
    }
    // `as_bytes` is the curve tag followed by the key.
    match <[u8; 32]>::try_from(&key.as_bytes()[1..]) {
        Ok(bytes) => bytes,
        Err(_) => fail("RSREG_KEY_NOT_ED25519"),
    }
}

fn key_text(bytes: &[u8; 32]) -> String {
    let mut tagged = Vec::with_capacity(33);
    tagged.push(0u8);
    tagged.extend_from_slice(bytes);
    match PublicKey::try_from(tagged) {
        Ok(key) => String::from(&key),
        Err(_) => fail("RSREG_INTERNAL"),
    }
}

fn page(from_index: Option<u32>, limit: Option<u32>, total: u32) -> core::ops::Range<u32> {
    let from = from_index.unwrap_or(0).min(total);
    let count = limit.unwrap_or(MAX_PAGE).min(MAX_PAGE);
    from..from.saturating_add(count).min(total)
}

impl Registry {
    fn require_owner(&self) {
        if env::predecessor_account_id() != self.owner_id {
            fail("RSREG_NOT_OWNER");
        }
    }

    fn certificate_view(&self, id: u32) -> Option<CertificateView> {
        let c = self.certificates.get(id)?;
        let attester = self.attesters.get(&c.attester);
        let verdict = cert::Verdict::from_u8(c.verdict).unwrap_or_else(|| fail("RSREG_INTERNAL"));
        Some(CertificateView {
            id,
            registry: env::current_account_id(),
            project: c.project.clone(),
            bundle_digest: cert::digest_text(&c.bundle_digest),
            verdict: verdict.as_str().to_owned(),
            corpus_digest: cert::digest_text(&c.corpus_digest),
            artifact_digest: cert::digest_text(&c.artifact_digest),
            commit: c.commit.clone(),
            timestamp_ms: c.timestamp_ms,
            attester: key_text(&c.attester),
            signature: Base64VecU8(c.signature.to_vec()),
            published_at_ms: c.published_at_ms,
            published_block_height: c.published_block_height,
            attester_revoked: attester.map(|a| a.revoked_at_ms.is_some()).unwrap_or(true),
            attester_revoked_at_ms: attester.and_then(|a| a.revoked_at_ms),
        })
    }

    fn attester_view(key: &[u8; 32], a: &Attester) -> AttesterView {
        AttesterView {
            public_key: key_text(key),
            label: a.label.clone(),
            enrolled_at_ms: a.enrolled_at_ms,
            enrolled_block_height: a.enrolled_block_height,
            revoked: a.revoked_at_ms.is_some(),
            revoked_at_ms: a.revoked_at_ms,
            revoked_block_height: a.revoked_block_height,
            revocation_reason: a.revocation_reason.clone(),
            certificates: a.certificates,
        }
    }
}

#[near]
impl Registry {
    /// One-time initialisation. Only the contract account itself may call it (deploy and
    /// initialise in one transaction), so nobody else can claim ownership of a fresh deployment.
    #[init]
    #[private]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            attesters: IterableMap::new(b"a"),
            certificates: Vector::new(b"c"),
            by_bundle: LookupMap::new(b"b"),
            project_counts: LookupMap::new(b"n"),
            by_project: LookupMap::new(b"p"),
        }
    }

    /// Owner only: enrol an Ed25519 attester key. A key is enrolled at most once; a revoked key
    /// can never be enrolled again.
    pub fn enrol_attester(&mut self, public_key: PublicKey, label: String) {
        self.require_owner();
        let key = ed25519_bytes(&public_key);
        if !cert::is_plain_text(&label, cert::MAX_LABEL_LEN) {
            fail("RSREG_FIELD_INVALID:label");
        }
        if self.attesters.contains_key(&key) {
            fail("RSREG_ATTESTER_EXISTS");
        }
        if self.attesters.len() >= MAX_ATTESTERS {
            fail("RSREG_ATTESTER_LIMIT");
        }
        self.attesters.insert(
            key,
            Attester {
                label,
                enrolled_at_ms: env::block_timestamp_ms(),
                enrolled_block_height: env::block_height(),
                revoked_at_ms: None,
                revoked_block_height: None,
                revocation_reason: None,
                certificates: 0,
            },
        );
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"{CONTRACT_NAME}\",\"version\":\"{CONTRACT_VERSION}\",\"event\":\"attester_enrolled\",\"data\":{{\"public_key\":\"{}\"}}}}",
            key_text(&key)
        ));
    }

    /// Owner only: revoke an attester key. Permanent. Certificates the key already published
    /// stay in the log and are reported with the revocation.
    pub fn revoke_attester(&mut self, public_key: PublicKey, reason: String) {
        self.require_owner();
        let key = ed25519_bytes(&public_key);
        if !cert::is_plain_text(&reason, cert::MAX_REASON_LEN) {
            fail("RSREG_FIELD_INVALID:reason");
        }
        let now = env::block_timestamp_ms();
        let height = env::block_height();
        match self.attesters.get_mut(&key) {
            None => fail("RSREG_ATTESTER_UNKNOWN"),
            Some(a) => {
                if a.revoked_at_ms.is_some() {
                    fail("RSREG_ALREADY_REVOKED");
                }
                a.revoked_at_ms = Some(now);
                a.revoked_block_height = Some(height);
                a.revocation_reason = Some(reason);
            }
        }
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"{CONTRACT_NAME}\",\"version\":\"{CONTRACT_VERSION}\",\"event\":\"attester_revoked\",\"data\":{{\"public_key\":\"{}\"}}}}",
            key_text(&key)
        ));
    }

    /// Append a certificate. Anyone may call this; the certificate is accepted only when
    /// `signature` is the attester's Ed25519 signature over the signing payload for exactly these
    /// fields and this registry account, and the attester is enrolled and not revoked. Returns
    /// the certificate id (its position in the log).
    pub fn publish(&mut self, certificate: CertificateInput, attester: PublicKey, signature: Base64VecU8) -> u32 {
        let key = ed25519_bytes(&attester);
        match self.attesters.get(&key) {
            None => fail("RSREG_ATTESTER_UNKNOWN"),
            Some(a) if a.revoked_at_ms.is_some() => fail("RSREG_ATTESTER_REVOKED"),
            Some(_) => {}
        }
        let registry = env::current_account_id();
        let fields = cert::CertificateFields {
            registry: registry.as_str(),
            project: &certificate.project,
            bundle_digest: &certificate.bundle_digest,
            verdict: &certificate.verdict,
            corpus_digest: &certificate.corpus_digest,
            artifact_digest: &certificate.artifact_digest,
            commit: &certificate.commit,
            timestamp_ms: certificate.timestamp_ms,
        };
        let verdict = cert::validate(&fields).unwrap_or_else(|e| fail(e.code()));
        let payload = cert::signing_payload(&fields).unwrap_or_else(|e| fail(e.code()));
        let now = env::block_timestamp_ms();
        if let Err(e) = cert::check_timestamp(certificate.timestamp_ms, now) {
            fail(e.code());
        }
        let signature: [u8; 64] = match <[u8; 64]>::try_from(signature.0.as_slice()) {
            Ok(s) => s,
            Err(_) => fail("RSREG_SIGNATURE_INVALID"),
        };
        if !env::ed25519_verify(&signature, &payload, &key) {
            fail("RSREG_SIGNATURE_INVALID");
        }

        let bundle = cert::digest_bytes(&certificate.bundle_digest).unwrap_or_else(|| fail("RSREG_INTERNAL"));
        let corpus = cert::digest_bytes(&certificate.corpus_digest).unwrap_or_else(|| fail("RSREG_INTERNAL"));
        let artifact = cert::digest_bytes(&certificate.artifact_digest).unwrap_or_else(|| fail("RSREG_INTERNAL"));
        let mut ids = self.by_bundle.get(&bundle).cloned().unwrap_or_default();
        for id in &ids {
            match self.certificates.get(*id) {
                Some(existing) if existing.attester == key => fail("RSREG_ALREADY_PUBLISHED"),
                Some(_) => {}
                None => fail("RSREG_INTERNAL"),
            }
        }
        if ids.len() >= MAX_CERTIFICATES_PER_BUNDLE {
            fail("RSREG_BUNDLE_CERTIFICATE_LIMIT");
        }

        let id = self.certificates.len();
        let height = env::block_height();
        self.certificates.push(Certificate {
            project: certificate.project.clone(),
            bundle_digest: bundle,
            verdict: verdict as u8,
            corpus_digest: corpus,
            artifact_digest: artifact,
            commit: certificate.commit.clone(),
            timestamp_ms: certificate.timestamp_ms,
            attester: key,
            signature,
            published_at_ms: now,
            published_block_height: height,
        });
        ids.push(id);
        self.by_bundle.insert(bundle, ids);
        let position = self.project_counts.get(&certificate.project).copied().unwrap_or(0);
        self.by_project.insert((certificate.project.clone(), position), id);
        self.project_counts.insert(certificate.project.clone(), position + 1);
        if let Some(a) = self.attesters.get_mut(&key) {
            a.certificates += 1;
        }
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"{CONTRACT_NAME}\",\"version\":\"{CONTRACT_VERSION}\",\"event\":\"certificate_published\",\"data\":{{\"id\":{id},\"project\":\"{}\",\"bundle_digest\":\"{}\",\"verdict\":\"{}\",\"attester\":\"{}\"}}}}",
            certificate.project,
            certificate.bundle_digest,
            verdict.as_str(),
            key_text(&key)
        ));
        id
    }

    pub fn get_info(&self) -> RegistryInfo {
        RegistryInfo {
            contract: CONTRACT_NAME.to_owned(),
            version: CONTRACT_VERSION.to_owned(),
            payload_domain: cert::PAYLOAD_DOMAIN.to_owned(),
            owner_id: self.owner_id.clone(),
            attesters: self.attesters.len(),
            certificates: self.certificates.len(),
            max_future_skew_ms: cert::MAX_FUTURE_SKEW_MS,
            max_age_ms: cert::MAX_AGE_MS,
        }
    }

    pub fn get_attester(&self, public_key: PublicKey) -> Option<AttesterView> {
        let key = ed25519_bytes(&public_key);
        self.attesters.get(&key).map(|a| Self::attester_view(&key, a))
    }

    /// Attesters in enrolment order.
    pub fn list_attesters(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<AttesterView> {
        let range = page(from_index, limit, self.attesters.len());
        self.attesters
            .iter()
            .skip(range.start as usize)
            .take((range.end - range.start) as usize)
            .map(|(key, a)| Self::attester_view(key, a))
            .collect()
    }

    pub fn get_certificate(&self, id: u32) -> Option<CertificateView> {
        self.certificate_view(id)
    }

    /// Every certificate published for a bundle digest (at most one per attester).
    pub fn get_certificates_by_bundle(&self, bundle_digest: String) -> Vec<CertificateView> {
        let bundle = cert::digest_bytes(&bundle_digest).unwrap_or_else(|| fail("RSREG_FIELD_INVALID:bundle_digest"));
        self.by_bundle
            .get(&bundle)
            .map(|ids| ids.iter().filter_map(|id| self.certificate_view(*id)).collect())
            .unwrap_or_default()
    }

    pub fn get_project_certificate_count(&self, project: String) -> u32 {
        self.project_counts.get(&project).copied().unwrap_or(0)
    }

    /// A project's certificates in publication order.
    pub fn get_certificates_by_project(
        &self,
        project: String,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<CertificateView> {
        if !cert::is_project_key(&project) {
            fail("RSREG_FIELD_INVALID:project");
        }
        let total = self.project_counts.get(&project).copied().unwrap_or(0);
        page(from_index, limit, total)
            .filter_map(|position| self.by_project.get(&(project.clone(), position)).copied())
            .filter_map(|id| self.certificate_view(id))
            .collect()
    }
}
