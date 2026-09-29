const UNITS = ["B", "KB", "MB", "GB"];

/** Human-readable size with one decimal, using 1024-based units. */
export function formatBytes(n) {
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${UNITS[i]}`;
}
