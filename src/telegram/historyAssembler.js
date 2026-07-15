export class HistoryPageAssembler {
  constructor() {
    this.pending = [];
  }

  push(messages, { hasNext = false } = {}) {
    const combined = [...this.pending, ...messages];
    this.pending = [];
    if (!hasNext || combined.length === 0) return combined;

    const trailingGroupId = getGroupedId(combined[combined.length - 1]);
    if (!trailingGroupId) return combined;

    let splitAt = combined.length - 1;
    while (splitAt > 0 && getGroupedId(combined[splitAt - 1]) === trailingGroupId) splitAt -= 1;
    this.pending = combined.slice(splitAt);
    return combined.slice(0, splitAt);
  }

  flush() {
    const messages = this.pending;
    this.pending = [];
    return messages;
  }
}

function getGroupedId(message) {
  const value = message?.groupedId ?? message?.grouped_id;
  return value === undefined || value === null || value === '' ? '' : String(value);
}
