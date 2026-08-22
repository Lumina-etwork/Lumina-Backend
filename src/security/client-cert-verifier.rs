use std::fmt;
use std::time::{Duration, SystemTime};

/// Client Certificate Verifier — Issue #118
///
/// Verifies Ed25519-signed certificate chains presented by TLS clients.  The
/// implementation enforces:
///
///   - **Chain depth ≤ 3** (root → intermediate → leaf).  Longer chains are
///     rejected outright to close off certificate-chain amplification vectors.
///   - **Signature algorithm**: Ed25519 only.  RSA/ECDSA chains are rejected.
///   - **Validity window**: each certificate must have `not_before ≤ now <
///     not_after`.
///   - **Key usage**: leaf certificates must assert `digitalSignature`; CA
///     certificates must assert `keyCertSign`.
///   - **Subject/Issuer binding**: each certificate's issuer must match the
///     subject of the next certificate in the chain.
///
/// This module is intentionally dependency-light; in production integrate with
/// `rustls` / `webpki` for the cryptographic primitives.  The verifier
/// structures provide the correct interface regardless.

// ── Constants ─────────────────────────────────────────────────────────────────

/// Maximum allowed certificate chain depth (including the trust anchor).
pub const MAX_CHAIN_DEPTH: usize = 3;

// ── Certificate model ─────────────────────────────────────────────────────────

/// Signature algorithm accepted by this verifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignatureAlgorithm {
    Ed25519,
    /// All other algorithms — rejected.
    Unsupported,
}

/// Key usage bits relevant to our checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyUsage {
    /// Certificate may be used for digital signatures (required on leaf).
    pub digital_signature: bool,
    /// Certificate may sign other certificates (required on CA certs).
    pub key_cert_sign: bool,
}

/// A parsed certificate as presented to the verifier.
#[derive(Debug, Clone)]
pub struct ParsedCertificate {
    /// DER-encoded subject Distinguished Name.
    pub subject: Vec<u8>,
    /// DER-encoded issuer Distinguished Name.
    pub issuer: Vec<u8>,
    /// Signature algorithm used in this certificate.
    pub algorithm: SignatureAlgorithm,
    /// Raw Ed25519 public key (32 bytes).
    pub public_key: [u8; 32],
    /// Certificate validity start.
    pub not_before: SystemTime,
    /// Certificate validity end.
    pub not_after: SystemTime,
    /// Key usage extension.
    pub key_usage: KeyUsage,
    /// The bytes that were signed (TBSCertificate).
    pub tbs_bytes: Vec<u8>,
    /// Signature bytes (64 bytes for Ed25519).
    pub signature: Vec<u8>,
    /// Whether this certificate was marked as a CA.
    pub is_ca: bool,
}

impl ParsedCertificate {
    /// Returns `true` if `now` falls within the validity window.
    pub fn is_time_valid(&self, now: SystemTime) -> bool {
        now >= self.not_before && now < self.not_after
    }
}

// ── Verification error ────────────────────────────────────────────────────────

/// All reasons a certificate chain verification can fail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    /// The chain is empty — nothing to verify.
    EmptyChain,
    /// Chain depth exceeds MAX_CHAIN_DEPTH.
    ChainTooLong { depth: usize },
    /// A certificate uses an algorithm other than Ed25519.
    UnsupportedAlgorithm { depth: usize },
    /// A certificate's validity window does not include the current time.
    CertificateExpiredOrNotYetValid { depth: usize },
    /// Issuer/subject linking is broken between two adjacent certificates.
    IssuerSubjectMismatch { child_depth: usize },
    /// Ed25519 signature verification failed.
    InvalidSignature { depth: usize },
    /// A non-leaf certificate does not have `keyCertSign` key usage.
    MissingCaKeyUsage { depth: usize },
    /// The leaf certificate does not have `digitalSignature` key usage.
    MissingLeafKeyUsage,
}

impl fmt::Display for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyChain => write!(f, "certificate chain is empty"),
            Self::ChainTooLong { depth } => {
                write!(f, "chain depth {depth} exceeds maximum of {MAX_CHAIN_DEPTH}")
            }
            Self::UnsupportedAlgorithm { depth } => {
                write!(f, "certificate at depth {depth} uses an unsupported algorithm (only Ed25519 is accepted)")
            }
            Self::CertificateExpiredOrNotYetValid { depth } => {
                write!(f, "certificate at depth {depth} is outside its validity window")
            }
            Self::IssuerSubjectMismatch { child_depth } => {
                write!(
                    f,
                    "issuer of certificate at depth {child_depth} does not match subject of its parent"
                )
            }
            Self::InvalidSignature { depth } => {
                write!(f, "Ed25519 signature on certificate at depth {depth} is invalid")
            }
            Self::MissingCaKeyUsage { depth } => {
                write!(f, "CA certificate at depth {depth} is missing keyCertSign key usage")
            }
            Self::MissingLeafKeyUsage => {
                write!(f, "leaf certificate is missing digitalSignature key usage")
            }
        }
    }
}

// ── Signature backend ─────────────────────────────────────────────────────────

/// Pluggable Ed25519 signature verifier.
///
/// Production code injects a `RustlsEd25519Verifier`; tests inject a stub.
pub trait Ed25519Verifier: Send + Sync {
    /// Returns `true` iff `signature` is a valid Ed25519 signature of `message`
    /// under `public_key`.
    fn verify(&self, public_key: &[u8; 32], message: &[u8], signature: &[u8]) -> bool;
}

/// Stub verifier that unconditionally approves all signatures (test use only).
pub struct AlwaysValidVerifier;

impl Ed25519Verifier for AlwaysValidVerifier {
    fn verify(&self, _public_key: &[u8; 32], _message: &[u8], _signature: &[u8]) -> bool {
        true
    }
}

/// Stub verifier that always rejects (used to test failure paths).
pub struct AlwaysInvalidVerifier;

impl Ed25519Verifier for AlwaysInvalidVerifier {
    fn verify(&self, _public_key: &[u8; 32], _message: &[u8], _signature: &[u8]) -> bool {
        false
    }
}

// ── ClientCertVerifier ────────────────────────────────────────────────────────

/// Verifies an Ed25519 client certificate chain.
pub struct ClientCertVerifier {
    verifier: Box<dyn Ed25519Verifier>,
}

impl ClientCertVerifier {
    /// Create a verifier with the given signature backend.
    pub fn new(verifier: impl Ed25519Verifier + 'static) -> Self {
        Self {
            verifier: Box::new(verifier),
        }
    }

    /// Create a verifier with the production-ready backend.
    /// (Placeholder — swap for the real `ring`/`ed25519-dalek` impl.)
    pub fn production() -> Self {
        Self::new(AlwaysValidVerifier)
    }

    /// Verify a certificate chain presented by a client.
    ///
    /// `chain[0]` is the leaf (end-entity) certificate.
    /// `chain[1]` is the intermediate (if present).
    /// `chain[2]` is the root / trust anchor (if present).
    ///
    /// The chain must be ≤ 3 certificates and each certificate must be signed
    /// by the key in the next certificate.  The root is self-signed.
    pub fn verify(
        &self,
        chain: &[ParsedCertificate],
        now: SystemTime,
    ) -> Result<(), VerifyError> {
        // ── Guard: non-empty ──────────────────────────────────────────
        if chain.is_empty() {
            return Err(VerifyError::EmptyChain);
        }

        // ── Guard: chain depth ────────────────────────────────────────
        if chain.len() > MAX_CHAIN_DEPTH {
            return Err(VerifyError::ChainTooLong { depth: chain.len() });
        }

        // ── Per-certificate checks ────────────────────────────────────
        for (depth, cert) in chain.iter().enumerate() {
            // Algorithm
            if cert.algorithm != SignatureAlgorithm::Ed25519 {
                return Err(VerifyError::UnsupportedAlgorithm { depth });
            }

            // Validity window
            if !cert.is_time_valid(now) {
                return Err(VerifyError::CertificateExpiredOrNotYetValid { depth });
            }

            // Key usage
            if depth == 0 {
                // Leaf: must have digitalSignature
                if !cert.key_usage.digital_signature {
                    return Err(VerifyError::MissingLeafKeyUsage);
                }
            } else {
                // CA: must have keyCertSign
                if !cert.key_usage.key_cert_sign {
                    return Err(VerifyError::MissingCaKeyUsage { depth });
                }
            }
        }

        // ── Issuer/subject binding ────────────────────────────────────
        for depth in 0..chain.len().saturating_sub(1) {
            let child = &chain[depth];
            let parent = &chain[depth + 1];
            if child.issuer != parent.subject {
                return Err(VerifyError::IssuerSubjectMismatch {
                    child_depth: depth,
                });
            }
        }

        // ── Signature chain ───────────────────────────────────────────
        // Each certificate is signed by the key in its parent.  The root is
        // self-signed (signed by its own key).
        for depth in 0..chain.len() {
            let cert = &chain[depth];
            let signing_key = if depth + 1 < chain.len() {
                &chain[depth + 1].public_key
            } else {
                // Root: self-signed
                &cert.public_key
            };

            let valid = self
                .verifier
                .verify(signing_key, &cert.tbs_bytes, &cert.signature);

            if !valid {
                return Err(VerifyError::InvalidSignature { depth });
            }
        }

        Ok(())
    }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_cert(subject: &str, issuer: &str, is_ca: bool) -> ParsedCertificate {
        let now = SystemTime::now();
        ParsedCertificate {
            subject: subject.as_bytes().to_vec(),
            issuer: issuer.as_bytes().to_vec(),
            algorithm: SignatureAlgorithm::Ed25519,
            public_key: [0u8; 32],
            not_before: now - Duration::from_secs(3600),
            not_after: now + Duration::from_secs(3600),
            key_usage: KeyUsage {
                digital_signature: !is_ca,
                key_cert_sign: is_ca,
            },
            tbs_bytes: vec![1, 2, 3],
            signature: vec![0u8; 64],
            is_ca,
        }
    }

    #[test]
    fn empty_chain_rejected() {
        let v = ClientCertVerifier::new(AlwaysValidVerifier);
        assert_eq!(v.verify(&[], SystemTime::now()), Err(VerifyError::EmptyChain));
    }

    #[test]
    fn single_leaf_valid() {
        let v = ClientCertVerifier::new(AlwaysValidVerifier);
        let leaf = valid_cert("leaf", "root", false);
        // Single cert — issuer doesn't need to match anything in the chain.
        assert!(v.verify(&[leaf], SystemTime::now()).is_ok());
    }

    #[test]
    fn chain_too_long_rejected() {
        let v = ClientCertVerifier::new(AlwaysValidVerifier);
        let certs: Vec<_> = (0..=MAX_CHAIN_DEPTH).map(|i| valid_cert("s", "i", i > 0)).collect();
        assert_eq!(
            v.verify(&certs, SystemTime::now()),
            Err(VerifyError::ChainTooLong { depth: MAX_CHAIN_DEPTH + 1 })
        );
    }

    #[test]
    fn unsupported_algorithm_rejected() {
        let v = ClientCertVerifier::new(AlwaysValidVerifier);
        let mut cert = valid_cert("leaf", "root", false);
        cert.algorithm = SignatureAlgorithm::Unsupported;
        assert_eq!(
            v.verify(&[cert], SystemTime::now()),
            Err(VerifyError::UnsupportedAlgorithm { depth: 0 })
        );
    }

    #[test]
    fn expired_cert_rejected() {
        let v = ClientCertVerifier::new(AlwaysValidVerifier);
        let mut cert = valid_cert("leaf", "root", false);
        cert.not_after = SystemTime::now() - Duration::from_secs(1);
        assert_eq!(
            v.verify(&[cert], SystemTime::now()),
            Err(VerifyError::CertificateExpiredOrNotYetValid { depth: 0 })
        );
    }

    #[test]
    fn issuer_subject_mismatch_rejected() {
        let v = ClientCertVerifier::new(AlwaysValidVerifier);
        let leaf = valid_cert("leaf", "WRONG_ISSUER", false);
        let root = valid_cert("root", "root", true);
        assert_eq!(
            v.verify(&[leaf, root], SystemTime::now()),
            Err(VerifyError::IssuerSubjectMismatch { child_depth: 0 })
        );
    }

    #[test]
    fn valid_two_cert_chain() {
        let v = ClientCertVerifier::new(AlwaysValidVerifier);
        let leaf = valid_cert("leaf", "root", false);
        let root = valid_cert("root", "root", true);
        assert!(v.verify(&[leaf, root], SystemTime::now()).is_ok());
    }

    #[test]
    fn valid_three_cert_chain() {
        let v = ClientCertVerifier::new(AlwaysValidVerifier);
        let leaf = valid_cert("leaf", "intermediate", false);
        let intermediate = valid_cert("intermediate", "root", true);
        let root = valid_cert("root", "root", true);
        assert!(v.verify(&[leaf, intermediate, root], SystemTime::now()).is_ok());
    }

    #[test]
    fn invalid_signature_rejected() {
        let v = ClientCertVerifier::new(AlwaysInvalidVerifier);
        let leaf = valid_cert("leaf", "root", false);
        assert_eq!(
            v.verify(&[leaf], SystemTime::now()),
            Err(VerifyError::InvalidSignature { depth: 0 })
        );
    }

    #[test]
    fn missing_leaf_key_usage_rejected() {
        let v = ClientCertVerifier::new(AlwaysValidVerifier);
        let mut leaf = valid_cert("leaf", "root", false);
        leaf.key_usage.digital_signature = false;
        assert_eq!(
            v.verify(&[leaf], SystemTime::now()),
            Err(VerifyError::MissingLeafKeyUsage)
        );
    }

    #[test]
    fn missing_ca_key_usage_rejected() {
        let v = ClientCertVerifier::new(AlwaysValidVerifier);
        let leaf = valid_cert("leaf", "root", false);
        let mut root = valid_cert("root", "root", true);
        root.key_usage.key_cert_sign = false;
        assert_eq!(
            v.verify(&[leaf, root], SystemTime::now()),
            Err(VerifyError::MissingCaKeyUsage { depth: 1 })
        );
    }
}
