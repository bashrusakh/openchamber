/**
 * Strip terminal control sequences from a string of text emitted by a shell
 * tool (e.g. `bash`, `grep`, `curl`, `npm`, or `ocr review --audience agent`).
 *
 * The chat renders raw tool output as either a syntax-highlighted code block
 * or a `<pre>` block. Neither consumer interprets ANSI escapes, so a colored
 * CLI leaks literal `\x1b[…m` (and friends) bytes into the chat — visible as
 * stray `[2m`, `[48;2;38;38;38m`, `[0m` tokens around the actual text. This
 * helper is the single boundary that converts "terminal-emitted text" into
 * "HTML-safe text" by removing the control sequences and keeping everything
 * else byte-for-byte.
 *
 * Coverage:
 *  - CSI (`ESC [` … final byte `@`-`~`): SGR colors/styles, cursor moves,
 *    erases, mode toggles, etc.
 *  - OSC (`ESC ]` … BEL or ST): window title, hyperlink, color palette.
 *  - DCS / SOS / PM / APC (`ESC P/X/^/_` … ST): sixel, status strings,
 *    private messages.
 *  - Two-byte ESC sequences (`ESC` … final byte `@`-`~`): charset selection
 *    and similar.
 *  - Stray lone ESC bytes that did not match a sequence above.
 *
 * Notes:
 *  - The visible text content is preserved verbatim; only control sequences
 *    are removed. Trailing whitespace per line is NOT collapsed — that would
 *    be a behavior change for tools like `diff` whose alignment matters.
 *  - Idempotent: running `stripAnsi(stripAnsi(text))` returns the same value.
 *  - Safe for HTML: the result still contains angle brackets and ampersands
 *    that the caller must escape before insertion into the DOM.
 */
export const stripAnsi = (text: string): string => {
  if (!text) {
    return text;
  }

  // Longest matches first so DCS/SOS/PM/APC (which can contain CSI-like
  // bytes inside their payload) are removed before the generic CSI sweep.
  // `s` (dotAll) is not widely supported in our TS targets; use [\s\S].
  /* eslint-disable no-control-regex */
  return text
    // OSC: ESC ] … terminated by BEL (\x07) or ST (ESC \)
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
    // DCS / SOS / PM / APC: ESC P / X / ^ / _ … terminated by ST (ESC \)
    .replace(/\x1B[PX^_][\s\S]*?\x1B\\/g, '')
    // CSI: ESC [ … final byte in the @-~ range (0x40–0x7E)
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
    // Two-byte ESC sequences (charset selection etc.): ESC <intermediates> <final>
    .replace(/\x1B[ -/]+[@-~]/g, '')
    // Stray lone ESC bytes (defensive — should be unreachable after the above)
    .replace(/\x1B/g, '');
  /* eslint-enable no-control-regex */
};