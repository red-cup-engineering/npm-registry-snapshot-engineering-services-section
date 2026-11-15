import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPackageRegistryServer, closeServer, listen } from "@red-cup-engineering/npm-registry-read-service";
import { assemblePackageRegistrySnapshot } from "../../scripts/assemble-package-registry-snapshot.mjs";
import { npmPackageFixture } from "./npm-package-fixture.mjs";

export async function fixtureTarball(root, manifest) {
  const entrypointSource = manifest.dependencies
    ? 'export { admitted } from "plain-provider";\n'
    : 'export const admitted = "plain-provider@2.0.0-dev.0";\n';
  const bytes = npmPackageFixture(manifest, "", { entrypointSource });
  const artifactPath = join(root, `${manifest.name.replaceAll("@", "").replaceAll("/", "-")}-${manifest.version}.tgz`);
  await writeFile(artifactPath, bytes);
  return { manifest, artifactPath, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

export const snapshotRegistryUrl = "https://snapshot.fixture.invalid/";

export function expectedTarballPath({ name, version }) {
  return name === "@customer/provider"
    ? `/@customer/provider/-/provider-${version}.tgz`
    : `/plain-provider/-/plain-provider-${version}.tgz`;
}

async function withSnapshot(assay) {
  const root = await mkdtemp(join(tmpdir(), "npm-snapshot-offline-"));
  try {
    const plain = await fixtureTarball(root, { name: "plain-provider", version: "2.0.0-dev.0", type: "module", exports: "./src/index.mjs" });
    const scoped = await fixtureTarball(root, { name: "@customer/provider", version: "1.0.0-dev.0", type: "module", exports: "./src/index.mjs", dependencies: { "plain-provider": "2.0.0-dev.0" } });
    const registryDirectory = join(root, "registry");
    const releases = [scoped, plain];
    await assemblePackageRegistrySnapshot({ releases, outputDirectory: registryDirectory, registryUrl: snapshotRegistryUrl });
    await assay({ root, registryDirectory, releases });
  } finally { await rm(root, { recursive: true, force: true }); }
}

export async function withReader(assay) {
  await withSnapshot(async ({ root, registryDirectory, releases }) => {
    const server = createPackageRegistryServer({ registryDirectory });
    await listen(server, { host: "127.0.0.1", port: 0 });
    try {
      const registry = `http://127.0.0.1:${server.address().port}/`;
      await assay({ root, registry, releases });
    } finally { await closeServer(server); }
  });
}

