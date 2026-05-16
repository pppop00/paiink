/**
 * GET /verify/<uuid>/export — verification export bundle.
 *
 * Produces a gzipped tar containing everything a third party needs to
 * verify the article offline:
 *
 *   ai-audit.json                                    (R2 manifest bytes)
 *   index.html                                       (R2 article bytes)
 *   agreements/agreement-<version>.md                (R2 agreement bytes)
 *   schemas/ai-audit/v1.json                         (R2 schema bytes)
 *   README.md                                        (one-paragraph instructions)
 *
 * Implementation:
 *   1. Fetch all required bytes from R2 in parallel.
 *   2. Build a USTAR-format tar buffer in-Worker (~200 lines below).
 *   3. Pipe through `new CompressionStream('gzip')`.
 *   4. Stream the gzip-encoded ReadableStream out as the response body.
 *
 * USTAR is the right format here because it has zero external deps and
 * the verify tool (`tar xz`) accepts it. Tar buffer is small enough
 * (< 1 MB even for the largest article) that we build it in memory.
 *
 * Any missing R2 object → 500. Don't ship a half-bundle.
 */

import type { Env, Manifest } from "../types";
import { HttpError } from "../types";
import { getArticleByUuid } from "../db/queries";
import {
  getArticleHTML,
  getArticleManifest,
  getArticleManifestBytes,
  getAgreementBytes,
  getSchemaBytes,
} from "../r2";

const README = `# paiink export bundle

This archive contains the bytes needed to verify an article published on
www.paiink.com offline.

## Files

- \`ai-audit.json\`               provenance manifest
- \`index.html\`                  article HTML (hashed by manifest.content_sha256)
- \`agreements/agreement-*.md\`   the agreement version pinned in the manifest
- \`schemas/ai-audit/v1.json\`    JSON Schema the manifest validates against
- \`README.md\`                   this file

## Verify

\`\`\`
git clone https://github.com/pppop00/paiink
cd paiink
pip install -r tools/requirements.txt
python3 tools/verify_audit.py --offline /path/to/ai-audit.json
\`\`\`

Offline mode skips network checks (skill repo public, commit exists) but
still verifies content_sha256, agreement hash, schema conformance, and
ed25519 signature if present.
`;

export async function handleExport(
  _req: Request,
  env: Env,
  uuid: string,
): Promise<Response> {
  const row = await getArticleByUuid(env.DB, uuid);
  if (!row) {
    throw new HttpError(404, "not_found", `No article with uuid=${uuid}`);
  }

  // Fetch manifest first to know which agreement version we need. Then fan
  // out the rest in parallel.
  const manifest: Manifest | null = await getArticleManifest(env.R2_CONTENT, uuid);
  if (!manifest) {
    throw new HttpError(500, "missing_manifest", `R2 manifest missing for uuid=${uuid}`);
  }
  const agreementVersion = manifest.agreement?.version || "v2";

  const [manifestBytes, htmlStream, agreementBytes, schemaBytes] = await Promise.all([
    getArticleManifestBytes(env.R2_CONTENT, uuid),
    getArticleHTML(env.R2_CONTENT, uuid),
    getAgreementBytes(env.R2_CONTENT, agreementVersion),
    getSchemaBytes(env.R2_CONTENT),
  ]);

  if (!manifestBytes || !htmlStream || !agreementBytes || !schemaBytes) {
    throw new HttpError(
      500,
      "missing_r2_object",
      `Missing R2 object for export uuid=${uuid}`,
    );
  }

  const htmlBytes = await readStreamToBytes(htmlStream);
  const readmeBytes = new TextEncoder().encode(README);

  // Build tar in memory.
  const tarBytes = buildTar([
    { name: "ai-audit.json", data: manifestBytes },
    { name: "index.html", data: htmlBytes },
    {
      name: `agreements/agreement-${agreementVersion}.md`,
      data: agreementBytes,
    },
    { name: "schemas/ai-audit/v1.json", data: schemaBytes },
    { name: "README.md", data: readmeBytes },
  ]);

  // Pipe tar bytes through gzip CompressionStream so the response streams
  // out compressed instead of materializing the gzipped blob first.
  const tarStream = new Response(tarBytes).body!;
  const gzipped = tarStream.pipeThrough(new CompressionStream("gzip"));

  return new Response(gzipped, {
    status: 200,
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="paiink-export-${uuid}.tar.gz"`,
      "cache-control": "public, max-age=3600",
    },
  });
}

// ---------- USTAR tar encoder ----------

interface TarEntry {
  name: string;
  data: Uint8Array;
  mode?: number;
  mtime?: number;
}

/**
 * Build a USTAR-format tar archive (POSIX 1003.1-1988). Each entry is:
 *   • 512-byte header (see fields below)
 *   • data padded up to a 512-byte boundary
 * The archive ends with two zero-filled 512-byte blocks.
 *
 * We use the modern "ustar" magic so GNU tar / bsdtar / Python's tarfile
 * all accept it. Names ≤ 100 bytes; we don't ship anything longer.
 */
function buildTar(entries: TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = makeUstarHeader(entry);
    blocks.push(header);
    blocks.push(entry.data);
    const pad = (512 - (entry.data.byteLength % 512)) % 512;
    if (pad > 0) {
      blocks.push(new Uint8Array(pad));
    }
  }
  // End-of-archive: two zero blocks.
  blocks.push(new Uint8Array(1024));

  let total = 0;
  for (const b of blocks) total += b.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.byteLength;
  }
  return out;
}

function makeUstarHeader(entry: TarEntry): Uint8Array {
  const header = new Uint8Array(512);
  const name = entry.name;
  if (name.length > 100) {
    // Could use the USTAR `prefix` field but our names are all short.
    throw new Error(`tar entry name too long: ${name}`);
  }

  const mode = entry.mode ?? 0o644;
  const mtime = entry.mtime ?? Math.floor(Date.now() / 1000);
  const size = entry.data.byteLength;

  // Field layout (offset, length): name 0,100; mode 100,8; uid 108,8;
  // gid 116,8; size 124,12; mtime 136,12; chksum 148,8; typeflag 156,1;
  // linkname 157,100; magic 257,6; version 263,2; uname 265,32;
  // gname 297,32; devmajor 329,8; devminor 337,8; prefix 345,155.
  writeString(header, 0, name, 100);
  writeOctal(header, 100, mode, 7);                 // mode (null-terminated 8 bytes)
  writeOctal(header, 108, 0, 7);                    // uid
  writeOctal(header, 116, 0, 7);                    // gid
  writeOctal(header, 124, size, 11);                // size, 12 bytes, null-term
  writeOctal(header, 136, mtime, 11);               // mtime
  // Checksum field placeholder: 8 spaces until computed below.
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  header[156] = 0x30;                               // typeflag '0' = regular file
  writeString(header, 257, "ustar", 6);             // magic
  header[263] = 0x30; header[264] = 0x30;           // version "00"
  writeString(header, 265, "paiink", 32);           // uname
  writeString(header, 297, "paiink", 32);           // gname

  // Compute checksum: sum of all header bytes treating chksum field as spaces.
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  // Write checksum as 6-digit octal + NUL + space (POSIX-compliant).
  writeOctal(header, 148, sum, 6);
  header[154] = 0x00;
  header[155] = 0x20;

  return header;
}

function writeString(buf: Uint8Array, offset: number, value: string, length: number): void {
  const encoded = new TextEncoder().encode(value);
  const n = Math.min(encoded.length, length);
  for (let i = 0; i < n; i++) buf[offset + i] = encoded[i];
}

/**
 * Write an octal number into a fixed-width field, null-padded on the
 * right. `length` is the number of octal digits to emit; the field uses
 * length+1 bytes total because USTAR fields are null-terminated.
 */
function writeOctal(buf: Uint8Array, offset: number, value: number, length: number): void {
  let oct = value.toString(8);
  if (oct.length > length) {
    throw new Error(`tar field overflow: ${value} > ${"7".repeat(length)} octal`);
  }
  // Left-pad with zeros to `length` digits.
  while (oct.length < length) oct = "0" + oct;
  for (let i = 0; i < length; i++) {
    buf[offset + i] = oct.charCodeAt(i);
  }
  buf[offset + length] = 0x00;
}

async function readStreamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
