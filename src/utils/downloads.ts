import type {
  DownloadLink,
  DownloadRecord,
  DownloadResumeState,
  DownloadStatus,
  ProviderId,
} from '../types/cloud';
import { assertHttpHeaders, filterHttpHeaderRecord } from './headers';

const providerIds = new Set<ProviderId>(['115', 'baidu', 'quark', 'alipan', 'tianyi', 'xunlei']);
const statuses = new Set<DownloadStatus>(['queued', 'downloading', 'paused', 'completed', 'failed']);
export const MAX_DOWNLOAD_RECORDS = 500;
const unsafeUrlTextPattern = /[\u0000-\u001F\u007F]/;
const MAX_DOWNLOAD_RESUME_BYTES = 220_000;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: unknown): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(finiteNumber(value))));
}

function journalTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export interface DownloadJournalCandidate<T> {
  value: T;
  modifiedAt: unknown;
  fallbackOrder: number;
}

export function orderDownloadJournalCandidates<T>(
  candidates: readonly DownloadJournalCandidate<T>[],
): T[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => (
      journalTimestamp(right.candidate.modifiedAt) - journalTimestamp(left.candidate.modifiedAt) ||
      left.candidate.fallbackOrder - right.candidate.fallbackOrder ||
      left.index - right.index
    ))
    .map(({ candidate }) => candidate.value);
}

export function isExpectedDownloadFileSize(
  expectedSize: unknown,
  actualSize: unknown,
): boolean {
  if (!Number.isSafeInteger(actualSize) || (actualSize as number) < 0) return false;
  if (expectedSize === 0) return true;
  return (
    Number.isSafeInteger(expectedSize) &&
    (expectedSize as number) > 0 &&
    expectedSize === actualSize
  );
}

export interface ReconciledDownloadProgress {
  bytesWritten: number;
  totalBytes: number;
  progress: number;
}

export function reconcileDownloadProgress(
  currentBytes: unknown,
  currentTotal: unknown,
  reportedBytes: unknown,
  reportedTotal: unknown,
): ReconciledDownloadProgress {
  const bytesWritten = Math.max(nonNegative(currentBytes), nonNegative(reportedBytes));
  const knownTotal = Math.max(nonNegative(currentTotal), nonNegative(reportedTotal));
  const totalBytes = knownTotal > 0 ? Math.max(knownTotal, bytesWritten) : 0;
  return {
    bytesWritten,
    totalBytes,
    progress: totalBytes > 0 ? Math.min(1, bytesWritten / totalBytes) : 0,
  };
}

export function normalizedLocalFilePath(uri: unknown): string | null {
  if (typeof uri !== 'string' || uri.length > 4_096) return null;
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) return null;
    const decodedPath = decodeURIComponent(url.pathname);
    if (decodedPath.includes('\u0000')) return null;
    const segments: string[] = [];
    for (const segment of decodedPath.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') segments.pop();
      else segments.push(segment);
    }
    return `/${segments.join('/')}`;
  } catch {
    return null;
  }
}

export function isSameLocalFileUri(left: unknown, right: unknown): boolean {
  const leftPath = normalizedLocalFilePath(left);
  const rightPath = normalizedLocalFilePath(right);
  return !!leftPath && leftPath === rightPath;
}

export interface DownloadRunLease {
  token: symbol;
  reservationKey?: string;
}

export class DownloadRunRegistry {
  private readonly tokens = new Map<string, symbol>();
  private readonly reservations = new Map<string, number>();

  begin(id: string, targetUri?: string): DownloadRunLease {
    const token = Symbol(id);
    this.tokens.set(id, token);
    const reservationKey = normalizedLocalFilePath(targetUri) ?? undefined;
    if (reservationKey) {
      this.reservations.set(
        reservationKey,
        (this.reservations.get(reservationKey) ?? 0) + 1,
      );
    }
    return { token, ...(reservationKey ? { reservationKey } : {}) };
  }

  isCurrent(id: string, token: symbol): boolean {
    return this.tokens.get(id) === token;
  }

  invalidate(id: string): void {
    this.tokens.delete(id);
  }

  isReserved(targetUri: unknown): boolean {
    const key = normalizedLocalFilePath(targetUri);
    return !!key && this.reservations.has(key);
  }

  finish(id: string, lease: DownloadRunLease): void {
    if (this.tokens.get(id) === lease.token) this.tokens.delete(id);
    if (!lease.reservationKey) return;
    const remaining = (this.reservations.get(lease.reservationKey) ?? 1) - 1;
    if (remaining > 0) this.reservations.set(lease.reservationKey, remaining);
    else this.reservations.delete(lease.reservationKey);
  }
}

export function limitDownloadHistory(
  records: DownloadRecord[],
  limit = MAX_DOWNLOAD_RECORDS,
): DownloadRecord[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('下载记录上限无效');
  const pendingCount = records.filter((record) => (
    record.status === 'queued' || record.status === 'downloading' || record.status === 'paused'
  )).length;
  let terminalSlots = Math.max(0, limit - pendingCount);
  return records.filter((record) => {
    if (record.status === 'queued' || record.status === 'downloading' || record.status === 'paused') {
      return true;
    }
    if (terminalSlots <= 0) return false;
    terminalSlots -= 1;
    return true;
  });
}

export function isHttpUrl(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    value.length > 16_384 ||
    unsafeUrlTextPattern.test(value)
  ) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function assertDownloadLink(link: DownloadLink, now = Date.now()): DownloadLink {
  if (!link || typeof link !== 'object' || !isHttpUrl(link.url)) {
    throw new Error('网盘返回了无效的下载地址');
  }
  if (link.headers !== undefined) {
    if (!link.headers || typeof link.headers !== 'object' || Array.isArray(link.headers)) {
      throw new Error('网盘返回了无效的下载请求头');
    }
    assertHttpHeaders(link.headers, '网盘返回的下载请求头');
  }
  if (link.expiresAt !== undefined && (!Number.isFinite(link.expiresAt) || link.expiresAt <= 0)) {
    throw new Error('网盘返回了无效的下载地址有效期');
  }
  if (link.expiresAt !== undefined && link.expiresAt <= now) {
    throw new Error('网盘返回的下载地址已经过期，请重新获取');
  }
  return link;
}

export function normalizeDownloadResumeState(
  value: unknown,
  now = Date.now(),
): DownloadResumeState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Record<string, unknown>;
  if (
    !isHttpUrl(state.url) ||
    typeof state.fileUri !== 'string' ||
    state.fileUri.length > 4_096 ||
    !normalizedLocalFilePath(state.fileUri) ||
    state.isDirectory !== false ||
    typeof state.resumeData !== 'string' ||
    !state.resumeData ||
    utf8Length(state.resumeData) > 200_000
  ) {
    return undefined;
  }
  const expiresAt = typeof state.expiresAt === 'number' && Number.isFinite(state.expiresAt)
    ? Math.floor(state.expiresAt)
    : undefined;
  if (state.expiresAt !== undefined && (!expiresAt || expiresAt <= now)) return undefined;
  const headers = filterHttpHeaderRecord(state.headers);
  const normalized: DownloadResumeState = {
    url: state.url,
    fileUri: state.fileUri,
    isDirectory: state.isDirectory,
    resumeData: state.resumeData,
    ...(headers && Object.keys(headers).length ? { headers } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
  return utf8Length(JSON.stringify(normalized)) <= MAX_DOWNLOAD_RESUME_BYTES
    ? normalized
    : undefined;
}

export function normalizeDownloadRecords(value: unknown, limit = MAX_DOWNLOAD_RECORDS): DownloadRecord[] {
  if (!Array.isArray(value)) return [];
  let records: DownloadRecord[] = [];
  const seenIds = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.id !== 'string' ||
      !record.id ||
      record.id.length > 512 ||
      seenIds.has(record.id) ||
      typeof record.accountId !== 'string' ||
      !record.accountId ||
      record.accountId.length > 256 ||
      typeof record.providerId !== 'string' ||
      !providerIds.has(record.providerId as ProviderId) ||
      typeof record.itemId !== 'string' ||
      record.itemId.length > 1024 ||
      typeof record.name !== 'string' ||
      !record.name ||
      record.name.length > 1024 ||
      typeof record.status !== 'string' ||
      !statuses.has(record.status as DownloadStatus)
    ) {
      continue;
    }
    const reconciled = reconcileDownloadProgress(
      0,
      record.totalBytes,
      record.bytesWritten,
      record.totalBytes,
    );
    const progress = record.status === 'completed' ? 1 : reconciled.progress;
    const localUri = typeof record.localUri === 'string' && normalizedLocalFilePath(record.localUri)
      ? record.localUri
      : undefined;
    const error = typeof record.error === 'string' && record.error
      ? record.error.slice(0, 1000)
      : undefined;
    const resumeAvailable = record.status === 'paused' && record.resumeAvailable === true;
    records.push({
      id: record.id,
      accountId: record.accountId,
      providerId: record.providerId as ProviderId,
      itemId: record.itemId,
      name: record.name,
      status: record.status as DownloadStatus,
      progress,
      bytesWritten: reconciled.bytesWritten,
      totalBytes: reconciled.totalBytes,
      createdAt: nonNegative(record.createdAt),
      ...(localUri ? { localUri } : {}),
      ...(resumeAvailable ? { resumeAvailable: true } : {}),
      ...(error ? { error } : {}),
    });
    seenIds.add(record.id);
    if (records.length > limit * 2) records = limitDownloadHistory(records, limit);
  }
  return limitDownloadHistory(records, limit);
}

export function parseDownloadMetadataText(text: string, limit = MAX_DOWNLOAD_RECORDS): DownloadRecord[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('下载记录文件结构无效');
  const records = normalizeDownloadRecords(parsed, limit);
  if (parsed.length > 0 && records.length === 0) {
    throw new Error('下载记录文件已损坏');
  }
  return records;
}
