export function formatScheduledPublishLog(result = {}) {
  if (result.skipped) {
    return compactLogFields({
      outcome: 'skipped',
      message: describeSkipReason(result.reason),
      reason: result.reason
    });
  }

  const selections = result.selections || [];
  if (selections.length === 0) {
    return {
      outcome: 'skipped',
      message: 'No scheduled publication matched the configured selections.'
    };
  }

  const created = selections.filter((selection) => selection.requested || selection.status === 'scheduled');
  const existing = selections.filter((selection) => selection.status === 'exists');
  const empty = selections.filter((selection) => selection.status === 'empty');
  const duplicate = selections.filter((selection) => selection.status === 'duplicate');
  const other = selections.filter((selection) => !['scheduled', 'exists', 'empty', 'duplicate'].includes(selection.status));

  return compactLogFields({
    outcome: created.length > 0 ? 'created' : 'skipped',
    message: describeScheduledPublishSelections({ created, existing, empty, duplicate, other }),
    created: describeSelectionList(created),
    alreadyDone: describeSelectionList(existing, (selection) => `${selection.key} (${selection.publicationStatus || 'already scheduled'})`),
    noPosts: describeSelectionList(empty),
    duplicates: describeSelectionList(duplicate),
    other: describeSelectionList(other, (selection) => `${selection.key} (${selection.status})`)
  });
}

function describeScheduledPublishSelections({ created, existing, empty, duplicate, other }) {
  const parts = [];
  if (created.length > 0) parts.push(`${created.length} publication request${created.length === 1 ? '' : 's'} created`);
  if (existing.length > 0) parts.push(`${existing.length} already published or scheduled`);
  if (empty.length > 0) {
    parts.push(`${empty.length} skipped because no posts were found in the database for the publication period; no publication row was created and it can be retried after sync or backfill loads data`);
  }
  if (duplicate.length > 0) parts.push(`${duplicate.length} skipped because another scheduler already created it`);
  if (other.length > 0) parts.push(`${other.length} returned another status`);
  return parts.join('; ') || 'No publication request was created.';
}

function describeSelectionList(selections, formatter = (selection) => selection.key) {
  if (!selections.length) return undefined;
  return selections.map(formatter).join(', ');
}

function describeSkipReason(reason) {
  if (reason === 'duplicate_job') return 'The same scheduled publication is already being planned.';
  if (reason === 'busy') return 'Another job is currently running.';
  if (reason === 'empty_selection') return 'No configured scheduled publication matched this key.';
  return reason ? `Skipped: ${reason}.` : 'Scheduled publication planning was skipped.';
}

function compactLogFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== '')
  );
}
