import { assertHttpHeaders } from './headers';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RequestJsonOptions extends RequestInit {
  timeoutMs?: number;
  maxResponseChars?: number;
}

const DEFAULT_MAX_RESPONSE_CHARS = 20 * 1024 * 1024;

function responseErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.slice(0, 240) : undefined;
  const values = body as Record<string, unknown>;
  for (const key of ['error_description', 'error_info', 'error_msg', 'errmsg', 'res_message', 'message', 'msg', 'error']) {
    const value = values[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 240);
  }
  return undefined;
}

export async function requestJson<T>(url: string, options: RequestJsonOptions = {}): Promise<T> {
  const {
    timeoutMs = 30_000,
    maxResponseChars = DEFAULT_MAX_RESPONSE_CHARS,
    signal: externalSignal,
    ...requestOptions
  } = options;
  const controller = new AbortController();
  let timedOut = false;
  let cancelledByCaller = externalSignal?.aborted === true;
  const delay = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 30_000;
  const responseLimit = Number.isSafeInteger(maxResponseChars) && maxResponseChars > 0
    ? Math.min(maxResponseChars, 50 * 1024 * 1024)
    : DEFAULT_MAX_RESPONSE_CHARS;
  const timeout = setTimeout(() => {
    if (cancelledByCaller) return;
    timedOut = true;
    controller.abort();
  }, delay);
  const abortFromCaller = () => {
    cancelledByCaller = true;
    controller.abort();
  };
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    assertHttpHeaders(requestOptions.headers, 'HTTP 请求头');
    const response = await fetch(url, { ...requestOptions, signal: controller.signal });
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > responseLimit) {
      controller.abort();
      throw new Error('网盘响应内容过大，请缩小目录范围后重试');
    }
    const text = await response.text();
    if (
      text.length > responseLimit ||
      new TextEncoder().encode(text).length > responseLimit
    ) {
      throw new Error('网盘响应内容过大，请缩小目录范围后重试');
    }
    let body: unknown = undefined;
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      const detail = responseErrorMessage(body);
      throw new HttpError(
        `请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`,
        response.status,
        body,
      );
    }
    return (body === undefined ? {} : body) as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(timedOut ? '请求超时，请检查网络后重试' : '请求已取消');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromCaller);
  }
}

export function formBody(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value));
  });
  return params.toString();
}

export function withQuery(
  baseUrl: string,
  values: Record<string, string | number | boolean | undefined>,
): string {
  const url = new URL(baseUrl);
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  });
  return url.toString();
}
