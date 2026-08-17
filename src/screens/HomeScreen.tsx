import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { providerDefinitions, providerOrder } from '../config/providers';
import { colors, radii } from '../config/theme';
import { useApp } from '../context/AppContext';
import type { CloudAccount, ProviderId } from '../types/cloud';
import { AppButton } from '../components/Buttons';
import { ProviderIcon } from '../components/ProviderIcon';
import { LoadingState } from '../components/States';

interface Props {
  onSetup(providerId: ProviderId, account?: CloudAccount): void;
  onOpen(account: CloudAccount): void;
}

export function HomeScreen({ onSetup, onOpen }: Props) {
  const { accounts, accountsLoading } = useApp();
  if (accountsLoading) return <LoadingState label="正在读取本机账号…" />;

  const connectedCount = new Set(accounts.map((account) => account.providerId)).size;
  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.hero}>
        <View style={styles.heroGlow} />
        <Text style={styles.eyebrow}>JUYUN · PERSONAL CLOUD</Text>
        <Text style={styles.title}>六个网盘，一个入口</Text>
        <Text style={styles.subtitle}>预览、上传下载和文件管理，不经过中转服务器</Text>
        <View style={styles.stats}>
          <View style={styles.stat}><Text style={styles.statValue}>{connectedCount}</Text><Text style={styles.statLabel}>已连接</Text></View>
          <View style={styles.statDivider} />
          <View style={styles.stat}><Text style={styles.statValue}>6</Text><Text style={styles.statLabel}>支持网盘</Text></View>
          <View style={styles.statDivider} />
          <View style={styles.stat}><Text style={styles.statValue}>直连</Text><Text style={styles.statLabel}>传输方式</Text></View>
        </View>
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>我的网盘</Text>
        <Text style={styles.sectionMeta}>{accounts.length} 个账号</Text>
      </View>

      {providerOrder.map((providerId) => {
        const definition = providerDefinitions[providerId];
        const providerAccounts = accounts.filter((account) => account.providerId === providerId);
        return (
          <View key={providerId} style={styles.providerCard}>
            <View style={styles.providerHeader}>
              <ProviderIcon providerId={providerId} />
              <View style={styles.providerCopy}>
                <Text style={styles.providerName}>{definition.name}</Text>
                <Text style={styles.providerState}>
                  {providerAccounts.length ? `${providerAccounts.length} 个账号已连接` : '尚未连接'}
                </Text>
              </View>
              <Pressable onPress={() => onSetup(providerId)} style={styles.addButton}>
                <Text style={styles.addButtonText}>＋</Text>
              </Pressable>
            </View>

            {providerAccounts.map((account) => (
              <Pressable key={account.id} onPress={() => onOpen(account)} style={styles.accountRow}>
                <View style={styles.onlineDot} />
                <Text numberOfLines={1} style={styles.accountName}>{account.displayName}</Text>
                <Pressable
                  onPress={(event) => {
                    event.stopPropagation();
                    onSetup(providerId, account);
                  }}
                  style={styles.editButton}
                >
                  <Text style={styles.editText}>设置</Text>
                </Pressable>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            ))}

            {!providerAccounts.length && (
              <AppButton
                label={`连接${definition.shortName}`}
                onPress={() => onSetup(providerId)}
                variant="secondary"
                style={styles.connectButton}
              />
            )}
          </View>
        );
      })}
      <Text style={styles.footer}>账号凭证仅保存在这台设备的系统钥匙串中</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 30 },
  hero: {
    minHeight: 218,
    borderRadius: 28,
    backgroundColor: '#14204A',
    padding: 24,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#334A92',
  },
  heroGlow: {
    position: 'absolute',
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: '#5579FF',
    opacity: 0.22,
    right: -70,
    top: -80,
  },
  eyebrow: { color: '#AFC0FF', fontSize: 11, letterSpacing: 1.4, fontWeight: '800' },
  title: { color: colors.white, fontSize: 28, fontWeight: '800', marginTop: 16 },
  subtitle: { color: '#C5D0F2', fontSize: 14, lineHeight: 21, marginTop: 8, maxWidth: 285 },
  stats: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(5,9,24,0.38)',
    borderRadius: radii.md,
    marginTop: 24,
    paddingVertical: 12,
  },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { color: colors.white, fontSize: 16, fontWeight: '800' },
  statLabel: { color: '#A7B5DA', fontSize: 10, marginTop: 3 },
  statDivider: { width: 1, height: 28, backgroundColor: 'rgba(255,255,255,0.13)' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 26, marginBottom: 12 },
  sectionTitle: { color: colors.text, fontSize: 20, fontWeight: '800' },
  sectionMeta: { color: colors.textMuted, fontSize: 12 },
  providerCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: 14,
    marginBottom: 12,
  },
  providerHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  providerCopy: { flex: 1 },
  providerName: { color: colors.text, fontSize: 16, fontWeight: '700' },
  providerState: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
  addButton: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.surfaceElevated, alignItems: 'center', justifyContent: 'center' },
  addButtonText: { color: colors.primary, fontSize: 24, lineHeight: 26 },
  accountRow: {
    marginTop: 12,
    minHeight: 48,
    borderRadius: 14,
    paddingHorizontal: 12,
    backgroundColor: colors.surfaceElevated,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  onlineDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success },
  accountName: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600' },
  editButton: { paddingHorizontal: 8, paddingVertical: 8 },
  editText: { color: colors.textMuted, fontSize: 12 },
  chevron: { color: colors.textMuted, fontSize: 24 },
  connectButton: { marginTop: 12 },
  footer: { color: colors.textMuted, fontSize: 11, textAlign: 'center', marginTop: 10 },
});
