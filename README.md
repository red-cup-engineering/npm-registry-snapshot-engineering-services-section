# npm-registry-snapshot-engineering-services-section

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Holds the registry snapshot services: assembly, verification, and activation of immutable registry snapshots. Use when producing or promoting a registry snapshot.

## Native source-artifact receiving prerequisite

This development selection uses the genuine current registry integrity owner and
read service. Assembly, verification and activation algorithms are unchanged.
Source and installed receiving are separate. Run
`node --test test/http-snapshot-receiving.test.mjs` to verify exact archive
delivery and refusal continuity over HTTP on loopback alone; it does not run
npm. The separately enrolled `test/npm11-offline-install.test.mjs` performs the
cold fixture lock/install receiving check; it needs Node 24+, npm 11 and tar.
Tests activate only disposable fixture snapshots, not a live registry.
Source/archive receiving does not grant activation authority, assert issued
registry availability or qualify the repository development graph.
