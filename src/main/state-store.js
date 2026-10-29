import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_STATE, normalizeState } from '../shared/state.js';

// 配置写入串行执行并使用临时文件替换，避免连续操作或退出时留下半个 JSON。
export class StateStore {
  // 允许测试传入隔离目录，桌面验证不会改写真实用户的位置。
  constructor(file) {
    this.file = file;
    this.queue = Promise.resolve();
    this.invalidOriginal = false;
    this.error = null;
  }

  // 初次启动不立即落盘，损坏文件保留到第一次明确修改时再备份。
  async load() {
    try {
      const input = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.invalidOriginal = input?.version !== 1;
      return normalizeState(input);
    } catch (error) {
      this.invalidOriginal = error.code !== 'ENOENT';
      return structuredClone(DEFAULT_STATE);
    }
  }

  // 每次保存捕获独立快照；后续修改不会改变已经排队的内容。
  save(state) {
    const text = JSON.stringify(normalizeState(state), null, 2) + '\n';
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        if (this.invalidOriginal) {
          await fs.copyFile(this.file, this.file + '.recovered-' + Date.now()).catch(() => {});
          this.invalidOriginal = false;
        }
        const temporary = this.file + '.' + process.pid + '.' + randomUUID() + '.tmp';
        try {
          await fs.writeFile(temporary, text, { mode: 0o600 });
          await fs.rename(temporary, this.file);
          this.error = null;
        } catch (error) {
          this.error = error;
          await fs.rm(temporary, { force: true }).catch(() => {});
          throw error;
        }
      });
    return this.queue;
  }

  // 退出时等待当前写入完成，拖动后立即退出也能保留位置。
  async flush() {
    await this.queue;
  }
}
