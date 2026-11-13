//! The shared vectors: the payload bytes, their SHA-256, and a real Ed25519 signature over them.
//! `packages/registry` checks the same file, so both implementations sign and verify identical
//! bytes.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use routespec_certificate::{signing_payload, validate, CertificateFields};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../vectors/certificate-v1.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("vectors file")).expect("vectors json")
}

fn text<'a>(fields: &'a Value, name: &str) -> &'a str {
    fields[name].as_str().unwrap_or_else(|| panic!("field {name}"))
}

fn fields(v: &Value) -> CertificateFields<'_> {
    let f = &v["fields"];
    CertificateFields {
        registry: text(f, "registry"),
        project: text(f, "project"),
        bundle_digest: text(f, "bundleDigest"),
        verdict: text(f, "verdict"),
        corpus_digest: text(f, "corpusDigest"),
        artifact_digest: text(f, "artifactDigest"),
        commit: text(f, "commit"),
        timestamp_ms: f["timestampMs"].as_u64().expect("timestampMs"),
    }
}

#[test]
fn payload_bytes_match_the_shared_vectors() {
    let doc = vectors();
    assert_eq!(doc["schema"], "routespec.certificate-vectors/1");
    let list = doc["vectors"].as_array().expect("vectors");
    assert!(list.len() >= 6);
    for v in list {
        let payload = signing_payload(&fields(v)).unwrap_or_else(|e| panic!("{}: {:?}", v["name"], e));
        assert_eq!(payload, v["payloadUtf8"].as_str().unwrap().as_bytes(), "{}", v["name"]);
        assert_eq!(
            hex::encode(Sha256::digest(&payload)),
            v["payloadSha256"].as_str().unwrap(),
            "{}",
            v["name"]
        );
    }
}

#[test]
fn recorded_signatures_verify_and_any_changed_field_breaks_them() {
    let doc = vectors();
    let key_bytes: [u8; 32] = hex::decode(doc["attesterPublicKeyHex"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let key = VerifyingKey::from_bytes(&key_bytes).unwrap();
    for v in doc["vectors"].as_array().unwrap() {
        let f = fields(v);
        let signature_bytes: [u8; 64] = hex::decode(v["signatureHex"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let signature = Signature::from_bytes(&signature_bytes);
        key.verify(&signing_payload(&f).unwrap(), &signature)
            .unwrap_or_else(|_| panic!("{}", v["name"]));

        let other_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000001";
        let other_commit = "0000000000000000000000000000000000000001";
        let other_verdict = if f.verdict == "PASS" { "FAIL" } else { "PASS" };
        let tampered = [
            CertificateFields {
                registry: "other-registry.testnet",
                ..f
            },
            CertificateFields {
                project: "someone/else",
                ..f
            },
            CertificateFields {
                bundle_digest: other_digest,
                ..f
            },
            CertificateFields {
                verdict: other_verdict,
                ..f
            },
            CertificateFields {
                corpus_digest: other_digest,
                ..f
            },
            CertificateFields {
                artifact_digest: other_digest,
                ..f
            },
            CertificateFields {
                commit: other_commit,
                ..f
            },
            CertificateFields {
                timestamp_ms: if f.timestamp_ms == 1 { 2 } else { f.timestamp_ms - 1 },
                ..f
            },
        ];
        for (i, t) in tampered.iter().enumerate() {
            let payload = signing_payload(t).unwrap();
            assert!(key.verify(&payload, &signature).is_err(), "{} tamper {}", v["name"], i);
        }
    }
}

#[test]
fn invalid_fields_are_refused_with_the_recorded_code() {
    let doc = vectors();
    let list = doc["invalid"].as_array().expect("invalid");
    assert!(list.len() >= 20);
    for v in list {
        let f = fields(v);
        let error = validate(&f).expect_err(v["name"].as_str().unwrap());
        assert_eq!(error.code(), v["error"].as_str().unwrap(), "{}", v["name"]);
        assert_eq!(signing_payload(&f).expect_err("payload").code(), error.code());
    }
}
