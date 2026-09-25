/**
 * Wrap third-party text (emails, WhatsApp, form input, transcripts, notes) as delimited data so
 * prompts can instruct the model to treat it as data only (§8.2 prompt-injection defence).
 * Closing-tag look-alikes inside the text are neutralised so it cannot break out of the block.
 */
export function untrusted(label: string, text: string): string {
  const safeLabel = label.replace(/[^a-z0-9_-]/gi, '_');
  const neutralised = text.replace(/<\/?\s*untrusted[^>]*>/gi, '[removed tag]');
  return `<untrusted source="${safeLabel}">\n${neutralised}\n</untrusted>`;
}
