import assert from "node:assert/strict";
import test from "node:test";
import { isExactVersion, versionOrder } from "../scripts/package-version.mjs";

test("admits canonical prerelease and build identities without coercion", () => {
  for (const value of ["0.4.3-dev.0", "1.0.0-alpha.1", "1.0.0-0.3.7", "1.0.0-x-y-z.--", "1.0.0+001", "1.0.0-alpha+001", "0.0.0"]) assert.equal(isExactVersion(value), true, value);
  for (const value of [null, {}, 1, "", "1.2", "01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+", "1.2.3-", "v1.2.3", "=1.2.3", " 1.2.3", "1.2.3\n", "^1.2.3", "1.2.3/../x", "1.2.3-α"]) assert.equal(isExactVersion(value), false, String(value));
});

test("orders the SemVer precedence example and deterministic build ties", () => {
 const expected = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.0+a", "1.0.0+b", "1.0.1-dev.0"];
 assert.deepEqual([...expected].reverse().sort(versionOrder), expected);
 assert.ok(versionOrder("1.0.0-dev.9", "1.0.0-dev.10") < 0);
});
