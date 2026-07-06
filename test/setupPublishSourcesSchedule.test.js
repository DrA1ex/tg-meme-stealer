import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPublishPresetToDraft,
  formatAppliedPublishPreset,
  formatConfirmReplacePublishPreset,
  formatPublishChanges,
  formatPublishPresetDetails,
  getPublishPreset,
  publishTemplate
} from '../src/telegram/setup/publishPresets.js';
import {
  findPublishTemplate,
  formatConfirmRemovePublishTemplate,
  formatManagePublishTemplates,
  formatPublishTemplateChanged,
  getPublishTemplates,
  removePublishTemplate,
  setPublishTemplateEnabled
} from '../src/telegram/setup/publishTemplates.js';
import {
  applySourcePreset,
  formatCustomSourceHelp,
  formatResetSources,
  formatSourcesMenu,
  getSourcePreset,
  parseCustomSourceInput,
  parseSourceTextCommand,
  resetDraftSources
} from '../src/telegram/setup/sourcePresets.js';
import {
  applyManualSchedule,
  buildManualScheduleTemplates,
  createScheduleWizard,
  formatManualScheduleApplied,
  formatManualScheduleConfirm,
  formatManualScheduleWizard,
  getPublishSources,
  getWizardNextStep,
  normalizeWizardStep
} from '../src/telegram/setup/scheduleWizard.js';
import {
  buildDatabaseTrafficScheduleSuggestions,
  buildRecentTrafficScheduleSuggestions,
  buildTrafficPreset,
  formatScheduleDoctor,
  formatSchedulePreview,
  getMaxTrafficDays
} from '../src/telegram/setup/scheduleDiagnostics.js';

test('publish presets can apply/update or replace templates without losing source definitions', () => {
  const preset = getPublishPreset('daily_top_night');
  const draft = {
    publish: {
      sources: [{ key: 'best', where: 'likes >= 10' }, { key: 'custom', where: 'dislikes > likes' }],
      template: [template({ key: 'legacy_custom', source: 'custom' })]
    }
  };
  const beforePublish = structuredClone(draft.publish);

  applyPublishPresetToDraft(draft, preset, { replace: false });

  assert.equal(draft.publish.sources.find((source) => source.key === 'best').where, 'likes >= 10');
  assert.ok(findPublishTemplate(draft, 'legacy_custom'));
  assert.ok(findPublishTemplate(draft, 'daily_best'));
  assert.match(formatPublishPresetDetails(preset, draft), /already exists/);
  assert.match(formatAppliedPublishPreset({ preset, beforePublish, afterPublish: draft.publish, replace: false }), /Publish preset applied/);
  assert.match(formatPublishChanges(beforePublish, draft.publish).join('\n'), /added: daily_best/);

  applyPublishPresetToDraft(draft, preset, { replace: true });
  assert.equal(findPublishTemplate(draft, 'legacy_custom'), null);
  assert.equal(getPublishTemplates(draft).length, 1);
  assert.match(formatConfirmReplacePublishPreset(preset, 2), /All other templates will be removed/);
});

test('template management enables, disables, removes and formats exact publish.template entries', () => {
  const draft = { publish: { template: [template({ key: 'a', enabled: true }), template({ key: 'b', enabled: false })] } };
  const before = structuredClone(draft.publish);

  setPublishTemplateEnabled(draft, 'a', false);
  removePublishTemplate(draft, 'b');

  assert.equal(findPublishTemplate(draft, 'a').enabled, false);
  assert.equal(findPublishTemplate(draft, 'b'), null);
  assert.match(formatManagePublishTemplates(draft), /a: disabled/);
  assert.match(formatConfirmRemovePublishTemplate(draft, 'a'), /Remove publish template\?/);
  assert.match(formatPublishTemplateChanged({ beforePublish: before, afterPublish: draft.publish, action: 'Changed', key: 'a' }), /Changed: a/);
});

test('source presets and custom source parsing validate expressions and keep changes reversible', () => {
  const draft = { publish: { sources: [] } };
  const best = getSourcePreset('best');

  assert.deepEqual(parseSourceTextCommand('/setsource positive likes > dislikes and likes >= 10'), { key: 'positive', where: 'likes > dislikes and likes >= 10' });
  assert.deepEqual(parseCustomSourceInput('negative\ndislikes > likes'), { key: 'negative', where: 'dislikes > likes' });
  assert.throws(() => parseCustomSourceInput('bad key\nlikes > 0'), /Source key must start/);
  assert.throws(() => parseSourceTextCommand('/setsource bad process.exit()'), /Unexpected|Unknown|Invalid|Expected/i);

  const added = applySourcePreset(draft, best);
  const removed = applySourcePreset(draft, best);
  const reset = resetDraftSources(draft);

  assert.equal(added.action, 'added');
  assert.equal(removed.action, 'removed');
  assert.equal(draft.publish.sources, undefined);
  assert.match(formatSourcesMenu({ publish: { sources: [{ key: 'positive', where: 'likes > dislikes' }] } }), /positive: likes > dislikes/);
  assert.match(formatCustomSourceHelp('Invalid expression'), /Invalid expression/);
  assert.match(formatResetSources(reset), /Draft sources reset/);
});

test('manual schedule wizard builds deterministic templates and applies them to draft config', () => {
  const baseConfig = { publish: { sources: [{ key: 'engagement', where: 'likes + dislikes >= 10' }] } };
  const draft = { publish: { sources: [{ key: 'engagement', where: 'likes + dislikes >= 10' }], template: [] } };
  const wizard = createScheduleWizard(draft, baseConfig);

  assert.equal(wizard.source, 'best');
  assert.deepEqual(getPublishSources({}, {}).map((source) => source.key), ['best', 'controversial']);
  assert.equal(normalizeWizardStep('unknown'), 'source');
  assert.equal(getWizardNextStep({ source: 'best' }), 'cadence');

  const filled = {
    source: 'engagement',
    cadence: 'twice_weekly',
    weekdays: [2, 5],
    time: '21:00',
    windowHours: 84,
    postsPreset: 'large',
    thresholdPreset: 'strict'
  };
  const templates = buildManualScheduleTemplates(filled);
  const change = applyManualSchedule(draft, filled);

  assert.deepEqual(templates.map((item) => item.key), ['twice_weekly_engagement_2', 'twice_weekly_engagement_5']);
  assert.equal(templates[0].reactions.strategy, 'sum');
  assert.equal(templates[0].posts.max, 30);
  assert.ok(findPublishTemplate(draft, 'twice_weekly_engagement_2'));
  assert.match(formatManualScheduleWizard({ wizard: filled, draft, baseConfig, step: 'confirm' }), /Source: engagement/);
  assert.match(formatManualScheduleConfirm(filled), /twice_weekly_engagement_2/);
  assert.match(formatManualScheduleApplied(change), /Custom schedule created/);
});


test('traffic suggestions recommend monthly schedules for very low volume sources', async () => {
  const now = Date.parse('2026-07-01T20:00:00.000Z') / 1000;
  const sparseMessages = Array.from({ length: 6 }, (_, index) => ({
    id: index + 1,
    date: now - index * 5 * 24 * 60 * 60,
    message: `Sparse post ${index + 1}`,
    text: `Sparse post ${index + 1}`,
    photo: { id: index + 1 },
    replyMarkup: { rows: [{ buttons: [{ text: `👍 ${index + 1}` }] }] }
  }));
  const draft = {
    parsing: {
      filters: [{ source: 'message', transform: 'hasContent' }],
      likes: [{ source: 'message', path: 'replyMarkup.rows[].buttons[].text', regex: '👍\\s*(\\d+)', group: 1, transform: 'count', aggregate: 'sum' }]
    }
  };
  const baseConfig = { schedule: { timezone: 'UTC' }, telegram: { sourceChatId: -100 } };

  const recent = buildRecentTrafficScheduleSuggestions({ messages: sparseMessages, draft, baseConfig });
  const database = await buildDatabaseTrafficScheduleSuggestions({
    repository: { all: async () => sparseMessages.map((item) => ({ messageId: item.id, likes: 5, dislikes: 0, messageDate: new Date(item.date * 1000).toISOString() })) },
    draft,
    baseConfig,
    days: 30
  });
  const monthly = buildTrafficPreset({ id: 'monthly', title: 'Monthly', kind: 'monthly', time: '21:00' });

  assert.match(recent.message, /monthly digest/i);
  assert.match(recent.message, /too sparse for weekly/i);
  assert.ok(recent.presets.some((preset) => preset.id.startsWith('traffic_monthly_')));
  assert.ok(database.presets.some((preset) => preset.id.startsWith('traffic_monthly_')));
  assert.deepEqual(monthly.templates.map((item) => item.key), ['monthly_best']);
  assert.equal(monthly.templates[0].schedule.type, 'monthly');
  assert.equal(monthly.templates[0].windowHours, 720);
});

test('schedule diagnostics preview upcoming runs, first-send gates and overlapping daily windows', () => {
  const now = new Date('2026-07-03T08:00:00.000Z');
  const baseConfig = { schedule: { timezone: 'UTC' }, publish: { sources: [{ key: 'best', where: 'likes > 0' }] } };
  const draft = {
    publish: {
      firstSendAt: '2026-07-05T00:00:00.000Z',
      template: [
        template({ key: 'morning', schedule: { type: 'daily', time: '11:00' }, windowHours: 18 }),
        template({ key: 'night', schedule: { type: 'daily', time: '23:00' }, windowHours: 18 })
      ]
    }
  };

  const preview = formatSchedulePreview(draft, baseConfig, now);
  const doctor = formatScheduleDoctor(draft, baseConfig, now);

  assert.match(preview, /Schedule preview/);
  assert.match(preview, /best\.morning/);
  assert.match(preview, /First send gate/);
  assert.match(doctor, /overlap by/);
  assert.equal(getMaxTrafficDays({ sync: { retentionDays: 90, initialScanDays: 10, refreshRecentDays: 3 } }), 90);
});

test('schedule diagnostics use offsetHours for preview and daily window overlap checks', () => {
  const now = new Date('2026-07-08T09:00:00.000Z');
  const baseConfig = { schedule: { timezone: 'UTC' }, publish: { sources: [{ key: 'best', where: 'likes > 0' }] } };
  const draft = {
    publish: {
      template: [
        template({ key: 'shifted_day', schedule: { type: 'daily', time: '10:00' }, windowHours: 24, offsetHours: 168 }),
        template({ key: 'morning', schedule: { type: 'daily', time: '10:00' }, windowHours: 12, offsetHours: 12 }),
        template({ key: 'night', schedule: { type: 'daily', time: '22:00' }, windowHours: 12 })
      ]
    }
  };

  const preview = formatSchedulePreview(draft, baseConfig, now);
  const doctor = formatScheduleDoctor(draft, baseConfig, now);

  assert.match(preview, /best\.shifted_day · window 06-30 10:00–07-01 10:00/);
  assert.match(doctor, /best: morning and night overlap by 12h/);
});

test('traffic suggestions use recent/parser data and database volume to build actionable presets', async () => {
  const messages = Array.from({ length: 24 }, (_, index) => ({
    id: index + 1,
    date: Date.parse('2026-07-02T20:00:00.000Z') / 1000 + index * 60,
    message: `Post ${index + 1}`,
    text: `Post ${index + 1}`,
    photo: { id: index + 1 },
    replyMarkup: { rows: [{ buttons: [{ text: `👍 ${index + 1}` }] }] }
  }));
  const draft = {
    parsing: {
      filters: [{ source: 'message', transform: 'hasContent' }],
      likes: [{ source: 'message', path: 'replyMarkup.rows[].buttons[].text', regex: '👍\\s*(\\d+)', group: 1, transform: 'count', aggregate: 'sum' }]
    }
  };
  const baseConfig = { schedule: { timezone: 'UTC' }, telegram: { sourceChatId: -100 } };
  const recent = buildRecentTrafficScheduleSuggestions({ messages, draft, baseConfig });
  const database = await buildDatabaseTrafficScheduleSuggestions({
    repository: { all: async () => messages.map((item) => ({ messageId: item.id, likes: 10, dislikes: 0, messageDate: new Date(item.date * 1000).toISOString() })) },
    draft,
    baseConfig,
    days: 7
  });
  const noRepo = await buildDatabaseTrafficScheduleSuggestions({ repository: null, draft, baseConfig });
  const weekly = buildTrafficPreset({ id: 'weekly', title: 'Weekly', kind: 'weekly', time: '10:00' });

  assert.equal(recent.mode, 'recent');
  assert.equal(recent.matched, 24);
  assert.ok(recent.presets.some((preset) => preset.id.startsWith('traffic_weekly_')));
  assert.equal(database.tooSmall, true);
  assert.match(database.message, /Small database sample/);
  assert.doesNotMatch(database.message, /Average: 12\./);
  assert.match(noRepo.message, /Repository is not available/);
  assert.deepEqual(weekly.templates.map((item) => item.key), ['weekly_best']);
});

function template(overrides = {}) {
  return publishTemplate({
    source: 'best',
    key: 'daily_best',
    schedule: { type: 'daily', time: '11:00' },
    windowHours: 24,
    posts: { min: 1, target: 3, max: 5 },
    reactions: { strategy: 'likes', min: 0, includeAbove: 999999 },
    template: 'Best {{count}}',
    ...overrides
  });
}
