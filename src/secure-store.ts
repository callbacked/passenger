import type { Env } from './env.ts';

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function unbase64url(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
}

export function randomId(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function storageConfigured(env: Env): env is Env & { MEDIA_SIGNING_SECRET: string } {
  return Boolean(env.APP_DATA) && typeof env.MEDIA_SIGNING_SECRET === 'string' && env.MEDIA_SIGNING_SECRET.length >= 32;
}

export interface StoredRecord {
  expiresAt: number;
}

export interface SecureStore {
  get<T extends StoredRecord = StoredRecord>(id: string | null | undefined): Promise<T | null>;
  put(id: string, record: StoredRecord, now: number): Promise<void>;
  delete(id: string | null | undefined): Promise<void>;
}

interface SealedRecord {
  version: number;
  iv: string;
  data: string;
}

// Encrypted KV records keyed by the hash of a caller-held identifier, so KV contents never reveal cookies or tokens.
export async function createSecureStore(env: Env & { MEDIA_SIGNING_SECRET: string },
  { prefix, salt, info }: { prefix: string; salt: string; info: string }): Promise<SecureStore> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(env.MEDIA_SIGNING_SECRET), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(salt), info: encoder.encode(info) },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const keyFor = async (id: string) => `${prefix}${base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(id))))}`;
  return {
    async get<T extends StoredRecord>(id: string | null | undefined): Promise<T | null> {
      if (!id) return null;
      const name = await keyFor(id);
      const value = await env.APP_DATA.get(name);
      if (!value) return null;
      try {
        const sealed = JSON.parse(value) as SealedRecord;
        if (sealed.version !== 1) return null;
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64url(sealed.iv),
          additionalData: encoder.encode(name) }, key, unbase64url(sealed.data));
        return JSON.parse(new TextDecoder().decode(plaintext)) as T;
      } catch { return null; }
    },
    async put(id: string, record: StoredRecord, now: number): Promise<void> {
      const name = await keyFor(id);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(name) },
        key, encoder.encode(JSON.stringify(record)));
      await env.APP_DATA.put(name, JSON.stringify({ version: 1, iv: base64url(iv), data: base64url(new Uint8Array(data)) }),
        { expirationTtl: Math.max(60, Math.ceil((record.expiresAt - now) / 1000)) });
    },
    async delete(id: string | null | undefined): Promise<void> { if (id) await env.APP_DATA.delete(await keyFor(id)); },
  };
}
