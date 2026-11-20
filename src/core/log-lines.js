const MAX_LINE_BYTES = 32 * 1024 * 1024;
// 极深的未知结构同样使用原有大小保护，避免仅保存括号就能耗尽内存。
const MAX_ENVELOPE_DEPTH = 4096;
// JSON 结构符号均为 ASCII，可以直接在原始字节里定位，不必解码历史正文。
const QUOTE = 0x22, BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b, CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b, CLOSE_ARRAY = 0x5d;
const LF = 0x0a, CR = 0x0d;

// 无法从超长记录确认事件类型时沿用账本的大小保护，保留上一次成功的检查点。
function oversizedError() {
  return new Error('单条日志超过 32 MiB，已停止该文件扫描');
}

// 超长 compacted 只需要外层时间、序号和类型。保留外层 JSON，流式略过嵌套容器的内容。
class CompactedEnvelope {
  bytes = Buffer.allocUnsafe(256);
  size = 0;
  closers = [];
  quoted = false;
  escaped = false;
  checkedHeader = false;

  // 外层缓冲按需成倍扩展，及时释放原始数据块，也避免为每个小字段长期保留一个 Buffer。
  keep(bytes) {
    if (!bytes.length) return;
    const end = this.size + bytes.length;
    if (end > MAX_LINE_BYTES) throw oversizedError();
    if (end > this.bytes.length) {
      const next = Buffer.allocUnsafe(Math.min(MAX_LINE_BYTES, Math.max(end, this.bytes.length * 2)));
      this.bytes.copy(next, 0, 0, this.size);
      this.bytes = next;
    }
    bytes.copy(this.bytes, this.size);
    this.size = end;
  }

  // 已保留的部分始终按 UTF-8 一次解码，避免数据块切在中文字符中间。
  parseOuter(suffix = '') {
    try {
      return JSON.parse(this.bytes.toString('utf8', 0, this.size) + suffix);
    } catch {
      throw oversizedError();
    }
  }

  // 在字节层面识别容器和字符串，跨块保留转义状态，正文里的括号和引号不会改变外层边界。
  write(bytes) {
    let start = this.closers.length < 2 ? 0 : -1;
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (byte === BACKSLASH) this.escaped = true;
        else if (byte === QUOTE) this.quoted = false;
        continue;
      }
      if (byte === QUOTE) {
        this.quoted = true;
      } else if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) {
        if (this.closers.length >= MAX_ENVELOPE_DEPTH) throw oversizedError();
        const closing = byte === OPEN_OBJECT ? CLOSE_OBJECT : CLOSE_ARRAY;
        if (this.closers.length === 1) {
          this.keep(bytes.subarray(start, i + 1));
          // 类型已经出现在第一个嵌套值前时，未知大记录立即报错。类型在后面的记录等整行确认。
          if (!this.checkedHeader) {
            const header = this.parseOuter(String.fromCharCode(closing, this.closers[0]));
            if (Object.hasOwn(header, 'type') && header.type !== 'compacted') throw oversizedError();
            this.checkedHeader = true;
          }
          start = -1;
        }
        this.closers.push(closing);
      } else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
        if (this.closers.pop() !== byte) throw oversizedError();
        if (this.closers.length === 1) start = i;
      }
    }
    if (start >= 0) this.keep(bytes.subarray(start));
  }

  // 用标准 JSON 解析器确认真正的外层类型，字段顺序不影响识别，嵌套的同名字段不会被采信。
  event() {
    if (this.quoted || this.closers.length) throw oversizedError();
    const outer = this.parseOuter();
    if (outer?.type !== 'compacted' || !outer.payload || typeof outer.payload !== 'object' || Array.isArray(outer.payload)) {
      throw oversizedError();
    }
    return outer;
  }
}

// 明文和解压流共用换行边界。普通行最多拼接一次，任务提醒可直接略过超长行。
export async function* readLogLines(input, offset = 0, { compactedMetadata = false } = {}) {
  let parts = [], length = 0, lastByte, envelope;
  for await (const chunk of input) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(LF, start);
      const fragment = chunk.subarray(start, newline < 0 ? chunk.length : newline);
      if (fragment.length) lastByte = fragment[fragment.length - 1];
      length += fragment.length;
      // CR 和 LF 可能分属两个数据块。终止符计入文件偏移，不占用 JSON 正文的大小限额。
      const contentLength = length - (lastByte === CR ? 1 : 0);
      if (contentLength <= MAX_LINE_BYTES) {
        if (fragment.length) parts.push(fragment);
      } else {
        if (compactedMetadata && !envelope) {
          envelope = new CompactedEnvelope();
          for (const part of parts) envelope.write(part);
        }
        parts.length = 0;
        envelope?.write(fragment);
      }
      if (newline < 0) break;
      // 偏移始终按原始字节数推进，包括换行。EOF 后未闭合的行由下次追加重读。
      offset += length + 1;
      const bytes = parts.length > 1 ? Buffer.concat(parts, length) : parts[0];
      const line = lastByte === CR ? bytes?.subarray(0, contentLength) : bytes;
      yield { offset, line, compacted: envelope?.event() };
      parts = [];
      length = 0;
      lastByte = undefined;
      envelope = undefined;
      start = newline + 1;
    }
  }
}
