import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createZstdDecompress } from 'node:zlib';
import { parserState, parseUsageEvent, estimateCost } from './usage-parser.js';

// 数据库只存用量元数据；对话正文不写入表或诊断文件。
export class Ledger {
  // 初始化仅当前用户可读写的数据库，并建立可迁移的索引结构。
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'wx', 0o600));
    else fs.chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    // 只用账本明细的变动使汇总失效。旧任务表仍可按保留期限清理。
    this.usageChanges = 0;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,home TEXT NOT NULL,inode TEXT,offset INTEGER NOT NULL,state TEXT NOT NULL,mtime REAL,size INTEGER);
      CREATE TABLE IF NOT EXISTS events(key TEXT PRIMARY KEY,home TEXT,account TEXT,thread TEXT,parent TEXT,turn TEXT,time INTEGER,model TEXT,tier TEXT,project TEXT,source TEXT,kind TEXT,input_tokens INTEGER,cached_input_tokens INTEGER,cache_write_input_tokens INTEGER,output_tokens INTEGER,reasoning_output_tokens INTEGER,total_tokens INTEGER);
      CREATE INDEX IF NOT EXISTS events_time ON events(time); CREATE INDEX IF NOT EXISTS events_turn ON events(thread,turn,kind); CREATE INDEX IF NOT EXISTS events_home ON events(home); CREATE INDEX IF NOT EXISTS events_canonical ON events(thread,account,kind,turn,time);
      CREATE TABLE IF NOT EXISTS origins(file TEXT,key TEXT,PRIMARY KEY(file,key));
      CREATE INDEX IF NOT EXISTS origins_key ON origins(key);
      CREATE TABLE IF NOT EXISTS tasks(home TEXT,thread TEXT,turn TEXT,status TEXT,time INTEGER,model TEXT,project TEXT,parent TEXT,source TEXT,PRIMARY KEY(home,thread,turn));
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);`);
    // 解析规则升级先备份旧索引，再重建文件检查点，禁止沿用旧去重规则。
    const revision = this.db.prepare("SELECT value FROM meta WHERE key='parserRevision'").get()?.value;
    if (revision !== '2') {
      if (this.db.prepare('SELECT count(*) n FROM files').get().n) {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        fs.copyFileSync(file, file + '.before-parser-2-' + Date.now());
        this.db.exec('DELETE FROM events;DELETE FROM origins;DELETE FROM files;DELETE FROM tasks;');
      }
      this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('parserRevision', '2');
    }
    this.origin = this.db.prepare('INSERT OR IGNORE INTO origins VALUES (?,?)');
    this.insert = this.db.prepare(
      `INSERT OR IGNORE INTO events VALUES (${Array(18).fill('?').join(',')})`,
    );
    // 增量扫描反复使用同一组语句，避免每份日志、每个任务都重新编译 SQL。
    this.findFile = this.db.prepare('SELECT * FROM files WHERE path=?');
    this.updateFileIdentity = this.db.prepare('UPDATE files SET inode=? WHERE path=?');
    this.saveFile = this.db.prepare('INSERT OR REPLACE INTO files VALUES (?,?,?,?,?,?,?)');
  }
  // 流式发现历史记录；同一路径的明文副本优先于压缩副本。
  async filesFor(home) {
    const files = [];
    // 递归遍历真实目录，不跟随符号链接避免重复扫描。
    async function walk(folder) {
      let entries;
      try {
        entries = await fsp.readdir(folder, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(folder, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile() && /\.jsonl(?:\.zst)?$/.test(e.name)) files.push(p);
      }
    }
    await walk(path.join(home, 'sessions'));
    await walk(path.join(home, 'archived_sessions'));
    const plain = new Set(files.filter((p) => p.endsWith('.jsonl')));
    return files.filter((p) => !p.endsWith('.zst') || !plain.has(p.slice(0, -4)));
  }
  // 文件截断或替换时只清理该文件拥有的事件，其他副本仍可保留。
  resetFile(file) {
    this.db.prepare('DELETE FROM origins WHERE file=?').run(file);
    this.usageChanges += this.db.prepare('DELETE FROM events WHERE key NOT IN (SELECT key FROM origins)').run().changes;
    this.db.prepare('DELETE FROM files WHERE path=?').run(file);
  }
  // 增量读取完整行；最后半行不提交偏移，下次追加后再解析。
  async scanFile(file, homeId, onTask = () => {}, signal) {
    const stat = await fsp.stat(file);
    const legacyInode = `${stat.dev}:${stat.ino}`;
    // macOS 重启后设备号可能变化，文件编号与创建时间仍能识别原文件。
    const inode = stat.ino && stat.birthtimeMs > 0
      ? `birth:${stat.ino}:${stat.birthtimeMs}`
      : legacyInode;
    const compressed = file.endsWith('.zst');
    let saved = this.findFile.get(file);
    if (saved) {
      const unchanged = saved.size === stat.size && saved.mtime === stat.mtimeMs;
      const oldIdentity = saved.inode?.split(':');
      // 旧检查点缺少创建时间，设备号变化时只迁移元数据能确认未变的文件。
      const sameFile = saved.inode === inode || saved.inode === legacyInode ||
        (unchanged && inode !== legacyInode && oldIdentity?.length === 2 &&
          oldIdentity[1] === String(stat.ino) && stat.birthtimeMs <= saved.mtime);
      if (sameFile && unchanged) {
        const state = JSON.parse(saved.state);
        if (saved.inode !== inode) this.updateFileIdentity.run(inode, file);
        return state;
      }
      // 同一明文文件追加时沿用偏移，替换、截断和变化的压缩归档从头读取。
      if (!sameFile || compressed || stat.size <= saved.size) {
        this.resetFile(file);
        saved = null;
      }
    }
    const state = saved ? JSON.parse(saved.state) : parserState();
    let offset = saved?.offset || 0,
      pending = Buffer.alloc(0),
      records = 0;
    const stream = fs.createReadStream(file, {
      start: compressed ? 0 : offset,
      highWaterMark: 256 * 1024,
      signal,
    });
    const input = compressed ? stream.pipe(createZstdDecompress()) : stream;
    // pipe 不会自动转发源流错误；文件被移走或无法读取时必须结束解压等待。
    if (compressed) stream.on('error', (error) => input.destroy(error));
    this.db.exec('BEGIN');
    try {
      for await (const chunk of input) {
        pending = Buffer.concat([pending, chunk]);
        let start = 0,
          index;
        while ((index = pending.indexOf(10, start)) !== -1) {
          const line = pending.subarray(start, index);
          offset += index - start + 1;
          start = index + 1;
          if (!line.length) continue;
          let event;
          try {
            event = JSON.parse(line.toString('utf8'));
          } catch {
            state.issues++;
            continue;
          }
          const parsed = parseUsageEvent(event, state, homeId);
          if (parsed.usage) {
            const r = parsed.usage;
            const result = this.insert.run(
              ...[
                'key',
                'home',
                'account',
                'thread',
                'parent',
                'turn',
                'time',
                'model',
                'tier',
                'project',
                'source',
                'kind',
                'input_tokens',
                'cached_input_tokens',
                'cache_write_input_tokens',
                'output_tokens',
                'reasoning_output_tokens',
                'total_tokens',
              ].map((k) => r[k]),
            );
            this.usageChanges += result.changes;
            this.origin.run(file, r.key);
          }
          // 任务状态随文件检查点恢复，实时提醒直接从解析事件发出。
          if (saved && parsed.task?.time > Date.now() - 120000) onTask({ ...parsed.task, home: homeId });
          if (++records % 1500 === 0) {
            this.db.exec('COMMIT');
            this.db.exec('BEGIN');
            await new Promise((r) => setImmediate(r));
          }
        }
        pending = pending.subarray(start);
        if (pending.length > 32 * 1024 * 1024) throw new Error('单条日志超过 32 MiB，已停止该文件扫描');
      }
      this.saveFile.run(
        file,
        homeId,
        inode,
        compressed ? stat.size : offset,
        JSON.stringify(state),
        stat.mtimeMs,
        stat.size,
      );
      this.db.exec('COMMIT');
      return state;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      // 解析失败也关闭两个流，避免损坏的归档留下文件句柄或继续读取。
      input.destroy();
      stream.destroy();
    }
  }
  // 以请求明细覆盖同轮累计快照；两种格式同时存在时不重复入账。
  rows(filter = {}) {
    const clauses = [
        `NOT (e.kind='delta' AND EXISTS(SELECT 1 FROM events r WHERE r.thread=e.thread AND r.account=e.account AND (
      (r.kind='canonical' AND r.turn=e.turn AND (e.turn<>'' OR e.time>=(SELECT MIN(c.time)-1000 FROM events c WHERE c.thread=e.thread AND c.account=e.account AND c.kind='canonical')))
      OR (r.kind='request' AND ABS(r.time-e.time)<1000 AND r.total_tokens=e.total_tokens AND r.input_tokens=e.input_tokens AND r.output_tokens=e.output_tokens)
    )))`,
      ],
      args = [];
    for (const key of ['home', 'account', 'model', 'project', 'thread', 'source', 'tier'])
      if (filter[key]) {
        clauses.push(`e.${key}=?`);
        args.push(filter[key]);
      }
    if (Number.isFinite(filter.from)) {
      clauses.push('e.time>=?');
      args.push(filter.from);
    }
    if (Number.isFinite(filter.to)) {
      clauses.push('e.time<?');
      args.push(filter.to);
    }
    return this.db
      .prepare(`SELECT e.* FROM events e WHERE ${clauses.join(' AND ')} ORDER BY e.time`)
      .all(...args);
  }
  // 聚合与导出复用同一过滤结果，避免图表和明细口径不一致。
  report(filter = {}, settings = {}) {
    const rows = this.rows(filter),
      daily = {},
      // 模型名来自日志，不能把 constructor、__proto__ 等名称当成对象原型成员。
      models = Object.create(null),
      homes = {},
      threads = {};
    let total = 0,
      input = 0,
      cached = 0,
      output = 0,
      reasoning = 0,
      cacheWrite = 0,
      cost = 0,
      priced = 0;
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: settings.timezone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    for (const r of rows) {
      const day = date.format(new Date(r.time)),
        amount = estimateCost(r, settings.prices);
      total += r.total_tokens;
      input += r.input_tokens;
      cached += r.cached_input_tokens;
      output += r.output_tokens;
      reasoning += r.reasoning_output_tokens;
      cacheWrite += r.cache_write_input_tokens;
      if (amount !== null) {
        cost += amount;
        priced += r.total_tokens;
      }
      daily[day] = (daily[day] || 0) + r.total_tokens;
      models[r.model] = (models[r.model] || 0) + r.total_tokens;
      homes[r.home] = (homes[r.home] || 0) + r.total_tokens;
      const id = `${r.home}:${r.thread}`;
      const t = (threads[id] ??= {
        home: r.home,
        thread: r.thread,
        parent: r.parent,
        project: r.project,
        source: r.source,
        models: [],
        tokens: 0,
        cost: 0,
        pricedTokens: 0,
        lastAt: 0,
      });
      t.tokens += r.total_tokens;
      if (amount !== null) {
        t.cost += amount;
        t.pricedTokens += r.total_tokens;
      }
      t.lastAt = Math.max(t.lastAt, r.time);
      if (!t.models.includes(r.model)) t.models.push(r.model);
    }
    return {
      total,
      input,
      cached,
      cacheWrite,
      output,
      reasoning,
      cost: priced ? cost : null,
      pricedTokens: priced,
      coverage: total ? priced / total : 0,
      requests: rows.length,
      daily,
      models,
      homes,
      threads: Object.values(threads).sort((a, b) => b.lastAt - a.lastAt),
      projects: [...new Set(rows.map((r) => r.project))],
    };
  }
  // 用户设置的保留期限只裁剪龙娘索引，原始 Codex 文件保持不变。
  prune(days) {
    if (days > 0) {
      this.usageChanges += this.db.prepare('DELETE FROM events WHERE time<?').run(Date.now() - days * 86400000).changes;
      this.db.exec('DELETE FROM origins WHERE key NOT IN (SELECT key FROM events)');
      this.db.prepare('DELETE FROM tasks WHERE time<?').run(Date.now() - days * 86400000);
    }
  }
  // 索引重建保留旧数据库备份，由调用端在停止扫描后执行。
  clear() {
    this.db.exec('DELETE FROM events; DELETE FROM origins; DELETE FROM files; DELETE FROM tasks;');
    this.usageChanges++;
  }
  // WAL 在退出时检查点落盘，复制数据库前也调用该操作。
  close() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close();
  }
}
