export function subtractDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() - days);
  return copy;
}

export function subtractMonths(date, months) {
  const copy = new Date(date);
  copy.setUTCMonth(copy.getUTCMonth() - months);
  return copy;
}

export function subtractHours(date, hours) {
  return new Date(date.getTime() - hours * 60 * 60 * 1000);
}

