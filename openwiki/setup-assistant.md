# Setup Assistant

## Purpose

Setup mode lets the Telegram admin tune parser rules, publication sources, schedules, and templates without hand-editing JSON. It starts from the currently loaded config, keeps a per-admin draft in memory, and writes only the editable sections to `config.json` on save.

Core files:

- `src/telegram/setupAssistant.js` registers bot commands and composes flow modules.
- `src/telegram/setupAssistant/session.js` manages draft lifecycle, keyboard cleanup, prompt handling, and saving.
- `src/telegram/setupAssistant/routing.js` maps callback actions to flow handlers.
- `src/core/setupConfig.js` creates, validates, formats, and saves setup drafts.
- `src/telegram/setup/*.js` contains formatters, keyboards, suggestions, diagnostics, presets, and schedule wizard helpers.

## Draft Lifecycle

`/setup` reloads config, creates a draft containing `parsing`, `publish`, and `templates`, and opens the setup home screen. Draft state lives in maps keyed by admin user id:

- `sessions`: editable draft config.
- `setupMeta`: timestamps for changed/tested/previewed state.
- `setupLastChange`: last meaningful change summary.
- `setupSampleCache`: loaded source messages for diagnostics and previews.
- `setupScheduleWizards`: in-progress manual schedule choices.
- `setupTextPrompts`: pending free-text prompts such as custom source expressions or message id lookup.

`Save` or `/done` validates the draft merged over current config, copies existing `config.json` to `config.json.old` when present, writes the next `config.json`, reloads runtime config in memory, and clears setup state. `Cancel` drops the draft.

## Parser Flow

Parser setup changes `parsing.filters`, `parsing.author`, `parsing.likes`, and `parsing.dislikes`. The button flow supports:

- Quick suggestions from recent sample messages.
- Manual filters, author extraction, and reaction extraction choices.
- Pending section config screens.
- Test and preview actions.
- Detailed parser traces for matched and rejected messages.

The parser diagnostics are powered by `debugParseMessage()` and helpers in `src/telegram/setup/parserDiagnostics.js` and `src/telegram/setup/technicalDiagnostics.js`.

## Publishing Flow

Publishing setup changes `publish.sources`, `publish.template`, and caption/stat templates. It supports:

- Recommended presets from `src/telegram/setup/publishPresets.js`.
- Traffic suggestions from recent parser samples or database volume.
- Manual schedule wizard steps for source, cadence, day, time, window, post count, and threshold.
- Source presets and custom source expressions.
- Template enable/disable/remove actions.
- Schedule preview and schedule doctor screens. Preview shows offset-adjusted selection windows, and doctor uses `offsetHours` when checking daily gaps and overlaps.

The pending draft may differ from saved config until the admin chooses `Save`.

## Diagnostics

Diagnostics are available from setup home because parser and publishing issues overlap. They include:

- Why matched or rejected.
- Unknown author and zero-like searches.
- Message browser over cached or Telegram-fetched source messages.
- Raw reactions, compact message shape, field scan, and parser trace.
- Parsed preview for a single message.

Message-id lookup first checks the loaded setup context and cache; if absent, it fetches the message from Telegram through the scanner.

## Text Commands

Button UI is the normal path, but setup mode still accepts text commands for exact edits and debugging:

- Parser edits: `/setfilter`, `/addfilter`, `/setauthor`, `/setlikes`, `/setdislikes`.
- Publishing edits: `/setsources`, `/setsource`, `/setpublish`, `/settemplate`.
- Diagnostics and previews: `/test`, `/raw`, `/test_message`, `/debug`, `/preview`.
- Session control: `/done`, `/cancel`.

When changing setup behavior, update both the callback routing and the relevant text command tests when the same feature is exposed in both places.
