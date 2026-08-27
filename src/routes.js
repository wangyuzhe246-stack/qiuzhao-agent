// REST 路由：设置 / 简历 / 找岗 / 材料 / 跟踪 / 画像 / 匹配分析
const path = require('path');
const fs = require('fs');
const express = require('express');
const store = require('./store');
const llm = require('./llm');
const resumeMod = require('./resume');
const jobSearch = require('./jobSearch');
const tailoring = require('./tailoring');
const resumeFile = require('./resumeFile');
const profileMod = require('./profile');
const matchMod = require('./match');
const resumeMapper = require('./resumeMapper');
const pdfClient = require('./pdfClient');
const resumeVersions = require('./resumeVersions');

const router = express.Router();
const PROJECT_ROOT = path.join(__dirname, '..');

// ---------------- 设置 ----------------
function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****' + key.slice(-4);
  return key.slice(0, 5) + '****' + key.slice(-4);
}

router.get('/settings', (req, res) => {
  const s = store.load('settings', {});
  res.json({
    apiKeySet: !!(s.apiKey && s.apiKey.trim()),
    apiKeyMasked: s.apiKey ? maskKey(s.apiKey) : '',
    cities: s.cities || ['北京', '上海', '广州', '深圳', '杭州'],
    keywords: s.keywords || [],
    major: s.major || '电子商务',
    companyPref: s.companyPref || '央企/国企优先，其次大厂',
    autoRefresh: !!s.autoRefresh,
    sources: jobSearch.getSources(),
  });
});

router.put('/settings', (req, res) => {
  const body = req.body || {};
  const s = store.load('settings', {});
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) s.apiKey = body.apiKey.trim();
  if (Array.isArray(body.cities)) s.cities = body.cities.map((c) => String(c).trim()).filter(Boolean);
  if (Array.isArray(body.keywords)) s.keywords = body.keywords.map((k) => String(k).trim()).filter(Boolean);
  if (typeof body.major === 'string') s.major = body.major.trim();
  if (typeof body.companyPref === 'string') s.companyPref = body.companyPref.trim();
  if (typeof body.autoRefresh === 'boolean') s.autoRefresh = body.autoRefresh;
  store.save('settings', s);
  res.json({ ok: true });
});

router.post('/settings/test', async (req, res) => {
  try {
    const r = await llm.testConnection();
    res.json(r);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---------------- 简历 ----------------
router.get('/resume', (req, res) => {
  const r = store.load('resume', null);
  if (!r) return res.json({ exists: false, resume: null });
  const { rawText, ...clean } = r;
  res.json({ exists: true, resume: clean });
});

router.put('/resume', (req, res) => {
  const r = req.body || {};
  if (!r.basic) return res.status(400).json({ ok: false, error: '简历结构不完整' });
  const prev = store.load('resume', {});
  r.rawText = prev.rawText || '';
  r.updatedAt = new Date().toISOString();
  store.save('resume', r);
  res.json({ ok: true });
});

router.post('/resume/upload', resumeMod.upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: '没有收到文件' });
    if (!llm.getApiKey()) return res.status(400).json({ ok: false, error: '还没有设置 DeepSeek API Key，请先到「设置」页填写并保存。' });
    const rawText = await resumeMod.extractText(req.file.buffer, req.file.originalname);
    if (!rawText || rawText.trim().length < 20) {
      return res.status(400).json({ ok: false, error: '未能从文件中提取到文本，请确认文件内容或改用「粘贴文字」' });
    }
    const structured = await resumeMod.structureResume(rawText);
    store.save('resume', structured);
    res.json({ ok: true, resume: structured, source: req.file.originalname });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/resume/paste', async (req, res) => {
  try {
    if (!llm.getApiKey()) return res.status(400).json({ ok: false, error: '还没有设置 DeepSeek API Key，请先到「设置」页填写并保存。' });
    const text = (req.body && req.body.text) || '';
    if (text.trim().length < 20) return res.status(400).json({ ok: false, error: '文本太短，请粘贴完整简历内容' });
    const structured = await resumeMod.structureResume(text);
    store.save('resume', structured);
    res.json({ ok: true, resume: structured, source: 'paste' });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---------------- 找岗 ----------------
router.post('/jobs/search', async (req, res) => {
  if (!llm.getApiKey()) {
    return res.status(400).json({ ok: false, error: '还没有设置 DeepSeek API Key，请先到「设置」页填写并保存。' });
  }
  try {
    const r = await jobSearch.runSearch();
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get('/search/status', (req, res) => {
  res.json(jobSearch.getSearchState());
});

router.post('/search/stop', (req, res) => {
  jobSearch.stopSearch();
  jobSearch.stopEnrich();
  res.json({ ok: true });
});

// 批量补充岗位福利信息（薪资/双休/险种/补贴 + 福利评级）
router.post('/jobs/enrich', async (req, res) => {
  if (!llm.getApiKey()) {
    return res.status(400).json({ ok: false, error: '还没有设置 DeepSeek API Key，请先到「设置」页填写并保存。' });
  }
  try {
    const r = await jobSearch.runEnrichBenefits();
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get('/jobs', (req, res) => {
  const jobs = store.load('jobs', []);
  const status = req.query.status;
  const list = status ? jobs.filter((j) => j.status === status) : jobs;
  res.json({ total: jobs.length, jobs: list.slice().reverse() });
});

router.post('/jobs/:id/confirm', async (req, res) => {
  const jobs = store.load('jobs', []);
  const j = jobs.find((x) => x.id === req.params.id);
  if (!j) return res.status(404).json({ ok: false, error: '岗位不存在' });
  j.status = 'confirmed';
  j.confirmedAt = new Date().toISOString();
  store.save('jobs', jobs);
  res.json({ ok: true, job: j });
});

router.post('/jobs/:id/skip', (req, res) => {
  const jobs = store.load('jobs', []);
  const j = jobs.find((x) => x.id === req.params.id);
  if (!j) return res.status(404).json({ ok: false, error: '岗位不存在' });
  j.status = 'skipped';
  store.save('jobs', jobs);
  res.json({ ok: true });
});

router.delete('/jobs/:id', (req, res) => {
  const jobs = store.load('jobs', []);
  store.save('jobs', jobs.filter((x) => x.id !== req.params.id));
  res.json({ ok: true });
});

// ---------------- 材料定制 ----------------
router.post('/jobs/:id/tailor', async (req, res) => {
  try {
    const jobs = store.load('jobs', []);
    const job = jobs.find((x) => x.id === req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: '岗位不存在' });
    const resume = store.load('resume', null);
    if (!resume || !resume.basic) return res.status(400).json({ ok: false, error: '还没有简历，请先到「我的简历」上传或填写' });
    const materials = await tailoring.generateMaterials(job, resume);
    const all = store.load('materials', {});
    all[job.id] = { jobId: job.id, company: job.company, title: job.title, ...materials };
    store.save('materials', all);
    // 版本管理：每次生成/重新生成都追加一个定制版快照（历史版本），PDF 生成时回填路径
    const version = resumeVersions.recordTailor(job, {
      content: materials.tailoredResume,
      optimizationReason: materials.optimizationReason,
      jdMatchPoints: materials.jdMatchPoints,
      jdKeywords: job.keywordsMatched || [],
    });
    res.json({ ok: true, materials: all[job.id], version });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get('/materials', (req, res) => {
  const all = store.load('materials', {});
  res.json({ items: all });
});

router.put('/materials/:id', (req, res) => {
  const all = store.load('materials', {});
  if (!all[req.params.id]) return res.status(404).json({ ok: false, error: '材料不存在' });
  all[req.params.id] = { ...all[req.params.id], ...(req.body || {}), updatedAt: new Date().toISOString() };
  store.save('materials', all);
  res.json({ ok: true });
});

router.get('/materials/:id/export', (req, res) => {
  const all = store.load('materials', {});
  const m = all[req.params.id];
  if (!m) return res.status(404).json({ ok: false, error: '材料不存在' });
  const jobs = store.load('jobs', []);
  const job = jobs.find((x) => x.id === req.params.id) || { company: m.company, title: m.title, location: '', platform: '', url: '' };
  const md = tailoring.materialsToMarkdown(job, m);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${job.company}-${job.title}-投递材料包.md`)}`);
  res.send(md);
});

// 每岗定制简历导出（Word 兼容 .doc）
router.get('/materials/:id/resume-file', (req, res) => {
  const all = store.load('materials', {});
  const m = all[req.params.id];
  if (!m) return res.status(404).json({ ok: false, error: '材料不存在，请先生成投递材料' });
  const jobs = store.load('jobs', []);
  const job = jobs.find((x) => x.id === req.params.id) || { company: m.company, title: m.title };
  const { buffer, filename } = resumeFile.buildDoc(job, m);
  res.setHeader('Content-Type', 'application/msword; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(buffer);
});

// ---------------- 简历 PDF 导出（经 Python 公共 PDF 模块） ----------------
// 请求体：{ jobId, resume_data?, filename? }
//   - 默认从【该岗位定制版】生成：materials[jobId].tailoredResume → 模板 4 版块
//     （markdown → sections，走模块已支持的 {name, sections} 形态），文件名为岗位名
//   - 也可显式传 resume_data / filename 覆盖（跳过版本回填）
// 生成成功后回填最新定制版版本的 pdfPath/status，版本管理由此闭环。
// 内部通过 fetch 调 services/pdf_service.py，Node 只负责 HTTP 中转、不做 PDF 逻辑。
router.post('/resume/generate-pdf', async (req, res) => {
  try {
    const { jobId, resume_data, filename } = req.body || {};
    let job = null;
    if (jobId) {
      job = store.load('jobs', []).find((x) => x.id === jobId) || null;
    }
    let resumeData = resume_data;
    let fname = filename;
    let version = null;

    if (!resumeData) {
      const m = store.load('materials', {})[jobId];
      if (!m || !m.tailoredResume) {
        return res.status(400).json({ success: false, error: '还没有生成投递材料，请先点击「生成投递材料」' });
      }
      resumeData = resumeMapper.buildTailoredResumeData(m, job);
      fname = resumeMapper.buildFilename(job);
    }

    const r = await pdfClient.generatePdfPath(resumeData, fname);

    // 版本回填（仅当走定制版流程时）
    if (jobId && !resume_data) {
      const m = store.load('materials', {})[jobId];
      version = resumeVersions.backfillPdf(jobId, {
        pdfPath: r.path,
        content: (m && m.tailoredResume) || '',
      });
    }
    res.json({ success: true, pdf_url: '/api/pdf/' + encodeURIComponent(r.name), filename: r.name, version });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// 某岗简历版本列表（基础版 + 定制版历史）
router.get('/resume-versions/:jobId', (req, res) => {
  const rec = resumeVersions.listForJob(req.params.jobId);
  if (!rec) return res.json({ exists: false, versions: null });
  res.json({ exists: true, versions: rec });
});

// 提供 output/ 下的 PDF 下载（带路径校验，防止穿越到 output 之外）
// output 目录必须与 pdf_service 的默认输出目录一致（core/pdf_generator DEFAULT_OUTPUT_DIR
// = <仓库根>/output = 本文件的上上级目录），否则生成后这里取不到文件。
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output');
router.get('/pdf/:filename', (req, res) => {
  const fname = path.basename(String(req.params.filename || ''));
  if (!fname || fname === '.' || fname === '..' || !/\.pdf$/i.test(fname)) {
    return res.status(400).json({ ok: false, error: '非法文件名' });
  }
  const file = path.join(OUTPUT_DIR, fname);
  if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: '文件不存在，请先生成 PDF' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="resume.pdf"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.sendFile(file);
});

// ---------------- 职业画像（职业记忆库） ----------------
function coerceStr(v) { return typeof v === 'string' ? v.trim() : ''; }
function coerceStrArr(v) { return Array.isArray(v) ? v.map(coerceStr).filter(Boolean) : undefined; }

router.get('/profile', (req, res) => {
  const p = store.load('profile', null);
  const resume = store.load('resume', null);
  res.json({
    exists: !!p,
    profile: p,
    hasResume: !!(resume && resume.basic),
    resumeUpdatedAt: (resume && resume.updatedAt) || null,
  });
});

router.post('/profile/regenerate', async (req, res) => {
  if (!llm.getApiKey()) {
    return res.status(400).json({ ok: false, error: '还没有设置 DeepSeek API Key，请先到「设置」页填写并保存。' });
  }
  try {
    const resume = store.load('resume', null);
    if (!resume || !resume.basic) return res.status(400).json({ ok: false, error: '还没有简历，请先到「我的简历」上传或填写' });
    const settings = store.load('settings', {});
    const profile = await profileMod.buildProfile(resume, settings);
    const prev = store.load('profile', null);
    profile.version = (prev && prev.version ? prev.version : 0) + 1;
    store.save('profile', profile);
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.put('/profile', (req, res) => {
  const body = req.body || {};
  const prev = store.load('profile', null);
  if (!prev) return res.status(404).json({ ok: false, error: '还没有画像，请先点「生成画像」' });
  const next = { ...prev };
  for (const f of ['summary', 'professionalIdentity', 'careerGoal']) {
    if (typeof body[f] === 'string') next[f] = body[f].trim();
  }
  for (const f of ['coreCompetencies', 'skills', 'achievements', 'targetRoles']) {
    const v = coerceStrArr(body[f]);
    if (v !== undefined) next[f] = v;
  }
  if (Array.isArray(body.industryExperience)) {
    next.industryExperience = body.industryExperience
      .map((x) => ({ industry: coerceStr(x && x.industry), depth: coerceStr(x && x.depth), evidence: coerceStr(x && x.evidence) }))
      .filter((x) => x.industry || x.evidence);
  }
  if (Array.isArray(body.strengths)) {
    next.strengths = body.strengths
      .map((x) => ({ tag: coerceStr(x && x.tag), evidence: coerceStr(x && x.evidence) }))
      .filter((x) => x.tag);
  }
  next.version = (prev.version || 0) + 1;
  next.editedAt = new Date().toISOString();
  store.save('profile', next);
  res.json({ ok: true, profile: next });
});

// ---------------- JD 语义分析 + 混合匹配 ----------------
router.get('/jobs/:id/analysis', (req, res) => {
  const app = matchMod.getApplication(req.params.id);
  if (!app) return res.json({ exists: false, application: null });
  res.json({ exists: true, application: app });
});

router.put('/jobs/:id/jd', (req, res) => {
  const jobs = store.load('jobs', []);
  const job = jobs.find((x) => x.id === req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: '岗位不存在' });
  const text = (req.body && req.body.text) || '';
  const app = matchMod.saveJdText(job, text);
  res.json({ ok: true, application: app });
});

router.post('/jobs/:id/analyze', async (req, res) => {
  if (!llm.getApiKey()) {
    return res.status(400).json({ ok: false, error: '还没有设置 DeepSeek API Key，请先到「设置」页填写并保存。' });
  }
  try {
    const jobs = store.load('jobs', []);
    const job = jobs.find((x) => x.id === req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: '岗位不存在' });
    const profile = store.load('profile', null);
    if (!profile) return res.status(400).json({ ok: false, error: '还没有职业画像，请先到「我的职业画像」页生成画像' });
    const jdText = (req.body && req.body.jdText) || '';
    const app = await matchMod.computeMatch(profile, job, jdText);
    res.json({ ok: true, application: app });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// 批量分析已确认岗位（可停止，轮询 /applications/analyze-status）
router.post('/applications/recompute', async (req, res) => {
  if (!llm.getApiKey()) {
    return res.status(400).json({ ok: false, error: '还没有设置 DeepSeek API Key，请先到「设置」页填写并保存。' });
  }
  try {
    const r = await matchMod.runAnalyzeAll();
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get('/applications/analyze-status', (req, res) => {
  res.json(matchMod.getAnalyzeState());
});

router.post('/applications/analyze-stop', (req, res) => {
  matchMod.stopAnalyze();
  res.json({ ok: true });
});

// 全部投递档案（键 = job.id），供前端卡片渲染匹配分析块
router.get('/analyses', (req, res) => {
  res.json({ items: store.load('applications', {}) });
});

// ---------------- 投递跟踪 ----------------
router.get('/applications', (req, res) => {
  // 由"已确认"岗位组成，带上材料与当前状态
  const jobs = store.load('jobs', []);
  const materials = store.load('materials', {});
  const apps = jobs
    .filter((j) => j.status === 'confirmed')
    .map((j) => ({
      id: j.id,
      company: j.company,
      title: j.title,
      location: j.location,
      platform: j.platform,
      url: j.url,
      score: j.score,
      confirmedAt: j.confirmedAt,
      applyStatus: j.applyStatus || '待投递',
      hasMaterials: !!materials[j.id],
    }));
  res.json({ items: apps });
});

router.post('/applications/:id/status', (req, res) => {
  const status = (req.body && req.body.status) || '';
  const allowed = ['待投递', '已投递', '笔试', '面试', '已拿Offer', '被拒', '放弃'];
  if (!allowed.includes(status)) return res.status(400).json({ ok: false, error: '非法状态' });
  const jobs = store.load('jobs', []);
  const j = jobs.find((x) => x.id === req.params.id);
  if (!j) return res.status(404).json({ ok: false, error: '岗位不存在' });
  j.applyStatus = status;
  j.statusUpdatedAt = new Date().toISOString();
  store.save('jobs', jobs);
  res.json({ ok: true });
});

module.exports = router;
