// 混合评分模型 + 投递档案（Job Intelligence Layer 的第三、四层）
// MatchScore = 结构化匹配 40%（代码规则，确定性、零成本）+ LLM 语义匹配 60%（来自 jdIntel）。
// 每条被分析的岗位落一条"投递档案"到 data/applications.json（键 = job.id），
// 为未来投递管理 / 状态追踪 / 简历版本管理预留 application 块。
const store = require('./store');
const jdIntel = require('./jdIntel');

// ---------- 一、结构化匹配（40%，代码规则） ----------
// 画像能力项（coreCompetencies + skills + strengths.tags）与 JD 文本的短语重叠命中计分。
// 命中判定三级递进（越靠前越强）：
//   1) JD 文本逐字包含能力词；
//   2) JD 词组与能力词互相包含（仿 jobSearch.js:214-216）；
//   3) 字符二元组软匹配：能力词的 bigram 在 JD 文本中的覆盖率 ≥ 50%
//      ——解决"达人营销与BD" vs "达人合作进行营销BD"这类措辞不同但语义重叠的情况。
// 归一化 0-100，确定性、可解释、不耗 token。
function bigramHitRatio(term, text) {
  const chars = String(term).replace(/\s+/g, '').split('');
  const grams = new Set();
  for (let i = 0; i < chars.length - 1; i++) grams.add(chars[i] + chars[i + 1]);
  if (!grams.size) return 0;
  let hit = 0;
  for (const g of grams) if (text.includes(g)) hit++;
  return hit / grams.size;
}

function structuredScore(profile, jdText) {
  const pool = [];
  const push = (terms) => {
    for (const t of terms || []) {
      const s = String(t).trim();
      if (s.length >= 2 && !pool.includes(s)) pool.push(s);
    }
  };
  push(profile.coreCompetencies);
  push(profile.skills);
  push((profile.strengths || []).map((x) => x.tag));
  if (!pool.length) return 50; // 画像尚无能力项，给中性分，不拖垮语义分

  const text = String(jdText || '');
  const tokens = text.split(/[、，。,.;；:：\s\n/｜|（）()\[\]【】"“”'‘’·\-—]/).filter((w) => w.length >= 2);
  let hits = 0;
  for (const k of pool) {
    if (text.includes(k)) { hits++; continue; }
    if (tokens.some((t) => t.includes(k) || k.includes(t))) { hits++; continue; }
    if (bigramHitRatio(k, text) >= 0.5) hits++;
  }
  return Math.round((hits / pool.length) * 100);
}

// ---------- 二、grade 定级 ----------
function gradeOf(score) {
  if (score >= 80) return '高';
  if (score >= 60) return '中';
  return '低';
}

// ---------- 二·五、综合岗位价值评分（推荐 v2） ----------
// 平台价值（代码规则，确定性、零成本）：央国企/事业单位与稳就业、大厂与高成长性。
function platformScoreOf(job) {
  const type = (job && job.companyType) || '';
  if (type === 'soe') return 88;
  if (type === 'bigtech') return 85;
  return 58;
}

// 综合岗位价值评分 = 0.35×匹配 + 0.25×价值 + 0.20×成长 + 0.10×(100−竞争) + 0.10×平台
// （用户选择·均衡型权重；competition 是"越难分越高"，故用 100−competition 折算为利好项）
function recScoreOf({ match, value, growth, competition, platform }) {
  const m = Number(match) || 0;
  const v = Number(value) || 0;
  const g = Number(growth) || 0;
  const c = Number(competition) || 0;
  const p = Number(platform) || 0;
  return Math.max(0, Math.min(100, Math.round(0.35 * m + 0.25 * v + 0.20 * g + 0.10 * (100 - c) + 0.10 * p)));
}

// A/B/C/D 分层（按顺序判定）——匹配一般但高价值/高成长/高平台的不淘汰，转探索投递
function tierOf({ match, value, growth, platform }) {
  const m = Number(match) || 0;
  const v = Number(value) || 0;
  const g = Number(growth) || 0;
  const p = Number(platform) || 0;
  if (m >= 70 && (v >= 70 || g >= 70)) return 'A';
  if (m >= 55 && (v >= 75 || g >= 75)) return 'B';
  if ((v >= 75 || g >= 80 || p >= 85) && m >= 40) return 'C';
  if (m >= 50) return 'C';
  return 'D';
}

function priorityOf(tier) {
  if (tier === 'A') return '重点投递';
  if (tier === 'B') return '重点冲刺';
  if (tier === 'C') return '探索投递';
  return '减少投入';
}

// 竞争档位文案：≥75 激烈 / 50-74 适中 / <50 容易
function competitionLabel(score) {
  const n = Number(score);
  if (n >= 75) return '激烈';
  if (n >= 50) return '适中';
  return '容易';
}

// ---------- 三、编排：语义分析 + 混合分 + 落 applications.json ----------
function emptyApplication(job) {
  return {
    jobId: job.id,
    company: job.company || '',
    title: job.title || '',
    url: job.url || '',
    platform: job.platform || '',
    jd: { text: '', unit: '', position: '', summary: '', requirements: [], status: '', publishDate: '', source: '' },
    explanation: { overview: '', daily: [], growth: [] },
    match: { structuredScore: 0, semanticScore: 0, matchScore: 0, grade: '', reasons: [], gaps: [], resumeAdvice: [] },
    rec: {
      resumeMatch: 0,
      careerValue: { score: 0, reasons: [] },
      growth: { score: 0, reasons: [] },
      competition: { score: 0, reasons: [], barrier: '' },
      platformScore: 0,
      recScore: 0,
      tier: '',
      priority: '',
      recommendReason: '',
      risks: [],
    },
    profile: { profileId: '', version: 1 },
    application: { status: '意向', appliedAt: null, resumeVersion: 'v1', resumeHistory: [] },
    analyzedAt: '',
  };
}

// 由 matchScore + LLM 分析 + job 合成 rec 推荐块
function buildRec({ matchScore, analysis, job }) {
  const value = analysis.careerValue.score;
  const growth = analysis.growth.score;
  const competition = analysis.competition.score;
  const platform = platformScoreOf(job);
  const recScore = recScoreOf({ match: matchScore, value, growth, competition, platform });
  const tier = tierOf({ match: matchScore, value, growth, platform });
  return {
    resumeMatch: matchScore,
    careerValue: { score: value, reasons: analysis.careerValue.reasons },
    growth: { score: growth, reasons: analysis.growth.reasons },
    competition: { score: competition, reasons: analysis.competition.reasons, barrier: analysis.competition.barrier },
    platformScore: platform,
    recScore,
    tier,
    priority: priorityOf(tier),
    recommendReason: analysis.recommendReason,
    risks: analysis.risks,
  };
}

async function computeMatch(profile, job, jdText) {
  const all = store.load('applications', {});
  const prev = all[job.id] || emptyApplication(job);
  // 未传 jdText 时，回退到之前已保存的用户输入 JD（保证重分析/批量分析不丢文本）
  const prevUserJd = prev.jd && prev.jd.source === 'user-input' ? prev.jd.text : '';
  const effectiveJd = jdIntel.buildJobText(job, jdText || prevUserJd);
  const source = (jdText && String(jdText).trim()) || prevUserJd ? 'user-input' : 'existing';
  const analysis = await jdIntel.analyzeJob(profile, job, effectiveJd);

  const structured = structuredScore(profile, effectiveJd);
  const semantic = analysis.semanticScore;
  const matchScore = Math.round(0.4 * structured + 0.6 * semantic);

  // application 块（投递状态）不可被分析覆盖
  const app = {
    ...prev,
    jobId: job.id,
    company: job.company || '',
    title: job.title || '',
    url: job.url || '',
    platform: job.platform || '',
    jd: {
      text: source === 'user-input' ? effectiveJd : (prev.jd && prev.jd.text ? prev.jd.text : effectiveJd),
      unit: analysis.unit,
      position: analysis.position,
      summary: analysis.summary,
      requirements: analysis.requirements,
      status: analysis.status,
      publishDate: analysis.publishDate,
      source: source === 'user-input' ? 'user-input' : (prev.jd && prev.jd.source) || 'existing',
    },
    explanation: analysis.explanation,
    match: {
      structuredScore: structured,
      semanticScore: semantic,
      matchScore,
      grade: gradeOf(matchScore),
      reasons: analysis.matchReasons,
      gaps: analysis.gaps,
      resumeAdvice: analysis.resumeAdvice,
    },
    rec: buildRec({ matchScore, analysis, job }),
    profile: { profileId: profile.generatedAt || '', version: profile.version || 1 },
    application: prev.application || { status: '意向', appliedAt: null, resumeVersion: 'v1', resumeHistory: [] },
    analyzedAt: new Date().toISOString(),
  };
  all[job.id] = app;
  store.save('applications', all);
  return app;
}

// ---------- 四、applications.json 读写辅助 ----------
function getApplication(jobId) {
  const all = store.load('applications', {});
  return all[jobId] || null;
}

// 保存用户手动输入的 JD 文本（不改动已有分析，仅记文本与来源）
function saveJdText(job, jdText) {
  const all = store.load('applications', {});
  const prev = all[job.id] || emptyApplication(job);
  prev.jd = {
    ...prev.jd,
    text: String(jdText || '').trim(),
    source: String(jdText || '').trim() ? 'user-input' : 'existing',
  };
  all[job.id] = prev;
  store.save('applications', all);
  return prev;
}

// ---------- 五、批量分析已确认岗位（仿 jobSearch enrichState 可停止状态机） ----------
let analyzeState = { running: false, stop: false, step: '', log: [], done: 0, total: 0 };

function getAnalyzeState() {
  return analyzeState;
}

function stopAnalyze() {
  analyzeState.stop = true;
}

async function runAnalyzeAll(onProgress) {
  if (analyzeState.running) {
    return Promise.reject(new Error('已有批量分析任务正在进行，请等待完成或先停止。'));
  }
  const jobs = store.load('jobs', []);
  const targets = jobs.filter((j) => j.status === 'confirmed');
  if (!targets.length) return Promise.resolve({ done: 0, total: 0, skipped: 0 });

  const profile = store.load('profile', null);
  if (!profile || (!profile.professionalIdentity && !(profile.coreCompetencies || []).length)) {
    return Promise.reject(new Error('还没有职业画像，请先在「我的职业画像」页生成画像。'));
  }

  const all = store.load('applications', {});
  // 迁移：旧档案只有 match.matchScore 没有 rec.recScore，也要重跑补齐推荐层
  const pending = targets.filter((j) => !(all[j.id] && all[j.id].rec && Number.isFinite(all[j.id].rec.recScore)));
  const skipped = targets.length - pending.length;

  analyzeState = { running: true, stop: false, step: '准备中', log: [], done: 0, total: pending.length };
  const log = (msg) => {
    analyzeState.log.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);
    if (analyzeState.log.length > 200) analyzeState.log.shift();
    if (onProgress) onProgress(msg);
  };
  log(`已确认岗位 ${targets.length} 个，其中 ${skipped} 个已分析过将跳过，待分析 ${pending.length} 个。`);

  return (async () => {
    let done = 0;
    try {
      for (let i = 0; i < pending.length; i++) {
        if (analyzeState.stop) {
          log('已停止（用户手动中断）');
          break;
        }
        const job = pending[i];
        analyzeState.step = `分析中 ${i + 1}/${pending.length}：${job.company} ${job.title}`;
        log(`▶ ${job.company} · ${job.title}`);
        try {
          const app = await computeMatch(profile, job); // 未传 jdText → 回退现有字段
          log(`  ✓ 分析完成（综合 ${app.rec.recScore} 分 / ${app.rec.tier}类，简历匹配 ${app.match.matchScore} 分）`);
        } catch (e) {
          log(`  ✗ 分析失败：${e.message.slice(0, 80)}`);
        }
        done++;
        analyzeState.done = done;
      }
      log(`批量分析完成：成功处理 ${done}/${pending.length} 个岗位。`);
    } finally {
      analyzeState.running = false;
      analyzeState.step = analyzeState.stop ? '已停止' : '完成';
      analyzeState.done = done;
    }
    return { done, total: pending.length, skipped };
  })();
}

module.exports = {
  structuredScore,
  gradeOf,
  platformScoreOf,
  recScoreOf,
  tierOf,
  priorityOf,
  competitionLabel,
  buildRec,
  computeMatch,
  getApplication,
  saveJdText,
  runAnalyzeAll,
  getAnalyzeState,
  stopAnalyze,
};
