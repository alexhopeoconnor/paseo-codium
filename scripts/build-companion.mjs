import { build } from "esbuild";
import { readFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out-dir" || !isAbsolute(args[1])) throw new Error("Use --out-dir with an absolute directory outside the source tree.");
await mkdir(args[1], { recursive: true });
const output = await realpath(args[1]);
const rel = relative(await realpath(source), output);
if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) throw new Error("Build output must be outside the source tree.");
const manifest = JSON.parse(await readFile(resolve(source, "companion/package.json"), "utf8"));
const bundled = await build({
  absWorkingDir: source, entryPoints: ["companion/src/extension.ts"],
  bundle: true, write: false, platform: "node", format: "cjs", target: "node22",
  external: ["vscode"], sourcemap: false, legalComments: "inline", charset: "utf8",
});
const id = `${manifest.publisher}.${manifest.name}`;
const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const files = new Map([
  ["[Content_Types].xml", Buffer.from('<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="txt" ContentType="text/plain"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>')],
  ["extension.vsixmanifest", Buffer.from(`<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="${xml(manifest.name)}" Version="${xml(manifest.version)}" Publisher="${xml(manifest.publisher)}"/><DisplayName>${xml(manifest.displayName)}</DisplayName><Description xml:space="preserve">${xml(manifest.description)}</Description><Tags></Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(manifest.engines.vscode)}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties><License>extension/LICENSE.txt</License></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true"/></Assets></PackageManifest>`) ],
  ["extension/package.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n")],
  ["extension/dist/extension.js", Buffer.from(bundled.outputFiles[0].contents)],
  ["extension/README.md", await readFile(resolve(source, "companion/README.md"))],
  ["extension/LICENSE.txt", await readFile(resolve(source, "LICENSE"))],
]);

// Deterministic ZIP STORE: regular files only, fixed timestamps and permissions.
// No archive library, shell process, install hook or network is involved.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunks = []; const central = []; let offset = 0;
for (const [path, bytes] of [...files.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
  const name = Buffer.from(path); const crc = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
  chunks.push(local, name, bytes);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
  entry.writeUInt16LE(33, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(name.length, 28);
  entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
  central.push(entry, name); offset += local.length + name.length + bytes.length;
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
await writeFile(resolve(output, "paseo-codium-bridge.vsix"), Buffer.concat([...chunks, directory, end]));
await writeFile(resolve(output, "companion.json"), JSON.stringify({ id, version: manifest.version, protocolVersion: manifest.paseoCodiumProtocolVersion }, null, 2) + "\n");
process.stdout.write(`Built ${id}@${manifest.version} (protocol ${manifest.paseoCodiumProtocolVersion}).\n`);
