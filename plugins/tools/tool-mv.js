import { rename, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { declarableSchema } from './lib/schema.mjs';
import { resolveWorkspacePath } from './lib/workspace.mjs';

/** 被覆盖前的旧目标：留一份可核对的指纹，让“覆盖了什么”在回执里说得出来。 */
async function readBackFact(absPath) {
  try {
    const buf = await readFile(absPath);
    return { path: absPath, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  } catch {
    return { path: absPath, bytes: null, sha256: null };
  }
}

class ToolMv {
  name = 'tool-mv';
  version = '0.2.0';
  permissions = ['fs.write'];
  provides = [{ name: 'tool.mv', removable: true }];
  cohesion = 'atomic';
  description = 'Move or rename files. IMPORTANT: paths must be RELATIVE to workspace.';
  parameters = {
    type: 'object',
    properties: {
      src: { type: 'string', description: 'RELATIVE source path from workspace' },
      dest: { type: 'string', description: 'RELATIVE destination path from workspace' },
      overwrite: { type: 'boolean', description: 'Allow replacing an existing dest (default false). Without it a move onto an existing file is refused, never silently applied' },
    },
    required: ['src', 'dest'],
  };

  async init(core) {
    this.core = core;
    core.registerCapability('tool.mv', {
      description: 'Move or rename files',
      handler: (args) => this.execute(args),
      // R0-152：只把内核**真能校验**的部分作为 input_schema（`parameters` 里的 enum/items
      // 等给模型看的约束不进校验层，否则注册会被 core 具名拒绝，工具直接装不上）。
      input_schema: declarableSchema(this.parameters),
      owner: 'tool-mv',
    });
  }

  async execute(args) {
    const workDir = this.core.getService?.('workspace')?.root(args?._sessionId) || this.core.getData('agent.workDir') || process.cwd(); // R0-124：会话根目录 > 进程默认
    try {
      const { src, dest } = args;
      if (!src || !dest) throw Object.assign(new Error('Error: src and dest are required'), { code: 'invalid_input', contractError: true });
      
      // R0-113（P0-02）：mv 的**两端**都要过同一条边界判据
      const fullSrc = await resolveWorkspacePath(workDir, src);
      const fullDest = await resolveWorkspacePath(workDir, dest);
      // `rename()` 遇到已存在的目标会**默默覆盖**：实测 `mv src/a.txt dst/a.txt`（dst 已有一份）
      // 返回 `{ok:true}`，目标原有内容消失，模型得到的是一个“成功”且没有任何提示。
      // 不可恢复的旧版本内容丢掉之后，连“刚才覆盖了什么”都无法回放。
      // 现在默认拒绝，要把覆盖变成显式决定（`overwrite:true`），并在回执里点名被替换的旧文件。
      // **落位那一刻才判定**，而不是"先 existsSync 再 rename"。
      // 后者是一段有时间窗口的两步：实测 24 进程 × 4 回合（闸门同步到落位）里，
      // 有 1 个回合出现 2 个进程同时"成功"—— 两次都返回 ok，后一个静默覆盖前一个。
      // 正确做法是让**内核**回答"目标存不存在"：`link(src, dest)` 在目标已存在时返回 EEXIST，
      // 是原子的；成功后再删源。这样并发里只有一个能赢，其余具名 dest_exists。
      // 注意 mv 与 cp 的差别：mv 的源在同一文件系统内，`link` 之后仍需 `unlink(src)`；
      // 跨设备的源在这里会先被 link 拒绝（EXDEV），那就退回 rename 的旧路径。
      let replaced = null;
      if (existsSync(fullDest) && args.overwrite !== true) {
        throw Object.assign(new Error(
          `Error: destination already exists: "${dest}". Refusing to overwrite silently. `
          + `Move it away first, or pass overwrite:true if replacing it is intended.`),
        { code: 'dest_exists', contractError: true });
      }
      if (existsSync(fullDest)) replaced = await readBackFact(fullDest);
      const st = await lstat(fullSrc);
      if (args.overwrite === true) {
        // 显式覆盖：rename 就是我们要的语义（原子替换），不需要 link。
        await rename(fullSrc, fullDest);
      } else if (st.isDirectory()) {
        // 目录不能用 link 占位（会返回 EPERM）；用 rename，并以"目标不存在"为前提重判一次。
        if (existsSync(fullDest)) {
          throw Object.assign(new Error(
            `Error: destination already exists: "${dest}". Refusing to overwrite silently.`),
          { code: 'dest_exists', contractError: true });
        }
        await rename(fullSrc, fullDest);
      } else {
        const { link, unlink } = await import('node:fs/promises');
        try {
          await link(fullSrc, fullDest);   // 原子：目标已存在 ⇒ EEXIST
        } catch (err) {
          if (err.code === 'EEXIST') {
            throw Object.assign(new Error(
              `Error: destination was created by someone else while moving: "${dest}". Refusing to overwrite it.`),
            { code: 'dest_exists', contractError: true });
          }
          // 不支持硬链接/跨设备的文件系统：退回 rename（此处已无原子性保证，如实标注）。
          if (['EPERM', 'ENOSYS', 'EACCES', 'ENOTSUP', 'EXDEV', 'EMLINK'].includes(err.code)) {
            if (existsSync(fullDest)) {
              throw Object.assign(new Error(
                `Error: destination already exists: "${dest}". Refusing to overwrite silently.`),
              { code: 'dest_exists', contractError: true });
            }
            await rename(fullSrc, fullDest);
            return { ok: true, ...(replaced ? { replaced } : {}), atomic: false };
          }
          throw err;
        }
        await unlink(fullSrc);            // link 成功后才删源；失败时源仍在（不丢数据）
      }
      return { ok: true, ...(replaced ? { replaced } : {}) };
    } catch (err) {
      if (err?.contractError) throw err;   // 本契约的具名失败原样上抛；系统错误码（ENOENT 等）不在此列
      throw Object.assign(new Error(`Error: ${err.message}`), { code: 'resource_error', contractError: true });
    }
  }
}

export default new ToolMv();
