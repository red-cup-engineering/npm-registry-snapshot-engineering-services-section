import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { expectedTarballPath, withReader } from "./support/registry-snapshot-receiving.mjs";

const run = promisify(execFile);

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
