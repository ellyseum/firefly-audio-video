/**
 * Reads a rendered file's video codec FourCC from its container: the first
 * sample entry of the first video track, at `moov/trak/mdia/minf/stbl/stsd`
 * in an ISO base media (MP4) or QuickTime (MOV) file — `ap4h` for ProRes 4444,
 * `ap4x` for ProRes 4444 XQ, `hvc1` for HEVC, `avc1` for H.264. Only box
 * headers are read, so the media payload is skipped rather than loaded; the
 * top-level boxes must tile the file exactly, which a truncated download fails.
 */

import { open, type FileHandle } from 'node:fs/promises';

/** A box: its four-character type and the byte range of its payload. */
interface Box {
  readonly type: string;
  /** Offset of the payload, just past the box header. */
  readonly start: number;
  /** Offset just past the box's last byte. */
  readonly end: number;
}

/**
 * The FourCC of the first video track's first sample entry in the MP4 or MOV
 * file at `path`, or `undefined` when the file has no `moov` or no video track.
 *
 * @throws when the file is not a complete sequence of boxes — a box claims
 *   more bytes than its parent holds, or the last one stops short of the end
 *   of the file: a truncated download, or not an MP4 or MOV at all.
 */
export async function videoSampleEntry(path: string): Promise<string | undefined> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const root: Box = { type: 'file', start: 0, end: size };
    const top: Box[] = [];
    for await (const box of boxesIn(file, root)) top.push(box);
    const last = top.at(-1);
    if (last?.end !== size) throw malformed(root, last?.end ?? 0);
    const moov = top.find((box) => box.type === 'moov');
    if (moov === undefined) return undefined;
    for await (const trak of boxesIn(file, moov)) {
      if (trak.type !== 'trak') continue;
      const mdia = await child(file, trak, 'mdia');
      if (mdia === undefined) continue;
      // `hdlr` payload: version and flags (4 bytes), a pre-defined or component-type field (4), then the handler type.
      const hdlr = await child(file, mdia, 'hdlr');
      if (hdlr === undefined || (await fourcc(file, hdlr.start + 8)) !== 'vide') continue;
      // `stsd` payload: version and flags (4 bytes), the entry count (4), then the first entry's size (4) and format.
      const stsd = await descend(file, mdia, ['minf', 'stbl', 'stsd']);
      if (stsd !== undefined) return fourcc(file, stsd.start + 12);
    }
    return undefined;
  } finally {
    await file.close();
  }
}

/** The boxes directly inside `parent`, in file order, each header read only when it is reached. */
async function* boxesIn(file: FileHandle, parent: Box): AsyncGenerator<Box> {
  const header = Buffer.alloc(16);
  let offset = parent.start;
  while (offset + 8 <= parent.end) {
    const { bytesRead } = await file.read(header, 0, 16, offset);
    if (bytesRead < 8) throw malformed(parent, offset);
    const declared = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    let headerSize = 8;
    let size = declared;
    if (declared === 1) {
      if (bytesRead < 16) throw malformed(parent, offset);
      headerSize = 16;
      size = Number(header.readBigUInt64BE(8));
    } else if (declared === 0) {
      size = parent.end - offset;
    }
    if (size < headerSize || offset + size > parent.end) throw malformed(parent, offset);
    yield { type, start: offset + headerSize, end: offset + size };
    offset += size;
  }
}

/** The first box of `type` directly inside `parent`. */
async function child(file: FileHandle, parent: Box, type: string): Promise<Box | undefined> {
  for await (const box of boxesIn(file, parent)) {
    if (box.type === type) return box;
  }
  return undefined;
}

/** The box `types` names, one level per entry, below `parent`. */
async function descend(
  file: FileHandle,
  parent: Box,
  types: readonly string[],
): Promise<Box | undefined> {
  let box: Box | undefined = parent;
  for (const type of types) {
    if (box === undefined) return undefined;
    box = await child(file, box, type);
  }
  return box;
}

/** The four latin-1 characters at `offset`. */
async function fourcc(file: FileHandle, offset: number): Promise<string> {
  const bytes = Buffer.alloc(4);
  const { bytesRead } = await file.read(bytes, 0, 4, offset);
  if (bytesRead < 4) {
    throw new Error(`The file ends inside the four-character code at byte ${offset}.`);
  }
  return bytes.toString('latin1');
}

function malformed(parent: Box, offset: number): Error {
  return new Error(
    `The box at byte ${offset} inside '${parent.type}' is cut short or runs past its parent: not a complete MP4 or MOV file.`,
  );
}
