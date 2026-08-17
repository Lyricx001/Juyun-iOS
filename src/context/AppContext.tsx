import * as Crypto from 'expo-crypto';
import { Directory, DownloadTask, File, Paths, type DownloadProgress } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { AppState } from 'react-native';
import { getProvider } from '../providers';
import {
  deleteDownloadResumeState,
  deleteAccount as deleteStoredAccount,
  loadDownloadResumeState,
  loadAccounts,
  pruneDownloadResumeStates,
  saveDownloadResumeState,
  saveAccount as saveStoredAccount,
} from '../storage/credentialStore';
import type { CloudAccount, CloudItem, DownloadRecord } from '../types/cloud';
import { mapWithConcurrency } from '../utils/async';
import {
  assertDownloadLink,
  DownloadRunRegistry,
  isExpectedDownloadFileSize,
  isSameLocalFileUri,
  limitDownloadHistory,
  normalizedLocalFilePath,
  orderDownloadJournalCandidates,
  parseDownloadMetadataText,
  reconcileDownloadProgress,
} from '../utils/downloads';
import { messageFromError, safeLocalFilename } from '../utils/format';

interface AppContextValue {
  accounts: CloudAccount[];
  accountsLoading: boolean;
  downloads: DownloadRecord[];
  saveAccount(account: CloudAccount): Promise<CloudAccount>;
  deleteAccount(id: string): Promise<void>;
  startDownload(account: CloudAccount, item: CloudItem): Promise<void>;
  pauseDownload(id: string): Promise<void>;
  resumeDownload(id: string): Promise<void>;
  cancelDownload(id: string): void;
  shareDownload(id: string): Promise<void>;
  deleteDownloadFile(id: string): Promise<void>;
  removeDownload(id: string): void;
  clearDownloadHistory(): void;
}

const AppContext = createContext<AppContextValue | null>(null);
const downloadDirectory = new Directory(Paths.document, 'Downloads');
const stateDirectory = new Directory(Paths.document, '.juyun');
const metadataFile = new File(stateDirectory, 'downloads.json');
const legacyMetadataFile = new File(Paths.document, 'juyun-downloads.json');
const MAX_ACTIVE_DOWNLOADS = 20;
const MAX_PENDING_DOWNLOADS = 100;
const MAX_DOWNLOAD_METADATA_BYTES = 10 * 1024 * 1024;

function downloadMetadataTempFile(): File {
  return new File(stateDirectory, 'downloads.json.tmp');
}

function downloadMetadataLastModified(file: File): number | null {
  try {
    return file.exists ? file.lastModified : null;
  } catch {
    return null;
  }
}

function ensureDownloadDirectory(): void {
  if (!downloadDirectory.exists) downloadDirectory.create({ intermediates: true, idempotent: true });
}

function deleteFileIfPresent(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // Cleanup is best-effort.
  }
}

async function readDownloadMetadata(): Promise<DownloadRecord[]> {
  const temporaryFile = downloadMetadataTempFile();
  const currentJournals = orderDownloadJournalCandidates([
    {
      value: temporaryFile,
      modifiedAt: downloadMetadataLastModified(temporaryFile),
      fallbackOrder: 1,
    },
    {
      value: metadataFile,
      modifiedAt: downloadMetadataLastModified(metadataFile),
      fallbackOrder: 0,
    },
  ]);
  for (const candidate of [...currentJournals, legacyMetadataFile]) {
    try {
      if (!candidate.exists) continue;
      if (!Number.isSafeInteger(candidate.size) || candidate.size > MAX_DOWNLOAD_METADATA_BYTES) {
        throw new Error('下载记录文件过大');
      }
      const records = parseDownloadMetadataText(await candidate.text());
      if (candidate.uri !== metadataFile.uri && persistDownloadMetadata(records)) {
        deleteFileIfPresent(candidate);
      } else if (candidate.uri === metadataFile.uri) {
        deleteFileIfPresent(downloadMetadataTempFile());
        deleteFileIfPresent(legacyMetadataFile);
      }
      return records;
    } catch {
      // Try the next journal, primary, or legacy candidate when this one is unreadable.
    }
  }
  return [];
}

function persistDownloadMetadata(records: DownloadRecord[]): boolean {
  try {
    if (!stateDirectory.exists) stateDirectory.create({ intermediates: true, idempotent: true });
    const temporaryFile = downloadMetadataTempFile();
    temporaryFile.create({ intermediates: true, overwrite: true });
    temporaryFile.write(JSON.stringify(records));
    temporaryFile.moveSync(metadataFile, { overwrite: true });
    return true;
  } catch {
    // Download metadata is helpful but not critical; downloaded files remain in Documents/Downloads.
    return false;
  }
}

function localFile(uri?: string): File | null {
  if (!uri) return null;
  try {
    return new File(uri);
  } catch {
    return null;
  }
}

function isManagedDownloadUri(uri?: string): uri is string {
  if (!uri) return false;
  const base = normalizedLocalFilePath(downloadDirectory.uri);
  const candidate = normalizedLocalFilePath(uri);
  return !!base && !!candidate && candidate.startsWith(`${base}/`);
}

function deleteManagedFile(uri?: string): void {
  if (!isManagedDownloadUri(uri)) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Cleanup is best-effort; a later retry or startup cleanup gets another chance.
  }
}

function releaseTask(task: DownloadTask): void {
  try {
    task.release();
  } catch {
    // The task may already have released itself after a terminal native state.
  }
}

function cancelTask(task: DownloadTask): void {
  try {
    task.cancel();
  } catch {
    // State reconciliation below still removes an unusable native task handle.
  }
}

function hydrateDownloadRecord(record: DownloadRecord): DownloadRecord {
  if (record.localUri && !isManagedDownloadUri(record.localUri)) {
    return {
      ...record,
      status: 'failed',
      progress: 0,
      localUri: undefined,
      resumeAvailable: false,
      error: '本机下载路径无效，请重新下载该文件',
    };
  }
  if (record.status === 'paused') {
    if (record.resumeAvailable) {
      return { ...record, error: undefined };
    }
    deleteManagedFile(record.localUri);
    return {
      ...record,
      status: 'failed',
      localUri: undefined,
      error: '暂停信息已失效，请从网盘重新下载',
      resumeAvailable: false,
    };
  }

  const file = localFile(record.localUri);
  if (record.status === 'completed') {
    if (file?.exists) {
      if (!isExpectedDownloadFileSize(record.totalBytes, file.size)) {
        deleteManagedFile(record.localUri);
        return {
          ...record,
          status: 'failed',
          progress: 0,
          bytesWritten: 0,
          localUri: undefined,
          error: '本机文件大小已变化，请重新下载',
        };
      }
      return {
        ...record,
        progress: 1,
        bytesWritten: file.size,
        totalBytes: file.size,
        error: undefined,
      };
    }
    return {
      ...record,
      status: 'failed',
      progress: 0,
      bytesWritten: 0,
      localUri: undefined,
      error: '本机文件已被移除',
    };
  }

  if (record.status === 'downloading' || record.status === 'queued') {
    if (file?.exists && record.totalBytes > 0 && file.size === record.totalBytes) {
      return {
        ...record,
        status: 'completed',
        progress: 1,
        bytesWritten: file.size,
        totalBytes: file.size,
        error: undefined,
      };
    }
    deleteManagedFile(record.localUri);
    return {
      ...record,
      status: 'failed',
      localUri: undefined,
      error: '应用退出时下载未完成，请从网盘重新下载',
      resumeAvailable: false,
    };
  }
  if (record.status === 'failed' && record.localUri) {
    deleteManagedFile(record.localUri);
    return { ...record, localUri: undefined };
  }
  return record;
}

async function hydrateDownloadRecords(records: DownloadRecord[]): Promise<DownloadRecord[]> {
  const hydrated = records.map(hydrateDownloadRecord);
  return mapWithConcurrency(hydrated, 4, async (record) => {
    if (record.status !== 'paused' || !record.resumeAvailable) return record;
    const state = await loadDownloadResumeState(record.id);
    if (
      state &&
      record.localUri &&
      isManagedDownloadUri(state.fileUri) &&
      isSameLocalFileUri(state.fileUri, record.localUri)
    ) return record;
    deleteManagedFile(record.localUri);
    return {
      ...record,
      status: 'failed',
      localUri: undefined,
      resumeAvailable: false,
      error: '暂停信息已失效，请从网盘重新下载',
    };
  });
}

export function AppProvider({ children }: PropsWithChildren) {
  const [accounts, setAccounts] = useState<CloudAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [downloadsHydrated, setDownloadsHydrated] = useState(false);
  const tasks = useRef(new Map<string, DownloadTask>());
  const taskExpirations = useRef(new Map<string, number>());
  const downloadRuns = useRef(new DownloadRunRegistry());
  const transitioningDownloads = useRef(new Set<string>());
  const cancelledDownloads = useRef(new Set<string>());
  const downloadsRef = useRef<DownloadRecord[]>([]);
  const metadataTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMetadataWrite = useRef(0);

  const mutateDownloads = useCallback((update: (current: DownloadRecord[]) => DownloadRecord[]) => {
    const next = limitDownloadHistory(update(downloadsRef.current));
    downloadsRef.current = next;
    setDownloads(next);
  }, []);

  const flushDownloadMetadata = useCallback(() => {
    if (metadataTimer.current) {
      clearTimeout(metadataTimer.current);
      metadataTimer.current = null;
    }
    persistDownloadMetadata(downloadsRef.current);
    lastMetadataWrite.current = Date.now();
  }, []);

  useEffect(() => {
    Promise.allSettled([loadAccounts(), readDownloadMetadata()])
      .then(async ([accountResult, downloadResult]) => {
        if (accountResult.status === 'fulfilled') setAccounts(accountResult.value);
        const storedDownloads = downloadResult.status === 'fulfilled'
          ? await hydrateDownloadRecords(downloadResult.value)
          : [];
        downloadsRef.current = storedDownloads;
        setDownloads(storedDownloads);
        void pruneDownloadResumeStates(
          storedDownloads
            .filter((record) => record.status === 'paused' && record.resumeAvailable)
            .map((record) => record.id),
        );
      })
      .finally(() => {
        setAccountsLoading(false);
        setDownloadsHydrated(true);
      });
  }, []);

  useEffect(() => {
    downloadsRef.current = downloads;
    if (!downloadsHydrated) return;
    const elapsed = Date.now() - lastMetadataWrite.current;
    if (elapsed >= 1000) {
      flushDownloadMetadata();
    } else if (!metadataTimer.current) {
      metadataTimer.current = setTimeout(flushDownloadMetadata, 1000 - elapsed);
    }
  }, [downloads, downloadsHydrated, flushDownloadMetadata]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (downloadsHydrated && state !== 'active') flushDownloadMetadata();
    });
    return () => {
      subscription.remove();
      if (downloadsHydrated) flushDownloadMetadata();
    };
  }, [downloadsHydrated, flushDownloadMetadata]);

  const saveAccount = useCallback(async (account: CloudAccount) => {
    const storedAccount = await saveStoredAccount(account);
    setAccounts((current) => {
      const index = current.findIndex((item) => item.id === storedAccount.id);
      if (index < 0) return [...current, storedAccount];
      const next = [...current];
      next[index] = storedAccount;
      return next;
    });
    return storedAccount;
  }, []);

  const deleteAccount = useCallback(async (id: string) => {
    await deleteStoredAccount(id);
    const related = downloadsRef.current.filter((record) => (
      record.accountId === id &&
      (record.status === 'queued' || record.status === 'downloading' || record.status === 'paused')
    ));
    for (const record of related) {
      const task = tasks.current.get(record.id);
      const wasPaused = task?.state === 'paused';
      if (task) cancelTask(task);
      else if (record.status === 'queued') cancelledDownloads.current.add(record.id);
      tasks.current.delete(record.id);
      taskExpirations.current.delete(record.id);
      downloadRuns.current.invalidate(record.id);
      if (task && wasPaused) releaseTask(task);
      deleteManagedFile(record.localUri);
    }
    void mapWithConcurrency(related, 4, async (record) => {
      await deleteDownloadResumeState(record.id).catch(() => undefined);
    });
    mutateDownloads((current) => current.map((record) => (
      record.accountId === id &&
      (record.status === 'queued' || record.status === 'downloading' || record.status === 'paused')
        ? {
            ...record,
            status: 'failed',
            localUri: undefined,
            resumeAvailable: false,
            error: '关联账号已删除，下载任务已停止',
          }
        : record
    )));
    setAccounts((current) => current.filter((account) => account.id !== id));
  }, [mutateDownloads]);

  const updateDownload = useCallback((id: string, patch: Partial<DownloadRecord>) => {
    mutateDownloads((current) =>
      current.map((record) => (record.id === id ? { ...record, ...patch } : record)),
    );
  }, [mutateDownloads]);

  const downloadProgress = useCallback(
    (id: string, { bytesWritten, totalBytes }: DownloadProgress) => {
      if (!tasks.current.has(id)) return;
      const current = downloadsRef.current.find((record) => record.id === id);
      if (!current || (current.status !== 'queued' && current.status !== 'downloading')) return;
      const progress = reconcileDownloadProgress(
        current.bytesWritten,
        current.totalBytes,
        bytesWritten,
        totalBytes,
      );
      updateDownload(id, {
        status: 'downloading',
        ...progress,
      });
    },
    [updateDownload],
  );

  const runDownload = useCallback(
    (
      id: string,
      task: DownloadTask,
      targetUri: string | undefined,
      operation: () => Promise<File | null>,
    ) => {
      const runLease = downloadRuns.current.begin(id, targetUri);
      const isCurrentRun = () => (
        tasks.current.get(id) === task && downloadRuns.current.isCurrent(id, runLease.token)
      );
      let execution: Promise<File | null>;
      try {
        execution = operation();
      } catch (error) {
        execution = Promise.reject(error);
      }
      void execution
        .then((output) => {
          if (!isCurrentRun()) {
            if (tasks.current.get(id) !== task) {
              if (output) deleteManagedFile(output.uri);
              releaseTask(task);
            }
            return;
          }
          if (!output) {
            if (task.state !== 'paused') {
              deleteManagedFile(targetUri);
              updateDownload(id, {
                status: 'failed',
                localUri: undefined,
                resumeAvailable: false,
                error: '下载任务意外中断，请重新下载该文件',
              });
              void deleteDownloadResumeState(id);
              tasks.current.delete(id);
              taskExpirations.current.delete(id);
              releaseTask(task);
            }
            return;
          }
          if (
            !isManagedDownloadUri(output.uri) ||
            !isSameLocalFileUri(output.uri, targetUri) ||
            !output.exists ||
            !Number.isSafeInteger(output.size) ||
            output.size < 0
          ) {
            throw new Error('系统下载器返回了无效的本机文件');
          }
          const expectedSize = downloadsRef.current.find((record) => record.id === id)?.totalBytes ?? 0;
          if (expectedSize > 0 && output.size !== expectedSize) {
            throw new Error(`下载文件大小不完整（应为 ${expectedSize} 字节，实际 ${output.size} 字节）`);
          }
          updateDownload(id, {
            status: 'completed',
            progress: 1,
            bytesWritten: output.size,
            totalBytes: output.size,
            localUri: output.uri,
            resumeAvailable: false,
            error: undefined,
          });
          void deleteDownloadResumeState(id);
          tasks.current.delete(id);
          taskExpirations.current.delete(id);
          releaseTask(task);
        })
        .catch((error) => {
          if (!isCurrentRun()) {
            if (tasks.current.get(id) !== task) {
              deleteManagedFile(targetUri);
              releaseTask(task);
            }
            return;
          }
          deleteManagedFile(targetUri);
          updateDownload(id, {
            status: 'failed',
            localUri: undefined,
            resumeAvailable: false,
            error: messageFromError(error),
          });
          void deleteDownloadResumeState(id);
          tasks.current.delete(id);
          taskExpirations.current.delete(id);
          releaseTask(task);
        })
        .finally(() => {
          downloadRuns.current.finish(id, runLease);
        });
    },
    [updateDownload],
  );

  const startDownload = useCallback(
    async (account: CloudAccount, item: CloudItem) => {
      const duplicate = downloadsRef.current.find(
        (record) =>
          record.accountId === account.id &&
          record.itemId === item.id &&
          (record.status === 'queued' || record.status === 'downloading' || record.status === 'paused'),
      );
      if (duplicate) throw new Error('这个文件已经在下载队列中');
      const pendingCount = downloadsRef.current.filter(
        (record) => (
          record.status === 'queued' ||
          record.status === 'downloading' ||
          record.status === 'paused'
        ),
      ).length;
      if (pendingCount >= MAX_PENDING_DOWNLOADS) {
        throw new Error(`最多保留 ${MAX_PENDING_DOWNLOADS} 个待完成任务，请继续或取消部分暂停任务后重试`);
      }
      const activeCount = downloadsRef.current.filter(
        (record) => record.status === 'queued' || record.status === 'downloading',
      ).length;
      if (activeCount >= MAX_ACTIVE_DOWNLOADS) {
        throw new Error(`同时最多进行 ${MAX_ACTIVE_DOWNLOADS} 个下载，请等待部分任务完成后重试`);
      }
      const id = Crypto.randomUUID();
      const record: DownloadRecord = {
        id,
        accountId: account.id,
        providerId: account.providerId,
        itemId: item.id,
        name: item.name,
        status: 'queued',
        progress: 0,
        bytesWritten: 0,
        totalBytes: item.size,
        createdAt: Date.now(),
      };
      mutateDownloads((current) => [record, ...current]);
      try {
        ensureDownloadDirectory();
        const link = assertDownloadLink(
          await getProvider(account.providerId).getDownloadLink(account, item),
        );
        if (link.expiresAt) taskExpirations.current.set(id, link.expiresAt);
        if (cancelledDownloads.current.has(id)) throw new Error('下载已取消');
        const safeName = safeLocalFilename(item.name);
        let target = new File(downloadDirectory, safeName);
        let collision = 0;
        const isReserved = () => {
          return (
            downloadRuns.current.isReserved(target.uri) ||
            downloadsRef.current.some(
              (value) => value.id !== id && isSameLocalFileUri(value.localUri, target.uri),
            )
          );
        };
        while (target.exists || isReserved()) {
          collision += 1;
          target = new File(
            downloadDirectory,
            safeLocalFilename(`${Date.now()}-${collision}-${safeName}`),
          );
        }
        updateDownload(id, { localUri: target.uri });
        const task = File.createDownloadTask(link.url, target, {
          headers: link.headers,
          sessionType: 'background',
          onProgress: (progress) => downloadProgress(id, progress),
        });
        tasks.current.set(id, task);
        updateDownload(id, { status: 'downloading' });
        runDownload(id, task, target.uri, () => task.downloadAsync());
      } catch (error) {
        taskExpirations.current.delete(id);
        if (cancelledDownloads.current.delete(id)) throw error;
        const failedRecord = downloadsRef.current.find((value) => value.id === id);
        deleteManagedFile(failedRecord?.localUri);
        updateDownload(id, {
          status: 'failed',
          localUri: undefined,
          resumeAvailable: false,
          error: messageFromError(error),
        });
        throw error;
      }
    },
    [downloadProgress, mutateDownloads, runDownload, updateDownload],
  );

  const pauseDownload = useCallback(
    async (id: string) => {
      if (transitioningDownloads.current.has(id)) throw new Error('任务操作正在进行中');
      const task = tasks.current.get(id);
      if (!task) throw new Error('下载任务已失效');
      transitioningDownloads.current.add(id);
      try {
        try {
          await task.pauseAsync();
        } catch (error) {
          if (tasks.current.get(id) !== task) return;
          throw error;
        }
        if (tasks.current.get(id) !== task) return;
        updateDownload(id, {
          status: 'paused',
          resumeAvailable: false,
          error: undefined,
        });
        const state = task.savable();
        if (!state.resumeData) {
          tasks.current.delete(id);
          taskExpirations.current.delete(id);
          downloadRuns.current.invalidate(id);
          cancelTask(task);
          releaseTask(task);
          const record = downloadsRef.current.find((value) => value.id === id);
          deleteManagedFile(record?.localUri);
          updateDownload(id, {
            status: 'failed',
            localUri: undefined,
            resumeAvailable: false,
            error: '下载源不支持断点恢复，请重新下载该文件',
          });
          throw new Error('下载源不支持断点恢复，请重新下载该文件');
        }
        const record = downloadsRef.current.find((value) => value.id === id);
        if (
          !record?.localUri ||
          !isManagedDownloadUri(state.fileUri) ||
          !isSameLocalFileUri(state.fileUri, record.localUri)
        ) {
          tasks.current.delete(id);
          taskExpirations.current.delete(id);
          downloadRuns.current.invalidate(id);
          cancelTask(task);
          releaseTask(task);
          deleteManagedFile(record?.localUri);
          updateDownload(id, {
            status: 'failed',
            localUri: undefined,
            resumeAvailable: false,
            error: '下载暂停信息与本机目标不一致，请重新下载该文件',
          });
          void deleteDownloadResumeState(id);
          throw new Error('下载暂停信息与本机目标不一致，请重新下载该文件');
        }
        try {
          const expiresAt = taskExpirations.current.get(id);
          await saveDownloadResumeState(id, {
            ...state,
            ...(expiresAt ? { expiresAt } : {}),
          });
          if (tasks.current.get(id) !== task) {
            await deleteDownloadResumeState(id).catch(() => undefined);
            return;
          }
          updateDownload(id, { resumeAvailable: true });
        } catch (error) {
          if (tasks.current.get(id) !== task) return;
          updateDownload(id, { error: '任务已暂停，但无法保存重启恢复信息' });
          throw error;
        }
      } finally {
        transitioningDownloads.current.delete(id);
      }
    },
    [updateDownload],
  );

  const resumeDownload = useCallback(
    async (id: string) => {
      if (transitioningDownloads.current.has(id)) throw new Error('任务操作正在进行中');
      const activeCount = downloadsRef.current.filter(
        (record) => record.id !== id && (record.status === 'queued' || record.status === 'downloading'),
      ).length;
      if (activeCount >= MAX_ACTIVE_DOWNLOADS) {
        throw new Error(`同时最多进行 ${MAX_ACTIVE_DOWNLOADS} 个下载，请等待部分任务完成后重试`);
      }
      transitioningDownloads.current.add(id);
      try {
        let task = tasks.current.get(id);
        if (!task) {
          const record = downloadsRef.current.find((value) => value.id === id);
          if (!record?.resumeAvailable) {
            deleteManagedFile(record?.localUri);
            updateDownload(id, {
              status: 'failed',
              localUri: undefined,
              resumeAvailable: false,
              error: '暂停信息已失效，请重新下载该文件',
            });
            throw new Error('暂停信息已失效，请重新下载该文件');
          }
          const savedState = await loadDownloadResumeState(id);
          if (!savedState) {
            deleteManagedFile(record.localUri);
            updateDownload(id, {
              status: 'failed',
              localUri: undefined,
              resumeAvailable: false,
              error: '无法读取暂停信息，请重新下载该文件',
            });
            throw new Error('无法读取暂停信息，请重新下载该文件');
          }
          const currentRecord = downloadsRef.current.find((value) => value.id === id);
          if (currentRecord?.status !== 'paused' || !currentRecord.resumeAvailable) {
            await deleteDownloadResumeState(id).catch(() => undefined);
            return;
          }
          if (
            !currentRecord.localUri ||
            !isManagedDownloadUri(savedState.fileUri) ||
            !isSameLocalFileUri(savedState.fileUri, currentRecord.localUri)
          ) {
            deleteManagedFile(currentRecord.localUri);
            updateDownload(id, {
              status: 'failed',
              localUri: undefined,
              resumeAvailable: false,
              error: '暂停信息与本机下载文件不匹配，请重新下载该文件',
            });
            await deleteDownloadResumeState(id).catch(() => undefined);
            throw new Error('暂停信息与本机下载文件不匹配，请重新下载该文件');
          }
          try {
            const { expiresAt, ...taskState } = savedState;
            task = DownloadTask.fromSavable(taskState, {
              sessionType: 'background',
              onProgress: (progress) => downloadProgress(id, progress),
            });
            if (expiresAt) taskExpirations.current.set(id, expiresAt);
          } catch (error) {
            deleteManagedFile(currentRecord.localUri);
            updateDownload(id, {
              status: 'failed',
              localUri: undefined,
              resumeAvailable: false,
              error: '暂停信息已损坏，请重新下载该文件',
            });
            void deleteDownloadResumeState(id);
            throw error;
          }
          tasks.current.set(id, task);
        }
        const expiresAt = taskExpirations.current.get(id);
        if (expiresAt && expiresAt <= Date.now()) {
          const record = downloadsRef.current.find((value) => value.id === id);
          const wasPaused = task.state === 'paused';
          tasks.current.delete(id);
          taskExpirations.current.delete(id);
          downloadRuns.current.invalidate(id);
          cancelTask(task);
          if (wasPaused) releaseTask(task);
          deleteManagedFile(record?.localUri);
          updateDownload(id, {
            status: 'failed',
            localUri: undefined,
            resumeAvailable: false,
            error: '下载地址已过期，请从网盘重新下载该文件',
          });
          void deleteDownloadResumeState(id);
          throw new Error('下载地址已过期，请从网盘重新下载该文件');
        }
        await deleteDownloadResumeState(id).catch(() => undefined);
        if (tasks.current.get(id) !== task) return;
        updateDownload(id, { status: 'downloading', resumeAvailable: false, error: undefined });
        const record = downloadsRef.current.find((value) => value.id === id);
        runDownload(id, task, record?.localUri, () => task.resumeAsync());
      } finally {
        transitioningDownloads.current.delete(id);
      }
    },
    [downloadProgress, runDownload, updateDownload],
  );

  const cancelDownload = useCallback(
    (id: string) => {
      const task = tasks.current.get(id);
      const wasPaused = task?.state === 'paused';
      const record = downloadsRef.current.find((value) => value.id === id);
      if (
        !task &&
        record &&
        record.status !== 'queued' &&
        record.status !== 'downloading' &&
        record.status !== 'paused'
      ) {
        return;
      }
      if (!task && record?.status === 'queued') cancelledDownloads.current.add(id);
      if (task) cancelTask(task);
      tasks.current.delete(id);
      taskExpirations.current.delete(id);
      downloadRuns.current.invalidate(id);
      if (task && wasPaused) releaseTask(task);
      if (record?.status !== 'completed') deleteManagedFile(record?.localUri);
      void deleteDownloadResumeState(id);
      updateDownload(id, {
        status: 'failed',
        localUri: undefined,
        resumeAvailable: false,
        error: '已取消',
      });
    },
    [updateDownload],
  );

  const shareDownload = useCallback(async (id: string) => {
    const record = downloadsRef.current.find((value) => value.id === id);
    if (record?.status !== 'completed') throw new Error('文件尚未下载完成');
    if (!record?.localUri || !isManagedDownloadUri(record.localUri)) {
      throw new Error('本地文件不存在');
    }
    const file = localFile(record.localUri);
    if (!file?.exists) throw new Error('本地文件已被移除');
    if (!(await Sharing.isAvailableAsync())) throw new Error('当前设备不支持系统分享');
    await Sharing.shareAsync(record.localUri);
  }, []);

  const deleteDownloadFile = useCallback(async (id: string) => {
    const record = downloadsRef.current.find((value) => value.id === id);
    if (record?.status !== 'completed') throw new Error('文件尚未下载完成');
    if (!record?.localUri || !isManagedDownloadUri(record.localUri)) {
      throw new Error('本地文件不存在');
    }
    const file = localFile(record.localUri);
    if (!file?.exists) throw new Error('本地文件已被移除，可改用“移除记录”清理列表');
    file.delete();
    await deleteDownloadResumeState(id).catch(() => undefined);
    mutateDownloads((current) => current.filter((value) => value.id !== id));
  }, [mutateDownloads]);

  const removeDownload = useCallback((id: string) => {
    const task = tasks.current.get(id);
    const record = downloadsRef.current.find((value) => value.id === id);
    if (task) {
      const wasPaused = task.state === 'paused';
      cancelTask(task);
      tasks.current.delete(id);
      taskExpirations.current.delete(id);
      downloadRuns.current.invalidate(id);
      if (wasPaused) releaseTask(task);
    } else if (record?.status === 'queued') {
      cancelledDownloads.current.add(id);
    }
    taskExpirations.current.delete(id);
    if (record?.status !== 'completed') deleteManagedFile(record?.localUri);
    void deleteDownloadResumeState(id);
    mutateDownloads((current) => current.filter((record) => record.id !== id));
  }, [mutateDownloads]);

  const clearDownloadHistory = useCallback(() => {
    const history = downloadsRef.current.filter(
      (record) => record.status === 'completed' || record.status === 'failed',
    );
    for (const record of history) {
      taskExpirations.current.delete(record.id);
    }
    void mapWithConcurrency(history, 4, async (record) => {
      await deleteDownloadResumeState(record.id).catch(() => undefined);
    });
    mutateDownloads((current) => current.filter(
      (record) => record.status !== 'completed' && record.status !== 'failed',
    ));
  }, [mutateDownloads]);

  const value = useMemo<AppContextValue>(
    () => ({
      accounts,
      accountsLoading,
      downloads,
      saveAccount,
      deleteAccount,
      startDownload,
      pauseDownload,
      resumeDownload,
      cancelDownload,
      shareDownload,
      deleteDownloadFile,
      removeDownload,
      clearDownloadHistory,
    }),
    [
      accounts,
      accountsLoading,
      cancelDownload,
      clearDownloadHistory,
      deleteDownloadFile,
      deleteAccount,
      downloads,
      pauseDownload,
      removeDownload,
      resumeDownload,
      saveAccount,
      shareDownload,
      startDownload,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider');
  return value;
}
