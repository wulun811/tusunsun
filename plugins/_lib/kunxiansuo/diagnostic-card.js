export class DiagnosticCard {
  static create({ code, tool, reason, alternatives, hint, retryable, chainId, retryCount, severity: overrideSeverity, path, command, context, suggestions, count, max, args, errors, sessionBlockCount, matchedRule, dangerPattern }) {
    const severity = overrideSeverity || this._severityOf(code);
    return {
      status: severity === 'P0' ? 'blocked' : code,
      code,
      severity,
      reason,
      hint: hint || this._defaultHint(code, { count, max, path, command }),
      alternatives: [...(alternatives || [])],
      retryable: retryable && code !== 'Y024',
      retry_after_ms: this._cooldown(code),
      chain_id: chainId,
      retry_count: retryCount,
      path,
      command,
      context: context || null,
      suggestions: suggestions || [],
      _count: count,
      _maxPerWindow: max,
      args: args || null,
      errors: errors || [],
      sessionBlockCount: sessionBlockCount || 0,
      matchedRule: matchedRule || null,
      dangerPattern: dangerPattern || null,
    };
  }

  static _severityOf(code) {
    const map = {
      'Y024': 'P0', 'Y040': 'P0', 'F020': 'P0',
      'Y019': 'P1', 'Y039': 'P1', 'NETWORK': 'P1',
      'rate_limited': 'P1', 'circuit_open': 'P1',
      'quota_exceeded': 'P1', 'SCHEMA_ERROR': 'P2', 'input_validation': 'P2',
      'FS_GUARD': 'P1', 'CMD_GUARD': 'P0',
    };
    return map[code] || 'P2';
  }

  static _cooldown(code) {
    const map = {
      'Y024': 0, 'rate_limited': 60, 'circuit_open': 30,
      'quota_exceeded': 300, 'SCHEMA_ERROR': 0, 'input_validation': 0, 'FS_GUARD': 0,
      'CMD_GUARD': 5000,
    };
    return map[code] || 0;
  }

  static _defaultHint(code, opts = {}) {
    const hints = {
      'Y024': 'This tool is permanently blocked for safety reasons.',
      'Y040': 'Infinite loop detected. Try a different approach or break the cycle.',
      'F020': 'Context isolation boundary crossed. This step cannot access previous context.',
      'NETWORK': 'Network fault detected. Retry may work after recovery.',
      'rate_limited': `Rate limit hit. Called ${opts.count || '?'} times (max ${opts.max || '?'}). Wait before retrying.`,
      'quota_exceeded': 'Session quota reached. Wait for the next window to reset.',
      'circuit_open': `Circuit breaker open — ${opts.count || '?'} of ${opts.max || '?'} recent calls failed. Wait for cooldown.`,
      'SCHEMA_ERROR': 'Schema validation failed. Check tool arguments against the expected schema.',
      'input_validation': 'Input validation failed. Check parameter types and constraints.',
      'FS_GUARD': `Path "${opts.path || 'this location'}" is sensitive. Write to a safe location instead.`,
      'CMD_GUARD': 'This command contains a dangerous operation. Use a safer alternative.',
    };
    return hints[code] || 'This call was blocked by safety policy.';
  }

  static _formatContext(context) {
    if (!context) return { inline: '', detail: '' };
    const inlineParts = [];
    const detailParts = [];
    if (context.triggerStep) {
      inlineParts.push(`step:${context.triggerStep}`);
      detailParts.push(`DAG step "${context.triggerStep}"`);
    }
    if (context.triggerTemplate && context.triggerTemplate !== 'unknown') {
      inlineParts.push(`template:${context.triggerTemplate}`);
      detailParts.push(`template "${context.triggerTemplate}"`);
    }
    if (context.replanCount > 0) {
      inlineParts.push(`replan:${context.replanCount}`);
      detailParts.push(`replan #${context.replanCount}`);
    }
    return {
      inline: inlineParts.length ? ` (${inlineParts.join(', ')})` : '',
      detail: detailParts.length ? `\n Trigger: ${detailParts.join(', ')}.` : '',
    };
  }

  static _argsSummary(args) {
    if (!args || typeof args !== 'object') return '';
    const keys = Object.keys(args).filter(k => k !== '_tcId');
    if (!keys.length) return '';
    const parts = keys.map(k => {
      const v = typeof args[k] === 'string' && args[k].length > 80 ? args[k].slice(0, 77) + '...' : JSON.stringify(args[k]);
      return `${k}=${v}`;
    });
    return parts.join(', ');
  }
}

export function toLLMText(card) {
  if (!card || !card.code) return 'Operation blocked (unknown reason)';
  const { inline: contextStr, detail: triggerLine } = DiagnosticCard._formatContext(card.context);
  const altStr = card.alternatives?.length ? ` Alternatives: ${card.alternatives.join(', ')}.` : '';
  const suggestStr = card.suggestions?.length ? `\n Best recovery: ${card.suggestions[0].tool} (${Math.round(card.suggestions[0].successRate * 100)}% success, n=${card.suggestions[0].sampleSize})` : '';
  const blockCountStr = card.sessionBlockCount > 1 ? `\n Blocked ${card.sessionBlockCount}x this session.` : '';
  const argsStr = card.args ? `\n Args: ${DiagnosticCard._argsSummary(card.args)}` : '';

  const detailed = [triggerLine, argsStr, blockCountStr, suggestStr].filter(Boolean).join('');

  switch (card.code) {
    case 'FS_GUARD': {
      const ruleStr = card.matchedRule ? ` (matched: ${card.matchedRule})` : '';
      return `[BLOCKED:FS_GUARD] Cannot ${card.tool === 'read_file' ? 'read from' : 'write to'} "${card.path || 'this path'}"${ruleStr}${contextStr}.${detailed}${altStr || ''}`;
    }
    case 'CMD_GUARD': {
      const patternStr = card.dangerPattern ? ` (pattern: ${card.dangerPattern})` : '';
      return `[BLOCKED:CMD_GUARD] Command "${card.command || ''}" is blocked${patternStr}${contextStr}.${detailed} Try a safer alternative.`;
    }
    case 'rate_limited':
      return `[BLOCKED:RATE_LIMIT] ${card.tool} called ${card._count || '?'} times (max ${card._maxPerWindow || '?'})${contextStr}.${detailed} ${card.hint}.`;
    case 'circuit_open':
      return `[BLOCKED:CIRCUIT_OPEN] ${card.tool} circuit breaker OPEN \u2014 ${card._count || '?'}/${card._maxPerWindow || '?'} recent failures${contextStr}.${detailed} ${card.hint}.`;
    case 'quota_exceeded':
      return `[BLOCKED:QUOTA] Session quota reached${contextStr}.${detailed} ${card.hint}.`;
    case 'SCHEMA_ERROR': {
      const errDetails = card.errors?.length ? `\n Errors:\n${card.errors.map(function(e) { return `  \u2022 ${e.field}: expected ${e.expected}, got ${e.received} \u2014 ${e.suggestion}`; }).join('\n')}` : '';
      return `[BLOCKED:SCHEMA_ERROR] ${card.reason || 'Schema validation failed'}${contextStr}.${detailed}${errDetails}`;
    }
    case 'input_validation':
      return `[BLOCKED:INPUT_VALIDATION] ${card.reason || 'Input validation failed'}${contextStr}.${detailed} ${card.hint}.`;
    case 'Y024':
      return `[BLOCKED:BLACKLIST] Tool "${card.tool}" is prohibited${contextStr}.${detailed} ${card.hint}. Alternatives: ${(card.alternatives || []).join(', ') || 'try a different approach'}`;
    case 'Y040':
      return `[BLOCKED:INFINITE_LOOP] Tool loop detected${contextStr}.${detailed} ${card.hint}.`;
    case 'F020':
      return `[BLOCKED:ISOLATION] Context isolation violation${contextStr}.${detailed} ${card.hint}.`;
    case 'NETWORK':
      return `[BLOCKED:NETWORK] Network fault affecting session${contextStr}.${detailed} ${card.hint}.`;
    default:
      return `[BLOCKED] ${card.code}: ${card.reason || card.hint || 'Operation rejected by security policy'}${contextStr}${detailed}`;
  }
}


