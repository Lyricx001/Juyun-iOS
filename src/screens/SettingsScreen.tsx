import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import appConfig from '../../app.json';
import { ProviderIcon } from '../components/ProviderIcon';
import { providerDefinitions } from '../config/providers';
import { colors, radii } from '../config/theme';
import { useApp } from '../context/AppContext';
import type { CloudAccount } from '../types/cloud';

interface Props {
  onEditAccount(account: CloudAccount): void;
}

export function SettingsScreen({ onEditAccount }: Props) {
  const { accounts } = useApp();
  const version = appConfig.expo.version;
  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <Text style={styles.title}>设置</Text>
      <Text style={styles.subtitle}>聚云 {version} · 个人版</Text>

      <View style={styles.securityCard}>
        <View style={styles.securityIcon}><Text style={styles.securityIconText}>⌁</Text></View>
        <View style={styles.securityCopy}>
          <Text style={styles.cardTitle}>本机优先的隐私设计</Text>
          <Text style={styles.cardText}>Token 与 Cookie 仅存入 iOS Keychain；预览、上传和下载均由网盘直连，不部署中转服务器。</Text>
        </View>
      </View>

      <Text style={styles.sectionTitle}>已连接账号</Text>
      <View style={styles.group}>
        {accounts.length ? accounts.map((account, index) => (
          <Pressable
            key={account.id}
            onPress={() => onEditAccount(account)}
            style={[styles.accountRow, index < accounts.length - 1 && styles.divider]}
          >
            <ProviderIcon providerId={account.providerId} size={40} />
            <View style={styles.accountCopy}>
              <Text numberOfLines={1} style={styles.accountName}>{account.displayName}</Text>
              <Text style={styles.accountProvider}>{providerDefinitions[account.providerId].name}</Text>
            </View>
            <Text style={styles.edit}>编辑  ›</Text>
          </Pressable>
        )) : (
          <Text style={styles.emptyText}>还没有连接账号，请从“网盘”页添加。</Text>
        )}
      </View>

      <Text style={styles.sectionTitle}>安装与更新</Text>
      <View style={styles.group}>
        <View style={[styles.infoRow, styles.divider]}>
          <Text style={styles.infoLabel}>安装渠道</Text>
          <Text style={styles.infoValue}>TestFlight</Text>
        </View>
        <View style={[styles.infoRow, styles.divider]}>
          <Text style={styles.infoLabel}>构建方式</Text>
          <Text style={styles.infoValue}>EAS 云端 iOS 构建</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>版本</Text>
          <Text style={styles.infoValue}>{version}</Text>
        </View>
      </View>

      <View style={styles.notice}>
        <Text style={styles.noticeTitle}>凭证维护</Text>
        <Text style={styles.noticeText}>夸克、天翼和迅雷的非标准凭证可能会过期。出现 401、未登录或风控提示时，编辑对应账号并更新 Token / Cookie 即可。</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, paddingBottom: 36 },
  title: { color: colors.text, fontSize: 28, fontWeight: '900' },
  subtitle: { color: colors.textMuted, fontSize: 12, marginTop: 5 },
  securityCard: { flexDirection: 'row', gap: 13, backgroundColor: '#102B29', borderWidth: 1, borderColor: '#1F5A50', borderRadius: radii.lg, padding: 16, marginTop: 22 },
  securityIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#17443D' },
  securityIconText: { color: colors.success, fontSize: 26 },
  securityCopy: { flex: 1 },
  cardTitle: { color: '#D5F6ED', fontSize: 15, fontWeight: '800' },
  cardText: { color: '#A7DBCE', fontSize: 12, lineHeight: 18, marginTop: 5 },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: '800', marginTop: 26, marginBottom: 10 },
  group: { backgroundColor: colors.surface, borderRadius: radii.lg, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.border },
  accountRow: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  accountCopy: { flex: 1, minWidth: 0 },
  accountName: { color: colors.text, fontSize: 14, fontWeight: '700' },
  accountProvider: { color: colors.textMuted, fontSize: 11, marginTop: 4, textTransform: 'uppercase' },
  edit: { color: colors.primary, fontSize: 12, fontWeight: '700' },
  emptyText: { color: colors.textMuted, textAlign: 'center', fontSize: 13, paddingVertical: 24 },
  infoRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  infoLabel: { color: colors.text, fontSize: 13, fontWeight: '600' },
  infoValue: { color: colors.textMuted, fontSize: 12 },
  notice: { backgroundColor: colors.surface, borderRadius: radii.md, padding: 14, marginTop: 16, borderWidth: 1, borderColor: colors.border },
  noticeTitle: { color: colors.warning, fontSize: 13, fontWeight: '800' },
  noticeText: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 5 },
});
