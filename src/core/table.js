export function formatTable(rows, columns) {
  const widths = {};
  for (const column of columns) {
    widths[column] = Math.max(column.length, ...rows.map((row) => String(row[column] || '').length));
  }

  const header = columns.map((column) => padCell(column, widths[column])).join('  ');
  const separator = columns.map((column) => '-'.repeat(widths[column])).join('  ');
  const body = rows.map((row) => columns.map((column) => padCell(row[column] || '', widths[column])).join('  '));
  return [header, separator, ...body].join('\n');
}

function padCell(value, width) {
  return ` ${String(value).padEnd(width)} `;
}
