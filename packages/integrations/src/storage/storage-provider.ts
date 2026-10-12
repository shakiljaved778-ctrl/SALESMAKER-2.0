import { Readable } from 'node:stream';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Object storage (§3.12): S3 in AWS, an S3-compatible store locally. Browsers upload and download
 * through short-lived pre-signed URLs; services read and write objects directly (imports read an
 * uploaded file and write a results file). Object keys are `{tenantId}/{yyyy}/{mm}/{uuid}`.
 */
export interface StorageProvider {
  presignPut(
    key: string,
    contentType: string,
    maxBytes: number,
    expiresInSeconds: number,
  ): Promise<string>;
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
  /** Write an object from the service. */
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Read an object as a stream; throws when it does not exist. */
  getObject(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

/** A storage key for a tenant's new object (§3.12). */
export function storageKey(tenantId: string, id: string, now = new Date()): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${tenantId}/${yyyy}/${mm}/${id}`;
}

export interface S3StorageOptions {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style URLs (S3-compatible stores such as SeaweedFS locally). */
  forcePathStyle?: boolean;
}

/** S3 settings as the apps read them from the environment (all optional: storage is off without them). */
export interface S3StorageConfig {
  S3_ENDPOINT?: string | undefined;
  S3_REGION: string;
  S3_ACCESS_KEY_ID?: string | undefined;
  S3_SECRET_ACCESS_KEY?: string | undefined;
  S3_BUCKET?: string | undefined;
}

/** S3 storage from an app's config; undefined when it is not configured. */
export function s3StorageFrom(config: S3StorageConfig): S3StorageProvider | undefined {
  if (!config.S3_BUCKET || !config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY)
    return undefined;
  return new S3StorageProvider({
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
  });
}

/** S3 (and S3-compatible) storage through the AWS SDK. */
export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      // Checksums only when S3 requires them: a pre-signed PUT must not carry one computed
      // over an empty body (the browser sends the file; the store would answer BadDigest).
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  /**
   * Development and CI only (cells are provisioned by Terraform): create the bucket if it is
   * missing and let these web origins upload and download through pre-signed URLs.
   */
  async ensureBucket(origins: string[]): Promise<void> {
    const Bucket = this.options.bucket;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket }));
    }
    await this.client.send(
      new PutBucketCorsCommand({
        Bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: origins,
              AllowedMethods: ['PUT', 'GET'],
              AllowedHeaders: ['*'],
              MaxAgeSeconds: 3000,
            },
          ],
        },
      }),
    );
  }

  presignPut(key: string, contentType: string, maxBytes: number, expiresInSeconds: number) {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: maxBytes,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  presignGet(key: string, expiresInSeconds: number) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getObject(key: string): Promise<Readable> {
    const out = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
    );
    if (!(out.Body instanceof Readable)) throw new Error(`object ${key} has no readable body`);
    return out.Body;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }
}

/** In-memory test double: keeps the bytes it is given and returns deterministic URLs. */
export class FakeStorageProvider implements StorageProvider {
  readonly objects = new Map<string, { contentType: string; body?: Buffer }>();

  presignPut(key: string, contentType: string): Promise<string> {
    this.objects.set(key, { contentType });
    return Promise.resolve(`https://storage.fake/upload/${encodeURIComponent(key)}`);
  }

  presignGet(key: string): Promise<string> {
    return Promise.resolve(`https://storage.fake/download/${encodeURIComponent(key)}`);
  }

  putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { contentType, body: Buffer.from(body) });
    return Promise.resolve();
  }

  getObject(key: string): Promise<Readable> {
    const body = this.objects.get(key)?.body;
    if (!body) return Promise.reject(new Error(`no object ${key}`));
    return Promise.resolve(Readable.from([body]));
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}
