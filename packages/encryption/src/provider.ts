export interface ContentKey {
  /** 16-byte public key identifier. Safe to put in a URL. */
  kid: Buffer;
  /** 16 raw AES-128 key bytes. Never persisted, never logged, never returned by an API
   *  other than the session-scoped key endpoint. */
  key: Buffer;
}

export interface WrappedKey {
  kid: Buffer;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  provider: string;
}

/** Bound as AEAD additional data, so a wrapped key cannot be transplanted between assets. */
export interface KeyContext { assetId: string; kid: Buffer }

export interface KeyProvider {
  readonly name: string;
  generateContentKey(): Promise<ContentKey>;
  wrap(key: Buffer, ctx: KeyContext): Promise<WrappedKey>;
  unwrap(w: WrappedKey, ctx: KeyContext): Promise<Buffer>;
}
