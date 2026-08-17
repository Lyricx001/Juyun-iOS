export function splitUtf8(value: string, maxBytes = 1800): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) {
    throw new Error('分片大小必须至少为 4 字节');
  }
  if (!value) return [''];

  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const character of value) {
    const characterBytes = encoder.encode(character).length;
    if (current && currentBytes + characterBytes > maxBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks;
}
