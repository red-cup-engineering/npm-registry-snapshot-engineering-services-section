import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPackageRegistryServer, closeServer, listen } from '@red-cup-engineering/npm-registry-read-service';
import { assemblePackageRegistrySnapshot } from '../scripts/assemble-package-registry-snapshot.mjs';
import { verifyPackageRegistrySnapshot } from '../scripts/verify-package-registry-snapshot.mjs';
import { activateVerifiedPackageRegistrySnapshot } from '../scripts/activate-verified-package-registry-snapshot.mjs';

const canonicalOrigin = 'https://snapshot.fixture.invalid/';
const integrityOf = bytes => 'sha512-'+createHash('sha512').update(bytes).digest('base64');
async function fixture(root) {
  const packageDirectory = join(root, 'package-source');
  await mkdir(packageDirectory);
  const manifest = { name:'@fixture/carrier', version:'0.1.0-dev.0', type:'module',
    os:['linux'], exports:'./entry.mjs', files:['entry.mjs'] };
  await writeFile(join(packageDirectory,'package.json'),JSON.stringify(manifest));
  await writeFile(join(packageDirectory,'entry.mjs'),'export const packageIdentity = () => "@fixture/carrier@0.1.0-dev.0";\n');
  const [packed]=JSON.parse(execFileSync('npm', ['pack','.','--offline','--ignore-scripts','--json',
    '--cache',join(root,'npm-cache'),'--pack-destination',root],{cwd:packageDirectory,encoding:'utf8',timeout:30000}));
  assert.match(packed.filename,/^[a-z0-9][a-z0-9._-]*\.tgz$/u);
  const artifactPath=join(root,packed.filename), bytes=await readFile(artifactPath);
  const integrity=integrityOf(bytes);
  assert.equal(packed.integrity,integrity);
  return { manifest, artifactPath, integrity, bytes };
}

test('the Snapshot and Reader deliver the exact npm archive and refuse a divergent compatibility catalogue', async t=>{
  const root=await mkdtemp(join(tmpdir(),'snapshot-actual-archive-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const release=await fixture(root);
  const { manifest, bytes, integrity }=release;
  const snapshots=join(root,'snapshots'), qualified=join(snapshots,'received'), candidate=join(snapshots,'candidate');
  await mkdir(snapshots);
  await assemblePackageRegistrySnapshot({ releases:[release], outputDirectory:qualified, registryUrl:canonicalOrigin });
  const verification=await verifyPackageRegistrySnapshot({ registryDirectory:qualified });
  assert.deepEqual(verification.releases,[`${manifest.name}@${manifest.version}`]);
  assert.equal((await activateVerifiedPackageRegistrySnapshot({
    hostDirectory:root,candidate:{name:'received',verification},
  })).activated,true);

  const current=join(root,'current'), server=createPackageRegistryServer({registryDirectory:current});
  await listen(server,{host:'127.0.0.1',port:0});
  try {
    const registry=new URL(`http://127.0.0.1:${server.address().port}/`);
    const receive=path=>fetch(new URL(path,registry),{redirect:'error',signal:AbortSignal.timeout(5000)});
    const metadata=await receive(encodeURIComponent(manifest.name));
    assert.equal(metadata.status,200);
    const catalogue=await metadata.json(), version=catalogue.versions[manifest.version];
    const expectedTarball=new URL(`@fixture/carrier/-/carrier-${manifest.version}.tgz`,registry).href;
    assert.equal(version.dist.tarball,expectedTarball);
    assert.equal(version.dist.integrity,integrity);
    const res=await receive(version.dist.tarball);
    assert.equal(res.status,200);
    assert.equal(res.headers.get('content-length'),String(bytes.length));
    const got=Buffer.from(await res.arrayBuffer());
    assert.deepEqual(got,bytes);
    assert.equal(integrityOf(got),integrity);

    // Receive the exact HTTP bytes in a clean Node consumer.
    const downloaded=join(root,'received.tgz'), consumer=join(root,'consumer');
    const installed=join(consumer,'node_modules',...manifest.name.split('/'));
    await writeFile(downloaded,got);
    await mkdir(installed,{recursive:true});
    execFileSync('tar',['--extract','--gzip','--file',downloaded,'--directory',installed,
      '--strip-components=1','--no-same-owner','--no-same-permissions'],{timeout:10000});
    execFileSync(process.execPath,['--input-type=module','--eval',
      "import assert from 'node:assert/strict'; import {packageIdentity} from '@fixture/carrier'; assert.equal(packageIdentity(),'@fixture/carrier@0.1.0-dev.0');"],
    {cwd:consumer,timeout:10000});

    // A candidate's changed compatibility declaration is not the archive that
    // its unchanged integrity measures. Verification happens before activation.
    await cp(qualified,candidate,{recursive:true});
    const path=join(candidate,'metadata',encodeURIComponent(manifest.name)+'.json');
    const divergent=JSON.parse(await readFile(path,'utf8'));
    divergent.versions[manifest.version].os=['darwin'];
    await writeFile(path,JSON.stringify(divergent));
    await assert.rejects(verifyPackageRegistrySnapshot({registryDirectory:candidate}),error=>
      error.defects?.some(item=>item.code==='ARTIFACT_MANIFEST_REFUSED'&&item.reason==='NPM_ARCHIVE_COMPATIBILITY_MISMATCH')===true);
    assert.equal(await readlink(current),'snapshots/received');
    const retained=await receive(expectedTarball);
    assert.equal(retained.status,200);
    assert.deepEqual(Buffer.from(await retained.arrayBuffer()),bytes);
  } finally { await closeServer(server); }
});
