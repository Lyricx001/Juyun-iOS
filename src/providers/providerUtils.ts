import type {
  CloudAccount,
  CloudCapabilities,
  CloudCapability,
  CloudItem,
  ProviderId,
} from '../types/cloud';
import { patchCredentials } from '../storage/credentialStore';
import { formBody, requestJson } from '../utils/http';
import { singleFlight } from '../utils/async';
import {
  assertDirectoryCapacity,
  MAX_PROVIDER_PAGES,
  normalizeProviderItem,
  providerArray,
  providerObject,
  shouldContinueProviderPagination,
} from '../utils/providerData';

export {
  assertDirectoryCapacity,
  MAX_PROVIDER_PAGES,
  providerArray,
  providerObject,
  shouldContinueProviderPagination,
};

export function requireCredential(account: CloudAccount, key: string, label = key): string {
  const value = account.credentials[key]?.trim();
  if (!value) throw new Error(`${account.displayName} 缺少 ${label}`);
  return value;
}

export function numberValue(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

export function providerItem(
  account: CloudAccount,
  providerId: ProviderId,
  input: Omit<CloudItem, 'accountId' | 'providerId'>,
): CloudItem {
  return normalizeProviderItem(account, providerId, input);
}

export async function saveTokenPatch(
  account: CloudAccount,
  patch: Record<string, string | undefined>,
): Promise<void> {
  const filtered = Object.fromEntries(
    Object.entries(patch).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1]),
  );
  if (Object.keys(filtered).length) await patchCredentials(account, filtered);
}

export function refreshSingleFlight(
  account: CloudAccount,
  operation: () => Promise<void>,
): Promise<void> {
  // Draft credentials used by connection tests can share an account ID with the
  // live account. Coalesce only requests using the exact same account instance.
  return singleFlight(account, operation);
}

export async function postFormJson<T>(
  url: string,
  values: Record<string, string | number | boolean | undefined>,
  headers: Record<string, string> = {},
): Promise<T> {
  return requestJson<T>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: formBody(values),
  });
}

export function guessMimeType(name: string): string | undefined {
  const extension = name.split('.').pop()?.toLowerCase();
  const values: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/x-m4v',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    m3u8: 'application/vnd.apple.mpegurl',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    html: 'text/html',
    htm: 'text/html',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    pages: 'application/vnd.apple.pages',
    numbers: 'application/vnd.apple.numbers',
    key: 'application/vnd.apple.keynote',
    zip: 'application/zip',
    rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    tar: 'application/x-tar',
  };
  return extension ? values[extension] : undefined;
}

export function capabilities(...enabled: CloudCapability[]): CloudCapabilities {
  const result: CloudCapabilities = {
    search: false,
    upload: false,
    createFolder: false,
    rename: false,
    move: false,
    copy: false,
    delete: false,
  };
  enabled.forEach((value) => {
    result[value] = true;
  });
  return result;
}
