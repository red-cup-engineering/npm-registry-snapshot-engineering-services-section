import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createPackageRegistryServer, closeServer, listen } from '@red-cup-engineering/npm-registry-read-service';
import { assemblePackageRegistrySnapshot } from '../scripts/assemble-package-registry-snapshot.mjs';
import { verifyPackageRegistrySnapshot } from '../scripts/verify-package-registry-snapshot.mjs';
import { activateVerifiedPackageRegistrySnapshot } from '../scripts/activate-verified-package-registry-snapshot.mjs';

const canonicalOrigin = 'https://snapshot.fixture.invalid/';
const integrityOf = bytes => 'sha512-'+createHash('sha512').update(bytes).digest('base64');
const runFile = promisify(execFile);
async function packFixture(root, manifest, source) {
  const packageDirectory = join(root, manifest.name.split('/').at(-1)+'-source');
  await mkdir(packageDirectory);
  await writeFile(join(packageDirectory,'package.json'),JSON.stringify(manifest));
  await writeFile(join(packageDirectory,'entry.mjs'),source);
  const [packed]=JSON.parse(execFileSync('npm', ['pack','.','--offline','--ignore-scripts','--json',
    '--cache',join(root,'npm-cache'),'--pack-destination',root],{cwd:packageDirectory,encoding:'utf8',timeout:30000}));
  assert.match(packed.filename,/^[a-z0-9][a-z0-9._-]*\.tgz$/u);
  const artifactPath=join(root,packed.filename), bytes=await readFile(artifactPath);
  const integrity=integrityOf(bytes);
  assert.equal(packed.integrity,integrity);
  return { manifest, artifactPath, integrity, bytes };
}
async function receiveFrozenGraph(root, registry, releases, server) {
  const resolver=join(root,'resolver'), consumer=join(root,'consumer'), userConfig=join(root,'user.npmrc');
  const globalConfig=join(root,'global.npmrc');
  await Promise.all([mkdir(resolver),mkdir(consumer),writeFile(userConfig,''),writeFile(globalConfig,'')]);
  const manifest={name:'snapshot-fixture-consumer',version:'1.0.0',private:true,
    dependencies:{'@fixture/carrier':'0.1.0-dev.0'}};
  await writeFile(join(resolver,'package.json'),JSON.stringify(manifest));
  // The child cannot inherit registry credentials or scope routing. The only
  // requested registry is the current test's ephemeral loopback listener.
  const env={PATH:process.env.PATH,HOME:root};
  const npm=(args,cwd,cacheName)=>runFile('npm',[...args,'--registry',registry.href,'--cache',join(root,cacheName),
    '--userconfig',userConfig,'--globalconfig',globalConfig,'--ignore-scripts','--no-audit','--no-fund',
    '--fetch-retries=0','--fetch-timeout=5000'],{cwd,env,timeout:30000});
  await npm(['install','--package-lock-only'],resolver,'resolver-cache');
  const lockBytes=await readFile(join(resolver,'package-lock.json'));
  const lock=JSON.parse(lockBytes);
  assert.deepEqual(Object.keys(lock.packages).filter(Boolean).sort(),
    releases.map(({manifest})=>'node_modules/'+manifest.name).sort());
  for(const {manifest,integrity} of releases) {
    const leaf=manifest.name.split('/').at(-1);
    const entry=lock.packages['node_modules/'+manifest.name];
    assert.equal(entry.version,manifest.version);
    assert.equal(entry.integrity,integrity);
    assert.equal(entry.resolved,new URL(manifest.name+'/-/'+leaf+'-'+manifest.version+'.tgz',registry).href);
  }
  await writeFile(join(consumer,'package.json'),JSON.stringify(manifest));
  await writeFile(join(consumer,'package-lock.json'),lockBytes);
  const downloaded=new Set();
  const observe=req=>{ if(req.method==='GET') downloaded.add(req.url); };
  server.on('request',observe);
  try { await npm(['ci'],consumer,'clean-install-cache'); }
  finally { server.off('request',observe); }
  for(const {resolved} of Object.values(lock.packages).filter(item=>item.resolved)) {
    assert.ok(downloaded.has(new URL(resolved).pathname),`npm ci did not receive ${resolved}`);
  }
  assert.deepEqual(await readFile(join(consumer,'package-lock.json')),lockBytes);
  await runFile(process.execPath,['--input-type=module','--eval',
    "import assert from 'node:assert/strict'; import {packageIdentity} from '@fixture/carrier'; assert.equal(packageIdentity(),'@fixture/carrier@0.1.0-dev.0');"],
    {cwd:consumer,env,timeout:10000});
}

test('the Snapshot and Reader support a cold frozen npm install and refuse a divergent catalogue', async t=>{
  const root=await mkdtemp(join(tmpdir(),'snapshot-actual-archive-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const common={version:'0.1.0-dev.0',type:'module',exports:'./entry.mjs',files:['entry.mjs']};
  const supplier=await packFixture(root,{...common,name:'@fixture/supplier'},"export const label = 'carrier';\n");
  const release=await packFixture(root,{...common,name:'@fixture/carrier',os:[process.platform],
    dependencies:{[supplier.manifest.name]:supplier.manifest.version},
    scripts:{install:'node -e "process.exitCode = 17"'}},
  "import {label} from '@fixture/supplier'; export const packageIdentity = () => '@fixture/' + label + '@0.1.0-dev.0';\n");
  const { manifest, bytes, integrity }=release;
  const snapshots=join(root,'snapshots'), qualified=join(snapshots,'received'), candidate=join(snapshots,'candidate');
  await mkdir(snapshots);
  await assemblePackageRegistrySnapshot({ releases:[release,supplier], outputDirectory:qualified, registryUrl:canonicalOrigin });
  const verification=await verifyPackageRegistrySnapshot({ registryDirectory:qualified });
  assert.deepEqual(verification.releases,[release,supplier].map(({manifest})=>`${manifest.name}@${manifest.version}`));
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

    // A clean npm consumer must receive the exact graph, including a real
    // transitive dependency and its measured integrity, from this same Reader.
    await receiveFrozenGraph(root,registry,[release,supplier],server);

    // A candidate's changed compatibility declaration is not the archive that
    // its unchanged integrity measures. Verification happens before activation.
    await cp(qualified,candidate,{recursive:true});
    const path=join(candidate,'metadata',encodeURIComponent(manifest.name)+'.json');
    const divergent=JSON.parse(await readFile(path,'utf8'));
    divergent.versions[manifest.version].os=[process.platform==='darwin'?'linux':'darwin'];
    await writeFile(path,JSON.stringify(divergent));
    await assert.rejects(verifyPackageRegistrySnapshot({registryDirectory:candidate}),error=>
      error.defects?.some(item=>item.code==='ARTIFACT_MANIFEST_REFUSED'&&item.reason==='NPM_ARCHIVE_COMPATIBILITY_MISMATCH')===true);
    assert.equal(await readlink(current),'snapshots/received');
    const retained=await receive(expectedTarball);
    assert.equal(retained.status,200);
    assert.deepEqual(Buffer.from(await retained.arrayBuffer()),bytes);
  } finally { await closeServer(server); }
});
