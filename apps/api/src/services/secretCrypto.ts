import * as crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

export function resolveSecretEncryptionKey(rawKey?: string, nodeEnv?: string): Buffer {
  const env = nodeEnv || process.env.NODE_ENV || 'development';
  const configured = rawKey ?? process.env.SECRET_ENCRYPTION_KEY ?? '';

  if (!configured) {
    if (env === 'production') {
      throw new Error('SECRET_ENCRYPTION_KEY must be set in production (64 hex chars / 32 bytes)');
    }
    // Development/test-only fallback derived in memory; never persisted in DB
    return crypto.createHash('sha256').update('chaintrace-dev-only-secret-key').digest();
  }

  if (/^[a-fA-F0-9]{64}$/.test(configured)) {
    return Buffer.from(configured, 'hex');
  }
  const b64 = Buffer.from(configured, 'base64');
  if (b64.length === 32) {
    return b64;
  }
  throw new Error('SECRET_ENCRYPTION_KEY must be a 32-byte hex (64 chars) or base64 key');
}

export function encryptClaimSecret(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptClaimSecret(payload: string, key: Buffer): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Malformed encrypted claim secret envelope');
  }
  const [, ivHex, tagHex, cipherHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(cipherHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
