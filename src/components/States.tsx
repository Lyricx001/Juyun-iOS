import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { colors } from '../config/theme';
import { AppButton } from './Buttons';

export function LoadingState({ label = '正在加载…' }: { label?: string }) {
  return (
    <View style={styles.container}>
      <ActivityIndicator color={colors.primary} size="large" />
      <Text style={styles.text}>{label}</Text>
    </View>
  );
}

export function EmptyState({
  icon = '☁',
  title,
  detail,
  actionLabel,
  onAction,
}: {
  icon?: string;
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.container}>
      <Text style={styles.icon}>{icon}</Text>
      <Text style={styles.title}>{title}</Text>
      {!!detail && <Text style={styles.text}>{detail}</Text>}
      {actionLabel && onAction && <AppButton label={actionLabel} onPress={onAction} style={styles.button} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 10 },
  icon: { fontSize: 46 },
  title: { color: colors.text, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  text: { color: colors.textMuted, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  button: { marginTop: 8, minWidth: 160 },
});
