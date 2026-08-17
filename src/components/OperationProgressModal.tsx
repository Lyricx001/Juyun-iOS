import { ActivityIndicator, Modal, StyleSheet, Text, View } from 'react-native';
import { colors, radii } from '../config/theme';
import { formatBytes } from '../utils/format';

interface Props {
  visible: boolean;
  title: string;
  detail?: string;
  bytesDone?: number;
  totalBytes?: number;
}

export function OperationProgressModal({
  visible,
  title,
  detail,
  bytesDone = 0,
  totalBytes = 0,
}: Props) {
  const ratio = totalBytes > 0 ? Math.max(0, Math.min(1, bytesDone / totalBytes)) : 0;
  return (
    <Modal animationType="fade" transparent visible={visible}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.heading}>
            <ActivityIndicator color={colors.primary} />
            <Text style={styles.title}>{title}</Text>
          </View>
          {!!detail && <Text numberOfLines={3} style={styles.detail}>{detail}</Text>}
          {totalBytes > 0 && (
            <>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${ratio * 100}%` }]} />
              </View>
              <Text style={styles.bytes}>{formatBytes(bytesDone)} / {formatBytes(totalBytes)}</Text>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.68)',
  },
  card: {
    width: '100%',
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 18,
  },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '800' },
  detail: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 12 },
  track: { height: 6, marginTop: 16, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.surfaceElevated },
  fill: { height: '100%', backgroundColor: colors.primary },
  bytes: { color: colors.textMuted, fontSize: 11, textAlign: 'right', marginTop: 7 },
});
