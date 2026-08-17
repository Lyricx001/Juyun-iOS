import * as Crypto from 'expo-crypto';
import { Directory, File, Paths, UploadType, type UploadResult } from 'expo-file-system';
import { copyRange, hmac } from '../native/juyunNative';
import type { CloudUploadSource, UploadProgress } from '../types/cloud';
import { isHttpUrl, normalizedLocalFilePath } from './downloads';
import { safeLocalFilename } from './format';
import { assertHttpHeaders } from './headers';
import { canonicalQueryString, encodeRfc3986 } from './signing';

const uploadCache = new Directory(Paths.cache, 'juyun-upload-parts');
let uploadCacheInitialized = false;

function deleteTemporaryFile(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // Cache cleanup must not turn a successful upload into a reported failure.
  }
}

function ensureUploadCache(): void {
  if (!uploadCache.exists) uploadCache.create({ intermediates: true, idempotent: true });
  if (uploadCacheInitialized) return;
  uploadCacheInitialized = true;
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of uploadCache.list()) {
      if (entry instanceof File && (entry.lastModified ?? 0) < cutoff) entry.delete();
    }
  } catch {
    // Leftover cleanup is best-effort; individual temporary files still clean up after upload.
  }
}

export function sourceFile(source: CloudUploadSource): File {
  return new File(source.uri);
}

export function assertUploadSource(source: CloudUploadSource): File {
  if (!source.name.trim()) throw new Error('本地文件名无效');
  if (!Number.isSafeInteger(source.size) || source.size < 0) throw new Error('本地文件大小无效');
  if (!normalizedLocalFilePath(source.uri)) throw new Error('本地文件地址无效，请重新选择');
  let file: File;
  try {
    file = sourceFile(source);
  } catch {
    throw new Error('本地文件地址无效，请重新选择');
  }
  if (!file.exists) throw new Error('本地文件已被移除，请重新选择');
  if (file.size !== source.size) throw new Error('本地文件在选择后发生了变化，请重新选择');
  if (
    source.modifiedAt !== undefined &&
    Number.isFinite(source.modifiedAt) &&
    source.modifiedAt > 0 &&
    file.lastModified !== null &&
    Math.abs(Math.floor(file.lastModified) - Math.floor(source.modifiedAt)) > 1
  ) {
    throw new Error('本地文件在选择后发生了变化，请重新选择');
  }
  return file;
}

export function assertUploadResult(result: UploadResult, label = '上传'): UploadResult {
  if (!result || typeof result.status !== 'number' || !Number.isFinite(result.status)) {
    throw new Error(`${label}返回了无效响应，请稍后重试`);
  }
  if (result.status < 200 || result.status >= 300) {
    const detail = typeof result.body === 'string' ? result.body.slice(0, 300).trim() : '';
    throw new Error(`${label}失败（HTTP ${result.status}）${detail ? `：${detail}` : ''}`);
  }
  return result;
}

async function fileForRange(
  source: CloudUploadSource,
  start: number,
  length: number,
): Promise<{ file: File; temporary: boolean }> {
  if (start === 0 && length >= source.size) return { file: sourceFile(source), temporary: false };
  ensureUploadCache();
  const target = new File(
    uploadCache,
    safeLocalFilename(
      `${Crypto.randomUUID()}-${source.name}`,
      200,
    ),
  );
  try {
    await copyRange(source.uri, target.uri, start, length);
    if (!target.exists || !Number.isSafeInteger(target.size) || target.size !== length) {
      throw new Error(`本机上传分片不完整（应为 ${length} 字节，实际 ${target.exists ? target.size : 0} 字节）`);
    }
  } catch (error) {
    deleteTemporaryFile(target);
    throw error;
  }
  return { file: target, temporary: true };
}

interface RangeUploadOptions {
  url: string;
  source: CloudUploadSource;
  start: number;
  length: number;
  headers?: Record<string, string>;
  multipart?: boolean;
  fieldName?: string;
  parameters?: Record<string, string>;
  onProgress?: (sent: number, total: number) => void;
}

export async function uploadRange(options: RangeUploadOptions): Promise<UploadResult> {
  if (!isHttpUrl(options.url)) throw new Error('网盘返回了无效的上传地址');
  assertHttpHeaders(options.headers, '网盘返回的上传请求头');
  if (
    !Number.isSafeInteger(options.start) ||
    !Number.isSafeInteger(options.length) ||
    options.start < 0 ||
    options.length < 0 ||
    !Number.isSafeInteger(options.start + options.length) ||
    options.start + options.length > options.source.size
  ) {
    throw new Error('上传分片范围无效');
  }
  assertUploadSource(options.source);
  const { file, temporary } = await fileForRange(options.source, options.start, options.length);
  try {
    assertUploadSource(options.source);
    const result = await file.upload(options.url, {
      httpMethod: options.multipart ? 'POST' : 'PUT',
      uploadType: options.multipart ? UploadType.MULTIPART : UploadType.BINARY_CONTENT,
      headers: options.headers,
      fieldName: options.fieldName,
      mimeType: options.source.mimeType || 'application/octet-stream',
      parameters: options.parameters,
      sessionType: 'background',
      onProgress: ({ bytesSent, totalBytes }) => {
        const sent = Number.isFinite(bytesSent)
          ? Math.max(0, Math.min(options.length, Math.floor(bytesSent)))
          : 0;
        const total = Number.isFinite(totalBytes) && totalBytes > 0
          ? Math.max(sent, Math.floor(totalBytes))
          : options.length;
        options.onProgress?.(sent, total);
      },
    });
    return assertUploadResult(result);
  } finally {
    if (temporary) deleteTemporaryFile(file);
  }
}

export function reportUpload(
  callback: ((progress: UploadProgress) => void) | undefined,
  bytesSent: number,
  totalBytes: number,
  phase?: string,
): void {
  const safeTotal = Number.isFinite(totalBytes) ? Math.max(0, Math.floor(totalBytes)) : 0;
  const safeSent = Number.isFinite(bytesSent)
    ? Math.max(0, Math.min(safeTotal, Math.floor(bytesSent)))
    : 0;
  callback?.({
    bytesSent: safeSent,
    totalBytes: safeTotal,
    phase,
  });
}

export function encodePathSegments(value: string): string {
  return value.split('/').map((segment) => encodeRfc3986(segment)).join('/');
}

export function joinCloudPath(parent: string, name: string): string {
  const normalized = parent && parent !== '/' ? parent.replace(/\/+$/, '') : '';
  return `${normalized}/${name}`.replace(/\/{2,}/g, '/');
}

export function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return globalThis.btoa(binary);
}

export async function sha256Text(value: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
}

export async function md5Text(value: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.MD5, value);
}

export async function awsV4Headers(input: {
  method: 'PUT' | 'POST';
  url: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  securityToken?: string;
  payloadHash: string;
  now?: Date;
}): Promise<Record<string, string>> {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const url = new URL(input.url);
  const canonicalUri = url.pathname.split('/').map((segment) => encodeRfc3986(decodeURIComponent(segment))).join('/') || '/';
  const canonicalQuery = canonicalQueryString(url);
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
  };
  if (input.securityToken) headers['x-amz-security-token'] = input.securityToken;
  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders.map((key) => {
    const value = headers[key];
    if (value === undefined) throw new Error(`AWS 签名缺少请求头：${key}`);
    return `${key}:${value.trim()}\n`;
  }).join('');
  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(';'),
    input.payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Text(canonicalRequest),
  ].join('\n');
  const dateKey = await hmac(dateStamp, `AWS4${input.secretAccessKey}`, 'sha256', 'utf8', 'base64');
  const regionKey = await hmac(input.region, dateKey, 'sha256', 'base64', 'base64');
  const serviceKey = await hmac(input.service, regionKey, 'sha256', 'base64', 'base64');
  const signingKey = await hmac('aws4_request', serviceKey, 'sha256', 'base64', 'base64');
  const signature = await hmac(stringToSign, signingKey, 'sha256', 'base64', 'hex');

  return {
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
    ...(input.securityToken ? { 'x-amz-security-token': input.securityToken } : {}),
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
  };
}

export function headerValue(headers: Record<string, string>, name: string): string {
  const target = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1] ?? '';
}
