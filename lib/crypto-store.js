'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const unlink = promisify(fs.unlink);
const access = promisify(fs.access);

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey() {
  const hex = process.env.FILE_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('FILE_ENCRYPTION_KEY must be 32-byte hex (64 chars)');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a Buffer → { iv, tag, ciphertext } all concatenated:
 * [12-byte IV][16-byte auth tag][ciphertext]
 */
function encryptBuffer(plain) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

function decryptBuffer(blob) {
  const key = getKey();
  if (!blob || blob.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Encrypted blob too short');
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * Sanitize object key: only UUID hex + optional safe suffix. Reject traversal.
 */
function assertSafeObjectKey(key) {
  if (typeof key !== 'string' || !key) {
    throw new Error('Invalid object key');
  }
  if (key.includes('..') || key.includes('/') || key.includes('\\') || key.includes('\0')) {
    throw new Error('Path traversal rejected');
  }
  // Allow UUID or UUID-with-safe-suffix (hex, dash, underscore, alnum)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}$/.test(key)) {
    throw new Error('Object key allowlist failed');
  }
  return key;
}

/**
 * LocalEncryptedStore — AES-256-GCM at rest under dataDir.
 * Swap for S3EncryptedStore (lib/s3-stub.js) when AWS_S3_BUCKET is set.
 */
class LocalEncryptedStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.objectsDir = path.join(dataDir, 'objects');
  }

  async init() {
    await mkdir(this.objectsDir, { recursive: true });
  }

  _pathFor(key) {
    const safe = assertSafeObjectKey(key);
    return path.join(this.objectsDir, safe + '.enc');
  }

  async put(key, buffer) {
    assertSafeObjectKey(key);
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    const encrypted = encryptBuffer(buffer);
    const dest = this._pathFor(key);
    // Ensure resolved path stays inside objectsDir
    const resolved = path.resolve(dest);
    if (!resolved.startsWith(path.resolve(this.objectsDir) + path.sep)) {
      throw new Error('Path escape blocked');
    }
    await writeFile(resolved, encrypted);
    return { key, bytes: buffer.length, encryptedBytes: encrypted.length };
  }

  async get(key) {
    assertSafeObjectKey(key);
    const resolved = path.resolve(this._pathFor(key));
    if (!resolved.startsWith(path.resolve(this.objectsDir) + path.sep)) {
      throw new Error('Path escape blocked');
    }
    const blob = await readFile(resolved);
    return decryptBuffer(blob);
  }

  async exists(key) {
    try {
      assertSafeObjectKey(key);
      await access(this._pathFor(key), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async delete(key) {
    assertSafeObjectKey(key);
    try {
      await unlink(this._pathFor(key));
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = {
  LocalEncryptedStore,
  encryptBuffer,
  decryptBuffer,
  assertSafeObjectKey,
  getKey,
};
