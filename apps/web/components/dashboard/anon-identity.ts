/**
 * The anonymous identity a D-102 visitor hash wears in the UI — a stable
 * name derived locally, never anything about the person. Shared by the
 * realtime board and the globe so the same hash is the same "Quiet Otter"
 * everywhere it appears.
 */

const ADJECTIVES = [
  "Gorgeous", "Quiet", "Brave", "Silent", "Amber", "Lucky", "Swift", "Calm",
  "Golden", "Misty", "Bold", "Gentle", "Vivid", "Mellow", "Nimble", "Wandering",
];
const ANIMALS = [
  "Wolf", "Falcon", "Otter", "Heron", "Lynx", "Marten", "Fox", "Ibis",
  "Puffin", "Badger", "Crane", "Stoat", "Osprey", "Dormouse", "Kestrel", "Seal",
];

/** Small stable hash — same visitor hash, same name, purely locally. */
export function hashCode(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function anonName(visitorHash: string): string {
  const code = hashCode(visitorHash);
  return `${ADJECTIVES[code % ADJECTIVES.length]} ${ANIMALS[(code >> 4) % ANIMALS.length]}`;
}
