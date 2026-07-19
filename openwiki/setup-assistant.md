# Setup assistant and configuration authoring

## Purpose and boundary

The setup assistant lets the Telegram admin author parser and publication configuration without hand-editing JSON. It is registered onto the same Telegraf bot as the operational commands (`src/telegram/setupAssistant.js`), so it is available in setup and daemon modes. Only the configured admin in a private chat may use it.

The assistant is a **draft editor**, not live configuration management. It starts from loaded configuration, keeps draft/session state in memory, validates a merged result, and writes local `config.json` for the next process start. Existing daemon dependencies continue using their original config until restart.

## Structure

| Area | Main sources | Role |
| --- | --- | --- |
| Composition and routing | `src/telegram/setupAssistant.js`, `setupAssistant/routing.js` | Commands, callback dispatch, flow composition |
| Draft/session lifecycle | `setupAssistant/session.js`, `src/core/setupConfig.js` | Per-admin state, save/cancel, atomic persistence and validation |
| Parser authoring | `setupAssistant/parserFlow.js`, `src/telegram/setup/{parserDiagnostics,parserSuggestions}.js` | Filters/extractors, samples, tests, trace/debugging |
| Publishing authoring | `setupAssistant/publishFlow.js`, `src/telegram/setup/{publishPresets,publishTemplates,publishSources,scheduleDiagnostics}.js` | Source expressions, templates, presets, schedules, previews |
| Technical/sample interaction | `setupAssistant/{technicalFlow,sampleFlow,commandFlow,helpers}.js` | Browsing source messages, raw/debug views, text commands |

## Draft lifecycle

`/setup` reloads configuration, creates a per-admin draft, and opens the keyboard UI. In-memory maps retain draft contents, change/test/preview metadata, cached sample messages, schedule-wizard state, and pending text prompts.

On Save or `/done`, setup logic:

1. validates the draft when merged with current configuration;
2. writes through a temporary file + synchronization + rename;
3. keeps `config.json.old` and timestamped backup behavior where applicable;
4. closes the in-memory session immediately after the durable write succeeds.

Save is single-flight per admin. The active inline keyboard is disabled before filesystem work, repeated Save clicks are ignored, and stale callbacks cannot recreate a session or repeat a completed write. If validation or persistence fails, the draft remains active and the setup keyboard is restored.

Cancel drops the draft. Because this state is memory-only, bot/process restart discards unsaved work. The save mechanism protects configuration-file integrity, not live reload.

## What the admin can configure

### Content rules

Parser screens edit `parsing.filters`, `author`, `likes`, and `dislikes`. Diagnostics use real/cached source messages to offer suggestions, test rules, preview parsed posts, show compact/raw shape, inspect fields/reactions, and render parse traces. Content Preview selects examples from the scanned matched sample; it does not impose the publication schedule's one-week window. This is the right workflow for a new source chat because parsing assumptions differ by channel markup and reaction conventions.

### Publishing rules

Publishing screens edit `publish.sources`, `publish.template`, and templates/stat formatting. The assistant supports presets and manual schedule construction: source, cadence, day/time, selection window/offset, post bounds, threshold, enabled state, and source expression. Schedule preview and schedule doctor use offset-adjusted windows, so a schedule can be evaluated for overlap/gap behavior before saving.

`src/core/sourceExpression.js` deliberately limits source predicates. Do not add arbitrary SQL through UI input; new expression capability must be implemented/validated/tested in the compiler and configuration layer.

## Text commands and compatibility

The button UI is the normal authoring path, but exact/editing diagnostic commands remain supported, including parser setters, source/template setters, `/test`, `/raw`, `/debug`, `/preview`, `/done`, and `/cancel`. A change exposed through both callbacks and text commands needs coverage for both routes; callback-only changes often leave legacy/admin workflows inconsistent.

## Change guidance

- UI/routing/session behavior: inspect `setupAssistant/routing.js` and `session.js`; run `test/setupAssistant.test.js` and regression tests.
- Parser suggestions/diagnostics: run `test/postParser.test.js`, `test/setupParserSuggestions.test.js`, `test/setupTechnicalDiagnostics.test.js`.
- Publishing sources/schedules/formatting: run `test/setupPublishSourcesSchedule.test.js`, `test/setupFormattingAndKeyboards.test.js`, `test/selection.test.js`.
- Config persistence/validation: run `test/setupConfig.test.js`, `test/config.test.js`.

Keep save/restart messaging explicit whenever configuration UX changes. The distinction between a valid saved draft and an active daemon configuration is an intentional operational safety boundary.
