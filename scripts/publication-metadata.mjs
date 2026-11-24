/** Join optional caller-received issuer metadata to one exact archive.
 * Assembly is offline. This validates the binding, not the caller's issuer
 * authentication; never substitute Git, tar, or assembly timestamps.
 */
export function receivePublicationMetadata(source, { manifest, integrity }) {
  if (source === undefined) return undefined;
  const { registry, packument } = source ?? {};
  const name = manifest.name, version = manifest.version;
  const timestamp = packument?.time && Object.hasOwn(packument.time, version) ? packument.time[version] : undefined;
  const record = packument?.versions && Object.hasOwn(packument.versions, version) ? packument.versions[version] : undefined;
  if (packument?.name !== name || record?.name !== name || record?.version !== version ||
      typeof record.dist?.integrity !== "string" || !record.dist.integrity.split(/\s+/u).includes(integrity))
    throw new Error(`issuer publication metadata does not bind the exact archive: ${name}@${version}`);
  const publication = { registry, publishedAt: timestamp };
  if (!validPublicationEvidence(publication))
    throw new Error(`issuer publication metadata has no valid exact-version timestamp: ${name}@${version}`);
  return publication;
}

export function validPublicationEvidence(evidence) {
  if (!evidence || Object.getPrototypeOf(evidence) !== Object.prototype ||
      Object.keys(evidence).sort().join(",") !== "publishedAt,registry") return false;
  const { registry, publishedAt } = evidence;
  try {
    const url = new URL(registry);
    if (url.protocol !== "https:" || url.href !== registry || url.username ||
        url.password || url.search || url.hash) return false;
    return typeof publishedAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(publishedAt) &&
      new Date(publishedAt).toISOString() === publishedAt;
  } catch { return false; }
}
