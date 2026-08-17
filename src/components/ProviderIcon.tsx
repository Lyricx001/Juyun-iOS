import { StyleSheet, Text, View } from 'react-native';
import { providerDefinitions } from '../config/providers';
import type { ProviderId } from '../types/cloud';

interface Props {
  providerId: ProviderId;
  size?: number;
}

export function ProviderIcon({ providerId, size = 48 }: Props) {
  const definition = providerDefinitions[providerId];
  return (
    <View
      style={[
        styles.container,
        { width: size, height: size, borderRadius: size * 0.28, backgroundColor: definition.color },
      ]}
    >
      <Text style={[styles.label, { fontSize: providerId === '115' ? size * 0.28 : size * 0.42 }]}>
        {definition.icon}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', justifyContent: 'center' },
  label: { color: '#FFFFFF', fontWeight: '900' },
});
