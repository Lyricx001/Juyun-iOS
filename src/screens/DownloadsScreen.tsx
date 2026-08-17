import { useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { EmptyState } from '../components/States';
import { providerDefinitions } from '../config/providers';
import { colors, radii } from '../config/theme';
import { useApp } from '../context/AppContext';
import { openNativePreview } from '../native/juyunNative';
import type { DownloadRecord, DownloadStatus } from '../types/cloud';
import { formatBytes, messageFromError } from '../utils/format';

const labels: Record<DownloadStatus, string> = {
  queued: '准备中',
  downloading: '下载中',
  paused: '已暂停',
  completed: '已完成',
  failed: '未完成',
};

function statusColor(status: DownloadStatus): string {
  if (status === 'completed') return colors.success;
  if (status === 'failed') return colors.danger;
  if (status === 'paused') return colors.warning;
  return colors.primary;
}

export function DownloadsScreen() {
  const {
    cancelDownload,
    clearDownloadHistory,
    deleteDownloadFile,
    downloads,
    pauseDownload,
    removeDownload,
    resumeDownload,
    shareDownload,
  } = useApp();
  const pendingIdsRef = useRef(new Set<string>());
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const hasHistory = downloads.some(
    (record) => record.status === 'completed' || record.status === 'failed',
  );

  async function perform(id: string, action: () => Promise<void>) {
    if (pendingIdsRef.current.has(id)) return;
    pendingIdsRef.current.add(id);
    setPendingIds(new Set(pendingIdsRef.current));
    try {
      await action();
    } catch (error) {
      Alert.alert('操作失败', messageFromError(error));
    } finally {
      pendingIdsRef.current.delete(id);
      setPendingIds(new Set(pendingIdsRef.current));
    }
  }

  function deleteLocalFile(record: DownloadRecord) {
    if (pendingIdsRef.current.has(record.id)) return;
    Alert.alert(
      '删除本机文件',
      `确定从聚云 Downloads 中永久删除“${record.name}”吗？此操作不会删除网盘中的原文件。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => void perform(record.id, () => deleteDownloadFile(record.id)),
        },
      ],
    );
  }

  function removeRecord(id: string) {
    if (pendingIdsRef.current.has(id)) return;
    removeDownload(id);
  }

  function clearHistory() {
    Alert.alert(
      '清理传输记录',
      '确定移除全部已完成和未完成记录吗？本机 Downloads 文件和网盘原文件都会保留。',
      [
        { text: '取消', style: 'cancel' },
        { text: '清理记录', style: 'destructive', onPress: clearDownloadHistory },
      ],
    );
  }

  function actions(record: DownloadRecord) {
    const pending = pendingIds.has(record.id);
    if (record.status === 'completed') {
      return (
        <>
          <Pressable
            disabled={pending}
            onPress={() => void perform(record.id, async () => {
              if (!record.localUri) throw new Error('本地文件不存在');
              await openNativePreview(record.localUri, record.name);
            })}
            style={[styles.actionButton, pending && styles.pendingAction]}
          >
            <Text style={styles.actionText}>预览</Text>
          </Pressable>
          <Pressable
            disabled={pending}
            onPress={() => void perform(record.id, () => shareDownload(record.id))}
            style={[styles.actionButton, pending && styles.pendingAction]}
          >
            <Text style={styles.actionText}>分享</Text>
          </Pressable>
          <Pressable
            disabled={pending}
            onPress={() => removeRecord(record.id)}
            style={[styles.minorButton, pending && styles.pendingAction]}
          >
            <Text style={styles.minorText}>移除记录</Text>
          </Pressable>
          <Pressable
            disabled={pending}
            onPress={() => deleteLocalFile(record)}
            style={[styles.minorButton, pending && styles.pendingAction]}
          >
            <Text style={styles.deleteText}>删除文件</Text>
          </Pressable>
        </>
      );
    }
    if (record.status === 'downloading') {
      return (
        <>
          <Pressable
            disabled={pending}
            onPress={() => void perform(record.id, () => pauseDownload(record.id))}
            style={[styles.actionButton, pending && styles.pendingAction]}
          >
            <Text style={styles.actionText}>暂停</Text>
          </Pressable>
          <Pressable onPress={() => cancelDownload(record.id)} style={styles.minorButton}>
            <Text style={styles.minorText}>取消</Text>
          </Pressable>
        </>
      );
    }
    if (record.status === 'queued') {
      return (
        <Pressable onPress={() => cancelDownload(record.id)} style={styles.minorButton}>
          <Text style={styles.minorText}>取消</Text>
        </Pressable>
      );
    }
    if (record.status === 'paused') {
      return (
        <>
          <Pressable
            disabled={pending}
            onPress={() => void perform(record.id, () => resumeDownload(record.id))}
            style={[styles.actionButton, pending && styles.pendingAction]}
          >
            <Text style={styles.actionText}>继续</Text>
          </Pressable>
          <Pressable onPress={() => cancelDownload(record.id)} style={styles.minorButton}>
            <Text style={styles.minorText}>取消</Text>
          </Pressable>
        </>
      );
    }
    return (
      <Pressable onPress={() => removeRecord(record.id)} style={styles.minorButton}>
        <Text style={styles.minorText}>移除记录</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>传输</Text>
          <Text style={styles.subtitle}>下载任务与已保存文件</Text>
        </View>
        {hasHistory && (
          <Pressable onPress={clearHistory} style={styles.clearButton}>
            <Text style={styles.clearText}>清理记录</Text>
          </Pressable>
        )}
      </View>
      {!downloads.length ? (
        <EmptyState icon="⇩" title="还没有下载" detail="在文件列表或播放器中点“下载”即可保存到本机" />
      ) : (
        <FlatList
          contentContainerStyle={styles.content}
          data={downloads}
          keyExtractor={(record) => record.id}
          renderItem={({ item: record }) => {
            const total = record.totalBytes || 0;
            const detail = total > 0
              ? `${formatBytes(record.bytesWritten)} / ${formatBytes(total)}`
              : formatBytes(record.bytesWritten);
            return (
              <View style={styles.card}>
                <View style={styles.cardHeader}>
                  <View style={[styles.statusDot, { backgroundColor: statusColor(record.status) }]} />
                  <Text numberOfLines={2} style={styles.name}>{record.name}</Text>
                  <Text style={[styles.status, { color: statusColor(record.status) }]}>{labels[record.status]}</Text>
                </View>
                <Text style={styles.provider}>{providerDefinitions[record.providerId].name}  ·  {detail}</Text>
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      { width: `${Math.max(0, Math.min(100, record.progress * 100))}%`, backgroundColor: statusColor(record.status) },
                    ]}
                  />
                </View>
                {!!record.error && <Text style={styles.error} numberOfLines={2}>{record.error}</Text>}
                <View style={styles.actions}>{actions(record)}</View>
              </View>
            );
          }}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: 18, paddingTop: 18, paddingBottom: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 28, fontWeight: '900' },
  subtitle: { color: colors.textMuted, fontSize: 12, marginTop: 5 },
  clearButton: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: radii.pill, backgroundColor: colors.surfaceElevated },
  clearText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  content: { paddingHorizontal: 16, paddingBottom: 28 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, padding: 15, marginBottom: 10 },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  name: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 20, fontWeight: '700' },
  status: { fontSize: 11, fontWeight: '800', marginTop: 3 },
  provider: { color: colors.textMuted, fontSize: 11, marginTop: 8, marginLeft: 17 },
  progressTrack: { height: 5, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.surfaceElevated, marginTop: 13 },
  progressFill: { height: '100%', borderRadius: 3 },
  error: { color: colors.danger, fontSize: 11, lineHeight: 16, marginTop: 9 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 15, marginTop: 13 },
  actionButton: { backgroundColor: colors.primarySoft, borderRadius: radii.pill, paddingHorizontal: 14, paddingVertical: 8 },
  pendingAction: { opacity: 0.45 },
  actionText: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  minorButton: { paddingVertical: 8 },
  minorText: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  deleteText: { color: colors.danger, fontSize: 12, fontWeight: '700' },
});
