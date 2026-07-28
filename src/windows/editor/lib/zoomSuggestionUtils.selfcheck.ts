/** Selfcheck: click clusters to suggested zoom windows. */

function buildClickClusters(
  clicks: { t: number; x: number; y: number }[],
  mergeGapSec: number,
): Array<{ first: number; last: number }> {
  if (clicks.length === 0) return [];
  const sorted = [...clicks].sort((a, b) => a.t - b.t);
  const out: Array<{ first: number; last: number }> = [];
  let first = sorted[0]!.t;
  let last = sorted[0]!.t;
  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i]!.t;
    if (t - last <= mergeGapSec) {
      last = Math.max(last, t);
    } else {
      out.push({ first, last });
      first = t;
      last = t;
    }
  }
  out.push({ first, last });
  return out;
}

const clicks = [
  { t: 1, x: 0.2, y: 0.3 },
  { t: 1.4, x: 0.21, y: 0.31 },
  { t: 8, x: 0.7, y: 0.6 },
];
const clusters = buildClickClusters(clicks, 2.5);
console.assert(clusters.length === 2, "two clusters");
console.assert(clusters[0]!.first === 1 && clusters[0]!.last === 1.4, "cluster 0");
console.assert(clusters[1]!.first === 8 && clusters[1]!.last === 8, "cluster 1");

const lonely = buildClickClusters([{ t: 3, x: 0.5, y: 0.5 }], 2.5);
console.assert(lonely.length === 1, "single click");

console.log("zoomSuggestionUtils.selfcheck: ok");
