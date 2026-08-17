import type { ProviderDefinition, ProviderId } from '../types/cloud';

export const providerDefinitions: Record<ProviderId, ProviderDefinition> = {
  '115': {
    id: '115',
    name: '115生活',
    shortName: '115',
    color: '#2278F2',
    icon: '115',
    root: { id: '0', name: '根目录', path: '/' },
    authNote: '使用 115 开放平台生成的 Access Token 和 Refresh Token。凭证只保存在本机钥匙串。',
    fields: [
      { key: 'accessToken', label: 'Access Token', required: true, secret: true, multiline: true },
      { key: 'refreshToken', label: 'Refresh Token', required: true, secret: true, multiline: true },
      { key: 'rootId', label: '根目录 ID', defaultValue: '0', placeholder: '0' },
    ],
  },
  baidu: {
    id: 'baidu',
    name: '百度网盘',
    shortName: '百度',
    color: '#2D72FF',
    icon: '度',
    root: { id: '/', name: '根目录', path: '/' },
    authNote: 'Access Token 可直接使用；填写 Client ID、Client Secret 和 Refresh Token 后可自动续期。',
    fields: [
      { key: 'accessToken', label: 'Access Token', required: true, secret: true, multiline: true },
      { key: 'refreshToken', label: 'Refresh Token', secret: true, multiline: true },
      { key: 'clientId', label: 'Client ID', secret: true },
      { key: 'clientSecret', label: 'Client Secret', secret: true },
      { key: 'rootPath', label: '根目录路径', defaultValue: '/', placeholder: '/' },
    ],
  },
  quark: {
    id: 'quark',
    name: '夸克网盘',
    shortName: '夸克',
    color: '#FFB51B',
    icon: '夸',
    root: { id: '0', name: '根目录', path: '/' },
    authNote: '使用夸克网盘 Open API 的 App ID、Sign Key 和 Access Token。Token 失效后需更新。',
    fields: [
      { key: 'accessToken', label: 'Access Token', required: true, secret: true, multiline: true },
      { key: 'refreshToken', label: 'Refresh Token', secret: true, multiline: true },
      { key: 'appId', label: 'App ID', required: true, secret: true },
      { key: 'signKey', label: 'Sign Key', required: true, secret: true, multiline: true },
      { key: 'rootId', label: '根目录 ID', defaultValue: '0', placeholder: '0' },
    ],
  },
  alipan: {
    id: 'alipan',
    name: '阿里云盘',
    shortName: '阿里',
    color: '#6B5CFF',
    icon: '阿',
    root: { id: 'root', name: '根目录', path: '/' },
    authNote: '使用阿里云盘开放平台 Token。填写应用 Client ID 和 Client Secret 后可自动刷新。',
    fields: [
      { key: 'accessToken', label: 'Access Token', required: true, secret: true, multiline: true },
      { key: 'refreshToken', label: 'Refresh Token', secret: true, multiline: true },
      { key: 'clientId', label: 'Client ID', secret: true },
      { key: 'clientSecret', label: 'Client Secret', secret: true },
      {
        key: 'driveType',
        label: '空间类型',
        defaultValue: 'resource',
        placeholder: 'resource / default / backup',
      },
      { key: 'rootId', label: '根目录 ID', defaultValue: 'root', placeholder: 'root' },
    ],
  },
  tianyi: {
    id: 'tianyi',
    name: '天翼云盘',
    shortName: '天翼',
    color: '#1890FF',
    icon: '天',
    root: { id: '-11', name: '根目录', path: '/' },
    authNote: '粘贴你登录 cloud.189.cn 后的完整 Cookie。不保存账号密码，Cookie 失效时重新粘贴。',
    fields: [
      {
        key: 'cookie',
        label: 'Cookie',
        required: true,
        secret: true,
        multiline: true,
        placeholder: 'COOKIE_LOGIN_USER=...; ...',
      },
      { key: 'rootId', label: '根目录 ID', defaultValue: '-11', placeholder: '-11' },
    ],
  },
  xunlei: {
    id: 'xunlei',
    name: '迅雷云盘',
    shortName: '迅雷',
    color: '#2D8CFF',
    icon: '迅',
    root: { id: '', name: '根目录', path: '/' },
    authNote: '使用你自己账号的 OAuth Token。若接口要求验证，还需要填写 Captcha Token 和 Device ID。',
    fields: [
      { key: 'tokenType', label: 'Token 类型', defaultValue: 'Bearer', placeholder: 'Bearer' },
      { key: 'accessToken', label: 'Access Token', required: true, secret: true, multiline: true },
      { key: 'refreshToken', label: 'Refresh Token', secret: true, multiline: true },
      { key: 'captchaToken', label: 'Captcha Token', secret: true, multiline: true },
      { key: 'deviceId', label: 'Device ID', secret: true },
      { key: 'clientId', label: 'Client ID（用于续期）', secret: true },
      { key: 'clientSecret', label: 'Client Secret（用于续期）', secret: true },
      { key: 'rootId', label: '根目录 ID', defaultValue: '', placeholder: '通常留空' },
    ],
  },
};

export const providerOrder: ProviderId[] = ['115', 'baidu', 'quark', 'alipan', 'tianyi', 'xunlei'];

export function getDefaultCredentials(providerId: ProviderId): Record<string, string> {
  return Object.fromEntries(
    providerDefinitions[providerId].fields
      .filter((field) => field.defaultValue !== undefined)
      .map((field) => [field.key, field.defaultValue ?? '']),
  );
}
