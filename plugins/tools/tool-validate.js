import { declarableSchema } from './lib/schema.mjs';
import { loadJson5 } from '../../src/core/json5-loader.js';

class ToolValidate {
  name = 'tool-validate';
  version = '0.1.0';
  permissions = ['fs.read'];
  provides = [{ name: 'tool.validate', removable: true, resultContract: 'execution_result' }];
  cohesion = 'atomic';
  description = 'Validate JSON/YAML/JSON5 syntax';
  parameters = {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['json', 'yaml', 'json5'], description: 'Data format' },
      content: { type: 'string', description: 'Content to validate' },
    },
    required: ['format', 'content'],
  };

  async init(core) {
    this.core = core;
    core.registerCapability('tool.validate', {
      description: 'Validate JSON/YAML/JSON5 syntax',
      handler: (args) => this.execute(args),
      // 只把内核真能校验的部分作为 input_schema：给模型看的约束（enum/items）不进校验层，
      // 否则注册会被 core 具名拒绝，工具装不上。
      input_schema: declarableSchema(this.parameters),
      owner: 'tool-validate',
    });
  }

  execute(args) {
    try {
      const { format, content } = args;
      if (!format || content === undefined) throw Object.assign(new Error('Error: format and content are required'), { code: 'invalid_input', contractError: true });

      if (format === 'json') {
        JSON.parse(content);
        return { ok: true };
      }

      if (format === 'json5') {
        // 无求值解析：content 是模型给的任意字符串，new Function / eval 都等于让模型
        // 在内核主进程里执行代码。
        try {
          loadJson5(String(content));
          return { ok: true };
        } catch (err) {
          // 解析器是通用件，报错前缀是它的；这里换成工具自己的措辞，避免模型看到无关的“scene config”。
          const reason = String(err.message).replace(/^Invalid scene config: /, '');
          return { ok: false, error: `Invalid JSON5 syntax: ${reason}` };
        }
      }

      if (format === 'yaml') {
        return { ok: false, error: 'YAML validation requires python3 (not available in this environment)' };
      }

      throw Object.assign(new Error(`Error: unsupported format "${format}"`), { code: 'invalid_input', contractError: true });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

export default new ToolValidate();
