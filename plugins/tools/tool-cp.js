import { cp, stat, lstat, mkdir, readFile, rename, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { declarableSchema } from './lib/schema.mjs';
import { resolveWorkspacePath } from './lib/workspace.mjs';

const IS_WINDOWS = process.platform === 'win32';

/** 覆盖前对被替换对象的指纹：让"覆盖了什么"在回执里说得出来，而不是一句 ok。 */
async function fingerprint(absPath) {
  try {
    const st = await lstat(absPath);
    if (st.isDirectory()) {
      const names = await readdir(absPath);
      return { path: absPath, kind: 'directory', entries: names.length, bytes: null, sha256: null };
    }
    const buf = await readFile(absPath);
    return { path: absPath, kind: 'file', bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  } catch (err) {
    return { path: absPath, kind: 'unknown', bytes: null, sha256: null, error: err.code || String(err.message) };
  }
}

function contractError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, contractError: true, ...extra });
}

class ToolCp {
  name = 'tool-cp';
  version = '0.3.0';
  permissions = ['fs.write'];
  provides = [{ name: 'tool.cp', removable: true }];
  cohesion = 'atomic';
  description = 'Copy files or directories. Refuses to write over an existing destination unless overwrite:true. IMPORTANT: paths must be RELATIVE to workspace.';
  parameters = {
    type: 'object',
    properties: {
      src: { type: 'string', description: 'RELATIVE source path from workspace' },
      dest: { type: 'string', description: 'RELATIVE destination path from workspace' },
      overwrite: { type: 'boolean', description: 'Allow replacing an existing destination (default false). Without it a copy onto an existing path is refused, never silently applied' },
    },
    required: ['src', 'dest'],
  };

  async init(core) {
    this.core = core;
    core.registerCapability('tool.cp', {
      description: 'Copy files or directories',
      handler: (args) => this.execute(args),
      // R0-152：只把内核**真能校验**的部分作为 input_schema（`parameters` 里的 enum/items
      // 等给模型看的约束不进校验层，否则注册会被 core 具名拒绝，工具直接装不上）。
      input_schema: declarableSchema(this.parameters),
      owner: 'tool-cp',
    });
  }

  /**
   * 落位那一刻才做存在性判定 —— 用"创建"而不是"先查再写"表达拒绝。
   *
   * `existsSync` 之后再 `cp` 是一段有时间窗口的两步：两个并发 cp 可以都看见"目标不存在"，
   * 然后都成功，后者覆盖前者，两次都报 ok —— 与 `tool-mv` 修前的形态同源。
   * 所以先在同一目录里把内容写进一个私有暂存名（`wx` 语义，绝不重名），再 `link()` 到目标：
   * `link` 在目标已存在时返回 EEXIST，是**内核判据**而非我们自己的猜测。
   * 只支持单文件的这条路径；目录树用 `cp` 的 `force:false` 语义 + 事后一致性核对。
   */
  async _placeFile(tmpPath, fullDest, overwrite) {
    let st;
    try { st = await lstat(fullDest); } catch { st = null; }   // 目标不存在 = 正常路径
    if (st) {
      // 目标存在：默认拒绝。**符号链接也算存在** —— 写穿链接改的是链接指向的文件，
      // 那既不是用户说的 dest，也不在 checkConfigPath/边界判据的视野里。
      if (!overwrite) {
        throw contractError(
          `Error: destination already exists: "${fullDest}". Refusing to overwrite silently. `
          + `Remove it first, or pass overwrite:true if replacing it is intended.`
          + (st.isSymbolicLink() ? ' (the destination is a symlink)' : ''),
          'dest_exists', { dest_kind: st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : 'file' });
      }
      if (st.isDirectory()) {
        throw contractError(
          `Error: destination is a directory: "${fullDest}". Copying a file onto a directory is ambiguous `
          + '(replace the whole tree, or write inside it?) and is refused in both modes.',
          'dest_is_directory', { dest_kind: 'directory' });
      }
      // 覆盖：先记旧目标的指纹（回执要说得清替换了什么），再把旧目标挪成私有备份名，
      // 最后落新内容。落位失败就把旧的挪回去 —— "覆盖到一半"不该是一种可达状态。
      const replacedFact = await fingerprint(fullDest);
      const backup = `${fullDest}.cprev-${randomBytes(6).toString('hex')}`;
      await rename(fullDest, backup);
      try {
        await this._linkOrCopy(tmpPath, fullDest);
        await rm(backup, { force: true, recursive: true });
        return { replaced: true, replacedFact };
      } catch (err) {
        await rm(fullDest, { force: true, recursive: true }).catch(() => {});
        await rename(backup, fullDest).catch(() => {});
        throw err;
      }
    }
    await this._linkOrCopy(tmpPath, fullDest);
    return { replaced: false };
  }

  /**
   * 把暂存文件变成目标。优先 `link()`（原子、目标存在即 EEXIST），
   * 不支持的平台/文件系统（Windows、部分 FUSE）退回 `rename()` + 存在性复核。
   */
  async _linkOrCopy(tmpPath, fullDest) {
    const { link } = await import('node:fs/promises');
    if (!IS_WINDOWS) {
      try {
        await link(tmpPath, fullDest);
        await rm(tmpPath, { force: true });
        return;
      } catch (err) {
        if (err.code === 'EEXIST') {
          await rm(tmpPath, { force: true }).catch(() => {});
          throw contractError(
            `Error: destination was created by someone else while copying: "${fullDest}". Refusing to overwrite it.`,
            'dest_exists');
        }
        // EPERM/ENOSYS/EACCES（FUSE、容器只读层、Windows 语义）⇒ 走下面的退路
        if (!['EPERM', 'ENOSYS', 'EACCES', 'ENOTSUP', 'EXDEV', 'EMLINK'].includes(err.code)) {
          await rm(tmpPath, { force: true }).catch(() => {});
          throw err;
        }
      }
    }
    // 退路：rename 会覆盖（Windows 上不覆盖反而报 EEXIST），故先做一次存在性复核。
    // 这仍有时间窗口，所以它是**退路**而不是主路径，且在回执里如实标注。
    if (existsSync(fullDest)) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw contractError(
        `Error: destination already exists: "${fullDest}". Refusing to overwrite silently.`, 'dest_exists');
    }
    await rename(tmpPath, fullDest);
  }

  async execute(args) {
    const workDir = this.core.getService?.('workspace')?.root(args?._sessionId) || this.core.getData('agent.workDir') || process.cwd(); // R0-124：会话根目录 > 进程默认
    let tmpPath = null;
    try {
      const { src, dest } = args;
      if (!src || !dest) throw contractError('Error: src and dest are required', 'invalid_input');

      // R0-113（P0-02）：cp 的**两端**都要过同一条边界判据（旧实现只查了前缀）
      const fullSrc = await resolveWorkspacePath(workDir, src);
      const fullDest = await resolveWorkspacePath(workDir, dest);
      const s = await stat(fullSrc);

      if (s.isDirectory()) {
        // 目录：cp 的 merge 语义本身就是"往已有目录里加文件"，这里只允许**目标不存在**时新建。
        // 合并到一个已有目录会让"目标里原本有什么"取决于运气（同名文件被覆盖、其它保留），
        // 而回执只有一个 bytes —— 那是本版要消灭的那类回执。
        if (existsSync(fullDest) && args.overwrite !== true) {
          throw contractError(
            `Error: destination already exists: "${fullDest}". Refusing to merge into an existing directory. `
            + 'Remove it first, or pass overwrite:true if merging is intended.',
            'dest_exists', { dest_kind: 'directory' });
        }
        const replaced = existsSync(fullDest) ? await fingerprint(fullDest) : null;
        await mkdir(dirname(fullDest), { recursive: true });
        await cp(fullSrc, fullDest, { recursive: true, errorOnExist: false, force: true });
        return { ok: true, kind: 'directory', ...(replaced ? { replaced } : {}) };
      }

      // 单文件：写进同目录私有暂存名，再原子落位。暂存名带随机后缀且用 `wx` 打开 ⇒
      // 两个并发 cp 不可能写进同一个暂存文件。
      await mkdir(dirname(fullDest), { recursive: true });
      tmpPath = join(dirname(fullDest), `.${basename(fullDest)}.cptmp-${randomBytes(6).toString('hex')}`);
      const { writeFile } = await import('node:fs/promises');
      const body = await readFile(fullSrc);
      await writeFile(tmpPath, body, { flag: 'wx', mode: 0o600 });
      const fact = await this._placeFile(tmpPath, fullDest, args.overwrite === true);
      tmpPath = null;
      return { ok: true, kind: 'file', bytes: body.length, ...(fact.replaced ? { replaced: fact.replacedFact } : {}) };
    } catch (err) {
      if (tmpPath) await rm(tmpPath, { force: true }).catch(() => {});
      if (err?.contractError) throw err;   // 本契约的具名失败原样上抛；系统错误码（ENOENT 等）不在此列
      throw contractError(`Error: ${err.message}`, 'resource_error');
    }
  }
}

export default new ToolCp();
