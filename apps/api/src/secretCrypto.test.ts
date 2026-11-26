import * as crypto from 'crypto';
import {
  decryptClaimSecret,
  encryptClaimSecret,
  resolveSecretEncryptionKey,
} from './services/secretCrypto';

describe('Claim Secret AES-256-GCM Encryption & Key Management', () => {
  const testKey = crypto.randomBytes(32);

  it('encrypts claim secrets with random IVs and decrypts cleanly', () => {
    const secret = 'CT-A1B2C3D4E5F60708';
    const enc1 = encryptClaimSecret(secret, testKey);
    const enc2 = encryptClaimSecret(secret, testKey);

    expect(enc1).not.toBe(enc2);
    expect(enc1).not.toContain(secret);
    expect(enc1.startsWith('v1:')).toBe(true);
    expect(decryptClaimSecret(enc1, testKey)).toBe(secret);
    expect(decryptClaimSecret(enc2, testKey)).toBe(secret);
  });

  it('rejects tampered ciphertext or wrong key via GCM authTag', () => {
    const enc = encryptClaimSecret('CT-SECRET-999', testKey);
    const parts = enc.split(':');
    // Flip last hex character in ciphertext
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3].slice(0, -1)}${
      parts[3].endsWith('a') ? 'b' : 'a'
    }`;

    expect(() => decryptClaimSecret(tampered, testKey)).toThrow();
    expect(() => decryptClaimSecret(enc, crypto.randomBytes(32))).toThrow();
  });

  it('fails closed in production if SECRET_ENCRYPTION_KEY is missing', () => {
    expect(() => resolveSecretEncryptionKey('', 'production')).toThrow(
      'SECRET_ENCRYPTION_KEY must be set in production',
    );
    const validHex = crypto.randomBytes(32).toString('hex');
    expect(resolveSecretEncryptionKey(validHex, 'production')).toHaveLength(32);
  });
});
