/** Replace every occurrence of a secret with a placeholder. Secrets shorter than 6 chars are ignored. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  return out;
}
