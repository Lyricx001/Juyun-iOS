import { File } from 'expo-file-system';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ActionSheet, type SheetAction } from '../components/ActionSheet';
import { FileRow } from '../components/FileRow';
import { FolderPickerModal } from '../components/FolderPickerModal';
import { OperationProgressModal } from '../components/OperationProgressModal';
import { ScreenHeader } from '../components/ScreenHeader';
import { EmptyState, LoadingState } from '../components/States';
import { TextInputDialog } from '../components/TextInputDialog';
import { providerDefinitions } from '../config/providers';
import { colors, radii } from '../config/theme';
import { useApp } from '../context/AppContext';
import { getProvider } from '../providers';
import type { CloudAccount, CloudFolder, CloudItem, UploadProgress } from '../types/cloud';
import { getAccountRoot } from '../utils/account';
import {
  cloudNameError,
  epochMilliseconds,
  fileTypeLabel,
  formatBytes,
  formatDate,
  messageFromError,
} from '../utils/format';
import { isItemAlreadyInFolder, uniqueCloudItems } from '../utils/providerData';

interface Props {
  account: CloudAccount;
  onBack(): void;
  onPreview(item: CloudItem): void;
}

type SortField = 'name' | 'date' | 'size';
type PromptState = { kind: 'folder' } | { kind: 'rename'; item: CloudItem } | null;
type DestinationAction = 'move' | 'copy' | null;

interface BusyState {
  visible: boolean;
  title: string;
  detail?: string;
  bytesDone?: number;
  totalBytes?: number;
}

const sortLabels: Record<SortField, string> = { name: '名称', date: '日期', size: '大小' };
const MAX_SEARCH_LENGTH = 200;
const MAX_BATCH_DOWNLOADS = 20;
const MAX_BATCH_CLOUD_ITEMS = 100;
const MAX_BATCH_UPLOADS = 100;

export function FileBrowserScreen({ account, onBack, onPreview }: Props) {
  const { startDownload } = useApp();
  const provider = useMemo(() => getProvider(account.providerId), [account.providerId]);
  const definition = providerDefinitions[account.providerId];
  const [folders, setFolders] = useState<CloudFolder[]>([getAccountRoot(account)]);
  const [items, setItems] = useState<CloudItem[]>([]);
  const [remoteItems, setRemoteItems] = useState<CloudItem[] | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [remoteSearching, setRemoteSearching] = useState(false);
  const [error, setError] = useState('');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortAscending, setSortAscending] = useState(true);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sheetItems, setSheetItems] = useState<CloudItem[] | null>(null);
  const [sortSheetVisible, setSortSheetVisible] = useState(false);
  const [prompt, setPrompt] = useState<PromptState>(null);
  const [destinationAction, setDestinationAction] = useState<DestinationAction>(null);
  const [destinationTargets, setDestinationTargets] = useState<CloudItem[]>([]);
  const [busy, setBusy] = useState<BusyState>({ visible: false, title: '' });
  const loadRequestId = useRef(0);
  const searchRequestId = useRef(0);
  const operationInProgress = useRef(false);
  const currentFolder = folders.at(-1) ?? getAccountRoot(account);

  const load = useCallback(
    async (showRefresh = false) => {
      const requestId = ++loadRequestId.current;
      showRefresh ? setRefreshing(true) : setLoading(true);
      setError('');
      try {
        const loadedItems = await provider.list(account, currentFolder);
        if (requestId === loadRequestId.current) setItems(uniqueCloudItems(loadedItems));
      } catch (loadError) {
        if (requestId === loadRequestId.current) setError(messageFromError(loadError));
      } finally {
        if (requestId === loadRequestId.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [account, currentFolder, provider],
  );

  useEffect(() => {
    setQuery('');
    setRemoteItems(null);
    setRemoteSearching(false);
    setSelectedIds(new Set());
    setSelectionMode(false);
    void load();
    return () => {
      loadRequestId.current += 1;
      searchRequestId.current += 1;
    };
  }, [load]);

  const sourceItems = remoteItems ?? items;
  const visibleItems = useMemo(() => {
    const keyword = remoteItems ? '' : query.trim().toLocaleLowerCase('zh-CN');
    const filtered = keyword
      ? sourceItems.filter((item) => item.name.toLocaleLowerCase('zh-CN').includes(keyword))
      : sourceItems;
    return [...filtered].sort((left, right) => {
      if (left.isFolder !== right.isFolder) return left.isFolder ? -1 : 1;
      let result = 0;
      if (sortField === 'name') {
        result = left.name.localeCompare(right.name, 'zh-CN', { numeric: true });
      } else if (sortField === 'size') {
        result = left.size - right.size;
      } else {
        result = (left.modifiedAt || left.createdAt || 0) - (right.modifiedAt || right.createdAt || 0);
      }
      return sortAscending ? result : -result;
    });
  }, [query, remoteItems, sortAscending, sortField, sourceItems]);

  const selectedItems = useMemo(
    () => sourceItems.filter((item) => selectedIds.has(item.id)),
    [selectedIds, sourceItems],
  );
  const excludedFolderIds = useMemo(
    () => destinationTargets.filter((item) => item.isFolder).map((item) => item.id),
    [destinationTargets],
  );

  function closeSelection() {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }

  function goBack() {
    if (selectionMode) {
      closeSelection();
      return;
    }
    if (remoteItems) {
      clearSearch();
      return;
    }
    if (folders.length === 1) onBack();
    else setFolders((current) => current.slice(0, -1));
  }

  function toggleItem(item: CloudItem) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }

  function openItem(item: CloudItem) {
    if (selectionMode) {
      toggleItem(item);
      return;
    }
    if (item.isFolder) {
      const folder = { id: item.id, name: item.name, path: item.path };
      if (remoteItems) setFolders([getAccountRoot(account), folder]);
      else setFolders((current) => [...current, folder]);
      return;
    }
    onPreview(item);
  }

  function beginSelection(item?: CloudItem) {
    setSelectionMode(true);
    setSelectedIds(item ? new Set([item.id]) : new Set());
  }

  async function refreshCurrent() {
    if (remoteItems && query.trim()) await searchDrive();
    else await load(true);
  }

  async function searchDrive() {
    const keyword = query.trim();
    if (!keyword || !provider.capabilities.search || !provider.search) return;
    if (keyword.length > MAX_SEARCH_LENGTH) {
      Alert.alert('搜索内容过长', `请把关键词控制在 ${MAX_SEARCH_LENGTH} 个字符以内。`);
      return;
    }
    const requestId = ++searchRequestId.current;
    setRemoteSearching(true);
    setError('');
    try {
      const results = await provider.search(account, keyword, { limit: 200 });
      if (requestId === searchRequestId.current) {
        setRemoteItems(uniqueCloudItems(results));
        closeSelection();
      }
    } catch (searchError) {
      if (requestId === searchRequestId.current) {
        Alert.alert('全盘搜索失败', messageFromError(searchError));
      }
    } finally {
      if (requestId === searchRequestId.current) setRemoteSearching(false);
    }
  }

  function updateQuery(value: string) {
    searchRequestId.current += 1;
    setRemoteSearching(false);
    setQuery(value);
    if (remoteItems) setRemoteItems(null);
  }

  function clearSearch() {
    searchRequestId.current += 1;
    setRemoteSearching(false);
    setQuery('');
    setRemoteItems(null);
  }

  async function queueDownloads(targets: CloudItem[]) {
    if (operationInProgress.current) return;
    const files = targets.filter((item) => !item.isFolder);
    if (!files.length) {
      Alert.alert('没有可下载的文件', '文件夹不能直接下载，请进入文件夹后选择文件。');
      return;
    }
    if (files.length > MAX_BATCH_DOWNLOADS) {
      Alert.alert('选择文件过多', `单次最多加入 ${MAX_BATCH_DOWNLOADS} 个下载，请分批选择。`);
      return;
    }
    operationInProgress.current = true;
    let queued = 0;
    const failures: string[] = [];
    setBusy({ visible: true, title: `正在加入下载 1 / ${files.length}` });
    try {
      for (let index = 0; index < files.length; index += 1) {
        const item = files[index];
        if (!item) continue;
        setBusy({
          visible: true,
          title: `正在加入下载 ${index + 1} / ${files.length}`,
          detail: item.name,
        });
        try {
          await startDownload(account, item);
          queued += 1;
        } catch (downloadError) {
          failures.push(`${item.name}：${messageFromError(downloadError)}`);
        }
      }
    } finally {
      operationInProgress.current = false;
      setBusy({ visible: false, title: '' });
    }
    if (queued) closeSelection();
    if (failures.length) {
      Alert.alert(
        queued ? '部分文件已加入下载' : '无法加入下载',
        `${queued} 个成功，${failures.length} 个失败。\n${failures.slice(0, 3).join('\n')}`,
      );
    } else {
      Alert.alert('已加入下载', `${queued} 个文件已加入“传输”页。`);
    }
  }

  async function runOperation(title: string, detail: string, operation: () => Promise<void>) {
    if (operationInProgress.current) return;
    operationInProgress.current = true;
    setBusy({ visible: true, title, detail });
    try {
      await operation();
      setBusy({ visible: false, title: '' });
      setRemoteItems(null);
      setDestinationTargets([]);
      closeSelection();
      await load();
    } catch (operationError) {
      setBusy({ visible: false, title: '' });
      setRemoteItems(null);
      setDestinationTargets([]);
      await load(true);
      Alert.alert('操作失败', messageFromError(operationError));
    } finally {
      operationInProgress.current = false;
    }
  }

  async function uploadFiles() {
    if (!provider.upload || operationInProgress.current) return;
    operationInProgress.current = true;
    try {
      const picked = await File.pickFileAsync({ multipleFiles: true, mimeTypes: '*/*' });
      if (picked.canceled) return;
      const files = picked.result;
      if (files.length > MAX_BATCH_UPLOADS) {
        Alert.alert('选择文件过多', `单次最多上传 ${MAX_BATCH_UPLOADS} 个文件，请分批选择。`);
        return;
      }
      let completed = 0;
      const failures: string[] = [];
      for (const file of files) {
        setBusy({
          visible: true,
          title: `上传 ${completed + failures.length + 1} / ${files.length}`,
          detail: file.name,
          bytesDone: 0,
          totalBytes: file.size,
        });
        try {
          const source = {
            uri: file.uri,
            name: file.name,
            size: file.size,
            mimeType: file.type || undefined,
            createdAt: epochMilliseconds(file.creationTime),
            modifiedAt: epochMilliseconds(file.lastModified),
          };
          await provider.upload(
            account,
            currentFolder,
            source,
            (progress: UploadProgress) => setBusy({
              visible: true,
              title: `上传 ${completed + failures.length + 1} / ${files.length}`,
              detail: progress.phase ? `${file.name}\n${progress.phase}` : file.name,
              bytesDone: progress.bytesSent,
              totalBytes: progress.totalBytes || file.size,
            }),
          );
          completed += 1;
        } catch (uploadError) {
          failures.push(`${file.name}：${messageFromError(uploadError)}`);
        }
      }
      setBusy({ visible: false, title: '' });
      await load();
      if (failures.length) {
        Alert.alert(
          completed ? '批量上传部分完成' : '上传失败',
          `${completed} 个成功，${failures.length} 个失败。\n${failures.slice(0, 3).join('\n')}`,
        );
      } else {
        Alert.alert('上传完成', `${completed} 个文件已上传到“${currentFolder.name}”。`);
      }
    } catch (uploadError) {
      setBusy({ visible: false, title: '' });
      Alert.alert('上传失败', messageFromError(uploadError));
      await load();
    } finally {
      operationInProgress.current = false;
      setBusy({ visible: false, title: '' });
    }
  }

  function confirmPrompt(value: string) {
    const activePrompt = prompt;
    const normalizedName = value.trim();
    const validationError = cloudNameError(normalizedName);
    if (validationError) {
      Alert.alert('名称不可用', validationError);
      return;
    }
    setPrompt(null);
    if (activePrompt?.kind === 'rename' && activePrompt.item.name === normalizedName) return;
    if (activePrompt?.kind === 'folder' && provider.createFolder) {
      void runOperation('正在新建文件夹', normalizedName, () => provider.createFolder!(account, currentFolder, normalizedName));
    } else if (activePrompt?.kind === 'rename' && provider.rename) {
      void runOperation('正在重命名', activePrompt.item.name, () => provider.rename!(account, activePrompt.item, normalizedName));
    }
  }

  function deleteItems(targets: CloudItem[]) {
    if (!provider.delete) return;
    if (targets.length > MAX_BATCH_CLOUD_ITEMS) {
      Alert.alert('选择项目过多', `单次最多删除 ${MAX_BATCH_CLOUD_ITEMS} 项，请分批操作。`);
      return;
    }
    const first = targets[0];
    if (!first) return;
    Alert.alert(
      '确认删除',
      targets.length === 1
        ? `确定删除“${first.name}”吗？网盘可能会将其移入回收站。`
        : `确定删除选中的 ${targets.length} 项吗？网盘可能会将其移入回收站。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => void runOperation('正在删除', `${targets.length} 项`, () => provider.delete!(account, targets)),
        },
      ],
    );
  }

  function showInfo(item: CloudItem) {
    const lines = [
      `类型：${item.isFolder ? '文件夹' : fileTypeLabel(item.name, item.mimeType)}`,
      !item.isFolder ? `大小：${formatBytes(item.size)}` : '',
      item.modifiedAt ? `修改时间：${formatDate(item.modifiedAt)}` : '',
      item.createdAt ? `创建时间：${formatDate(item.createdAt)}` : '',
      item.path ? `路径：${item.path}` : '',
      `文件 ID：${item.id}`,
    ].filter(Boolean);
    Alert.alert(item.name, lines.join('\n'));
  }

  const fileActions = useMemo<SheetAction[]>(() => {
    if (!sheetItems?.length) return [];
    const single = sheetItems.length === 1 ? sheetItems[0] : null;
    const actions: SheetAction[] = [];
    if (single && !single.isFolder) actions.push({ id: 'preview', label: '预览文件' });
    if (sheetItems.some((item) => !item.isFolder)) actions.push({ id: 'download', label: '下载到本机' });
    if (single && provider.capabilities.rename) actions.push({ id: 'rename', label: '重命名' });
    if (provider.capabilities.move) actions.push({ id: 'move', label: '移动到…' });
    if (provider.capabilities.copy) actions.push({ id: 'copy', label: '复制到…' });
    if (single) actions.push({ id: 'info', label: '文件详情' });
    if (provider.capabilities.delete) actions.push({ id: 'delete', label: '删除', destructive: true });
    return actions;
  }, [provider.capabilities, sheetItems]);

  function selectFileAction(action: SheetAction) {
    const targets = sheetItems ?? [];
    const single = targets.length === 1 ? targets[0] : null;
    setSheetItems(null);
    if (action.id === 'preview' && single) onPreview(single);
    else if (action.id === 'download') void queueDownloads(targets);
    else if (action.id === 'rename' && single) setPrompt({ kind: 'rename', item: single });
    else if (action.id === 'move') {
      setDestinationTargets(targets);
      setDestinationAction('move');
    } else if (action.id === 'copy') {
      setDestinationTargets(targets);
      setDestinationAction('copy');
    }
    else if (action.id === 'delete') deleteItems(targets);
    else if (action.id === 'info' && single) showInfo(single);
  }

  function chooseDestination(destination: CloudFolder) {
    const action = destinationAction;
    setDestinationAction(null);
    const targets = destinationTargets;
    const actionableTargets = targets.filter((item) => !isItemAlreadyInFolder(item, destination));
    if (actionableTargets.length > MAX_BATCH_CLOUD_ITEMS) {
      setDestinationTargets([]);
      Alert.alert('选择项目过多', `单次最多操作 ${MAX_BATCH_CLOUD_ITEMS} 项，请分批选择。`);
      return;
    }
    if ((action === 'move' || action === 'copy') && !actionableTargets.length) {
      setDestinationTargets([]);
      Alert.alert(
        action === 'copy' ? '无法复制' : '无需移动',
        action === 'copy' ? '不能复制到项目原来所在的文件夹。' : '所选项目已经在这个文件夹中。',
      );
      return;
    }
    if (action === 'move' && provider.move) {
      void runOperation('正在移动', `${actionableTargets.length} 项 → ${destination.name}`, () => provider.move!(account, actionableTargets, destination));
    } else if (action === 'copy' && provider.copy) {
      void runOperation('正在复制', `${actionableTargets.length} 项 → ${destination.name}`, () => provider.copy!(account, actionableTargets, destination));
    }
  }

  function cancelDestination() {
    setDestinationAction(null);
    setDestinationTargets([]);
  }

  function openSheetFor(targets: CloudItem[]) {
    if (!selectionMode) setSelectedIds(new Set(targets.map((item) => item.id)));
    setSheetItems(targets);
  }

  const sortActions: SheetAction[] = (['name', 'date', 'size'] as SortField[]).flatMap((field) => [
    { id: `${field}-asc`, label: `${sortLabels[field]} · 升序` },
    { id: `${field}-desc`, label: `${sortLabels[field]} · 降序` },
  ]);

  function selectSort(action: SheetAction) {
    const [field, direction] = action.id.split('-') as [SortField, 'asc' | 'desc'];
    setSortField(field);
    setSortAscending(direction === 'asc');
    setSortSheetVisible(false);
  }

  const breadcrumb = remoteItems
    ? `“${query.trim()}”的全盘搜索结果`
    : folders.map((folder) => folder.name).join(' / ');
  const promptTitle = prompt?.kind === 'rename' ? '重命名' : '新建文件夹';
  const promptInitial = prompt?.kind === 'rename' ? prompt.item.name : '';

  return (
    <View style={styles.root}>
      <ScreenHeader
        title={selectionMode ? `已选择 ${selectedItems.length} 项` : currentFolder.name}
        subtitle={`${definition.name} · ${account.displayName}`}
        onBack={goBack}
        actionLabel={selectionMode ? '完成' : '刷新'}
        onAction={selectionMode ? closeSelection : () => void refreshCurrent()}
      />

      <View style={styles.searchWrap}>
        <Text style={styles.searchIcon}>⌕</Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={MAX_SEARCH_LENGTH}
          onChangeText={updateQuery}
          onSubmitEditing={() => void searchDrive()}
          placeholder="筛选当前文件夹"
          placeholderTextColor={colors.textMuted}
          returnKeyType={provider.capabilities.search ? 'search' : 'done'}
          style={styles.searchInput}
          value={query}
        />
        {!!query && provider.capabilities.search && (
          <Pressable disabled={remoteSearching} onPress={() => void searchDrive()} style={styles.driveSearchButton}>
            <Text style={styles.driveSearchText}>{remoteSearching ? '搜索中' : '全盘'}</Text>
          </Pressable>
        )}
        {!!query && (
          <Pressable onPress={clearSearch}>
            <Text style={styles.clear}>×</Text>
          </Pressable>
        )}
      </View>

      <ScrollView contentContainerStyle={styles.toolbar} horizontal showsHorizontalScrollIndicator={false}>
        {provider.capabilities.upload && (
          <Pressable onPress={() => void uploadFiles()} style={styles.toolChip}>
            <Text style={styles.toolIcon}>↑</Text><Text style={styles.toolText}>上传</Text>
          </Pressable>
        )}
        {provider.capabilities.createFolder && (
          <Pressable onPress={() => setPrompt({ kind: 'folder' })} style={styles.toolChip}>
            <Text style={styles.toolIcon}>＋</Text><Text style={styles.toolText}>新建文件夹</Text>
          </Pressable>
        )}
        <Pressable onPress={() => beginSelection()} style={styles.toolChip}>
          <Text style={styles.toolIcon}>✓</Text><Text style={styles.toolText}>多选</Text>
        </Pressable>
        <Pressable onPress={() => setSortSheetVisible(true)} style={styles.toolChip}>
          <Text style={styles.toolIcon}>⇅</Text><Text style={styles.toolText}>{sortLabels[sortField]} {sortAscending ? '↑' : '↓'}</Text>
        </Pressable>
      </ScrollView>

      <Text numberOfLines={1} style={styles.breadcrumb}>{breadcrumb}</Text>

      {loading ? (
        <LoadingState label="正在读取文件…" />
      ) : error ? (
        <EmptyState icon="!" title="读取失败" detail={error} actionLabel="重新加载" onAction={() => void load()} />
      ) : (
        <FlatList
          contentContainerStyle={visibleItems.length ? [styles.list, selectionMode && styles.listWithSelection] : styles.emptyList}
          data={visibleItems}
          keyExtractor={(item) => `${item.id}-${item.parentId}`}
          ListEmptyComponent={
            <EmptyState
              icon={query ? '⌕' : '☁'}
              title={query ? '没有匹配的文件' : '这个文件夹是空的'}
              detail={remoteItems ? '换个关键词试试' : query ? '可以点“全盘”搜索整个网盘' : '可从上方上传文件或新建文件夹'}
            />
          }
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refreshCurrent()} tintColor={colors.primary} />}
          renderItem={({ item }) => (
            <FileRow
              item={item}
              onLongPress={() => selectionMode ? toggleItem(item) : beginSelection(item)}
              onMore={() => openSheetFor([item])}
              onOpen={() => openItem(item)}
              selected={selectedIds.has(item.id)}
              selectionMode={selectionMode}
            />
          )}
          showsVerticalScrollIndicator={false}
        />
      )}

      {selectionMode && (
        <View style={styles.selectionBar}>
          <Pressable
            onPress={() => setSelectedIds(
              visibleItems.length > 0 && visibleItems.every((item) => selectedIds.has(item.id))
                ? new Set()
                : new Set(visibleItems.map((item) => item.id)),
            )}
            style={styles.selectionAction}
          >
            <Text style={styles.selectionIcon}>✓</Text><Text style={styles.selectionText}>全选</Text>
          </Pressable>
          <Pressable
            disabled={!selectedItems.some((item) => !item.isFolder)}
            onPress={() => void queueDownloads(selectedItems)}
            style={[styles.selectionAction, !selectedItems.some((item) => !item.isFolder) && styles.disabledAction]}
          >
            <Text style={styles.selectionIcon}>⇩</Text><Text style={styles.selectionText}>下载</Text>
          </Pressable>
          <Pressable
            disabled={!selectedItems.length || !provider.capabilities.move}
            onPress={() => {
              setDestinationTargets(selectedItems);
              setDestinationAction('move');
            }}
            style={[styles.selectionAction, (!selectedItems.length || !provider.capabilities.move) && styles.disabledAction]}
          >
            <Text style={styles.selectionIcon}>↗</Text><Text style={styles.selectionText}>移动</Text>
          </Pressable>
          <Pressable
            disabled={!selectedItems.length}
            onPress={() => openSheetFor(selectedItems)}
            style={[styles.selectionAction, !selectedItems.length && styles.disabledAction]}
          >
            <Text style={styles.selectionIcon}>•••</Text><Text style={styles.selectionText}>更多</Text>
          </Pressable>
        </View>
      )}

      <ActionSheet actions={fileActions} onCancel={() => setSheetItems(null)} onSelect={selectFileAction} title={sheetItems?.length === 1 ? sheetItems[0]?.name ?? '文件操作' : `已选择 ${sheetItems?.length ?? 0} 项`} visible={!!sheetItems} />
      <ActionSheet actions={sortActions} onCancel={() => setSortSheetVisible(false)} onSelect={selectSort} title="文件排序" visible={sortSheetVisible} />
      <TextInputDialog confirmLabel={prompt?.kind === 'rename' ? '保存' : '新建'} initialValue={promptInitial} onCancel={() => setPrompt(null)} onConfirm={confirmPrompt} placeholder={prompt?.kind === 'rename' ? '输入新名称' : '输入文件夹名称'} title={promptTitle} visible={!!prompt} />
      <FolderPickerModal account={account} excludedIds={excludedFolderIds} onCancel={cancelDestination} onChoose={chooseDestination} title={destinationAction === 'copy' ? '复制到' : '移动到'} visible={!!destinationAction} />
      <OperationProgressModal {...busy} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  searchWrap: {
    minHeight: 48,
    marginHorizontal: 16,
    marginTop: 4,
    paddingHorizontal: 13,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  searchIcon: { color: colors.textMuted, fontSize: 22 },
  searchInput: { flex: 1, minWidth: 40, color: colors.text, fontSize: 14, paddingVertical: 10 },
  driveSearchButton: { paddingHorizontal: 8, paddingVertical: 7, borderRadius: radii.pill, backgroundColor: colors.primarySoft },
  driveSearchText: { color: colors.primary, fontSize: 11, fontWeight: '800' },
  clear: { color: colors.textMuted, fontSize: 25, lineHeight: 28, paddingLeft: 3 },
  toolbar: { paddingHorizontal: 16, paddingTop: 10, gap: 8 },
  toolChip: {
    height: 36,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceElevated,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  toolIcon: { color: colors.primary, fontSize: 15, fontWeight: '900' },
  toolText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  breadcrumb: { color: colors.textMuted, fontSize: 11, marginHorizontal: 18, marginVertical: 10 },
  list: { paddingBottom: 30 },
  listWithSelection: { paddingBottom: 100 },
  emptyList: { flexGrow: 1 },
  selectionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: 78,
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 12,
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  selectionAction: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 },
  disabledAction: { opacity: 0.35 },
  selectionIcon: { color: colors.primary, fontSize: 20, lineHeight: 23, fontWeight: '900' },
  selectionText: { color: colors.text, fontSize: 11, fontWeight: '700' },
});
