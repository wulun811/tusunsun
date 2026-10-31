// diagnostic-lite.js — 轻量错误格式化（无外部诊断服务依赖）
// 捆仙索 local 模式下的诊断卡片格式化

export function toLLMText(card) {
  const lines = [];
  lines.push(`[Blocked] ${card.code || 'UNKNOWN'}: ${card.reason || 'Tool blocked'}`);
  if (card.tool) lines.push(`Tool: ${card.tool}`);
  if (card.hint) lines.push(`Hint: ${card.hint}`);
  if (card.alternatives?.length) {
    lines.push(`Alternatives: ${card.alternatives.join(', ')}`);
  }
  if (card.retryable) lines.push('Retryable: yes');
  return lines.join('\n');
}
