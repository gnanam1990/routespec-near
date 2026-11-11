/**
 * Test-only X.509 material, generated at run time (nothing key-like is committed).
 *
 * - a test CA and a leaf for the pinned host name, used by the loopback upstream emulator;
 * - a leaf for a different host name signed by the same CA (hostname-mismatch case);
 * - a self-signed leaf for the pinned host name that no trust store contains (untrusted case).
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import forge from 'node-forge';

export interface TestCert {
  readonly key: string;
  readonly cert: string;
}

export interface TestPki {
  readonly caCert: string;
  readonly pinned: TestCert;
  readonly wrongHost: TestCert;
  readonly untrusted: TestCert;
}

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return {
    pem: privateKey,
    privateKey: forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey,
    publicKey: forge.pki.publicKeyFromPem(publicKey),
  };
}

function baseCert(publicKey: forge.pki.PublicKey, cn: string): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = `01${randomBytes(8).toString('hex')}`;
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 24 * 3_600_000);
  cert.setSubject([{ name: 'commonName', value: cn }]);
  return cert;
}

function leaf(
  hostname: string,
  issuer: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey } | null,
): TestCert {
  const kp = keyPair();
  const cert = baseCert(kp.publicKey, hostname);
  cert.setIssuer(issuer ? issuer.cert.subject.attributes : cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
  ]);
  cert.sign(issuer ? issuer.key : kp.privateKey, forge.md.sha256.create());
  return { key: kp.pem, cert: forge.pki.certificateToPem(cert) };
}

export function createTestPki(pinnedHost: string): TestPki {
  const ca = keyPair();
  const caCert = baseCert(ca.publicKey, 'RouteSpec loopback test CA');
  caCert.setIssuer(caCert.subject.attributes);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);
  caCert.sign(ca.privateKey, forge.md.sha256.create());
  const issuer = { cert: caCert, key: ca.privateKey };
  return {
    caCert: forge.pki.certificateToPem(caCert),
    pinned: leaf(pinnedHost, issuer),
    wrongHost: leaf('other-host.example', issuer),
    untrusted: leaf(pinnedHost, null),
  };
}
