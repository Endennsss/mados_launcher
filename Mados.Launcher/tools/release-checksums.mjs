import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

// Publish alongside the exact NSIS asset, before making the release visible.
const directory = resolve(process.argv[2]);
const files = (await readdir(directory)).filter(name => /^Mados\.Launcher\.Windows\.(x64|arm64)\.exe$/.test(name));
if (!files.length) throw Error("No Windows launcher installer found for checksums");
for (const name of files) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(join(directory, name))) hash.update(chunk);
  await writeFile(join(directory, `${name}.sha512`), hash.digest("base64") + "\n");
  console.log(`Checksum ready: ${name}.sha512`);
}
