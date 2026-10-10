export function quoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
