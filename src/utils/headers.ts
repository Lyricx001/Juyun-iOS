const MAX_HEADER_COUNT = 100;
const MAX_HEADER_NAME_LENGTH = 256;
const MAX_HEADER_VALUE_BYTES = 65_536;
const MAX_HEADER_TOTAL_BYTES = 256 * 1024;
const invalidHeaderValuePattern = /[\u0000-\u0008\u000A-\u001F\u007F]/;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function headerBytes(name: unknown, value: unknown): number {
  return typeof name === 'string' && typeof value === 'string'
    ? utf8Length(name) + utf8Length(value) + 4
    : MAX_HEADER_TOTAL_BYTES + 1;
}

export function isValidHttpHeader(name: unknown, value: unknown): value is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_HEADER_NAME_LENGTH &&
    /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) &&
    typeof value === 'string' &&
    utf8Length(value) <= MAX_HEADER_VALUE_BYTES &&
    !invalidHeaderValuePattern.test(value)
  );
}

function headerEntries(value: unknown): Array<[unknown, unknown]> | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    if (value.some((entry) => !Array.isArray(entry) || entry.length !== 2)) return null;
    return value.map((entry) => [entry[0], entry[1]]);
  }
  if (typeof Headers !== 'undefined' && value instanceof Headers) {
    const entries: Array<[string, string]> = [];
    value.forEach((headerValue, name) => entries.push([name, headerValue]));
    return entries;
  }
  return Object.entries(value as Record<string, unknown>);
}

export function assertHttpHeaders(value: unknown, label = '请求头'): void {
  if (value === undefined) return;
  const entries = headerEntries(value);
  const names = entries?.map(([name]) => typeof name === 'string' ? name.toLowerCase() : '') ?? [];
  if (
    !entries ||
    entries.length > MAX_HEADER_COUNT ||
    new Set(names).size !== names.length ||
    entries.reduce((total, [name, headerValue]) => total + headerBytes(name, headerValue), 0) > MAX_HEADER_TOTAL_BYTES ||
    entries.some(([name, headerValue]) => !isValidHttpHeader(name, headerValue))
  ) {
    throw new Error(`${label}无效，请更新凭证后重试`);
  }
}

export function filterHttpHeaderRecord(value: unknown): Record<string, string> | undefined {
  const entries = headerEntries(value);
  if (!entries) return undefined;
  const seenNames = new Set<string>();
  const filtered: Array<[string, string]> = [];
  let totalBytes = 0;
  for (const [name, headerValue] of entries) {
    if (typeof name !== 'string' || !isValidHttpHeader(name, headerValue)) continue;
    const normalizedName = name.toLowerCase();
    if (seenNames.has(normalizedName)) continue;
    const entryBytes = headerBytes(name, headerValue);
    if (totalBytes + entryBytes > MAX_HEADER_TOTAL_BYTES) continue;
    seenNames.add(normalizedName);
    filtered.push([name, headerValue]);
    totalBytes += entryBytes;
    if (filtered.length >= MAX_HEADER_COUNT) break;
  }
  return filtered.length ? Object.fromEntries(filtered) : undefined;
}
