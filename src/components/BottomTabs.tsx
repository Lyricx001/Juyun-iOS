import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../config/theme';

export type MainTab = 'drives' | 'downloads' | 'settings';

interface Props {
  active: MainTab;
  onChange(tab: MainTab): void;
  downloadCount?: number;
}

const tabs: Array<{ id: MainTab; label: string; icon: string }> = [
  { id: 'drives', label: '网盘', icon: '◫' },
  { id: 'downloads', label: '传输', icon: '⇅' },
  { id: 'settings', label: '设置', icon: '⚙' },
];

export function BottomTabs({ active, onChange, downloadCount = 0 }: Props) {
  return (
    <View style={styles.container}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <Pressable key={tab.id} onPress={() => onChange(tab.id)} style={styles.tab}>
            <View>
              <Text style={[styles.icon, selected && styles.selected]}>{tab.icon}</Text>
              {tab.id === 'downloads' && downloadCount > 0 && (
                <View style={styles.badge}><Text style={styles.badgeText}>{Math.min(downloadCount, 99)}</Text></View>
              )}
            </View>
            <Text style={[styles.label, selected && styles.selected]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 70,
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingTop: 7,
  },
  tab: { flex: 1, alignItems: 'center', gap: 2 },
  icon: { color: colors.textMuted, fontSize: 24, lineHeight: 28 },
  label: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },
  selected: { color: colors.primary },
  badge: {
    position: 'absolute',
    right: -12,
    top: -4,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.white, fontSize: 10, fontWeight: '800' },
});
