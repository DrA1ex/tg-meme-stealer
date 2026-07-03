import { formatSchedule, formatTemplateLines, setupScreen } from './formattingBase.js';
import { formatPublishChanges } from './publishPresets.js';

export function formatManagePublishTemplates(draft = {}) {
  const templates = getPublishTemplates(draft);
  const enabled = templates.filter((template) => template.enabled !== false);
  const disabled = templates.filter((template) => template.enabled === false);

  return setupScreen({
    icon: '🗂',
    title: 'Manage publishing templates',
    sections: [
      ['📌 Summary', [`Templates: ${templates.length}.`, `Enabled: ${enabled.length}.`, `Disabled: ${disabled.length}.`]],
      ['✅ Enabled', formatTemplateLines(enabled, { includeDisabled: true })],
      ['⏸ Disabled', disabled.length ? formatTemplateLines(disabled, { includeDisabled: true }) : ['- none']],
      ['➡️ Next', ['Disable to keep a schedule in config but stop it running.', 'Remove to delete it from draft publish.template.']]
    ]
  });
}

export function formatConfirmRemovePublishTemplate(draft = {}, key) {
  const template = findPublishTemplate(draft, key);
  return setupScreen({
    icon: '⚠️',
    title: 'Remove publish template?',
    sections: [
      ['🗑 Template', template ? [
        `${template.key}: ${template.source || '<missing source>'}, ${formatSchedule(template.schedule)}, window=${template.windowHours ?? '?'}h`,
        'This removes it from draft publish.template only.',
        'Existing publication records in the database are not deleted.'
      ] : [`Template not found: ${key}`]],
      ['➡️ Next', ['Confirm only if you want to remove this schedule from the draft config.']]
    ]
  });
}

export function setPublishTemplateEnabled(draft, key, enabled) {
  const template = findPublishTemplate(draft, key);
  if (!template) throw new Error(`Publish template not found: ${key}`);
  template.enabled = Boolean(enabled);
}

export function removePublishTemplate(draft, key) {
  draft.publish = draft.publish || {};
  draft.publish.template = getPublishTemplates(draft).filter((template) => template.key !== key);
}

export function formatPublishTemplateChanged({ beforePublish, afterPublish, action, key }) {
  return setupScreen({
    icon: '✅',
    title: 'Publish template changed',
    sections: [
      ['📌 Action', [`${action}: ${key}`]],
      ['📣 Changed', formatPublishChanges(beforePublish, afterPublish, { compact: true })],
      ['➡️ Next', ['Run Schedule preview or Schedule doctor, then Preview before saving.']]
    ]
  });
}

export function getPublishTemplates(draft = {}) {
  return Array.isArray(draft.publish?.template) ? draft.publish.template : [];
}

export function findPublishTemplate(draft = {}, key) {
  return getPublishTemplates(draft).find((template) => template.key === key) || null;
}
