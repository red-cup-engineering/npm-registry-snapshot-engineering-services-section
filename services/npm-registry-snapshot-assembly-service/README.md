# npm registry snapshot assembly service

Assembles one immutable, npm registry snapshot from caller-supplied
release manifests, SHA-512 integrity claims, and tarball files. It
refuses any artifact whose measured bytes differ from the admitted integrity.
It owns tarball coordinates,
packuments, `latest` tags, `client.npmrc`, the v2 registry receipt, optional
base-snapshot merge/exclusions, and final snapshot admission.

Admission rejects a receipt or packument metadata file that is symbolic,
non-regular, outside the snapshot root after canonicalization, or named outside
the top-level metadata layout. This keeps the verified snapshot a
closed artifact rather than a view through host filesystem links.

It deliberately does **not** discover source packages, read or project source
manifests/carriers, run `npm pack`, serve HTTP, activate a snapshot, or choose
and coordinate releases. Callers supply already-made release artifacts and any
release-coordination receipt facts.

Every generated client configuration sends both scoped and unscoped package
requests only to the snapshot. There is no npmjs or other ambient fallback.

`assemblePackageRegistrySnapshot({ releases, outputDirectory, registryUrl,
baseRegistryDirectory, excludedBaseReleases, compute })` returns the
receipt only after `npm-registry-snapshot-verification-service` admits the
completed directory. Each release is
`{ manifest, artifactPath, integrity: "sha512-..." }`.
