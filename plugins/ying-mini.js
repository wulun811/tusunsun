import { randomUUID, createHash } from 'node:crypto';
import { appendFile, readFile, writeFile, rename, unlink, mkdir, readdir, open as fsOpen } from 'node:fs/promises';
import { join } from 'node:path';

class YingMini {
  name = 'ying-mini';
  version = '0.6.6';
  permissions = [];
  provides = [
    { name: 'ying-mini', type: 'service' },
    { name: 'memory', type: 'service' },
  ];

  constructor() {
    this._transient = [];
    this._longTerm = {};
    this._readOnly = false;
    this._lastHash = null;
    this._writeLock = false;
    this._writeQueue = [];
    this._currentDate = '';
    this._baseDir = '';
    this._shortDir = '';
    this._longDir = '';
    this._chainPath = '';
    this._auditPath = '';
    this._fsyncTimer = null;
    this._cleanupTimer = null;
    this._batchTimer = null;
    this._totalShortEntries = 0;
    this._chainCache = null;
    this._indices = new Map();
    this._indexCounts = new Map();
    this._dateOffsets = new Map();
    this._writeBuffer = null;
  }

  async init(core) {
    this.core = core;
    core.registerService('ying-mini', this);
    core.registerService('memory', this);
  }

  async start() {
    const memDir = this.core.get('memory.storageDirectory') || 'memory';
    this._baseDir = join(this.core.stateDir, memDir);
    this._shortDir = join(this._baseDir, 'short');
    this._longDir = join(this._baseDir, 'long');
    this._chainPath = join(this._baseDir, 'chain.jsonl');
    this._auditPath = join(this._baseDir, 'audit.jsonl');

    await mkdir(this._shortDir, { recursive: true });
    await mkdir(this._longDir, { recursive: true });

    this._config = {
      retentionDays: this.core.get('memory.shortTermRetentionDays') ?? 7,
      maxEntries: this.core.get('memory.shortTermMaxEntries') ?? 5000,
      longTermMaxSizeMb: this.core.get('memory.longTermMaxSizeMb') ?? 100,
      backupCount: this.core.get('memory.longTermBackupCount') ?? 10,
      cleanupIntervalHours: this.core.get('memory.autoCleanupIntervalHours') ?? 24,
      enableAudit: this.core.get('memory.enableAuditLog') ?? true,
      fsyncEveryWrite: this.core.get('memory.fsyncEveryWrite') ?? false,
      enableRecording: this.core.get('memory.enableEventRecording') ?? true,
    };

    this._readOnly = this.core.get('memory.readOnly') ?? false;

    await this._loadChainCache();
    await this._loadLongTerm();

    const integrity = await this._verifyIntegrity();
    if (!integrity.ok) {
      this.core.log('warn', `ying-mini: ${integrity.errors.length} hash chain errors, entering read-only`);
      this._readOnly = true;
      try {
        this.core.emit('memory.readonly_entered', {
          reason: `hash chain errors (${integrity.errors.length})`,
          errorCount: integrity.errors.length,
          timestamp: new Date().toISOString(),
          sourcePlugin: 'ying-mini',
        });
      } catch (e) { this.core?.log?.('warn', `ying-mini: emit readonly_entered failed: ${e.message}`); }
    }

    await this.cleanup();
    this._cleanupTimer = setInterval(() => this.cleanup().catch(() => {}),
      this._config.cleanupIntervalHours * 3600000);
    this._fsyncTimer = setInterval(() => this._fsyncPending().catch(() => {}), 30000);
    this._writeBuffer = new Map();
    this._batchTimer = setInterval(() => this._flushBatch().catch(() => {}), 5000);
  }

  async stop() {
    clearInterval(this._cleanupTimer);
    clearInterval(this._fsyncTimer);
    clearInterval(this._batchTimer);
    await this._flushBatch();
    await this._fsyncPending();
    await this._saveLongTerm();
  }

  add(entry) {
    const id = randomUUID();
    const item = { id, timestamp: Date.now(), ...entry };
    this._transient.push(item);
    if (this._transient.length > 50) this._transient.shift();
    return id;
  }

  getTransient(id) {
    const result = this._transient.find(e => e.id === id) || null;
    try {
      this.core.emit('ying.cache_hit', {
        sessionId: '', hit: !!result, cacheSize: this._transient.length, latencyMs: 0,
        timestamp: new Date().toISOString(), sourcePlugin: 'ying-mini',
      });
    } catch (e) { this.core?.log?.('error', `ying-mini: emit cache_hit failed: ${e.message}`); }
    return result;
  }

  async getRecent(n = 10) {
    const seen = new Set();
    const result = [];
    for (const e of [...this._transient].reverse()) {
      if (result.length >= n) break;
      if (!seen.has(e.id)) { seen.add(e.id); result.push(e); }
    }
    if (result.length >= n) return result;

    let files;
    try {
      files = (await readdir(this._shortDir))
        .filter(f => f.endsWith('.jsonl'))
        .sort()
        .reverse();
    } catch { return result; }

    for (const file of files) {
      if (result.length >= n) break;
      try {
        const content = await readFile(join(this._shortDir, file), 'utf-8');
        for (const line of content.trim().split('\n').reverse()) {
          if (result.length >= n || !line) break;
          try {
            const e = JSON.parse(line);
            if (!seen.has(e.id)) { seen.add(e.id); result.push(e); }
          } catch {}
        }
      } catch {}
    }
    return result;
  }

  exportTransient() {
    return [...this._transient];
  }

  async recordEvent(sessionId, type, source, content) {
    if (this._readOnly || !this._config.enableRecording) return null;
    return new Promise((resolve, reject) => {
      this._writeQueue.push(() =>
        this._doRecordEvent(sessionId, type, source, content)
          .then(resolve)
          .catch(reject)
      );
      if (!this._writeLock) this._drainWriteQueue();
    });
  }

  async _drainWriteQueue() {
    this._writeLock = true;
    while (this._writeQueue.length > 0) {
      const fn = this._writeQueue.shift();
      await fn();
    }
    this._writeLock = false;
  }

  async _doRecordEvent(sessionId, type, source, content) {
    const t0 = Date.now();
    const id = randomUUID();
    const timestamp = Date.now();
    const hash = this._calcHash(id, timestamp, type, source, content);
    const prevHash = this._getPrevHash();
    const entry = { id, timestamp, type, source, content, hash, prev_hash: prevHash };

    this._transient.push(entry);
    if (this._transient.length > 50) this._transient.shift();

    const dateStr = new Date(timestamp).toISOString().slice(0, 10);
    const file = join(this._shortDir, `${dateStr}.jsonl`);

    if (dateStr !== this._currentDate) {
      await this._updateChainHead(this._currentDate || dateStr, this._lastHash);
      this._currentDate = dateStr;
    }

    const line = JSON.stringify(entry) + '\n';

    if (this._config.fsyncEveryWrite) {
      await appendFile(file, line);
      try {
        const fd = await fsOpen(file, 'a');
        await fd.sync();
        await fd.close();
      } catch (e) { this.core?.log?.('error', `ying-mini: fsync failed for ${file}: ${e.message}`); }
    } else {
      const buf = this._writeBuffer.get(file) || [];
      buf.push(line);
      this._writeBuffer.set(file, buf);
    }
    this._lastHash = hash;
    this._totalShortEntries++;

    const count = this._indexCounts.get(dateStr) || 0;
    const byteOffset = this._dateOffsets.get(dateStr) || 0;
    this._indexCounts.set(dateStr, count + 1);
    this._dateOffsets.set(dateStr, byteOffset + Buffer.byteLength(line));

    if (this._config.enableAudit) {
      await this._writeAudit({ op: 'insert', type, id, timestamp, source });
    }

    try {
      this.core.emit('ying.store', {
        sessionId, category: type, tier: 'short',
        contentLength: Buffer.byteLength(JSON.stringify(content), 'utf-8'),
        timestamp: new Date().toISOString(), sourcePlugin: 'ying-mini',
      });
    } catch (e) { this.core?.log?.('warn', `ying-mini: emit store failed: ${e.message}`); }

    if (this._totalShortEntries > this._config.maxEntries) {
      await this.cleanup();
    }

    return id;
  }

  async record(sessionId, fact, category = 'general', importance = 1) {
    const id = await this.recordEvent(sessionId, 'event', 'agent', { fact, category, importance });
    return !!id;
  }

  async search(keyword, limit = 100) {
    const results = [];
    let files;
    try {
      files = (await readdir(this._shortDir))
        .filter(f => f.endsWith('.jsonl'))
        .sort()
        .reverse();
    } catch { return results; }

    for (const file of files) {
      if (results.length >= limit) break;
      try {
        const content = await readFile(join(this._shortDir, file), 'utf-8');
        for (const line of content.trim().split('\n').reverse()) {
          if (!line || results.length >= limit) break;
          if (line.includes(keyword)) {
            try { results.push(JSON.parse(line)); } catch {}
          }
        }
      } catch {}
    }
    return results;
  }

  async getByTimeRange(startTs, endTs) {
    const results = [];
    let files;
    try {
      files = (await readdir(this._shortDir))
        .filter(f => f.endsWith('.jsonl'))
        .sort();
    } catch { return results; }

    for (const file of files) {
      const fileDate = new Date(file.replace('.jsonl', ''));
      const fileEnd = fileDate.getTime() + 86400000;
      if (fileEnd < startTs || fileDate.getTime() > endTs) continue;

      const dateStr = file.replace('.jsonl', '');
      const idx = this._indices.get(dateStr);
      if (idx) {
        const entryCount = this._indexCounts.get(dateStr) || 0;
        const startIdx = this._binarySearchTs(idx, entryCount, startTs, true);
        const endIdx = this._binarySearchTs(idx, entryCount, endTs, false);
        if (startIdx >= 0 && endIdx >= 0 && startIdx <= endIdx) {
          const fd = await fsOpen(join(this._shortDir, file), 'r');
          try {
            const dv = new DataView(idx);
            for (let i = startIdx; i <= endIdx && i < entryCount; i++) {
              const off = i * 48;
              const offset = dv.getUint32(off + 40, true);
              const len = dv.getUint32(off + 44, true);
              const buf = Buffer.alloc(len);
              await fd.read(buf, 0, len, offset);
              try { results.push(JSON.parse(buf.toString('utf-8').trim())); } catch {}
            }
          } finally { await fd.close(); }
        }
        continue;
      }

      await this._buildIndexForDate(dateStr);
      const builtIdx = this._indices.get(dateStr);
      if (builtIdx) {
        const entryCount = this._indexCounts.get(dateStr) || 0;
        const startIdx = this._binarySearchTs(builtIdx, entryCount, startTs, true);
        const endIdx = this._binarySearchTs(builtIdx, entryCount, endTs, false);
        if (startIdx >= 0 && endIdx >= 0 && startIdx <= endIdx) {
          const fd = await fsOpen(join(this._shortDir, file), 'r');
          try {
            const dv = new DataView(builtIdx);
            for (let i = startIdx; i <= endIdx && i < entryCount; i++) {
              const off = i * 48;
              const offset = dv.getUint32(off + 40, true);
              const len = dv.getUint32(off + 44, true);
              const buf = Buffer.alloc(len);
              await fd.read(buf, 0, len, offset);
              try { results.push(JSON.parse(buf.toString('utf-8').trim())); } catch {}
            }
          } finally { await fd.close(); }
        }
        continue;
      }

      try {
        const content = await readFile(join(this._shortDir, file), 'utf-8');
        for (const line of content.trim().split('\n')) {
          if (!line) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.timestamp >= startTs && entry.timestamp <= endTs) results.push(entry);
          } catch {}
        }
      } catch {}
    }
    return results;
  }

  _binarySearchTs(buffer, count, target, lower) {
    if (!count) return -1;
    const dv = new DataView(buffer);
    let lo = 0, hi = count - 1, result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const ts = dv.getFloat64(mid * 48 + 32, true);
      if (ts < target) {
        lo = mid + 1;
      } else if (ts > target) {
        hi = mid - 1;
      } else {
        result = mid;
        if (lower) hi = mid - 1; else lo = mid + 1;
      }
    }
    if (result === -1) result = lower ? lo : hi;
    if (result < 0 || result >= count) return -1;
    return result;
  }

  async getByType(type, limit = 100) {
    const results = [];
    let files;
    try {
      files = (await readdir(this._shortDir))
        .filter(f => f.endsWith('.jsonl'))
        .sort()
        .reverse();
    } catch { return results; }

    for (const file of files) {
      if (results.length >= limit) break;
      try {
        const content = await readFile(join(this._shortDir, file), 'utf-8');
        for (const line of content.trim().split('\n').reverse()) {
          if (!line || results.length >= limit) break;
          try {
            const entry = JSON.parse(line);
            if (entry.type === type) results.push(entry);
          } catch {}
        }
      } catch {}
    }
    return results;
  }

  async recall(query, categories = [], limit = 5) {
    const t0 = Date.now();
    const entries = await this.search(query, categories.length ? limit * 3 : limit);
    let result = entries.map(e => ({
      fact: e.content?.fact || JSON.stringify(e.content),
      category: e.content?.category || e.type,
      importance: e.content?.importance || 1,
      session_id: e.content?.sessionId || '',
      created_at: e.timestamp,
    }));
    if (categories.length) {
      result = result.filter(r => categories.includes(r.category));
    }
    const final = result.slice(0, limit);
    try {
      this.core.emit('ying.retrieve', {
        sessionId: '', queryHash: createHash('sha256').update(query).digest('hex').slice(0, 16),
        resultsCount: final.length, avgRelevance: final.length > 0 ? 0.5 : 0,
        latencyMs: Date.now() - t0, source: 'ying-mini',
        timestamp: new Date().toISOString(), sourcePlugin: 'ying-mini',
      });
    } catch {}
    try {
      this.core.emit('ying.cache_hit', {
        sessionId: '', hit: false, cacheSize: this._transient.length, latencyMs: 0,
        timestamp: new Date().toISOString(), sourcePlugin: 'ying-mini',
      });
    } catch {}
    return final;
  }

  set(key, value) {
    const str = JSON.stringify(value);
    const sizeMb = Buffer.byteLength(str, 'utf-8') / (1024 * 1024);
    if (sizeMb > 1) {
      this.core.log('error', `ying-mini: set rejected, single value ${sizeMb.toFixed(1)}MB > 1MB limit`);
      return false;
    }
    const limit = this._config.longTermMaxSizeMb * 0.9;
    const newTotal = Buffer.byteLength(JSON.stringify({ ...this._longTerm, [key]: value }), 'utf-8') / (1024 * 1024);
    if (newTotal > limit) {
      this.core.log('error', `ying-mini: set rejected, total would be ${newTotal.toFixed(1)}MB > ${limit.toFixed(1)}MB limit`);
      return false;
    }
    this._longTerm[key] = value;
    return true;
  }
  get(key, defaultValue) { return key in this._longTerm ? this._longTerm[key] : defaultValue; }
  delete(key) { delete this._longTerm[key]; }
  has(key) { return key in this._longTerm; }
  exportLongTerm() { return { ...this._longTerm }; }

  // --- L1/L2 记忆增强 ---
  setProjectRules(rules) { return this.set('l1:project_rules', rules); }
  getProjectRules() { return this.get('l1:project_rules', ''); }
  setRepoMap(map) { return this.set('l2:repo_map', map); }
  getRepoMap() { return this.get('l2:repo_map', ''); }

  async cleanup() {
    let files;
    try {
      files = (await readdir(this._shortDir))
        .filter(f => f.endsWith('.jsonl'))
        .sort();
    } catch { return 0; }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this._config.retentionDays);

    let deleted = 0;
    for (const file of files) {
      const dateStr = file.replace('.jsonl', '');
      const fileDate = new Date(dateStr);
      if (fileDate < cutoff && dateStr !== this._currentDate) {
        try {
          const fullPath = join(this._shortDir, file);
          const content = await readFile(fullPath, 'utf-8');
          const lineCount = content.trim().split('\n').filter(l => l).length;
          await unlink(fullPath);
          this._totalShortEntries -= lineCount;
          this._indices.delete(dateStr);
          this._indexCounts.delete(dateStr);
          this._dateOffsets.delete(dateStr);
          this._markChainArchived(dateStr);
          if (this._config.enableAudit) {
            await this._writeAudit({ op: 'delete-file', date: dateStr,
              timestamp: Date.now(), entriesRemoved: lineCount });
          }
          deleted++;
        } catch (e) { this.core?.log?.('error', `ying-mini: cleanup file delete failed ${fullPath}: ${e.message}`); }
      }
    }
    if (deleted) {
      this.core.log('info', `ying-mini: cleaned ${deleted} expired file(s)`);
      try {
        this.core.emit('ying.tusunzip', {
          sessionId: '', originalSize: deleted * 4096, compressedSize: 0,
          ratio: 0, tokensSaved: deleted * 100,
          timestamp: new Date().toISOString(), sourcePlugin: 'ying-mini',
        });
      } catch {}
      try {
        this.core.emit('ying.consolidation', {
          sessionId: '', fromTier: 'short', toTier: 'expired', itemsMerged: deleted,
          timestamp: new Date().toISOString(), sourcePlugin: 'ying-mini',
        });
      } catch {}
    }
    return deleted;
  }

  async verifyIntegrity() { return this._verifyIntegrity(); }
  setReadOnly(v) { this._readOnly = !!v; }
  isReadOnly() { return this._readOnly; }

  _calcHash(id, timestamp, type, source, content) {
    const raw = id + String(timestamp) + type + source + JSON.stringify(content);
    return createHash('sha256').update(raw).digest('hex');
  }

  _getPrevHash() {
    return this._lastHash || '0'.repeat(64);
  }

  async _verifyIntegrity() {
    const errors = [];
    let files;
    try {
      files = (await readdir(this._shortDir))
        .filter(f => f.endsWith('.jsonl'))
        .sort();
    } catch { return { ok: true, errors: [] }; }

    const chain = await this._loadChainMap();
    this._totalShortEntries = 0;
    let prevDayHead = null;

    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      const dateStr = file.replace('.jsonl', '');
      try {
        const content = await readFile(join(this._shortDir, file), 'utf-8');
        const lines = content.trim().split('\n').filter(l => l);
        if (!lines.length) {
          await unlink(join(this._shortDir, file));
          continue;
        }

        const prevHead = (prevDayHead && prevDayHead !== 'archive') ? prevDayHead : null;
        let lastValidHash = null;
        let goodLines = 0;

        for (let i = 0; i < lines.length; i++) {
          let entry;
          try { entry = JSON.parse(lines[i]); } catch {
            errors.push(`${file}:${i + 1} invalid JSON`);
            continue;
          }

          const { id, timestamp, type, source, content: cont, hash, prev_hash } = entry;
          if (!id || !timestamp || !type || !source || !hash || !prev_hash) {
            errors.push(`${file}:${i + 1} missing required fields`);
            continue;
          }

          const computed = this._calcHash(id, timestamp, type, source, cont);
          if (computed !== hash) {
            errors.push(`${file}:${i + 1} hash mismatch`);
          }

          if (i === 0) {
            if (prevHead && prev_hash !== prevHead) {
              errors.push(`${file}:1 cross-day prev_hash mismatch`);
            }
          } else if (lastValidHash !== null) {
            if (prev_hash !== lastValidHash) {
              errors.push(`${file}:${i + 1} file-internal prev_hash mismatch`);
            }
          }

          lastValidHash = hash;
          goodLines++;
        }

        if (lastValidHash !== null) {
          chain[dateStr] = lastValidHash;
          prevDayHead = lastValidHash;
          this._totalShortEntries += goodLines;
        }

      } catch (err) {
        errors.push(`${file}: ${err.message}`);
      }
    }

    await this._saveChainMap(chain);
    this._chainCache = chain;

    const sortedDates = Object.keys(chain).sort();
    let targetDate = null;
    for (let i = sortedDates.length - 1; i >= 0; i--) {
      if (chain[sortedDates[i]] !== 'archive') { targetDate = sortedDates[i]; break; }
    }
    if (!targetDate && files.length) targetDate = files[files.length - 1].replace('.jsonl', '');

    if (targetDate) {
      try {
        const lastContent = await readFile(join(this._shortDir, `${targetDate}.jsonl`), 'utf-8');
        const lastLines = lastContent.trim().split('\n').filter(l => l);
        for (let i = lastLines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(lastLines[i]);
            if (entry.id && entry.hash) { this._lastHash = entry.hash; break; }
          } catch {}
        }
        this._currentDate = targetDate;
      } catch {}
    }

    try {
      this.core.emit('ying.hash_verify', {
        sessionId: '', ok: errors.length === 0, chainLength: Object.keys(chain).length,
        integrityScore: errors.length === 0 ? 1.0 : Math.max(0, 1.0 - errors.length * 0.1),
        timestamp: new Date().toISOString(), sourcePlugin: 'ying-mini',
      });
    } catch {}

    if (errors.length) {
      this.core.log('warn', `ying-mini verify: ${errors.length} error(s)`);
      for (const e of errors.slice(0, 5)) this.core.log('debug', `  ${e}`);
    }

    return { ok: errors.length === 0, errors };
  }

  async _loadChainCache() {
    try {
      const raw = await readFile(this._chainPath, 'utf-8');
      this._chainCache = {};
      for (const line of raw.trim().split('\n')) {
        if (!line) continue;
        try {
          const { date, head } = JSON.parse(line);
          if (head !== 'archive') this._chainCache[date] = head;
        } catch {}
      }
    } catch { this._chainCache = {}; }
  }

  async _loadChainMap() {
    try {
      const raw = await readFile(this._chainPath, 'utf-8');
      const map = {};
      for (const line of raw.trim().split('\n')) {
        if (!line) continue;
        try {
          const { date, head } = JSON.parse(line);
          if (head !== 'archive') map[date] = head;
        } catch {}
      }
      return map;
    } catch { return {}; }
  }

  async _saveChainMap(chain) {
    const lines = Object.entries(chain)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, head]) => JSON.stringify({ date, head }) + '\n')
      .join('');
    try { await writeFile(this._chainPath, lines); } catch (e) { this.core?.log?.('error', `ying-mini: save chain map failed: ${e.message}`); }
  }

  async _updateChainHead(dateStr, lastHash) {
    if (!this._chainCache) await this._loadChainCache();
    if (lastHash) {
      this._chainCache[dateStr] = lastHash;
      await this._saveChainMap(this._chainCache);
    }
  }

  _markChainArchived(dateStr) {
    if (!this._chainCache) return;
    this._chainCache[dateStr] = 'archive';
    this._saveChainMap(this._chainCache).catch(() => {});
  }

  _appendToIndex(dateStr, hash, ts, offset, length) {
    const hashBytes = Buffer.from(hash.slice(0, 64), 'hex');
    const buf = this._indices.get(dateStr);
    const count = this._indexCounts.get(dateStr) || 0;
    const entrySize = 48;

    let newBuf;
    if (!buf || count >= buf.byteLength / entrySize) {
      const newCap = Math.max((count + 1) * 2, 32);
      newBuf = new ArrayBuffer(newCap * entrySize);
      if (buf) new Uint8Array(newBuf).set(new Uint8Array(buf));
    } else {
      newBuf = buf;
    }

    const dv = new DataView(newBuf);
    const off = count * entrySize;
    new Uint8Array(newBuf, off, 32).set(hashBytes.slice(0, 32));
    dv.setFloat64(off + 32, ts, true);
    dv.setUint32(off + 40, offset, true);
    dv.setUint32(off + 44, length, true);

    this._indices.set(dateStr, newBuf);
  }

  async _buildIndexForDate(dateStr) {
    if (this._indices.has(dateStr)) return;
    const file = join(this._shortDir, `${dateStr}.jsonl`);
    try {
      const content = await readFile(file, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l);
      if (!lines.length) return;
      let byteOffset = 0;
      let count = 0;
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { byteOffset += Buffer.byteLength(line) + 1; continue; }
        const { hash, timestamp } = entry;
        if (!hash || !timestamp) { byteOffset += Buffer.byteLength(line) + 1; continue; }
        const lineLen = Buffer.byteLength(line) + 1;
        this._appendToIndex(dateStr, hash, timestamp, byteOffset, lineLen);
        byteOffset += lineLen;
        count++;
      }
      this._indexCounts.set(dateStr, count);
      this._dateOffsets.set(dateStr, byteOffset);
    } catch (e) { this.core?.log?.('warn', `[ying-mini] buildIndex failed for ${dateStr}: ${e.message}`); }
  }

  async _loadLongTerm() {
    const path = join(this._longDir, 'state.json');
    const candidates = [path];
    for (let i = 1; i <= this._config.backupCount; i++) candidates.push(`${path}.${i}`);

    for (const f of candidates) {
      try {
        this._longTerm = JSON.parse(await readFile(f, 'utf-8'));
        return;
      } catch {}
    }
    this._longTerm = {};
  }

  async _saveLongTerm() {
    const path = join(this._longDir, 'state.json');
    const tmp = path + '.tmp';
    try {
      for (let i = this._config.backupCount; i >= 1; i--) {
        const old = `${path}.${i}`;
        const newer = i === 1 ? path : `${path}.${i - 1}`;
        try { await rename(newer, old); } catch (e) { this.core?.log?.('error', `ying-mini: rename backup failed ${newer} -> ${old}: ${e.message}`); }
      }
      await writeFile(tmp, JSON.stringify(this._longTerm, null, 2));
      await rename(tmp, path);
    } catch (e) { this.core?.log?.('error', `ying-mini: save long-term state failed: ${e.message}`); }
  }

  async _writeAudit(entry) {
    try { await appendFile(this._auditPath, JSON.stringify(entry) + '\n'); } catch (e) { this.core?.log?.('error', `ying-mini: audit log write failed: ${e.message}`); }
  }

  async _flushBatch() {
    if (!this._writeBuffer?.size) return;
    const entries = [...this._writeBuffer];
    this._writeBuffer.clear();
    for (const [file, lines] of entries) {
      try { await appendFile(file, lines.join('')); } catch (e) { this.core?.log?.('error', `[ying-mini] flush write failed ${file}: ${e.message}`); }
    }
  }

  async _fsyncPending() {
    if (!this._currentDate) return;
    const file = join(this._shortDir, `${this._currentDate}.jsonl`);
    try {
      const fd = await fsOpen(file, 'a');
      await fd.sync();
      await fd.close();
    } catch (e) { this.core?.log?.('error', `[ying-mini] fsync failed ${file}: ${e.message}`); }
  }
}

export default new YingMini();
