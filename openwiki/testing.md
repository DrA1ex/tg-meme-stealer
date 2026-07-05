# Testing

## Test Command

Run the full suite with:

```bash
npm test
```

The suite uses Node's built-in test runner (`node --test`) and lives under `test/*.test.js`.

## Coverage Map

Core parser and formatting:

- `test/postParser.test.js`
- `test/format.test.js`
- `test/stats.test.js`
- `test/logger.test.js`

Config and setup draft handling:

- `test/config.test.js`
- `test/setupConfig.test.js`

Setup assistant UI, diagnostics, and publishing setup:

- `test/setupAssistant.test.js`
- `test/setupFormattingAndKeyboards.test.js`
- `test/setupParserSuggestions.test.js`
- `test/setupPublishSourcesSchedule.test.js`
- `test/setupTechnicalDiagnostics.test.js`
- `test/setupTestsRegressions.test.js`

Storage, selection, and publication:

- `test/db.test.js`
- `test/selection.test.js`
- `test/publisher.test.js`
- `test/publishLog.test.js`
- `test/richPost.test.js`
- `test/media.test.js`

Runtime scheduling and concurrency:

- `test/scheduler.test.js`
- `test/syncWorker.test.js`
- `test/retentionWorker.test.js`
- `test/jobGate.test.js`
- `test/scanner.test.js`
- `test/throttle.test.js`
- `test/retry.test.js`
- `test/peer.test.js`

Presentation helpers:

- `test/jobs.test.js`

## What To Run When Changing Code

- Parser rules, transforms, path tracing, or diagnostics: run `npm test -- test/postParser.test.js test/setupParserSuggestions.test.js test/setupTechnicalDiagnostics.test.js`.
- Config loading or validation: run `npm test -- test/config.test.js test/setupConfig.test.js`.
- Scheduler, first-send gates, or catch-up behavior: run `npm test -- test/scheduler.test.js test/selection.test.js test/publisher.test.js`.
- Publication queue, resumability, admin publish command, or duplicate prevention: run `npm test -- test/publisher.test.js test/db.test.js`.
- Setup assistant routing or button/text flows: run `npm test -- test/setupAssistant.test.js test/setupPublishSourcesSchedule.test.js test/setupTestsRegressions.test.js`.
- SQLite schema or selection SQL: run `npm test -- test/db.test.js test/selection.test.js`.

Run the full suite before changes that touch shared config, scheduler, repository, parser, or publisher behavior.

