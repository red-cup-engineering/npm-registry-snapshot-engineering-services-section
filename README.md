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
