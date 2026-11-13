//! Field rules, digest conversion and the timestamp window.

use routespec_certificate::*;

const D: &str = "sha256:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

fn base() -> CertificateFields<'static> {
    CertificateFields {
        registry: "registry.testnet",
        project: "org/repo",
        bundle_digest: D,
        verdict: "PASS",
        corpus_digest: D,
        artifact_digest: D,
        commit: "0123456789abcdef0123456789abcdef01234567",
        timestamp_ms: 1_794_528_000_000,
    }
}

#[test]
fn payload_is_line_based_with_the_domain_first() {
    let payload = String::from_utf8(signing_payload(&base()).unwrap()).unwrap();
    let lines: Vec<&str> = payload.split('\n').collect();
    assert_eq!(lines.len(), 10);
    assert_eq!(lines[0], PAYLOAD_DOMAIN);
    assert_eq!(lines[1], "registry:registry.testnet");
    assert_eq!(lines[8], "timestamp:1794528000000");
    assert_eq!(lines[9], "");
}

#[test]
fn no_field_can_smuggle_a_line_or_a_second_field() {
    for project in ["a\nverdict:FAIL", "a\rb", "a b", "a:b", "a\u{0}b"] {
        assert_eq!(
            validate(&CertificateFields { project, ..base() }),
            Err(CertificateError::Project),
            "{project:?}"
        );
    }
    for registry in ["a\nb.near", "a b.near", "-a.near", "a.near.", "a__b.near"] {
        assert_eq!(
            validate(&CertificateFields { registry, ..base() }),
            Err(CertificateError::Registry),
            "{registry:?}"
        );
    }
}

#[test]
fn verdicts_round_trip() {
    for v in [Verdict::Pass, Verdict::Fail, Verdict::Review, Verdict::NotRun] {
        assert_eq!(Verdict::parse(v.as_str()), Some(v));
        assert_eq!(Verdict::from_u8(v as u8), Some(v));
    }
    assert_eq!(Verdict::parse("UNSUPPORTED"), None);
    assert_eq!(Verdict::from_u8(4), None);
    assert_eq!(validate(&base()), Ok(Verdict::Pass));
}

#[test]
fn digests_convert_both_ways() {
    let bytes = digest_bytes(D).unwrap();
    assert_eq!(bytes[0], 0x00);
    assert_eq!(bytes[1], 0x11);
    assert_eq!(bytes[31], 0xff);
    assert_eq!(digest_text(&bytes), D);
    assert_eq!(digest_bytes("sha256:00"), None);
    assert_eq!(digest_bytes(&D.to_uppercase()), None);
}

#[test]
fn timestamp_window() {
    let now = 1_794_528_000_000u64;
    assert_eq!(check_timestamp(now, now), Ok(()));
    assert_eq!(check_timestamp(now + MAX_FUTURE_SKEW_MS, now), Ok(()));
    assert_eq!(
        check_timestamp(now + MAX_FUTURE_SKEW_MS + 1, now),
        Err(CertificateError::TimestampFuture)
    );
    assert_eq!(check_timestamp(now - MAX_AGE_MS, now), Ok(()));
    assert_eq!(
        check_timestamp(now - MAX_AGE_MS - 1, now),
        Err(CertificateError::TimestampStale)
    );
    assert_eq!(check_timestamp(u64::MAX, now), Err(CertificateError::TimestampFuture));
    assert_eq!(check_timestamp(1, u64::MAX), Err(CertificateError::TimestampStale));
}

#[test]
fn labels_and_reasons_are_plain_text() {
    assert!(is_plain_text("CI attester (main)", MAX_LABEL_LEN));
    assert!(!is_plain_text("", MAX_LABEL_LEN));
    assert!(!is_plain_text("line\nbreak", MAX_LABEL_LEN));
    assert!(!is_plain_text(&"x".repeat(MAX_LABEL_LEN + 1), MAX_LABEL_LEN));
    assert!(!is_plain_text("caf\u{e9}", MAX_LABEL_LEN));
}

fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

#[test]
fn small_order_keys_are_recognised_in_every_encoding() {
    let listed = [
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0100000000000000000000000000000000000000000000000000000000000000",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    ];
    for hex in listed {
        let mut key = hex32(hex);
        assert!(is_small_order_key(&key), "{hex}");
        key[31] ^= 0x80;
        assert!(is_small_order_key(&key), "{hex} with the sign bit flipped");
    }
    // A real key (RFC 8032 test 1) and a nearby value are not.
    let mut ordinary = hex32("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    assert!(!is_small_order_key(&ordinary));
    ordinary[0] = 2;
    assert!(!is_small_order_key(&ordinary));
}
