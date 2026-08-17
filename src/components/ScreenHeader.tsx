import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../config/theme';

interface Props {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  actionLabel?: string;
  onAction?: () => void;
}

export function ScreenHeader({ title, subtitle, onBack, actionLabel, onAction }: Props) {
  return (
    <View style={styles.container}>
      {onBack ? (
        <Pressable accessibilityRole="button" onPress={onBack} style={styles.backButton}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
      ) : (
        <View style={styles.backSpacer} />
      )}
      <View style={styles.copy}>
        <Text numberOfLines={1} style={styles.title}>{title}</Text>
        {!!subtitle && <Text numberOfLines={1} style={styles.subtitle}>{subtitle}</Text>}
      </View>
      {actionLabel && onAction ? (
        <Pressable accessibilityRole="button" onPress={onAction} style={styles.actionButton}>
          <Text style={styles.actionText}>{actionLabel}</Text>
        </Pressable>
      ) : (
        <View style={styles.actionSpacer} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    gap: 12,
  },
  backButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceElevated,
  },
  backText: { color: colors.text, fontSize: 34, lineHeight: 36, marginTop: -3 },
  backSpacer: { width: 38 },
  copy: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 21, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  actionButton: { minWidth: 46, alignItems: 'flex-end', paddingVertical: 10 },
  actionText: { color: colors.primary, fontSize: 15, fontWeight: '700' },
  actionSpacer: { width: 46 },
});
