// Unit tests למנוע מסחר הנייר. הרצה: node --test paper-trading-engine.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("./paper-trading-engine.js");

// ── עזר: בונה נר בודד ──
function candle(o, h, l, c, v) {
  return { o, h, l, c, v };
}

// ── עזר: בונה סדרת נרות "טווח" שטוח + נר פריצה בסוף ──
function buildRangeAndBreakout({ low = 90, high = 100, days = 25, breakoutClose = 108, breakoutVol = 5_000_000, baseVol = 1_000_000 } = {}) {
  const candles = [];
  // תקופה שקדמה לטווח — נפח גבוה יותר (כדי לבדוק התכווצות נפח)
  for (let i = 0; i < days; i++) {
    candles.push(candle(95, 105, 88, 95 + (i % 2), baseVol * 2.5));
  }
  // הטווח עצמו — נפח נמוך יותר, בתוך [low, high]
  for (let i = 0; i < days; i++) {
    const c = low + (i % (high - low || 1));
    candles.push(candle(c, Math.min(high, c + 2), Math.max(low, c - 2), c, baseVol));
  }
  // נר הפריצה
  candles.push(candle(high, breakoutClose + 1, high - 1, breakoutClose, breakoutVol));
  return candles;
}

// ══════════════════════ עמלות ו-P&L ══════════════════════

test("קניית מניה אחת ב-$10 -> עלות אפקטיבית $12.50 (העמלה השטוחה נטענת במלואה)", () => {
  const order = E.calcBuyOrder(1, 10);
  assert.equal(order.totalCost, 12.5);
  assert.equal(order.effectivePrice, 12.5);
});

test("קניית 2 מניות ב-$10 -> עלות כוללת $22.5, מחיר אפקטיבי $11.25 למניה", () => {
  const order = E.calcBuyOrder(2, 10);
  assert.equal(order.totalCost, 22.5);
  assert.equal(order.effectivePrice, 11.25);
});

test("ככל שקונים יותר יחידות, העלות האפקטיבית למניה יורדת (העמלה מתפזרת)", () => {
  const a = E.calcBuyOrder(1, 50).effectivePrice;
  const b = E.calcBuyOrder(10, 50).effectivePrice;
  const c = E.calcBuyOrder(100, 50).effectivePrice;
  assert.ok(a > b && b > c);
});

test("מכירת מניה מפחיתה את העמלה מהתמורה", () => {
  const order = E.calcSellOrder(4, 20);
  // 4*20 = 80, פחות עמלה 2.5 = 77.5, חלקי 4 = 19.375 -> מעוגל ל-19.38
  assert.equal(order.totalProceeds, 77.5);
  assert.equal(order.effectivePrice, 19.38);
});

test("רווח/הפסד נטו על עסקה שלמה (round trip) כולל שתי עמלות נפרדות", () => {
  const { netPnL } = E.calcRoundTripPnL({ shares: 10, buyPrice: 10, sellPrice: 11 });
  // עלות קנייה: 100+2.5=102.5. תמורת מכירה: 110-2.5=107.5. נטו: 5.0
  assert.equal(netPnL, 5);
});

test("עסקה עם רווח ברוטו קטן מהעמלות הכפולות מניבה הפסד נטו", () => {
  const { netPnL } = E.calcRoundTripPnL({ shares: 1, buyPrice: 10, sellPrice: 10.5 });
  // ברוטו: 0.5$, עמלות: 5$ (2.5 קנייה + 2.5 מכירה) -> הפסד נטו
  assert.ok(netPnL < 0);
});

test("שלוש פקודות קנייה נפרדות (DCA) נושאות שלוש עמלות בנפרד", () => {
  const orders = [E.calcBuyOrder(1, 10), E.calcBuyOrder(1, 11), E.calcBuyOrder(1, 12)];
  const totalCommission = orders.reduce((s, o) => s + o.commission, 0);
  assert.equal(totalCommission, 7.5);
});

test("כמות/מחיר לא חיוביים זורקים שגיאה", () => {
  assert.throws(() => E.calcBuyOrder(0, 10));
  assert.throws(() => E.calcBuyOrder(1, -5));
});

// ══════════════════════ אינדיקטורים ══════════════════════

test("OBV עולה כאשר המחיר עולה על נפח", () => {
  const candles = [candle(10, 11, 9, 10, 1000), candle(10, 12, 10, 11, 1500), candle(11, 13, 11, 12, 2000)];
  const obv = E.calcOBV(candles);
  assert.equal(obv[0], 0);
  assert.equal(obv[1], 1500);
  assert.equal(obv[2], 3500);
});

test("OBV יורד כאשר המחיר יורד", () => {
  const candles = [candle(10, 11, 9, 10, 1000), candle(10, 10, 8, 9, 1500)];
  const obv = E.calcOBV(candles);
  assert.equal(obv[1], -1500);
});

test("RSI מחזיר 50 כברירת מחדל כשאין מספיק נתונים", () => {
  assert.equal(E.calcRSI([candle(1, 1, 1, 1, 1)]), 50);
});

test("MFI בטווח 0-100", () => {
  const candles = Array.from({ length: 20 }, (_, i) => candle(10 + i * 0.1, 10.5 + i * 0.1, 9.5 + i * 0.1, 10 + i * 0.1, 1_000_000));
  const mfi = E.calcMFI(candles);
  assert.ok(mfi >= 0 && mfi <= 100);
});

test("Donchian channel מזהה נכון את השיא/שפל בחלון", () => {
  const candles = [candle(1, 10, 5, 8, 1), candle(1, 15, 4, 9, 1), candle(1, 12, 3, 10, 1)];
  const d = E.calcDonchian(candles, 3);
  assert.equal(d.upper, 15);
  assert.equal(d.lower, 3);
});

test("ATR אינו שלילי ומגיב לתנודתיות", () => {
  const calm = Array.from({ length: 20 }, () => candle(10, 10.2, 9.8, 10, 1000));
  const volatile = Array.from({ length: 20 }, () => candle(10, 15, 5, 10, 1000));
  assert.ok(E.calcATR(calm) < E.calcATR(volatile));
});

// ══════════════════════ שיטת המסחר: טווח → פריצה ══════════════════════

test("detectRange מזהה טווח שרוחבו עד 15% ודוחה טווח רחב מדי", () => {
  const tightCandles = buildRangeAndBreakout({ low: 95, high: 100 }); // ~5% width
  const range = E.detectRange(tightCandles);
  assert.ok(range, "אמור לזהות טווח הדוק");
  assert.ok(range.widthPct <= 15);

  const wideCandles = [];
  for (let i = 0; i < 30; i++) wideCandles.push(candle(50, 100, 50, 50 + (i % 40), 1_000_000));
  wideCandles.push(candle(100, 110, 99, 105, 5_000_000));
  const noRange = E.detectRange(wideCandles);
  assert.equal(noRange, null, "טווח של 100% רוחב לא אמור להתקבל");
});

test("isVolumeContracting מזהה ירידת נפח בטווח לעומת מה שקדם לו", () => {
  const candles = buildRangeAndBreakout();
  const range = E.detectRange(candles);
  const vol = E.isVolumeContracting(candles, range);
  assert.equal(vol.contracting, true);
});

test("classifyAccumulationDistribution: OBV עולה לאורך הטווח -> צבירה", () => {
  const days = 25;
  const candles = [];
  for (let i = 0; i < days; i++) {
    // מחיר עולה בהדרגה בתוך נרות עם נפח -> OBV אמור לעלות
    candles.push(candle(90 + i * 0.1, 92 + i * 0.1, 89 + i * 0.1, 90.5 + i * 0.1, 1_000_000));
  }
  candles.push(candle(100, 108, 99, 106, 5_000_000)); // נר פריצה, לא חלק מהטווח
  const range = E.detectRange(candles);
  assert.ok(range);
  const result = E.classifyAccumulationDistribution(candles, range);
  assert.equal(result.classification, "accumulation");
});

test("classifyAccumulationDistribution: OBV יורד לאורך הטווח -> חלוקה", () => {
  const days = 25;
  const candles = [];
  for (let i = 0; i < days; i++) {
    // מחיר יורד בהדרגה -> OBV אמור לרדת (חלוקה, לא מועמד ללונג)
    candles.push(candle(100 - i * 0.1, 101 - i * 0.1, 98 - i * 0.1, 99 - i * 0.1, 1_000_000));
  }
  candles.push(candle(95, 100, 94, 99, 5_000_000));
  const range = E.detectRange(candles);
  assert.ok(range);
  const result = E.classifyAccumulationDistribution(candles, range);
  assert.equal(result.classification, "distribution");
});

test("detectBreakout דורש גם סגירה מעל שיא הטווח וגם נפח >= פי 1.5 מהממוצע", () => {
  const candles = buildRangeAndBreakout({ low: 95, high: 100, breakoutClose: 108, breakoutVol: 5_000_000, baseVol: 1_000_000 });
  const range = E.detectRange(candles);
  const breakout = E.detectBreakout(candles, range);
  assert.equal(breakout.closedAboveHigh, true);
  assert.equal(breakout.volumeConfirmed, true);
  assert.equal(breakout.confirmed, true);
});

test("detectBreakout נכשל אם הנפח לא מספיק גם אם המחיר פרץ", () => {
  const candles = buildRangeAndBreakout({ low: 95, high: 100, breakoutClose: 108, breakoutVol: 1_000_000, baseVol: 1_000_000 });
  const range = E.detectRange(candles);
  const breakout = E.detectBreakout(candles, range);
  assert.equal(breakout.closedAboveHigh, true);
  assert.equal(breakout.volumeConfirmed, false);
  assert.equal(breakout.confirmed, false);
});

test("משקלי הציון מסתכמים בדיוק ל-100 (Wyckoff 20 + RSI 15 + MFI 15 + 5*10)", () => {
  const total = Object.values(E.SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
});

test("scoreCandidate: פריצה מאושרת עם צבירה נותנת ציון גבוה שעובר את הסף", () => {
  const candles = buildRangeAndBreakout({ low: 95, high: 100, breakoutClose: 108, breakoutVol: 5_000_000, baseVol: 1_000_000 });
  const range = E.detectRange(candles);
  const breakout = E.detectBreakout(candles, range);
  const score = E.scoreCandidate(candles, range, breakout, "accumulation");
  assert.ok(score.compositeScore >= 0 && score.compositeScore <= 100);
  assert.ok(score.passesThreshold, `הציון ${score.compositeScore} אמור לעבור את סף ה-70`);
});

test("scoreCandidate: חלוקה תמיד מקבלת ציון Wyckoff/OBV-AD אפס", () => {
  const candles = buildRangeAndBreakout();
  const range = E.detectRange(candles);
  const breakout = E.detectBreakout(candles, range);
  const score = E.scoreCandidate(candles, range, breakout, "distribution");
  assert.equal(score.components.wyckoff, 0);
  assert.equal(score.components.obvAd, 0);
});

test("calcStopLoss ממקם את הסטופ מתחת לשפל הטווח בגודל שנגזר מ-ATR", () => {
  const range = { low: 100, high: 120 };
  const stop = E.calcStopLoss(range, 2, 1);
  assert.equal(stop, 98);
});

test("calcTakeProfit מבצע Measured Move מגובה הטווח מעל נקודת הפריצה", () => {
  const range = { low: 100, high: 120 }; // גובה טווח = 20
  const target = E.calcTakeProfit(range, 121);
  assert.equal(target, 141);
});

test("isTimeStopExpired מזהה חלון של 3 שבועות", () => {
  assert.equal(E.isTimeStopExpired("2025-01-01", "2025-01-15"), false); // שבועיים
  assert.equal(E.isTimeStopExpired("2025-01-01", "2025-01-23"), true);  // 22 יום
});

test("evaluateOpenPosition סוגר בסטופ, ביעד, ובזמן — ולא נוגע כשהכל תקין", () => {
  const pos = { entryDate: "2025-01-01", stop: 90, target: 110 };
  assert.equal(E.evaluateOpenPosition(pos, 89, "2025-01-05").action, "sell");
  assert.equal(E.evaluateOpenPosition(pos, 111, "2025-01-05").action, "sell");
  assert.equal(E.evaluateOpenPosition(pos, 100, "2025-01-25").action, "sell"); // time stop
  assert.equal(E.evaluateOpenPosition(pos, 100, "2025-01-05").action, "hold");
});

// ══════════════════════ תיק וירטואלי ══════════════════════

test("תיק חדש נפתח עם $1000 הון פתיחה", () => {
  const p = E.createPaperPortfolio();
  assert.equal(p.cash, 1000);
  assert.equal(p.startingCapital, 1000);
});

test("openPaperPosition לא חורג מ-25% מהמזומן הפנוי", () => {
  const p = E.createPaperPortfolio(1000);
  const pos = E.openPaperPosition(p, { symbol: "AAPL", price: 50, date: "2025-01-01", stop: 45, target: 60 });
  assert.ok(pos.entryCost <= 250, `עלות הכניסה ${pos.entryCost} חייבת להיות עד 25% מ-1000`);
});

test("openPaperPosition מפחית מזומן בדיוק לפי עלות הפקודה כולל עמלה", () => {
  const p = E.createPaperPortfolio(1000);
  const cashBefore = p.cash;
  const pos = E.openPaperPosition(p, { symbol: "AAPL", price: 50, date: "2025-01-01", stop: 45, target: 60 });
  assert.equal(p.cash, E.round2(cashBefore - pos.entryCost));
});

test("לא ניתן לפתוח שתי פוזיציות באותו סימבול בו-זמנית", () => {
  const p = E.createPaperPortfolio(1000);
  E.openPaperPosition(p, { symbol: "AAPL", price: 50, date: "2025-01-01", stop: 45, target: 60 });
  assert.throws(() => E.openPaperPosition(p, { symbol: "AAPL", price: 51, date: "2025-01-02", stop: 45, target: 60 }));
});

test("closePaperPosition מחזיר את המזומן לתיק ומחשב P&L נכון", () => {
  const p = E.createPaperPortfolio(1000);
  const pos = E.openPaperPosition(p, { symbol: "AAPL", price: 50, date: "2025-01-01", stop: 45, target: 60 });
  const cashAfterBuy = p.cash;
  const trade = E.closePaperPosition(p, "AAPL", { price: 60, date: "2025-01-15", reason: "יעד" });
  assert.equal(p.positions.length, 0);
  assert.equal(p.closedTrades.length, 1);
  const expectedProceeds = E.calcSellOrder(pos.shares, 60).totalProceeds;
  assert.equal(p.cash, E.round2(cashAfterBuy + expectedProceeds));
  assert.equal(trade.pnl, E.round2(expectedProceeds - pos.entryCost));
});

test("markToMarket מחשב שווי תיק כולל מזומן ופוזיציות פתוחות במחיר שוק", () => {
  const p = E.createPaperPortfolio(1000);
  const pos = E.openPaperPosition(p, { symbol: "AAPL", price: 50, date: "2025-01-01", stop: 45, target: 60 });
  const snapshot = E.markToMarket(p, { AAPL: 55 });
  assert.equal(snapshot.cash, p.cash);
  assert.equal(snapshot.positionsValue, E.round2(pos.shares * 55));
  assert.equal(snapshot.equity, E.round2(p.cash + pos.shares * 55));
});

// ══════════════════════ מדדי הצלחה ══════════════════════

test("computeTradeMetrics מחשב win rate ויחס רווח/הפסד ממוצע", () => {
  const trades = [
    { pnl: 100 }, { pnl: 50 }, { pnl: -20 }, { pnl: -30 },
  ];
  const metrics = E.computeTradeMetrics(trades);
  assert.equal(metrics.count, 4);
  assert.equal(metrics.winRate, 50);
  assert.equal(metrics.avgWin, 75);
  assert.equal(metrics.avgLoss, -25);
  assert.equal(metrics.winLossRatio, 3);
  assert.equal(metrics.netPnL, 100);
});

test("computeTradeMetrics מחזיר ערכי בסיס כשאין עסקאות סגורות", () => {
  const metrics = E.computeTradeMetrics([]);
  assert.equal(metrics.count, 0);
  assert.equal(metrics.winLossRatio, null);
});

test("computeBuyAndHold משווה ביצועים מול אסטרטגיית קנה-והחזק", () => {
  const bh = E.computeBuyAndHold("AAPL", 100, 120, 5);
  assert.equal(bh.pnl, 100);
  assert.equal(bh.pnlPct, 20);
});

test("auditDistributionRejection: דחייה כ'חלוקה' נכונה אם המחיר לא עלה בהמשך", () => {
  const logEntry = { classification: "distribution", priceAtLog: 100 };
  assert.equal(E.auditDistributionRejection(logEntry, 95).correct, true);
  assert.equal(E.auditDistributionRejection(logEntry, 110).correct, false);
});
