'use strict';

/**
 * S3EncryptedStore — drop-in replacement for LocalEncryptedStore.
 *
 * When AWS_S3_BUCKET (+ credentials / IAM role) are configured, swap:
 *   const store = process.env.AWS_S3_BUCKET
 *     ? new S3EncryptedStore()
 *     : new LocalEncryptedStore(dataDir);
 *
 * Objects are AES-256-GCM encrypted client-side before PutObject
 * (defense in depth on top of SSE-S3 / SSE-KMS). TLS in transit via AWS SDK.
 *
 * Env: AWS_S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 * (or instance role). Optional: AWS_S3_PREFIX=om-gate/
 *
 * This stub throws until @aws-sdk/client-s3 is installed and wired.
 */

const { encryptBuffer, decryptBuffer, assertSafeObjectKey } = require('./crypto-store');

class S3EncryptedStore {
  constructor(opts = {}) {
    this.bucket = opts.bucket || process.env.AWS_S3_BUCKET;
    this.region = opts.region || process.env.AWS_REGION || 'us-west-2';
    this.prefix = opts.prefix || process.env.AWS_S3_PREFIX || 'om-gate/';
    this._client = null;
  }

  async init() {
    if (!this.bucket) {
      throw new Error('AWS_S3_BUCKET required for S3EncryptedStore');
    }
    // Lazy-load SDK so local demos don't need the package
    try {
      const { S3Client } = require('@aws-sdk/client-s3');
      this._client = new S3Client({ region: this.region });
    } catch (e) {
      console.warn('[s3-stub] @aws-sdk/client-s3 not installed — S3 store unavailable. Using LocalEncryptedStore.');
      throw new Error('S3 SDK not available: ' + e.message);
    }
  }

  _objectKey(key) {
    return this.prefix + assertSafeObjectKey(key) + '.enc';
  }

  async put(key, buffer) {
    assertSafeObjectKey(key);
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    const encrypted = encryptBuffer(buffer);
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await this._client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this._objectKey(key),
      Body: encrypted,
      ContentType: 'application/octet-stream',
      ServerSideEncryption: 'AES256',
    }));
    return { key, bytes: buffer.length, encryptedBytes: encrypted.length };
  }

  async get(key) {
    assertSafeObjectKey(key);
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const out = await this._client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: this._objectKey(key),
    }));
    const chunks = [];
    for await (const c of out.Body) chunks.push(c);
    return decryptBuffer(Buffer.concat(chunks));
  }

  async exists(key) {
    try {
      const { HeadObjectCommand } = require('@aws-sdk/client-s3');
      await this._client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this._objectKey(key),
      }));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key) {
    assertSafeObjectKey(key);
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await this._client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this._objectKey(key),
    }));
    return true;
  }
}

/**
 * Factory: prefer S3 when bucket configured and SDK loads; else local.
 */
async function createObjectStore(dataDir) {
  const { LocalEncryptedStore } = require('./crypto-store');
  if (process.env.AWS_S3_BUCKET) {
    try {
      const s3 = new S3EncryptedStore();
      await s3.init();
      console.log('[store] Using S3EncryptedStore bucket=' + process.env.AWS_S3_BUCKET);
      return s3;
    } catch (e) {
      console.warn('[store] S3 unavailable (' + e.message + '); falling back to LocalEncryptedStore');
    }
  }
  const local = new LocalEncryptedStore(dataDir);
  await local.init();
  console.log('[store] Using LocalEncryptedStore at ' + dataDir);
  return local;
}

module.exports = { S3EncryptedStore, createObjectStore };
