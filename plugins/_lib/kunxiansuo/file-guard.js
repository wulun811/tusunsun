import { realpathSync } from 'node:fs';
import { dirname, join, basename, sep } from 'node:path';
import { request } from 'node:https';
// 路径字段清单只有一份（围栏边界 / 写前必读 / 工具执行共用）。
import { isFileTool, pathsOf, pickPath } from '../tool-path-args.mjs';
// 敏感路径判据只有一份：workspace、bash 命令判据与这里共用同一份名单。
import { sensitivePathOf } from '../sensitive-paths.js';

const IRREVERSIBLE_OPS = [
  /\brm\b/, /\bmv\b/, /curl\s+-F/,
  /wget\s+--post-file/, /dd\s+of=/, /\bshred\b/,
];

export class FileSystemGuard {
  constructor(cfg) {
    this.paths = cfg?.sensitivePaths || null;   // null = 用 sensitive-paths.js 的默认名单
    const rawOps = cfg?.irreversibleOps || IRREVERSIBLE_OPS;
    this.ops = rawOps.map(op => typeof op === 'string' ? new RegExp(op, 'i') : op);
    const rawRoots = cfg?.safeRoots || [process.cwd(), '/tmp', '/dev/null'];
    this.safeRoots = rawRoots.map(function(r) {
      try { return realpathSync(r); } catch { return r; }
    });
    this.enableBoundary = cfg?.enableBoundary !== false
      && process.platform !== 'win32';
    if (process.platform === 'win32') {
      console.warn('[file_guard] Boundary check disabled on Windows (RC-3)');
    }
  }

  /**
   * 敏感路径判据：覆盖全部文件类工具，路径取值走 `tool-path-args.mjs` 的同一份清单
   * （`file_path` / `filePath` / `cp`、`mv` 的 `src|dest` 都不会漏）。
   * 判据本体在 `_lib/sensitive-paths.js`：展开 ~/$HOME、追 realpath，符号链接绕不过去。
   *
   * severity 按"会不会改盘"分级：写/删/搬 = P0，只读 = P1。
   */
  checkPath(tool, args) {
    if (!isFileTool(tool)) return { ok: true };
    const WRITE_TOOLS = ['write_file', 'tool-write', 'tool-rm', 'tool-cp', 'tool-mv'];
    const severity = WRITE_TOOLS.includes(tool) ? 'P0' : 'P1';
    for (const { value: p } of pathsOf(tool, args)) {
      const matched = sensitivePathOf(p, this.paths ? { roots: this.paths } : {});
      if (!matched) continue;
      return {
        ok: false,
        code: 'FS_GUARD',
        severity,
        reason: `Path "${p}" matches sensitive path "${matched}"`,
        hint: this._suggestAlt(p),
        retryable: true,
        path: p,
      };
    }
    return { ok: true };
  }

  checkCommand(tool, args, ctx) {
    if (tool !== 'execute_command' && tool !== 'tool-bash') return { ok: true };
    // 执行器已确认过的不可恢复操作不再由本判据二次拒绝：软闸要求调用方核对实际影响面
    // 并回填，比这里的"见 rm 就拦"更严格；两条叠在一起会变成"确认了也没用"。
    // 只有执行器显式置位才生效 —— 单独使用 FileSystemGuard 的一方拿不到这个豁免。
    if (ctx?.irreversibleAcknowledged === true) return { ok: true };
    // 只认 command/cmd/script，不接受 `_raw` 别名：判据与执行必须读同一个字段。
    const cmd = args?.command ?? args?.cmd ?? args?.script ?? '';
    const found = this.ops.find(op => op.test(cmd));
    if (!found) return { ok: true };
    return {
      ok: false,
      code: 'CMD_GUARD',
      severity: 'P0',
      reason: `Command contains irreversible operation "${found}"`,
      hint: 'Consider restricting scope or using a safer alternative',
      retryable: true,
      command: cmd,
    };
  }

  /**
   * 边界判据：解析后不得逃出 safeRoots。
   * 遍历 `pathsOf()` 给出的**全部**路径：任一端越界即拒绝 —— cp/mv 只查一端
   * 等于给"把文件搬到工作区外"留一半的门。
   */
  checkBoundary(tool, args) {
    if (!this.enableBoundary) return { ok: true };
    if (!isFileTool(tool)) return { ok: true };

    const targets = pathsOf(tool, args);
    if (targets.length === 0) return { ok: true };

    for (const { field, value } of targets) {
      const r = this._boundaryForOne(value);
      if (!r.ok) return { ...r, field };
    }
    return { ok: true };
  }

  /** 单条路径的边界判定（checkBoundary 逐条调用；拆出来是为了"两端都查"而不重复代码）。 */
  _boundaryForOne(rawPath) {
    if (rawPath === '/dev/null' || rawPath === '/dev/stdout' || rawPath === '/dev/stderr') {
      return { ok: true };
    }

    let resolved;
    try {
      resolved = realpathSync(rawPath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        try {
          const parent = dirname(rawPath);
          const realParent = realpathSync(parent);
          resolved = join(realParent, basename(rawPath));
        } catch {
          return {
            ok: false,
            code: 'SYMLINK_ESCAPE',
            severity: 'P0',
            reason: 'Path and parent directory do not exist',
            hint: 'Symbolic link or path traversal detected, operation blocked',
            retryable: false,
            path: rawPath,
          };
        }
      } else {
        return { ok: true };
      }
    }

    const isSafe = this.safeRoots.some(root => resolved === root || resolved.startsWith(root + sep));
    if (!isSafe) {
      return {
        ok: false,
        code: 'SYMLINK_ESCAPE',
        severity: 'P0',
        reason: `Resolved path "${resolved}" escapes project boundary`,
        hint: 'Symbolic link or path traversal detected, operation blocked',
        retryable: false,
        path: resolved,
      };
    }

    return { ok: true };
  }

  _suggestAlt(path) {
    return `Try a non-sensitive path instead, e.g. /tmp/safe_output.txt`;
  }

  // --- 2.7 依赖风险评级 (OSV.dev) ---
  async checkDependencyRisk(name, version) {
    if (!name) return { ok: true, vulnerabilities: [] };
    const pkg = version ? `${name}@${version}` : name;
    try {
      const body = JSON.stringify({ package: { name, ecosystem: 'npm' }, version: version ? [version] : [] });
      const result = await this._osvQuery(body);
      if (!result || !result.results) return { ok: true, vulnerabilities: [] };
      const vulns = result.results.flatMap(r => r.vulnerabilities || []);
      return {
        ok: vulns.length === 0,
        package: pkg,
        total: vulns.length,
        vulnerabilities: vulns.slice(0, 10).map(v => ({
          id: v.id,
          severity: v.database_specific?.severity || 'UNKNOWN',
          summary: v.summary?.slice(0, 200) || v.aliases?.[0] || v.id,
        })),
      };
    } catch (e) {
      return { ok: true, vulnerabilities: [], error: e.message };
    }
  }

  async checkPackageJson(dir) {
    const { existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) return { ok: true, dependencies: [] };
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      const results = [];
      for (const [name, ver] of Object.entries(allDeps).slice(0, 20)) {
        const cleanVer = ver.replace(/^[\^~>=<]/, '');
        const risk = await this.checkDependencyRisk(name, cleanVer);
        if (!risk.ok) results.push(risk);
      }
      return { ok: results.length === 0, dependencies: results };
    } catch {
      return { ok: true, dependencies: [] };
    }
  }

  _osvQuery(body) {
    return new Promise((resolve, reject) => {
      const req = request({
        hostname: 'api.osv.dev', path: '/v1/querybatch', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });
  }
}
