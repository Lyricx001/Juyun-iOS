import * as Crypto from 'expo-crypto';
import { providerDefinitions } from '../config/providers';
import { aesEcbEncryptHex, hashChunks, hashFile, hmac, rsaEncryptBase64 } from '../native/juyunNative';
import type {
  CloudAccount,
  CloudFolder,
  CloudItem,
  CloudProvider,
  CloudUploadSource,
  DownloadLink,
  UploadProgress,
} from '../types/cloud';
import { requestJson, withQuery } from '../utils/http';
import { assertUploadSource, md5Text, reportUpload, uploadRange } from '../utils/upload';
import {
  assertDirectoryCapacity,
  capabilities,
  guessMimeType,
  MAX_PROVIDER_PAGES,
  numberValue,
  providerArray,
  providerItem,
  providerObject,
  requireCredential,
  shouldContinueProviderPagination,
  stringValue,
} from './providerUtils';

interface TianyiFile {
  id: number | string;
  name: string;
  size?: number;
  lastOpTime?: string;
  icon?: { smallUrl?: string };
}

interface TianyiFolder {
  id: number | string;
  name: string;
  lastOpTime?: string;
}

interface TianyiResponse {
  res_code?: number;
  res_message?: string;
  errorCode?: string;
  errorMsg?: string;
  fileListAO?: {
    count?: number;
    fileList?: TianyiFile[];
    folderList?: TianyiFolder[];
  };
  downloadUrl?: string;
  sessionKey?: string;
  pubKey?: string;
  pkId?: string;
  expire?: number;
}

interface TianyiUploadResponse<T = Record<string, unknown>> {
  code?: string;
  msg?: string;
  data?: T;
  uploadUrls?: Record<string, { requestURL?: string; requestHeader?: string }>;
}

const BASE = 'https://cloud.189.cn';

export class TianyiProvider implements CloudProvider {
  readonly definition = providerDefinitions.tianyi;
  readonly capabilities = capabilities('upload', 'createFolder', 'rename', 'move', 'copy', 'delete');
  private rsaCache = new Map<string, { publicKey: string; pkId: string; expiresAt: number }>();

  private async request(
    account: CloudAccount,
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    method: 'GET' | 'POST' = 'GET',
    values?: Record<string, string | number | boolean | undefined>,
  ): Promise<TianyiResponse> {
    const body = values ? new URLSearchParams() : undefined;
    if (body && values) {
      Object.entries(values).forEach(([key, value]) => {
        if (value !== undefined && value !== '') body.set(key, String(value));
      });
    }
    const response = providerObject<TianyiResponse>(
      await requestJson<TianyiResponse>(
        withQuery(`${BASE}${path}`, { ...query, noCache: Math.random() }),
        {
          method,
          headers: {
            Accept: 'application/json;charset=UTF-8',
            Cookie: requireCredential(account, 'cookie', 'Cookie'),
            Referer: `${BASE}/`,
            ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          },
          body: body?.toString(),
        },
      ),
      '天翼云盘',
    );
    if (response.errorCode) throw new Error(response.errorMsg || `天翼云盘错误：${response.errorCode}`);
    if (response.res_code && response.res_code !== 0) {
      throw new Error(response.res_message || `天翼云盘错误码：${response.res_code}`);
    }
    return response;
  }

  async list(account: CloudAccount, folder: CloudFolder): Promise<CloudItem[]> {
    const items: CloudItem[] = [];
    let page = 1;
    const seenPages = new Set<string>();
    while (true) {
      const response = await this.request(account, '/api/open/file/listFiles.action', {
        pageSize: 60,
        pageNum: page,
        mediaType: 0,
        folderId: folder.id || account.credentials.rootId || '-11',
        iconOption: 5,
        orderBy: 'lastOpTime',
        descending: true,
      });
      const folders = providerArray<TianyiFolder>(response.fileListAO?.folderList, '天翼云盘');
      const files = providerArray<TianyiFile>(response.fileListAO?.fileList, '天翼云盘');
      assertDirectoryCapacity(items.length, folders.length + files.length, '天翼云盘');
      const pageSignature = [
        folders[0]?.id,
        folders.at(-1)?.id,
        files[0]?.id,
        files.at(-1)?.id,
        folders.length,
        files.length,
      ].join(':');
      if (folders.length + files.length > 0 && seenPages.has(pageSignature)) {
        throw new Error('天翼云盘返回了重复的目录分页，请稍后重试');
      }
      if (folders.length + files.length > 0) seenPages.add(pageSignature);
      items.push(
        ...folders.map((value) =>
          providerItem(account, 'tianyi', {
            id: stringValue(value.id),
            parentId: folder.id,
            name: value.name,
            isFolder: true,
            size: 0,
            modifiedAt: value.lastOpTime ? Date.parse(value.lastOpTime.replace(/-/g, '/')) : undefined,
          }),
        ),
        ...files.map((value) =>
          providerItem(account, 'tianyi', {
            id: stringValue(value.id),
            parentId: folder.id,
            name: value.name,
            isFolder: false,
            size: numberValue(value.size),
            mimeType: guessMimeType(value.name),
            thumbnailUrl: value.icon?.smallUrl,
            modifiedAt: value.lastOpTime ? Date.parse(value.lastOpTime.replace(/-/g, '/')) : undefined,
          }),
        ),
      );
      const pageItemCount = folders.length + files.length;
      const reportedTotal = numberValue(response.fileListAO?.count);
      if (!shouldContinueProviderPagination(items.length, pageItemCount, 60, reportedTotal)) break;
      page += 1;
      if (page > MAX_PROVIDER_PAGES) {
        throw new Error('天翼云盘当前目录分页过多，请缩小根目录范围后重试');
      }
    }
    return items;
  }

  async getDownloadLink(account: CloudAccount, item: CloudItem): Promise<DownloadLink> {
    const response = await this.request(account, '/api/portal/getFileInfo.action', { fileId: item.id });
    const rawUrl = stringValue(response.downloadUrl);
    if (!rawUrl) throw new Error('天翼云盘未返回下载地址');
    const url = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl.replace(/^http:\/\//, 'https://');
    return {
      url,
      headers: {
        Cookie: requireCredential(account, 'cookie'),
        Referer: `${BASE}/`,
      },
    };
  }

  async createFolder(account: CloudAccount, parent: CloudFolder, name: string): Promise<void> {
    await this.request(account, '/api/open/file/createFolder.action', {}, 'POST', {
      parentFolderId: parent.id,
      folderName: name,
    });
  }

  async rename(account: CloudAccount, item: CloudItem, name: string): Promise<void> {
    await this.request(
      account,
      item.isFolder ? '/api/open/file/renameFolder.action' : '/api/open/file/renameFile.action',
      {},
      'POST',
      item.isFolder
        ? { folderId: item.id, destFolderName: name }
        : { fileId: item.id, destFileName: name },
    );
  }

  private async batch(
    account: CloudAccount,
    type: 'MOVE' | 'COPY' | 'DELETE',
    items: CloudItem[],
    destination?: CloudFolder,
  ): Promise<void> {
    if (!items.length) return;
    await this.request(account, '/api/open/batch/createBatchTask.action', {}, 'POST', {
      type,
      targetFolderId: destination?.id ?? '',
      taskInfos: JSON.stringify(items.map((item) => ({
        fileId: item.id,
        fileName: item.name,
        isFolder: item.isFolder ? 1 : 0,
      }))),
    });
  }

  async move(account: CloudAccount, items: CloudItem[], destination: CloudFolder): Promise<void> {
    await this.batch(account, 'MOVE', items, destination);
  }

  async copy(account: CloudAccount, items: CloudItem[], destination: CloudFolder): Promise<void> {
    await this.batch(account, 'COPY', items, destination);
  }

  async delete(account: CloudAccount, items: CloudItem[]): Promise<void> {
    await this.batch(account, 'DELETE', items);
  }

  private async getSessionKey(account: CloudAccount): Promise<string> {
    const response = await this.request(account, '/v2/getUserBriefInfo.action', {});
    if (!response.sessionKey) throw new Error('天翼云盘未返回上传 Session Key，请更新 Cookie');
    return response.sessionKey;
  }

  private async getRsaKey(account: CloudAccount): Promise<{ publicKey: string; pkId: string }> {
    const cacheId = `${account.id}:${account.updatedAt}`;
    const cached = this.rsaCache.get(cacheId);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached;
    const response = await this.request(account, '/api/security/generateRsaKey.action', {});
    if (!response.pubKey || !response.pkId) throw new Error('天翼云盘未返回上传加密公钥');
    const rawExpiry = numberValue(response.expire);
    const now = Date.now();
    const expiresAt = rawExpiry >= 1_000_000_000_000
      ? rawExpiry
      : rawExpiry >= 1_000_000_000
        ? rawExpiry * 1000
        : rawExpiry > 86_400
          ? now + rawExpiry
          : rawExpiry > 0
            ? now + rawExpiry * 1000
            : now + 5 * 60_000;
    const value = {
      publicKey: response.pubKey,
      pkId: response.pkId,
      expiresAt,
    };
    for (const key of this.rsaCache.keys()) {
      if (key.startsWith(`${account.id}:`) && key !== cacheId) this.rsaCache.delete(key);
    }
    this.rsaCache.set(cacheId, value);
    return value;
  }

  private async uploadRequest<T>(
    account: CloudAccount,
    sessionKey: string,
    uri: string,
    values: Record<string, string>,
  ): Promise<TianyiUploadResponse<T>> {
    const randomBytes = Crypto.getRandomBytes(16);
    const hex = Array.from(randomBytes).map((value) => value.toString(16).padStart(2, '0')).join('');
    const secret = hex.slice(0, 16 + ((randomBytes[0] ?? 0) % 16));
    const plaintext = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('&');
    const encryptedParams = await aesEcbEncryptHex(plaintext, secret.slice(0, 16));
    const requestDate = String(Date.now());
    const signatureText = `SessionKey=${sessionKey}&Operate=GET&RequestURI=${uri}&Date=${requestDate}&params=${encryptedParams}`;
    const [rsaKey, signature] = await Promise.all([
      this.getRsaKey(account),
      hmac(signatureText, secret, 'sha1', 'utf8', 'hex'),
    ]);
    const encryptionText = await rsaEncryptBase64(secret, rsaKey.publicKey);
    const response = providerObject<TianyiUploadResponse<T>>(
      await requestJson<TianyiUploadResponse<T>>(
        `https://upload.cloud.189.cn${uri}?params=${encryptedParams}`,
        {
          headers: {
            Accept: 'application/json;charset=UTF-8',
            Cookie: requireCredential(account, 'cookie', 'Cookie'),
            SessionKey: sessionKey,
            Signature: signature,
            'X-Request-Date': requestDate,
            'X-Request-ID': Crypto.randomUUID(),
            EncryptionText: encryptionText,
            PkId: rsaKey.pkId,
          },
        },
      ),
      '天翼云盘',
    );
    if (response.code && response.code !== 'SUCCESS') {
      throw new Error(response.msg || `天翼上传错误：${response.code}`);
    }
    return response;
  }

  async upload(
    account: CloudAccount,
    folder: CloudFolder,
    source: CloudUploadSource,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<void> {
    assertUploadSource(source);
    const partSize = 10 * 1024 * 1024;
    if (Math.ceil(source.size / partSize) > 10_000) {
      throw new Error('文件过大，超出天翼云盘分片任务上限');
    }
    reportUpload(onProgress, 0, source.size, '正在校验文件');
    const [sessionKey, fileMd5, chunkMd5s] = await Promise.all([
      this.getSessionKey(account),
      hashFile(source.uri, 'md5'),
      hashChunks(source.uri, partSize, 'md5'),
    ]);
    const upperChunkMd5s = chunkMd5s.map((value) => value.toUpperCase());
    const sliceMd5 = source.size > partSize && upperChunkMd5s.length
      ? await md5Text(upperChunkMd5s.join('\n'))
      : fileMd5;
    assertUploadSource(source);
    const encodedName = new URLSearchParams({ value: source.name }).toString().slice('value='.length);
    const initialized = await this.uploadRequest<{
      uploadFileId?: string;
      fileDataExists?: number;
    }>(account, sessionKey, '/person/initMultiUpload', {
      parentFolderId: folder.id,
      fileName: encodedName,
      fileSize: String(source.size),
      sliceSize: String(partSize),
      fileMd5,
      sliceMd5,
    });
    const uploadFileId = initialized.data?.uploadFileId;
    if (!uploadFileId) throw new Error('天翼云盘未返回 Upload File ID');
    if (numberValue(initialized.data?.fileDataExists) !== 1) {
      let completed = 0;
      for (let index = 0; index < chunkMd5s.length; index += 1) {
        const partNumber = index + 1;
        const partMd5 = chunkMd5s[index];
        if (!partMd5) throw new Error(`天翼云盘缺少第 ${partNumber} 个分片校验值`);
        let binary = '';
        for (let offset = 0; offset < partMd5.length; offset += 2) {
          binary += String.fromCharCode(Number.parseInt(partMd5.slice(offset, offset + 2), 16));
        }
        const urls = await this.uploadRequest(account, sessionKey, '/person/getMultiUploadUrls', {
          partInfo: `${partNumber}-${globalThis.btoa(binary)}`,
          uploadFileId,
        });
        const part = urls.uploadUrls?.[`partNumber_${partNumber}`];
        if (!part?.requestURL || !part.requestHeader) {
          throw new Error(`天翼云盘未返回第 ${partNumber} 个分片地址`);
        }
        const headers: Record<string, string> = {};
        const headerText = part.requestHeader.includes('=')
          ? part.requestHeader
          : decodeURIComponent(part.requestHeader);
        new URLSearchParams(headerText).forEach((value, key) => {
          if (key) headers[key] = value;
        });
        const start = index * partSize;
        const length = Math.min(partSize, source.size - start);
        await uploadRange({
          url: part.requestURL,
          source,
          start,
          length,
          headers,
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
    await this.uploadRequest(account, sessionKey, '/person/commitMultiUploadFile', {
      uploadFileId,
      fileMd5,
      sliceMd5,
      lazyCheck: '1',
      opertype: '3',
    });
    reportUpload(onProgress, source.size, source.size, '上传完成');
  }
}
