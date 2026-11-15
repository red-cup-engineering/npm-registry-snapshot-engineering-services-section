import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createPackageRegistryServer, closeServer, listen } from '@red-cup-engineering/npm-registry-read-service';
import { assemblePackageRegistrySnapshot } from '../scripts/assemble-package-registry-snapshot.mjs';
import { verifyPackageRegistrySnapshot } from '../scripts/verify-package-registry-snapshot.mjs';

const run = promisify(execFile);
const issuer = 'https://issuer.fixture.invalid/';

function observed(release, publishedAt) {
  const { name, version } = release.manifest;
  return { ...release, publicationMetadata: { registry: issuer, packument: {
    name, time: { [version]: publishedAt }, versions: { [version]: {
      name, version, dist: { integrity: release.integrity },
    } },
  } } };
}

test('Snapshot and Reader retain measured version publication times for native pnpm age policy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-publication-age-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pack = async (name, version) => {
    const source = join(root, name.replace(/[@/]/gu, '-')+'-'+version);
    await mkdir(source);
    const manifest = { name, version, type: 'module', exports: './entry.mjs', files: ['entry.mjs'] };
    await writeFile(join(source, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(source, 'entry.mjs'), `export const installed = ${JSON.stringify(name+'@'+version)};\n`);
    const { stdout } = await run('npm', ['pack', '.', '--offline', '--ignore-scripts', '--json',
      '--cache', join(root, 'npm-cache'), '--pack-destination', root], { cwd: source, timeout: 30000 });
    const [report] = JSON.parse(stdout);
    return { manifest, artifactPath: join(root, report.filename), integrity: report.integrity };
  };
  const backed = await pack('dated-fixture', '1.0.0');
  const undated = await pack('dated-fixture', '1.0.1');
  const latest = await pack('young-fixture', '1.0.0');
  const house = await pack('@fixture/house-age', '1.0.0');
  const agedAt = new Date(Date.now()-10*86400_000).toISOString(), today = new Date().toISOString();
  const aged = observed(backed, agedAt), young = observed(latest, today);
  const first = join(root, 'first'), merged = join(root, 'merged'), partial = join(root, 'partial');
  const initial = await assemblePackageRegistrySnapshot({ releases: [aged, young, house], outputDirectory: first, registryUrl: issuer,
    requireCompletePublicationMetadataFor: ['dated-fixture','young-fixture'] });
  const received = initial.packages.find(entry => entry.name === backed.manifest.name);
  assert.deepEqual(received.publication, { registry: issuer, publishedAt: agedAt });
  assert.equal(initial.packages.find(entry => entry.name === house.manifest.name).publication, undefined);
  await assemblePackageRegistrySnapshot({ releases: [backed], outputDirectory: merged,
    baseRegistryDirectory: first, registryUrl: issuer });
  await assert.rejects(assemblePackageRegistrySnapshot({ releases: [undated], outputDirectory: partial,
    baseRegistryDirectory: merged, registryUrl: issuer }), error =>
    error.defects?.some(fact => fact.code === 'REQUIRED_PUBLICATION_TIME_MISSING' &&
      fact.identity === 'dated-fixture@1.0.1') === true);
  assert.deepEqual(await readdir(partial), []);
  await assert.rejects(assemblePackageRegistrySnapshot({ releases: [], outputDirectory: join(root, 'required-absent'),
    registryUrl: issuer, requireCompletePublicationMetadataFor: ['dated-fixture'] }), error =>
    error.defects?.some(fact => fact.code === 'PUBLICATION_TIME_REQUIRED_PACKAGE_MISSING') === true);
  const metadataPath = join(merged, 'metadata', 'dated-fixture.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  assert.deepEqual(metadata.time, { '1.0.0': agedAt });

  const collision = join(root, 'collision');
  await assert.rejects(assemblePackageRegistrySnapshot({ releases: [observed(backed, today)],
    outputDirectory: collision, baseRegistryDirectory: merged, registryUrl: issuer }), /collides with admitted evidence/);
  assert.deepEqual(await readdir(collision), []);
  const mismatch = observed(backed, agedAt);
  mismatch.publicationMetadata.packument.versions['1.0.0'].dist.integrity = latest.integrity;
  await assert.rejects(assemblePackageRegistrySnapshot({ releases: [mismatch],
    outputDirectory: join(root, 'mismatch'), registryUrl: issuer }), /does not bind the exact archive/);
  await assert.rejects(assemblePackageRegistrySnapshot({ releases: [observed(backed, '2026-02-30T00:00:00.000Z')],
    outputDirectory: join(root, 'invalid'), registryUrl: issuer }), /no valid exact-version timestamp/);

  const server = createPackageRegistryServer({ registryDirectory: merged });
  await listen(server, { host: '127.0.0.1', port: 0 });
  t.after(() => closeServer(server));
  const base = target => `http://127.0.0.1:${target.address().port}/`;
  const packument = async target => (await fetch(base(target)+'dated-fixture', { signal: AbortSignal.timeout(4000) })).json();
  assert.deepEqual((await packument(server)).time, { '1.0.0': agedAt });

  const env = { PATH: process.env.PATH, HOME: root,
    NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: '/dev/null' };
  const install = async (target, label, dependency, except = []) => {
    const dir = join(root, 'consumer-'+label);
    await mkdir(dir);
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'snapshot-age-consumer', version: '1.0.0', type: 'module', private: true,
      dependencies: { [dependency]: '1.0.0' },
    }));
    const args = ['--ignore-scripts', '--fetch-retries=0', '--fetch-timeout=5000',
      `--registry=${base(target)}`, `--@fixture:registry=${base(target)}`,
      `--cache-dir=${join(dir,'metadata-cache')}`, `--store-dir=${join(dir,'store')}`,
      ...except.map(value=>`--config.minimumReleaseAgeExclude=${value}`),
      '--config.minimumReleaseAge=1440', '--config.minimumReleaseAgeStrict=true'];
    await run('pnpm', ['install','--lockfile-only',...args], { cwd: dir, env, timeout: 20000 });
    const lock = await readFile(join(dir, 'pnpm-lock.yaml'));
    await run('pnpm', ['install','--frozen-lockfile',...args], { cwd: dir, env, timeout: 20000 });
    assert.deepEqual(await readFile(join(dir, 'pnpm-lock.yaml')), lock);
    await run(process.execPath, ['--input-type=module','--eval',
      `import assert from 'node:assert/strict'; import {installed} from ${JSON.stringify(dependency)}; assert.equal(installed, ${JSON.stringify(dependency+'@1.0.0')});`],
    { cwd: dir, env, timeout: 5000 });
  };
  await install(server, 'aged', 'dated-fixture');
  const ageRefusal = error => /MATURE|RELEASE_AGE|publish time|minimumReleaseAge/iu.test(error.stderr + error.stdout);
  await assert.rejects(install(server, 'young', 'young-fixture'), ageRefusal);
  await install(server, 'house', '@fixture/house-age', ['@fixture/*']);

  metadata.time['1.0.0'] = today;
  await writeFile(metadataPath, JSON.stringify(metadata));
  await assert.rejects(verifyPackageRegistrySnapshot({ registryDirectory: merged }), error =>
    error.defects?.some(fact => fact.code === 'METADATA_PUBLICATION_TIME_MISMATCH') === true);
});
