export function normalizeTelegramPeerId(peerId) {
  if (typeof peerId !== 'string') return peerId;
  const trimmed = peerId.trim();
  if (!/^-?\d+$/.test(trimmed)) return peerId;
  const number = Number(trimmed);
  return Number.isSafeInteger(number) ? number : peerId;
}
