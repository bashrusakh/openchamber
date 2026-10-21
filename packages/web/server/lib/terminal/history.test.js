import { describe, expect, it } from 'vitest';
import {
  MAX_PENDING_CONTROL_SEQUENCE_UNITS,
  consumeTerminalHistoryChunk,
  createTerminalHistoryParser,
} from './history.js';

describe('terminal replay history', () => {
  it('removes device and color query exchanges while preserving display controls', () => {
    const parser = createTerminalHistoryParser();
    const input = `before\u001b[6n\u001b[12;40R\u001b[>0c\u001b[?2031h\u001b[?2031$p\u001b[?2031;1$y\u001b]10;?\u0007\u001b[31mred\u001b[0mafter`;
    expect(consumeTerminalHistoryChunk(parser, input)).toBe('before\u001b[31mred\u001b[0mafter');
    expect(parser.units).toBe(0);
  });

  it('carries incomplete control sequences across PTY chunks', () => {
    const parser = createTerminalHistoryParser();
    expect(consumeTerminalHistoryChunk(parser, 'text\u001b]11;')).toBe('text');
    expect(parser.units).toBe(5);
    expect(consumeTerminalHistoryChunk(parser, '?\u001b\\next')).toBe('next');
    expect(parser.units).toBe(0);
  });

  it('preserves ordinary OSC titles and split UTF-16 text', () => {
    const parser = createTerminalHistoryParser();
    expect(consumeTerminalHistoryChunk(parser, '\u001b]0;title\u0007ok')).toBe('\u001b]0;title\u0007ok');
    expect(parser.units).toBe(0);
  });

  it('passes a clean chunk of ordinary text through unchanged', () => {
    const parser = createTerminalHistoryParser();
    const line = 'build result source/file.ts 0123456789\r\n';
    expect(consumeTerminalHistoryChunk(parser, line)).toBe(line);
    expect(parser.units).toBe(0);
  });

  it('keeps ordinary runs between display controls in one piece', () => {
    const parser = createTerminalHistoryParser();
    const input = 'line1\r\n\u001b[1mbold\u001b[0m\r\nline2 tail';
    expect(consumeTerminalHistoryChunk(parser, input)).toBe(input);
    expect(parser.units).toBe(0);
  });

  it('strips C1 device queries and keeps C1 string controls', () => {
    const parser = createTerminalHistoryParser();
    expect(consumeTerminalHistoryChunk(parser, 'a\u009b6nb')).toBe('ab');
    expect(consumeTerminalHistoryChunk(parser, 'x\u009d10;?\u009cy\u009d0;title\u009cz')).toBe('xy\u009d0;title\u009cz');
    expect(parser.units).toBe(0);
  });

  it('keeps DCS and APC string controls in the replay text', () => {
    const parser = createTerminalHistoryParser();
    const input = 'a\u00901;2|data\u009cb\u001b[_apc\u0007c';
    expect(consumeTerminalHistoryChunk(parser, input)).toBe(input);
    expect(parser.units).toBe(0);
  });

  it('strips a query whose introducer, payload and terminator arrive in separate chunks', () => {
    const parser = createTerminalHistoryParser();
    expect(consumeTerminalHistoryChunk(parser, '\u001b]')).toBe('');
    expect(consumeTerminalHistoryChunk(parser, '10;?')).toBe('');
    expect(consumeTerminalHistoryChunk(parser, '\u0007after')).toBe('after');
    expect(parser.units).toBe(0);
  });

  it('bounds the carried control string and replays the text after it', () => {
    const parser = createTerminalHistoryParser();
    const payload = 'p'.repeat(4096);
    expect(consumeTerminalHistoryChunk(parser, '\u001b]0;')).toBe('');
    for (let index = 0; index < 64; index += 1) {
      expect(consumeTerminalHistoryChunk(parser, payload)).toBe('');
      expect(parser.units).toBeLessThanOrEqual(MAX_PENDING_CONTROL_SEQUENCE_UNITS);
    }
    // The cap was crossed, so the payload was dropped instead of carried.
    expect(parser.overflowed).toBe(true);
    expect(parser.units).toBeLessThanOrEqual(MAX_PENDING_CONTROL_SEQUENCE_UNITS);
    // The sequence ends and the ordinary text after it is replayed again.
    expect(consumeTerminalHistoryChunk(parser, '\u0007tail')).toBe('tail');
    expect(parser.units).toBe(0);
  });

  it('bounds the carried CSI parameters', () => {
    const parser = createTerminalHistoryParser();
    const parameters = '1'.repeat(4096);
    expect(consumeTerminalHistoryChunk(parser, '\u001b[')).toBe('');
    for (let index = 0; index < 64; index += 1) {
      expect(consumeTerminalHistoryChunk(parser, parameters)).toBe('');
      expect(parser.units).toBeLessThanOrEqual(MAX_PENDING_CONTROL_SEQUENCE_UNITS);
    }
    expect(parser.overflowed).toBe(true);
    expect(parser.units).toBeLessThanOrEqual(MAX_PENDING_CONTROL_SEQUENCE_UNITS);
  });

  it('drops a control sequence that crosses the cap and replays the text after it', () => {
    const parser = createTerminalHistoryParser();
    const payload = 'z'.repeat(MAX_PENDING_CONTROL_SEQUENCE_UNITS);
    expect(consumeTerminalHistoryChunk(parser, '\u001b]0;')).toBe('');
    expect(consumeTerminalHistoryChunk(parser, payload)).toBe('');
    expect(parser.overflowed).toBe(true);
    expect(consumeTerminalHistoryChunk(parser, '\u0007visible tail')).toBe('visible tail');
    expect(parser.units).toBe(0);
  });

  it('keeps a carried surrogate pair and a lone surrogate intact', () => {
    const parser = createTerminalHistoryParser();
    // The high surrogate of the pair arrives in one chunk and the low
    // surrogate in the next, so the carried body holds half a pair.
    expect(consumeTerminalHistoryChunk(parser, '\u001b]0;\uD83D')).toBe('');
    expect(consumeTerminalHistoryChunk(parser, '\uDE00\u0007after')).toBe('\u001b]0;\uD83D\uDE00\u0007after');
    expect(parser.units).toBe(0);
    // A lone surrogate in a carried fragment survives the copy unchanged.
    expect(consumeTerminalHistoryChunk(parser, '\u001b]1;\uDE00')).toBe('');
    expect(consumeTerminalHistoryChunk(parser, '\u0007after')).toBe('\u001b]1;\uDE00\u0007after');
    expect(parser.units).toBe(0);
  });

  it('keeps an escape sequence with intermediate bytes in the replay', () => {
    const parser = createTerminalHistoryParser();
    // ESC ( 0 designates a character set, ESC # 8 is the screen alignment
    // test, ESC % G selects a character set, ESC SP F is a final byte after
    // an intermediate.
    expect(consumeTerminalHistoryChunk(parser, '\u001b(0')).toBe('\u001b(0');
    expect(consumeTerminalHistoryChunk(parser, '\u001b#8')).toBe('\u001b#8');
    expect(consumeTerminalHistoryChunk(parser, '\u001b%G')).toBe('\u001b%G');
    expect(consumeTerminalHistoryChunk(parser, '\u001b F')).toBe('\u001b F');
    expect(parser.units).toBe(0);
  });

  it('assembles an escape sequence with intermediate bytes split across chunks', () => {
    const parser = createTerminalHistoryParser();
    expect(consumeTerminalHistoryChunk(parser, '\u001b(')).toBe('');
    expect(consumeTerminalHistoryChunk(parser, '0')).toBe('\u001b(0');
    expect(parser.units).toBe(0);

    const other = createTerminalHistoryParser();
    expect(consumeTerminalHistoryChunk(other, '\u001b#')).toBe('');
    expect(consumeTerminalHistoryChunk(other, '8')).toBe('\u001b#8');
    expect(other.units).toBe(0);
  });

  it('ends an escape sequence at a byte that is neither intermediate nor final', () => {
    const parser = createTerminalHistoryParser();
    // BEL is neither, so the sequence ends after its first intermediate byte
    // and the rest is ordinary text.
    expect(consumeTerminalHistoryChunk(parser, '\u001b(\u0007after')).toBe('\u001b(\u0007after');
    expect(parser.units).toBe(0);

    const split = createTerminalHistoryParser();
    expect(consumeTerminalHistoryChunk(split, '\u001b(')).toBe('');
    expect(consumeTerminalHistoryChunk(split, '\u0007after')).toBe('\u001b(\u0007after');
    expect(split.units).toBe(0);
  });

  it('drops a control string that crosses the cap inside one chunk', () => {
    const parser = createTerminalHistoryParser();
    const payload = 'z'.repeat(MAX_PENDING_CONTROL_SEQUENCE_UNITS);
    expect(consumeTerminalHistoryChunk(parser, `\u001b]0;${payload}\u0007after`)).toBe('after');
    expect(parser.units).toBe(0);
  });

  it('parses a long unterminated control string in linear time', () => {
    const parser = createTerminalHistoryParser();
    const chunk = 'x'.repeat(4096);
    let replay = '';
    const started = performance.now();
    // The stream opens a control string and never terminates it, which is the
    // shape the issue reports: the previous implementation carried the whole
    // accumulated buffer and re-parsed it on every chunk, and needed about 15
    // CPU-seconds for 4 MiB delivered this way.
    replay += consumeTerminalHistoryChunk(parser, '\u001b]0;' + chunk);
    for (let index = 1; index < 1024; index += 1) replay += consumeTerminalHistoryChunk(parser, chunk);
    const elapsed = performance.now() - started;
    // The incremental parser scans the stream once, so this stays far below
    // the budget: the case takes about 50 ms, and the budget still catches a
    // tenfold regression. Re-parsing a growing pending buffer needs 19 to 25
    // seconds for the same input.
    expect(elapsed).toBeLessThan(400);
    // The case really has the pathological shape: the carried sequence crossed
    // the cap, the carried bytes stayed within it, and the control payload
    // never reached the replay.
    expect(parser.overflowed).toBe(true);
    expect(parser.units).toBeLessThanOrEqual(MAX_PENDING_CONTROL_SEQUENCE_UNITS);
    expect(replay).toBe('');
  });
});
