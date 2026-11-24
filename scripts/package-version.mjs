import { parse, compare } from "semver";

/** Admit one canonical SemVer 2.0.0 identity, never a range or coerced spelling. */
export function isExactVersion(value) {
  if (typeof value !== "string") return false;
  const parsed = parse(value);
  if (parsed === null) return false;
  return value === `${parsed.version}${parsed.build.length ? `+${parsed.build.join(".")}` : ""}`;
}

/** SemVer precedence; lexical identity breaks build-metadata ties deterministically. */
export function versionOrder(left, right) {
  return compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
}
