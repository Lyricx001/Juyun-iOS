import { providerDefinitions } from '../config/providers';
import { hashFile, hashRange, hmac } from '../native/juyunNative';
import type {
  CloudAccount,
  CloudFolder,
  CloudItem,
  CloudProvider,
  CloudSearchOptions,
  CloudUploadSource,
  DownloadLink,
  UploadProgress,
} from '../types/cloud';
import { HttpError, requestJson, withQuery } from '../utils/http';
import { assertUploadSource, base64Utf8, encodePathSegments, reportUpload, uploadRange } from '../utils/upload';
import {
  assertDirectoryCapacity,
  capabilities,
  guessMimeType,
  MAX_PROVIDER_PAGES,
  numberValue,
  postFormJson,
  providerArray,
  providerItem,
  providerObject,
  refreshSingleFlight,
  requireCredential,
  saveTokenPatch,
  stringValue,
} from './providerUtils';

interface Envelope<T> {
  state: boolean | number;
  code?: number;
  message?: string;
  error?: string;
  errno?: number;
  data: T;
  count?: number;
}

interface File115 {
  fid: string;
  pid: string;
  fc: string;
  fn: string;
  fs: number;
  pc: string;
  upt: number;
  uppt: number;
  thumb?: string;
  uo?: string;
}

interface SearchFile115 {
  file_id: string;
  parent_id: string;
  file_name: string;
  file_size: string | number;
  file_category: string;
  pick_code?: string;
  user_ptime?: string | number;
  user_utime?: string | number;
}

interface UploadInit115 {
  status: number;
  sign_key?: string;
  sign_check?: string;
  bucket?: string;
  object?: string;
  callback?:
    | { callback?: string; callback_var?: string; value?: { callback?: string; callback_var?: string } }
    | Array<{ callback?: string; callback_var?: string; value?: { callback?: string; callback_var?: string } }>;
}

interface UploadToken115 {
  endpoint: string;
  AccessKeySecret: string;
  SecurityToken: string;
  AccessKeyId: string;
}

const API = 'https://proapi.115.com';
const AUTH_API = 'https://passportapi.115.com';
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';

export class Drive115Provider implements CloudProvider {
  readonly definition = providerDefinitions['115'];
  readonly capabilities = capabilities(
    'search',
    'upload',
    'createFolder',
    'rename',
    'move',
    'copy',
    'delete',
  );

  private async refresh(account: CloudAccount): Promise<void> {
    await refreshSingleFlight(account, async () => {
      const response = providerObject<Envelope<{ access_token: string; refresh_token: string }>>(
        await postFormJson<Envelope<{ access_token: string; refresh_token: string }>>(
          `${AUTH_API}/open/refreshToken`,
          { refresh_token: requireCredential(account, 'refreshToken', 'Refresh Token') },
        ),
        '115',
      );
      if (response.code && response.code !== 0) {
        throw new Error(response.message || response.error || '115 Token 刷新失败');
      }
      if (!response.data?.access_token) throw new Error('115 未返回新的 Access Token');
      await saveTokenPatch(account, {
        accessToken: response.data?.access_token,
        refreshToken: response.data?.refresh_token,
      });
    });
  }

  private async request<T>(
    account: CloudAccount,
    url: string,
    init: RequestInit,
    allowRefresh = true,
  ): Promise<Envelope<T>> {
    const accessToken = requireCredential(account, 'accessToken', 'Access Token');
    let response: Envelope<T>;
    try {
      response = providerObject<Envelope<T>>(
        await requestJson<Envelope<T>>(url, {
          ...init,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': USER_AGENT,
            ...(init.headers ?? {}),
          },
        }),
        '115',
      );
    } catch (error) {
      if (
        allowRefresh &&
        error instanceof HttpError &&
        error.status === 401 &&
        account.credentials.refreshToken
      ) {
        if (account.credentials.accessToken === accessToken) await this.refresh(account);
        return this.request<T>(account, url, init, false);
      }
      throw error;
    }
    if (response.state === true || response.state === 1) return response;
    const unauthorized = response.code === 99 || response.code === 401 || response.errno === 401;
    if (allowRefresh && unauthorized && account.credentials.refreshToken) {
      if (account.credentials.accessToken === accessToken) await this.refresh(account);
      return this.request<T>(account, url, init, false);
    }
    throw new Error(response.message || response.error || `115 接口错误：${response.code ?? response.errno ?? '未知'}`);
  }

  async list(account: CloudAccount, folder: CloudFolder): Promise<CloudItem[]> {
    const result: CloudItem[] = [];
    const pageSize = 500;
    let offset = 0;
    let count = Number.POSITIVE_INFINITY;
    const seenPages = new Set<string>();
    while (offset < count) {
      const url = withQuery(`${API}/open/ufile/files`, {
        cid: folder.id || account.credentials.rootId || '0',
        limit: pageSize,
        offset,
        asc: 1,
        o: 'file_name',
        cur: 1,
        show_dir: 1,
      });
      const response = await this.request<File115[]>(account, url, { method: 'GET' });
      const files = providerArray<File115>(response.data, '115');
      assertDirectoryCapacity(result.length, files.length, '115');
      const pageSignature = files.length
        ? `${stringValue(files[0]?.fid)}:${stringValue(files.at(-1)?.fid)}:${files.length}`
        : '';
      if (pageSignature && seenPages.has(pageSignature)) {
        throw new Error('115 返回了重复的目录分页，请稍后重试');
      }
      if (pageSignature) {
        if (seenPages.size >= MAX_PROVIDER_PAGES) {
          throw new Error('115 当前目录分页过多，请缩小根目录范围后重试');
        }
        seenPages.add(pageSignature);
      }
      const reportedCount = numberValue(response.count);
      result.push(
        ...files.map((file) =>
          providerItem(account, '115', {
            id: stringValue(file.fid),
            parentId: stringValue(file.pid),
            name: file.fn,
            isFolder: String(file.fc) === '0',
            size: numberValue(file.fs),
            mimeType: guessMimeType(file.fn),
            thumbnailUrl: file.thumb || file.uo,
            modifiedAt: numberValue(file.upt) * 1000,
            createdAt: numberValue(file.uppt) * 1000,
            extra: { pickCode: file.pc },
          }),
        ),
      );
      count = reportedCount > 0
        ? reportedCount
        : files.length < pageSize
          ? result.length
          : offset + files.length + 1;
      if (!files.length || result.length >= count) break;
      offset += files.length;
    }
    return result;
  }

  async getDownloadLink(account: CloudAccount, item: CloudItem): Promise<DownloadLink> {
    const pickCode = stringValue(item.extra?.pickCode);
    if (!pickCode) throw new Error('115 文件缺少 Pick Code，请刷新目录后重试');
    const response = await this.request<Record<string, { url?: { url?: string } }>>(
      account,
      `${API}/open/ufile/downurl`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `pick_code=${encodeURIComponent(pickCode)}`,
      },
    );
    const url = Object.values(response.data ?? {})[0]?.url?.url;
    if (!url) throw new Error('115 未返回可用下载地址');
    return { url, headers: { 'User-Agent': USER_AGENT } };
  }

  async search(
    account: CloudAccount,
    keyword: string,
    options: CloudSearchOptions = {},
  ): Promise<CloudItem[]> {
    const limit = Math.min(500, Math.max(20, options.limit ?? 200));
    const response = await this.request<SearchFile115[]>(
      account,
      withQuery(`${API}/open/ufile/search`, {
        search_value: keyword,
        limit,
        offset: 0,
        cid: options.folder?.id || account.credentials.rootId || '0',
      }),
      { method: 'GET' },
    );
    return providerArray<SearchFile115>(response.data, '115').map((file) =>
      providerItem(account, '115', {
        id: stringValue(file.file_id),
        parentId: stringValue(file.parent_id),
        name: file.file_name,
        isFolder: String(file.file_category) === '0',
        size: numberValue(file.file_size),
        mimeType: guessMimeType(file.file_name),
        createdAt: numberValue(file.user_ptime) * 1000,
        modifiedAt: numberValue(file.user_utime) * 1000,
        extra: { pickCode: file.pick_code },
      }),
    );
  }

  async createFolder(account: CloudAccount, parent: CloudFolder, name: string): Promise<void> {
    await this.request(account, `${API}/open/folder/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `pid=${encodeURIComponent(parent.id)}&file_name=${encodeURIComponent(name)}`,
    });
  }

  async rename(account: CloudAccount, item: CloudItem, name: string): Promise<void> {
    await this.request(account, `${API}/open/ufile/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `file_id=${encodeURIComponent(item.id)}&file_name=${encodeURIComponent(name)}`,
    });
  }

  async move(account: CloudAccount, items: CloudItem[], destination: CloudFolder): Promise<void> {
    if (!items.length) return;
    await this.request(account, `${API}/open/ufile/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `file_ids=${encodeURIComponent(items.map((item) => item.id).join(','))}&to_cid=${encodeURIComponent(destination.id)}`,
    });
  }

  async copy(account: CloudAccount, items: CloudItem[], destination: CloudFolder): Promise<void> {
    if (!items.length) return;
    await this.request(account, `${API}/open/ufile/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `pid=${encodeURIComponent(destination.id)}&file_id=${encodeURIComponent(items.map((item) => item.id).join(','))}&no_dupli=0`,
    });
  }

  async delete(account: CloudAccount, items: CloudItem[]): Promise<void> {
    const grouped = new Map<string, CloudItem[]>();
    items.forEach((item) => grouped.set(item.parentId, [...(grouped.get(item.parentId) ?? []), item]));
    for (const [parentId, values] of grouped) {
      await this.request(account, `${API}/open/ufile/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `file_ids=${encodeURIComponent(values.map((item) => item.id).join(','))}&parent_id=${encodeURIComponent(parentId)}`,
      });
    }
  }

  async upload(
    account: CloudAccount,
    folder: CloudFolder,
    source: CloudUploadSource,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<void> {
    assertUploadSource(source);
    if (source.size > 5 * 1024 ** 3) throw new Error('115 单次上传暂支持 5 GB 以内文件');
    reportUpload(onProgress, 0, source.size, '正在校验文件');
    const sha1 = (await hashFile(source.uri, 'sha1')).toUpperCase();
    const preSha1 = (
      await hashRange(source.uri, 0, Math.min(source.size, 128 * 1024), 'sha1')
    ).toUpperCase();
    assertUploadSource(source);

    const initialize = async (signKey = '', signValue = '') => {
      const values = new URLSearchParams({
        file_name: source.name,
        file_size: String(source.size),
        target: `U_1_${folder.id || account.credentials.rootId || '0'}`,
        fileid: sha1,
        preid: preSha1,
      });
      if (signKey) values.set('sign_key', signKey);
      if (signValue) values.set('sign_val', signValue);
      return this.request<UploadInit115>(account, `${API}/open/upload/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: values.toString(),
      });
    };

    let initialized = await initialize();
    let initializedData = providerObject<UploadInit115>(initialized.data, '115');
    if ([6, 7, 8].includes(initializedData.status) && initializedData.sign_check && initializedData.sign_key) {
      const [startText, endText] = initializedData.sign_check.split('-');
      const start = Number(startText);
      const end = Number(endText);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end >= source.size
      ) {
        throw new Error('115 返回了无效的二次验证范围');
      }
      const signValue = (await hashRange(source.uri, start, end - start + 1, 'sha1')).toUpperCase();
      assertUploadSource(source);
      initialized = await initialize(initializedData.sign_key, signValue);
      initializedData = providerObject<UploadInit115>(initialized.data, '115');
    }
    if (initializedData.status === 2) {
      reportUpload(onProgress, source.size, source.size, '秒传完成');
      return;
    }
    const data = initializedData;
    if (!data.bucket || !data.object) throw new Error('115 未返回上传空间信息');
    const token = providerObject<UploadToken115>(
      (await this.request<UploadToken115>(account, `${API}/open/upload/get_token`, { method: 'GET' })).data,
      '115',
    );
    if (!token.endpoint || !token.AccessKeyId || !token.AccessKeySecret || !token.SecurityToken) {
      throw new Error('115 未返回有效上传凭证');
    }

    const endpoint = new URL(token.endpoint.includes('://') ? token.endpoint : `https://${token.endpoint}`);
    const host = endpoint.hostname.startsWith(`${data.bucket}.`)
      ? endpoint.hostname
      : `${data.bucket}.${endpoint.hostname}`;
    const authority = `${host}${endpoint.port ? `:${endpoint.port}` : ''}`;
    const prefix = endpoint.pathname.replace(/\/+$/, '');
    const objectPath = encodePathSegments(data.object).replace(/^\/+/, '');
    const uploadUrl = `${endpoint.protocol}//${authority}${prefix}/${objectPath}`;
    const date = new Date().toUTCString();
    const callbackValue = Array.isArray(data.callback) ? data.callback[0] : data.callback;
    const callback = callbackValue?.value ?? callbackValue;
    const ossHeaders: Record<string, string> = {
      'x-oss-security-token': token.SecurityToken,
    };
    if (callback?.callback) ossHeaders['x-oss-callback'] = base64Utf8(callback.callback);
    if (callback?.callback_var) ossHeaders['x-oss-callback-var'] = base64Utf8(callback.callback_var);
    const canonicalHeaders = Object.entries(ossHeaders)
      .filter(([, value]) => !!value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => `${key.toLowerCase()}:${value.trim()}\n`)
      .join('');
    const contentType = source.mimeType || 'application/octet-stream';
    const stringToSign = `PUT\n\n${contentType}\n${date}\n${canonicalHeaders}/${data.bucket}/${data.object}`;
    const signature = await hmac(stringToSign, token.AccessKeySecret, 'sha1', 'utf8', 'base64');
    await uploadRange({
      url: uploadUrl,
      source,
      start: 0,
      length: source.size,
      headers: {
        ...ossHeaders,
        Date: date,
        'Content-Type': contentType,
        Authorization: `OSS ${token.AccessKeyId}:${signature}`,
      },
      onProgress: (sent) => reportUpload(onProgress, sent, source.size, '正在上传'),
    });
    reportUpload(onProgress, source.size, source.size, '上传完成');
  }
}
