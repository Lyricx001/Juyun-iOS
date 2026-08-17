import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radii } from '../config/theme';

export interface SheetAction {
  id: string;
  label: string;
  detail?: string;
  destructive?: boolean;
  disabled?: boolean;
}

interface Props {
  visible: boolean;
  title: string;
  actions: SheetAction[];
  onCancel(): void;
  onSelect(action: SheetAction): void;
}

export function ActionSheet({ visible, title, actions, onCancel, onSelect }: Props) {
  return (
    <Modal animationType="slide" onRequestClose={onCancel} transparent visible={visible}>
      <View style={styles.backdrop}>
        <Pressable onPress={onCancel} style={StyleSheet.absoluteFill} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text numberOfLines={2} style={styles.title}>{title}</Text>
          <ScrollView style={styles.list}>
            {actions.map((action) => (
              <Pressable
                disabled={action.disabled}
                key={action.id}
                onPress={() => onSelect(action)}
                style={({ pressed }) => [
                  styles.row,
                  pressed && styles.pressed,
                  action.disabled && styles.disabled,
                ]}
              >
                <View style={styles.copy}>
                  <Text style={[styles.label, action.destructive && styles.destructive]}>{action.label}</Text>
                  {!!action.detail && <Text style={styles.detail}>{action.detail}</Text>}
                </View>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            ))}
          </ScrollView>
          <Pressable onPress={onCancel} style={styles.cancel}>
            <Text style={styles.cancelText}>取消</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.54)' },
  sheet: {
    maxHeight: '82%',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 26,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    backgroundColor: colors.surface,
  },
  handle: { width: 40, height: 5, borderRadius: 3, backgroundColor: colors.border, alignSelf: 'center' },
  title: { color: colors.text, fontSize: 17, lineHeight: 23, fontWeight: '800', marginVertical: 15 },
  list: { flexGrow: 0 },
  row: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingVertical: 10,
  },
  copy: { flex: 1, minWidth: 0 },
  label: { color: colors.text, fontSize: 15, fontWeight: '700' },
  detail: { color: colors.textMuted, fontSize: 11, lineHeight: 16, marginTop: 3 },
  destructive: { color: colors.danger },
  chevron: { color: colors.textMuted, fontSize: 24 },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.35 },
  cancel: {
    minHeight: 48,
    marginTop: 12,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceElevated,
  },
  cancelText: { color: colors.text, fontSize: 15, fontWeight: '800' },
});
