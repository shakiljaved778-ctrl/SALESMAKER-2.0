/**
 * Object storage (§3.12): S3 in AWS, an S3-compatible store locally. Uploads and downloads use
 * short-lived pre-signed URLs; object keys are `{tenantId}/{yyyy}/{mm}/{uuid}`.
 */
export interface StorageProvider {
  presignPut(
    key: string,
    contentType: string,
    maxBytes: number,
    expiresInSeconds: number,
  ): Promise<string>;
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}

/** In-memory test double that records calls and returns deterministic URLs. */
export class FakeStorageProvider implements StorageProvider {
  readonly objects = new Map<string, { contentType: string }>();

  presignPut(key: string, contentType: string): Promise<string> {
    this.objects.set(key, { contentType });
    return Promise.resolve(`https://storage.fake/upload/${encodeURIComponent(key)}`);
  }

  presignGet(key: string): Promise<string> {
    return Promise.resolve(`https://storage.fake/download/${encodeURIComponent(key)}`);
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}
