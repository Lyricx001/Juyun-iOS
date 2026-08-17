const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return value === 0 ? '0 B' : '—';
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), UNITS.length - 1);
  const amount = value / 1024 ** unit;
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${UNITS[unit]}`;
}

export function formatDate(value?: number): string {
  if (!value || !Number.isFinite(value)) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export function epochMilliseconds(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  const milliseconds = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  return milliseconds <= 8_640_000_000_000_000 ? milliseconds : undefined;
}

export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '_')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return `下载_${Date.now()}`;
  return cleaned.startsWith('.') ? `_${cleaned}` : cleaned;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Length(value) <= maxBytes) return value;
  let result = '';
  let used = 0;
  for (const character of value) {
    const bytes = utf8Length(character);
    if (used + bytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}

export function safeLocalFilename(name: string, maxBytes = 180): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 255) {
    throw new Error('本机文件名长度上限无效');
  }
  const cleaned = sanitizeFilename(name);
  if (utf8Length(cleaned) <= maxBytes) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const hasExtension = dot > 0 && cleaned.length - dot <= 24;
  const extension = hasExtension ? cleaned.slice(dot) : '';
  const base = hasExtension ? cleaned.slice(0, dot) : cleaned;
  const extensionBytes = utf8Length(extension);
  if (extension && extensionBytes < maxBytes) {
    const available = maxBytes - extensionBytes;
    const truncatedBase = truncateUtf8(base, available) || (available >= 1 ? '_' : '');
    if (truncatedBase) return `${truncatedBase}${extension}`;
  }
  return truncateUtf8(cleaned, maxBytes) || '_';
}

export function cloudNameError(value: string): string | null {
  const name = value.trim();
  if (!name) return '名称不能为空';
  if (name === '.' || name === '..') return '名称不能是“.”或“..”';
  if (/[\\/\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/.test(name)) {
    return '名称不能包含斜杠、反斜杠或控制字符';
  }
  if (utf8Length(name) > 240) return '名称过长，请控制在 240 字节以内';
  return null;
}

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mov', 'mkv', 'avi', 'flv', 'wmv', 'webm', 'mts', 'm2ts', 'm3u8', 'mpeg', 'mpg',
]);

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'amr', 'aiff', 'aif',
]);

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'svg',
]);

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'xml', 'csv', 'log', 'yaml', 'yml', 'ini', 'conf', 'html', 'htm', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'go', 'java', 'swift', 'kt', 'sql',
]);

const DOCUMENT_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'pages', 'numbers', 'key', 'odt', 'ods', 'odp',
]);

const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz']);

export type PreviewKind = 'video' | 'audio' | 'image' | 'text' | 'document' | 'archive' | 'other';

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > -1 ? name.slice(dot + 1).toLowerCase() : '';
}

function normalizedMimeType(value?: string): string | undefined {
  const mime = value?.split(';', 1)[0]?.trim().toLowerCase();
  return mime || undefined;
}

export function isVideoItem(name: string, mimeType?: string): boolean {
  if (normalizedMimeType(mimeType)?.startsWith('video/')) return true;
  return VIDEO_EXTENSIONS.has(fileExtension(name));
}

export function isAudioItem(name: string, mimeType?: string): boolean {
  if (normalizedMimeType(mimeType)?.startsWith('audio/')) return true;
  return AUDIO_EXTENSIONS.has(fileExtension(name));
}

export function previewKind(name: string, mimeType?: string): PreviewKind {
  const extension = fileExtension(name);
  const mime = normalizedMimeType(mimeType);
  if (isVideoItem(name, mimeType)) return 'video';
  if (isAudioItem(name, mimeType)) return 'audio';
  if (extension === 'svg') return 'text';
  if (mime?.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (mime?.startsWith('text/') || TEXT_EXTENSIONS.has(extension)) return 'text';
  if (mime === 'application/pdf' || DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
  return 'other';
}

export function fileTypeLabel(name: string, mimeType?: string): string {
  const labels: Record<PreviewKind, string> = {
    video: '视频',
    audio: '音频',
    image: '图片',
    text: '文本',
    document: '文档',
    archive: '压缩包',
    other: fileExtension(name).toUpperCase() || '文件',
  };
  return labels[previewKind(name, mimeType)];
}

export function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '发生未知错误';
}
