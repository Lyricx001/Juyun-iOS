import { providerDefinitions } from '../config/providers';
import { patchCredentials } from '../storage/credentialStore';
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
import { HttpError, requestJson } from '../utils/http';
import { assertUploadSource, reportUpload, uploadRange } from '../utils/upload';
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
  stringValue,
} from './providerUtils';

interface AliError {
  code?: string;
  message?: string;
}

interface AliFile {
  drive_id: string;
  file_id: string;
  parent_file_id: string;
  name: string;
  size: number;
  type: 'file' | 'folder';
  category?: string;
  thumbnail?: string;
  created_at?: string;
  updated_at?: string;
}

interface AliPartInfo {
  part_number: number;
  upload_url?: string;
}

interface AliCreateUpload {
  file_id: string;
  upload_id: string;
  rapid_upload?: boolean;
  part_info_list?: AliPartInfo[];
}

const API = 'https://openapi.alipan.com';
const TOKEN_ERRORS = new Set(['AccessTokenInvalid', 'AccessTokenExpired', 'I400JD']);

export class AlipanProvider implements CloudProvider {
  readonly definition = providerDefinitions.alipan;
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
      const response = providerObject<{
          access_token?: string;
          refresh_token?: string;
          code?: string;
          message?: string;
        }>(
        await requestJson<{
          access_token?: string;
          refresh_token?: string;
          code?: string;
          message?: string;
        }>(`${API}/oauth/access_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: requireCredential(account, 'clientId', 'Client ID'),
            client_secret: requireCredential(account, 'clientSecret', 'Client Secret'),
            grant_type: 'refresh_token',
            refresh_token: requireCredential(account, 'refreshToken', 'Refresh Token'),
          }),
        }),
        '阿里云盘',
      );
      if (!response.access_token) throw new Error(response.message || response.code || '阿里云盘 Token 刷新失败');
      await saveTokenPatch(account, {
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
      });
    });
  }

  private async post<T extends object = Record<string, unknown>>(
    account: CloudAccount,
    path: string,
    body: Record<string, unknown>,
    allowRefresh = true,
  ): Promise<T> {
    const accessToken = requireCredential(account, 'accessToken', 'Access Token');
    try {
      const response = providerObject<T & AliError>(
        await requestJson<T & AliError>(`${API}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
        '阿里云盘',
      );
      if (response.code) throw new HttpError(response.message || response.code, 400, response);
      return response;
    } catch (error) {
      const bodyValue = error instanceof HttpError ? (error.body as AliError | undefined) : undefined;
      const tokenExpired = error instanceof HttpError && (
        error.status === 401 || (!!bodyValue?.code && TOKEN_ERRORS.has(bodyValue.code))
      );
      if (
        allowRefresh &&
        tokenExpired &&
        account.credentials.clientId &&
        account.credentials.clientSecret &&
        account.credentials.refreshToken
      ) {
        if (account.credentials.accessToken === accessToken) await this.refresh(account);
        return this.post<T>(account, path, body, false);
      }
      if (bodyValue?.message || bodyValue?.code) throw new Error(bodyValue.message || bodyValue.code);
      throw error;
    }
  }

  private async getDriveId(account: CloudAccount): Promise<string> {
    if (account.credentials.driveId) return account.credentials.driveId;
    const info = await this.post<Record<string, unknown>>(account, '/adrive/v1.0/user/getDriveInfo', {});
    const driveType = account.credentials.driveType || 'resource';
    const driveId = stringValue(info[`${driveType}_drive_id`]) || stringValue(info.default_drive_id);
    if (!driveId) throw new Error('阿里云盘未返回空间 ID，请检查空间类型');
    if (!(await patchCredentials(account, { driveId }))) {
      throw new Error('阿里云盘账号配置已更新，请重新打开目录');
    }
    return driveId;
  }

  async list(account: CloudAccount, folder: CloudFolder): Promise<CloudItem[]> {
    const driveId = await this.getDriveId(account);
    const items: CloudItem[] = [];
    let marker = '';
    const seenMarkers = new Set<string>();
    do {
      const response = await this.post<{ items?: AliFile[]; next_marker?: string }>(
        account,
        '/adrive/v1.0/openFile/list',
        {
          drive_id: driveId,
          parent_file_id: folder.id || account.credentials.rootId || 'root',
          limit: 200,
          marker,
          order_by: 'name',
          order_direction: 'ASC',
        },
      );
      const files = providerArray<AliFile>(response.items, '阿里云盘');
      assertDirectoryCapacity(items.length, files.length, '阿里云盘');
      items.push(
        ...files.map((file) =>
          providerItem(account, 'alipan', {
            id: file.file_id,
            parentId: file.parent_file_id,
            name: file.name,
            isFolder: file.type === 'folder',
            size: numberValue(file.size),
            mimeType: guessMimeType(file.name),
            thumbnailUrl: file.thumbnail,
            createdAt: file.created_at ? Date.parse(file.created_at) : undefined,
            modifiedAt: file.updated_at ? Date.parse(file.updated_at) : undefined,
            extra: { driveId: file.drive_id || driveId },
          }),
        ),
      );
      const nextMarker = response.next_marker ?? '';
      if (nextMarker && (seenMarkers.has(nextMarker) || seenMarkers.size >= MAX_PROVIDER_PAGES)) {
        throw new Error('阿里云盘返回了重复的分页游标，请稍后重试');
      }
      if (nextMarker) seenMarkers.add(nextMarker);
      marker = nextMarker;
    } while (marker);
    return items;
  }

  async getDownloadLink(account: CloudAccount, item: CloudItem): Promise<DownloadLink> {
    const driveId = stringValue(item.extra?.driveId) || (await this.getDriveId(account));
    const response = await this.post<{ url?: string; streamsUrl?: Record<string, string> }>(
      account,
      '/adrive/v1.0/openFile/getDownloadUrl',
      { drive_id: driveId, file_id: item.id, expire_sec: 14_400 },
    );
    const url = response.url || response.streamsUrl?.mov || response.streamsUrl?.jpeg;
    if (!url) throw new Error('阿里云盘未返回下载地址');
    return { url, expiresAt: Date.now() + 4 * 60 * 60 * 1000 };
  }

  async search(
    account: CloudAccount,
    keyword: string,
    options: CloudSearchOptions = {},
  ): Promise<CloudItem[]> {
    const driveId = await this.getDriveId(account);
    const escaped = keyword.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const items: CloudItem[] = [];
    let marker = '';
    const seenMarkers = new Set<string>();
    do {
      const response = await this.post<{ items?: AliFile[]; next_marker?: string }>(
        account,
        '/adrive/v1.0/openFile/search',
        {
          drive_id: driveId,
          query: `name match '${escaped}'`,
          limit: Math.min(200, options.limit ?? 200),
          marker,
          order_by: 'updated_at DESC',
        },
      );
      const files = providerArray<AliFile>(response.items, '阿里云盘');
      items.push(...files.map((file) =>
        providerItem(account, 'alipan', {
          id: file.file_id,
          parentId: file.parent_file_id,
          name: file.name,
          isFolder: file.type === 'folder',
          size: numberValue(file.size),
          mimeType: guessMimeType(file.name),
          thumbnailUrl: file.thumbnail,
          createdAt: file.created_at ? Date.parse(file.created_at) : undefined,
          modifiedAt: file.updated_at ? Date.parse(file.updated_at) : undefined,
          extra: { driveId: file.drive_id || driveId },
        }),
      ));
      const nextMarker = response.next_marker ?? '';
      if (nextMarker && (seenMarkers.has(nextMarker) || seenMarkers.size >= MAX_PROVIDER_PAGES)) {
        throw new Error('阿里云盘返回了重复的搜索游标，请稍后重试');
      }
      if (nextMarker) seenMarkers.add(nextMarker);
      marker = nextMarker;
      if (items.length >= (options.limit ?? 200)) break;
    } while (marker);
    return items.slice(0, options.limit ?? 200);
  }

  async createFolder(account: CloudAccount, parent: CloudFolder, name: string): Promise<void> {
    const driveId = await this.getDriveId(account);
    await this.post(account, '/adrive/v1.0/openFile/create', {
      drive_id: driveId,
      parent_file_id: parent.id || 'root',
      name,
      type: 'folder',
      check_name_mode: 'refuse',
    });
  }

  async rename(account: CloudAccount, item: CloudItem, name: string): Promise<void> {
    await this.post(account, '/adrive/v1.0/openFile/update', {
      drive_id: stringValue(item.extra?.driveId) || (await this.getDriveId(account)),
      file_id: item.id,
      name,
      check_name_mode: 'refuse',
    });
  }

  async move(account: CloudAccount, items: CloudItem[], destination: CloudFolder): Promise<void> {
    const driveId = await this.getDriveId(account);
    for (const item of items) {
      await this.post(account, '/adrive/v1.0/openFile/move', {
        drive_id: stringValue(item.extra?.driveId) || driveId,
        file_id: item.id,
        to_parent_file_id: destination.id,
        check_name_mode: 'refuse',
      });
    }
  }

  async copy(account: CloudAccount, items: CloudItem[], destination: CloudFolder): Promise<void> {
    const driveId = await this.getDriveId(account);
    for (const item of items) {
      await this.post(account, '/adrive/v1.0/openFile/copy', {
        drive_id: stringValue(item.extra?.driveId) || driveId,
        file_id: item.id,
        to_parent_file_id: destination.id,
        auto_rename: false,
      });
    }
  }

  async delete(account: CloudAccount, items: CloudItem[]): Promise<void> {
    const driveId = await this.getDriveId(account);
    for (const item of items) {
      await this.post(account, '/adrive/v1.0/openFile/recyclebin/trash', {
        drive_id: stringValue(item.extra?.driveId) || driveId,
        file_id: item.id,
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
    const driveId = await this.getDriveId(account);
    const partSize = 20 * 1024 * 1024;
    const partCount = Math.max(1, Math.ceil(source.size / partSize));
    if (partCount > 10_000) throw new Error('文件过大，超出阿里云盘分片任务上限');
    const partInfoList = Array.from({ length: partCount }, (_, index) => ({ part_number: index + 1 }));
    reportUpload(onProgress, 0, source.size, '正在创建上传任务');
    const created = await this.post<AliCreateUpload>(account, '/adrive/v1.0/openFile/create', {
      drive_id: driveId,
      parent_file_id: folder.id || 'root',
      name: source.name,
      type: 'file',
      check_name_mode: 'refuse',
      local_created_at: new Date(source.createdAt ?? Date.now()).toISOString(),
      local_modified_at: new Date(source.modifiedAt ?? Date.now()).toISOString(),
      part_info_list: partInfoList,
    });
    if (!created.file_id || !created.upload_id) throw new Error('阿里云盘未返回上传任务信息');
    if (!created.rapid_upload) {
      let parts = providerArray<AliPartInfo>(created.part_info_list, '阿里云盘');
      if (parts.length !== partCount || parts.some((part) => !part.upload_url)) {
        const response = await this.post<{ part_info_list?: AliPartInfo[] }>(
          account,
          '/adrive/v1.0/openFile/getUploadUrl',
          {
            drive_id: driveId,
            file_id: created.file_id,
            upload_id: created.upload_id,
            part_info_list: partInfoList,
          },
        );
        parts = providerArray<AliPartInfo>(response.part_info_list, '阿里云盘');
      }
      if (parts.length !== partCount) throw new Error('阿里云盘返回的分片数量不完整');
      const partsByNumber = new Map<number, AliPartInfo>();
      for (const part of parts) {
        if (
          !Number.isSafeInteger(part.part_number) ||
          part.part_number < 1 ||
          part.part_number > partCount ||
          !part.upload_url ||
          partsByNumber.has(part.part_number)
        ) {
          throw new Error('阿里云盘返回了无效或重复的分片信息');
        }
        partsByNumber.set(part.part_number, part);
      }
      let completed = 0;
      for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
        const url = partsByNumber.get(partNumber)?.upload_url;
        if (!url) throw new Error(`阿里云盘未返回第 ${partNumber} 个分片地址`);
        const start = (partNumber - 1) * partSize;
        const length = Math.max(0, Math.min(partSize, source.size - start));
        await uploadRange({
          url,
          source,
          start,
          length,
          onProgress: (sent) => reportUpload(
            onProgress,
            Math.min(source.size, completed + sent),
            source.size,
            '正在上传',
          ),
        });
        completed += length;
      }
    }
    reportUpload(onProgress, Math.max(0, source.size - 1), source.size, '正在合并文件');
    await this.post(account, '/adrive/v1.0/openFile/complete', {
      drive_id: driveId,
      file_id: created.file_id,
      upload_id: created.upload_id,
    });
    reportUpload(onProgress, source.size, source.size, '上传完成');
  }
}
