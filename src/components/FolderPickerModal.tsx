import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, radii } from '../config/theme';
import { getProvider } from '../providers';
import type { CloudAccount, CloudFolder, CloudItem } from '../types/cloud';
import { getAccountRoot } from '../utils/account';
import { messageFromError } from '../utils/format';
import { uniqueCloudItems } from '../utils/providerData';
import { EmptyState, LoadingState } from './States';

interface Props {
  visible: boolean;
  account: CloudAccount;
  title: string;
  confirmLabel?: string;
  excludedIds?: string[];
  onCancel(): void;
  onChoose(folder: CloudFolder): void;
}

export function FolderPickerModal({
  visible,
  account,
  title,
  confirmLabel = '选择这里',
  excludedIds = [],
  onCancel,
  onChoose,
}: Props) {
  const provider = useMemo(() => getProvider(account.providerId), [account.providerId]);
  const [stack, setStack] = useState<CloudFolder[]>([getAccountRoot(account)]);
  const [folders, setFolders] = useState<CloudItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const requestIdRef = useRef(0);
  const current = stack.at(-1) ?? getAccountRoot(account);

  const load = useCallback(async (refresh = false) => {
    const requestId = ++requestIdRef.current;
    refresh ? setRefreshing(true) : setLoading(true);
    setError('');
    try {
      const values = await provider.list(account, current);
      if (requestId === requestIdRef.current) {
        setFolders(
          uniqueCloudItems(values)
            .filter((item) => item.isFolder && !excludedIds.includes(item.id))
            .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true })),
        );
      }
    } catch (loadError) {
      if (requestId === requestIdRef.current) setError(messageFromError(loadError));
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [account, current, excludedIds, provider]);

  useEffect(() => {
    if (!visible) return;
    setStack([getAccountRoot(account)]);
  }, [account, visible]);

  useEffect(() => {
    if (visible) void load();
    return () => {
      requestIdRef.current += 1;
    };
  }, [load, visible]);

  function back() {
    if (stack.length === 1) onCancel();
    else setStack((value) => value.slice(0, -1));
  }

  return (
    <Modal animationType="slide" onRequestClose={onCancel} visible={visible}>
      <View style={styles.root}>
        <View style={styles.header}>
          <Pressable onPress={back} style={styles.headerButton}><Text style={styles.back}>‹</Text></Pressable>
          <View style={styles.headerCopy}>
            <Text numberOfLines={1} style={styles.title}>{title}</Text>
            <Text numberOfLines={1} style={styles.path}>{stack.map((folder) => folder.name).join(' / ')}</Text>
          </View>
          <Pressable onPress={() => onChoose(current)} style={styles.chooseButton}>
            <Text style={styles.chooseText}>{confirmLabel}</Text>
          </Pressable>
        </View>

        {loading ? (
          <LoadingState label="正在读取文件夹…" />
        ) : error ? (
          <EmptyState icon="!" title="无法读取文件夹" detail={error} actionLabel="重试" onAction={() => void load()} />
        ) : (
          <FlatList
            contentContainerStyle={folders.length ? styles.list : styles.empty}
            data={folders}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<EmptyState icon="▰" title="没有子文件夹" detail="可以直接选择当前文件夹" />}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={colors.primary} />}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => setStack((value) => [...value, { id: item.id, name: item.name, path: item.path }])}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <View style={styles.icon}><Text style={styles.iconText}>▰</Text></View>
                <Text numberOfLines={2} style={styles.name}>{item.name}</Text>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            )}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 54, backgroundColor: colors.background },
  header: { minHeight: 68, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceElevated },
  back: { color: colors.text, fontSize: 34, lineHeight: 36, marginTop: -3 },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 18, fontWeight: '800' },
  path: { color: colors.textMuted, fontSize: 11, marginTop: 3 },
  chooseButton: { minHeight: 38, justifyContent: 'center', paddingHorizontal: 8 },
  chooseText: { color: colors.primary, fontSize: 14, fontWeight: '800' },
  list: { padding: 16, paddingBottom: 34 },
  empty: { flexGrow: 1 },
  row: {
    minHeight: 66,
    marginBottom: 8,
    paddingHorizontal: 12,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#3A2F13' },
  iconText: { color: colors.warning, fontSize: 16, fontWeight: '900' },
  name: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 19, fontWeight: '700' },
  chevron: { color: colors.textMuted, fontSize: 26 },
  pressed: { opacity: 0.68 },
});
