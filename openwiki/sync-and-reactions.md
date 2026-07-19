# Sync and reaction verification

## Purpose

Selections depend on current reaction counts, so regular sync intentionally rereads the complete `sync.refreshRecentDays` window. This is not an incremental-only scanner: posts already stored in SQLite must be refreshed because their ranking can change after publication in the source chat.

## Telegram request flow

For each history page, the scanner performs:

1. `getHistory` for source messages.
2. `getMessageReactions` for messages inside the active refresh or backfill update window when the parser uses native reactions.
3. Parsing and one transactional SQLite upsert for all posts produced from the page.

The full reaction endpoint remains authoritative. Reaction summaries embedded in `getHistory` are normalized and compared with the full endpoint, but they do not replace it yet.

Messages older than the active update boundary are not included in `getMessageReactions`. This prevents the final history page from requesting full reactions for rows that will immediately be discarded or skipped.

## Verification counters

A sync or backfill result includes `reactionVerification`:

```text
compared
matched
mismatched
examples
```

`examples` is bounded and contains message IDs plus normalized history and full-endpoint counts. A mismatch is logged as WARN. The values used by parsing and selection always come from `getMessageReactions`.

The comparison exists to collect evidence before considering removal of the additional endpoint. It should be tested on normal emoji reactions, custom emoji reactions, removed reactions, and any paid-reaction formats used by the source chat.

## Empty reaction results

An empty result from `getMessageReactions` is authoritative. The scanner explicitly assigns empty `nativeReactions` and `reactionCounts` arrays so a post whose reactions were removed cannot retain stale values from another representation.

## Page writes

Posts produced from one history page are written with `PostRepository.upsertPosts()` inside one SQLite transaction. Deleted-post reconciliation uses `PostRepository.deletePosts()` and deletes IDs in bounded SQL batches.

Single-row repository methods remain available for callers that operate on one post, but sync and reconciliation use the batch methods.

## Albums and boundaries

`HistoryPageAssembler` keeps albums intact across Telegram history pages. Reaction enrichment happens before assembled posts are parsed. The final page may contain messages older than the configured window; those messages are excluded from full reaction enrichment.

## Failure behavior

If required native reaction enrichment fails, sync is incomplete and fails with `NATIVE_REACTIONS_UNAVAILABLE`. Existing reaction values are not overwritten with zeroes.

Deletion reconciliation runs only after an authoritative complete scan. A large missing ratio is blocked unless the administrator explicitly uses force reconciliation.
