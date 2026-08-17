import type { CloudAccount, CloudFolder, CloudItem, ProviderId } from '../types/cloud';
import { isHttpUrl } from './downloads';

export const MAX_DIRECTORY_ITEMS = 100_000;
export const MAX_PROVIDER_PAGES = 1_000;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

export function assertDirectoryCapacity(
  currentCount: number,
  incomingCount: number,
  providerLabel: string,
): void {
  if (
    !Number.isSafeInteger(currentCount) ||
    !Number.isSafeInteger(incomingCount) ||
    currentCount < 0 ||
    incomingCount < 0 ||
    currentCount + incomingCount > MAX_DIRECTORY_ITEMS
  ) {
    throw new Error(`${providerLabel}当前目录超过 ${MAX_DIRECTORY_ITEMS} 项，请缩小根目录范围后重试`);
  }
}

export function providerArray<T>(value: unknown, providerLabel: string): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${providerLabel}返回了无效的列表数据，请稍后刷新重试`);
  }
  return value as T[];
}

export function providerObject<T extends object>(value: unknown, providerLabel: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${providerLabel}返回了无效的响应数据，请稍后重试`);
  }
  return value as T;
}

export function shouldContinueProviderPagination(
  loadedCount: number,
  pageItemCount: number,
  pageSize: number,
  reportedTotal = 0,
): boolean {
  if (
    !Number.isSafeInteger(loadedCount) ||
    !Number.isSafeInteger(pageItemCount) ||
    !Number.isSafeInteger(pageSize) ||
    loadedCount < 0 ||
    pageItemCount < 0 ||
    pageSize < 1 ||
    !Number.isSafeInteger(reportedTotal) ||
    reportedTotal < 0
  ) {
    throw new Error('网盘返回了无效的分页状态，请稍后刷新重试');
  }
  if (pageItemCount === 0) return false;
  return reportedTotal > 0
    ? loadedCount < Math.floor(reportedTotal)
    : pageItemCount >= pageSize;
}

function optionalTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_TIMESTAMP
    ? Math.floor(value)
    : undefined;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

function optionalHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.startsWith('//') ? `https:${value}` : value;
  return isHttpUrl(normalized) ? normalized : undefined;
}

export function normalizeProviderItem(
  account: CloudAccount,
  providerId: ProviderId,
  input: Omit<CloudItem, 'accountId' | 'providerId'>,
): CloudItem {
  if (
    typeof input.id !== 'string' ||
    !input.id ||
    input.id.length > 1_024 ||
    input.id.includes('\u0000') ||
    typeof input.parentId !== 'string' ||
    input.parentId.length > 4_096 ||
    input.parentId.includes('\u0000') ||
    typeof input.name !== 'string' ||
    !input.name ||
    input.name.length > 1_024 ||
    input.name.includes('\u0000') ||
    typeof input.isFolder !== 'boolean'
  ) {
    throw new Error(`${providerId} 返回了无效的文件信息，请稍后刷新重试`);
  }
  const size = typeof input.size === 'number' && Number.isFinite(input.size) && input.size >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(input.size))
    : 0;
  return {
    ...input,
    id: input.id,
    parentId: input.parentId,
    name: input.name,
    isFolder: input.isFolder,
    size,
    path: optionalString(input.path, 4_096),
    mimeType: optionalString(input.mimeType, 256),
    thumbnailUrl: optionalHttpUrl(input.thumbnailUrl),
    createdAt: optionalTimestamp(input.createdAt),
    modifiedAt: optionalTimestamp(input.modifiedAt),
    extra: input.extra && typeof input.extra === 'object' && !Array.isArray(input.extra)
      ? input.extra
      : undefined,
    accountId: account.id,
    providerId,
  };
}

export function uniqueCloudItems(items: CloudItem[]): CloudItem[] {
  const seen = new Set<string>();
  const result: CloudItem[] = [];
  for (const item of items) {
    const key = `${item.accountId}\u0000${item.providerId}\u0000${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= MAX_DIRECTORY_ITEMS) break;
  }
  return result;
}

export function isItemAlreadyInFolder(item: CloudItem, folder: CloudFolder): boolean {
  return item.parentId === folder.id || (
    typeof folder.path === 'string' && item.parentId === folder.path
  );
}
