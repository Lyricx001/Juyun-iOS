import { useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radii } from '../config/theme';
import type { CloudItem } from '../types/cloud';
import { fileTypeLabel, formatBytes, formatDate, previewKind } from '../utils/format';

interface Props {
  item: CloudItem;
  onOpen(): void;
  onLongPress?(): void;
  onMore?(): void;
  selected?: boolean;
  selectionMode?: boolean;
}

function fileIcon(item: CloudItem): string {
  if (item.isFolder) return '▰';
  const icons = {
    video: '▶',
    audio: '♫',
    image: '▧',
    text: 'TXT',
    document: 'DOC',
    archive: 'ZIP',
    other: '◆',
  } as const;
  return icons[previewKind(item.name, item.mimeType)];
}

export function FileRow({
  item,
  onOpen,
  onLongPress,
  onMore,
  selected = false,
  selectionMode = false,
}: Props) {
  const suppressPress = useRef(false);
  return (
    <Pressable
      delayLongPress={350}
      onLongPress={() => {
        suppressPress.current = true;
        onLongPress?.();
      }}
      onPress={() => {
        if (suppressPress.current) {
          suppressPress.current = false;
          return;
        }
        onOpen();
      }}
      onPressOut={() => {
        if (suppressPress.current) {
          setTimeout(() => { suppressPress.current = false; }, 100);
        }
      }}
      style={({ pressed }) => [
        styles.container,
        selected && styles.selectedContainer,
        pressed && styles.pressed,
      ]}
    >
      {selectionMode && (
        <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
          <Text style={styles.checkmark}>{selected ? '✓' : ''}</Text>
        </View>
      )}
      <View style={[styles.icon, item.isFolder && styles.folderIcon]}>
        <Text style={styles.iconText}>{fileIcon(item)}</Text>
      </View>
      <View style={styles.copy}>
        <Text numberOfLines={2} style={styles.name}>{item.name}</Text>
        <Text style={styles.meta}>
          {item.isFolder ? '文件夹' : `${fileTypeLabel(item.name, item.mimeType)}  ·  ${formatBytes(item.size)}`}
          {item.modifiedAt ? `  ·  ${formatDate(item.modifiedAt)}` : ''}
        </Text>
      </View>
      {!selectionMode && onMore && (
        <Pressable
          accessibilityLabel={`${item.name}的更多操作`}
          onPress={(event) => {
            event.stopPropagation();
            onMore();
          }}
          style={styles.action}
        >
          <Text style={styles.actionText}>•••</Text>
        </Pressable>
      )}
      {!selectionMode && <Text style={styles.chevron}>›</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: 76,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  selectedContainer: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  pressed: { opacity: 0.72 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxSelected: { borderColor: colors.primary, backgroundColor: colors.primary },
  checkmark: { color: colors.white, fontSize: 13, fontWeight: '900' },
  icon: {
    width: 44,
    height: 44,
    borderRadius: 13,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  folderIcon: { backgroundColor: '#3A2F13' },
  iconText: { color: colors.text, fontWeight: '800', fontSize: 14 },
  copy: { flex: 1, minWidth: 0, paddingVertical: 12 },
  name: { color: colors.text, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  meta: { color: colors.textMuted, fontSize: 12, marginTop: 5 },
  action: {
    minWidth: 38,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceElevated,
  },
  actionText: { color: colors.primary, fontSize: 13, fontWeight: '900', letterSpacing: 1 },
  chevron: { color: colors.textMuted, fontSize: 28, marginLeft: -4 },
});
