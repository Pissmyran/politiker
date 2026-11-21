// Minimal SMTP-klient byggd på Workers' cloudflare:sockets API.
// Stödjer STARTTLS (587) och direkt TLS (465), AUTH LOGIN.

import { connect } from "cloudflare:sockets";
import {
  sanitizeAttachmentFilename,
  validateContentType,
  validateMailboxAddress,
} from "./input-safety";
export { escapeHtml } from "./html";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  fromAddress: string;
}

export class SmtpError extends Error {}

interface SmtpResponse {
  code: number;
  text: string;
}
interface Connection {
  write: (line: string) => Promise<void>;
  read: () => Promise<SmtpResponse>;
  quit: (success: boolean) => Promise<void>;
}

const MAX_SMTP_REPLY_LINE_BYTES = 4096;
const MAX_SMTP_REPLY_BYTES = 64 * 1024;
// RFC 5321 recommends up to ten minutes for a DATA termination reply.
const SMTP_REPLY_TIMEOUT_MS = 10 * 60 * 1000;

async function openConnection(host: string, port: number): Promise<Connection> {
  const useDirectTls = port === 465;
  let socket = connect(
    { hostname: host, port },
    { secureTransport: useDirectTls ? "on" : "starttls", allowHalfOpen: false },
  );
  let writer = socket.writable.getWriter();
  let reader = socket.readable.getReader();
  const read = () => readSmtpResponse(reader);
  const write = (line: string) => writer.write(new TextEncoder().encode(line + "\r\n"));

  try {
    await expect(await read(), 220, "Servern svarade inte med 220 vid anslutning");
    await write("EHLO __PUBLIC_HOST__");
    await read();

    if (!useDirectTls) {
      await write("STARTTLS");
      await expect(await read(), 220, "STARTTLS nekades av servern");
      writer.releaseLock();
      reader.releaseLock();
      socket = socket.startTls();
      writer = socket.writable.getWriter();
      reader = socket.readable.getReader();
      await write("EHLO __PUBLIC_HOST__");
      await read();
    }

    const quit = async (success: boolean) => {
      try {
        if (success) await write("QUIT");
      } catch {
      } finally {
        void socket.close().catch(() => {});
      }
    };
    return { write, read, quit };
  } catch (error) {
    void socket.close().catch(() => {});
    throw error;
  }
}

async function authenticate(conn: Connection, config: SmtpConfig): Promise<void> {
  await conn.write("AUTH LOGIN");
  await expect(await conn.read(), 334, "Servern accepterade inte AUTH LOGIN");
  await conn.write(btoa(config.user));
  await expect(await conn.read(), 334, "Användarnamn accepterades inte");
  await conn.write(btoa(config.password));
  const authResp = await conn.read();
  if (authResp.code !== 235)
    throw new SmtpError(`Inloggning misslyckades (${authResp.code}): ${authResp.text}`);
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  bytes: ArrayBuffer;
}

export async function sendSmtpMail(
  config: SmtpConfig,
  opts: { to: string; subject?: string; html: string; attachments?: MailAttachment[] },
): Promise<void> {
  // Envelope-adresserna interpoleras i SMTP-kommandon. Validera dem före
  // anslutning så CR/LF och andra ogiltiga tecken aldrig kan nå protokollet.
  const from = validateMailboxAddress(config.fromAddress, "avsändaradress");
  const to = validateMailboxAddress(opts.to, "mottagaradress");
  const conn = await openConnection(config.host, config.port);
  let success = false;
  try {
    await authenticate(conn, config);
    await conn.write(`MAIL FROM:<${from}>`);
    await expect(await conn.read(), 250, "MAIL FROM nekades");
    await conn.write(`RCPT TO:<${to}>`);
    const rcptResp = await conn.read();
    if (rcptResp.code !== 250 && rcptResp.code !== 251) {
      throw new SmtpError(`RCPT TO nekades (${rcptResp.code}): ${rcptResp.text}`);
    }
    await conn.write("DATA");
    await expect(await conn.read(), 354, "Servern accepterade inte DATA");
    const message = buildMimeMessage(from, to, opts.subject, opts.html, opts.attachments ?? []);
    const stuffed = message.replace(/\r?\n\./g, "\n..");
    await conn.write(`${stuffed}\r\n.`);
    await expect(await conn.read(), 250, "Mejlet accepterades inte av servern");
    success = true;
  } finally {
    await conn.quit(success);
  }
}

function buildMimeMessage(
  from: string,
  to: string,
  subject: string | undefined,
  html: string,
  attachments: MailAttachment[],
): string {
  const baseHeaders = [
    `From: ${from}`,
    `To: ${to}`,
    subject ? `Subject: ${encodeHeaderValue(subject)}` : null,
    "MIME-Version: 1.0",
  ].filter((line): line is string => line !== null);

  if (attachments.length === 0)
    return [...baseHeaders, "Content-Type: text/html; charset=UTF-8", "", html].join("\r\n");

  const boundary = `----politiker-${crypto.randomUUID()}`;
  const parts = [
    ["Content-Type: text/html; charset=UTF-8", "", html].join("\r\n"),
    ...attachments.map((attachment) => {
      const filename = sanitizeAttachmentFilename(attachment.filename);
      const contentType = validateContentType(attachment.contentType);
      return [
        `Content-Type: ${contentType}; name="${filename}"`,
        `Content-Disposition: attachment; filename="${filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        wrapBase64(bytesToBase64(attachment.bytes)),
      ].join("\r\n");
    }),
  ];
  const body = parts.map((part) => `--${boundary}\r\n${part}`).join("\r\n") + `\r\n--${boundary}--`;
  return [...baseHeaders, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", body].join(
    "\r\n",
  );
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function wrapBase64(base64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 76) lines.push(base64.slice(i, i + 76));
  return lines.join("\r\n");
}

export async function testSmtpAuth(config: SmtpConfig): Promise<void> {
  validateMailboxAddress(config.fromAddress, "avsändaradress");
  const conn = await openConnection(config.host, config.port);
  let success = false;
  try {
    await authenticate(conn, config);
    success = true;
  } finally {
    await conn.quit(success);
  }
}

async function readSmtpResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<SmtpResponse> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      parseSmtpResponse(reader),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SmtpError("SMTP-servern svarade inte i tid")),
          SMTP_REPLY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function parseSmtpResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<SmtpResponse> {
  const line = new Uint8Array(MAX_SMTP_REPLY_LINE_BYTES);
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let lineLength = 0;
  let totalBytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new SmtpError("Anslutningen stängdes oväntat");
    for (const byte of value) {
      if (++totalBytes > MAX_SMTP_REPLY_BYTES || lineLength === line.length)
        throw new SmtpError("SMTP-serverns svar är för långt");
      line[lineLength++] = byte;
      if (lineLength >= 2 && line[lineLength - 2] === 13 && byte === 10) {
        const text = decoder.decode(line.subarray(0, lineLength - 2));
        lineLength = 0;
        if (text) lines.push(text);
        if (/^\d{3} /.test(text))
          return { code: parseInt(text.slice(0, 3), 10), text: lines.join("\n") };
      }
    }
  }
}
async function expect(
  resp: SmtpResponse,
  expectedCode: number,
  errorMessage: string,
): Promise<void> {
  if (resp.code !== expectedCode)
    throw new SmtpError(`${errorMessage} (fick ${resp.code}: ${resp.text})`);
}

export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}
