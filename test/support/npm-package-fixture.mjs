import { gzipSync } from "node:zlib";

const BLOCK = 512;

function member(name, value) {
  const body = Buffer.from(value);
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100);
  header.write("0000644\0", 100, 8);
  header.write("0000000\0", 108, 8);
  header.write("0000000\0", 116, 8);
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12);
  header.write("00000000000\0", 136, 12);
  header.write("0", 156, 1);
  header.write("ustar\0", 257, 6);
  header.write("00", 263, 2);
  header.fill(32, 148, 156);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return Buffer.concat([header, body, Buffer.alloc((BLOCK - body.length % BLOCK) % BLOCK)]);
}

/** Deterministic registry fixture, without installing, packing or extracting anything. */
export function npmPackageFixture(manifest, payload = "") {
  return gzipSync(Buffer.concat([
    member("package/package.json", JSON.stringify(manifest) + "\n"),
    member("package/src/index.mjs", "export default " + JSON.stringify(String(payload)) + ";\n"),
    Buffer.alloc(2 * BLOCK),
  ]));
}
