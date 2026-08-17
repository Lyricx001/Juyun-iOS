import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { colors, radii } from '../config/theme';

interface Props {
  visible: boolean;
  title: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  onCancel(): void;
  onConfirm(value: string): void;
}

export function TextInputDialog({
  visible,
  title,
  initialValue = '',
  placeholder,
  confirmLabel = '确定',
  onCancel,
  onConfirm,
}: Props) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [initialValue, visible]);

  const trimmed = value.trim();
  return (
    <Modal animationType="fade" onRequestClose={onCancel} transparent visible={visible}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.backdrop}
      >
        <Pressable onPress={onCancel} style={StyleSheet.absoluteFill} />
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          <TextInput
            autoFocus
            maxLength={240}
            onChangeText={setValue}
            onSubmitEditing={() => trimmed && onConfirm(trimmed)}
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
            returnKeyType="done"
            selectTextOnFocus
            style={styles.input}
            value={value}
          />
          <View style={styles.actions}>
            <Pressable onPress={onCancel} style={styles.button}>
              <Text style={styles.cancelText}>取消</Text>
            </Pressable>
            <Pressable
              disabled={!trimmed}
              onPress={() => onConfirm(trimmed)}
              style={[styles.button, !trimmed && styles.disabled]}
            >
              <Text style={styles.confirmText}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.68)',
  },
  card: {
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 18,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '800' },
  input: {
    minHeight: 48,
    marginTop: 16,
    paddingHorizontal: 13,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceElevated,
    color: colors.text,
    fontSize: 15,
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 18, marginTop: 16 },
  button: { paddingHorizontal: 4, paddingVertical: 8 },
  cancelText: { color: colors.textMuted, fontSize: 14, fontWeight: '700' },
  confirmText: { color: colors.primary, fontSize: 14, fontWeight: '800' },
  disabled: { opacity: 0.4 },
});
