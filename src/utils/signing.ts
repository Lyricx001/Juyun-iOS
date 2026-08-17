export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalQueryString(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey === rightKey ? lexicalCompare(leftValue, rightValue) : lexicalCompare(leftKey, rightKey)
    ))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}
