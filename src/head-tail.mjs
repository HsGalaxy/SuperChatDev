// Bounded byte ring for retaining the last part of a job's output.
// Does not keep unbounded process logs in gateway or worker memory.
export class TailBuffer {
  constructor(capacity = 65536) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024 * 1024)
      throw new Error('Invalid tail capacity');
    this.data = Buffer.alloc(capacity);
    this.capacity = capacity;
    this.length = 0;
    this.end = 0;
  }
  push(data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!buffer.length) return;
    if (buffer.length >= this.capacity) {
      buffer.copy(this.data, 0, buffer.length - this.capacity);
      this.length = this.capacity;
      this.end = 0;
      return;
    }
    const first = Math.min(buffer.length, this.capacity - this.end);
    buffer.copy(this.data, this.end, 0, first);
    if (first < buffer.length) buffer.copy(this.data, 0, first);
    this.end = (this.end + buffer.length) % this.capacity;
    this.length = Math.min(this.length + buffer.length, this.capacity);
  }
  snapshot() {
    const start = (this.end - this.length + this.capacity) % this.capacity;
    if (start + this.length <= this.capacity) return Buffer.from(this.data.subarray(start, start + this.length));
    return Buffer.concat([this.data.subarray(start), this.data.subarray(0, (start + this.length) % this.capacity)]);
  }
}

// Avoid replacement characters at the split boundary in previews.
export function headUtf8(data) {
  if (!data.length) return '';
  let len = data.length;
  let i = len - 1;
  while (i > 0 && (data[i] & 0xc0) === 0x80) i--;
  const first = data[i];
  const expected = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
  if (len - i < expected) len = i;
  return data.subarray(0, len).toString('utf8');
}
export function tailUtf8(data) {
  let start = 0;
  while (start < data.length && (data[start] & 0xc0) === 0x80) start++;
  return data.subarray(start).toString('utf8');
}
