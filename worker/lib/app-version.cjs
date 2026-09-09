// Desktop marketing/package versions are numeric build identifiers, not Codex runtime SemVer.
const validAppVersion = (v) => typeof v === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(v) && v.length <= 64 && v.split('.').every((p) => Number.isSafeInteger(Number(p)));
function compare(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0); if (diff) return Math.sign(diff);
  }
  return 0;
}
const validAppRange = (v) => v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).length === 2 && validAppVersion(v.min) && validAppVersion(v.maxExclusive) && compare(v.min, v.maxExclusive) < 0;
const matchesAppRange = (version, range) => validAppVersion(version) && compare(version, range.min) >= 0 && compare(version, range.maxExclusive) < 0;
module.exports = { validAppVersion, validAppRange, matchesAppRange };
