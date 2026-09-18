/**
 * v2 port of the v1 `lib/ui/utils.ts` helpers the command handlers need.
 * The rest of the v1 module (stats formatting, etc.) ports with the `/dcp`
 * panel ticket.
 */

export function formatTokenCount(tokens: number, compact?: boolean): string {
  const suffix = compact ? "" : " tokens";
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`.replace(".0K", "K") + suffix;
  }
  return tokens.toString() + suffix;
}
