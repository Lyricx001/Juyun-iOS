import type { CloudProvider, ProviderId } from '../types/cloud';
import { AlipanProvider } from './alipan';
import { BaiduProvider } from './baidu';
import { Drive115Provider } from './drive115';
import { QuarkProvider } from './quark';
import { TianyiProvider } from './tianyi';
import { XunleiProvider } from './xunlei';

export const providers: Record<ProviderId, CloudProvider> = {
  '115': new Drive115Provider(),
  baidu: new BaiduProvider(),
  quark: new QuarkProvider(),
  alipan: new AlipanProvider(),
  tianyi: new TianyiProvider(),
  xunlei: new XunleiProvider(),
};

export function getProvider(id: ProviderId): CloudProvider {
  return providers[id];
}
