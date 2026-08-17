import { StatusBar } from 'expo-status-bar';
import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { BottomTabs, type MainTab } from './src/components/BottomTabs';
import { colors } from './src/config/theme';
import { AppProvider, useApp } from './src/context/AppContext';
import { DownloadsScreen } from './src/screens/DownloadsScreen';
import { FileBrowserScreen } from './src/screens/FileBrowserScreen';
import { FilePreviewScreen } from './src/screens/FilePreviewScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SetupScreen } from './src/screens/SetupScreen';
import type { CloudAccount, CloudItem, ProviderId } from './src/types/cloud';

type Route =
  | { type: 'setup'; providerId: ProviderId; account?: CloudAccount }
  | { type: 'browser'; account: CloudAccount }
  | { type: 'preview'; account: CloudAccount; item: CloudItem };

function JuyunApp() {
  const { downloads } = useApp();
  const [tab, setTab] = useState<MainTab>('drives');
  const [routes, setRoutes] = useState<Route[]>([]);
  const activeRoute = routes[routes.length - 1];
  const push = (route: Route) => setRoutes((current) => [...current, route]);
  const pop = () => setRoutes((current) => current.slice(0, -1));

  let content: ReactNode;
  if (activeRoute?.type === 'setup') {
    content = (
      <SetupScreen
        account={activeRoute.account}
        providerId={activeRoute.providerId}
        onBack={pop}
        onSaved={(account) => {
          setRoutes((current) => [
            ...current.slice(0, -1),
            { type: 'browser', account },
          ]);
        }}
      />
    );
  } else if (activeRoute?.type === 'browser') {
    content = (
      <FileBrowserScreen
        account={activeRoute.account}
        onBack={pop}
        onPreview={(item) => push({ type: 'preview', account: activeRoute.account, item })}
      />
    );
  } else if (activeRoute?.type === 'preview') {
    content = <FilePreviewScreen account={activeRoute.account} item={activeRoute.item} onBack={pop} />;
  } else if (tab === 'downloads') {
    content = <DownloadsScreen />;
  } else if (tab === 'settings') {
    content = <SettingsScreen onEditAccount={(account) => push({ type: 'setup', providerId: account.providerId, account })} />;
  } else {
    content = (
      <HomeScreen
        onOpen={(account) => push({ type: 'browser', account })}
        onSetup={(providerId, account) => push({ type: 'setup', providerId, account })}
      />
    );
  }

  const activeDownloadCount = downloads.filter((record) => record.status === 'queued' || record.status === 'downloading').length;
  return (
    <SafeAreaView edges={['top', 'right', 'bottom', 'left']} style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.content}>{content}</View>
      {!activeRoute && <BottomTabs active={tab} downloadCount={activeDownloadCount} onChange={setTab} />}
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <JuyunApp />
      </AppProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1 },
});
