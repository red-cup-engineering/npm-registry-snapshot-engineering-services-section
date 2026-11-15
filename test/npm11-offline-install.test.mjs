import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { createPackageRegistryServer, closeServer, listen } from "@red-cup-engineering/npm-registry-read-service";
import { assemblePackageRegistrySnapshot } from "../scripts/assemble-package-registry-snapshot.mjs";
import { npmPackageFixture } from "./support/npm-package-fixture.mjs";

const run = promisify(execFile);

async function fixtureTarball(root, manifest) {
  const entrypointSource = manifest.dependencies
    ? 'export { admitted } from "plain-provider";\n'
    : 'export const admitted = "plain-provider@2.0.0-dev.0";\n';
  const bytes = npmPackageFixture(manifest, "", { entrypointSource });
  const artifactPath = join(root, `${manifest.name.replaceAll("@", "").replaceAll("/", "-")}-${manifest.version}.tgz`);
  await writeFile(artifactPath, bytes);
  return { manifest, artifactPath, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

const snapshotRegistryUrl = "https://snapshot.fixture.invalid/";

function expectedTarballPath({ name, version }) {
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

async function withReader(assay) {
  await withSnapshot(async ({ root, registryDirectory, releases }) => {
    const server = createPackageRegistryServer({ registryDirectory });
    await listen(server, { host: "127.0.0.1", port: 0 });
    try {
      const registry = `http://127.0.0.1:${server.address().port}/`;
      await assay({ root, registry, releases });
    } finally { await closeServer(server); }
  });
}

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

test("snapshot and read owners drive two cold npm 11 locks and a cold npm ci against the fixture registry", async () => {
  assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "native integration requires Node >=24");
  const npmVersion = (await run("npm", ["--version"])).stdout.trim();
  assert.equal(Number(npmVersion.split(".")[0]), 11, "native integration requires npm 11");
  await withReader(async ({ root, registry, releases }) => {
    const consumer = join(root, "consumer");
    await mkdir(consumer);
    await writeFile(join(consumer, "package.json"), `${JSON.stringify({ name: "consumer", version: "1.0.0-dev.0", private: true, dependencies: { "@customer/provider": "1.0.0-dev.0" } })}\n`);
    const config = join(root, "client.npmrc");
    await writeFile(config, `registry=${registry}\n@customer:registry=${registry}\naudit=false\nfund=false\n`);
    const environment = {
      PATH: process.env.PATH, HOME: root, NPM_CONFIG_USERCONFIG: config,
      NPM_CONFIG_GLOBALCONFIG: join(root, "empty-global.npmrc"), TMPDIR: root,
    };
    await writeFile(environment.NPM_CONFIG_GLOBALCONFIG, "");
    const common = ["--ignore-scripts", "--no-audit", "--no-fund", "--fetch-retries=0", `--registry=${registry}`, `--@customer:registry=${registry}`];
    const runNpm = (args, phase) => run("npm", [...args, ...common], {
      cwd: consumer, env: { ...environment, NPM_CONFIG_CACHE: join(root, `cache-${phase}`) }, timeout: 30_000,
    });
    const lockPath = join(consumer, "package-lock.json");
    await runNpm(["install", "--package-lock-only"], "first-lock");
    const first = await readFile(lockPath);
    await rm(lockPath);
    await runNpm(["install", "--package-lock-only"], "second-lock");
    assert.deepEqual(await readFile(lockPath), first);
    const { packages } = JSON.parse(first);
    assert.deepEqual(Object.keys(packages).sort(), ["", ...releases.map(({ manifest }) => `node_modules/${manifest.name}`).sort()]);
    for (const { manifest, integrity } of releases) {
      const record = packages[`node_modules/${manifest.name}`];
      assert.equal(record.version, manifest.version);
      assert.equal(record.resolved, new URL(expectedTarballPath(manifest), registry).href);
      assert.equal(record.integrity, integrity);
      assert.equal(record.link, undefined);
    }
    await runNpm(["ci"], "install");
    assert.deepEqual(await readFile(lockPath), first);
    for (const { manifest } of releases) {
      const installed = JSON.parse(await readFile(join(consumer, "node_modules", manifest.name, "package.json"), "utf8"));
      assert.equal(installed.name, manifest.name);
      assert.equal(installed.version, manifest.version);
    }
    await writeFile(join(consumer, "receive.mjs"), `
      import assert from "node:assert/strict";
      import { admitted } from "@customer/provider";
      assert.equal(admitted, "plain-provider@2.0.0-dev.0");
    `);
    await run(process.execPath, ["receive.mjs"], { cwd: consumer, env: environment, timeout: 10_000 });
  });
});
