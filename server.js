// ============================================================
//  PHẦN 1/5: IMPORTS + CẤU HÌNH + SINH TÊN CẦU
// ============================================================
import fastify from "fastify";
import cors from "@fastify/cors";
import fetch from "node-fetch";

// ==================== CẤU HÌNH ====================
const PORT = 3000;
const VALID_KEY = "Hentaiz";
const ADMIN_ID = "@cskhgiabao";

const API_URL_HU  = "https://wtx.tele68.com/v1/tx/lite-sessions?cp=R&cl=R&pf=web&at=83991213bfd4c554dc94bcd98979bdc5";
const API_URL_MD5 = "https://wtxmd52.tele68.com/v1/txmd5/sessions";

// Ngưỡng học rules
const MIN_SAMPLES_DICE   = 30;
const MIN_SAMPLES_STREAK = 20;
const MIN_SAMPLES_SCORE  = 50;
const MIN_RATE_DICE      = 65;
const MIN_RATE_STREAK    = 62;
const MIN_RATE_SCORE     = 60;

/* ================================================================
 *  SINH TÊN CẦU
 * ================================================================ */
function blocksOf(pat) {
  const b = []; let c = 1;
  for (let i = 1; i < pat.length; i++) {
    if (pat[i] === pat[i - 1]) c++;
    else { b.push(c); c = 1; }
  }
  b.push(c);
  return b;
}

function namePattern(pat) {
  if (!pat || pat.length < 2) return "N/A";
  const b = blocksOf(pat);
  const L = pat.length;
  if (b.length === 1) return `BỆT-${L}`;
  if (/^(BT)+B?$/.test(pat) || /^(TB)+T?$/.test(pat)) return `SOLE-${L}`;
  if (/^(BBTT)+B{0,2}$/.test(pat) || /^(TTBB)+T{0,2}$/.test(pat)) return `GẤPĐÔI-${L}`;
  return `NHỊP-${b.join('-')}`;
}
// ============================================================
//  PHẦN 2/5: DICE CLASSIFIER + HỌC RULES ONLINE
// ============================================================

/* ================================================================
 *  DICE CLASSIFIER
 * ================================================================ */
function classifyDice(dice) {
  if (!dice || dice.length !== 3) return null;
  const sorted = [...dice].sort((a, b) => a - b);
  const [a, b, c] = sorted;
  const unique = new Set(dice).size;

  // BÃO: 3 mặt giống
  if (unique === 1) return { type: "BAO", label: `BÃO ${a}-${a}-${a}`, strength: "SKIP" };

  // KÉP: 2 mặt giống
  if (unique === 2) {
    const pair = dice.find((v, i) => dice.indexOf(v) !== i);
    if (pair <= 2) return { type: "KEP_BE", label: `Kép Bé ${pair}-${pair}`, strength: "STRONG" };
    if (pair >= 5) return { type: "KEP_LON", label: `Kép Lớn ${pair}-${pair}`, strength: "STRONG" };
    return { type: "KEP_TB", label: `Kép TB ${pair}-${pair}`, strength: "WEAK" };
  }

  // GÁNH
  if (a === c && a !== b) return { type: "GANH", label: `Gánh ${a}-${b}-${a}`, strength: "WEAK" };

  // TIẾN
  if (b === a + 1 && c === b + 1) return { type: "TIEN", label: `Tiến ${a}-${b}-${c}`, strength: "STRONG" };

  // LÙI
  if (b === a - 1 && c === b - 1) return { type: "LUI", label: `Lùi ${a}-${b}-${c}`, strength: "STRONG" };

  // 2 mặt 6
  if (dice.filter(d => d === 6).length === 2) return { type: "HAI_SAU", label: `2 mặt 6`, strength: "STRONG" };

  // 2 mặt 1
  if (dice.filter(d => d === 1).length === 2) return { type: "HAI_MOT", label: `2 mặt 1`, strength: "STRONG" };

  return { type: "OTHER", label: `Khác ${a}-${b}-${c}`, strength: "NONE" };
}

/* ================================================================
 *  HỌC DICE RULES
 * ================================================================ */
function learnDiceRules(sessions) {
  const stat = {};
  for (let i = 0; i < sessions.length - 1; i++) {
    const cur = sessions[i], nxt = sessions[i + 1];
    const cls = classifyDice(cur.dice);
    if (!cls || cls.type === "BAO") continue;
    (stat[cls.type] ??= { label: cls.label, strength: cls.strength, TAI: 0, XIU: 0 });
    stat[cls.type][nxt.result]++;
  }

  const rules = {};
  for (const type in stat) {
    const s = stat[type];
    const total = s.TAI + s.XIU;
    if (total < MIN_SAMPLES_DICE) continue;

    const pT = s.TAI / total * 100;
    const pX = s.XIU / total * 100;
    const maxRate = Math.max(pT, pX);
    if (maxRate < MIN_RATE_DICE) continue;

    rules[type] = {
      type,
      label: s.label,
      strength: s.strength,
      total,
      TAI: s.TAI,
      XIU: s.XIU,
      TAI_pct: +pT.toFixed(1),
      XIU_pct: +pX.toFixed(1),
      predict: pT > pX ? 'TAI' : 'XIU',
      rate: Math.round(maxRate),
      has_edge: maxRate >= MIN_RATE_DICE
    };
  }
  return rules;
}

/* ================================================================
 *  HỌC STREAK RULES (Bệt)
 * ================================================================ */
function learnStreakRules(sessions) {
  const stat = {};
  for (let i = 3; i < sessions.length - 1; i++) {
    let count = 1;
    for (let j = i - 1; j >= 0; j--) {
      if (sessions[j].result === sessions[i].result) count++;
      else break;
    }
    if (count < 3 || count > 8) continue;
    const nxt = sessions[i + 1];
    const key = `BET_${sessions[i].result}_${count}`;
    (stat[key] ??= { side: sessions[i].result, count, TAI: 0, XIU: 0 });
    stat[key][nxt.result]++;
  }

  const rules = {};
  for (const key in stat) {
    const s = stat[key];
    const total = s.TAI + s.XIU;
    if (total < MIN_SAMPLES_STREAK) continue;

    const pT = s.TAI / total * 100;
    const pX = s.XIU / total * 100;
    const maxRate = Math.max(pT, pX);
    if (maxRate < MIN_RATE_STREAK) continue;

    rules[key] = {
      key,
      side: s.side,
      streak: s.count,
      label: `Bệt ${s.side === 'TAI' ? 'TÀI' : 'XỈU'} ${s.count} tay`,
      total,
      TAI: s.TAI,
      XIU: s.XIU,
      TAI_pct: +pT.toFixed(1),
      XIU_pct: +pX.toFixed(1),
      predict: pT > pX ? 'TAI' : 'XIU',
      rate: Math.round(maxRate),
      has_edge: maxRate >= MIN_RATE_STREAK
    };
  }
  return rules;
}

/* ================================================================
 *  HỌC SCORE RULES (Điểm số)
 * ================================================================ */
function learnScoreRules(sessions) {
  const stat = {};
  for (let i = 0; i < sessions.length - 1; i++) {
    const cur = sessions[i], nxt = sessions[i + 1];
    const key = `${cur.result}_${cur.score}`;
    (stat[key] ??= { TAI: 0, XIU: 0 });
    stat[key][nxt.result]++;
  }

  const rules = {};
  for (const key in stat) {
    const s = stat[key];
    const total = s.TAI + s.XIU;
    if (total < MIN_SAMPLES_SCORE) continue;

    const pT = s.TAI / total * 100;
    const pX = s.XIU / total * 100;
    const maxRate = Math.max(pT, pX);
    if (maxRate < MIN_RATE_SCORE) continue;

    const [side, score] = key.split('_');
    rules[key] = {
      side, score: parseInt(score),
      label: `${side === 'TAI' ? 'T' : 'X'}${score}`,
      total,
      TAI: s.TAI, XIU: s.XIU,
      TAI_pct: +pT.toFixed(1),
      XIU_pct: +pX.toFixed(1),
      predict: pT > pX ? 'TAI' : 'XIU',
      rate: Math.round(maxRate),
      has_edge: maxRate >= MIN_RATE_SCORE
    };
  }
  return rules;
}

/* ================================================================
 *  HỌC LẠI TẤT CẢ RULES
 * ================================================================ */
function relearnRules(history, currentRules) {
  const sessions = [...history].reverse(); // Chronological
  if (sessions.length < 50) return currentRules;

  const diceRules   = learnDiceRules(sessions);
  const streakRules = learnStreakRules(sessions);
  const scoreRules  = learnScoreRules(sessions);

  return {
    dice:   diceRules,
    streak: streakRules,
    score:  scoreRules,
    meta: {
      total: sessions.length,
      updatedAt: new Date().toISOString(),
      counts: {
        dice:   Object.keys(diceRules).length,
        streak: Object.keys(streakRules).length,
        score:  Object.keys(scoreRules).length
      }
    }
  };
}
// ============================================================
//  PHẦN 3/5: STATE + RULE ENGINE + ENSEMBLE + PREDICT
// ============================================================

/* ================================================================
 *  GLOBAL STATE
 * ================================================================ */
let huHistory  = [];
let md5History = [];

let currentSessionIdHu  = null;
let currentSessionIdMd5 = null;

let huPredictionLog  = [];
let md5PredictionLog = [];

let HU_RULES  = { dice: {}, streak: {}, score: {}, meta: { total: 0, updatedAt: null } };
let MD5_RULES = { dice: {}, streak: {}, score: {}, meta: { total: 0, updatedAt: null } };

/* ================================================================
 *  RULE ENGINE
 * ================================================================ */
function ruleEngine(sessions, rules) {
  const last = sessions[sessions.length - 1];
  const signals = [];

  // 1. DICE
  const diceClass = classifyDice(last.dice);
  if (diceClass) {
    if (diceClass.type === "BAO") {
      return [{
        source: "rule_bao",
        label: diceClass.label,
        predict: null,
        rate: 0,
        note: "BÃO → NGHỈ 3 phiên",
        weight: 0,
        skip: true
      }];
    }

    const diceRule = rules.dice[diceClass.type];
    if (diceRule && diceRule.has_edge) {
      signals.push({
        source: "rule_dice",
        label: diceRule.label,
        predict: diceRule.predict,
        rate: diceRule.rate,
        weight: 3.0,
        samples: diceRule.total,
        note: `Học từ ${diceRule.total} mẫu thực tế`
      });
    }
  }

  // 2. STREAK
  let streakCount = 1;
  for (let i = sessions.length - 2; i >= 0; i--) {
    if (sessions[i].result === last.result) streakCount++;
    else break;
  }
  if (streakCount >= 3) {
    const key = `BET_${last.result}_${streakCount}`;
    const streakRule = rules.streak[key];
    if (streakRule && streakRule.has_edge) {
      signals.push({
        source: "rule_bet",
        label: streakRule.label,
        predict: streakRule.predict,
        rate: streakRule.rate,
        weight: 2.0,
        samples: streakRule.total,
        note: `Học từ ${streakRule.total} mẫu thực tế`
      });
    }
  }

  // 3. SCORE (yếu)
  const scoreKey = `${last.result}_${last.score}`;
  const scoreRule = rules.score[scoreKey];
  if (scoreRule && scoreRule.has_edge) {
    signals.push({
      source: "rule_score",
      label: scoreRule.label,
      predict: scoreRule.predict,
      rate: scoreRule.rate,
      weight: 0.5,
      samples: scoreRule.total,
      note: `Học từ ${scoreRule.total} mẫu`
    });
  }

  return signals;
}

/* ================================================================
 *  ENSEMBLE VOTING
 * ================================================================ */
function ensembleVote(signals) {
  let vB = 0, vT = 0, wSum = 0;
  const used = [];

  for (const sig of signals) {
    if (!sig || !sig.predict) continue;
    const w = (sig.weight || 1) * (sig.rate / 100) * Math.log10(1 + (sig.samples || 10));
    if (sig.predict === 'TAI') vB += w;
    else vT += w;
    wSum += w;
    used.push(sig);
  }

  if (wSum === 0) return null;

  const pB = vB / wSum, pT = vT / wSum;
  const predict = pB >= pT ? 'TAI' : 'XIU';
  const agreement = predict === 'TAI' ? pB : pT;
  const disagreement = 1 - agreement;

  let confidence = Math.round(50 + agreement * 50);
  if (disagreement > 0.35) confidence = Math.min(confidence, 60);
  if (agreement > 0.75)    confidence = Math.min(confidence + 5, 95);

  const strongDice = used.find(s => s.source === 'rule_dice' && s.rate >= 70);
  if (strongDice && strongDice.predict === predict) {
    confidence = Math.min(confidence + 8, 97);
  }

  confidence = Math.max(52, Math.min(confidence, 97));

  const reasons = used.map(s => {
    const icon = s.predict === 'TAI' ? '🔵' : '🔴';
    const srcName = {
      rule_dice:  `🎲 ${s.label}`,
      rule_bet:   `🔥 ${s.label}`,
      rule_score: `📌 ${s.label}`
    }[s.source] || s.label;
    return `${icon} ${srcName} → ${s.predict} ${s.rate}%`;
  });

  return { predict, confidence, reasons, signals: used, disagreement };
}

/* ================================================================
 *  PREDICT
 * ================================================================ */
function predict(history, rules) {
  if (history.length < 20) {
    return {
      predict: 'WAIT',
      confidence: 0,
      reason: `⏳ Chưa đủ mẫu học (${history.length}/50 phiên) — Vui lòng chờ`,
      signals: [],
      skip: true,
      disagreement: 0
    };
  }

  const sessions = [...history].reverse();
  const signals = ruleEngine(sessions, rules);

  const bao = signals.find(s => s.skip);
  if (bao) {
    return {
      predict: 'NGHI',
      confidence: 100,
      reason: `⛔ ${bao.note}`,
      signals,
      skip: true,
      disagreement: 0
    };
  }

  const validSignals = signals.filter(s => s.predict);

  if (validSignals.length === 0) {
    return {
      predict: 'SKIP',
      confidence: 0,
      reason: '⚠️ Không có tín hiệu đủ mạnh → ĐỨNG NGOÀI',
      signals: [],
      skip: true,
      disagreement: 0
    };
  }

  const vote = ensembleVote(validSignals);
  if (!vote || vote.confidence < 65) {
    return {
      predict: 'SKIP',
      confidence: vote?.confidence || 0,
      reason: `⚠️ Confidence thấp → ĐỨNG NGOÀI`,
      signals: vote?.signals || [],
      skip: true,
      disagreement: vote?.disagreement || 0
    };
  }

  return {
    predict: vote.predict,
    confidence: vote.confidence,
    reason: vote.reasons.join(' | '),
    signals: vote.signals,
    skip: false,
    disagreement: vote.disagreement
  };
}
// ============================================================
//  PHẦN 4/5: PARSE API + FETCH + LOG + HELPERS
// ============================================================

/* ================================================================
 *  PARSE DỮ LIỆU TỪ API
 * ================================================================ */
function parseLinesHu(data) {
  if (!data || !Array.isArray(data.list)) return [];
  return data.list.map(item => ({
    session: item.id,
    dice: item.dices,
    score: item.point,
    result: item.point >= 11 ? 'TAI' : 'XIU'
  })).sort((a, b) => a.session - b.session);
}

function parseLinesMd5(data) {
  if (!data || !Array.isArray(data.list)) return [];
  return data.list.map(item => ({
    session: item.id,
    dice: item.dices,
    score: item.point,
    result: item.resultTruyenThong === 'Tài' ? 'TAI' : 'XIU'
  })).sort((a, b) => a.session - b.session);
}

/* ================================================================
 *  FETCH HŨ
 * ================================================================ */
async function fetchHuData() {
  try {
    const res = await fetch(API_URL_HU);
    const data = await res.json();
    const newHistory = parseLinesHu(data);
    if (newHistory.length === 0) return;

    const lastSession = newHistory.at(-1);

    if (!currentSessionIdHu) {
      huHistory = newHistory.slice().reverse();
      currentSessionIdHu = lastSession.session;
      console.log(`✅ [HŨ] Đã tải ${newHistory.length} phiên`);
    } else if (lastSession.session > currentSessionIdHu) {
      const newRecords = newHistory.filter(r => r.session > currentSessionIdHu);
      for (const r of newRecords) huHistory.unshift(r);
      if (huHistory.length > 2000) huHistory = huHistory.slice(0, 1500);
      currentSessionIdHu = lastSession.session;
      console.log(`🆕 [HŨ] +${newRecords.length} phiên | Tổng: ${huHistory.length}`);
    }

    HU_RULES = relearnRules(huHistory, HU_RULES);
    verifyPredictions(huPredictionLog, huHistory);
  } catch (e) {
    console.error(`❌ [HŨ] Lỗi:`, e.message);
  }
}

/* ================================================================
 *  FETCH MD5
 * ================================================================ */
async function fetchMd5Data() {
  try {
    const res = await fetch(API_URL_MD5);
    const data = await res.json();
    const newHistory = parseLinesMd5(data);
    if (newHistory.length === 0) return;

    const lastSession = newHistory.at(-1);

    if (!currentSessionIdMd5) {
      md5History = newHistory.slice().reverse();
      currentSessionIdMd5 = lastSession.session;
      console.log(`✅ [MD5] Đã tải ${newHistory.length} phiên`);
    } else if (lastSession.session > currentSessionIdMd5) {
      const newRecords = newHistory.filter(r => r.session > currentSessionIdMd5);
      for (const r of newRecords) md5History.unshift(r);
      if (md5History.length > 2000) md5History = md5History.slice(0, 1500);
      currentSessionIdMd5 = lastSession.session;
      console.log(`🆕 [MD5] +${newRecords.length} phiên | Tổng: ${md5History.length}`);
    }

    MD5_RULES = relearnRules(md5History, MD5_RULES);
    verifyPredictions(md5PredictionLog, md5History);
  } catch (e) {
    console.error(`❌ [MD5] Lỗi:`, e.message);
  }
}

/* ================================================================
 *  PREDICTION LOG
 * ================================================================ */
function recordPrediction(log, session, prediction) {
  if (log.find(p => p.session === session)) return;
  if (prediction.skip) return;

  log.push({
    session,
    predict: prediction.predict,
    confidence: prediction.confidence,
    reason: prediction.reason,
    actual: null,
    correct: null
  });
  if (log.length > 500) log.splice(0, log.length - 500);
}

function verifyPredictions(log, history) {
  const map = new Map(history.map(h => [h.session, h]));
  for (const p of log) {
    if (p.actual === null && map.has(p.session)) {
      const h = map.get(p.session);
      p.actual = h.result;
      p.correct = p.predict === p.actual;
    }
  }
}

function buildHistoryReport(log, limit = 50) {
  const finished = log
    .filter(p => p.actual !== null)
    .sort((a, b) => b.session - a.session)
    .slice(0, limit);

  const total = finished.length;
  const dung  = finished.filter(p => p.correct).length;
  const sai   = total - dung;

  let winStreak = 0, lossStreak = 0;
  const sorted = [...log].filter(x => x.actual !== null).sort((a, b) => b.session - a.session);
  for (const p of sorted) {
    if (p.correct) { if (lossStreak === 0) winStreak++; else break; }
    else           { if (winStreak === 0) lossStreak++; else break; }
  }

  const history = finished.map(p => ({
    phien:      p.session,
    du_doan:    p.predict === 'TAI' ? 'tài' : 'xỉu',
    do_tin_cay: `${p.confidence}%`,
    ket_qua:    p.actual === 'TAI' ? 'tài' : 'xỉu',
    check:      p.correct ? 'đúng✅' : 'sai❌'
  }));

  return {
    history,
    thong_ke: {
      tong: total,
      dung,
      sai,
      ti_le: total > 0 ? `${(dung / total * 100).toFixed(1)}%` : '0%',
      win_streak: winStreak,
      loss_streak: lossStreak
    }
  };
}

/* ================================================================
 *  HELPERS
 * ================================================================ */
function checkKey(query) {
  const userKey = query.key;
  if (!userKey || userKey !== VALID_KEY) {
    return { valid: false, error: "sai key rồi mua key đi adSika88" };
  }
  return { valid: true };
}

function buildResponse(history, gameName, log, rules) {
  const last = history[0];
  const result = predict(history, rules);

  if (result.skip) {
    return {
      id: ADMIN_ID,
      game: gameName,
      phien_truoc: last.session,
      xuc_xac: `${last.dice[0]} - ${last.dice[1]} - ${last.dice[2]}`,
      ket_qua: last.result === 'TAI' ? 'tài' : 'xỉu',
      tong: last.score,
      phien_nay: last.session + 1,
      du_doan: result.predict === 'NGHI' ? 'NGHỈ ⛔' : result.predict === 'WAIT' ? 'CHỜ DỮ LIỆU ⏳' : 'ĐỨNG NGOÀI ⚠️',
      do_tin_cay: `${result.confidence}%`,
      ly_do: result.reason,
      so_tin_hieu: result.signals?.length || 0,
      rules_da_hoc: {
        dice: Object.keys(rules.dice).length,
        streak: Object.keys(rules.streak).length,
        score: Object.keys(rules.score).length,
        tong_mau: rules.meta.total
      }
    };
  }

  recordPrediction(log, last.session + 1, result);

  return {
    id: ADMIN_ID,
    game: gameName,
    phien_truoc: last.session,
    xuc_xac: `${last.dice[0]} - ${last.dice[1]} - ${last.dice[2]}`,
    ket_qua: last.result === 'TAI' ? 'tài' : 'xỉu',
    tong: last.score,
    phien_nay: last.session + 1,
    du_doan: result.predict === 'TAI' ? 'tài' : 'xỉu',
    do_tin_cay: `${result.confidence}%`,
    ly_do: result.reason,
    so_tin_hieu: result.signals?.length || 0,
    do_bat_dong: result.disagreement ? `${(result.disagreement * 100).toFixed(0)}%` : '0%',
    rules_da_hoc: {
      dice: Object.keys(rules.dice).length,
      streak: Object.keys(rules.streak).length,
      score: Object.keys(rules.score).length,
      tong_mau: rules.meta.total
    }
  };
}
// ============================================================
//  PHẦN 5/5: FASTIFY SERVER + ROUTES + START
// ============================================================

const app = fastify({ logger: false });
await app.register(cors, { origin: "*" });

/* ---------- ROUTE GỐC ---------- */
app.get("/", async () => ({
  status: "active",
  message: "API Tài Xỉu v3 — Học online từ API (không cần file mẫu)",
  key: VALID_KEY,
  endpoints: {
    hu:          `/api/taixiu/lc789?key=${VALID_KEY}`,
    md5:         `/api/md5/lc789?key=${VALID_KEY}`,
    hu_history:  `/api/taixiu/lc789/prediction-history?key=${VALID_KEY}`,
    md5_history: `/api/md5/lc789/prediction-history?key=${VALID_KEY}`,
    hu_raw:      `/api/taixiu/lc789/raw-history?key=${VALID_KEY}`,
    md5_raw:     `/api/md5/lc789/raw-history?key=${VALID_KEY}`,
    hu_rules:    `/api/taixiu/lc789/rules?key=${VALID_KEY}`,
    md5_rules:   `/api/md5/lc789/rules?key=${VALID_KEY}`
  }
}));

/* -------- HŨ -------- */
app.get("/api/taixiu/lc789", async (request, reply) => {
  const k = checkKey(request.query);
  if (!k.valid) return reply.status(401).send({ error: k.error });

  if (huHistory.length < 5) {
    return reply.status(503).send({
      error: "Đang tải dữ liệu HŨ...",
      need: 50,
      current: huHistory.length,
      eta: "Chờ khoảng 5-10 phút để tích lũy đủ mẫu"
    });
  }

  const res = buildResponse(huHistory, "HŨ", huPredictionLog, HU_RULES);
  const hist = buildHistoryReport(huPredictionLog, 30);
  return { ...res, history: hist.history, thong_ke: hist.thong_ke };
});

/* -------- MD5 -------- */
app.get("/api/md5/lc789", async (request, reply) => {
  const k = checkKey(request.query);
  if (!k.valid) return reply.status(401).send({ error: k.error });

  if (md5History.length < 5) {
    return reply.status(503).send({
      error: "Đang tải dữ liệu MD5...",
      need: 50,
      current: md5History.length
    });
  }

  const res = buildResponse(md5History, "MD5", md5PredictionLog, MD5_RULES);
  const hist = buildHistoryReport(md5PredictionLog, 30);
  return { ...res, history: hist.history, thong_ke: hist.thong_ke };
});

/* -------- HISTORY -------- */
app.get("/api/taixiu/lc789/prediction-history", async (request, reply) => {
  const k = checkKey(request.query);
  if (!k.valid) return reply.status(401).send({ error: k.error });
  const limit = Math.min(parseInt(request.query.limit) || 30, 200);
  return buildHistoryReport(huPredictionLog, limit);
});

app.get("/api/md5/lc789/prediction-history", async (request, reply) => {
  const k = checkKey(request.query);
  if (!k.valid) return reply.status(401).send({ error: k.error });
  const limit = Math.min(parseInt(request.query.limit) || 30, 200);
  return buildHistoryReport(md5PredictionLog, limit);
});

/* -------- RAW -------- */
app.get("/api/taixiu/lc789/raw-history", async (request, reply) => {
  const k = checkKey(request.query);
  if (!k.valid) return reply.status(401).send({ error: k.error });
  return huHistory.slice(0, 30).map(i => ({
    session: i.session, dice: i.dice, total: i.score,
    result: i.result === 'TAI' ? 'tài' : 'xỉu'
  }));
});

app.get("/api/md5/lc789/raw-history", async (request, reply) => {
  const k = checkKey(request.query);
  if (!k.valid) return reply.status(401).send({ error: k.error });
  return md5History.slice(0, 30).map(i => ({
    session: i.session, dice: i.dice, total: i.score,
    result: i.result === 'TAI' ? 'tài' : 'xỉu'
  }));
});

/* -------- RULES -------- */
app.get("/api/taixiu/lc789/rules", async (request, reply) => {
  const k = checkKey(request.query);
  if (!k.valid) return reply.status(401).send({ error: k.error });
  return HU_RULES;
});

app.get("/api/md5/lc789/rules", async (request, reply) => {
  const k = checkKey(request.query);
  if (!k.valid) return reply.status(401).send({ error: k.error });
  return MD5_RULES;
});

/* -------- CHECK KEY -------- */
app.get("/check-key", async (request) => {
  const userKey = request.query.key;
  if (!userKey || userKey !== VALID_KEY) {
    return { status: "error", message: "sai key rồi mua key đi adSika88" };
  }
  return { status: "success", message: "KEY HỢP LỆ" };
});

/* ================================================================
 *  START SERVER
 * ================================================================ */
const start = async () => {
  console.log("🚀 Tải dữ liệu từ API...");
  await Promise.all([fetchHuData(), fetchMd5Data()]);

  // Polling mỗi 5 giây
  setInterval(fetchHuData, 5000);
  setInterval(fetchMd5Data, 5000);

  // Log rules mỗi 5 phút
  setInterval(() => {
    console.log(`\n📊 RULES HIỆN TẠI:`);
    console.log(`   [HŨ]  ${HU_RULES.meta.total} mẫu | Dice: ${Object.keys(HU_RULES.dice).length} | Streak: ${Object.keys(HU_RULES.streak).length} | Score: ${Object.keys(HU_RULES.score).length}`);
    console.log(`   [MD5] ${MD5_RULES.meta.total} mẫu | Dice: ${Object.keys(MD5_RULES.dice).length} | Streak: ${Object.keys(MD5_RULES.streak).length} | Score: ${Object.keys(MD5_RULES.score).length}`);
  }, 5 * 60 * 1000);

  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
  } catch (err) {
    console.error("❌ Lỗi khởi động:", err.message);
    process.exit(1);
  }

  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  TÀI XỈU VIP v3 — HỌC ONLINE TỪ API (KHÔNG CẦN FILE MẪU)      ║");
  console.log("╠══════════════════════════════════════════════════════════════════╣");
  console.log(`║  🚀 Port: ${PORT}`);
  console.log(`║  🔑 KEY:  ${VALID_KEY}`);
  console.log(`║  👤 ADMIN: ${ADMIN_ID}`);
  console.log("║                                                                  ║");
  console.log("║  📊 SERVER SẼ TỰ HỌC RULES SAU KHI TÍCH LŨY ĐỦ MẪU:            ║");
  console.log("║     • 50+ phiên   → bắt đầu có rules                          ║");
  console.log("║     • 200+ phiên  → rules ổn định                             ║");
  console.log("║     • 500+ phiên  → rules chính xác cao                       ║");
  console.log("║                                                                  ║");
  console.log("║  ⏳ Thời gian chờ (polling 5s/phiên):                          ║");
  console.log("║     • ~5 phút  → 50 phiên                                     ║");
  console.log("║     • ~20 phút → 200 phiên                                    ║");
  console.log("║     • ~45 phút → 500 phiên                                    ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");
};

start();