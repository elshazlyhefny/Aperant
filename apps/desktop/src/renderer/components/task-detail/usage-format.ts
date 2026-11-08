/** zeenha fork: formatting helpers for the task Usage tab. */

/** 850 -> "850ms", 184000 -> "3m 4s", 3720000 -> "1h 2m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatTokens(n: number, language?: string): string {
  return new Intl.NumberFormat(language).format(Number.isFinite(n) ? n : 0);
}
