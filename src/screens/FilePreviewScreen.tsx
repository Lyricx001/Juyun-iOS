import * as Crypto from 'expo-crypto';
import { Directory, File, Paths, type DownloadTask } from 'expo-file-system';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { AppButton } from '../components/Buttons';
import { ScreenHeader } from '../components/ScreenHeader';
import { EmptyState, LoadingState } from '../components/States';
import { providerDefinitions } from '../config/providers';
import { colors, radii } from '../config/theme';
import { useApp } from '../context/AppContext';
import { openNativePreview } from '../native/juyunNative';
import { getProvider } from '../providers';
import type { CloudAccount, CloudItem, DownloadLink } from '../types/cloud';
import {
  assertDownloadLink,
  isSameLocalFileUri,
  reconcileDownloadProgress,
} from '../utils/downloads';
import {
  fileTypeLabel,
  fileExtension,
  formatBytes,
  messageFromError,
  previewKind,
  safeLocalFilename,
} from '../utils/format';
import { VideoPlayerScreen } from './VideoPlayerScreen';

interface Props {
  account: CloudAccount;
  item: CloudItem;
  onBack(): void;
}

function useDownloadLink(account: CloudAccount, item: CloudItem) {
  const [link, setLink] = useState<DownloadLink | null>(null);
  const [error, setError] = useState('');
  const requestIdRef = useRef(0);
  const reload = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setLink(null);
    setError('');
    getProvider(account.providerId)
      .getDownloadLink(account, item)
      .then((value) => {
        if (requestId === requestIdRef.current) setLink(assertDownloadLink(value));
      })
      .catch((loadError) => {
        if (requestId === requestIdRef.current) setError(messageFromError(loadError));
      });
  }, [account, item]);

  useEffect(() => {
    reload();
    return () => {
      requestIdRef.current += 1;
    };
  }, [reload]);
  return { link, error, reload };
}

const PREVIEW_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const PREVIEW_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const UNVERSIONED_PREVIEW_MAX_AGE = 15 * 60 * 1000;
const PREVIEW_PART_MAX_AGE = 60 * 60 * 1000;
const PREVIEW_FILE_MAX_BYTES = PREVIEW_CACHE_MAX_BYTES;
const PREVIEW_CACHE_VERSION = '2';
const PREVIEW_PART_PREFIX = '.juyun-preview-part-';

function isPreviewPartial(file: File): boolean {
  return file.name.startsWith(PREVIEW_PART_PREFIX);
}

function prunePreviewCache(directory: Directory, protectedUri: string): void {
  try {
    const now = Date.now();
    const files = directory.list().filter((entry): entry is File => entry instanceof File);
    for (const file of files) {
      const maxAge = isPreviewPartial(file) ? PREVIEW_PART_MAX_AGE : PREVIEW_CACHE_MAX_AGE;
      if (file.lastModified && now - file.lastModified > maxAge) {
        file.delete();
      }
    }
    const remaining = directory
      .list()
      .filter((entry): entry is File => entry instanceof File);
    let total = remaining.reduce((sum, file) => sum + file.size, 0);
    const removable = remaining
      .filter((file) => file.uri !== protectedUri && !isPreviewPartial(file))
      .sort((left, right) => (left.lastModified ?? 0) - (right.lastModified ?? 0));
    for (const file of removable) {
      if (total <= PREVIEW_CACHE_MAX_BYTES) break;
      const size = file.size;
      file.delete();
      total -= size;
    }
  } catch {
    // Cache cleanup is best-effort and must never block a preview.
  }
}

function cancelPreviewTask(task: DownloadTask | null): void {
  try {
    task?.cancel();
  } catch {
    // A terminal native task may already be unavailable.
  }
}

function releasePreviewTask(task: DownloadTask | null): void {
  try {
    task?.release();
  } catch {
    // Releasing an already released task is harmless for preview cleanup.
  }
}

function deletePartialPreview(file: File | null): void {
  try {
    if (file?.exists) file.delete();
  } catch {
    // The next cache cleanup can retry.
  }
}

function PreviewFooter({ account, item }: Pick<Props, 'account' | 'item'>) {
  const { startDownload } = useApp();
  async function download() {
    try {
      await startDownload(account, item);
      Alert.alert('已加入下载', '可在“下载”页查看进度，完成后可通过系统分享打开。');
    } catch (error) {
      Alert.alert('无法下载', messageFromError(error));
    }
  }
  return (
    <View style={styles.footer}>
      <Text numberOfLines={3} style={styles.name}>{item.name}</Text>
      <Text style={styles.meta}>
        {providerDefinitions[account.providerId].name}  ·  {fileTypeLabel(item.name, item.mimeType)}  ·  {formatBytes(item.size)}
      </Text>
      <AppButton label="下载到本机" onPress={() => void download()} variant="secondary" />
    </View>
  );
}

function ImagePreviewScreen({ account, item, onBack }: Props) {
  const { width, height } = useWindowDimensions();
  const { link, error, reload } = useDownloadLink(account, item);
  const [imageError, setImageError] = useState('');
  const [loaded, setLoaded] = useState(false);

  if (error) {
    return (
      <View style={styles.root}>
        <ScreenHeader title="图片预览" onBack={onBack} />
        <EmptyState icon="!" title="无法获取图片" detail={error} actionLabel="重试" onAction={() => reload()} />
      </View>
    );
  }
  if (!link) {
    return <View style={styles.root}><ScreenHeader title="图片预览" onBack={onBack} /><LoadingState label="正在获取原图…" /></View>;
  }
  return (
    <View style={styles.root}>
      <ScreenHeader title="图片预览" subtitle="双指缩放" onBack={onBack} />
      <View style={styles.imageStage}>
        {!loaded && !imageError && <View style={styles.centerOverlay}><LoadingState label="正在载入图片…" /></View>}
        {imageError ? (
          <EmptyState icon="!" title="图片加载失败" detail={imageError} actionLabel="重新加载" onAction={() => { setImageError(''); setLoaded(false); reload(); }} />
        ) : (
          <ScrollView
            centerContent
            contentContainerStyle={styles.imageScroll}
            maximumZoomScale={5}
            minimumZoomScale={1}
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
          >
            <Image
              onError={(event) => setImageError(event.nativeEvent.error || '下载地址可能已过期')}
              onLoad={() => setLoaded(true)}
              resizeMode="contain"
              source={{ uri: link.url, headers: link.headers }}
              style={{ width, height: Math.max(280, height * 0.55) }}
            />
          </ScrollView>
        )}
      </View>
      <PreviewFooter account={account} item={item} />
    </View>
  );
}

function NativePreviewScreen({ account, item, onBack }: Props) {
  const { startDownload } = useApp();
  const taskRef = useRef<DownloadTask | null>(null);
  const prepareRequestId = useRef(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [detail, setDetail] = useState('正在获取下载地址…');
  const [progress, setProgress] = useState({ done: 0, total: item.size });
  const [localUri, setLocalUri] = useState('');
  const kind = previewKind(item.name, item.mimeType);

  const prepare = useCallback(async () => {
    const requestId = ++prepareRequestId.current;
    cancelPreviewTask(taskRef.current);
    taskRef.current = null;
    setStatus('loading');
    setDetail('正在获取下载地址…');
    setProgress({ done: 0, total: item.size });
    setLocalUri('');
    let activeTask: DownloadTask | null = null;
    let partialTarget: File | null = null;
    let transferComplete = false;
    let previewLimitExceeded = false;
    try {
      if (item.size > PREVIEW_FILE_MAX_BYTES) {
        previewLimitExceeded = true;
        throw new Error(`系统预览文件不能超过 ${formatBytes(PREVIEW_FILE_MAX_BYTES)}，请改用下载到本机`);
      }
      const directory = new Directory(Paths.cache, 'JuyunPreviews');
      if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
      const identity = [
        PREVIEW_CACHE_VERSION,
        account.providerId,
        account.id,
        item.id,
        item.size,
        item.modifiedAt ?? item.createdAt ?? 0,
      ].join('\u0000');
      const cacheKey = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        identity,
      );
      if (requestId !== prepareRequestId.current) return;
      const safeName = safeLocalFilename(item.name, 120);
      const extension = fileExtension(safeName).slice(0, 16);
      const baseName = extension ? safeName.slice(0, -(extension.length + 1)) : safeName;
      const compactName = `${baseName.slice(0, 45)}${extension ? `.${extension}` : ''}`;
      const target = new File(
        directory,
        `${cacheKey.slice(0, 32)}-${compactName}`,
      );
      prunePreviewCache(directory, target.uri);
      if (target.exists && target.size > PREVIEW_FILE_MAX_BYTES) {
        target.delete();
        previewLimitExceeded = true;
        throw new Error(`系统预览文件不能超过 ${formatBytes(PREVIEW_FILE_MAX_BYTES)}，请改用下载到本机`);
      }
      const hasRemoteVersion = !!(item.modifiedAt || item.createdAt);
      if (
        target.exists &&
        !hasRemoteVersion &&
        (!target.lastModified || Date.now() - target.lastModified > UNVERSIONED_PREVIEW_MAX_AGE)
      ) {
        target.delete();
      }
      if (!target.exists || (item.size > 0 && target.size !== item.size)) {
        if (target.exists) target.delete();
        const link = assertDownloadLink(
          await getProvider(account.providerId).getDownloadLink(account, item),
        );
        if (requestId !== prepareRequestId.current) return;
        setDetail('正在下载临时预览文件…');
        const temporaryTarget = new File(
          directory,
          `${PREVIEW_PART_PREFIX}${cacheKey.slice(0, 16)}-${Crypto.randomUUID()}`,
        );
        deletePartialPreview(temporaryTarget);
        const task = File.createDownloadTask(link.url, temporaryTarget, {
          headers: link.headers,
          sessionType: 'foreground',
          onProgress: ({ bytesWritten, totalBytes }) => {
            if (bytesWritten > PREVIEW_FILE_MAX_BYTES || totalBytes > PREVIEW_FILE_MAX_BYTES) {
              previewLimitExceeded = true;
              cancelPreviewTask(activeTask);
              return;
            }
            if (requestId === prepareRequestId.current) {
              setProgress((current) => {
                const progress = reconcileDownloadProgress(
                  current.done,
                  current.total,
                  bytesWritten,
                  totalBytes,
                );
                return { done: progress.bytesWritten, total: progress.totalBytes };
              });
            }
          },
        });
        activeTask = task;
        partialTarget = temporaryTarget;
        taskRef.current = task;
        const output = await task.downloadAsync();
        if (previewLimitExceeded) {
          throw new Error(`系统预览文件不能超过 ${formatBytes(PREVIEW_FILE_MAX_BYTES)}，请改用下载到本机`);
        }
        if (
          !output ||
          !isSameLocalFileUri(output.uri, temporaryTarget.uri) ||
          !temporaryTarget.exists
        ) {
          throw new Error('临时预览文件下载已中断');
        }
        if (temporaryTarget.size > PREVIEW_FILE_MAX_BYTES) {
          previewLimitExceeded = true;
          throw new Error(`系统预览文件不能超过 ${formatBytes(PREVIEW_FILE_MAX_BYTES)}，请改用下载到本机`);
        }
        if (item.size > 0 && temporaryTarget.size !== item.size) {
          throw new Error(`临时预览文件大小不完整（应为 ${item.size} 字节，实际 ${temporaryTarget.size} 字节）`);
        }
        if (requestId !== prepareRequestId.current) {
          deletePartialPreview(temporaryTarget);
          releasePreviewTask(task);
          activeTask = null;
          if (taskRef.current === task) taskRef.current = null;
          return;
        }
        temporaryTarget.moveSync(target, { overwrite: true });
        partialTarget = null;
        transferComplete = true;
        releasePreviewTask(task);
        activeTask = null;
        if (taskRef.current === task) taskRef.current = null;
        prunePreviewCache(directory, target.uri);
      }
      if (requestId !== prepareRequestId.current) return;
      setLocalUri(target.uri);
      setProgress({ done: target.size, total: target.size });
      setStatus('ready');
      setDetail('已准备好 iOS 系统预览');
      await openNativePreview(target.uri, item.name);
    } catch (error) {
      releasePreviewTask(activeTask);
      if (!transferComplete) deletePartialPreview(partialTarget);
      if (taskRef.current === activeTask) taskRef.current = null;
      if (requestId === prepareRequestId.current) {
        setStatus('error');
        setDetail(previewLimitExceeded
          ? `系统预览文件不能超过 ${formatBytes(PREVIEW_FILE_MAX_BYTES)}，请改用下载到本机`
          : messageFromError(error));
      }
    }
  }, [account, item]);

  useEffect(() => {
    void prepare();
    return () => {
      prepareRequestId.current += 1;
      cancelPreviewTask(taskRef.current);
      taskRef.current = null;
    };
  }, [prepare]);

  async function openAgain() {
    try {
      if (!localUri) throw new Error('预览文件还没有准备好');
      await openNativePreview(localUri, item.name);
    } catch (error) {
      Alert.alert('无法预览', messageFromError(error));
    }
  }

  async function download() {
    try {
      await startDownload(account, item);
      Alert.alert('已加入下载', '文件会保存到聚云 Downloads，可在“下载”页查看进度。');
    } catch (error) {
      Alert.alert('无法下载', messageFromError(error));
    }
  }

  const ratio = progress.total > 0 ? Math.max(0, Math.min(1, progress.done / progress.total)) : 0;
  return (
    <View style={styles.root}>
      <ScreenHeader title={`${fileTypeLabel(item.name, item.mimeType)}预览`} subtitle="iOS Quick Look" onBack={onBack} />
      <View style={styles.nativeBody}>
        <View style={styles.fileBadge}>
          <Text style={styles.fileBadgeText}>{kind === 'archive' ? 'ZIP' : kind === 'text' ? 'TXT' : kind === 'document' ? 'DOC' : 'FILE'}</Text>
        </View>
        <Text numberOfLines={3} style={styles.nativeName}>{item.name}</Text>
        <Text style={styles.nativeDetail}>{detail}</Text>
        {status === 'loading' && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${ratio * 100}%` }]} />
          </View>
        )}
        <Text style={styles.nativeMeta}>{formatBytes(progress.done)}{progress.total > 0 ? ` / ${formatBytes(progress.total)}` : ''}</Text>
        {status === 'error' ? (
          <AppButton label="重新准备预览" onPress={() => void prepare()} />
        ) : status === 'ready' ? (
          <AppButton label="再次打开系统预览" onPress={() => void openAgain()} />
        ) : (
          <View style={styles.loadingButton}><Text style={styles.loadingButtonText}>正在准备…</Text></View>
        )}
        <AppButton label="下载到本机" onPress={() => void download()} variant="secondary" style={styles.secondaryButton} />
        <Text style={styles.previewNote}>PDF、Office、iWork、文本、压缩包等由 iOS 系统预览；预览文件只缓存在本机，不会经过第三方服务器。</Text>
      </View>
    </View>
  );
}

export function FilePreviewScreen(props: Props) {
  const kind = useMemo(() => previewKind(props.item.name, props.item.mimeType), [props.item]);
  if (kind === 'video' || kind === 'audio') return <VideoPlayerScreen {...props} />;
  if (kind === 'image') return <ImagePreviewScreen {...props} />;
  return <NativePreviewScreen {...props} />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  imageStage: { flex: 1, minHeight: 280, backgroundColor: colors.black },
  imageScroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  centerOverlay: { ...StyleSheet.absoluteFill, zIndex: 2, backgroundColor: colors.black },
  footer: { padding: 18, gap: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  name: { color: colors.text, fontSize: 17, lineHeight: 23, fontWeight: '800' },
  meta: { color: colors.textMuted, fontSize: 11, marginTop: -5 },
  nativeBody: { flex: 1, alignItems: 'center', paddingHorizontal: 24, paddingTop: 42 },
  fileBadge: {
    width: 96,
    height: 118,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileBadgeText: { color: colors.primary, fontSize: 21, fontWeight: '900' },
  nativeName: { color: colors.text, fontSize: 18, lineHeight: 25, fontWeight: '800', textAlign: 'center', marginTop: 22 },
  nativeDetail: { color: colors.textMuted, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 8 },
  progressTrack: { width: '100%', height: 6, marginTop: 22, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.surfaceElevated },
  progressFill: { height: '100%', backgroundColor: colors.primary },
  nativeMeta: { color: colors.textMuted, fontSize: 11, marginVertical: 10 },
  loadingButton: { width: '100%', minHeight: 48, borderRadius: radii.md, backgroundColor: colors.surfaceElevated, alignItems: 'center', justifyContent: 'center', opacity: 0.55 },
  loadingButtonText: { color: colors.textMuted, fontSize: 15, fontWeight: '700' },
  secondaryButton: { width: '100%', marginTop: 10 },
  previewNote: { color: colors.textMuted, fontSize: 11, lineHeight: 17, textAlign: 'center', marginTop: 18 },
});
