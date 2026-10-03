// ══════════════════════════════════════════════════════════════════════════
// סורק מניות ספקולטיביות — יהונתן חיים ניתוח שוק ההון
//
// שני מסלולים בדירוג נפרד:
//   1. מניות קטנות בבורסה (נאסד"ק / ניו יורק), 0.5–5 דולר
//   2. מניות מחוץ לבורסה (שוק ה-OTC / מניות "פני")
//
// המטרה היא לא להקדים חדשות (את זה אי אפשר לעשות בסריקה תקופתית), אלא:
//   א. לסנן מלכודות: דילול, חברות בלי דיווחים, משאבות, מרווחים בלתי סחירים
//   ב. לזהות מניות "חיות" — שזזות בגלים חוזרים, עם בסיס שלא נשחק
//   ג. לתת תוכנית כניסה/יציאה ריאלית, כולל עלות המרווח והעמלה
//
// מודול טהור (בלי קריאות רשת), בדיוק כמו paper-trading-engine.js:
// נטען בדפדפן (window.SpeculativeScreener) וב-Node (module.exports),
// ונבדק עם `node --test speculative-screener.test.js`.
//
// הערה חשובה: במניות של שבריר סנט אסור לעגל ל-2 ספרות (0.0015 → 0).
// לכן כל המחירים כאן מעוגלים לפי roundPrice ולא לפי round2.
// ══════════════════════════════════════════════════════════════════════════

const TRACKS = { SMALL_CAP: "small_cap", OTC: "otc" };

const TRACK_LABELS = {
  small_cap: "מניות קטנות בבורסה",
  otc: "מחוץ לבורסה (OTC)",
};

const OTC_EXCHANGES = ["OTC", "PINK", "OTCID", "OTCQB", "OTCQX", "OTCBB", "PNK", "EXPERT", "GREY", "OTCM"];

const DEFAULT_CONFIG = {
  small_cap: {
    minPrice: 0.5,
    maxPrice: 5,
    minAvgDollarVolume: 250000,   // מחזור יומי ממוצע מינימלי בדולרים
    maxSpreadPct: 2,              // מרווח קנייה/מכירה מקסימלי באחוזים
    maxTickPct: 2,                // כמה אחוזים "שווה" צעד מחיר אחד
    maxDilution6mPct: 25,         // גידול מקסימלי במספר המניות בחצי שנה
    swingThresholdPct: 8,         // גודל מינימלי לגל שנספר
    minSwingsEachWay: 3,          // לפחות 3 גלים לכל כיוון = מניה "חיה"
    entryThreshold: 7,            // ציון סופי מינימלי (מתוך 10) לכניסה מדומה
  },
  otc: {
    minPrice: 0.0001,
    maxPrice: 5,
    minAvgDollarVolume: 15000,
    maxSpreadPct: 10,
    maxTickPct: 10,
    maxDilution6mPct: 10,         // ב-OTC דילול הוא הסיכון מספר 1, לכן מחמירים
    swingThresholdPct: 20,
    minSwingsEachWay: 3,
    entryThreshold: 7.5,          // רף גבוה יותר בגלל הסיכון
  },
  sizing: {
    speculativeCapital: 1000,     // תיק מדומה נפרד לספקולציה, בגודל זהה לתיק המדומה הראשי
    maxPositionPct: 0.25,         // עד 25% בעסקה אחת. פחות מזה — העמלה השטוחה אוכלת את הרווח
    maxAdvPct: 0.02,              // לא יותר מ-2% מהמחזור היומי הממוצע (כדי שאפשר יהיה לצאת)
    commission: 2.5,              // עמלה שטוחה לכל פקודה, כמו במנוע המסחר המדומה
    maxRoundTripCostPct: 8,       // אם עלות הלוך-חזור (מרווח + עמלות) עולה על זה — לא נכנסים
    minRewardRisk: 2,             // יחס סיכוי/סיכון מינימלי אחרי עלויות
  },
  weights: { consistency: 35, liquidity: 20, risk: 25, signal: 20 },
};

// ── עזרים ──

function sum(arr) { return arr.reduce((s, v) => s + v, 0); }
function mean(arr) { return arr.length ? sum(arr) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// עיגול מחיר לפי גודל המחיר — שומר על דיוק במניות של שבריר סנט
function roundPrice(p) {
  if (!(typeof p === "number" && isFinite(p))) return p;
  const abs = Math.abs(p);
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  const f = 10 ** decimals;
  return Math.round((p + Number.EPSILON) * f) / f;
}

function mergeConfig(overrides = {}) {
  return {
    small_cap: { ...DEFAULT_CONFIG.small_cap, ...(overrides.small_cap || {}) },
    otc: { ...DEFAULT_CONFIG.otc, ...(overrides.otc || {}) },
    sizing: { ...DEFAULT_CONFIG.sizing, ...(overrides.sizing || {}) },
    weights: { ...DEFAULT_CONFIG.weights, ...(overrides.weights || {}) },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// סיווג מסלול וגודל צעד מחיר
// ══════════════════════════════════════════════════════════════════════════

function classifyTrack({ exchange = "", price }, config = DEFAULT_CONFIG) {
  const ex = String(exchange).toUpperCase().replace(/[^A-Z]/g, "");
  const isOtc = OTC_EXCHANGES.some((e) => ex.includes(e));
  if (isOtc) {
    return price >= config.otc.minPrice && price <= config.otc.maxPrice ? TRACKS.OTC : null;
  }
  return price >= config.small_cap.minPrice && price <= config.small_cap.maxPrice ? TRACKS.SMALL_CAP : null;
}

// צעד מחיר מינימלי: מתחת לדולר — 0.0001, מעל — סנט
function tickSize(price) {
  return price < 1 ? 0.0001 : 0.01;
}

// כמה אחוזים זז המחיר בצעד אחד. ב-NXGB ב-0.0015 צעד אחד = 6.7%
function tickPct(price) {
  return price > 0 ? (tickSize(price) / price) * 100 : Infinity;
}

// ══════════════════════════════════════════════════════════════════════════
// אינדיקטורים בטוחים לשבריר סנט
// ══════════════════════════════════════════════════════════════════════════

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i].c - candles[i - 1].c;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return gains === 0 ? 50 : 100;
  return Math.round(100 - 100 / (1 + gains / losses));
}

function calcATR(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i - 1];
    trs.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c)));
  }
  return mean(trs.slice(-period));
}

// ══════════════════════════════════════════════════════════════════════════
// נזילות: האם אפשר בכלל להיכנס ולצאת בלי לאבד את הרווח במרווח
// ══════════════════════════════════════════════════════════════════════════

function liquidityProfile(candles, quote = {}, track, config = DEFAULT_CONFIG) {
  const cfg = config[track];
  const recent = candles.slice(-20);
  const last = candles[candles.length - 1];
  const avgVolume = mean(recent.map((c) => c.v));
  const avgDollarVolume = mean(recent.map((c) => c.v * c.c));
  const zeroVolumeDays = recent.filter((c) => !c.v).length;

  const { bid, ask, bidSize, askSize } = quote;
  const hasQuote = bid > 0 && ask > 0 && ask >= bid;
  const mid = hasQuote ? (bid + ask) / 2 : last.c;
  const spreadPct = hasQuote ? ((ask - bid) / mid) * 100 : null;
  const tPct = tickPct(mid);
  // היצע גדול פי כמה מהביקוש = לחץ מכירה שממתין מעל המחיר
  const askBidSizeRatio = hasQuote && bidSize > 0 ? askSize / bidSize : null;

  const flags = [];
  if (avgDollarVolume < cfg.minAvgDollarVolume) {
    flags.push({ code: "low_dollar_volume", severity: "high", he: `מחזור יומי ממוצע נמוך (${Math.round(avgDollarVolume).toLocaleString("en-US")}$)` });
  }
  if (zeroVolumeDays >= 3) {
    flags.push({ code: "dead_days", severity: "high", he: `${zeroVolumeDays} ימים בלי מסחר בכלל ב-20 הימים האחרונים` });
  }
  if (spreadPct !== null && spreadPct > cfg.maxSpreadPct) {
    flags.push({ code: "wide_spread", severity: "hard", he: `מרווח קנייה/מכירה של ${round2(spreadPct)}% — הרווח נאכל כבר בכניסה` });
  }
  if (tPct > cfg.maxTickPct) {
    flags.push({ code: "huge_tick", severity: "high", he: `צעד מחיר אחד שווה ${round2(tPct)}% — כל תנודה מינימלית היא קפיצה גדולה` });
  }
  if (askBidSizeRatio !== null && askBidSizeRatio >= 10) {
    flags.push({ code: "ask_wall", severity: "medium", he: `קיר היצע: פי ${Math.round(askBidSizeRatio)} יותר מניות למכירה מאשר לקנייה` });
  }

  // ציון 0-100
  let score = 100;
  score -= avgDollarVolume < cfg.minAvgDollarVolume ? 40 : 0;
  score -= zeroVolumeDays * 5;
  if (spreadPct !== null) score -= clamp((spreadPct / cfg.maxSpreadPct) * 30, 0, 50);
  score -= clamp((tPct / cfg.maxTickPct) * 15, 0, 30);
  if (askBidSizeRatio !== null && askBidSizeRatio >= 10) score -= 10;

  return {
    avgVolume: Math.round(avgVolume),
    avgDollarVolume: Math.round(avgDollarVolume),
    zeroVolumeDays,
    spreadPct: spreadPct === null ? null : round2(spreadPct),
    tickPct: round2(tPct),
    askBidSizeRatio: askBidSizeRatio === null ? null : round2(askBidSizeRatio),
    score: Math.round(clamp(score, 0, 100)),
    flags,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// דילול: הסיכון מספר 1 במניות קטנות. גידול במספר המניות = מישהו מוכר לך
// ══════════════════════════════════════════════════════════════════════════

// sharesHistory: [{ date: "2026-04-01", shares: 460000000 }, ...]
function dilutionProfile(fundamentals = {}, asOf = new Date()) {
  const history = (fundamentals.sharesHistory || [])
    .filter((h) => h && h.shares > 0 && h.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (history.length < 2) {
    return { known: false, dilution6mPct: null, dilution12mPct: null, headroomPct: null };
  }
  const latest = history[history.length - 1];
  const sharesAt = (monthsBack) => {
    const cutoff = new Date(asOf);
    cutoff.setMonth(cutoff.getMonth() - monthsBack);
    // הנקודה המאוחרת ביותר שעדיין לפני/בתאריך היעד; אחרת המוקדמת ביותר שיש
    const before = history.filter((h) => new Date(h.date) <= cutoff);
    return (before.length ? before[before.length - 1] : history[0]).shares;
  };
  const pct = (from) => (from > 0 ? ((latest.shares - from) / from) * 100 : null);
  const authorized = fundamentals.authorizedShares;
  const headroomPct = authorized > 0 ? ((authorized - latest.shares) / latest.shares) * 100 : null;
  return {
    known: true,
    latestShares: latest.shares,
    dilution6mPct: round2(pct(sharesAt(6))),
    dilution12mPct: round2(pct(sharesAt(12))),
    headroomPct: headroomPct === null ? null : round2(headroomPct),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// סיווג חדשות: חומר אמיתי מול רעש/הייפ מול דילול
// ההודעות לעיתונות כתובות באנגלית, לכן מילות המפתח באנגלית; התוויות בעברית.
// ══════════════════════════════════════════════════════════════════════════

const NEWS_RULES = [
  { category: "negative", he: "שלילי", patterns: [
    /delist/i, /deficiency notice/i, /going concern/i, /trading suspension/i, /\bsuspend(ed|s)? trading/i,
    /auditor (resign|dismiss)/i, /(cfo|ceo|chief financial officer) resign/i, /bankrupt/i, /chapter 11/i, /default/i,
  ] },
  { category: "dilutive", he: "דילול / גיוס", patterns: [
    /offering/i, /private placement/i, /registered direct/i, /convertible/i, /\bS-1\b/, /\bS-3\b/, /at[- ]the[- ]market/i,
    /\bATM\b/, /warrant/i, /reverse (stock )?split/i, /increase (in )?(its )?authori[sz]ed/i, /equity line/i, /\bELOC\b/i,
  ] },
  { category: "hype", he: "הייפ / הבטחה בלי תוכן", patterns: [
    /letter of intent/i, /\bLOI\b/, /\bMOU\b/i, /memorandum of understanding/i, /in talks/i, /nearing/i, /exploring/i,
    /\btoken\b/i, /airdrop/i, /blockchain/i, /crypto/i, /metaverse/i, /\bAI\b/, /artificial intelligence/i,
    /roadmap/i, /corporate update/i, /shareholder (update|letter)/i, /strategic (alternatives|direction)/i, /rebrand/i,
    /name change/i, /new (ticker|symbol)/i, /pivot/i,
  ] },
  { category: "material", he: "מהותי", patterns: [
    /definitive agreement/i, /(closes|completed|completes) (the )?acquisition/i, /contract (award|win)/i, /awarded/i,
    /purchase order/i, /record revenue/i, /revenue (grew|increase|up)/i, /net income/i, /profitab/i,
    /\bFDA\b.*(approv|clear)/i, /patent (grant|issued)/i, /uplist/i, /(nasdaq|nyse) (listing|approval)/i,
    /(10-K|10-Q) fil/i, /audited financials/i, /current (in|with) (its )?(sec |otc )?(reporting|filings)/i,
  ] },
];

function classifyNewsItem(item) {
  const text = `${item.title || ""} ${item.summary || ""}`;
  const matched = [];
  for (const rule of NEWS_RULES) {
    if (rule.patterns.some((p) => p.test(text))) matched.push(rule.category);
  }
  // סדר עדיפות: שלילי > דילול > מהותי > הייפ. "LOI" לצד "definitive" עדיין הייפ אם אין חתימה.
  let category = "neutral";
  if (matched.includes("negative")) category = "negative";
  else if (matched.includes("dilutive")) category = "dilutive";
  else if (matched.includes("material") && !matched.includes("hype")) category = "material";
  else if (matched.includes("hype")) category = "hype";
  else if (matched.includes("material")) category = "material";
  const label = { negative: "שלילי", dilutive: "דילול / גיוס", hype: "הייפ / הבטחה בלי תוכן", material: "מהותי", neutral: "ניטרלי" }[category];
  return { ...item, category, label, matched };
}

function summarizeNews(newsItems = []) {
  const classified = newsItems.map(classifyNewsItem);
  const count = (cat) => classified.filter((n) => n.category === cat).length;
  return {
    items: classified,
    material: count("material"),
    hype: count("hype"),
    dilutive: count("dilutive"),
    negative: count("negative"),
    neutral: count("neutral"),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// עקביות: האם המניה "חיה" — גלים חוזרים לשני הכיוונים, בסיס שלא נשחק,
// ולא תנועה שכולה ספייק בודד (חתימה של משאבה)
// ══════════════════════════════════════════════════════════════════════════

// זיגזג: מזהה נקודות מפנה כשהמחיר זז לפחות thresholdPct מהקיצון האחרון
function zigzag(candles, thresholdPct) {
  if (candles.length < 2) return [];
  const t = thresholdPct / 100;
  const pivots = [];
  let dir = 0; // 0 = עוד לא ידוע, 1 = במגמת עלייה (מחפש שיא), -1 = בירידה (מחפש שפל)
  let hi = candles[0].c, hiIdx = 0, lo = candles[0].c, loIdx = 0;
  for (let i = 1; i < candles.length; i++) {
    const p = candles[i].c;
    if (dir === 0) {
      if (p > hi) { hi = p; hiIdx = i; }
      if (p < lo) { lo = p; loIdx = i; }
      if (lo > 0 && p >= lo * (1 + t)) { pivots.push({ idx: loIdx, price: lo, type: "low" }); dir = 1; hi = p; hiIdx = i; }
      else if (p <= hi * (1 - t)) { pivots.push({ idx: hiIdx, price: hi, type: "high" }); dir = -1; lo = p; loIdx = i; }
    } else if (dir === 1) {
      if (p > hi) { hi = p; hiIdx = i; }
      else if (p <= hi * (1 - t)) { pivots.push({ idx: hiIdx, price: hi, type: "high" }); dir = -1; lo = p; loIdx = i; }
    } else {
      if (p < lo) { lo = p; loIdx = i; }
      else if (p >= lo * (1 + t)) { pivots.push({ idx: loIdx, price: lo, type: "low" }); dir = 1; hi = p; hiIdx = i; }
    }
  }
  return pivots;
}

function consistencyProfile(candles, track, config = DEFAULT_CONFIG, lookback = 120) {
  const cfg = config[track];
  const window = candles.slice(-lookback);
  // בשבריר סנט, קפיצה בין 0.0002 ל-0.0003 היא "גל" של 50% שהוא בסך הכל רעש של צעד מחיר אחד.
  // לכן גל נספר רק אם הוא גם לפחות 3 צעדי מחיר
  const typicalPrice = median(window.map((c) => c.c));
  const effectiveThreshold = Math.max(cfg.swingThresholdPct, 3 * tickPct(typicalPrice));
  const pivots = zigzag(window, effectiveThreshold);

  const swings = [];
  for (let i = 1; i < pivots.length; i++) {
    const a = pivots[i - 1], b = pivots[i];
    swings.push({ dir: b.price > a.price ? "up" : "down", pct: ((b.price - a.price) / a.price) * 100, bars: b.idx - a.idx });
  }
  const upSwings = swings.filter((s) => s.dir === "up");
  const downSwings = swings.filter((s) => s.dir === "down");

  // בסיס שלא נשחק: השפל במחצית השנייה לא נמוך משמעותית מהשפל במחצית הראשונה
  const half = Math.floor(window.length / 2);
  const lowFirst = Math.min(...window.slice(0, half).map((c) => c.l));
  const lowSecond = Math.min(...window.slice(half).map((c) => c.l));
  const baseHoldingPct = lowFirst > 0 ? ((lowSecond - lowFirst) / lowFirst) * 100 : 0;
  const baseHolding = baseHoldingPct >= -15;

  // שליטת ספייק: כמה מהטווח הכולל נוצר ביום בודד. ערך גבוה = תנועה של משאבה, לא גלים
  const rangeHigh = Math.max(...window.map((c) => c.h));
  const rangeLow = Math.min(...window.map((c) => c.l));
  const totalRange = rangeHigh - rangeLow || 1e-12;
  let maxDayMove = 0;
  for (let i = 1; i < window.length; i++) {
    maxDayMove = Math.max(maxDayMove, Math.abs(window[i].c - window[i - 1].c));
  }
  const spikeDominance = maxDayMove / totalRange;

  // האם ספייקים קודמים "נמחקו" — עלו וחזרו לבסיס תוך זמן קצר
  const fadedSpikes = countFadedSpikes(window);

  const isLiving = upSwings.length >= cfg.minSwingsEachWay && downSwings.length >= cfg.minSwingsEachWay;

  let score = 0;
  score += clamp((Math.min(upSwings.length, downSwings.length) / cfg.minSwingsEachWay) * 45, 0, 45);
  score += baseHolding ? 25 : clamp(25 + baseHoldingPct, 0, 20);
  score += clamp((1 - spikeDominance) * 30, 0, 30);
  score -= fadedSpikes * 8;

  return {
    swingThresholdPct: round2(effectiveThreshold),
    swingCount: swings.length,
    upSwings: upSwings.length,
    downSwings: downSwings.length,
    medianUpSwingPct: round2(median(upSwings.map((s) => s.pct))),
    medianSwingBars: Math.round(median(swings.map((s) => s.bars))),
    isLiving,
    baseHolding,
    baseHoldingPct: round2(baseHoldingPct),
    spikeDominance: round2(spikeDominance),
    fadedSpikes,
    score: Math.round(clamp(score, 0, 100)),
  };
}

// ספייק שנמחק: יום עם עלייה של 50%+ (או פי 3 מהממוצע בנפח + 30%+),
// ותוך 10 ימים המחיר חזר אל מתחת לנקודת ההתחלה של הספייק + רבע מהעלייה
function countFadedSpikes(candles) {
  let count = 0;
  for (let i = 21; i < candles.length - 1; i++) {
    const prev = candles[i - 1].c;
    const gainPct = prev > 0 ? ((candles[i].h - prev) / prev) * 100 : 0;
    const avgVol = mean(candles.slice(i - 20, i).map((c) => c.v));
    const volSpike = avgVol > 0 && candles[i].v >= avgVol * 3;
    if (gainPct >= 50 || (volSpike && gainPct >= 30)) {
      const peak = candles[i].h;
      const giveBackLevel = prev + (peak - prev) * 0.25;
      const after = candles.slice(i + 1, i + 11);
      if (after.some((c) => c.c <= giveBackLevel)) count++;
      i += 10; // לא סופרים את אותו ספייק פעמיים
    }
  }
  return count;
}

// ══════════════════════════════════════════════════════════════════════════
// דגלים אדומים — מאגדים הכל לרשימה אחת עם חומרה
//   hard   = פוסל אוטומטית
//   high   = מוריד ציון משמעותית
//   medium = מוריד ציון
// ══════════════════════════════════════════════════════════════════════════

function redFlags({ track, fundamentals = {}, dilution, news, liquidity, candles }, config = DEFAULT_CONFIG) {
  const cfg = config[track];
  const flags = [...(liquidity ? liquidity.flags : [])];
  const f = fundamentals;

  // מצב דיווח (מתוך OTC Markets או SEC)
  const status = String(f.reportingStatus || "").toLowerCase();
  if (/delinquent|no information|limited information|not current/.test(status)) {
    flags.push({ code: "not_reporting", severity: "hard", he: "החברה לא מגישה דוחות עדכניים" });
  }
  if (f.caveatEmptor) flags.push({ code: "caveat_emptor", severity: "hard", he: "סימון 'הקונה ייזהר' של OTC Markets" });
  if (f.expertMarket) flags.push({ code: "expert_market", severity: "hard", he: "המניה בשוק המומחים — כמעט לא סחירה לציבור" });
  if (f.shellRisk) flags.push({ code: "shell", severity: "high", he: "חשד לחברת מעטפת (אין פעילות עסקית ממשית)" });
  if (f.convertibleNotes) flags.push({ code: "convertible_notes", severity: "high", he: "הלוואות להמרה — מקור דילול עתידי" });
  if (f.goingConcern) flags.push({ code: "going_concern", severity: "medium", he: "הערת עסק חי בדוחות" });
  if (f.recentReverseSplit) flags.push({ code: "reverse_split", severity: "high", he: "איחוד מניות לאחרונה — לרוב מקדים גל דילול" });
  if ((f.businessPivots24m || 0) >= 2) {
    flags.push({ code: "pivots", severity: "high", he: `החליפה תחום פעילות ${f.businessPivots24m} פעמים בשנתיים` });
  }
  if (f.paidPromotion) flags.push({ code: "paid_promotion", severity: "high", he: "קידום בתשלום מדווח (משפיענים / ניוזלטרים)" });

  // דילול
  if (dilution && dilution.known) {
    if (dilution.dilution6mPct > cfg.maxDilution6mPct * 2) {
      flags.push({ code: "heavy_dilution", severity: "hard", he: `מספר המניות גדל ב-${dilution.dilution6mPct}% בחצי שנה` });
    } else if (dilution.dilution6mPct > cfg.maxDilution6mPct) {
      flags.push({ code: "dilution", severity: "high", he: `מספר המניות גדל ב-${dilution.dilution6mPct}% בחצי שנה` });
    }
    if (dilution.headroomPct !== null && dilution.headroomPct > 300 && track === TRACKS.OTC) {
      flags.push({ code: "authorized_headroom", severity: "medium", he: `ההון הרשום מאפשר להנפיק עוד פי ${round2(dilution.headroomPct / 100)} מניות` });
    }
  } else if (track === TRACKS.OTC) {
    flags.push({ code: "dilution_unknown", severity: "medium", he: "אין נתוני היסטוריית מניות — לא ניתן לבדוק דילול" });
  }

  // חדשות
  if (news) {
    if (news.negative > 0) flags.push({ code: "negative_news", severity: "high", he: `${news.negative} ידיעות שליליות` });
    if (news.dilutive > 0) flags.push({ code: "dilutive_news", severity: "high", he: `${news.dilutive} ידיעות על גיוס / דילול` });
    if (news.hype >= 2 && news.material === 0) {
      flags.push({ code: "hype_only", severity: "medium", he: "רק הודעות הייפ בלי חדשות מהותיות" });
    }
  }

  // ווליום חריג בלי שום חדשות = חתימה קלאסית של משאבה
  if (candles && candles.length > 21) {
    const last = candles[candles.length - 1];
    const avgVol = mean(candles.slice(-21, -1).map((c) => c.v));
    const noNews = !news || news.items.length === 0;
    if (avgVol > 0 && last.v >= avgVol * 5 && noNews) {
      flags.push({ code: "volume_no_news", severity: "high", he: `ווליום פי ${Math.round(last.v / avgVol)} מהממוצע בלי שום ידיעה — חשד למשאבה` });
    }
  }

  return flags;
}

function riskScore(flags) {
  if (flags.some((f) => f.severity === "hard")) return 0;
  const penalty = sum(flags.map((f) => (f.severity === "high" ? 25 : f.severity === "medium" ? 10 : 0)));
  return clamp(100 - penalty, 0, 100);
}

// ══════════════════════════════════════════════════════════════════════════
// עלויות, גודל פוזיציה ומילוי ריאלי
// ══════════════════════════════════════════════════════════════════════════

// קונים במחיר המבוקש (ask), מוכרים במחיר המוצע (bid). בלי ציטוט — מניחים חצי מרווח
function simulateFillPrices(lastClose, quote = {}, fallbackSpreadPct = 2) {
  if (quote.bid > 0 && quote.ask > 0 && quote.ask >= quote.bid) {
    return { buy: quote.ask, sell: quote.bid };
  }
  const half = (fallbackSpreadPct / 100 / 2) * lastClose;
  const t = tickSize(lastClose);
  return { buy: roundPrice(lastClose + Math.max(half, t)), sell: roundPrice(Math.max(t, lastClose - Math.max(half, t))) };
}

function sizePosition({ buyPrice, avgDollarVolume }, config = DEFAULT_CONFIG) {
  const s = config.sizing;
  const capBudget = s.speculativeCapital * s.maxPositionPct;
  const advBudget = avgDollarVolume * s.maxAdvPct;
  const budget = Math.min(capBudget, advBudget);
  const shares = Math.floor((budget - s.commission) / buyPrice);
  if (shares <= 0) return { shares: 0, budget: round2(budget), positionValue: 0, limitedBy: advBudget < capBudget ? "מחזור" : "הון" };
  return {
    shares,
    budget: round2(budget),
    positionValue: round2(shares * buyPrice),
    limitedBy: advBudget < capBudget ? "מחזור" : "הון",
  };
}

// עלות הלוך-חזור באחוזים: מרווח + שתי עמלות ביחס לגודל הפוזיציה
function roundTripCostPct({ buyPrice, sellPrice, positionValue }, config = DEFAULT_CONFIG) {
  if (!positionValue) return Infinity;
  const spreadPct = ((buyPrice - sellPrice) / buyPrice) * 100;
  const commissionPct = ((config.sizing.commission * 2) / positionValue) * 100;
  return round2(spreadPct + commissionPct);
}

// ══════════════════════════════════════════════════════════════════════════
// אותות כניסה (נבדקים במסחר מדומה, כל סוג מתויג בנפרד ביומן)
//
//   base_bounce       — "רכיבה על גל": מניה חיה ליד תחתית הטווח שלה, מתחילה להתהפך
//   news_followthrough — יום אחרי חדשות מהותיות: המניה מחזיקה את רוב העלייה
//                         בנפח יורד. לא רודפים אחרי הקפיצה עצמה.
// ══════════════════════════════════════════════════════════════════════════

function detectBaseBounce(candles, { lookback = 40 } = {}) {
  if (candles.length < lookback + 1) return null;
  const window = candles.slice(-lookback - 1, -1);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const high = Math.max(...window.map((c) => c.h));
  const low = Math.min(...window.map((c) => c.l));
  const range = high - low;
  if (range <= 0) return null;
  const positionInRange = (last.c - low) / range; // 0 = תחתית, 1 = פסגה
  const avgVol = mean(window.slice(-20).map((c) => c.v));
  const rsiNow = calcRSI(candles);
  const rsiPrev = calcRSI(candles.slice(0, -1));

  const nearBase = positionInRange <= 0.25;
  const turningUp = last.c > prev.c;
  const volumeOk = avgVol > 0 && last.v >= avgVol * 0.8;
  const rsiOk = rsiNow >= 30 && rsiNow <= 55 && rsiNow > rsiPrev;
  const triggered = nearBase && turningUp && volumeOk && rsiOk;

  const atr = calcATR(candles);
  return {
    type: "base_bounce",
    label: "רכיבה על גל מתחתית הטווח",
    triggered,
    checks: { nearBase, turningUp, volumeOk, rsiOk },
    positionInRangePct: Math.round(positionInRange * 100),
    rsi: rsiNow,
    rangeHigh: roundPrice(high),
    rangeLow: roundPrice(low),
    stop: roundPrice(Math.max(tickSize(low), low - atr * 0.5)),
    target: roundPrice(low + range * 0.7), // לוקחים 70% מהטווח, לא מחכים לפסגה
  };
}

function detectNewsFollowthrough(candles, news) {
  if (candles.length < 22 || !news) return null;
  const spikeDay = candles[candles.length - 2];
  const dayBefore = candles[candles.length - 3];
  const last = candles[candles.length - 1];
  const avgVol = mean(candles.slice(-22, -2).map((c) => c.v));
  const spikeGain = spikeDay.c - dayBefore.c;
  const spikeGainPct = dayBefore.c > 0 ? (spikeGain / dayBefore.c) * 100 : 0;
  const hasMaterial = news.items.some((n) => n.category === "material");

  const wasSpike = spikeGainPct >= 15 && avgVol > 0 && spikeDay.v >= avgVol * 3;
  const holding = spikeGain > 0 && last.c >= dayBefore.c + spikeGain * 0.5;
  const volumeCooling = last.v < spikeDay.v;
  const triggered = wasSpike && hasMaterial && holding && volumeCooling;

  return {
    type: "news_followthrough",
    label: "המשכיות אחרי חדשות מהותיות",
    triggered,
    checks: { wasSpike, hasMaterial, holding, volumeCooling },
    spikeGainPct: round2(spikeGainPct),
    stop: roundPrice(Math.max(tickSize(dayBefore.c), dayBefore.c)), // חזרה למחיר שלפני החדשות = התזה נשברה
    target: roundPrice(spikeDay.h + spikeGain * 0.5),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// הערכה מלאה של מועמד אחד
// ══════════════════════════════════════════════════════════════════════════

// input: { symbol, exchange, candles:[{date,o,h,l,c,v}], quote:{bid,ask,bidSize,askSize},
//          fundamentals:{...}, news:[{date,title,summary,source}] }
function evaluateCandidate(input, overrides = {}, asOf = new Date()) {
  const config = mergeConfig(overrides);
  const { symbol, exchange, candles = [], quote = {}, fundamentals = {}, news: rawNews = [] } = input;
  if (candles.length < 60) {
    return { symbol, track: null, verdict: "skip", verdictHe: "דילוג", reasons: ["פחות מ-60 ימי מסחר — אין מספיק היסטוריה"], score: 0 };
  }
  const last = candles[candles.length - 1];
  const track = classifyTrack({ exchange, price: last.c }, config);
  if (!track) {
    return { symbol, track: null, verdict: "skip", verdictHe: "דילוג", reasons: ["המחיר או הבורסה מחוץ לתחום הסורק"], score: 0 };
  }

  const liquidity = liquidityProfile(candles, quote, track, config);
  const dilution = dilutionProfile(fundamentals, asOf);
  const news = summarizeNews(rawNews);
  const consistency = consistencyProfile(candles, track, config);
  const flags = redFlags({ track, fundamentals, dilution, news, liquidity, candles }, config);
  const risk = riskScore(flags);

  const signals = [detectBaseBounce(candles), detectNewsFollowthrough(candles, news)].filter(Boolean);
  const active = signals.find((s) => s.triggered) || null;

  // תוכנית מסחר (רק אם יש אות פעיל)
  let plan = null;
  if (active) {
    const fills = simulateFillPrices(last.c, quote, track === TRACKS.OTC ? 6 : 1);
    const size = sizePosition({ buyPrice: fills.buy, avgDollarVolume: liquidity.avgDollarVolume }, config);
    const costPct = roundTripCostPct({ buyPrice: fills.buy, sellPrice: fills.sell, positionValue: size.positionValue }, config);
    const rewardPct = ((active.target - fills.buy) / fills.buy) * 100 - costPct;
    const riskPct = ((fills.buy - active.stop) / fills.buy) * 100 + costPct;
    const rewardRisk = riskPct > 0 ? rewardPct / riskPct : 0;
    plan = {
      signal: active.type,
      signalLabel: active.label,
      entry: roundPrice(fills.buy),
      exitAssumedAt: roundPrice(fills.sell),
      stop: active.stop,
      target: active.target,
      shares: size.shares,
      positionValue: size.positionValue,
      limitedBy: size.limitedBy,
      roundTripCostPct: costPct,
      netRewardPct: round2(rewardPct),
      netRiskPct: round2(riskPct),
      rewardRisk: round2(rewardRisk),
      viable: size.shares > 0 && costPct <= config.sizing.maxRoundTripCostPct && rewardRisk >= config.sizing.minRewardRisk,
    };
  }

  const signalScore = !active ? 0 : plan && plan.viable ? 100 : 40;
  const w = config.weights;
  const totalW = w.consistency + w.liquidity + w.risk + w.signal;
  const composite = (consistency.score * w.consistency + liquidity.score * w.liquidity + risk * w.risk + signalScore * w.signal) / totalW;
  const hardFail = flags.some((f) => f.severity === "hard");
  const score = hardFail ? 0 : round2(composite / 10);

  // החלטה
  let verdict, verdictHe;
  const reasons = [];
  if (hardFail) {
    verdict = "reject"; verdictHe = "נפסל";
    flags.filter((f) => f.severity === "hard").forEach((f) => reasons.push(f.he));
  } else if (plan && plan.viable && score >= config[track].entryThreshold
             && (plan.signal !== "base_bounce" || consistency.isLiving)) {
    // רכיבה על גלים מותרת רק במניה שכבר הוכיחה גלים חוזרים
    verdict = "paper_entry"; verdictHe = "כניסה לתיק המדומה";
    reasons.push(`אות: ${plan.signalLabel}`);
    reasons.push(`יחס סיכוי/סיכון אחרי עלויות: ${plan.rewardRisk}`);
  } else {
    verdict = "watch"; verdictHe = "מעקב";
    if (!consistency.isLiving) reasons.push("המניה עוד לא הוכיחה גלים חוזרים לשני הכיוונים");
    if (!active) reasons.push("אין כרגע אות כניסה");
    if (plan && !plan.viable) {
      if (plan.shares === 0) reasons.push("המחזור קטן מדי לפוזיציה סבירה");
      else if (plan.roundTripCostPct > config.sizing.maxRoundTripCostPct) reasons.push(`עלות הלוך-חזור ${plan.roundTripCostPct}% — יקר מדי`);
      else reasons.push(`יחס סיכוי/סיכון ${plan.rewardRisk} נמוך מהמינימום`);
    }
    if (score < config[track].entryThreshold) reasons.push(`ציון ${score} מתחת לרף ${config[track].entryThreshold}`);
  }

  return {
    symbol,
    track,
    trackLabel: TRACK_LABELS[track],
    price: roundPrice(last.c),
    date: last.date,
    score,
    verdict,
    verdictHe,
    reasons,
    components: { consistency: consistency.score, liquidity: liquidity.score, risk, signal: signalScore },
    consistency,
    liquidity,
    dilution,
    news: { material: news.material, hype: news.hype, dilutive: news.dilutive, negative: news.negative, items: news.items },
    flags,
    signals,
    plan,
  };
}

// דירוג נפרד לכל מסלול — לא משווים מניית OTC למניית נאסד"ק
function rankCandidates(results, topN = 5) {
  const byTrack = { small_cap: [], otc: [] };
  for (const r of results) if (r.track && byTrack[r.track]) byTrack[r.track].push(r);
  const order = { paper_entry: 0, watch: 1, reject: 2, skip: 3 };
  for (const k of Object.keys(byTrack)) {
    byTrack[k].sort((a, b) => order[a.verdict] - order[b.verdict] || b.score - a.score);
    byTrack[k] = byTrack[k].slice(0, topN);
  }
  return byTrack;
}

// ══════════════════════════════════════════════════════════════════════════
// דוח טקסט בעברית (לאימייל / הודעה)
// ══════════════════════════════════════════════════════════════════════════

function formatResultHe(r) {
  const lines = [`${r.symbol} | ${r.price}$ | ציון ${r.score}/10 | ${r.verdictHe}`];
  lines.push(`  עקביות ${r.components.consistency} · נזילות ${r.components.liquidity} · סיכון ${r.components.risk} · אות ${r.components.signal}`);
  if (r.consistency) {
    lines.push(`  גלים: ${r.consistency.upSwings} עליות / ${r.consistency.downSwings} ירידות, גל עלייה חציוני ${r.consistency.medianUpSwingPct}%`);
  }
  if (r.plan) {
    lines.push(`  תוכנית: כניסה ${r.plan.entry} · סטופ ${r.plan.stop} · יעד ${r.plan.target} · ${r.plan.shares.toLocaleString("en-US")} מניות (${r.plan.positionValue}$)`);
    lines.push(`  עלות הלוך-חזור ${r.plan.roundTripCostPct}% · סיכוי/סיכון ${r.plan.rewardRisk}`);
  }
  for (const reason of r.reasons) lines.push(`  • ${reason}`);
  for (const f of r.flags.filter((x) => x.severity !== "hard")) lines.push(`  ⚠ ${f.he}`);
  return lines.join("\n");
}

function formatReportHe(results, topN = 5) {
  const ranked = rankCandidates(results, topN);
  const out = [];
  for (const track of [TRACKS.SMALL_CAP, TRACKS.OTC]) {
    out.push(`══ ${TRACK_LABELS[track]} ══`);
    if (!ranked[track].length) out.push("אין מועמדים היום");
    for (const r of ranked[track]) out.push(formatResultHe(r));
    out.push("");
  }
  out.push("מסחר מדומה בלבד. זה כלי סינון, לא ייעוץ השקעות.");
  return out.join("\n");
}

// ══════════════════════════════════════════════════════════════════════════
// Export — דואלי (דפדפן + Node)
// ══════════════════════════════════════════════════════════════════════════

const SpeculativeScreener = {
  TRACKS, TRACK_LABELS, DEFAULT_CONFIG, mergeConfig,
  roundPrice, classifyTrack, tickSize, tickPct,
  calcRSI, calcATR,
  liquidityProfile, dilutionProfile,
  classifyNewsItem, summarizeNews,
  zigzag, consistencyProfile, countFadedSpikes,
  redFlags, riskScore,
  simulateFillPrices, sizePosition, roundTripCostPct,
  detectBaseBounce, detectNewsFollowthrough,
  evaluateCandidate, rankCandidates, formatResultHe, formatReportHe,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = SpeculativeScreener;
}
if (typeof window !== "undefined") {
  window.SpeculativeScreener = SpeculativeScreener;
}
