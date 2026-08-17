import { useEvent } from 'expo';
import { useVideoPlayer, VideoView, type VideoSource } from 'expo-video';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppButton } from '../components/Buttons';
import { ScreenHeader } from '../components/ScreenHeader';
import { EmptyState, LoadingState } from '../components/States';
import { providerDefinitions } from '../config/providers';
import { colors, radii } from '../config/theme';
import { useApp } from '../context/AppContext';
import { getProvider } from '../providers';
import type { CloudAccount, CloudItem, DownloadLink } from '../types/cloud';
import { assertDownloadLink } from '../utils/downloads';
import { formatBytes, isAudioItem, messageFromError } from '../utils/format';

interface Props {
  account: CloudAccount;
  item: CloudItem;
  onBack(): void;
}

const speeds = [0.5, 1, 1.25, 1.5, 2, 3];

function Player({
  account,
  item,
  link,
  onBack,
  onReload,
}: Props & { link: DownloadLink; onReload(): void }) {
  const { startDownload } = useApp();
  const audio = isAudioItem(item.name, item.mimeType);
  const source = useMemo<VideoSource>(
    () => ({
      uri: link.url,
      headers: link.headers,
      contentType: link.url.toLowerCase().includes('.m3u8') ? 'hls' : 'auto',
      metadata: {
        title: item.name,
        artist: providerDefinitions[account.providerId].name,
        artwork: item.thumbnailUrl,
      },
    }),
    [account.providerId, item.name, item.thumbnailUrl, link.headers, link.url],
  );
  const player = useVideoPlayer(source, (instance) => {
    instance.preservesPitch = true;
    instance.playbackRate = 1;
    instance.play();
  });
  const status = useEvent(player, 'statusChange', { status: player.status });
  const playing = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const [speed, setSpeed] = useState(1);

  function changeSpeed(value: number) {
    player.preservesPitch = true;
    player.playbackRate = value;
    setSpeed(value);
  }

  async function download() {
    try {
      await startDownload(account, item);
      Alert.alert('已加入下载', `${audio ? '音频' : '视频'}会继续在后台下载，可在“下载”页查看进度。`);
    } catch (error) {
      Alert.alert('无法下载', messageFromError(error));
    }
  }

  return (
    <View style={styles.root}>
      <ScreenHeader title={`${audio ? '音频' : '视频'}预览`} subtitle={account.displayName} onBack={onBack} />
      <View style={[styles.videoFrame, audio && styles.audioFrame]}>
        <VideoView
          allowsPictureInPicture
          contentFit="contain"
          fullscreenOptions={{ enable: true, orientation: audio ? 'default' : 'landscape' }}
          nativeControls
          player={player}
          startsPictureInPictureAutomatically
          style={styles.video}
        />
        {audio && (
          <View pointerEvents="none" style={styles.audioArtwork}>
            <Text style={styles.audioIcon}>♫</Text>
            <Text numberOfLines={2} style={styles.audioName}>{item.name}</Text>
          </View>
        )}
        {status?.status === 'loading' && (
          <View pointerEvents="none" style={styles.videoLoading}>
            <Text style={styles.videoLoadingText}>正在缓冲…</Text>
          </View>
        )}
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text numberOfLines={3} style={styles.title}>{item.name}</Text>
        <Text style={styles.meta}>
          {providerDefinitions[account.providerId].name}  ·  {formatBytes(item.size)}
        </Text>

        {status?.status === 'error' && (
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>{audio ? '音频' : '视频'}加载失败</Text>
            <Text style={styles.errorText}>{status.error?.message || '下载地址可能已经过期，请返回后重试。'}</Text>
            <AppButton label="刷新播放地址" onPress={onReload} style={styles.retryButton} variant="secondary" />
          </View>
        )}

        <View style={styles.sectionRow}>
          <Text style={styles.sectionTitle}>播放速度</Text>
          <Text style={styles.playingState}>{playing?.isPlaying ? '播放中' : '已暂停'}</Text>
        </View>
        <View style={styles.speedRow}>
          {speeds.map((value) => (
            <Pressable
              accessibilityRole="button"
              key={value}
              onPress={() => changeSpeed(value)}
              style={[styles.speedChip, value === speed && styles.speedChipActive]}
            >
              <Text style={[styles.speedText, value === speed && styles.speedTextActive]}>{value}×</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.tipBox}>
          <Text style={styles.tipTitle}>直连预览</Text>
          <Text style={styles.tipText}>{audio ? '音频' : '视频'}流直接从网盘发送到你的 iPhone，不经过聚云服务器。系统播放器支持进度拖动、倍速{audio ? '和后台播放' : '、全屏和画中画'}。</Text>
        </View>
        <AppButton label="下载到本机" onPress={() => void download()} variant="secondary" />
      </ScrollView>
    </View>
  );
}

export function VideoPlayerScreen(props: Props) {
  const [link, setLink] = useState<DownloadLink | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  function reload() {
    setAttempt((value) => value + 1);
  }

  useEffect(() => {
    let active = true;
    setLink(null);
    setError('');
    getProvider(props.account.providerId)
      .getDownloadLink(props.account, props.item)
      .then((value) => {
        if (active) setLink(assertDownloadLink(value));
      })
      .catch((loadError) => {
        if (active) setError(messageFromError(loadError));
      });
    return () => {
      active = false;
    };
  }, [attempt, props.account, props.item]);

  if (error) {
    return (
      <View style={styles.root}>
        <ScreenHeader title="文件预览" onBack={props.onBack} />
        <EmptyState icon="!" title="无法获取预览地址" detail={error} actionLabel="重试" onAction={reload} />
      </View>
    );
  }
  if (!link) {
    return (
      <View style={styles.root}>
        <ScreenHeader title="文件预览" onBack={props.onBack} />
        <LoadingState label="正在获取预览地址…" />
      </View>
    );
  }
  return <Player {...props} link={link} onReload={reload} />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  videoFrame: { aspectRatio: 16 / 9, backgroundColor: colors.black, justifyContent: 'center' },
  audioFrame: { aspectRatio: 1.45, backgroundColor: colors.surface },
  video: { flex: 1 },
  audioArtwork: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
  },
  audioIcon: { color: colors.primary, fontSize: 62, fontWeight: '800' },
  audioName: { color: colors.textMuted, fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 8 },
  videoLoading: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.22)',
  },
  videoLoadingText: { color: colors.white, fontSize: 13, fontWeight: '600' },
  content: { padding: 18, paddingBottom: 36 },
  title: { color: colors.text, fontSize: 20, fontWeight: '800', lineHeight: 28 },
  meta: { color: colors.textMuted, fontSize: 12, marginTop: 7 },
  errorBox: {
    backgroundColor: '#331820',
    borderColor: '#6E2B39',
    borderWidth: 1,
    borderRadius: radii.md,
    padding: 14,
    marginTop: 16,
  },
  errorTitle: { color: colors.danger, fontWeight: '800', fontSize: 14 },
  errorText: { color: '#E9ADB6', fontSize: 12, lineHeight: 18, marginTop: 5 },
  retryButton: { marginTop: 12 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 26 },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  playingState: { color: colors.success, fontSize: 11, fontWeight: '700' },
  speedRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  speedChip: {
    minWidth: 52,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  speedChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  speedText: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },
  speedTextActive: { color: colors.white },
  tipBox: { backgroundColor: colors.surface, borderRadius: radii.md, padding: 15, marginVertical: 22, borderWidth: 1, borderColor: colors.border },
  tipTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  tipText: { color: colors.textMuted, fontSize: 12, lineHeight: 19, marginTop: 6 },
});
