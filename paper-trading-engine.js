// ══════════════════════════════════════════════════════════════════════════
// מנוע מסחר נייר (Paper Trading Engine) — יהונתן חיים ניתוח שוק ההון
//
// מודול עצמאי לחלוטין ממסחר אמיתי: אין כאן שום קריאה לברוקר, רק חישובים
// טהורים על נתוני נרות (candles) שכבר נשלפו על ידי שאר האפליקציה.
//
// נטען הן בדפדפן (script רגיל, ללא type=module — חושף window.PaperTradingEngine)
// והן ב-Node (module.exports) כדי שניתן יהיה להריץ עליו unit tests עם
// `node --test paper-trading-engine.test.js`.
// ══════════════════════════════════════════════════════════════════════════

// ── קבועים ──
const DEFAULT_COMMISSION = 2.5;      // עמלה שטוחה לכל פקודה (קנייה/מכירה), בדולרים
const STARTING_CAPITAL = 1000;       // הון פתיחה וירטואלי לניסוי
const MAX_POSITION_PCT = 0.25;       // תקרת גודל פוזיציה: 25% מההון הפנוי
const SCORE_ENTRY_THRESHOLD = 70;    // סף כניסה: ציון מצטבר 0-100 (= 7/10)
const RANGE_MAX_WIDTH_PCT = 15;      // רוחב טווח מקסימלי (high-low כ-% מהשפל)
const RANGE_MIN_DAYS = 20;           // ~4 שבועות מסחר
const RANGE_MAX_DAYS = 40;           // ~8 שבועות מסחר
const BREAKOUT_VOLUME_MULTIPLIER = 1.5;
const TIME_STOP_WEEKS = 3;

const SCORE_WEIGHTS = {
  wyckoff: 20,
  rsi: 15,
  mfi: 15,
  obvAd: 10,
  volume: 10,
  vwap: 10,
  donchian: 10,
  poc: 10,
};

// ── עזרים כלליים ──
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function sum(arr) {
  return arr.reduce((s, v) => s + v, 0);
}

function assertPositive(value, label) {
  if (!(typeof value === "number" && isFinite(value) && value > 0)) {
    throw new Error(`${label} חייב להיות מספר חיובי`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// עמלות ו-P&L — הליבה הקריטית לדיוק (ראה תיעוד: עמלה שטוחה $2.5 לכל פקודה,
// מתפזרת על פני כמות המניות בפקודה)
// ══════════════════════════════════════════════════════════════════════════

function calcBuyOrder(shares, price, commission = DEFAULT_COMMISSION) {
  assertPositive(shares, "כמות מניות");
  assertPositive(price, "מחיר");
  const grossCost = shares * price;
  const totalCost = round2(grossCost + commission);
  const effectivePrice = round2(totalCost / shares);
  return { shares, price, commission, grossCost: round2(grossCost), totalCost, effectivePrice };
}

function calcSellOrder(shares, price, commission = DEFAULT_COMMISSION) {
  assertPositive(shares, "כמות מניות");
  assertPositive(price, "מחיר");
  const grossProceeds = shares * price;
  const totalProceeds = round2(grossProceeds - commission);
  const effectivePrice = round2(totalProceeds / shares);
  return { shares, price, commission, grossProceeds: round2(grossProceeds), totalProceeds, effectivePrice };
}

// רווח/הפסד נטו על עסקה שלמה (round trip) — כולל עמלת קנייה ועמלת מכירה
function calcRoundTripPnL({ shares, buyPrice, sellPrice, commission = DEFAULT_COMMISSION }) {
  const buy = calcBuyOrder(shares, buyPrice, commission);
  const sell = calcSellOrder(shares, sellPrice, commission);
  const netPnL = round2(sell.totalProceeds - buy.totalCost);
  const netPnLPct = round2((netPnL / buy.totalCost) * 100);
  return { buy, sell, netPnL, netPnLPct };
}

// ══════════════════════════════════════════════════════════════════════════
// אינדיקטורים טכניים
// ══════════════════════════════════════════════════════════════════════════

function calcSMA(candles, period) {
  const slice = candles.slice(-period);
  if (!slice.length) return 0;
  return round2(sum(slice.map((c) => c.c)) / slice.length);
}

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i].c - candles[i - 1].c;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const rs = gains / (losses || 0.001);
  return Math.round(100 - 100 / (1 + rs));
}

function calcATR(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i - 1];
    trs.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c)));
  }
  const slice = trs.slice(-period);
  return slice.length ? round2(sum(slice) / slice.length) : 0;
}

// On-Balance Volume — סדרה מצטברת
function calcOBV(candles) {
  const series = [0];
  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i].c - candles[i - 1].c;
    const prevObv = series[i - 1];
    if (diff > 0) series.push(prevObv + candles[i].v);
    else if (diff < 0) series.push(prevObv - candles[i].v);
    else series.push(prevObv);
  }
  return series;
}

// Accumulation/Distribution Line (Chaikin)
function calcADLine(candles) {
  let ad = 0;
  const series = [];
  for (const c of candles) {
    const range = c.h - c.l || 1e-9;
    const moneyFlowMultiplier = ((c.c - c.l) - (c.h - c.c)) / range;
    ad += moneyFlowMultiplier * c.v;
    series.push(ad);
  }
  return series;
}

// שיפוע ליניארי של סדרה — משמש להערכת מגמת OBV/AD לאורך הטווח
function linearSlope(series) {
  const n = series.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = sum(series) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (series[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den ? num / den : 0;
}

function calcMFI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  const typical = candles.map((c) => (c.h + c.l + c.c) / 3);
  let posFlow = 0, negFlow = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const rawFlow = typical[i] * candles[i].v;
    if (typical[i] > typical[i - 1]) posFlow += rawFlow;
    else if (typical[i] < typical[i - 1]) negFlow += rawFlow;
  }
  if (negFlow === 0) return 100;
  const moneyRatio = posFlow / negFlow;
  return Math.round(100 - 100 / (1 + moneyRatio));
}

function calcDonchian(candles, period = 20) {
  const slice = candles.slice(-period);
  if (!slice.length) return { upper: 0, lower: 0, mid: 0 };
  const upper = Math.max(...slice.map((c) => c.h));
  const lower = Math.min(...slice.map((c) => c.l));
  return { upper: round2(upper), lower: round2(lower), mid: round2((upper + lower) / 2) };
}

// VWAP מעוגן (anchored) — מחושב על פני קבוצת נרות נתונה (למשל מתחילת הטווח)
function calcAnchoredVWAP(candles) {
  let cumPV = 0, cumV = 0;
  for (const c of candles) {
    const typical = (c.h + c.l + c.c) / 3;
    cumPV += typical * c.v;
    cumV += c.v;
  }
  return cumV ? round2(cumPV / cumV) : 0;
}

// Point of Control — רמת המחיר עם הכי הרבה נפח מצטבר (volume profile מפושט)
function calcPOC(candles, buckets = 20) {
  if (!candles.length) return 0;
  const highs = candles.map((c) => c.h), lows = candles.map((c) => c.l);
  const max = Math.max(...highs), min = Math.min(...lows);
  const range = max - min || 1;
  const bucketSize = range / buckets;
  const volByBucket = new Array(buckets).fill(0);
  for (const c of candles) {
    const mid = (c.h + c.l) / 2;
    const idx = Math.max(0, Math.min(buckets - 1, Math.floor((mid - min) / bucketSize)));
    volByBucket[idx] += c.v;
  }
  let maxIdx = 0;
  for (let i = 1; i < buckets; i++) if (volByBucket[i] > volByBucket[maxIdx]) maxIdx = i;
  return round2(min + bucketSize * (maxIdx + 0.5));
}

// ══════════════════════════════════════════════════════════════════════════
// שיטת המסחר: זיהוי טווח → פריצה (Wyckoff-style)
// ══════════════════════════════════════════════════════════════════════════

// מאתר את חלון הטווח הארוך ביותר (בין RANGE_MIN_DAYS ל-RANGE_MAX_DAYS) שרוחבו
// עד RANGE_MAX_WIDTH_PCT אחוז, מתוך הנרות שלפני הנר האחרון (נר הפריצה הפוטנציאלי)
function detectRange(candles, opts = {}) {
  const {
    minDays = RANGE_MIN_DAYS,
    maxDays = RANGE_MAX_DAYS,
    maxWidthPct = RANGE_MAX_WIDTH_PCT,
    excludeLast = 1, // אל תכלול את נר הפריצה הפוטנציאלי בתוך הטווח עצמו
  } = opts;
  const usable = excludeLast > 0 ? candles.slice(0, -excludeLast) : candles;
  if (usable.length < minDays) return null;

  for (let len = Math.min(maxDays, usable.length); len >= minDays; len--) {
    const startIndex = usable.length - len;
    const window = usable.slice(startIndex, startIndex + len);
    const high = Math.max(...window.map((c) => c.h));
    const low = Math.min(...window.map((c) => c.l));
    const widthPct = (low > 0) ? ((high - low) / low) * 100 : Infinity;
    if (widthPct <= maxWidthPct) {
      return { startIndex, length: len, high: round2(high), low: round2(low), widthPct: round2(widthPct) };
    }
  }
  return null;
}

// נפח ממוצע בתוך הטווח לעומת הנפח שקדם לו — צריך שיהיה יורד (צבירה אמיתית)
function isVolumeContracting(candles, range) {
  const rangeCandles = candles.slice(range.startIndex, range.startIndex + range.length);
  const priorStart = Math.max(0, range.startIndex - range.length);
  const priorCandles = candles.slice(priorStart, range.startIndex);
  if (!priorCandles.length || !rangeCandles.length) return null;
  const avgInRange = sum(rangeCandles.map((c) => c.v)) / rangeCandles.length;
  const avgPrior = sum(priorCandles.map((c) => c.v)) / priorCandles.length;
  return { contracting: avgInRange < avgPrior, avgInRange: round2(avgInRange), avgPrior: round2(avgPrior) };
}

// הבחנה צבירה מול חלוקה לפי שיפוע OBV לאורך הטווח (חובה לפני כל כניסה).
// OBV הוא האינדיקטור המכריע (כפי שמופיע ראשון בשיטה); שיפוע ה-A-D line מדווח
// כאינדיקטור מסייע/מאשש לצורך הלוג, אך לא חוסם קביעה כשהוא סותר את ה-OBV.
function classifyAccumulationDistribution(candles, range) {
  const rangeCandles = candles.slice(range.startIndex, range.startIndex + range.length);
  const obvSeries = calcOBV(rangeCandles);
  const adSeries = calcADLine(rangeCandles);
  const obvSlope = linearSlope(obvSeries);
  const adSlope = linearSlope(adSeries);
  const classification = obvSlope > 0 ? "accumulation" : "distribution";
  return { classification, obvSlope: round2(obvSlope), adSlope: round2(adSlope) };
}

// אישור פריצה: סגירה מעל שיא הטווח + נפח פריצה >= פי 1.5 מהממוצע הנע ל-20 יום
function detectBreakout(candles, range, opts = {}) {
  const { volumeMultiplier = BREAKOUT_VOLUME_MULTIPLIER, volumeLookback = 20 } = opts;
  const last = candles[candles.length - 1];
  const closedAboveHigh = last.c > range.high;
  const volWindow = candles.slice(-(volumeLookback + 1), -1); // 20 יום שלפני נר הפריצה
  const avgVol = volWindow.length ? sum(volWindow.map((c) => c.v)) / volWindow.length : 0;
  const volumeRatio = avgVol ? round2(last.v / avgVol) : 0;
  const volumeConfirmed = avgVol > 0 && last.v >= avgVol * volumeMultiplier;
  return {
    closedAboveHigh,
    volumeConfirmed,
    confirmed: closedAboveHigh && volumeConfirmed,
    breakoutPrice: last.c,
    avgVol: round2(avgVol),
    volumeRatio,
  };
}

// ציון מצטבר משוקלל (0-100) לפי המשקלים המוגדרים במתודולוגיה
function scoreCandidate(candles, range, breakout, classification) {
  const rsi = calcRSI(candles);
  const mfi = calcMFI(candles);
  const donchian = calcDonchian(candles);
  const rangeCandles = candles.slice(range.startIndex);
  const vwap = calcAnchoredVWAP(rangeCandles);
  const poc = calcPOC(rangeCandles);
  const last = candles[candles.length - 1];

  const isAccumulation = classification === "accumulation";
  const wyckoffScore = isAccumulation ? (breakout.confirmed ? 100 : 50) : 0;
  const rsiScore = (rsi >= 45 && rsi <= 65) ? 100 : (rsi > 65 && rsi <= 75) ? 70 : (rsi >= 35 && rsi < 45) ? 60 : 30;
  const mfiScore = (mfi >= 45 && mfi <= 70) ? 100 : (mfi > 70 && mfi <= 80) ? 60 : 40;
  const obvAdScore = isAccumulation ? 100 : 0;
  const volumeScore = breakout.volumeConfirmed ? 100 : Math.min(100, round2((breakout.volumeRatio / BREAKOUT_VOLUME_MULTIPLIER) * 100));
  const vwapScore = last.c >= vwap ? 100 : 40;
  const donchianScore = last.c >= donchian.upper ? 100 : 50;
  const pocScore = last.c >= poc ? 80 : 50;

  const components = {
    wyckoff: wyckoffScore, rsi: rsiScore, mfi: mfiScore, obvAd: obvAdScore,
    volume: volumeScore, vwap: vwapScore, donchian: donchianScore, poc: pocScore,
  };
  const totalWeight = sum(Object.values(SCORE_WEIGHTS));
  const weightedSum = sum(Object.keys(SCORE_WEIGHTS).map((k) => components[k] * SCORE_WEIGHTS[k]));
  const compositeScore = round2(weightedSum / totalWeight);
  const scoreOutOf10 = round2(compositeScore / 10);
  return { components, compositeScore, scoreOutOf10, passesThreshold: compositeScore >= SCORE_ENTRY_THRESHOLD };
}

// סטופ-לוס: מתחת ל"ספרינג" (השפל בתוך הטווח), בגודל שנגזר מ-ATR
function calcStopLoss(range, atr, atrMultiplier = 1) {
  return round2(range.low - atr * atrMultiplier);
}

// יעד: Measured Move — גובה הטווח מוקרן כלפי מעלה מנקודת הפריצה
function calcTakeProfit(range, breakoutPrice) {
  const rangeHeight = range.high - range.low;
  return round2(breakoutPrice + rangeHeight);
}

// יציאה בזמן: אם עברו 3 שבועות מהכניסה בלי לפגוע ביעד/סטופ
function isTimeStopExpired(entryDate, currentDate, weeks = TIME_STOP_WEEKS) {
  const ms = new Date(currentDate).getTime() - new Date(entryDate).getTime();
  return ms >= weeks * 7 * 24 * 60 * 60 * 1000;
}

// מחליט מה קורה לפוזיציה פתוחה בהינתן מחיר/תאריך נוכחיים
function evaluateOpenPosition(position, currentPrice, currentDate) {
  if (currentPrice <= position.stop) return { action: "sell", reason: "סטופ-לוס" };
  if (currentPrice >= position.target) return { action: "sell", reason: "יעד (Measured Move)" };
  if (isTimeStopExpired(position.entryDate, currentDate)) return { action: "sell", reason: "Time Stop (3 שבועות)" };
  return { action: "hold", reason: null };
}

// ══════════════════════════════════════════════════════════════════════════
// תיק וירטואלי (Paper Portfolio)
// ══════════════════════════════════════════════════════════════════════════

function createPaperPortfolio(startingCapital = STARTING_CAPITAL) {
  return {
    startingCapital,
    cash: startingCapital,
    positions: [],     // { symbol, shares, entryPrice, entryEffectivePrice, entryDate, stop, target, entryCost }
    closedTrades: [],  // { symbol, shares, entryEffectivePrice, exitEffectivePrice, entryDate, exitDate, pnl, pnlPct, reason }
  };
}

function maxPositionBudget(portfolio, pct = MAX_POSITION_PCT) {
  return round2(portfolio.cash * pct);
}

function hasOpenPosition(portfolio, symbol) {
  return portfolio.positions.some((p) => p.symbol === symbol);
}

// פותח פוזיציית לונג חדשה. מחזיר null אם אין מספיק מזומן/אין כבר החזקה קיימת.
// גודל הפוזיציה מוגבל ל-maxPct מהמזומן הפנוי (ברירת מחדל 25%), ולא יעלה לעולם
// על סך המזומן הזמין — כך שאפשר להחזיק כמה עסקאות מקבילות בלי למנף.
function openPaperPosition(portfolio, { symbol, price, date, stop, target, commission = DEFAULT_COMMISSION, maxPct = MAX_POSITION_PCT }) {
  if (hasOpenPosition(portfolio, symbol)) {
    throw new Error(`כבר קיימת פוזיציה פתוחה ב-${symbol}`);
  }
  const budget = Math.min(maxPositionBudget(portfolio, maxPct), portfolio.cash);
  const shares = Math.floor((budget - commission) / price);
  if (shares <= 0) return null;
  const order = calcBuyOrder(shares, price, commission);
  if (order.totalCost > portfolio.cash) return null;

  portfolio.cash = round2(portfolio.cash - order.totalCost);
  const position = {
    symbol, shares, entryPrice: price, entryEffectivePrice: order.effectivePrice,
    entryDate: date, stop, target, entryCost: order.totalCost,
  };
  portfolio.positions.push(position);
  return position;
}

function closePaperPosition(portfolio, symbol, { price, date, reason, commission = DEFAULT_COMMISSION }) {
  const idx = portfolio.positions.findIndex((p) => p.symbol === symbol);
  if (idx === -1) return null;
  const position = portfolio.positions[idx];
  const order = calcSellOrder(position.shares, price, commission);
  portfolio.cash = round2(portfolio.cash + order.totalProceeds);
  const pnl = round2(order.totalProceeds - position.entryCost);
  const pnlPct = round2((pnl / position.entryCost) * 100);
  const trade = {
    symbol: position.symbol, shares: position.shares,
    entryEffectivePrice: position.entryEffectivePrice, exitEffectivePrice: order.effectivePrice,
    entryDate: position.entryDate, exitDate: date, pnl, pnlPct, reason,
  };
  portfolio.closedTrades.push(trade);
  portfolio.positions.splice(idx, 1);
  return trade;
}

// שווי תיק כולל = מזומן + שווי שוק נוכחי של הפוזיציות הפתוחות
function markToMarket(portfolio, currentPrices) {
  const positionsValue = sum(portfolio.positions.map((p) => {
    const price = currentPrices[p.symbol];
    return (typeof price === "number" ? price : p.entryPrice) * p.shares;
  }));
  const equity = round2(portfolio.cash + positionsValue);
  const totalPnL = round2(equity - portfolio.startingCapital);
  const totalPnLPct = round2((totalPnL / portfolio.startingCapital) * 100);
  return { cash: round2(portfolio.cash), positionsValue: round2(positionsValue), equity, totalPnL, totalPnLPct };
}

// ══════════════════════════════════════════════════════════════════════════
// מדדי הצלחה בסוף חודש הניסוי
// ══════════════════════════════════════════════════════════════════════════

function computeTradeMetrics(closedTrades) {
  if (!closedTrades.length) {
    return { count: 0, winRate: 0, avgWin: 0, avgLoss: 0, winLossRatio: null, netPnL: 0 };
  }
  const wins = closedTrades.filter((t) => t.pnl > 0);
  const losses = closedTrades.filter((t) => t.pnl <= 0);
  const netPnL = round2(sum(closedTrades.map((t) => t.pnl)));
  const winRate = round2((wins.length / closedTrades.length) * 100);
  const avgWin = wins.length ? round2(sum(wins.map((t) => t.pnl)) / wins.length) : 0;
  const avgLoss = losses.length ? round2(sum(losses.map((t) => t.pnl)) / losses.length) : 0;
  const winLossRatio = avgLoss !== 0 ? round2(Math.abs(avgWin / avgLoss)) : null;
  return { count: closedTrades.length, winRate, avgWin, avgLoss, winLossRatio, netPnL };
}

function computeBuyAndHold(symbol, startPrice, currentPrice, shares) {
  const startValue = round2(startPrice * shares);
  const currentValue = round2(currentPrice * shares);
  const pnl = round2(currentValue - startValue);
  const pnlPct = round2((pnl / startValue) * 100);
  return { symbol, startPrice, currentPrice, shares, startValue, currentValue, pnl, pnlPct };
}

// בדיקת דיוק ההבחנה צבירה/חלוקה בדיעבד: אם סווג כ"חלוקה" ונדחה, המחיר
// באמת אמור היה לרדת/להישאר שטוח בהמשך כדי שהדחייה תיחשב נכונה.
function auditDistributionRejection(logEntry, laterPrice) {
  if (logEntry.classification !== "distribution") return { ...logEntry, correct: null };
  const correct = laterPrice <= logEntry.priceAtLog;
  return { ...logEntry, correct };
}

// ══════════════════════════════════════════════════════════════════════════
// Export — דואלי (דפדפן + Node)
// ══════════════════════════════════════════════════════════════════════════

const PaperTradingEngine = {
  // קבועים
  DEFAULT_COMMISSION, STARTING_CAPITAL, MAX_POSITION_PCT, SCORE_ENTRY_THRESHOLD,
  RANGE_MAX_WIDTH_PCT, RANGE_MIN_DAYS, RANGE_MAX_DAYS, BREAKOUT_VOLUME_MULTIPLIER,
  TIME_STOP_WEEKS, SCORE_WEIGHTS,
  // עמלות / P&L
  round2, calcBuyOrder, calcSellOrder, calcRoundTripPnL,
  // אינדיקטורים
  calcSMA, calcRSI, calcATR, calcOBV, calcADLine, linearSlope, calcMFI,
  calcDonchian, calcAnchoredVWAP, calcPOC,
  // שיטת המסחר
  detectRange, isVolumeContracting, classifyAccumulationDistribution,
  detectBreakout, scoreCandidate, calcStopLoss, calcTakeProfit,
  isTimeStopExpired, evaluateOpenPosition,
  // תיק וירטואלי
  createPaperPortfolio, maxPositionBudget, hasOpenPosition,
  openPaperPosition, closePaperPosition, markToMarket,
  // מדדי הצלחה
  computeTradeMetrics, computeBuyAndHold, auditDistributionRejection,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = PaperTradingEngine;
}
if (typeof window !== "undefined") {
  window.PaperTradingEngine = PaperTradingEngine;
}
