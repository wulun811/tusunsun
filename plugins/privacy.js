const CONFIRM_ACTION_MAP = {
  delete_file: ['rm', 'rmdir', 'shred'],
  dependency_change: ['npm', 'pip', 'cargo', 'go install', 'gem install'],
  ci_change: ['.github/', 'ci/', 'Jenkinsfile', 'Dockerfile'],
  permission_change: ['chmod', 'chown', 'sudo'],
};

export default {
  name: 'privacy',
  version: '0.1.0',
  provides: [{ name: 'privacy', type: 'service' }],
  init(core) {
    core.registerService('privacy', this);
    this.core = core;
    this._confirmCache = new Map();
  },
  start() { this.core.log('info', 'Privacy plugin started'); },
  stop() { this._confirmCache.clear(); },

  getRequireConfirmFor() {
    return this.core.get('privacy.requireConfirmFor') || [];
  },

  shouldConfirm(actionType) {
    const required = this.getRequireConfirmFor();
    return required.includes(actionType);
  },

  classifyAction(rawCommand) {
    const trimmed = rawCommand.trim();
    const firstWord = trimmed.split(/\s+/)[0] || trimmed;
    for (const [actionType, patterns] of Object.entries(CONFIRM_ACTION_MAP)) {
      if (patterns.some(p => firstWord === p || trimmed.startsWith(p))) return actionType;
    }
    if (trimmed.startsWith('.github/') || trimmed.includes('Jenkinsfile') || trimmed.includes('Dockerfile')) return 'ci_change';
    return null;
  },

  async confirmAction(rawCommand, context = {}) {
    const actionType = this.classifyAction(rawCommand);
    if (!actionType) return { ok: true, reason: 'no_confirmation_needed' };
    if (!this.shouldConfirm(actionType)) return { ok: true, reason: 'not_in_require_list' };

    const question = context.question || `Allow "${rawCommand}"? (${actionType})`;
    const approved = await this.core.confirm(question, context.timeoutMs);
    if (approved) {
      return { ok: true, reason: 'confirmed' };
    }
    return { ok: false, reason: `Rejected: ${actionType} requires confirmation`, actionType };
  },
};
