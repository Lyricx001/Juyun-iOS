import { providerDefinitions } from '../config/providers';
import { gcidFile, hashFile } from '../native/juyunNative';
import type {
  CloudAccount,
  CloudFolder,
  CloudItem,
  CloudProvider,
  CloudUploadSource,
  DownloadLink,
  UploadProgress,
} from '../types/cloud';
import { HttpError, requestJson, withQuery } from '../utils/http';
import { assertUploadSource, awsV4Headers, encodePathSegments, reportUpload, uploadRange } from '../utils/upload';
import {
  assertDirectoryCapacity,
  capabilities,
  guessMimeType,
  MAX_PROVIDER_PAGES,
  numberValue,
  providerArray,
  providerItem,
  providerObject,
  refreshSingleFlight,
  requireCredential,
  saveTokenPatch,
} from './providerUtils';

interface XunleiError {
  error_code?: number;
  error?: string;
  error_description?: string;
}

interface XunleiLink {
  url?: string;
  expire?: string;
}

interface XunleiFile {
  id: string;
  parent_id: string;
  name: string;
  kind: string;
  size?: string | number;
  mime_type?: string;
  icon_link?: string;
  thumbnail_link?: string;
  web_content_link?: string;
  created_time?: string;
  modified_time?: string;
  medias?: Array<{ link?: XunleiLink }>;
}

const DRIVE_API = 'https://api-pan.xunlei.com/drive/v1';
const USER_API = 'https://xluser-ssl.xunlei.com/v1';
const DEFAULT_CLIENT_ID = 'Xp6vsxz_7IYVw2BB';
const DEFAULT_CLIENT_VERSION = '8.31.0.9726';
const DEFAULT_USER_AGENT =
  'ANDROID-com.xunlei.downloadprovider/8.31.0.9726 netWorkType/5G appid/40 deviceName/iPhone deviceModel/iPhone OSVersion/18 protocolVersion/301';
const DEFAULT_DOWNLOAD_USER_AGENT = 'Dalvik/2.1.0 (Linux; U; Android 12)';

export class XunleiProvider implements CloudProvider {
  readonly definition = providerDefinitions.xunlei;
  readonly capabilities = capabilities('upload', 'createFolder', 'rename', 'move', 'copy', 'delete');

  private headers(account: CloudAccount): Record<string, string> {
    const tokenType = account.credentials.tokenType || 'Bearer';
    const headers: Record<string, string> = {
      Authorization: `${tokenType} ${requireCredential(account, 'accessToken', 'Access Token')}`,
      Accept: 'application/json;charset=UTF-8',
      'User-Agent': account.credentials.userAgent || DEFAULT_USER_AGENT,
      'X-Client-Id': account.credentials.clientId || DEFAULT_CLIENT_ID,
      'X-Client-Version': account.credentials.clientVersion || DEFAULT_CLIENT_VERSION,
    };
    if (account.credentials.captchaToken) headers['X-Captcha-Token'] = account.credentials.captchaToken;
    if (account.credentials.deviceId) headers['X-Device-Id'] = account.credentials.deviceId;
    return headers;
  }

  private async refresh(account: CloudAccount): Promise<void> {
    await refreshSingleFlight(account, async () => {
      const response = providerObject<{
          token_type?: string;
          access_token?: string;
          refresh_token?: string;
          error?: string;
          error_description?: string;
        }>(
        await requestJson<{
          token_type?: string;
          access_token?: string;
          refresh_token?: string;
          error?: string;
          error_description?: string;
        }>(`${USER_API}/auth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: requireCredential(account, 'refreshToken', 'Refresh Token'),
            client_id: account.credentials.clientId || DEFAULT_CLIENT_ID,
            client_secret: requireCredential(account, 'clientSecret', 'Client Secret'),
          }),
        }),
        '迅雷云盘',
      );
      if (!response.access_token) throw new Error(response.error_description || response.error || '迅雷 Token 刷新失败');
      await saveTokenPatch(account, {
        tokenType: response.token_type,
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
      });
    });
  }

  private async request<T extends object = Record<string, unknown>>(
    account: CloudAccount,
    url: string,
    method: 'GET' | 'POST' | 'PATCH' = 'GET',
    body?: Record<string, unknown>,
    allowRefresh = true,
  ): Promise<T> {
    const accessToken = requireCredential(account, 'accessToken', 'Access Token');
    try {
      const response = providerObject<T & XunleiError>(
        await requestJson<T & XunleiError>(url, {
          method,
          headers: {
            ...this.headers(account),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        }),
        '迅雷云盘',
      );
      if (response.error_code || response.error_description || (response.error && response.error !== 'success')) {
        throw new HttpError(
          response.error_description || response.error || `迅雷错误码：${response.error_code}`,
          400,
          response as Record<string, unknown>,
        );
      }
      return response;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 0;
      const errorBody = error instanceof HttpError ? (error.body as XunleiError | undefined) : undefined;
      const tokenExpired = status === 401 || [10, 16, 4121, 4122].includes(numberValue(errorBody?.error_code));
      if (allowRefresh && tokenExpired && account.credentials.refreshToken && account.credentials.clientSecret) {
        if (account.credentials.accessToken === accessToken) await this.refresh(account);
        return this.request<T>(account, url, method, body, false);
      }
      if (errorBody?.error_description || errorBody?.error) {
        throw new Error(errorBody.error_description || errorBody.error);
      }
      throw error;
    }
  }

  async list(account: CloudAccount, folder: CloudFolder): Promise<CloudItem[]> {
    const items: CloudItem[] = [];
    let pageToken = '';
    const seenPageTokens = new Set<string>();
    do {
      const response = await this.request<{ files?: XunleiFile[]; next_page_token?: string }>(
        account,
        withQuery(`${DRIVE_API}/files`, {
          space: account.credentials.space,
          __type: 'drive',
          refresh: true,
          __sync: true,
          parent_id: folder.id || account.credentials.rootId,
          page_token: pageToken,
          with_audit: true,
          limit: 100,
          filters: JSON.stringify({ phase: { eq: 'PHASE_TYPE_COMPLETE' }, trashed: { eq: false } }),
        }),
      );
      const files = providerArray<XunleiFile>(response.files, '迅雷云盘');
      assertDirectoryCapacity(items.length, files.length, '迅雷云盘');
      items.push(
        ...files.map((file) =>
          providerItem(account, 'xunlei', {
            id: file.id,
            parentId: file.parent_id,
            name: file.name,
            isFolder: file.kind === 'drive#folder',
            size: numberValue(file.size),
            mimeType: file.mime_type || guessMimeType(file.name),
            thumbnailUrl: file.thumbnail_link || file.icon_link,
            createdAt: file.created_time ? Date.parse(file.created_time) : undefined,
            modifiedAt: file.modified_time ? Date.parse(file.modified_time) : undefined,
            extra: { webContentLink: file.web_content_link, medias: file.medias },
          }),
        ),
      );
      const nextPageToken = response.next_page_token ?? '';
      if (nextPageToken && (seenPageTokens.has(nextPageToken) || seenPageTokens.size >= MAX_PROVIDER_PAGES)) {
        throw new Error('迅雷云盘返回了重复的分页游标，请稍后重试');
      }
      if (nextPageToken) seenPageTokens.add(nextPageToken);
      pageToken = nextPageToken;
    } while (pageToken);
    return items;
  }

  async getDownloadLink(account: CloudAccount, item: CloudItem): Promise<DownloadLink> {
    const response = await this.request<XunleiFile>(
      account,
      withQuery(`${DRIVE_API}/files/${encodeURIComponent(item.id)}`, { space: account.credentials.space }),
    );
    const mediaUrl = providerArray<{ link?: XunleiLink }>(response.medias, '迅雷云盘')
      .find((media) => media.link?.url)?.link?.url;
    const url = mediaUrl || response.web_content_link;
    if (!url) throw new Error('迅雷云盘未返回下载地址');
    return {
      url,
      headers: {
        'User-Agent': account.credentials.downloadUserAgent || DEFAULT_DOWNLOAD_USER_AGENT,
      },
    };
  }

  async createFolder(account: CloudAccount, parent: CloudFolder, name: string): Promise<void> {
    await this.request(account, `${DRIVE_API}/files`, 'POST', {
      kind: 'drive#folder',
      name,
      parent_id: parent.id,
      space: account.credentials.space || '',
    });
  }

  async rename(account: CloudAccount, item: CloudItem, name: string): Promise<void> {
    await this.request(
      account,
      `${DRIVE_API}/files/${encodeURIComponent(item.id)}`,
      'PATCH',
      { name, space: account.credentials.space || '' },
    );
  }

  async move(account: CloudAccount, items: CloudItem[], destination: CloudFolder): Promise<void> {
    if (!items.length) return;
    await this.request(account, `${DRIVE_API}/files:batchMove`, 'POST', {
      to: { parent_id: destination.id },
      ids: items.map((item) => item.id),
      space: account.credentials.space || '',
    });
  }

  async copy(account: CloudAccount, items: CloudItem[], destination: CloudFolder): Promise<void> {
    if (!items.length) return;
    await this.request(account, `${DRIVE_API}/files:batchCopy`, 'POST', {
      to: { parent_id: destination.id },
      ids: items.map((item) => item.id),
      space: account.credentials.space || '',
    });
  }

  async delete(account: CloudAccount, items: CloudItem[]): Promise<void> {
    for (const item of items) {
      await this.request(
        account,
        withQuery(`${DRIVE_API}/files/${encodeURIComponent(item.id)}/trash`, {
          space: account.credentials.space,
        }),
        'PATCH',
        {},
      );
    }
  }

  async upload(
    account: CloudAccount,
    folder: CloudFolder,
    source: CloudUploadSource,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<void> {
    assertUploadSource(source);
    if (source.size > 5 * 1024 ** 3) throw new Error('迅雷单次上传暂支持 5 GB 以内文件');
    reportUpload(onProgress, 0, source.size, '正在校验文件');
    const [gcid, payloadHash] = await Promise.all([
      gcidFile(source.uri, source.size),
      hashFile(source.uri, 'sha256'),
    ]);
    assertUploadSource(source);
    const task = await this.request<{
      upload_type?: string;
      resumable?: {
        params?: {
          access_key_id?: string;
          access_key_secret?: string;
          bucket?: string;
          endpoint?: string;
          key?: string;
          security_token?: string;
        };
      };
    }>(account, `${DRIVE_API}/files`, 'POST', {
      kind: 'drive#file',
      parent_id: folder.id,
      name: source.name,
      size: source.size,
      hash: gcid,
      upload_type: 'UPLOAD_TYPE_RESUMABLE',
      space: account.credentials.space || '',
    });
    const params = task.resumable?.params;
    if (!task.upload_type) throw new Error('迅雷未返回上传任务类型');
    if (task.upload_type !== 'UPLOAD_TYPE_RESUMABLE') {
      reportUpload(onProgress, source.size, source.size, '秒传完成');
      return;
    }
    if (!params) throw new Error('迅雷未返回可用的分片上传任务');
    if (
      !params.access_key_id ||
      !params.access_key_secret ||
      !params.bucket ||
      !params.endpoint ||
      !params.key
    ) {
      throw new Error('迅雷返回的上传凭证不完整');
    }
    const endpoint = new URL(params.endpoint.includes('://') ? params.endpoint : `https://${params.endpoint}`);
    const baseHost = endpoint.host.startsWith(`${params.bucket}.`)
      ? endpoint.host.slice(params.bucket.length + 1)
      : endpoint.host;
    const prefix = endpoint.pathname.replace(/\/+$/, '');
    const url = `${endpoint.protocol}//${params.bucket}.${baseHost}${prefix}/${encodePathSegments(params.key).replace(/^\/+/, '')}`;
    const signedHeaders = await awsV4Headers({
      method: 'PUT',
      url,
      region: 'xunlei',
      service: 's3',
      accessKeyId: params.access_key_id,
      secretAccessKey: params.access_key_secret,
      securityToken: params.security_token,
      payloadHash,
    });
    await uploadRange({
      url,
      source,
      start: 0,
      length: source.size,
      headers: {
        ...signedHeaders,
        'Content-Type': source.mimeType || 'application/octet-stream',
      },
      onProgress: (sent) => reportUpload(onProgress, sent, source.size, '正在上传'),
    });
    reportUpload(onProgress, source.size, source.size, '上传完成');
  }
}
