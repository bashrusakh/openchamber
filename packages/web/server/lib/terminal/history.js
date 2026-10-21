const isCsiFinalByte = (code) => code >= 0x40 && code <= 0x7e;
const shouldStripCsi = (body, finalByte) =>
  finalByte === 'n'
  || (finalByte === 'R' && /^[0-9;?]*$/.test(body))
  || (finalByte === 'c' && /^[>0-9;?]*$/.test(body))
  || ((finalByte === 'p' || finalByte === 'y') && /^\?2031(?:;[0-9]+)?\$$/.test(body))
  || ((finalByte === 'h' || finalByte === 'l') && body === '?2031');
const shouldStripOsc = (content) => /^(10|11|12);(?:\?|rgb:)/.test(content);

// All six control-string introducers: ESC, DCS, CSI, OSC, PM, and APC. Replay
// history has to notice every one, or a C1 query byte leaks into the replay.
const isControlIntroducer = (code) => code === 0x1b || code === 0x90 || code === 0x9b || code === 0x9d || code === 0x9e || code === 0x9f;
const findControlIntroducer = (input, start) => {
  for (let cursor = start; cursor < input.length; cursor += 1) {
    if (isControlIntroducer(input.charCodeAt(cursor))) return cursor;
  }
  return -1;
};

// A CSI is kept in the replay unless it is one of the query exchanges the
// strip predicates name, and unless the sequence is too long to carry. The
// caller says which: a sequence that was carried already knows, and one that
// never left its chunk is measured.
const keepCsi = (body, finalByte, tooLong) => !tooLong && !shouldStripCsi(body, finalByte);
// A control string is kept in the replay unless it is an OSC colour query, and
// unless the sequence is too long to carry.
const keepControlString = (content, osc, tooLong) => !tooLong && (!osc || !shouldStripOsc(content));

// The end of a CSI is its first final byte, or -1 when the sequence runs past
// the end of the chunk.
const findCsiEnd = (input, start) => {
  for (let cursor = start; cursor < input.length; cursor += 1) {
    if (isCsiFinalByte(input.charCodeAt(cursor))) return cursor;
  }
  return -1;
};

// The terminator of a control string is BEL, the C1 ST, or ESC backslash.
// Returns where the terminator starts, or -1 when the string runs past the end
// of the chunk.
const findStringTerminator = (input, start) => {
  for (let cursor = start; cursor < input.length; cursor += 1) {
    const code = input.charCodeAt(cursor);
    if (code === BEL_CODE || code === ST_CODE) return cursor;
    if (code === ESC_CODE && input.charCodeAt(cursor + 1) === BACKSLASH_CODE) return cursor;
  }
  return -1;
};

// A terminator is one byte (BEL or the C1 ST) or two (ESC backslash).
const stringTerminatorLength = (code) => (code === ESC_CODE ? 2 : 1);

// A control string opens with ESC followed by ] P ^ or _, or with one of the
// C1 codes for DCS, OSC, PM and APC. Returns the length of the introducer, or
// 0 when the bytes there do not open one.
const controlStringLength = (code, data, index) => {
  if (code === ESC_CODE) {
    const next = data.charCodeAt(index + 1);
    return next === 0x5d || next === 0x50 || next === 0x5e || next === 0x5f ? 2 : 0;
  }
  return code === OSC_CODE || code === 0x90 || code === 0x9e || code === 0x9f ? 1 : 0;
};

// Only an OSC carries a colour query that the replay drops.
const isOscString = (code, data, index) =>
  code === OSC_CODE || (code === ESC_CODE && data.charCodeAt(index + 1) === 0x5d);

const ESC_CODE = 0x1b;
const BEL_CODE = 0x07;
const BACKSLASH_CODE = 0x5c;
const BACKSLASH = '\u005c';
const ST_CODE = 0x9c;
const CSI_CODE = 0x9b;
const OSC_CODE = 0x9d;
// Escape sequence intermediates (0x20-0x2f) may precede the final byte.
const isEscapeIntermediate = (code) => code >= 0x20 && code <= 0x2f;
const isEscapeFinalByte = (code) => code >= 0x30 && code <= 0x7e;

// One in-progress control sequence may not carry more than this many UTF-16
// code units. The scrollback cap does not bound it: a stream that never
// terminates a control sequence would otherwise grow the carried state with
// the stream.
export const MAX_PENDING_CONTROL_SEQUENCE_UNITS = 64 * 1024;

// The replay parser keeps one explicit state per terminal session. A control
// sequence that spans PTY chunks is carried forward instead of being re-parsed
// from the start on every chunk, so the work stays linear in the stream size.
export const createTerminalHistoryParser = () => ({
  mode: 'text',
  introducer: '',
  body: '',
  tail: '',
  units: 0,
  start: -1,
  overflowed: false,
  osc: false,
  stringEscape: false,
});

const resetSequence = (parser) => {
  parser.mode = 'text';
  parser.introducer = '';
  parser.body = '';
  parser.tail = '';
  parser.units = 0;
  parser.start = -1;
  parser.overflowed = false;
  parser.osc = false;
  parser.stringEscape = false;
};

const startSequence = (parser, mode, introducer, osc) => {
  parser.mode = mode;
  parser.introducer = introducer;
  parser.body = '';
  parser.tail = '';
  // The carried size is counted in UTF-16 code units, so the introducer is
  // counted the same way as in the overflow reset below.
  parser.units = introducer.length;
  // The bytes of the sequence are only contiguous while it stays in the chunk
  // it started in; the caller knows where it started.
  parser.start = -1;
  parser.overflowed = false;
  parser.osc = osc;
  parser.stringEscape = false;
};

// The carried payload: the part that was detached from an earlier chunk plus
// the part carried in the current one.
const carriedPayload = (parser) => (parser.tail ? parser.body + parser.tail : parser.body);

// Carry the payload of an in-progress control sequence. The fragment is not
// copied here: it is copied at the chunk boundary, and only if it survives
// into the next chunk. A sequence that grows past the cap is dropped from the
// replay: its payload must never reappear as printable text, and the parser
// resynchronises at the end of the sequence instead of holding on to it.
const carrySequenceBody = (parser, text) => {
  if (!text || parser.overflowed) return;
  if (parser.units + text.length > MAX_PENDING_CONTROL_SEQUENCE_UNITS) {
    parser.overflowed = true;
    parser.body = '';
    parser.tail = '';
    parser.units = parser.introducer.length;
    return;
  }
  parser.tail += text;
  parser.units += text.length;
};

// A slice is a view that keeps its parent string alive, so a carried fragment
// would pin the whole PTY callback it was cut from, and the retained state
// would grow past the cap with it. Copying the fragment keeps the retained
// state bounded by the fragment itself: the concatenation is flattened into a
// string of its own before it is sliced, so the copy no longer references the
// callback. The copy holds the same code units, so a surrogate pair that
// arrives in two chunks still assembles and a lone surrogate survives.
const copyFragment = (text) => `${text} `.slice(0, text.length);

// Returns the replay-safe text of one PTY chunk. The parser keeps the state of
// the control sequence that is still in progress, so the caller owns one
// parser per terminal session.
export const consumeTerminalHistoryChunk = (parser, data) => {
  let visible = '';
  let index = 0;
  while (index < data.length) {
    if (parser.mode === 'text') {
      // Ordinary text: copy the whole run up to the next introducer in one
      // slice instead of appending one character at a time.
      const runEnd = findControlIntroducer(data, index);
      if (runEnd === -1) { visible += data.slice(index); break; }
      visible += data.slice(index, runEnd);
      index = runEnd;
      const code = data.charCodeAt(index);
      // A CSI that ends in this chunk is the common case, and it is replayed
      // from the chunk itself: one slice for the sequence and one for its
      // body. Only a sequence that reaches into the next chunk needs the
      // parser state below.
      if (code === ESC_CODE && data.charCodeAt(index + 1) === 0x5b) {
        const cursor = findCsiEnd(data, index + 2);
        if (cursor !== -1) {
          const body = data.slice(index + 2, cursor);
          const finalByte = data[cursor];
          if (keepCsi(body, finalByte, body.length + 2 > MAX_PENDING_CONTROL_SEQUENCE_UNITS)) {
            visible += data.slice(index, cursor + 1);
          }
          index = cursor + 1;
          continue;
        }
        // The sequence continues in the next chunk: carry it.
        startSequence(parser, 'csi', '\u001b[', false);
        parser.start = index;
        index += 2;
        continue;
      }
      // A control string that ends in this chunk is the common case too, and
      // it is replayed from the chunk itself, the same way a CSI is.
      const controlLength = controlStringLength(code, data, index);
      if (controlLength > 0) {
        const terminatorStart = findStringTerminator(data, index + controlLength);
        if (terminatorStart !== -1) {
          const body = data.slice(index + controlLength, terminatorStart);
          const end = terminatorStart + stringTerminatorLength(data.charCodeAt(terminatorStart));
          const tooLong = body.length + controlLength > MAX_PENDING_CONTROL_SEQUENCE_UNITS;
          if (keepControlString(body, isOscString(code, data, index), tooLong)) {
            visible += data.slice(index, end);
          }
          index = end;
          continue;
        }
      }
      if (code === ESC_CODE) startSequence(parser, 'escape', '\u001b', false);
      else if (code === CSI_CODE) startSequence(parser, 'csi', '\u009b', false);
      else startSequence(parser, 'string', data[index], code === OSC_CODE);
      parser.start = runEnd;
      index += 1;
      continue;
    }
    if (parser.mode === 'escape') {
      const code = data.charCodeAt(index);
      if (code === 0x5b) { startSequence(parser, 'csi', '\u001b[', false); index += 1; continue; }
      if (code === 0x5d || code === 0x50 || code === 0x5e || code === 0x5f) {
        startSequence(parser, 'string', `\u001b${data[index]}`, code === 0x5d);
        index += 1;
        continue;
      }
      if (isEscapeIntermediate(code)) {
        parser.mode = 'intermediate';
        parser.tail = data[index];
        parser.units = parser.introducer.length + 1;
        index += 1;
        continue;
      }
      // Any other byte closes a two-byte escape sequence, which stays in the
      // replay exactly as it arrived.
      visible += parser.start >= 0 ? data.slice(parser.start, index + 1) : parser.introducer + data[index];
      resetSequence(parser);
      index += 1;
      continue;
    }
    if (parser.mode === 'intermediate') {
      let cursor = index;
      while (cursor < data.length && isEscapeIntermediate(data.charCodeAt(cursor))) cursor += 1;
      if (cursor > index) {
        carrySequenceBody(parser, data.slice(index, cursor));
        index = cursor;
        if (index >= data.length) continue;
      }
      const code = data.charCodeAt(index);
      if (isEscapeFinalByte(code)) {
        if (!parser.overflowed) {
          visible += parser.start >= 0
            ? data.slice(parser.start, index + 1)
            : parser.introducer + carriedPayload(parser) + data[index];
        }
        resetSequence(parser);
        index += 1;
        continue;
      }
      // A byte that is neither an intermediate nor a final byte ends the escape
      // sequence after its first intermediate byte; the rest is ordinary text.
      if (!parser.overflowed) {
        visible += parser.start >= 0
          ? data.slice(parser.start, parser.start + 2) + data.slice(parser.start + 2, index)
          : parser.introducer + carriedPayload(parser);
      }
      resetSequence(parser);
      continue;
    }
    if (parser.mode === 'csi') {
      const cursor = findCsiEnd(data, index);
      if (cursor === -1) {
        // The sequence continues in the next chunk: carry the rest of it.
        carrySequenceBody(parser, data.slice(index));
        index = data.length;
        continue;
      }
      if (cursor > index) {
        carrySequenceBody(parser, data.slice(index, cursor));
        index = cursor;
      }
      const finalByte = data[index];
      const payload = carriedPayload(parser);
      if (keepCsi(payload, finalByte, parser.overflowed)) {
        visible += parser.start >= 0 ? data.slice(parser.start, index + 1) : parser.introducer + payload + finalByte;
      }
      resetSequence(parser);
      index += 1;
      continue;
    }
    // A control string: OSC, DCS, PM, or APC.
    if (parser.stringEscape) {
      // The previous chunk ended with ESC inside a control string.
      parser.stringEscape = false;
      if (data.charCodeAt(index) === BACKSLASH_CODE) {
        const payload = carriedPayload(parser);
        if (keepControlString(payload, parser.osc, parser.overflowed)) {
          visible += parser.introducer + payload + BACKSLASH;
        }
        resetSequence(parser);
        index += 1;
        continue;
      }
      // The ESC was payload, so the byte that follows it is payload as well.
    }
    const terminatorStart = findStringTerminator(data, index);
    if (terminatorStart === -1) {
      // The control string continues in the next chunk.
      carrySequenceBody(parser, data.slice(index));
      index = data.length;
      if (data.charCodeAt(data.length - 1) === ESC_CODE) parser.stringEscape = true;
      continue;
    }
    const end = terminatorStart + stringTerminatorLength(data.charCodeAt(terminatorStart));
    carrySequenceBody(parser, data.slice(index, terminatorStart));
    index = terminatorStart;
    const payload = carriedPayload(parser);
    if (keepControlString(payload, parser.osc, parser.overflowed)) {
      visible += parser.start >= 0
        ? data.slice(parser.start, end)
        : parser.introducer + payload + data.slice(terminatorStart, end);
    }
    resetSequence(parser);
    index = end;
  }
  if (parser.mode !== 'text') {
    // The carried payload survives into the next chunk, so it is detached from
    // the PTY callback here. Only the material carried in this chunk is new:
    // the rest was detached at an earlier boundary, so every carried byte is
    // copied once.
    parser.introducer = copyFragment(parser.introducer);
    parser.body += copyFragment(parser.tail);
    parser.tail = '';
    // The sequence continues in the next chunk, so its bytes are no longer
    // contiguous in one chunk.
    parser.start = -1;
  }
  return visible;
};
