function rank(snapshot) {
  let score = 0;
  const fields = snapshot.fields || [];
  if (fields.length) score += 100 + fields.length * 3;
  if (snapshot.apply) score += 40;
  if (snapshot.submit) score += 40;
  if ((snapshot.job?.description || "").length > 180) score += 30;
  if (snapshot.listings?.length) score += Math.min(snapshot.listings.length, 20);
  if (snapshot.captcha) score += 15;
  if (snapshot.isTop) score += 1;
  return score;
}

export function pickSnapshot(snapshots) {
  const usable = (snapshots || []).filter((snapshot) => snapshot && !snapshot.error);
  if (!usable.length) return null;
  const confirmation = usable.find((snapshot) => snapshot.confirmation);
  if (confirmation) return confirmation;
  return usable.slice().sort((a, b) => rank(b) - rank(a))[0];
}

export function mergeSnapshots(snapshots) {
  const usable = (snapshots || []).filter(Boolean);
  const picked = pickSnapshot(usable);
  if (!picked) return null;
  const seen = new Set();
  const listings = [];
  for (const snapshot of usable) {
    for (const listing of snapshot.listings || []) {
      const key = listing.url || `${listing.title}|${listing.company}`;
      if (seen.has(key)) continue;
      seen.add(key);
      listings.push(listing);
    }
  }
  const formFrame = usable.find((snapshot) => (snapshot.fields || []).length);
  return {
    ...picked,
    frameId: formFrame?.frameId ?? picked.frameId,
    fields: formFrame?.fields?.length ? formFrame.fields : picked.fields || [],
    apply: picked.apply || usable.find((snapshot) => snapshot.apply)?.apply || null,
    submit: formFrame?.submit || picked.submit || null,
    next: formFrame?.next || picked.next || usable.find((snapshot) => snapshot.next)?.next || null,
    captcha: usable.some((snapshot) => snapshot.captcha),
    captchaDetail: usable.find((snapshot) => snapshot.captchaDetail)?.captchaDetail || null,
    loginWall: usable.some((snapshot) => snapshot.loginWall) && !usable.some((snapshot) => (snapshot.fields || []).length),
    listings,
  };
}
