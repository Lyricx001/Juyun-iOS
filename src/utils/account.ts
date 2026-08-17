import { providerDefinitions } from '../config/providers';
import type { CloudAccount, CloudFolder, ProviderId } from '../types/cloud';

const providerIds = new Set<ProviderId>(['115', 'baidu', 'quark', 'alipan', 'tianyi', 'xunlei']);
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const unsafeTextGlobal = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;
const secureStoreIdPattern = /^[A-Za-z0-9._-]+$/;

function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIMESTAMP
    ? Math.floor(value)
    : 0;
}

export function normalizeStoredAccount(value: unknown): CloudAccount | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' ||
    !candidate.id ||
    candidate.id.length > 256 ||
    !secureStoreIdPattern.test(candidate.id) ||
    typeof candidate.providerId !== 'string' ||
    !providerIds.has(candidate.providerId as ProviderId) ||
    typeof candidate.displayName !== 'string' ||
    !candidate.credentials ||
    typeof candidate.credentials !== 'object' ||
    Array.isArray(candidate.credentials)
  ) {
    return null;
  }
  const credentials = Object.fromEntries(
    Object.entries(candidate.credentials as Record<string, unknown>)
      .filter((entry): entry is [string, string] => (
        /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(entry[0]) &&
        typeof entry[1] === 'string' &&
        entry[1].length <= 220_000
      ))
      .slice(0, 100),
  );
  return {
    id: candidate.id,
    providerId: candidate.providerId as ProviderId,
    displayName: candidate.displayName.replace(unsafeTextGlobal, '_').trim().slice(0, 120) || providerDefinitions[candidate.providerId as ProviderId].name,
    credentials,
    createdAt: timestamp(candidate.createdAt),
    updatedAt: timestamp(candidate.updatedAt),
  };
}

export function hasSameCredentialSnapshot(
  current: CloudAccount,
  stored: CloudAccount,
): boolean {
  if (current.id !== stored.id || current.providerId !== stored.providerId) return false;
  const currentEntries = Object.entries(current.credentials);
  const storedKeys = Object.keys(stored.credentials);
  return currentEntries.length === storedKeys.length && currentEntries.every(([key, value]) => (
    Object.prototype.hasOwnProperty.call(stored.credentials, key) &&
    stored.credentials[key] === value
  ));
}

export function getAccountRoot(account: CloudAccount): CloudFolder {
  const definition = providerDefinitions[account.providerId];
  if (account.providerId === 'baidu') {
    const path = account.credentials.rootPath?.trim() || '/';
    return { id: path, name: definition.root.name, path };
  }
  const rootId = account.credentials.rootId?.trim() || definition.root.id;
  return {
    ...definition.root,
    id: rootId,
  };
}
