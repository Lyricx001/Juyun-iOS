import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AppButton } from '../components/Buttons';
import { ProviderIcon } from '../components/ProviderIcon';
import { ScreenHeader } from '../components/ScreenHeader';
import { getDefaultCredentials, providerDefinitions } from '../config/providers';
import { colors, radii } from '../config/theme';
import { useApp } from '../context/AppContext';
import { getProvider } from '../providers';
import { createAccount, withTransientCredentialUpdates } from '../storage/credentialStore';
import type { CloudAccount, ProviderId } from '../types/cloud';
import { getAccountRoot } from '../utils/account';
import { messageFromError } from '../utils/format';

interface Props {
  providerId: ProviderId;
  account?: CloudAccount;
  onBack(): void;
  onSaved(account: CloudAccount): void;
}

export function SetupScreen({ providerId, account, onBack, onSaved }: Props) {
  const definition = providerDefinitions[providerId];
  const { saveAccount, deleteAccount } = useApp();
  const baseAccount = useMemo(
    () => account ?? createAccount(providerId, definition.name),
    [account, definition.name, providerId],
  );
  const [displayName, setDisplayName] = useState(baseAccount.displayName);
  const [credentials, setCredentials] = useState<Record<string, string>>({
    ...getDefaultCredentials(providerId),
    ...baseAccount.credentials,
  });
  const [showSecrets, setShowSecrets] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const operationInProgress = useRef(false);

  function normalizedAccount(): CloudAccount {
    const normalizedCredentials = Object.fromEntries(
      Object.entries(credentials).map(([key, value]) => [key, value.trim()]),
    );
    if (providerId === 'alipan') delete normalizedCredentials.driveId;
    return {
      ...baseAccount,
      displayName: displayName.trim() || definition.name,
      credentials: normalizedCredentials,
      updatedAt: Date.now(),
    };
  }

  function validate(): string | null {
    const missing = definition.fields.find((field) => field.required && !credentials[field.key]?.trim());
    if (missing) return `请填写${missing.label}`;
    const name = displayName.trim();
    if (name.length > 120) return '显示名称过长，请控制在 120 个字符以内';
    if (/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/.test(name)) {
      return '显示名称不能包含控制字符';
    }
    const credentialBytes = new TextEncoder().encode(JSON.stringify(credentials)).length;
    if (credentialBytes > 220_000) return '凭证内容过长，请只保留接口需要的 Token 或 Cookie';
    if (providerId === 'baidu' && !credentials.rootPath?.trim().startsWith('/')) {
      return '百度网盘根目录路径必须以“/”开头';
    }
    if (
      providerId === 'alipan' &&
      !new Set(['resource', 'default', 'backup']).has(credentials.driveType?.trim() || 'resource')
    ) {
      return '阿里云盘空间类型只能是 resource、default 或 backup';
    }
    if (
      providerId === 'xunlei' &&
      !/^[A-Za-z][A-Za-z0-9+.-]*$/.test(credentials.tokenType?.trim() || 'Bearer')
    ) {
      return '迅雷 Token 类型格式无效，通常填写 Bearer';
    }
    return null;
  }

  async function handleSave(shouldTest: boolean) {
    if (operationInProgress.current) return;
    const validationError = validate();
    if (validationError) {
      Alert.alert('信息不完整', validationError);
      return;
    }
    const next = normalizedAccount();
    operationInProgress.current = true;
    shouldTest ? setTesting(true) : setSaving(true);
    try {
      if (shouldTest) {
        await withTransientCredentialUpdates(next, () => (
          getProvider(providerId).list(next, getAccountRoot(next))
        ));
        const savedAccount = await saveAccount(next);
        Alert.alert('连接成功', `${savedAccount.displayName} 已可以读取文件。`, [
          { text: '进入网盘', onPress: () => onSaved(savedAccount) },
        ]);
      } else {
        const savedAccount = await saveAccount(next);
        onSaved(savedAccount);
      }
    } catch (error) {
      Alert.alert(
        shouldTest ? '连接测试失败' : '保存失败',
        shouldTest
          ? `${messageFromError(error)}\n\n${account ? '原有可用凭证没有被覆盖。' : '本次凭证尚未保存。'}`
          : messageFromError(error),
      );
    } finally {
      operationInProgress.current = false;
      setSaving(false);
      setTesting(false);
    }
  }

  function handleDelete() {
    if (!account) return;
    Alert.alert('删除账号', `确定移除“${account.displayName}”吗？本机凭证会删除，该账号正在排队、下载或暂停的任务也会停止。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          if (operationInProgress.current) return;
          operationInProgress.current = true;
          try {
            await deleteAccount(account.id);
            onBack();
          } catch (error) {
            Alert.alert('删除失败', messageFromError(error));
          } finally {
            operationInProgress.current = false;
          }
        },
      },
    ]);
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
      <ScreenHeader title={`连接${definition.name}`} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.providerIntro}>
          <ProviderIcon providerId={providerId} size={58} />
          <View style={styles.introCopy}>
            <Text style={styles.introTitle}>{definition.name}</Text>
            <Text style={styles.introText}>{definition.authNote}</Text>
          </View>
        </View>

        <View style={styles.securityNote}>
          <Text style={styles.securityIcon}>⌁</Text>
          <Text style={styles.securityText}>不收集网盘密码；Token 与 Cookie 使用 iOS Keychain 加密保存。</Text>
        </View>

        <View style={styles.sectionTitleRow}>
          <Text style={styles.sectionTitle}>账号信息</Text>
          <Pressable onPress={() => setShowSecrets((value) => !value)}>
            <Text style={styles.revealText}>{showSecrets ? '隐藏凭证' : '显示凭证'}</Text>
          </Pressable>
        </View>

        <Text style={styles.label}>显示名称</Text>
        <TextInput
          autoCapitalize="none"
          maxLength={120}
          onChangeText={setDisplayName}
          placeholder={definition.name}
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          value={displayName}
        />

        {definition.fields.map((field) => (
          <View key={field.key} style={styles.field}>
            <Text style={styles.label}>{field.label}{field.required ? ' *' : ''}</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={220_000}
              multiline={field.multiline}
              onChangeText={(value) => setCredentials((current) => ({ ...current, [field.key]: value }))}
              placeholder={field.placeholder}
              placeholderTextColor={colors.textMuted}
              secureTextEntry={field.secret && !showSecrets}
              style={[styles.input, field.multiline && styles.multilineInput]}
              textAlignVertical={field.multiline ? 'top' : 'center'}
              value={credentials[field.key] ?? ''}
            />
            {!!field.help && <Text style={styles.help}>{field.help}</Text>}
          </View>
        ))}

        <View style={styles.buttons}>
          <AppButton disabled={saving} label="保存并测试连接" loading={testing} onPress={() => handleSave(true)} />
          <AppButton disabled={testing} label="仅保存" loading={saving} onPress={() => handleSave(false)} variant="secondary" />
          {account && <AppButton disabled={saving || testing} label="删除这个账号" onPress={handleDelete} variant="danger" />}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, paddingBottom: 40 },
  providerIntro: {
    flexDirection: 'row',
    gap: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: 16,
  },
  introCopy: { flex: 1 },
  introTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  introText: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: 5 },
  securityNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#102B29',
    borderColor: '#1F5A50',
    borderWidth: 1,
    padding: 13,
    borderRadius: radii.md,
    marginTop: 12,
  },
  securityIcon: { color: colors.success, fontSize: 22 },
  securityText: { flex: 1, color: '#A7DBCE', fontSize: 12, lineHeight: 18 },
  sectionTitleRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 26, marginBottom: 14 },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  revealText: { color: colors.primary, fontSize: 13, fontWeight: '600' },
  field: { marginTop: 15 },
  label: { color: colors.text, fontSize: 13, fontWeight: '600', marginBottom: 7 },
  input: {
    minHeight: 50,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: 14,
    fontSize: 14,
  },
  multilineInput: { minHeight: 92, paddingTop: 13, paddingBottom: 13 },
  help: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 6 },
  buttons: { gap: 10, marginTop: 26 },
});
