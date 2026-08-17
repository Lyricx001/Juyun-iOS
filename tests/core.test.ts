import assert from 'node:assert/strict';
import test from 'node:test';
import { providerDefinitions, providerOrder } from '../src/config/providers';
import type { CloudAccount } from '../src/types/cloud';
import {
  getAccountRoot,
  hasSameCredentialSnapshot,
  normalizeStoredAccount,
} from '../src/utils/account';
import { mapWithConcurrency, singleFlight } from '../src/utils/async';
import {
  cloudNameError,
  epochMilliseconds,
  fileTypeLabel,
  formatBytes,
  formatDate,
  isAudioItem,
  isVideoItem,
  previewKind,
  safeLocalFilename,
  sanitizeFilename,
} from '../src/utils/format';
import {
  assertDownloadLink,
  DownloadRunRegistry,
  isExpectedDownloadFileSize,
  isSameLocalFileUri,
  isHttpUrl,
  limitDownloadHistory,
  normalizedLocalFilePath,
  normalizeDownloadRecords,
  normalizeDownloadResumeState,
  orderDownloadJournalCandidates,
  parseDownloadMetadataText,
  reconcileDownloadProgress,
} from '../src/utils/downloads';
import { assertHttpHeaders, filterHttpHeaderRecord } from '../src/utils/headers';
import { formBody, requestJson, withQuery } from '../src/utils/http';
import {
  assertDirectoryCapacity,
  MAX_DIRECTORY_ITEMS,
  normalizeProviderItem,
  providerArray,
  providerObject,
  shouldContinueProviderPagination,
  isItemAlreadyInFolder,
  uniqueCloudItems,
} from '../src/utils/providerData';
import { splitUtf8 } from '../src/utils/storage';
import { canonicalQueryString } from '../src/utils/signing';

test('六家网盘都已注册且顺序稳定', () => {
  assert.deepEqual(providerOrder, ['115', 'baidu', 'quark', 'alipan', 'tianyi', 'xunlei']);
  for (const id of providerOrder) {
    assert.equal(providerDefinitions[id].id, id);
    assert.ok(providerDefinitions[id].fields.some((field) => field.required));
  }
});

test('网盘根目录会使用有效配置并为空白配置回退', () => {
  const account: CloudAccount = {
    id: 'baidu-test',
    providerId: 'baidu',
    displayName: '百度测试',
    credentials: { rootPath: '/电影' },
    createdAt: 1,
    updatedAt: 1,
  };
  assert.deepEqual(getAccountRoot(account), { id: '/电影', name: '根目录', path: '/电影' });
  assert.equal(getAccountRoot({
    ...account,
    id: 'baidu-blank-root',
    credentials: { rootPath: '   ' },
  }).id, '/');
  assert.equal(getAccountRoot({
    ...account,
    id: '115-blank-root',
    providerId: '115',
    credentials: { rootId: '   ' },
  }).id, '0');
  assert.equal(getAccountRoot({
    ...account,
    id: 'xunlei-blank-root',
    providerId: 'xunlei',
    credentials: { rootId: '   ' },
  }).id, '');
});

test('文件识别、大小格式和文件名清理', () => {
  assert.equal(isVideoItem('示例.MKV'), true);
  assert.equal(isVideoItem('无扩展名', 'video/mp4'), true);
  assert.equal(isVideoItem('说明.pdf', 'application/pdf'), false);
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(sanitizeFilename('a/b:c?.mp4'), 'a_b_c_.mp4');
  assert.equal(sanitizeFilename('.env'), '_.env');
  assert.match(sanitizeFilename('..'), /^下载_\d+$/);
  assert.equal(formatDate(Number.POSITIVE_INFINITY), '');
});

test('常见文件类型会进入对应预览器', () => {
  assert.equal(previewKind('电影.MKV'), 'video');
  assert.equal(previewKind('播客.flac'), 'audio');
  assert.equal(isAudioItem('未知文件', 'audio/mpeg'), true);
  assert.equal(previewKind('照片.HEIC'), 'image');
  assert.equal(previewKind('合同.docx'), 'document');
  assert.equal(previewKind('说明.md'), 'text');
  assert.equal(previewKind('组件.ts'), 'text');
  assert.equal(previewKind('录像.ts', 'video/mp2t'), 'video');
  assert.equal(previewKind('未知文件', ' Application/PDF; charset=binary '), 'document');
  assert.equal(previewKind('备份.7z'), 'archive');
  assert.equal(fileTypeLabel('合同.pdf'), '文档');
});

test('查询参数和表单编码不会拼出空字段', () => {
  const url = new URL(withQuery('https://example.com/files?existing=1', {
    parent_id: '根目录',
    page: 2,
    empty: '',
    missing: undefined,
  }));
  assert.equal(url.searchParams.get('existing'), '1');
  assert.equal(url.searchParams.get('parent_id'), '根目录');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.has('empty'), false);
  assert.equal(formBody({ pick_code: 'a+b', enabled: true, empty: '' }), 'pick_code=a%2Bb&enabled=true');
});

test('本机文件名会保留扩展名并限制 UTF-8 长度', () => {
  const name = safeLocalFilename(`${'云'.repeat(200)}.pdf`);
  assert.ok(name.endsWith('.pdf'));
  assert.ok(new TextEncoder().encode(name).length <= 180);
  const tinyName = safeLocalFilename('云端文件.很长扩展名', 12);
  assert.ok(new TextEncoder().encode(tinyName).length <= 12);
  assert.throws(() => safeLocalFilename('文件.txt', 3), /长度上限/);
  assert.equal(cloudNameError('正常名称'), null);
  assert.match(cloudNameError('../目录') ?? '', /斜杠/);
  assert.match(cloudNameError('..') ?? '', /不能/);
});

test('长 Cookie 可按 UTF-8 安全拆分并无损恢复', () => {
  const value = `COOKIE=${'天翼云盘;'.repeat(900)}`;
  const chunks = splitUtf8(value, 127);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), value);
  assert.ok(chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 127));
});

test('下载记录恢复时会过滤损坏数据并校正进度', () => {
  const records = normalizeDownloadRecords([
    { id: 'broken' },
    {
      id: 'download-1',
      accountId: 'account-1',
      providerId: 'baidu',
      itemId: 'item-1',
      name: '文件.zip',
      status: 'paused',
      progress: 4,
      bytesWritten: -10,
      totalBytes: 100,
      createdAt: 10,
      resumeAvailable: true,
    },
  ]);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.ok(record);
  assert.equal(record.progress, 0);
  assert.equal(record.bytesWritten, 0);
  assert.equal(record.resumeAvailable, true);
  assert.deepEqual(
    normalizeDownloadResumeState({
      url: 'https://example.com/file',
      fileUri: 'file:///tmp/file.zip',
      isDirectory: false,
      resumeData: 'opaque',
      headers: {
        Authorization: 'token',
        'Bad Header': 'ignored',
        'X-Injected': 'value\r\nmalicious',
        invalid: 1,
      },
    })?.headers,
    { Authorization: 'token' },
  );
  assert.equal(normalizeDownloadResumeState({
    url: 'javascript:alert(1)',
    fileUri: 'file:///tmp/file.zip',
    isDirectory: false,
    resumeData: 'opaque',
  }), undefined);
  assert.equal(normalizeDownloadResumeState({
    url: 'https://example.com/file',
    fileUri: 'file:///tmp/file.zip',
    isDirectory: false,
    resumeData: 'opaque',
    expiresAt: 2_000,
  }, 1_000)?.expiresAt, 2_000);
  assert.equal(normalizeDownloadResumeState({
    url: 'https://example.com/file',
    fileUri: 'file:///tmp/file.zip',
    isDirectory: false,
    resumeData: 'opaque',
    expiresAt: 1_000,
  }, 1_000), undefined);
  assert.equal(normalizeDownloadResumeState({
    url: 'https://',
    fileUri: 'file:///tmp/file.zip',
    isDirectory: false,
    resumeData: 'opaque',
  }), undefined);
  assert.equal(normalizeDownloadResumeState({
    url: 'https://example.com/file',
    fileUri: 'file://server/tmp/file.zip',
    isDirectory: false,
    resumeData: 'opaque',
  }), undefined);
  assert.equal(normalizeDownloadResumeState({
    url: 'https://example.com/file',
    fileUri: 'file:///tmp/file.zip',
    isDirectory: false,
    resumeData: '云'.repeat(70_000),
  }), undefined);
  assert.equal(normalizeDownloadResumeState({
    url: 'https://example.com/file',
    fileUri: 'file:///tmp/file.zip',
    isDirectory: false,
    resumeData: 'r'.repeat(160_000),
    headers: { Authorization: 'a'.repeat(65_536) },
  }), undefined);
  assert.equal(isHttpUrl('https://example.com/file'), true);
  assert.equal(isHttpUrl(' https://example.com/file'), false);
  assert.equal(isHttpUrl('https://exa\nmple.com/file'), false);
  assert.equal(isHttpUrl('https://user:pass@example.com/file'), false);
  assert.equal(isHttpUrl('file:///tmp/file.zip'), false);
  assert.deepEqual(assertDownloadLink({
    url: 'https://example.com/file',
    headers: { Authorization: 'Bearer token' },
    expiresAt: 2_000,
  }, 1_000), {
    url: 'https://example.com/file',
    headers: { Authorization: 'Bearer token' },
    expiresAt: 2_000,
  });
  assert.throws(() => assertDownloadLink({
    url: 'https://example.com/file',
    expiresAt: 1_000,
  }, 1_000), /过期/);
  assert.throws(
    () => assertDownloadLink({ url: 'https://example.com', headers: { 'X-Test': 'ok\r\nInjected: 1' } }),
    /请求头/,
  );
  assert.throws(() => assertDownloadLink({ url: 'https://', expiresAt: Number.NaN }), /下载地址/);
  assert.equal(normalizeDownloadRecords([{
    ...record,
    id: 'download-2',
    localUri: 'https://example.com/not-local',
  }])[0]?.localUri, undefined);
  assert.equal(normalizeDownloadRecords([{
    ...record,
    id: 'download-remote-file-uri',
    localUri: 'file://server/tmp/file.zip',
  }])[0]?.localUri, undefined);
  assert.equal(normalizeDownloadRecords([records[0], records[0]]).length, 1);
  assert.equal(normalizeDownloadRecords([{
    ...record,
    id: 'download-3',
    bytesWritten: Number.MAX_VALUE,
    totalBytes: Number.MAX_VALUE,
  }])[0]?.bytesWritten, Number.MAX_SAFE_INTEGER);
});

test('下载进度不会倒退或缩小已知文件总大小', () => {
  assert.deepEqual(reconcileDownloadProgress(40, 100, 60, 50), {
    bytesWritten: 60,
    totalBytes: 100,
    progress: 0.6,
  });
  assert.deepEqual(reconcileDownloadProgress(60, 100, Number.NaN, -1), {
    bytesWritten: 60,
    totalBytes: 100,
    progress: 0.6,
  });
  assert.deepEqual(reconcileDownloadProgress(60, 100, 150, 120), {
    bytesWritten: 150,
    totalBytes: 150,
    progress: 1,
  });
  assert.deepEqual(reconcileDownloadProgress(64, 0, 128, 0), {
    bytesWritten: 128,
    totalBytes: 0,
    progress: 0,
  });
  const normalized = normalizeDownloadRecords([{
    id: 'download-inconsistent',
    accountId: 'account-1',
    providerId: 'baidu',
    itemId: 'item-1',
    name: '未知大小.bin',
    status: 'paused',
    progress: 1,
    bytesWritten: 128,
    totalBytes: 0,
    createdAt: 10,
  }])[0];
  assert.equal(normalized?.bytesWritten, 128);
  assert.equal(normalized?.totalBytes, 0);
  assert.equal(normalized?.progress, 0);
  assert.equal(isExpectedDownloadFileSize(100, 100), true);
  assert.equal(isExpectedDownloadFileSize(100, 99), false);
  assert.equal(isExpectedDownloadFileSize(0, 99), true);
  assert.equal(isExpectedDownloadFileSize(0, -1), false);
  assert.equal(isExpectedDownloadFileSize(undefined, 99), false);
});

test('本机文件 URI 会规范化并拒绝远程主机、查询参数和伪路径', () => {
  assert.equal(
    normalizedLocalFilePath('file:///tmp/cache/../%E6%96%87%E4%BB%B6.pdf'),
    '/tmp/文件.pdf',
  );
  assert.equal(
    isSameLocalFileUri('file:///tmp/cache/../file.pdf', 'file:///tmp/file.pdf'),
    true,
  );
  assert.equal(normalizedLocalFilePath('file://server/tmp/file.pdf'), null);
  assert.equal(normalizedLocalFilePath('file:///tmp/file.pdf?token=1'), null);
  assert.equal(normalizedLocalFilePath('https://example.com/file.pdf'), null);
  assert.equal(isSameLocalFileUri('file:///tmp/a.pdf', 'file:///tmp/b.pdf'), false);

  const runs = new DownloadRunRegistry();
  const first = runs.begin('download-1', 'file:///tmp/Downloads/file.pdf');
  assert.equal(runs.isCurrent('download-1', first.token), true);
  const resumed = runs.begin('download-1', 'file:///tmp/Downloads/file.pdf');
  assert.equal(runs.isCurrent('download-1', first.token), false);
  assert.equal(runs.isCurrent('download-1', resumed.token), true);
  assert.equal(runs.isReserved('file:///tmp/Downloads/../Downloads/file.pdf'), true);
  runs.finish('download-1', first);
  assert.equal(runs.isReserved('file:///tmp/Downloads/file.pdf'), true);
  runs.invalidate('download-1');
  assert.equal(runs.isCurrent('download-1', resumed.token), false);
  runs.finish('download-1', resumed);
  assert.equal(runs.isReserved('file:///tmp/Downloads/file.pdf'), false);
});

test('下载历史达到上限时会优先保留活动与暂停任务', () => {
  const base = {
    accountId: 'account-1',
    providerId: 'baidu' as const,
    itemId: 'item-1',
    name: '文件.bin',
    progress: 0,
    bytesWritten: 0,
    totalBytes: 0,
    createdAt: 1,
  };
  const records = [
    { ...base, id: 'failed-new', status: 'failed' as const },
    { ...base, id: 'paused', status: 'paused' as const },
    { ...base, id: 'completed-old', status: 'completed' as const },
    { ...base, id: 'failed-oldest', status: 'failed' as const },
  ];
  assert.deepEqual(
    limitDownloadHistory(records, 3).map((record) => record.id),
    ['failed-new', 'paused', 'completed-old'],
  );
  const pendingOnly = Array.from({ length: 4 }, (_, index) => ({
    ...base,
    id: `paused-${index}`,
    status: 'paused' as const,
  }));
  assert.equal(limitDownloadHistory(pendingOnly, 2).length, 4);
  assert.throws(() => limitDownloadHistory([], 0), /上限/);
  const legacyRecords = [
    ...Array.from({ length: 501 }, (_, index) => ({
      ...base,
      id: `history-${index}`,
      status: 'completed' as const,
    })),
    { ...base, id: 'legacy-paused', status: 'paused' as const, resumeAvailable: true },
  ];
  const migrated = normalizeDownloadRecords(legacyRecords, 500);
  assert.equal(migrated.length, 500);
  assert.equal(migrated.some((record) => record.id === 'legacy-paused'), true);
});

test('下载元数据会拒绝损坏主结构并保留有效记录', () => {
  const record = {
    id: 'download-valid',
    accountId: 'account-1',
    providerId: 'baidu',
    itemId: 'item-1',
    name: '文件.zip',
    status: 'completed',
    progress: 1,
    bytesWritten: 100,
    totalBytes: 100,
    createdAt: 10,
  };
  assert.equal(parseDownloadMetadataText(JSON.stringify([record]))[0]?.id, 'download-valid');
  assert.deepEqual(parseDownloadMetadataText('[]'), []);
  assert.throws(() => parseDownloadMetadataText('{}'), /结构无效/);
  assert.throws(() => parseDownloadMetadataText('[{"broken":true}]'), /已损坏/);
  assert.deepEqual(orderDownloadJournalCandidates([
    { value: 'stale-temporary', modifiedAt: 100, fallbackOrder: 0 },
    { value: 'new-primary', modifiedAt: 200, fallbackOrder: 1 },
  ]), ['new-primary', 'stale-temporary']);
  assert.deepEqual(orderDownloadJournalCandidates([
    { value: 'new-temporary', modifiedAt: 300, fallbackOrder: 0 },
    { value: 'old-primary', modifiedAt: 200, fallbackOrder: 1 },
  ]), ['new-temporary', 'old-primary']);
  assert.deepEqual(orderDownloadJournalCandidates([
    { value: 'temporary', modifiedAt: null, fallbackOrder: 1 },
    { value: 'primary', modifiedAt: Number.NaN, fallbackOrder: 0 },
  ]), ['primary', 'temporary']);
});

test('HTTP 请求头会阻止注入且空成功响应可正常返回', async () => {
  assert.doesNotThrow(() => assertHttpHeaders({ Authorization: 'Bearer token', 'X-Test': 'ok' }));
  assert.throws(() => assertHttpHeaders({ 'Bad Header': 'value' }), /请求头/);
  assert.throws(() => assertHttpHeaders({ 'X-Test': 'ok\r\nInjected: 1' }), /请求头/);
  assert.throws(() => assertHttpHeaders({ 'X-Test': 'ok\u0001bad' }), /请求头/);
  assert.throws(
    () => assertHttpHeaders({ Authorization: 'first', authorization: 'second' }),
    /请求头/,
  );
  assert.throws(
    () => assertHttpHeaders({ Authorization: '云'.repeat(22_000) }),
    /请求头/,
  );
  const oversizedHeaderSet = Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => [`X-Large-${index}`, 'a'.repeat(60_000)]),
  );
  assert.throws(() => assertHttpHeaders(oversizedHeaderSet), /请求头/);
  assert.equal(Object.keys(filterHttpHeaderRecord(oversizedHeaderSet) ?? {}).length, 4);
  assert.deepEqual(filterHttpHeaderRecord({
    Authorization: 'token',
    authorization: 'ignored duplicate',
    'Bad Header': 'ignored',
    'X-Injected': 'value\nmalicious',
  }), { Authorization: 'token' });

  const originalFetch = globalThis.fetch;
  const responses = [
    new Response(null, { status: 204 }),
    new Response('   ', { status: 200 }),
    new Response('too large', { status: 200 }),
    new Response('汉字', { status: 200 }),
  ];
  globalThis.fetch = (async () => responses.shift() ?? new Response(null, { status: 204 })) as typeof fetch;
  try {
    assert.deepEqual(await requestJson<Record<string, unknown>>('https://example.com/empty'), {});
    assert.deepEqual(await requestJson<Record<string, unknown>>('https://example.com/whitespace'), {});
    await assert.rejects(
      requestJson('https://example.com/large', { maxResponseChars: 4 }),
      /响应内容过大/,
    );
    await assert.rejects(
      requestJson('https://example.com/utf8-large', { maxResponseChars: 4 }),
      /响应内容过大/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  await assert.rejects(
    requestJson('https://example.com', { headers: { 'X-Test': 'ok\r\nInjected: 1' } }),
    /请求头/,
  );
});

test('网盘目录数据会被校正并限制最大规模', () => {
  const account: CloudAccount = {
    id: 'account-1',
    providerId: 'alipan',
    displayName: '阿里云盘',
    credentials: { refreshToken: 'token' },
    createdAt: 1,
    updatedAt: 1,
  };
  assert.deepEqual(normalizeProviderItem(account, 'alipan', {
    id: 'file-1',
    parentId: 'root',
    name: '示例.txt',
    isFolder: false,
    size: Number.NaN,
    createdAt: -1,
    modifiedAt: Number.POSITIVE_INFINITY,
    extra: [] as unknown as Record<string, unknown>,
  }), {
    id: 'file-1',
    parentId: 'root',
    name: '示例.txt',
    isFolder: false,
    size: 0,
    path: undefined,
    mimeType: undefined,
    thumbnailUrl: undefined,
    createdAt: undefined,
    modifiedAt: undefined,
    extra: undefined,
    accountId: 'account-1',
    providerId: 'alipan',
  });
  assert.doesNotThrow(() => assertDirectoryCapacity(MAX_DIRECTORY_ITEMS - 1, 1, '阿里云盘'));
  assert.throws(() => assertDirectoryCapacity(MAX_DIRECTORY_ITEMS, 1, '阿里云盘'), /超过/);
  assert.throws(() => normalizeProviderItem(account, 'alipan', {
    id: '',
    parentId: 'root',
    name: '坏数据',
    isFolder: false,
    size: 1,
  }), /无效的文件信息/);
  const normalized = normalizeProviderItem(account, 'alipan', {
    id: 'file-2',
    parentId: 'root',
    name: '封面.jpg',
    isFolder: false,
    size: Number.MAX_VALUE,
    thumbnailUrl: '//example.com/cover.jpg',
  });
  assert.equal(normalized.size, Number.MAX_SAFE_INTEGER);
  assert.equal(normalized.thumbnailUrl, 'https://example.com/cover.jpg');
  assert.equal(normalizeProviderItem(account, 'alipan', {
    ...normalized,
    id: 'file-3',
    thumbnailUrl: 'javascript:alert(1)',
  }).thumbnailUrl, undefined);
  assert.deepEqual(providerArray(undefined, '阿里云盘'), []);
  assert.throws(() => providerArray({}, '阿里云盘'), /列表数据/);
  assert.deepEqual(providerObject({ value: 1 }, '阿里云盘'), { value: 1 });
  assert.throws(() => providerObject(null, '阿里云盘'), /响应数据/);
  assert.throws(() => providerObject([], '阿里云盘'), /响应数据/);
  assert.equal(shouldContinueProviderPagination(40, 40, 60, 100), true);
  assert.equal(shouldContinueProviderPagination(100, 40, 60, 100), false);
  assert.equal(shouldContinueProviderPagination(60, 60, 60), true);
  assert.equal(shouldContinueProviderPagination(59, 59, 60), false);
  assert.equal(shouldContinueProviderPagination(60, 0, 60, 120), false);
  assert.throws(() => shouldContinueProviderPagination(0, -1, 60, 100), /分页状态/);
  assert.deepEqual(uniqueCloudItems([normalized, normalized]), [normalized]);
  assert.equal(isItemAlreadyInFolder({ ...normalized, parentId: '/电影' }, {
    id: '123456',
    name: '电影',
    path: '/电影',
  }), true);
  assert.equal(isItemAlreadyInFolder({ ...normalized, parentId: 'root' }, {
    id: 'root',
    name: '根目录',
  }), true);
  assert.equal(isItemAlreadyInFolder({ ...normalized, parentId: 'other' }, {
    id: 'root',
    name: '根目录',
  }), false);
});

test('账号恢复会过滤损坏结构并保留有效凭证', () => {
  assert.equal(normalizeStoredAccount({ providerId: 'unknown' }), null);
  assert.equal(normalizeStoredAccount({
    id: 'bad\u0000id',
    providerId: 'tianyi',
    displayName: '损坏账号',
    credentials: {},
  }), null);
  assert.equal(normalizeStoredAccount({
    id: 'unsafe/account',
    providerId: 'tianyi',
    displayName: '损坏账号',
    credentials: {},
  }), null);
  const account = normalizeStoredAccount({
    id: 'account-1',
    providerId: 'tianyi',
    displayName: '  天翼主账号  ',
    credentials: { cookie: 'SESSION=1', 'bad-key': 'ignored', invalid: 123 },
    createdAt: 10,
    updatedAt: Number.NaN,
  });
  assert.deepEqual(account, {
    id: 'account-1',
    providerId: 'tianyi',
    displayName: '天翼主账号',
    credentials: { cookie: 'SESSION=1' },
    createdAt: 10,
    updatedAt: 0,
  });
  assert.ok(account);
  assert.equal(hasSameCredentialSnapshot(account, {
    ...account,
    displayName: '用户刚修改的名称',
    updatedAt: 99,
  }), true);
  assert.equal(hasSameCredentialSnapshot(account, {
    ...account,
    credentials: { cookie: 'SESSION=2' },
    updatedAt: 99,
  }), false);
});

test('时间戳和 AWS 查询排序保持跨平台稳定', () => {
  assert.equal(epochMilliseconds(1_700_000_000), 1_700_000_000_000);
  assert.equal(epochMilliseconds(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(epochMilliseconds('bad'), undefined);
  assert.equal(epochMilliseconds(Number.MAX_VALUE), undefined);
  assert.equal(
    canonicalQueryString(new URL('https://example.com/?z=1&Z=2&%C3%A4=x&a=~&a=%C3%A9&a=A')),
    '%C3%A4=x&Z=2&a=%C3%A9&a=A&a=~&z=1',
  );
});

test('并发刷新会合并为一次且失败后可以重试', async () => {
  let calls = 0;
  let unblock: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const first = singleFlight('test:success', async () => {
    calls += 1;
    await gate;
    return 7;
  });
  const second = singleFlight('test:success', async () => {
    calls += 1;
    return 8;
  });
  assert.equal(first, second);
  unblock?.();
  assert.deepEqual(await Promise.all([first, second]), [7, 7]);
  assert.equal(calls, 1);

  await assert.rejects(singleFlight('test:failure', async () => {
    throw new Error('first failure');
  }));
  assert.equal(await singleFlight('test:failure', async () => 9), 9);
});

test('受控并发会保持结果顺序且不淹没本机接口', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([12, 2, 6], 2, async (delay, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return index * 10;
  });
  assert.deepEqual(results, [0, 10, 20]);
  assert.equal(peak, 2);
  assert.deepEqual(
    await mapWithConcurrency([undefined], 1, async (value) => value ?? '保留'),
    ['保留'],
  );
  await assert.rejects(mapWithConcurrency([], 0, async () => 1), /并发数量/);
});

test('同 ID 的临时账号与已保存账号不会错误共用刷新结果', async () => {
  const liveAccount = { id: 'same-id' };
  const draftAccount = { id: 'same-id' };
  let calls = 0;
  const results = await Promise.all([
    singleFlight(liveAccount, async () => {
      calls += 1;
      return 'live';
    }),
    singleFlight(draftAccount, async () => {
      calls += 1;
      return 'draft';
    }),
  ]);
  assert.deepEqual(results, ['live', 'draft']);
  assert.equal(calls, 2);
});
