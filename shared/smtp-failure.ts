function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

export function isSmtpAuthenticationFailure(error: unknown): boolean {
  return /^(?:Servern accepterade inte AUTH LOGIN|Användarnamn accepterades inte|Inloggning misslyckades)\b/i.test(
    errorMessage(error),
  );
}

function smtpResponseCode(error: unknown): number | null {
  const match = errorMessage(error).match(/\((?:fick\s+)?(\d{3})(?::|\))/i);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isInteger(code) ? code : null;
}

export function isMailCredentialFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    isSmtpAuthenticationFailure(error) ||
    /^Det sparade SMTP-lösenordet kan inte dekrypteras\b/.test(message)
  );
}

export function isTransientSmtpFailure(error: unknown): boolean {
  if (isMailCredentialFailure(error)) return false;
  const code = smtpResponseCode(error);
  return code !== null && code >= 400 && code < 500;
}

export function visibleSendJobError(
  status: string,
  error: string | null | undefined,
): string | null {
  if (!error) return null;
  if (isMailCredentialFailure(error)) return status === "aborted" ? error : null;
  return error;
}
