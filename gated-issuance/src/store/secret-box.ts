import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Seals secrets with AES-256-GCM as "v1:" + base64(iv || ciphertext || tag).
 * Each secret is bound to its record id as additional authenticated data, so
 * a sealed value copied onto another record does not open, and a wrong key
 * or a flipped bit fails loudly instead of yielding garbage.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (key.length !== 32) throw new Error(`secret-box key must be 32 bytes, got ${key.length}`);
    this.key = Buffer.from(key);
  }

  /** Parses a 32-byte key given as 64 hex characters (e.g. STATE_KEY). */
  static fromHex(hex: string): SecretBox {
    const trimmed = hex.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      throw new Error('state key must be 32 bytes given as 64 hex characters');
    }
    return new SecretBox(Buffer.from(trimmed, 'hex'));
  }

  seal(plaintext: string, recordId: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(recordId, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return VERSION + Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64');
  }

  open(sealed: string, recordId: string): string {
    if (typeof sealed !== 'string' || !sealed.startsWith(VERSION)) {
      throw new Error(`unknown sealed-secret format for '${recordId}'`);
    }
    const raw = Buffer.from(sealed.slice(VERSION.length), 'base64');
    if (raw.length < IV_BYTES + TAG_BYTES) throw new Error(`sealed secret for '${recordId}' is too short`);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, IV_BYTES), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(Buffer.from(recordId, 'utf8'));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch (err) {
      throw new Error(`cannot unseal secret for '${recordId}' (wrong key or tampered state)`, { cause: err });
    }
  }
}
