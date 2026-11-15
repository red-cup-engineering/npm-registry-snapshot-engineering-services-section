import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createPackageRegistryServer, closeServer, listen } from "@red-cup-engineering/npm-registry-read-service";
import { assemblePackageRegistrySnapshot } from "../scripts/assemble-package-registry-snapshot.mjs";
import { verifyPackageRegistrySnapshot } from "../scripts/verify-package-registry-snapshot.mjs";
import { activateVerifiedPackageRegistrySnapshot } from "../scripts/activate-verified-package-registry-snapshot.mjs";
import { expectedTarballPath, fixtureTarball, snapshotRegistryUrl, withReader } from "./support/registry-snapshot-receiving.mjs";

async function readFixtureBytes(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    assert.ok(size <= limit, `fixture response exceeded ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

test("the HTTP read service delivers each verified snapshot archive byte-for-byte", { timeout: 15_000 }, async () => {
  await withReader(async ({ registry, releases }) => {
    const receive = (url) => fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
    for (const { manifest, artifactPath, integrity } of releases) {
      const metadata = await receive(new URL(encodeURIComponent(manifest.name), registry));
      assert.equal(metadata.status, 200);
      assert.match(metadata.headers.get("content-type"), /^application\/json\b/u);
      const packument = JSON.parse(await readFixtureBytes(metadata, 64 * 1024));
      const published = packument.versions[manifest.version];
      assert.equal(published.name, manifest.name);
      assert.equal(published.version, manifest.version);
      assert.equal(published.dist.tarball, new URL(expectedTarballPath(manifest), registry).href);
      assert.equal(published.dist.integrity, integrity);
      assert.deepEqual(published.dependencies, manifest.dependencies);

      // Follow only the URL whose exact loopback origin and path were checked
      // above. Independently hash the response, not the local snapshot file.
      const artifact = await receive(published.dist.tarball);
      assert.equal(artifact.status, 200);
      const expected = await readFile(artifactPath);
      assert.match(artifact.headers.get("content-type"), /^application\/octet-stream\b/u);
      assert.equal(artifact.headers.get("content-length"), String(expected.length));
      const bytes = await readFixtureBytes(artifact, expected.length);
      assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, integrity);
      assert.deepEqual(bytes, expected);
    }
  });
});

test("a refused candidate snapshot leaves the last verified HTTP release available", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-snapshot-previous-"));
  let server;
  try {
    const snapshotRoot = join(root, "snapshots");
    const selected = join(snapshotRoot, "selected"), candidate = join(snapshotRoot, "candidate");
    await mkdir(snapshotRoot);
    const prior = await fixtureTarball(root, {
      name: "plain-provider", version: "2.0.0-dev.0", type: "module", exports: "./src/index.mjs",
    });
    await assemblePackageRegistrySnapshot({
      releases: [prior], outputDirectory: selected, registryUrl: snapshotRegistryUrl,
    });
    const verification = await verifyPackageRegistrySnapshot({ registryDirectory: selected });
    const activated = await activateVerifiedPackageRegistrySnapshot({
      hostDirectory: root, candidate: { name: "selected", verification },
    });
    assert.equal(activated.activated, true);
    const current = join(root, "current");
    server = createPackageRegistryServer({ registryDirectory: current });
    await listen(server, { host: "127.0.0.1", port: 0 });
    const registry = `http://127.0.0.1:${server.address().port}/`;
    const receive = path => fetch(new URL(path, registry), { redirect: "error", signal: AbortSignal.timeout(5000) });

    // Preserve the archive digest while deliberately changing the proposed
    // release identity. The original assembler must not admit this candidate.
    const proposed = { ...prior, manifest: { ...prior.manifest, version: "2.0.0-dev.1" } };
    await assert.rejects(assemblePackageRegistrySnapshot({
      releases: [proposed], outputDirectory: candidate, registryUrl: snapshotRegistryUrl,
    }), error => error.defects?.some(defect => defect.code === "ARTIFACT_MANIFEST_REFUSED") === true);
    assert.deepEqual(await readdir(candidate), []);
    assert.equal(await readlink(current), "snapshots/selected");

    const metadata = await receive("plain-provider");
    assert.equal(metadata.status, 200);
    const packument = JSON.parse(await readFixtureBytes(metadata, 64 * 1024));
    assert.deepEqual(Object.keys(packument.versions), [prior.manifest.version]);
    const available = packument.versions[prior.manifest.version];
    assert.equal(available.dist.integrity, prior.integrity);
    assert.equal(available.dist.tarball, new URL(expectedTarballPath(prior.manifest), registry).href);
    const body = await receive(available.dist.tarball);
    const archive = await readFile(prior.artifactPath);
    assert.equal(body.status, 200);
    assert.deepEqual(await readFixtureBytes(body, archive.length), archive);
    const unavailable = await receive(expectedTarballPath(proposed.manifest));
    assert.equal(unavailable.status, 404);
    await unavailable.body.cancel();
  } finally {
    if (server) await closeServer(server);
    await rm(root, { recursive: true, force: true });
  }
});
