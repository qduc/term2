/**
 * The native store names a conversation `conv_<uuid>`; legacy shows and accepts the bare UUID. Everything the user
 * reads shows the bare form, and everything the user types accepts either form.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The id as legacy prints it: `conv_<uuid>` without its prefix; any other text unchanged. */
export function displaySessionId(id: string): string {
  return id.startsWith('conv_') && UUID.test(id.slice(5)) ? id.slice(5) : id;
}

/** A typed reference in the store's form: a bare UUID gains `conv_`; any other text unchanged. */
export function storedSessionId(reference: string): string {
  return UUID.test(reference) ? `conv_${reference}` : reference;
}
