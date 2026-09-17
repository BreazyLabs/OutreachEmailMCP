import type { AddressObject, ParsedMail } from 'mailparser';

/** "Name <a@b>, c@d" for one or several parsed address headers. */
function addressText(value: AddressObject | AddressObject[] | undefined): string | null {
  if (!value) return null;
  const text = (Array.isArray(value) ? value.map((v) => v.text) : [value.text]).filter(Boolean).join(', ');
  return text || null;
}

/**
 * The JSON shape of one message. Threading headers are returned in full:
 * `references` lists every Message-ID of the conversation (a forwarded or
 * re-threaded reply often names the original only there, not in
 * In-Reply-To), and `replyTo` is where the sender wants answers to go
 * (assistants, shared inboxes, "please contact my colleague" setups).
 */
export function messageDetailOf(
  id: string,
  parsed: ParsedMail,
  warmup: boolean,
): Record<string, unknown> {
  const references = parsed.references
    ? (Array.isArray(parsed.references) ? parsed.references : String(parsed.references).split(/\s+/)).filter(Boolean)
    : [];
  return {
    id,
    // Fetching by id is deliberate, so warmup mail is returned — flagged.
    warmup,
    from: parsed.from?.text ?? null,
    to: addressText(parsed.to),
    cc: addressText(parsed.cc),
    replyTo: parsed.replyTo?.text || null,
    subject: parsed.subject ?? null,
    date: parsed.date?.toISOString() ?? null,
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references,
    text: parsed.text ?? null,
    html: parsed.html || null,
    attachments: parsed.attachments.map((a, index) => ({
      id: String(index),
      filename: a.filename ?? `attachment-${index}`,
      contentType: a.contentType,
      size: a.size,
    })),
  };
}
