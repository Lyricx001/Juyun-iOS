import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type { CloudAccount, DownloadResumeState, ProviderId } from '../types/cloud';
import { hasSameCredentialSnapshot, normalizeStoredAccount } from '../utils/account';
import { mapWithConcurrency } from '../utils/async';
import { normalizeDownloadResumeState } from '../utils/downloads';
import { splitUtf8 } from '../utils/storage';

const INDEX_KEY = 'juyun.account.index.v1';
const ACCOUNT_PREFIX = 'juyun.account.v1.';
const DOWNLOAD_RESUME_PREFIX = 'juyun.download.resume.v1.';
const DOWNLOAD_RESUME_INDEX_KEY = 'juyun.download.resume.index.v1';
const SECURE_CHUNK_BYTES = 1800;
const MAX_SECURE_CHUNKS = 128;
const MAX_STORED_ACCOUNTS = 500;
const secureStoreIdPattern = /^[A-Za-z0-9._-]+$/;
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

interface SecureBlobManifest {
  __juyunSecureChunks: 1;
  generation: string;
  count: number;
  byteLength: number;
}

let resumeIndexQueue: Promise<void> = Promise.resolve();
let accountMutationQueue: Promise<void> = Promise.resolve();
const transientCredentialUpdates = new WeakMap<CloudAccount, number>();
const deletedAccountIds = new Set<string>();

function accountKey(id: string): string {
  if (!id || id.length > 256 || !secureStoreIdPattern.test(id)) {
    throw new Error('账号 ID 无效，请重新添加账号');
  }
  return `${ACCOUNT_PREFIX}${id}`;
}

function parseManifest(value: string | null): SecureBlobManifest | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SecureBlobManifest>;
    if (
      parsed.__juyunSecureChunks === 1 &&
      typeof parsed.generation === 'string' &&
      /^[a-z0-9]+$/i.test(parsed.generation) &&
      parsed.generation.length <= 80 &&
      Number.isInteger(parsed.count) &&
      (parsed.count ?? 0) > 0 &&
      (parsed.count ?? 0) <= MAX_SECURE_CHUNKS &&
      Number.isInteger(parsed.byteLength) &&
      (parsed.byteLength ?? -1) >= 0 &&
      (parsed.byteLength ?? 0) <= MAX_SECURE_CHUNKS * SECURE_CHUNK_BYTES
    ) {
      return parsed as SecureBlobManifest;
    }
  } catch {
    // Existing v1 entries contain the account JSON directly.
  }
  return null;
}

function chunkKey(key: string, generation: string, index: number): string {
  return `${key}.chunk.${generation}.${index}`;
}

async function cleanupChunks(key: string, manifest: SecureBlobManifest | null): Promise<void> {
  if (!manifest) return;
  await mapWithConcurrency(
    Array.from({ length: manifest.count }, (_, index) => index),
    8,
    async (index) => {
      try {
        await SecureStore.deleteItemAsync(chunkKey(key, manifest.generation, index), secureOptions);
      } catch {
        // Old chunk cleanup is best-effort and can be retried by a later rewrite.
      }
    },
  );
}

async function readSecureBlob(key: string): Promise<string | null> {
  const value = await SecureStore.getItemAsync(key, secureOptions);
  const manifest = parseManifest(value);
  if (!manifest) return value;
  const chunks = await mapWithConcurrency(
    Array.from({ length: manifest.count }, (_, index) => index),
    8,
    (index) => SecureStore.getItemAsync(
      chunkKey(key, manifest.generation, index),
      secureOptions,
    ),
  );
  if (chunks.some((chunk) => chunk === null)) {
    throw new Error('本机钥匙串中的凭证数据不完整，请重新保存账号');
  }
  const joined = (chunks as string[]).join('');
  if (new TextEncoder().encode(joined).length !== manifest.byteLength) {
    throw new Error('本机钥匙串中的凭证数据校验失败，请重新保存账号');
  }
  return joined;
}

async function writeSecureBlob(key: string, value: string): Promise<void> {
  const previous = parseManifest(await SecureStore.getItemAsync(key, secureOptions));
  const chunks = splitUtf8(value, SECURE_CHUNK_BYTES);
  if (chunks.length === 1) {
    await SecureStore.setItemAsync(key, value, secureOptions);
    await cleanupChunks(key, previous);
    return;
  }
  if (chunks.length > MAX_SECURE_CHUNKS) {
    throw new Error('凭证内容过长，请只保留网盘接口需要的 Token 或 Cookie 字段');
  }

  const generation = `${Date.now().toString(36)}${Crypto.randomUUID().replace(/-/g, '')}`;
  const written: string[] = [];
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const target = chunkKey(key, generation, index);
      const chunk = chunks[index];
      if (chunk === undefined) throw new Error('凭证分片生成失败');
      await SecureStore.setItemAsync(target, chunk, secureOptions);
      written.push(target);
    }
    const manifest: SecureBlobManifest = {
      __juyunSecureChunks: 1,
      generation,
      count: chunks.length,
      byteLength: new TextEncoder().encode(value).length,
    };
    await SecureStore.setItemAsync(key, JSON.stringify(manifest), secureOptions);
  } catch (error) {
    await mapWithConcurrency(written, 8, async (target) => {
      try {
        await SecureStore.deleteItemAsync(target, secureOptions);
      } catch {
        // Preserve the original write error; unused generation chunks are unreachable.
      }
    });
    throw error;
  }
  await cleanupChunks(key, previous);
}

async function deleteSecureBlob(key: string): Promise<void> {
  const manifest = parseManifest(await SecureStore.getItemAsync(key, secureOptions));
  await SecureStore.deleteItemAsync(key, secureOptions);
  await cleanupChunks(key, manifest);
}

async function downloadResumeKey(id: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, id);
  return `${DOWNLOAD_RESUME_PREFIX}${digest}`;
}

async function readResumeIndex(): Promise<string[]> {
  const value = await readSecureBlob(DOWNLOAD_RESUME_INDEX_KEY);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((entry): entry is string => (
          typeof entry === 'string' && entry.length > 0 && entry.length <= 512
        )))].slice(0, 1_000)
      : [];
  } catch {
    return [];
  }
}

function updateResumeIndex(operation: () => Promise<void>): Promise<void> {
  const next = resumeIndexQueue.then(operation, operation);
  resumeIndexQueue = next.catch(() => undefined);
  return next;
}

function updateAccounts<T>(operation: () => Promise<T>): Promise<T> {
  const next = accountMutationQueue.then(operation, operation);
  accountMutationQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function readIndex(): Promise<string[]> {
  const raw = await readSecureBlob(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((value): value is string => (
          typeof value === 'string' && value.length > 0 && value.length <= 256
          && secureStoreIdPattern.test(value)
        )))].slice(0, MAX_STORED_ACCOUNTS)
      : [];
  } catch {
    return [];
  }
}

async function writeIndex(ids: string[]): Promise<void> {
  if (
    ids.length > MAX_STORED_ACCOUNTS ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !id || id.length > 256 || !secureStoreIdPattern.test(id))
  ) {
    throw new Error('本机账号索引无效');
  }
  await writeSecureBlob(INDEX_KEY, JSON.stringify(ids));
}

export async function loadAccounts(): Promise<CloudAccount[]> {
  const ids = await readIndex();
  const accounts = await mapWithConcurrency(
    ids,
    4,
    async (id) => {
      try {
        const raw = await readSecureBlob(accountKey(id));
        if (!raw) return null;
        return normalizeStoredAccount(JSON.parse(raw));
      } catch {
        return null;
      }
    },
  );
  return accounts.filter((account): account is CloudAccount => account !== null);
}

async function persistAccountUnlocked(account: CloudAccount): Promise<CloudAccount> {
  const now = Date.now();
  const normalized: CloudAccount = {
    ...account,
    credentials: { ...account.credentials },
    createdAt: account.createdAt || now,
    updatedAt: now,
  };
  const ids = await readIndex();
  const key = accountKey(account.id);
  if (!ids.includes(account.id) && ids.length >= MAX_STORED_ACCOUNTS) {
    throw new Error(`本机最多保存 ${MAX_STORED_ACCOUNTS} 个网盘账号，请先删除不用的账号`);
  }
  const previousUnindexedValue = ids.includes(account.id) ? undefined : await readSecureBlob(key);
  await writeSecureBlob(key, JSON.stringify(normalized));
  if (!ids.includes(account.id)) {
    try {
      await writeIndex([...ids, account.id]);
    } catch (error) {
      if (previousUnindexedValue === null) {
        await deleteSecureBlob(key).catch(() => undefined);
      } else if (previousUnindexedValue !== undefined) {
        await writeSecureBlob(key, previousUnindexedValue).catch(() => undefined);
      }
      throw error;
    }
  }
  return normalized;
}

async function persistAccount(account: CloudAccount): Promise<CloudAccount> {
  return updateAccounts(() => persistAccountUnlocked(account));
}

export async function saveAccount(account: CloudAccount): Promise<CloudAccount> {
  deletedAccountIds.delete(account.id);
  return persistAccount(account);
}

export async function deleteAccount(id: string): Promise<void> {
  deletedAccountIds.add(id);
  try {
    await updateAccounts(async () => {
      const ids = await readIndex();
      const wasIndexed = ids.includes(id);
      if (wasIndexed) await writeIndex(ids.filter((item) => item !== id));
      try {
        await deleteSecureBlob(accountKey(id));
      } catch (error) {
        if (wasIndexed) {
          try {
            await writeIndex(ids);
          } catch {
            throw new Error('账号凭证删除失败，且本机账号索引无法恢复，请重新打开应用后检查');
          }
        }
        throw error;
      }
    });
  } catch (error) {
    deletedAccountIds.delete(id);
    throw error;
  }
}

export async function withTransientCredentialUpdates<T>(
  account: CloudAccount,
  operation: () => Promise<T>,
): Promise<T> {
  transientCredentialUpdates.set(account, (transientCredentialUpdates.get(account) ?? 0) + 1);
  try {
    return await operation();
  } finally {
    const remaining = (transientCredentialUpdates.get(account) ?? 1) - 1;
    if (remaining > 0) transientCredentialUpdates.set(account, remaining);
    else transientCredentialUpdates.delete(account);
  }
}

export async function patchCredentials(
  account: CloudAccount,
  values: Record<string, string>,
): Promise<boolean> {
  if (transientCredentialUpdates.has(account)) {
    Object.assign(account.credentials, values);
    account.updatedAt = Date.now();
    return true;
  }
  return updateAccounts(async () => {
    if (deletedAccountIds.has(account.id)) return false;
    const raw = await readSecureBlob(accountKey(account.id));
    let stored: CloudAccount | null = null;
    if (raw) {
      try {
        stored = normalizeStoredAccount(JSON.parse(raw));
      } catch {
        // A malformed stored value is replaced from the already validated in-memory account.
      }
    }
    if (stored && !hasSameCredentialSnapshot(account, stored)) {
      account.credentials = { ...stored.credentials };
      account.displayName = stored.displayName;
      account.createdAt = stored.createdAt;
      account.updatedAt = stored.updatedAt;
      return false;
    }
    const base = stored ?? account;
    const persisted = await persistAccountUnlocked({
      ...base,
      credentials: { ...base.credentials, ...values },
    });
    account.credentials = { ...persisted.credentials };
    account.displayName = persisted.displayName;
    account.createdAt = persisted.createdAt;
    account.updatedAt = persisted.updatedAt;
    return true;
  });
}

export async function saveDownloadResumeState(
  id: string,
  state: DownloadResumeState,
): Promise<void> {
  const normalized = normalizeDownloadResumeState(state);
  if (!normalized) throw new Error('下载暂停信息无效或已经过期');
  await writeSecureBlob(await downloadResumeKey(id), JSON.stringify(normalized));
  try {
    await updateResumeIndex(async () => {
      const ids = await readResumeIndex();
      if (!ids.includes(id)) await writeSecureBlob(DOWNLOAD_RESUME_INDEX_KEY, JSON.stringify([...ids, id]));
    });
  } catch {
    // The state itself is safely stored; the index only enables orphan cleanup.
  }
}

export async function loadDownloadResumeState(id: string): Promise<DownloadResumeState | null> {
  try {
    const raw = await readSecureBlob(await downloadResumeKey(id));
    if (!raw) return null;
    return normalizeDownloadResumeState(JSON.parse(raw)) ?? null;
  } catch {
    return null;
  }
}

export async function deleteDownloadResumeState(id: string): Promise<void> {
  await deleteSecureBlob(await downloadResumeKey(id));
  try {
    await updateResumeIndex(async () => {
      const ids = await readResumeIndex();
      if (ids.includes(id)) {
        await writeSecureBlob(DOWNLOAD_RESUME_INDEX_KEY, JSON.stringify(ids.filter((value) => value !== id)));
      }
    });
  } catch {
    // A stale index entry is harmless and will be retried during startup cleanup.
  }
}

export async function pruneDownloadResumeStates(validIds: string[]): Promise<void> {
  const valid = new Set(validIds);
  try {
    await updateResumeIndex(async () => {
      const ids = await readResumeIndex();
      const stale = ids.filter((id) => !valid.has(id));
      const deleted = await mapWithConcurrency(stale, 4, async (id) => {
        try {
          await deleteSecureBlob(await downloadResumeKey(id));
          return id;
        } catch {
          return null;
        }
      });
      const deletedIds = new Set(deleted.filter((id): id is string => id !== null));
      if (deletedIds.size) {
        await writeSecureBlob(
          DOWNLOAD_RESUME_INDEX_KEY,
          JSON.stringify(ids.filter((id) => !deletedIds.has(id))),
        );
      }
    });
  } catch {
    // Cleanup is best-effort; never hide accounts or downloads because of it.
  }
}

export function createAccount(providerId: ProviderId, displayName: string): CloudAccount {
  const now = Date.now();
  return {
    id: `${providerId}-${Crypto.randomUUID()}`,
    providerId,
    displayName,
    credentials: {},
    createdAt: now,
    updatedAt: now,
  };
}
