/**
 * Outgoing-text hygiene for pi-ai requests.
 *
 * llama.cpp hands the rendered prompt to `mtmd_tokenize` as a C string on its
 * multimodal path: an embedded NUL truncates it, every media marker past the
 * cut disappears, the marker count stops matching the attached images and the
 * request fails with `400 Failed to tokenize prompt`. The poisoned text stays
 * in history, so once one tool prints a control byte the session is dead for
 * every later request that carries an image.
 *
 * Tool output is the usual source — `grep -a` over a binary file is enough.
 * Sanitising at this boundary covers every producer (shell, file reads, web
 * fetches) instead of one tool at a time.
 *
 * @module dsh-llm-pi-ai/sanitize
 */

// C0 controls except tab, line feed and carriage return, which are legitimate
// prompt text.
const PROMPT_BREAKING_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g

/**
 * Strip prompt-breaking control characters from one outgoing text.
 * @param text - harness-side text about to leave for the provider.
 * @returns the same text without C0 controls other than tab, LF and CR.
 */
export function sanitizeText(text: string): string {
  return text.replace(PROMPT_BREAKING_CONTROLS, '')
}
