# npm-registry-snapshot-engineering-services-section

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Holds the registry snapshot services: assembly, verification, and activation of immutable registry snapshots. Use when producing or promoting a registry snapshot.

## Receiving a frozen npm dependency graph

Run `npm test` with Node 24 and npm 11. The test creates two real npm archives
offline, including a carrier that imports a transitive supplier. It verifies and
selects a disposable snapshot, reads the exact archive bytes through the
Registry Reader on loopback, and resolves an npm lockfile only against that
listener. A fresh consumer runs `npm ci --ignore-scripts` with an empty cache.
The lockfile must retain both exact versions, URLs and SHA-512 integrities; the
Reader must actually receive a request for each archive. The installed entry
point must then use its transitive supplier under Node.

Verification must refuse a staged catalogue whose platform declaration differs
from its measured archive. The selected snapshot must remain available. The
test does not acquire external packages, select a live snapshot, or certify
that the Snapshot's installed Registry supplier versions have been issued.


## Receiving issuer publication times

A supplied release may carry `publicationMetadata: { registry, packument }`,
where `packument` is the caller's original issuer observation. Assembly requires
its exact package name, version, SHA-512 integrity and `time[version]` to bind
the same admitted archive. Only that per-version timestamp is projected into
the snapshot catalogue. No time is manufactured from Git history, file
modification, or the moment of assembly. The caller owns issuer authentication;
offline assembly verifies the binding, not the logging-in or acquisition step.

A merge retains an existing release's timestamp, refuses conflicting evidence,
and removes time for an excluded release. Verification joins catalogue time
to the release receipt before selection. A version with no issuer observation
remains undated. When called with `requireCompletePublicationMetadataFor`,
the Snapshot refuses absent packages or missing time for **any** offered
version of the named packages, and retains that requirement on merges.
Use this for the application's authored release-age scope: some pnpm versions
can proceed with an incomplete time map rather than making a reliable age
decision. Do not invent dates or add exceptions to make an install pass.

Run `npm run test:publication-age` with native pnpm 11 available. It runs native
lock generation and frozen receiving against the Snapshot's existing Reader on
loopback; the dates in its synthetic packages are fixture data only.
