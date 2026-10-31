export class RetryChainTracker {
  constructor(maxRetries = 3, windowMs = 10000) {
    this.maxRetries = maxRetries;
    this.window = windowMs;
    this._chains = new Map();
    this._alternatives = new Map();
  }

  saw(toolName, chainId = 'default') {
    const key = `${chainId}::${toolName}`;
    const now = Date.now();
    let entry = this._chains.get(key);
    if (!entry || now - entry.firstSeen > this.window) {
      entry = { count: 0, firstSeen: now, lastSeen: now };
    }
    entry.count++;
    entry.lastSeen = now;
    this._chains.set(key, entry);
    this._pruneAlternatives(now);
    return entry.count > this.maxRetries ? { escalated: true, count: entry.count } : { escalated: false, count: entry.count };
  }

  _pruneAlternatives(now) {
    for (const [key, entry] of this._alternatives) {
      if (now - entry.ts > this.window) this._alternatives.delete(key);
    }
  }

  recordAlternatives(blockedTool, chainId, alternatives) {
    if (!alternatives?.length) return;
    const key = `${chainId}::${blockedTool}`;
    this._alternatives.set(key, { alternatives: new Set(alternatives), ts: Date.now() });
  }

  checkRecovery(succeededTool, chainId) {
    for (const [key, entry] of this._alternatives) {
      if (entry.alternatives.has(succeededTool)) {
        this._alternatives.delete(key);
        return key.split('::')[1];
      }
    }
    return null;
  }

  reset(chainId, toolName) {
    if (toolName) {
      this._chains.delete(`${chainId}::${toolName}`);
      this._alternatives.delete(`${chainId}::${toolName}`);
    } else {
      for (const k of this._chains.keys()) {
        if (k.startsWith(`${chainId}::`)) this._chains.delete(k);
      }
      for (const k of this._alternatives.keys()) {
        if (k.startsWith(`${chainId}::`)) this._alternatives.delete(k);
      }
    }
  }

  get chains() { return new Map(this._chains); }
}
