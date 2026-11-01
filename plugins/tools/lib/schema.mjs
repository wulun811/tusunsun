// R0-152（v0.9.32 续）：把工具声明的 `parameters` 转成 core 愿意接受的 `input_schema`。
//
// 为什么需要这一步 —— 我在这里踩了一个自己的坑，记下来：
//
//   R0-145 让工具声明的 `parameters` 真正成为 `input_schema`（此前执行期零校验）。
//   但 `parameters` 是**给模型看的**接口说明，可以用 `enum` / `items` / `pattern`
//   这类描述性关键字；而 core 只支持 required / type / additionalProperties，
//   其余关键字在**注册时具名拒绝**（R0-28 的决定：宁可注册失败，也不静默忽略
//   一个声明了的约束 —— 那个决定是对的）。
//
//   两者相遇的后果是：`tool-todo` 和 `tool-validate` 的 `parameters` 里有 `enum`，
//   接上 schema 之后**工具直接装不上**：
//       schema_unsupported：能力 "tool.todo" 的 input_schema 使用了本内核不校验的关键字 'enum'
//   也就是说，一次"让声明生效"的修复，让两个工具彻底不可用。
//
// 正确的分工：
//   · `parameters` —— 完整声明，给模型看（提示词与 `agent.tool.register` 事件读它）；
//   · `input_schema` —— 只放 core 能**真的校验**的部分，作为执行期的硬判据。
//   剥掉的关键字不是"被忽略"，而是"没有进入校验层"—— 这比让声明里的约束
//   假装生效（其实不校验）要诚实。
const UNSUPPORTED = new Set([
  'enum', 'const', 'oneOf', 'anyOf', 'allOf', 'not', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'items', 'minItems', 'maxItems', 'uniqueItems', '$ref',
  // 属性子表只允许 `type` + title/description/default；嵌套的对象子结构（如
  // `danger_ack: {properties, required}`）在这里整体剥掉 —— core 不递归校验子结构，
  // 留着会在注册期被具名拒绝，工具直接装不上。模型仍从 `parameters` 看到完整声明。
  'properties', 'required', 'additionalProperties',
]);

/**
 * 剥掉内核不支持的关键字，返回一个可以安全传给 `registerCapability` 的 schema。
 * 顶层（required / type / additionalProperties）原样保留，只过滤 properties 下的规则。
 */
export function declarableSchema(parameters) {
  const src = parameters && typeof parameters === 'object' ? parameters : null;
  if (!src) return undefined;
  const properties = {};
  for (const [k, spec] of Object.entries(src.properties || {})) {
    properties[k] = Object.fromEntries(Object.entries(spec || {}).filter(([kw]) => !UNSUPPORTED.has(kw)));
  }
  return { ...src, properties };
}
