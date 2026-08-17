import { requireOptionalNativeModule } from 'expo';

type HashAlgorithm = 'md5' | 'sha1' | 'sha256';
type TextEncoding = 'utf8' | 'base64';
type OutputEncoding = 'hex' | 'base64';

interface JuyunNativeModule {
  openPreview(uri: string, title?: string): Promise<void>;
  hashFile(uri: string, algorithm: HashAlgorithm): Promise<string>;
  hashRange(uri: string, start: number, length: number, algorithm: HashAlgorithm): Promise<string>;
  hashChunks(uri: string, chunkSize: number, algorithm: HashAlgorithm): Promise<string[]>;
  gcidFile(uri: string, size: number): Promise<string>;
  hmac(
    message: string,
    key: string,
    algorithm: 'sha1' | 'sha256',
    keyEncoding: TextEncoding,
    outputEncoding: OutputEncoding,
  ): Promise<string>;
  aesEcbEncryptHex(message: string, key: string): Promise<string>;
  rsaEncryptBase64(message: string, publicKey: string): Promise<string>;
  copyRange(sourceUri: string, destinationUri: string, start: number, length: number): Promise<void>;
  readRangeBase64(uri: string, start: number, length: number): Promise<string>;
}

const nativeModule = requireOptionalNativeModule<JuyunNativeModule>('ExpoJuyunNative');
const MAX_IN_MEMORY_RANGE = 64 * 1024 * 1024;

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}必须是安全的非负整数`);
  }
}

function assertRange(start: number, length: number, label: string): void {
  assertNonNegativeInteger(start, `${label}起点`);
  assertNonNegativeInteger(length, `${label}长度`);
  if (!Number.isSafeInteger(start + length)) throw new Error(`${label}范围过大`);
}

function requireModule(): JuyunNativeModule {
  if (!nativeModule) {
    throw new Error('此功能需要 TestFlight 或聚云开发构建，Expo Go 不包含原生文件组件');
  }
  return nativeModule;
}

export function hasJuyunNativeModule(): boolean {
  return nativeModule !== null;
}

export async function openNativePreview(uri: string, title?: string): Promise<void> {
  await requireModule().openPreview(uri, title);
}

export async function hashFile(uri: string, algorithm: HashAlgorithm): Promise<string> {
  return requireModule().hashFile(uri, algorithm);
}

export async function hashRange(
  uri: string,
  start: number,
  length: number,
  algorithm: HashAlgorithm,
): Promise<string> {
  assertRange(start, length, '哈希');
  return requireModule().hashRange(uri, start, length, algorithm);
}

export async function hashChunks(
  uri: string,
  chunkSize: number,
  algorithm: HashAlgorithm,
): Promise<string[]> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_IN_MEMORY_RANGE) {
    throw new Error('哈希分片大小无效');
  }
  return requireModule().hashChunks(uri, chunkSize, algorithm);
}

export async function gcidFile(uri: string, size: number): Promise<string> {
  assertNonNegativeInteger(size, '文件大小');
  return requireModule().gcidFile(uri, size);
}

export async function hmac(
  message: string,
  key: string,
  algorithm: 'sha1' | 'sha256',
  keyEncoding: TextEncoding = 'utf8',
  outputEncoding: OutputEncoding = 'hex',
): Promise<string> {
  return requireModule().hmac(message, key, algorithm, keyEncoding, outputEncoding);
}

export async function aesEcbEncryptHex(message: string, key: string): Promise<string> {
  return requireModule().aesEcbEncryptHex(message, key);
}

export async function rsaEncryptBase64(message: string, publicKey: string): Promise<string> {
  return requireModule().rsaEncryptBase64(message, publicKey);
}

export async function copyRange(
  sourceUri: string,
  destinationUri: string,
  start: number,
  length: number,
): Promise<void> {
  assertRange(start, length, '复制');
  await requireModule().copyRange(sourceUri, destinationUri, start, length);
}

export async function readRangeBase64(uri: string, start: number, length: number): Promise<string> {
  assertRange(start, length, '读取');
  if (length > MAX_IN_MEMORY_RANGE) throw new Error('单次读取范围过大');
  return requireModule().readRangeBase64(uri, start, length);
}
