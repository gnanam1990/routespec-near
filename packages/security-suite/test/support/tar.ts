/**
 * Hand-built ustar archives for hostile-archive tests. The product writer refuses unsafe names,
 * so attack archives are assembled here byte by byte: arbitrary names, link targets, and
 * entry types (regular, hard link, symbolic link, directory, PAX header).
 */
export interface RawEntry {
  readonly name: string;
  readonly content?: Buffer | string;
  /** ustar typeflag: '0' file, '1' hard link, '2' symlink, '5' directory, 'x' PAX header. */
  readonly type?: string;
  readonly linkname?: string;
}

function header(e: RawEntry, size: number): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(e.name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8, 'ascii');
  h.write('0000000\0', 108, 8, 'ascii');
  h.write('0000000\0', 116, 8, 'ascii');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(e.type ?? '0', 156, 1, 'ascii');
  if (e.linkname) h.write(e.linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

export function rawTar(entries: readonly RawEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content ?? '', 'utf8');
    parts.push(header(e, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}
