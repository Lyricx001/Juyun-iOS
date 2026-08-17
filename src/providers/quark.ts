import * as Crypto from 'expo-crypto';
import { providerDefinitions } from '../config/providers';
import { hashFile, readRangeBase64 } from '../native/juyunNative';
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
import { epochMilliseconds } from '../utils/format';
import { assertUploadSource, headerValue, md5Text, reportUpload, uploadRange } from '../utils/upload';
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
  stringValue,
} from './providerUtils';

interface QuarkResponse<T> {
  status?: number;
  errno?: number;
  error_info?: string;
  data?: T;
}

interface QuarkFile {
  fid: string;
  parent_fid: string;
  filename: string;
  size: number;
  file_type: string;
  thumbnail_url?: string;
  created_at?: number;
  updated_at?: number;
}

const API = 'https://open-api-drive.quark.cn';
const USER_AGENT = 'go-resty/3.0.0-beta.1 (https://resty.dev)';

export class QuarkProvider implements CloudProvider {
  readonly definition = providerDefinitions.quark;
  readonly capabilities = capabilities('upload', 'createFolder', 'rename', 'move', 'delete');

  private async request<T extends object = Record<string, unknown>>(
    account: CloudAccount,
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
    manualSign?: { timestamp: string; signature: string; requestId: string },
  ): Promise<T> {
    const timestamp = manualSign?.timestamp ?? String(Date.now());
    const signature = manualSign?.signature ?? await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      `${method}&${path}&${timestamp}&${requireCredential(account, 'signKey', 'Sign Key')}`,
    );
    const url = withQuery(`${API}${path}`, {
      req_id: manualSign?.requestId ?? Crypto.randomUUID(),
      access_token: requireCredential(account, 'accessToken', 'Access Token'),
    });
    const response = providerObject<QuarkResponse<T>>(
      await requestJson<QuarkResponse<T>>(url, {
        method,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          'x-pan-tm': timestamp,
          'x-pan-token': signature,
          'x-pan-client-id': requireCredential(account, 'appId', 'App ID'),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
      '夸克网盘',
    );
    if (response.errno && response.errno !== 0) {
      throw new Error(response.error_info || `夸克网盘错误码：${response.errno}`);
    }
    if (response.status && response.status >= 400) {
      throw new Error(response.error_info || `夸克网盘请求失败：${response.status}`);
    }
    return providerObject<T>(response.data ?? {}, '夸克网盘');
  }

  async list(account: CloudAccount, folder: CloudFolder): Promise<CloudItem[]> {
    const items: CloudItem[] = [];
    let cursor: { version?: string; token?: string } | undefined;
    const seenCursors = new Set<string>();
    while (true) {
      const response = await this.request<{
        file_list?: QuarkFile[];
        last_page?: boolean;
        next_query_cursor?: { version?: string; token?: string };
      }>(account, '/open/v1/file/list', 'POST', {
        parent_fid: folder.id || account.credentials.rootId || '0',
        size: 100,
        sort: 'file_name:asc',
        ...(cursor?.token ? { query_cursor: cursor } : {}),
      });
      const files = providerArray<QuarkFile>(response.file_list, '夸克网盘');
      assertDirectoryCapacity(items.length, files.length, '夸克网盘');
      items.push(
        ...files.map((file) =>
          providerItem(account, 'quark', {
            id: file.fid,
            parentId: file.parent_fid,
            name: file.filename,
            isFolder: String(file.file_type) === '0',
            size: numberValue(file.size),
            mimeType: guessMimeType(file.filename),
            thumbnailUrl: file.thumbnail_url,
            createdAt: epochMilliseconds(file.created_at),
            modifiedAt: epochMilliseconds(file.updated_at),
          }),
        ),
      );
      cursor = response.next_query_cursor;
      if (response.last_page || !cursor?.token) break;
      const cursorKey = `${cursor.version ?? ''}:${cursor.token}`;
      if (seenCursors.has(cursorKey) || seenCursors.size >= MAX_PROVIDER_PAGES) {
        throw new Error('夸克网盘返回了重复的分页游标，请稍后重试');
      }
      seenCursors.add(cursorKey);
    }
    return items;
  }

  async getDownloadLink(account: CloudAccount, item: CloudItem): Promise<DownloadLink> {
    const response = await this.request<{ download_url?: string }>(
      account,
      '/open/v1/file/get_download_url',
      'POST',
      { fid: item.id },
    );
    const url = stringValue(response.download_url);
    if (!url) throw new Error('夸克网盘未返回下载地址');
    return {
      url,
      headers: {
        Cookie: `x_pan_client_id=${requireCredential(account, 'appId')}; x_pan_access_token=${requireCredential(account, 'accessToken')}`,
      },
    };
  }

  async createFolder(account: CloudAccount, parent: CloudFolder, name: string): Promise<void> {
    await this.request(account, '/open/v1/dir', 'POST', {
      dir_path: name,
      pdir_fid: parent.id || '0',
    });
  }

  async rename(account: CloudAccount, item: CloudItem, name: string): Promise<void> {
    await this.request(account, '/open/v1/file/rename', 'POST', {
      fid: item.id,
      file_name: name,
      conflict_mode: 'REUSE',
    });
  }

  async move(account: CloudAccount, items: CloudItem[], destination: CloudFolder): Promise<void> {
    if (!items.length) return;
    await this.request(account, '/open/v1/file/move', 'POST', {
      action_type: 1,
      fid_list: items.map((item) => item.id),
      to_pdir_fid: destination.id,
    });
  }

  async delete(account: CloudAccount, items: CloudItem[]): Promise<void> {
    if (!items.length) return;
    await this.request(account, '/open/v1/file/delete', 'POST', {
      action_type: 1,
      fid_list: items.map((item) => item.id),
    });
  }

  async upload(
    account: CloudAccount,
    folder: CloudFolder,
    source: CloudUploadSource,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<void> {
    assertUploadSource(source);
    reportUpload(onProgress, 0, source.size, '正在校验文件');
    const [{ user_id: userId }, md5, sha1] = await Promise.all([
      this.request<{ user_id?: string }>(account, '/open/v1/user/info', 'GET'),
      hashFile(source.uri, 'md5'),
      hashFile(source.uri, 'sha1'),
    ]);
    if (!userId) throw new Error('夸克网盘未返回用户 ID');

    const uploadPath = '/open/v1/file/upload_pre';
    const timestamp = String(Date.now());
    const signature = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      `POST&${uploadPath}&${timestamp}&${requireCredential(account, 'signKey', 'Sign Key')}`,
    );
    const requestId = Crypto.randomUUID();
    const proofSeed1 = await md5Text(`${userId}${signature}`);
    const proofSeed2 = await md5Text(String(source.size));

    const proofCode = async (seed: string): Promise<string> => {
      if (!source.size) return '';
      const rangeHash = await md5Text(seed);
      const start = Number(BigInt(`0x${rangeHash.slice(0, 16)}`) % BigInt(source.size));
      return readRangeBase64(source.uri, start, Math.min(8, source.size - start));
    };
    const [proofCode1, proofCode2] = await Promise.all([
      proofCode(proofSeed1),
      proofCode(proofSeed2),
    ]);
    assertUploadSource(source);
    const now = Date.now();
    const pre = await this.request<{
      finish?: boolean;
      task_id?: string;
      part_size?: number;
    }>(
      account,
      uploadPath,
      'POST',
      {
        file_name: source.name,
        size: source.size,
        format_type: source.mimeType || 'application/octet-stream',
        md5,
        sha1,
        l_created_at: source.createdAt ?? now,
        l_updated_at: source.modifiedAt ?? now,
        pdir_fid: folder.id || '0',
        same_path_reuse: true,
        proof_version: 'v1',
        proof_seed1: proofSeed1,
        proof_seed2: proofSeed2,
        proof_code1: proofCode1,
        proof_code2: proofCode2,
      },
      { timestamp, signature, requestId },
    );
    if (pre.finish) {
      reportUpload(onProgress, source.size, source.size, '秒传完成');
      return;
    }
    const partSize = Math.floor(numberValue(pre.part_size));
    if (!pre.task_id || partSize <= 0) throw new Error('夸克网盘未返回上传任务信息');
    const partCount = Math.max(1, Math.ceil(source.size / partSize));
    if (!Number.isSafeInteger(partSize) || partCount > 10_000) {
      throw new Error('夸克网盘返回的上传分片配置无效');
    }
    const partInfoList = Array.from({ length: partCount }, (_, index) => ({
      part_number: index + 1,
      part_size: Math.max(0, Math.min(partSize, source.size - index * partSize)),
    }));
    const urlInfo = await this.request<{
      upload_urls?: Array<{
        upload_url?: string;
        signature_info?: { signature?: string };
      }>;
      common_headers?: {
        'X-Oss-Date'?: string;
        'X-Oss-Content-Sha256'?: string;
      };
    }>(account, '/open/v1/file/get_upload_urls', 'POST', {
      task_id: pre.task_id,
      part_info_list: partInfoList,
    });
    const urls = providerArray<{
      upload_url?: string;
      signature_info?: { signature?: string };
    }>(urlInfo.upload_urls, '夸克网盘');
    if (urls.length !== partCount) throw new Error('夸克网盘返回的分片地址不完整');
    const ossDate = urlInfo.common_headers?.['X-Oss-Date'];
    const contentHash = urlInfo.common_headers?.['X-Oss-Content-Sha256'];
    if (!ossDate || !contentHash) throw new Error('夸克网盘返回的上传请求头不完整');
    const etags: string[] = [];
    let completed = 0;
    for (let index = 0; index < urls.length; index += 1) {
      const part = urls[index];
      if (!part?.upload_url || !part.signature_info?.signature) {
        throw new Error(`夸克网盘未返回第 ${index + 1} 个分片凭证`);
      }
      const uploadUrl = part.upload_url;
      const signature = part.signature_info.signature;
      const partInfo = partInfoList[index];
      if (!partInfo) throw new Error(`夸克网盘缺少第 ${index + 1} 个分片信息`);
      const start = index * partSize;
      const length = partInfo.part_size;
      const result = await uploadRange({
        url: uploadUrl,
        source,
        start,
        length,
        headers: {
          Authorization: signature,
          'X-Oss-Date': ossDate,
          'X-Oss-Content-Sha256': contentHash,
        },
        onProgress: (sent) => reportUpload(
          onProgress,
          Math.min(source.size, completed + sent),
          source.size,
          '正在上传',
        ),
      });
      const etag = headerValue(result.headers, 'etag');
      if (!etag) throw new Error(`夸克网盘第 ${index + 1} 个分片缺少 ETag`);
      etags.push(etag);
      completed += length;
    }
    const finished = await this.request<{ finish?: boolean }>(account, '/open/v1/file/upload_finish', 'POST', {
      task_id: pre.task_id,
      part_info_list: partInfoList.map((part, index) => ({ ...part, etag: etags[index] })),
    });
    if (finished.finish === false) throw new Error('夸克网盘未能完成上传任务');
    reportUpload(onProgress, source.size, source.size, '上传完成');
  }
}
