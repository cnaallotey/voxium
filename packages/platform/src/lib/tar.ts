/**
 * Streaming tar.gz reader. Memory stays bounded: only files the caller wants (and that are
 * small enough) are kept, everything else is skipped as it streams past. The result can therefore be
 * incomplete, so compare it with the commit's file list (see uncheckedPaths) before trusting a pass.
 * Handles ustar prefixes, pax extended headers (what GitHub tarballs use) and GNU long names.
 */

import { toHex } from "./crypto";

class ByteReader {
  private chunks: Uint8Array[] = [];
  private len = 0;
  private done = false;
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async pull(): Promise<boolean> {
    if (this.done) return false;
    const { value, done } = await this.reader.read();
    if (done) {
      this.done = true;
      return false;
    }
    if (value && value.length) {
      this.chunks.push(value);
      this.len += value.length;
    }
    return true;
  }

  async take(n: number): Promise<Uint8Array | null> {
    while (this.len < n) if (!(await this.pull())) return null;
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const first = this.chunks[0];
      const k = Math.min(n - off, first.length);
      out.set(first.subarray(0, k), off);
      off += k;
      if (k === first.length) this.chunks.shift();
      else this.chunks[0] = first.subarray(k);
    }
    this.len -= n;
    return out;
  }

  async skip(n: number): Promise<void> {
    while (n > 0) {
      if (this.len === 0 && !(await this.pull())) return;
      const first = this.chunks[0];
      const k = Math.min(n, first.length);
      if (k === first.length) this.chunks.shift();
      else this.chunks[0] = first.subarray(k);
      this.len -= k;
      n -= k;
    }
  }
}

const dec = new TextDecoder();

function str(b: Uint8Array, start: number, len: number): string {
  const slice = b.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return dec.decode(nul === -1 ? slice : slice.subarray(0, nul));
}

function octal(b: Uint8Array, start: number, len: number): number {
  if (b[start] & 0x80) return Number.MAX_SAFE_INTEGER; // base 256 sizes are huge, skip them
  const s = str(b, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

/** Record lengths count bytes, not characters, so this works on the raw bytes. */
function parsePax(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < bytes.length) {
    const sp = bytes.indexOf(0x20, i);
    if (sp === -1) break;
    const total = parseInt(dec.decode(bytes.subarray(i, sp)), 10);
    if (!total) break;
    const rec = dec.decode(bytes.subarray(sp + 1, i + total - 1)); // drop trailing newline
    const eq = rec.indexOf("=");
    if (eq !== -1) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += total;
  }
  return out;
}

export interface ReadTarOptions {
  /** Path with the leading "<repo>-<sha>/" folder already removed. */
  want: (path: string) => boolean;
  maxFileBytes?: number;
  maxKeptBytes?: number;
  /**
   * Git blob hash of every file in the commit. Only files whose contents match are kept, because
   * .gitattributes can make an archive differ from the commit (export-subst, working-tree-encoding).
   */
  expect?: ReadonlyMap<string, string>;
}

async function blobHash(data: Uint8Array, algorithm: "SHA-1" | "SHA-256"): Promise<string> {
  const head = new TextEncoder().encode(`blob ${data.length}\0`);
  const all = new Uint8Array(head.length + data.length);
  all.set(head);
  all.set(data, head.length);
  return toHex(await crypto.subtle.digest(algorithm, all));
}

function withoutCarriageReturns(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) if (!(data[i] === 13 && data[i + 1] === 10)) out[n++] = data[i];
  return out.subarray(0, n);
}

/** The bytes exactly as committed, or null when the archive holds something else. */
async function asCommitted(data: Uint8Array, sha: string | undefined): Promise<Uint8Array | null> {
  if (!sha) return null;
  const algorithm = sha.length === 64 ? "SHA-256" : "SHA-1";
  if ((await blobHash(data, algorithm)) === sha) return data;
  // Archives apply eol=crlf. Undoing that is safe because the hash still has to match.
  if (!data.includes(13)) return null;
  const lf = withoutCarriageReturns(data);
  return (await blobHash(lf, algorithm)) === sha ? lf : null;
}

export async function readTarGz(
  source: ReadableStream<Uint8Array>,
  opts: ReadTarOptions,
): Promise<Record<string, string>> {
  const maxFile = opts.maxFileBytes ?? 4_000_000;
  const maxKept = opts.maxKeptBytes ?? 40_000_000;
  const reader = new ByteReader(source.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader());
  const files: Record<string, string> = {};
  let kept = 0;
  let paxPath: string | undefined;
  let gnuLong: string | undefined;

  for (;;) {
    const header = await reader.take(512);
    if (!header) break;
    if (header.every((b) => b === 0)) continue; // end of archive blocks

    const type = String.fromCharCode(header[156] || 48);
    let name = str(header, 0, 100);
    if (str(header, 257, 5) === "ustar") {
      const prefix = str(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const size = octal(header, 124, 12);
    const padded = Math.ceil(size / 512) * 512;

    if (type === "x" || type === "L") {
      const body = await reader.take(padded);
      if (!body) break;
      const data = body.subarray(0, size);
      if (type === "x") paxPath = parsePax(data).path ?? paxPath;
      else gnuLong = dec.decode(data).replace(/\0+$/, "");
      continue;
    }
    if (type === "g" || type === "K") {
      await reader.skip(padded);
      continue;
    }

    const fullName = (paxPath ?? gnuLong ?? name).replace(/^\.\//, "");
    paxPath = undefined;
    gnuLong = undefined;

    const isFile = type === "0" || type === "7";
    const rel = fullName.split("/").slice(1).join("/"); // drop "<repo>-<sha>/"
    if (isFile && rel && size <= maxFile && kept + size <= maxKept && opts.want(rel)) {
      const body = await reader.take(padded);
      if (!body) break;
      const raw = body.subarray(0, size);
      const data = opts.expect ? await asCommitted(raw, opts.expect.get(rel)) : raw;
      if (!data) continue;
      files[rel] = dec.decode(data);
      kept += size;
    } else {
      await reader.skip(padded);
    }
  }
  return files;
}
