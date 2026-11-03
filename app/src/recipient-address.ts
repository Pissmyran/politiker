const MAX_IMPORT_CONTACTS = 5_000;
const MAX_NAME_LENGTH = 160;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export interface RecipientAddressInput {
  email: string;
  name?: string;
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}
function cleanEmail(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .toLocaleLowerCase("sv-SE");
}

export function normalizePrivateContactInput(input: RecipientAddressInput): {
  email: string;
  name: string;
} {
  const email = cleanEmail(input?.email);
  if (!email || email.length > 254 || !EMAIL_RE.test(email))
    throw new Error("Ogiltig e-postadress");
  return { email, name: cleanText(input?.name, MAX_NAME_LENGTH) };
}

export function normalizeImportedContacts(
  inputs: RecipientAddressInput[],
): Array<{ email: string; name: string }> {
  if (!Array.isArray(inputs) || inputs.length === 0)
    throw new Error("Importen innehåller inga mottagare");
  if (inputs.length > MAX_IMPORT_CONTACTS)
    throw new Error(`Högst ${MAX_IMPORT_CONTACTS} mottagare kan importeras åt gången`);
  const deduped = new Map<string, { email: string; name: string }>();
  for (const input of inputs) {
    const normalized = normalizePrivateContactInput(input);
    const existing = deduped.get(normalized.email);
    if (!existing || (!existing.name && normalized.name)) deduped.set(normalized.email, normalized);
  }
  return [...deduped.values()];
}

export function parseIncludedRecipient(value: string): { email: string; name: string } | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const open = raw.lastIndexOf("<");
  let emailInput = raw;
  let name = "";
  if (open !== -1) {
    const displayName = raw.slice(0, open).trimEnd();
    const address = raw.slice(open + 1, -1);
    if (
      !raw.endsWith(">") ||
      !address ||
      address.includes(">") ||
      /[\r\n\u2028\u2029]/.test(displayName)
    )
      return null;
    emailInput = address;
    name = cleanText(displayName.replace(/[<>]/g, " "), MAX_NAME_LENGTH);
  }
  const email = cleanEmail(emailInput);
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return { email, name };
}
