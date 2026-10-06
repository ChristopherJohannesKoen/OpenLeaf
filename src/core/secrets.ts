import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption for things OpenLeaf has to keep but must never show: tokens for other services.
 * AES-256-GCM with a fresh nonce each time. `bind` ties a sealed value to its owner (a user id),
 * so a value copied onto another row does not open. The key is SECRETS_KEY, which lives in the
 * service's environment and not in the database: a copy of the database alone opens nothing.
 */
export function seal(key: Buffer, plaintext: string, bind: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(bind, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

/** Opens a sealed value, or returns null if it was sealed with another key, for another owner, or altered. */
export function unseal(key: Buffer, sealed: string, bind: string): string | null {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1]!, 'base64url'));
    decipher.setAAD(Buffer.from(bind, 'utf8'));
    decipher.setAuthTag(Buffer.from(parts[2]!, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
