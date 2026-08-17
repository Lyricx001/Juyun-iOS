import { providerDefinitions } from '../config/providers';
import { hashChunks, hashFile, hashRange } from '../native/juyunNative';
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
import { assertUploadSource, joinCloudPath, reportUpload, uploadRange } from '../utils/upload';
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

interface BaiduEnvelope {
  errno: number;
  errmsg?: string;
  error_msg?: string;
}

interface BaiduFile {
  fs_id: number | string;
  server_filename: string;
  path: string;
  size: number;
  isdir: number;
  category?: number;
  server_ctime?: number;
  server_mtime?: number;
  thumbs?: { url3?: string };
}

interface BaiduPrecreate extends BaiduEnvelope {
  return_type?: number;
  uploadid?: string;
  block_list?: number[];
  info?: BaiduFile;
}

interface BaiduUploadServer {
  error_code?: number;
  error_msg?: string;
  servers?: Array<{ server: string }>;
  bak_servers?: Array<{ server: string }>;
}

const BASE = 'https://pan.baidu.com/rest/2.0';
const USER_AGENT = 'pan.baidu.com';

export class BaiduProvider implements CloudProvider {
  readonly definition = providerDefinitions.baidu;
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
      const clientId = requireCredential(account, 'clientId', 'Client ID');
      const clientSecret = requireCredential(account, 'clientSecret', 'Client Secret');
      const refreshToken = requireCredential(account, 'refreshToken', 'Refresh Token');
      const response = providerObject<{
          access_token?: string;
          refresh_token?: string;
          error?: string;
          error_description?: string;
        }>(
        await requestJson<{
          access_token?: string;
          refresh_token?: string;
          error?: string;
          error_description?: string;
        }>(withQuery('https://openapi.baidu.com/oauth/2.0/token', {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        })),
        '百度网盘',
      );
      if (!response.access_token) throw new Error(response.error_description || response.error || '百度 Token 刷新失败');
      await saveTokenPatch(account, {
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
      });
    });
  }

  private async get<T extends BaiduEnvelope>(
    account: CloudAccount,
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    allowRefresh = true,
  ): Promise<T> {
    const accessToken = requireCredential(account, 'accessToken', 'Access Token');
    let response: T;
    try {
      response = providerObject<T>(
        await requestJson<T>(
          withQuery(`${BASE}${path}`, { ...params, access_token: accessToken }),
          { headers: { 'User-Agent': USER_AGENT } },
        ),
        '百度网盘',
      );
    } catch (error) {
      if (
        allowRefresh &&
        error instanceof HttpError &&
        error.status === 401 &&
        account.credentials.clientId &&
        account.credentials.clientSecret &&
        account.credentials.refreshToken
      ) {
        if (account.credentials.accessToken === accessToken) await this.refresh(account);
        return this.get<T>(account, path, params, false);
      }
      throw error;
    }
    if (!response.errno) return response;
    if (
      allowRefresh &&
      (response.errno === 111 || response.errno === -6) &&
      account.credentials.clientId &&
      account.credentials.clientSecret &&
      account.credentials.refreshToken
    ) {
      if (account.credentials.accessToken === accessToken) await this.refresh(account);
      return this.get<T>(account, path, params, false);
    }
    throw new Error(response.errmsg || response.error_msg || `百度网盘错误码：${response.errno}`);
  }

  private async postForm<T extends BaiduEnvelope>(
    account: CloudAccount,
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    values: Record<string, string | number | boolean | undefined>,
    allowRefresh = true,
  ): Promise<T> {
    const body = new URLSearchParams();
    Object.entries(values).forEach(([key, value]) => {
      if (value !== undefined && value !== '') body.set(key, String(value));
    });
    const accessToken = requireCredential(account, 'accessToken', 'Access Token');
    let response: T;
    try {
      response = providerObject<T>(
        await requestJson<T>(
          withQuery(`${BASE}${path}`, { ...params, access_token: accessToken }),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': USER_AGENT,
            },
            body: body.toString(),
          },
        ),
        '百度网盘',
      );
    } catch (error) {
      if (
        allowRefresh &&
        error instanceof HttpError &&
        error.status === 401 &&
        account.credentials.clientId &&
        account.credentials.clientSecret &&
        account.credentials.refreshToken
      ) {
        if (account.credentials.accessToken === accessToken) await this.refresh(account);
        return this.postForm<T>(account, path, params, values, false);
      }
      throw error;
    }
    if (!response.errno) return response;
    if (
      allowRefresh &&
      (response.errno === 111 || response.errno === -6) &&
      account.credentials.clientId &&
      account.credentials.clientSecret &&
      account.credentials.refreshToken
    ) {
      if (account.credentials.accessToken === accessToken) await this.refresh(account);
      return this.postForm<T>(account, path, params, values, false);
    }
    throw new Error(response.errmsg || response.error_msg || `百度网盘错误码：${response.errno}`);
  }

  async list(account: CloudAccount, folder: CloudFolder): Promise<CloudItem[]> {
    const items: CloudItem[] = [];
    const limit = 1000;
    let start = 0;
    const seenPages = new Set<string>();
    const directory = folder.path || folder.id || account.credentials.rootPath || '/';
    while (true) {
      const response = await this.get<BaiduEnvelope & { list: BaiduFile[] }>(account, '/xpan/file', {
        method: 'list',
        dir: directory,
        start,
        limit,
        order: 'name',
        desc: 0,
        web: 'web',
      });
      const files = providerArray<BaiduFile>(response.list, '百度网盘');
      assertDirectoryCapacity(items.length, files.length, '百度网盘');
      const pageSignature = files.length
        ? `${stringValue(files[0]?.fs_id)}:${stringValue(files.at(-1)?.fs_id)}:${files.length}`
        : '';
      if (pageSignature && seenPages.has(pageSignature)) {
        throw new Error('百度网盘返回了重复的目录分页，请稍后重试');
      }
      if (pageSignature) seenPages.add(pageSignature);
      items.push(
        ...files.map((file) =>
          providerItem(account, 'baidu', {
            id: stringValue(file.fs_id),
            parentId: directory,
            name: file.server_filename,
            path: file.path,
            isFolder: numberValue(file.isdir) === 1,
            size: numberValue(file.size),
            mimeType: guessMimeType(file.server_filename),
            thumbnailUrl: file.thumbs?.url3,
            createdAt: numberValue(file.server_ctime) * 1000,
            modifiedAt: numberValue(file.server_mtime) * 1000,
          }),
        ),
      );
      if (files.length < limit) break;
      start += limit;
      if (start / limit >= MAX_PROVIDER_PAGES) {
        throw new Error('百度网盘当前目录分页过多，请缩小根目录范围后重试');
      }
    }
    return items;
  }

  async getDownloadLink(account: CloudAccount, item: CloudItem): Promise<DownloadLink> {
    const response = await this.get<
      BaiduEnvelope & { list: Array<{ dlink?: string }> }
    >(account, '/xpan/multimedia', {
      method: 'filemetas',
      fsids: `[${item.id}]`,
      dlink: 1,
    });
    const dlink = response.list?.[0]?.dlink;
    if (!dlink) throw new Error('百度网盘未返回下载地址');
    const separator = dlink.includes('?') ? '&' : '?';
    return {
      url: `${dlink}${separator}access_token=${encodeURIComponent(requireCredential(account, 'accessToken'))}`,
      headers: { 'User-Agent': USER_AGENT },
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
  }

  async search(
    account: CloudAccount,
    keyword: string,
    options: CloudSearchOptions = {},
  ): Promise<CloudItem[]> {
    const response = await this.get<BaiduEnvelope & { list?: BaiduFile[] }>(account, '/xpan/file', {
      method: 'search',
      key: keyword,
      dir: options.folder?.path || account.credentials.rootPath || '/',
      recursion: 1,
      page: 1,
      num: Math.min(1000, options.limit ?? 200),
      web: 'web',
    });
    return providerArray<BaiduFile>(response.list, '百度网盘').map((file) =>
      providerItem(account, 'baidu', {
        id: stringValue(file.fs_id),
        parentId: file.path.slice(0, Math.max(1, file.path.lastIndexOf('/'))),
        name: file.server_filename,
        path: file.path,
        isFolder: numberValue(file.isdir) === 1,
        size: numberValue(file.size),
        mimeType: guessMimeType(file.server_filename),
        thumbnailUrl: file.thumbs?.url3,
        createdAt: numberValue(file.server_ctime) * 1000,
        modifiedAt: numberValue(file.server_mtime) * 1000,
      }),
    );
  }

  async createFolder(account: CloudAccount, parent: CloudFolder, name: string): Promise<void> {
    await this.postForm(account, '/xpan/file', { method: 'create' }, {
      path: joinCloudPath(parent.path || parent.id || '/', name),
      size: 0,
      isdir: 1,
      rtype: 3,
    });
  }

  private async manage(
    account: CloudAccount,
    operation: 'rename' | 'move' | 'copy' | 'delete',
    filelist: unknown,
  ): Promise<void> {
    await this.postForm(account, '/xpan/file', { method: 'filemanager', opera: operation }, {
      async: 0,
      filelist: JSON.stringify(filelist),
      ondup: 'fail',
    });
  }

  async rename(account: CloudAccount, item: CloudItem, name: string): Promise<void> {
    if (!item.path) throw new Error('百度文件缺少路径，请刷新目录后重试');
    await this.manage(account, 'rename', [{ path: item.path, newname: name }]);
  }

  async move(account: CloudAccount, items: CloudItem[], destination: CloudFolder): Promise<void> {
    const destinationPath = destination.path || destination.id;
    if (items.some((item) => !item.path)) throw new Error('部分百度文件缺少路径，请刷新目录后重试');
    await this.manage(account, 'move', items.map((item) => ({
      path: item.path,
      dest: destinationPath,
      newname: item.name,
    })));
  }

  async copy(account: CloudAccount, items: CloudItem[], destination: CloudFolder): Promise<void> {
    const destinationPath = destination.path || destination.id;
    if (items.some((item) => !item.path)) throw new Error('部分百度文件缺少路径，请刷新目录后重试');
    await this.manage(account, 'copy', items.map((item) => ({
      path: item.path,
      dest: destinationPath,
      newname: item.name,
    })));
  }

  async delete(account: CloudAccount, items: CloudItem[]): Promise<void> {
    const paths = items.map((item) => item.path).filter((value): value is string => !!value);
    if (paths.length !== items.length) throw new Error('部分百度文件缺少路径，请刷新目录后重试');
    await this.manage(account, 'delete', paths);
  }

  async upload(
    account: CloudAccount,
    folder: CloudFolder,
    source: CloudUploadSource,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<void> {
    assertUploadSource(source);
    if (source.size < 1) throw new Error('百度网盘不支持上传空文件');
    const blockSize = 4 * 1024 * 1024;
    const blockCount = Math.ceil(source.size / blockSize);
    if (blockCount > 10_000) throw new Error('文件过大，超出百度网盘分片任务上限');
    const path = joinCloudPath(folder.path || folder.id || '/', source.name);
    reportUpload(onProgress, 0, source.size, '正在校验文件');
    const [contentMd5, sliceMd5, blockHashes] = await Promise.all([
      hashFile(source.uri, 'md5'),
      hashRange(source.uri, 0, Math.min(source.size, 256 * 1024), 'md5'),
      hashChunks(source.uri, blockSize, 'md5'),
    ]);
    assertUploadSource(source);
    const createdAt = Math.floor((source.createdAt ?? Date.now()) / 1000);
    const modifiedAt = Math.floor((source.modifiedAt ?? Date.now()) / 1000);
    const precreate = await this.postForm<BaiduPrecreate>(account, '/xpan/file', { method: 'precreate' }, {
      path,
      size: source.size,
      isdir: 0,
      autoinit: 1,
      rtype: 3,
      block_list: JSON.stringify(blockHashes),
      'content-md5': contentMd5,
      'slice-md5': sliceMd5,
      local_ctime: createdAt,
      local_mtime: modifiedAt,
    });
    if (precreate.return_type === 2) {
      reportUpload(onProgress, source.size, source.size, '秒传完成');
      return;
    }
    if (!precreate.uploadid) throw new Error('百度网盘未返回 Upload ID');

    const uploadServer = providerObject<BaiduUploadServer>(
      await requestJson<BaiduUploadServer>(withQuery(
        'https://d.pcs.baidu.com/rest/2.0/pcs/file',
        {
          method: 'locateupload',
          appid: '250528',
          path,
          uploadid: precreate.uploadid,
          upload_version: '2.0',
          access_token: requireCredential(account, 'accessToken'),
        },
      )),
      '百度网盘',
    );
    if (uploadServer.error_code) throw new Error(uploadServer.error_msg || `百度上传错误：${uploadServer.error_code}`);
    const server = uploadServer.servers?.[0]?.server || uploadServer.bak_servers?.[0]?.server;
    if (!server) throw new Error('百度网盘未返回上传服务器');
    const partIndexes = precreate.block_list?.length
      ? precreate.block_list
      : blockHashes.map((_, index) => index);
    const uniquePartIndexes = new Set(partIndexes);
    if (
      uniquePartIndexes.size !== partIndexes.length ||
      partIndexes.some((value) => (
        !Number.isSafeInteger(value) || value < 0 || value >= blockHashes.length
      ))
    ) {
      throw new Error('百度网盘返回了无效或重复的分片编号');
    }

    let completed = 0;
    for (const partIndex of partIndexes) {
      const start = partIndex * blockSize;
      const length = Math.min(blockSize, source.size - start);
      const url = withQuery(`${server.replace(/\/$/, '')}/rest/2.0/pcs/superfile2`, {
        method: 'upload',
        access_token: requireCredential(account, 'accessToken'),
        type: 'tmpfile',
        path,
        uploadid: precreate.uploadid,
        partseq: partIndex,
      });
      await uploadRange({
        url,
        source,
        start,
        length,
        multipart: true,
        fieldName: 'file',
        onProgress: (sent) => reportUpload(
          onProgress,
          Math.min(source.size, completed + sent),
          source.size,
          '正在上传',
        ),
      });
      completed += length;
    }
    reportUpload(onProgress, Math.max(0, source.size - 1), source.size, '正在合并文件');
    await this.postForm(account, '/xpan/file', { method: 'create' }, {
      path,
      size: source.size,
      isdir: 0,
      rtype: 3,
      uploadid: precreate.uploadid,
      block_list: JSON.stringify(blockHashes),
      local_ctime: createdAt,
      local_mtime: modifiedAt,
    });
    reportUpload(onProgress, source.size, source.size, '上传完成');
  }
}
