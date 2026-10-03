// בדיקות לסורק המניות הספקולטיביות — הרצה: node --test speculative-screener.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("./speculative-screener.js");

// ── מחוללי נתונים ──

function dateAt(i) {
  const d = new Date("2026-03-02T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}

// מניה "חיה": גלים סינוסיים סביב בסיס יציב
function wavyCandles({ n = 130, base = 2, amp = 0.25, period = 20, vol = 400000 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = base * (1 + amp * Math.sin((2 * Math.PI * i) / period));
    out.push({ date: dateAt(i), o: c, h: c * 1.01, l: c * 0.99, c, v: vol });
  }
  return out;
}

// מניה מתה: שטוחה עם ספייק בודד שנמחק (בדומה ל-NXGB)
function deadWithSpike({ n = 130, base = 0.0004, vol = 20000000, spikeAt = 40 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let c = base;
    if (i === spikeAt) c = base * 3.5;
    if (i === spikeAt + 1) c = base * 2;
    if (i === spikeAt + 2) c = base * 1.2;
    out.push({ date: dateAt(i), o: c, h: c, l: c, c, v: i === spikeAt ? vol * 15 : vol });
  }
  return out;
}

// ── עיגול ──

test("roundPrice שומר דיוק במניות של שבריר סנט", () => {
  assert.equal(S.roundPrice(0.0015), 0.0015);
  assert.equal(S.roundPrice(0.00149999), 0.0015);
  assert.equal(S.roundPrice(0.0234567), 0.0235);
  assert.equal(S.roundPrice(3.14159), 3.14);
});

// ── סיווג מסלול ──

test("classifyTrack מפריד בין בורסה ל-OTC", () => {
  assert.equal(S.classifyTrack({ exchange: "PINK.OTCID", price: 0.0015 }), "otc");
  assert.equal(S.classifyTrack({ exchange: "NASDAQ", price: 2.4 }), "small_cap");
  assert.equal(S.classifyTrack({ exchange: "NASDAQ", price: 12 }), null);
  assert.equal(S.classifyTrack({ exchange: "NYSE", price: 0.3 }), null);
});

test("tickPct: צעד אחד ב-0.0015 שווה כ-6.67%", () => {
  assert.equal(Math.round(S.tickPct(0.0015) * 100) / 100, 6.67);
  assert.equal(S.tickPct(2), 0.5);
});

// ── נזילות ──

test("liquidityProfile מזהה מרווח רחב וקיר היצע (צילום NXGB)", () => {
  const candles = deadWithSpike();
  const quote = { bid: 0.0014, ask: 0.0015, bidSize: 45000, askSize: 1020000 };
  const liq = S.liquidityProfile(candles, quote, "otc");
  assert.equal(liq.spreadPct, 6.9);
  assert.ok(liq.askBidSizeRatio > 20);
  assert.ok(liq.flags.some((f) => f.code === "ask_wall"));
  assert.ok(!liq.flags.some((f) => f.code === "wide_spread"), "6.9% עדיין מתחת לרף 10% של OTC");
});

test("מרווח רחב מעל הרף = פסילה", () => {
  const candles = deadWithSpike();
  const liq = S.liquidityProfile(candles, { bid: 0.0003, ask: 0.0005 }, "otc");
  assert.ok(liq.flags.some((f) => f.code === "wide_spread" && f.severity === "hard"));
});

// ── דילול ──

test("dilutionProfile מחשב גידול במספר המניות", () => {
  const d = S.dilutionProfile({
    sharesHistory: [
      { date: "2025-10-01", shares: 400e6 },
      { date: "2026-04-01", shares: 460e6 },
      { date: "2026-09-30", shares: 941e6 },
    ],
    authorizedShares: 5e9,
  }, new Date("2026-10-04"));
  assert.equal(d.known, true);
  assert.equal(d.dilution6mPct, 104.57);
  assert.ok(d.headroomPct > 400);
});

// ── חדשות ──

test("classifyNewsItem מבדיל מהותי / הייפ / דילול / שלילי", () => {
  assert.equal(S.classifyNewsItem({ title: "Company Signs Definitive Agreement and Closes Acquisition" }).category, "material");
  assert.equal(S.classifyNewsItem({ title: "NxGen Launches $CAND Token Airdrop on Solana" }).category, "hype");
  assert.equal(S.classifyNewsItem({ title: "Company Nearing Completion of Strategic Acquisition" }).category, "hype");
  assert.equal(S.classifyNewsItem({ title: "Company Announces $5M Registered Direct Offering" }).category, "dilutive");
  assert.equal(S.classifyNewsItem({ title: "Company Receives Nasdaq Deficiency Notice" }).category, "negative");
  assert.equal(S.classifyNewsItem({ title: "Quarterly webinar scheduled" }).category, "neutral");
});

// ── עקביות ──

test("מניה גלית מזוהה כ'חיה' עם ציון עקביות גבוה", () => {
  const c = S.consistencyProfile(wavyCandles(), "small_cap");
  assert.equal(c.isLiving, true);
  assert.ok(c.upSwings >= 3 && c.downSwings >= 3);
  assert.equal(c.baseHolding, true);
  assert.ok(c.score >= 80, `ציון ${c.score}`);
});

test("מניה מתה עם ספייק בודד מקבלת ציון עקביות נמוך", () => {
  const c = S.consistencyProfile(deadWithSpike(), "otc");
  assert.equal(c.isLiving, false);
  assert.ok(c.spikeDominance > 0.5);
  assert.equal(c.fadedSpikes, 1);
  assert.ok(c.score < 40, `ציון ${c.score}`);
});

test("zigzag מוצא נקודות מפנה מתחלפות", () => {
  const p = S.zigzag(wavyCandles(), 8);
  for (let i = 1; i < p.length; i++) assert.notEqual(p[i].type, p[i - 1].type);
});

// ── דגלים ──

test("ווליום חריג בלי חדשות = חשד למשאבה", () => {
  const candles = deadWithSpike({ spikeAt: 129 });
  const flags = S.redFlags({ track: "otc", candles, news: S.summarizeNews([]), dilution: { known: false } });
  assert.ok(flags.some((f) => f.code === "volume_no_news"));
});

test("חברה בלי דיווחים נפסלת", () => {
  const flags = S.redFlags({ track: "otc", fundamentals: { reportingStatus: "Pink Limited Information" }, dilution: { known: false } });
  assert.equal(S.riskScore(flags), 0);
});

// ── עלויות וגודל ──

test("sizePosition מוגבל ל-2% מהמחזור כשהמניה דלילה", () => {
  const s = S.sizePosition({ buyPrice: 0.0015, avgDollarVolume: 1000 });
  assert.equal(s.limitedBy, "מחזור");
  // 1000$ מחזור × 2% = 20$ תקציב, פחות 2.5$ עמלה = 17.5$ / 0.0015
  assert.equal(s.budget, 20);
  assert.equal(s.shares, 11666);
});

test("roundTripCostPct כולל מרווח ועמלות", () => {
  // מרווח 0.0014/0.0015 = 6.67% + עמלות 5$ על פוזיציה של 60$ = 8.33%
  const pct = S.roundTripCostPct({ buyPrice: 0.0015, sellPrice: 0.0014, positionValue: 60 });
  assert.equal(pct, 15);
});

// ── אותות ──

test("detectBaseBounce נדלק בתחתית גל כשהמחיר מתהפך למעלה", () => {
  // גל עם מחזור 40: תחתית בערך ביום 30 של כל מחזור. נחתוך קצת אחרי התחתית
  const all = wavyCandles({ n: 200, period: 40, amp: 0.3 });
  let found = false;
  for (let end = 80; end <= 200; end++) {
    const sig = S.detectBaseBounce(all.slice(0, end));
    if (sig && sig.triggered) {
      found = true;
      assert.ok(sig.stop < sig.rangeLow);
      assert.ok(sig.target > all[end - 1].c);
      break;
    }
  }
  assert.ok(found, "האות צריך להידלק לפחות פעם אחת בתחתית גל");
});

test("detectNewsFollowthrough דורש חדשות מהותיות ולא הייפ", () => {
  const candles = wavyCandles({ n: 80, amp: 0.02 });
  const prevC = candles[77].c;
  candles[78] = { ...candles[78], c: prevC * 1.4, h: prevC * 1.45, v: 400000 * 6 };
  candles[79] = { ...candles[79], c: prevC * 1.3, h: prevC * 1.35, v: 400000 * 2 };
  const material = S.summarizeNews([{ title: "Company Awarded $20M Government Contract" }]);
  const hype = S.summarizeNews([{ title: "Company Exploring AI Blockchain Roadmap" }]);
  assert.equal(S.detectNewsFollowthrough(candles, material).triggered, true);
  assert.equal(S.detectNewsFollowthrough(candles, hype).triggered, false);
});

// ── הערכה מלאה ──

test("evaluateCandidate: מקרה בסגנון NXGB לא נכנס לתיק", () => {
  const r = S.evaluateCandidate({
    symbol: "NXGB",
    exchange: "PINK.OTCID",
    candles: deadWithSpike(),
    quote: { bid: 0.0014, ask: 0.0015, bidSize: 45000, askSize: 1020000 },
    fundamentals: { businessPivots24m: 3 },
    news: [{ title: "NxGen Brands Launches Community Token $CAND on Raydium Launchpad" }],
  });
  assert.equal(r.track, "otc");
  assert.notEqual(r.verdict, "paper_entry");
  assert.ok(r.flags.some((f) => f.code === "pivots"));
  assert.ok(r.score < 7.5);
});

test("evaluateCandidate: מניה קטנה גלית ונזילה עם אות מקבלת תוכנית", () => {
  // גל עם בסיס שטוח: מתבסס בתחתית ואז עולה — הצורה שהאות מחפש
  const all = [];
  for (let i = 0; i < 200; i++) {
    const s = Math.sin((2 * Math.PI * i) / 30);
    const noise = s < -0.3 ? (i % 2 ? 0.004 : -0.004) : 0;
    const c = 2 * (1 + 0.3 * Math.max(s, -0.3) + noise);
    all.push({ date: dateAt(i), o: c, h: c * 1.01, l: c * 0.99, c, v: 2000000 });
  }
  let r = null;
  for (let end = 80; end <= 200; end++) {
    const res = S.evaluateCandidate({
      symbol: "WAVE", exchange: "NASDAQ", candles: all.slice(0, end),
      quote: { bid: all[end - 1].c * 0.998, ask: all[end - 1].c * 1.002 },
      fundamentals: { sharesHistory: [{ date: "2026-01-01", shares: 50e6 }, { date: "2026-09-01", shares: 51e6 }] },
    }, {}, new Date("2026-10-04"));
    if (res.verdict === "paper_entry") { r = res; break; }
  }
  assert.ok(r, "צריכה להיווצר כניסה מדומה בתחתית גל, אחרי שהמניה הוכיחה גלים");
  assert.equal(r.track, "small_cap");
  assert.ok(r.plan.shares > 0);
  assert.ok(r.plan.roundTripCostPct < 8);
  assert.equal(r.verdict, "paper_entry", r.reasons.join(" | "));
});

test("formatReportHe מפריד מסלולים ומסיים בהסתייגות", () => {
  const a = S.evaluateCandidate({ symbol: "NXGB", exchange: "OTC", candles: deadWithSpike() });
  const b = S.evaluateCandidate({ symbol: "WAVE", exchange: "NASDAQ", candles: wavyCandles() });
  const txt = S.formatReportHe([a, b]);
  assert.ok(txt.includes("מניות קטנות בבורסה"));
  assert.ok(txt.includes("מחוץ לבורסה (OTC)"));
  assert.ok(txt.includes("NXGB") && txt.includes("WAVE"));
  assert.ok(txt.trim().endsWith("לא ייעוץ השקעות."));
});

test("רעש של צעד מחיר אחד בשבריר סנט לא נספר כגל", () => {
  const candles = [];
  for (let i = 0; i < 130; i++) {
    const c = i % 2 ? 0.0003 : 0.0002; // קפיצות של 50% שהן בסך הכל צעד אחד
    candles.push({ date: dateAt(i), o: c, h: c, l: c, c, v: 1e7 });
  }
  const c = S.consistencyProfile(candles, "otc");
  assert.equal(c.swingCount, 0);
  assert.equal(c.isLiving, false);
});
