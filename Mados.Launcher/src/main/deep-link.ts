export function containsDeepLink(commandLine: readonly string[]): boolean {
  return commandLine.some((value) => {
    const normalized = value.trim().toLowerCase();
    return normalized.startsWith("ss14://") || normalized.startsWith("ss14s://");
  });
}
