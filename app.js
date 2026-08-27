/* 秋招智能投递助手 — 前端逻辑 */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  settings: null,
  jobs: [],
  resume: null,
  profile: null,
  analyses: {},
  materials: {},
  applications: [],
  filter: 'all',
  sortByRec: false,
  searchRunning: false,
  enrichRunning: false,
  analyzeRunning: false,
  task: null,
  pollTimer: null,
  searchDone: false,
  selMaterialJob: null,
  selectedCities: new Set(),
};

let toastTimer;
function toast(msg, type = '', ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

// ---------------- Tab 切换 ----------------
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
  if (name === 'materials') loadMaterialsSide();
  if (name === 'track') loadTrack();
  if (name === 'resume') loadResume();
  if (name === 'profile') loadProfile();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
$('#onboardGoto').addEventListener('click', () => switchTab('settings'));

// ---------------- 初始化 ----------------
async function init() {
  await loadSettings();
  await loadJobs();
  loadResume();
}
init().catch((e) => toast(e.message, 'error'));

// ---------------- 设置 ----------------
const CITY_PRESET = ['北京', '上海', '广州', '深圳', '杭州', '南京', '苏州', '成都', '武汉', '西安', '天津', '重庆', '宁波', '佛山', '东莞', '合肥', '青岛', '长沙', '郑州'];

async function loadSettings() {
  state.settings = await api('/api/settings');
  state.selectedCities = new Set(state.settings.cities);
  $('#apikeyIndicator').textContent = state.settings.apiKeySet ? `API Key：已设置 ${state.settings.apiKeyMasked}` : 'API Key：未设置';
  $('#apikeyIndicator').classList.toggle('ok', state.settings.apiKeySet);
  $('#onboardBanner').hidden = state.settings.apiKeySet;
  $('#apiKeyHint').textContent = state.settings.apiKeySet ? `当前已设置（${state.settings.apiKeyMasked}）。重新输入并保存会覆盖；留空表示不修改。` : '还没有设置。填入后点「保存设置」。申请地址：platform.deepseek.com';
  $('#setKeywords').value = (state.settings.keywords || []).join('\n');
  $('#setMajor').value = state.settings.major || '电子商务';
  $('#setCompanyPref').value = state.settings.companyPref || '央企/国企优先，其次大厂';
  renderCityChips();
  renderSources(state.settings.sources || []);
}

// 数据来源平台清单（只读展示）
function renderSources(sources) {
  const el = $('#sourceList');
  if (!el) return;
  el.innerHTML = (sources || [])
    .map((g) => `<div class="src-group"><b>${esc(g.group)}</b>：${(g.sites || []).map((s) => `<span class="src-site">${esc(s)}</span>`).join('')}</div>`)
    .join('');
}

function renderCityChips() {
  $('#cityChips').innerHTML = CITY_PRESET.map(
    (c) => `<button class="chip ${state.selectedCities.has(c) ? 'active' : ''}" data-city="${c}">${c}</button>`
  ).join('');
  $$('#cityChips .chip').forEach((b) =>
    b.addEventListener('click', () => {
      const c = b.dataset.city;
      state.selectedCities.has(c) ? state.selectedCities.delete(c) : state.selectedCities.add(c);
      b.classList.toggle('active');
    })
  );
}

$('#saveSettingsBtn').addEventListener('click', async () => {
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        apiKey: $('#setApiKey').value.trim(),
        cities: [...state.selectedCities],
        keywords: $('#setKeywords').value.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean),
        major: $('#setMajor').value.trim(),
        companyPref: $('#setCompanyPref').value.trim(),
      }),
    });
    $('#setApiKey').value = '';
    await loadSettings();
    $('#settingsMsg').textContent = '✅ 已保存';
    toast('设置已保存', 'success');
    setTimeout(() => ($('#settingsMsg').textContent = ''), 3000);
  } catch (e) {
    toast(e.message, 'error');
  }
});

$('#testBtn').addEventListener('click', async () => {
  const key = $('#setApiKey').value.trim();
  const $r = $('#testResult');
  $r.textContent = '测试中…';
  try {
    if (key) {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ apiKey: key }) });
      $('#setApiKey').value = '';
    }
    const r = await api('/api/settings/test', { method: 'POST' });
    $r.textContent = `✅ 连接成功（${r.model}）`;
  } catch (e) {
    $r.textContent = `❌ ${e.message.slice(0, 80)}`;
  }
});

// ---------------- 找岗位 ----------------
$('#searchBtn').addEventListener('click', startSearch);
$('#enrichBtn').addEventListener('click', startEnrich);
$('#analyzeAllBtn').addEventListener('click', startAnalyzeAll);
$('#stopBtn').addEventListener('click', async () => {
  await api('/api/search/stop', { method: 'POST' }).catch(() => {});
  await api('/api/applications/analyze-stop', { method: 'POST' }).catch(() => {});
  toast('正在停止…');
});

function setBusy(busy, stepText) {
  $('#searchBtn').disabled = busy;
  $('#enrichBtn').disabled = busy;
  $('#stopBtn').hidden = !busy;
  if (stepText) $('#searchStep').textContent = stepText;
  if (busy) $('#searchLog').classList.add('show');
}

async function startSearch() {
  if (state.searchRunning || state.enrichRunning) return;
  if (!state.settings || !state.settings.apiKeySet) {
    toast('请先到「设置」填写并保存 DeepSeek API Key', 'error');
    switchTab('settings');
    return;
  }
  state.task = 'search';
  state.searchRunning = true;
  state.searchDone = false;
  setBusy(true, '正在准备搜索…（每轮约 20-60 秒，共 6 轮）');
  state.pollTimer = setInterval(pollStatus, 1500);
  try {
    const r = await api('/api/jobs/search', { method: 'POST' });
    await finishTask(`搜索完成：新增 ${r.found} 个岗位，共 ${r.total} 个`);
  } catch (e) {
    await finishTask(null, e.message);
  }
}

// 给已有岗位批量补充福利信息（薪资/双休/险种/补贴 + 评级）
async function startEnrich() {
  if (state.searchRunning || state.enrichRunning) return;
  if (!state.settings || !state.settings.apiKeySet) {
    toast('请先到「设置」填写并保存 DeepSeek API Key', 'error');
    switchTab('settings');
    return;
  }
  if (!state.jobs.length) {
    toast('还没有岗位，先点「开始搜索秋招岗位」', 'error');
    return;
  }
  state.task = 'enrich';
  state.enrichRunning = true;
  state.searchDone = false;
  setBusy(true, '正在为已有岗位补充福利信息…（每岗约 10-30 秒）');
  state.pollTimer = setInterval(pollStatus, 1500);
  try {
    const r = await api('/api/jobs/enrich', { method: 'POST' });
    await finishTask(`福利补充完成：${r.done}/${r.total} 个岗位`);
  } catch (e) {
    await finishTask(null, e.message);
  }
}

// 批量分析已确认岗位（职业画像 → 混合匹配分 → 落 applications.json）
async function startAnalyzeAll() {
  if (state.searchRunning || state.enrichRunning || state.analyzeRunning) return;
  if (!state.settings || !state.settings.apiKeySet) {
    toast('请先到「设置」填写并保存 DeepSeek API Key', 'error');
    switchTab('settings');
    return;
  }
  if (!state.jobs.some((j) => j.status === 'confirmed')) {
    toast('还没有已确认的岗位', 'error');
    return;
  }
  const p = await api('/api/profile').catch(() => null);
  if (!p || !p.exists) {
    toast('请先到「我的职业画像」生成画像', 'error');
    switchTab('profile');
    return;
  }
  state.task = 'analyze';
  state.analyzeRunning = true;
  state.searchDone = false;
  setBusy(true, '正在批量分析已确认岗位…（每岗约 20-40 秒，可随时停止）');
  state.pollTimer = setInterval(pollStatus, 1500);
  try {
    const r = await api('/api/applications/recompute', { method: 'POST' });
    await finishTask(r.skipped ? `批量分析完成：${r.done}/${r.total} 个（另有 ${r.skipped} 个已有分析自动跳过）` : `批量分析完成：${r.done}/${r.total} 个岗位`);
  } catch (e) {
    await finishTask(null, e.message);
  }
}

async function pollStatus() {
  try {
    const [s, az] = await Promise.all([api('/api/search/status'), api('/api/applications/analyze-status')]);
    const en = s.enrich || {};
    const active = s.running ? { step: s.step, log: s.log }
      : en.running ? { step: en.step, log: en.log }
      : az.running ? { step: az.step, log: az.log } : null;
    if (active) {
      $('#searchStep').textContent = active.step || '';
      if (active.log && active.log.length) {
        const el = $('#searchLog');
        el.textContent = active.log.slice(-14).join('\n');
        el.scrollTop = el.scrollHeight;
      }
    }
    if (!s.running && !en.running && !az.running && !state.searchDone) {
      clearInterval(state.pollTimer);
      state.searchRunning = false;
      state.enrichRunning = false;
      state.analyzeRunning = false;
      setBusy(false);
      state.searchDone = true;
      await loadJobs();
    }
  } catch (e) {
    /* 忽略瞬时错误 */
  }
}

async function finishTask(msg, err) {
  clearInterval(state.pollTimer);
  state.searchRunning = false;
  state.enrichRunning = false;
  state.analyzeRunning = false;
  state.searchDone = true;
  setBusy(false);
  await loadJobs();
  const who = state.task === 'enrich' ? '福利补充' : state.task === 'analyze' ? '批量分析' : '搜索';
  if (err) toast(`${who}中断：${err}`, 'error');
  else toast(msg, 'success');
  state.task = null;
}

function typeLabel(t) {
  return t === 'soe' ? '央企/国企' : t === 'bigtech' ? '大厂' : '其它';
}

// 岗位的推荐分：已分析 → rec.recScore；未分析 → 0（排最后）
function recScoreOfJob(j) {
  const rec = state.analyses[j.id] && state.analyses[j.id].rec;
  return rec && Number.isFinite(Number(rec.recScore)) ? Number(rec.recScore) : 0;
}

function renderJobs() {
  const list = state.jobs.filter((j) => state.filter === 'all' || j.status === state.filter);
  const counts = { all: state.jobs.length, pending: 0, confirmed: 0, skipped: 0 };
  state.jobs.forEach((j) => { if (counts[j.status] != null) counts[j.status]++; });
  $('#cntAll').textContent = counts.all;
  $('#cntPending').textContent = counts.pending;
  $('#cntConfirmed').textContent = counts.confirmed;
  $('#cntSkipped').textContent = counts.skipped;
  let hint = `${list.length}/${counts.all} 个岗位`;
  if (state.sortByRec) {
    hint += ' · 按推荐排序（A重点投递 / B重点冲刺 / C探索投递 / D减少投入）';
    list.sort((a, b) => {
      const ra = recScoreOfJob(a), rb = recScoreOfJob(b);
      if (ra && rb) return rb - ra;
      if (ra) return -1;
      if (rb) return 1;
      return b.score - a.score;
    });
  }
  $('#jobsHint').textContent = state.jobs.length ? hint : '';

  const el = $('#jobList');
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">${state.jobs.length ? '当前筛选下没有岗位' : '还没有岗位。点右上「开始搜索秋招岗位」，AI 会联网为你找开放中的 2027 届秋招岗位。'}</div>`;
    return;
  }
  el.innerHTML = list.map(jobCard).join('');
  $$('#jobList .job-card').forEach((card) => attachJobCard(card));
}

// 福利待遇区：薪资 + 双休/险种/补贴徽章 + 评级
function benefitsHTML(j) {
  const g = j.benefitsGrade;
  if (!g || g === '未知') {
    return `<div class="jc-meta jc-benefits">🎁 福利：<span class="hint">未补充（可点上方「补充福利信息」）</span></div>`;
  }
  const parts = [];
  if (j.salary && j.salary !== '未知') parts.push(`<span class="b-salary">💰 ${esc(j.salary)}</span>`);
  const badges = [];
  if (j.workDays && j.workDays !== '未知') badges.push(`<span class="b-badge b-days">🗓 ${esc(j.workDays)}</span>`);
  if (j.insurance && j.insurance !== '未知') badges.push(`<span class="b-badge b-ins">🛡 ${esc(j.insurance)}</span>`);
  (j.subsidies || []).forEach((s) => badges.push(`<span class="b-badge b-sub">🏠 ${esc(s)}</span>`));
  const notes = j.benefitsNotes ? `<span class="hint" title="${esc(j.benefitsNotes)}">${esc(j.benefitsNotes)}</span>` : '';
  return `<div class="jc-benefits">${parts.join('')}${badges.join('')}
    <span class="grade grade-${g}">福利${g}</span>${notes}</div>`;
}

function jobCard(j) {
  const scoreCls = j.score >= 80 ? 'high' : j.score >= 65 ? 'mid' : 'low';
  const rec = state.analyses[j.id] && state.analyses[j.id].rec;
  const tierChip = rec && rec.tier ? `<span class="tier tier-${rec.tier}" title="${esc(rec.priority || '')}">${rec.tier}·${esc(rec.priority || '')}</span>` : '';
  const kws = (j.keywordsMatched || []).slice(0, 6).map((k) => `<span class="kw">${esc(k)}</span>`).join('');
  let actions = '';
  if (j.status === 'skipped') {
    actions = `<button class="btn small" data-act="unskip">恢复</button>`;
  } else {
    actions = `<button class="btn small" data-act="match">🎯 分析匹配度</button>`;
    if (j.status === 'pending') {
      actions += `<button class="btn gold small" data-act="confirm">✅ 确认投递</button>
                  <button class="btn small" data-act="skip">跳过</button>`;
    } else if (j.status === 'confirmed') {
      actions += `<button class="btn primary small" data-act="materials">📄 生成/查看材料</button>
                  <span class="badge soe">已确认</span>`;
    }
  }
  return `<div class="job-card ${j.status === 'skipped' ? 'skipped' : ''}" data-id="${j.id}">
    <div class="jc-top">
      <div>
        <h4>${esc(j.title)}</h4>
        <div class="jc-meta">🏢 ${esc(j.company)} ｜ 📍 ${esc(j.location)}</div>
        <div class="jc-meta">平台：${esc(j.platform)} ｜ 截止：${esc(j.deadline)}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
        <span class="badge ${j.companyType || 'unknown'}">${typeLabel(j.companyType)}</span>
        ${tierChip}
        <span class="score ${scoreCls}">${j.score}分</span>
      </div>
    </div>
    <div class="jc-meta">${esc(j.jdSummary)}</div>
    <div>${kws}</div>
    ${benefitsHTML(j)}
    ${matchBlockHTML(state.analyses[j.id], j)}
    <div class="jc-actions">${actions}
      ${j.url ? `<a class="jc-link" href="${esc(j.url)}" target="_blank" rel="noopener">查看投递入口 ↗</a>` : ''}
    </div>
  </div>`;
}

// 卡片里的"匹配分析"块：推荐区（综合评分/四维/理由/风险）＋ 匹配分析（混合分/理由/不足/简历建议/岗位解释）
function matchBlockHTML(app) {
  if (!app || !app.match || !app.match.matchScore) return '';
  const m = app.match;
  const rec = app.rec;
  const expl = app.explanation || {};
  const jd = app.jd || {};
  const meta = [
    jd.unit ? `📁 ${esc(jd.unit)}` : '',
    jd.position ? `岗位：${esc(jd.position)}` : '',
    jd.status ? `状态：${esc(jd.status)}` : '',
    jd.publishDate ? `发布：${esc(jd.publishDate)}` : '',
  ].filter(Boolean).join(' ｜ ');
  // 推荐区（综合岗位价值评分 + A/B/C/D）
  let recHTML = '';
  if (rec && Number.isFinite(Number(rec.recScore))) {
    const comp = rec.competition || {};
    const compLabel = comp.score >= 75 ? '激烈' : comp.score >= 50 ? '适中' : '容易';
    const dims = [
      `简历匹配 <b>${rec.resumeMatch}</b>`,
      `岗位价值 <b>${rec.careerValue && rec.careerValue.score}</b>`,
      `成长空间 <b>${rec.growth && rec.growth.score}</b>`,
      `竞争难度 <b>${comp.score}（${compLabel}）</b>`,
      `平台 <b>${rec.platformScore}</b>`,
    ].join(' ｜ ');
    recHTML = `
      <div class="rec-head">
        <b>🏆 综合岗位价值评分</b>
        <span class="rec-score">${rec.recScore}分</span>
        <span class="tier tier-${rec.tier}">${rec.tier}·${esc(rec.priority || '')}</span>
      </div>
      <div class="rec-dim">${dims}</div>
      ${rec.recommendReason ? `<div class="rec-reason"><b>推荐理由：</b>${esc(rec.recommendReason)}</div>` : ''}
      ${(rec.risks && rec.risks.length) ? `<div class="mb-sec mb-warn"><b>风险提示</b><ul class="guide-list">${rec.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
    `;
  }
  const secs = [];
  if (expl.overview) secs.push(`<div class="mb-sec"><b>这个岗位实际做什么</b><div class="mb-text">${esc(expl.overview)}</div></div>`);
  if ((expl.daily || []).length) secs.push(`<div class="mb-sec"><b>日常工作</b><ul class="guide-list">${expl.daily.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>`);
  if ((expl.growth || []).length) secs.push(`<div class="mb-sec"><b>发展路径</b><ul class="guide-list">${expl.growth.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>`);
  if (m.reasons && m.reasons.length) secs.push(`<div class="mb-sec"><b>为什么匹配</b><ul class="guide-list">${m.reasons.map((r) => `<li><b>${esc(r.requirement)}</b><div class="hint">→ ${esc(r.evidence)}</div></li>`).join('')}</ul></div>`);
  if (m.gaps && m.gaps.length) secs.push(`<div class="mb-sec"><b>不足</b><ul class="guide-list mb-warn">${m.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>`);
  if (m.resumeAdvice && m.resumeAdvice.length) secs.push(`<div class="mb-sec"><b>简历建议</b><ul class="guide-list mb-tip">${m.resumeAdvice.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>`);
  return `<div class="match-block">
    ${recHTML}
    <div class="mb-head">
      <b>🎯 匹配分析</b>
      <span class="m-score">${m.matchScore}分</span>
      <span class="grade grade-${m.grade}">匹配${m.grade}</span>
    </div>
    ${meta ? `<div class="mb-meta">${meta}</div>` : ''}
    <div class="mb-sub">结构化 ${m.structuredScore} 分 ×40% ＋ 语义 ${m.semanticScore} 分 ×60%</div>
    ${secs.join('')}
  </div>`;
}

function attachJobCard(card) {
  const id = card.dataset.id;
  card.querySelectorAll('[data-act]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      try {
        if (act === 'confirm') {
          await api(`/api/jobs/${id}/confirm`, { method: 'POST' });
          await loadJobs();
          toast('已确认投递，去「投递材料」生成材料', 'success');
        } else if (act === 'skip') {
          await api(`/api/jobs/${id}/skip`, { method: 'POST' });
          await loadJobs();
        } else if (act === 'unskip') {
          await api(`/api/jobs/${id}/confirm`, { method: 'POST' });
          await loadJobs();
        } else if (act === 'materials') {
          state.selMaterialJob = id;
          switchTab('materials');
        } else if (act === 'match') {
          const p = await api('/api/profile').catch(() => null);
          if (!p || !p.exists) {
            toast('请先到「我的职业画像」生成画像', 'error');
            switchTab('profile');
            return;
          }
          openJdInput(card, id);
        }
      } catch (e) {
        toast(e.message, 'error');
      }
    })
  );
}

// 卡片内联 JD 输入框：可粘贴岗位 JD 全文，或用现有信息直接分析
function openJdInput(card, id) {
  card.querySelectorAll('.jd-input-box').forEach((b) => b.remove());
  const job = state.jobs.find((j) => j.id === id);
  const app = state.analyses[id];
  const prefill = (app && app.jd && app.jd.text) || (job && job.jdSummary) || '';
  const box = document.createElement('div');
  box.className = 'jd-input-box';
  box.innerHTML = `
    <b class="jd-label">粘贴岗位 JD 全文（越完整，分析越准）</b>
    <textarea class="jd-ta" rows="6" placeholder="把该岗位的职位描述、任职要求、工作内容粘贴到这里…">${esc(prefill)}</textarea>
    <div class="row">
      <button class="btn primary small jd-analyze">🎯 用这段 JD 分析</button>
      <button class="btn small jd-existing">用现有信息分析</button>
      <button class="btn small jd-cancel">取消</button>
    </div>
  `;
  card.appendChild(box);
  box.querySelector('.jd-analyze').addEventListener('click', async (e) => {
    const text = box.querySelector('.jd-ta').value.trim();
    if (!text) return toast('请先粘贴岗位 JD 文本', 'error');
    await runAnalyze(id, text, box);
  });
  box.querySelector('.jd-existing').addEventListener('click', () => runAnalyze(id, '', box));
  box.querySelector('.jd-cancel').addEventListener('click', () => box.remove());
}

async function runAnalyze(id, jdText, box) {
  box.querySelectorAll('button').forEach((b) => (b.disabled = true));
  box.querySelector('.jd-label').textContent = jdText
    ? 'AI 语义分析 + 混合评分中…（约 20-40 秒）'
    : '用现有信息分析中…（约 20-40 秒）';
  try {
    await api(`/api/jobs/${id}/jd`, { method: 'PUT', body: JSON.stringify({ text: jdText }) });
    await api(`/api/jobs/${id}/analyze`, { method: 'POST', body: JSON.stringify({ jdText }) });
    await loadJobs();
    toast('匹配分析完成', 'success');
  } catch (e) {
    box.querySelectorAll('button').forEach((b) => (b.disabled = false));
    box.querySelector('.jd-label').textContent = '粘贴岗位 JD 全文（越完整，分析越准）';
    toast(e.message, 'error');
  }
}

async function loadJobs() {
  const [r, a] = await Promise.all([api('/api/jobs'), api('/api/analyses')]);
  state.jobs = r.jobs;
  state.analyses = a.items || {};
  renderJobs();
}

// 筛选 chip
$$('.filter-row .chip').forEach((c) =>
  c.addEventListener('click', () => {
    $$('.filter-row .chip').forEach((x) => x.classList.remove('active'));
    c.classList.add('active');
    state.filter = c.dataset.filter;
    renderJobs();
  })
);

// 按推荐排序 chip（与筛选 chip 互斥高亮：排序开启时清掉 filter 的 active，只亮自己）
$('#sortRecChip').addEventListener('click', () => {
  state.sortByRec = !state.sortByRec;
  $('#sortRecChip').classList.toggle('active', state.sortByRec);
  renderJobs();
});

// ---------------- 我的简历 ----------------
function loadResume() {
  return api('/api/resume')
    .then((r) => {
      state.resume = r.resume;
      $('#resumeForm').hidden = !r.exists;
      if (r.exists) renderResumeForm();
      else $('#resumeForm').innerHTML = '';
    })
    .catch(() => {});
}

// 上传
const dz = $('#dropzone');
dz.addEventListener('click', () => $('#fileInput').click());
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) uploadResumeFile(f);
});
$('#fileInput').addEventListener('change', (e) => {
  if (e.target.files[0]) uploadResumeFile(e.target.files[0]);
});

async function uploadResumeFile(file) {
  const msg = $('#resumeMsg');
  msg.textContent = '正在解析并结构化简历（约 20-40 秒）…';
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/resume/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '解析失败');
    state.resume = data.resume;
    $('#resumeForm').hidden = false;
    renderResumeForm();
    msg.textContent = `✅ 解析成功（${data.source}），请检查并编辑下方信息。`;
  } catch (e) {
    msg.textContent = '❌ ' + e.message;
    toast(e.message, 'error');
  }
}

$('#pasteBtn').addEventListener('click', async () => {
  const text = $('#pasteText').value.trim();
  const msg = $('#resumeMsg');
  if (text.length < 20) return toast('请先粘贴完整的简历文字', 'error');
  msg.textContent = '正在结构化简历…';
  try {
    const res = await api('/api/resume/paste', { method: 'POST', body: JSON.stringify({ text }) });
    state.resume = res.resume;
    $('#resumeForm').hidden = false;
    renderResumeForm();
    $('#pasteText').value = '';
    msg.textContent = '✅ 解析成功，请检查下方信息。';
  } catch (e) {
    msg.textContent = '❌ ' + e.message;
    toast(e.message, 'error');
  }
});

function renderResumeForm() {
  const r = state.resume;
  const b = r.basic || {};
  const li = (arr, keys) => (arr || []).map((item) => keys.map((k) => item[k] || '').join('｜')).join('\n');
  $('#resumeForm').innerHTML = `
    <h3>✏️ 简历信息（可编辑）</h3>
    <div class="form-grid">
      <div class="section-title">基本信息</div>
      <label>姓名<input data-b="name" value="${esc(b.name)}"></label>
      <label>性别<input data-b="gender" value="${esc(b.gender)}"></label>
      <label>手机号<input data-b="phone" value="${esc(b.phone)}"></label>
      <label>邮箱<input data-b="email" value="${esc(b.email)}"></label>
      <label>出生年份<input data-b="birthYear" value="${esc(b.birthYear)}"></label>
      <label>政治面貌<input data-b="party" value="${esc(b.party)}" placeholder="中共党员/共青团员/群众"></label>
      <label>现居城市<input data-b="city" value="${esc(b.city)}"></label>
      <label>状态<input data-b="status" value="${esc(b.status)}" placeholder="2027届应届生"></label>

      <div class="section-title">教育经历（school｜degree｜major｜period｜gpa｜rank）</div>
      <div class="full"><textarea id="eduArea" rows="3">${esc(li(r.education, ['school', 'degree', 'major', 'period', 'gpa', 'rank']))}</textarea></div>

      <div class="section-title">实习经历（company｜role｜period｜description）</div>
      <div class="full"><textarea id="internArea" rows="4">${esc(li(r.internship, ['company', 'role', 'period', 'description']))}</textarea></div>

      <div class="section-title">项目经历（name｜role｜period｜description）</div>
      <div class="full"><textarea id="projectArea" rows="3">${esc(li(r.project, ['name', 'role', 'period', 'description']))}</textarea></div>

      <div class="section-title">技能 / 证书 / 荣誉 / 自我评价</div>
      <label class="full">技能（每行一个）<textarea id="skillsArea" rows="2">${esc((r.skills || []).join('\n'))}</textarea></label>
      <label class="full">证书（每行一个）<textarea id="certArea" rows="2">${esc((r.certifications || []).join('\n'))}</textarea></label>
      <label class="full">荣誉（每行一个）<textarea id="awardArea" rows="2">${esc((r.awards || []).join('\n'))}</textarea></label>
      <label class="full">自我评价<textarea id="selfEvalArea" rows="3">${esc(r.selfEval || '')}</textarea></label>
    </div>
    <div class="row">
      <button id="saveResumeBtn" class="btn primary">保存简历</button>
      <span class="hint">用｜分割字段；空行跳过。保存后即可用于找岗打分和材料定制。</span>
    </div>
  `;
  $('#saveResumeBtn').addEventListener('click', saveResume);
}

const splitList = (area) => area.value.split('\n').map((s) => s.trim()).filter(Boolean);
const splitRow = (area, keys) => (area.value.split('\n').map((s) => s.trim()).filter(Boolean)
  .map((line) => {
    const parts = line.split('｜').map((x) => x.trim());
    const item = {};
    keys.forEach((k, i) => (item[k] = parts[i] || ''));
    return item;
  }));

function saveResume() {
  const r = state.resume;
  r.basic = {
    name: $('[data-b="name"]').value,
    gender: $('[data-b="gender"]').value,
    phone: $('[data-b="phone"]').value,
    email: $('[data-b="email"]').value,
    birthYear: $('[data-b="birthYear"]').value,
    party: $('[data-b="party"]').value,
    city: $('[data-b="city"]').value,
    status: $('[data-b="status"]').value,
  };
  r.education = splitRow($('#eduArea'), ['school', 'degree', 'major', 'period', 'gpa', 'rank']);
  r.internship = splitRow($('#internArea'), ['company', 'role', 'period', 'description']);
  r.project = splitRow($('#projectArea'), ['name', 'role', 'period', 'description']);
  r.skills = splitList($('#skillsArea'));
  r.certifications = splitList($('#certArea'));
  r.awards = splitList($('#awardArea'));
  r.selfEval = $('#selfEvalArea').value.trim();
  api('/api/resume', { method: 'PUT', body: JSON.stringify(r) })
    .then(() => toast('简历已保存', 'success'))
    .catch((e) => toast(e.message, 'error'));
}

// ---------------- 我的职业画像 ----------------
function loadProfile() {
  return api('/api/profile')
    .then((r) => {
      state.profile = r.profile;
      const form = $('#profileForm');
      form.hidden = false;
      if (r.exists) {
        renderProfileForm();
      } else {
        form.innerHTML = r.hasResume
          ? `<div class="profile-guide">
              <h3>🧑‍💻 生成我的职业画像</h3>
              <p class="hint">AI 将基于你的简历与求职设置，提炼：职业定位、核心能力、行业经验、优势标签、成果数据、职业目标、目标岗位。之后每个岗位都能用它做 JD 语义匹配、匹配度评分和简历建议。</p>
              <div class="row"><button id="genProfileBtn" class="btn primary">✨ 生成职业画像（约 20-40 秒）</button></div>
            </div>`
          : `<div class="empty-state">还没有简历。请先到「我的简历」上传或填写简历，再回来生成职业画像。</div>`;
        const b = $('#genProfileBtn');
        if (b) b.addEventListener('click', regenerateProfile);
      }
    })
    .catch(() => {});
}

function renderProfileForm() {
  const p = state.profile;
  const arrArea = (arr) => (arr || []).map((x) => String(x)).join('\n');
  const indArea = (p.industryExperience || []).map((x) => `${x.industry || ''}｜${x.depth || ''}｜${x.evidence || ''}`).join('\n');
  const strArea = (p.strengths || []).map((x) => `${x.tag || ''}｜${x.evidence || ''}`).join('\n');
  const genAt = p.generatedAt ? new Date(p.generatedAt).toLocaleString('zh-CN', { hour12: false }) : '';
  const base = p.resumeUpdatedAt ? `｜ 基于简历版本：${new Date(p.resumeUpdatedAt).toLocaleDateString('zh-CN')}` : '';
  $('#profileForm').innerHTML = `
    <h3>🧑‍💻 我的职业画像（可编辑）</h3>
    <p class="hint">生成于 ${esc(genAt || '未知')}${base}。以下内容用于每个岗位的匹配分析与简历建议，编辑仅影响画像、不影响简历原文。</p>
    <div class="form-grid">
      <div class="section-title">画像总览</div>
      <label class="full">画像摘要<textarea id="pfSummary" rows="3">${esc(p.summary)}</textarea></label>
      <label>职业定位<textarea id="pfIdentity" rows="2">${esc(p.professionalIdentity)}</textarea></label>
      <label>职业目标<textarea id="pfGoal" rows="2">${esc(p.careerGoal)}</textarea></label>

      <div class="section-title">核心能力 / 行业经验</div>
      <label class="full">核心能力（每行一个，用可被 JD 对号入座的词组）<textarea id="pfCore" rows="3">${esc(arrArea(p.coreCompetencies))}</textarea></label>
      <label class="full">行业经验（行业｜深度｜证据，每行一条）<textarea id="pfIndustry" rows="3">${esc(indArea)}</textarea></label>

      <div class="section-title">技能 / 优势 / 成果</div>
      <label class="full">技能（每行一个）<textarea id="pfSkills" rows="2">${esc(arrArea(p.skills))}</textarea></label>
      <label class="full">优势标签（标签｜证据，每行一条）<textarea id="pfStrengths" rows="3">${esc(strArea)}</textarea></label>
      <label class="full">成果数据（每行一条）<textarea id="pfAwards" rows="2">${esc(arrArea(p.achievements))}</textarea></label>

      <div class="section-title">目标岗位（具体岗位名，不要大类）</div>
      <label class="full">目标岗位（每行一个）<textarea id="pfRoles" rows="2">${esc(arrArea(p.targetRoles))}</textarea></label>
    </div>
    <div class="row">
      <button id="saveProfileBtn" class="btn primary">保存画像</button>
      <button id="regenProfileBtn" class="btn">🔄 基于最新简历重新生成</button>
      <span class="hint">AI 提炼难免有偏差，可在此直接修改。</span>
    </div>
  `;
  $('#saveProfileBtn').addEventListener('click', saveProfile);
  $('#regenProfileBtn').addEventListener('click', regenerateProfile);
}

const splitLine = (area) => area.value.split('\n').map((s) => s.trim()).filter(Boolean);

function saveProfile() {
  const ind = (area) => splitLine(area).map((l) => {
    const [industry, depth, ...rest] = l.split('｜').map((x) => x.trim());
    return { industry: industry || '', depth: depth || '', evidence: rest.join('｜').trim() };
  });
  const str = (area) => splitLine(area).map((l) => {
    const [tag, ...rest] = l.split('｜').map((x) => x.trim());
    return { tag: tag || '', evidence: rest.join('｜').trim() };
  });
  const payload = {
    summary: $('#pfSummary').value.trim(),
    professionalIdentity: $('#pfIdentity').value.trim(),
    careerGoal: $('#pfGoal').value.trim(),
    coreCompetencies: splitLine($('#pfCore')),
    industryExperience: ind($('#pfIndustry')),
    skills: splitLine($('#pfSkills')),
    strengths: str($('#pfStrengths')),
    achievements: splitLine($('#pfAwards')),
    targetRoles: splitLine($('#pfRoles')),
  };
  api('/api/profile', { method: 'PUT', body: JSON.stringify(payload) })
    .then((r) => {
      state.profile = r.profile;
      toast('画像已保存', 'success');
    })
    .catch((e) => toast(e.message, 'error'));
}

async function regenerateProfile() {
  const btn = $('#genProfileBtn') || $('#regenProfileBtn');
  if (btn) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '生成中…（约 20-40 秒）';
    try {
      const r = await api('/api/profile/regenerate', { method: 'POST' });
      state.profile = r.profile;
      renderProfileForm();
      toast('画像已生成', 'success');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = old;
      toast(e.message, 'error');
    }
    return;
  }
  try {
    const r = await api('/api/profile/regenerate', { method: 'POST' });
    state.profile = r.profile;
    renderProfileForm();
    toast('画像已生成', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------- 投递材料 ----------------
async function loadMaterialsSide() {
  const apps = await api('/api/applications');
  state.applications = apps.items;
  const list = $('#materialsJobList');
  if (!apps.items.length) {
    list.innerHTML = `<div class="hint">还没有已确认的岗位。</div>`;
    return;
  }
  list.innerHTML = apps.items.map((a) => `
    <button class="side-item ${state.selMaterialJob === a.id ? 'active' : ''}" data-id="${a.id}">
      <b>${esc(a.company)}</b>
      <span>${esc(a.title)}</span>
      <span class="m-state">${a.hasMaterials ? '✅ 已有材料' : '未生成材料'}</span>
    </button>`).join('');
  $$('#materialsJobList .side-item').forEach((b) =>
    b.addEventListener('click', () => {
      state.selMaterialJob = b.dataset.id;
      loadMaterialsSide();
      showMaterials(state.selMaterialJob);
    })
  );
  if (state.selMaterialJob) showMaterials(state.selMaterialJob);
  else if (apps.items.length && !state.selMaterialJob) {
    state.selMaterialJob = apps.items[0].id;
    loadMaterialsSide();
  }
}

async function showMaterials(jobId) {
  const view = $('#materialsView');
  view.innerHTML = '<div class="empty-state">加载中…</div>';
  try {
    const r = await api('/api/materials');
    state.materials = r.items || {};
    const m = state.materials[jobId];
    const app = (state.applications || []).find((a) => a.id === jobId);
    if (!m) {
      view.innerHTML = `
        <h2>${esc(app ? app.company : '')} · ${esc(app ? app.title : '')}</h2>
        <p class="hint">还没有生成材料。点击下方按钮，AI 将根据岗位 JD 为你定制简历、自我评价、网申答案和投递指引。</p>
        <div class="gen-btn-row">
          <button id="genMatBtn" class="btn primary">✨ 生成投递材料（约 30-60 秒）</button>
        </div>
      `;
      $('#genMatBtn').addEventListener('click', async () => {
        const btn = $('#genMatBtn');
        btn.disabled = true;
        btn.textContent = '生成中，请稍候…';
        try {
          const r2 = await api(`/api/jobs/${jobId}/tailor`, { method: 'POST' });
          state.materials[jobId] = r2.materials;
          toast('材料生成完成', 'success');
          showMaterials(jobId);
          loadMaterialsSide();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = '✨ 生成投递材料';
          toast(e.message, 'error');
        }
      });
      return;
    }
    const versions = await api('/api/resume-versions/' + jobId).catch(() => ({ exists: false, versions: null }));
    renderMaterials(jobId, m, app, versions.exists ? versions.versions : null);
  } catch (e) {
    view.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
  }
}

// 本岗位简历版本列表（基础版 + 定制版历史，可单独重渲染）
function versionsBlockHTML(jobId, versions) {
  const base = (versions && versions.base) || null;
  const custom = (versions && versions.custom) || [];
  const rows = [];
  if (base) {
    rows.push(`<li class="ver-row"><span class="ver-label"><b>版本${base.version}</b>：${esc(base.label)}</span><span class="hint">${base.resumeUpdatedAt ? '简历更新于 ' + esc(base.resumeUpdatedAt).slice(0, 10) : ''}</span><span class="hint">基础简历资产（data/resume.json）</span></li>`);
  } else {
    rows.push(`<li class="ver-row"><span class="ver-label"><b>版本1</b>：基础版</span><span class="hint">基础简历资产（data/resume.json）</span></li>`);
  }
  custom.forEach((v) => {
    const pdf = v.pdfExists && v.pdfPath
      ? `<a class="jc-link" href="/api/pdf/${encodeURIComponent(v.pdfPath.split(/[\\/]/).pop())}" download>⬇️ PDF</a>`
      : `<span class="hint">未生成PDF</span>`;
    rows.push(`<li class="ver-row"><span class="ver-label"><b>版本${v.version}</b>：${esc(v.label)}</span><span class="hint">${esc(v.createdAt || '').slice(0, 10)}</span><span>${pdf}</span></li>`);
  });
  return `<div id="versionsSec" class="mb-sec">
    <b>📁 本岗位简历版本</b>
    <ul class="guide-list">${rows.join('')}</ul>
  </div>`;
}

// AI优化分析：原内容 → 修改后 → 原因（可解释的 AI）+ JD 匹配点
function optBlockHTML(m, title) {
  const opt = m.optimizationReason || [];
  const jdp = m.jdMatchPoints || [];
  const items = opt.map((o, i) => `<li class="opt-item">
    <div class="opt-line"><b>${i + 1}. ${esc(o.original)}</b><span class="opt-arrow">→</span>${esc(o.optimized)}</div>
    <div class="opt-reason hint">原因：${esc(o.reason)}</div>
  </li>`).join('');
  const jdItems = jdp.map((p) => `<li><b>${esc(p.requirement)}</b><div class="hint">→ ${esc(p.evidence)}</div></li>`).join('');
  return `<div id="optSec" class="mb-sec">
    <b>🧠 AI优化分析</b>
    <div class="hint">本次针对「${esc(title || '该岗位')}」基于 JD 强化了 ${opt.length} 处经历：</div>
    <ul class="guide-list">${items || '<li class="hint">（暂无优化说明，请点击「重新生成」获取）</li>'}</ul>
    ${jdItems ? `<div class="mb-sub" style="margin-top:8px;"><b>JD 匹配点</b></div><ul class="guide-list">${jdItems}</ul>` : ''}
  </div>`;
}

function renderMaterials(jobId, m, app, versions) {
  const view = $('#materialsView');
  const g = m.guide || {};
  const answers = m.answers || {};
  const company = app ? app.company : (m.company || '');
  const title = app ? app.title : (m.title || '');
  view.innerHTML = `
    <div class="mat-job-card">
      <h2>${esc(company)} · ${esc(title)}</h2>
      <div class="jc-meta">📍 ${esc(app ? app.location : '')} ｜ 平台：${esc(app ? app.platform : '')}</div>
      <div class="gen-btn-row">
        <button id="jdToggleBtn" class="btn">① 查看JD分析</button>
        <button id="optToggleBtn" class="btn">② 查看AI优化记录</button>
        <button id="pdfResumeBtn" class="btn primary">③ 生成PDF简历</button>
        <button id="verToggleBtn" class="btn">④ 查看历史版本</button>
      </div>
      <div id="jdBlock" hidden></div>
      <div id="pdfStatus" class="hint" hidden></div>
    </div>

    ${versionsBlockHTML(jobId, versions)}
    ${optBlockHTML(m, title)}

    <div class="gen-btn-row">
      <button id="saveMatBtn" class="btn primary">💾 保存修改</button>
      <a id="exportMatBtn" class="btn" href="/api/materials/${jobId}/export" download>⬇️ 导出材料包（.md）</a>
      <a id="resumeFileBtn" class="btn" href="/api/materials/${jobId}/resume-file" download>⬇️ 定制简历(.doc)</a>
      <button id="regenMatBtn" class="btn">🔄 重新生成</button>
    </div>

    <h3>一、定制简历（按 JD 强化）</h3>
    <textarea id="f_tailoredResume" rows="12">${esc(m.tailoredResume)}</textarea>

    <h3>二、自我评价</h3>
    <textarea id="f_selfEval" rows="4">${esc(m.selfEval)}</textarea>

    <h3>三、网申常见问题</h3>
    <div id="answersBox"></div>
    <div id="answersArea" hidden></div>
    <button id="addAnswerBtn" class="btn small">＋ 增加一问</button>

    <h3>四、自我介绍</h3>
    <textarea id="f_selfIntro" rows="4">${esc(m.selfIntro)}</textarea>

    <h3>五、投递指引</h3>
    <div class="guide-block">
      <p><b>平台：</b>${esc(g.platform || app?.platform || '')}</p>
      <p><b>入口：</b>${g.url ? `<a class="jc-link" href="${esc(g.url)}" target="_blank" rel="noopener">${esc(g.url)} ↗</a>` : esc(app?.url || '')}</p>
      <b>步骤：</b>
      <ul class="guide-list">${(g.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      <b>注意：</b>
      <ul class="guide-list">${(g.notes || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
    </div>
  `;

  // 渲染网申答案（可编辑输入）
  const box = $('#answersBox');
  Object.entries(answers).forEach(([q, a]) => box.appendChild(answerRow(q, a)));

  $('#addAnswerBtn').addEventListener('click', () => {
    box.appendChild(answerRow('', ''));
  });

  $('#saveMatBtn').addEventListener('click', async () => {
    const newAnswers = {};
    $$('#answersBox .qa-edit').forEach((item) => {
      const q = item.querySelector('.qa-q').value.trim();
      if (q) newAnswers[q] = item.querySelector('.qa-a').value;
    });
    const payload = {
      tailoredResume: $('#f_tailoredResume').value,
      selfEval: $('#f_selfEval').value,
      selfIntro: $('#f_selfIntro').value,
      answers: newAnswers,
    };
    try {
      await api(`/api/materials/${jobId}`, { method: 'PUT', body: JSON.stringify(payload) });
      state.materials[jobId] = { ...state.materials[jobId], ...payload };
      toast('已保存', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  $('#regenMatBtn').addEventListener('click', async () => {
    const btn = $('#regenMatBtn');
    btn.disabled = true;
    btn.textContent = '重新生成中…';
    try {
      const r = await api(`/api/jobs/${jobId}/tailor`, { method: 'POST' });
      state.materials[jobId] = r.materials;
      toast('已重新生成', 'success');
      showMaterials(jobId);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '🔄 重新生成';
      toast(e.message, 'error');
    }
  });

  // ① 查看JD分析（复用找岗位页的完整匹配分析块）
  $('#jdToggleBtn').addEventListener('click', () => {
    const block = $('#jdBlock');
    const btn = $('#jdToggleBtn');
    if (!block.hidden) { block.hidden = true; btn.textContent = '① 查看JD分析'; return; }
    block.hidden = false;
    const app = state.analyses[jobId];
    block.innerHTML = (app && app.match && app.match.matchScore)
      ? matchBlockHTML(app)
      : `<div class="hint">该岗位暂无完整匹配分析，可在「找岗位」页对岗位执行分析后查看。</div>`;
    btn.textContent = '① 收起JD分析';
  });

  // ② 查看AI优化记录 → 滚动到优化分析区块
  $('#optToggleBtn').addEventListener('click', () => {
    const el = $('#optSec');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.style.boxShadow = '0 0 0 2px var(--gold)';
      setTimeout(() => { el.style.boxShadow = ''; }, 1500);
    } else {
      toast('还没有AI优化记录，请先生成投递材料', 'error');
    }
  });

  // ④ 查看历史版本 → 滚动到版本列表
  $('#verToggleBtn').addEventListener('click', () => {
    const el = $('#versionsSec');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else toast('还没有版本记录', 'error');
  });

  // ③ 生成 PDF 简历：Node 中转调 Python 公共 PDF 模块（内容 = 本岗位定制版）
  $('#pdfResumeBtn').addEventListener('click', async () => {
    const btn = $('#pdfResumeBtn');
    const st = $('#pdfStatus');
    btn.disabled = true;
    btn.textContent = '⏳ 生成中…';
    st.hidden = false;
    st.textContent = '正在用本岗位定制版生成 PDF，请稍候…';
    try {
      const r = await api('/api/resume/generate-pdf', { method: 'POST', body: JSON.stringify({ jobId }) });
      st.innerHTML = `✅ PDF已生成（${esc(r.filename)}）<br><a class="jc-link" href="${esc(r.pdf_url)}" download>⬇️ 下载 PDF</a>`;
      // 刷新版本列表（pdfPath/status 已回填）
      const v = await api('/api/resume-versions/' + jobId).catch(() => null);
      if (v && v.exists) {
        const sec = $('#versionsSec');
        if (sec) sec.outerHTML = versionsBlockHTML(jobId, v.versions);
      }
    } catch (e) {
      st.textContent = `❌ ${e.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = '③ 生成PDF简历';
    }
  });
}

function answerRow(q, a) {
  const div = document.createElement('div');
  div.className = 'qa-edit qa-block';
  div.innerHTML = `
    <input class="qa-q" value="${esc(q)}" placeholder="问题，如：为什么选择我们公司">
    <textarea class="qa-a" rows="3" placeholder="答案">${esc(a)}</textarea>
    <button class="del-item qa-del" style="position:static;float:right;">删除</button>`;
  div.querySelector('.qa-del').addEventListener('click', () => div.remove());
  return div;
}

// ---------------- 投递跟踪 ----------------
const STATUS_LIST = ['待投递', '已投递', '笔试', '面试', '已拿Offer', '被拒', '放弃'];

async function loadTrack() {
  try {
    const r = await api('/api/applications');
    state.applications = r.items;
    const board = $('#trackBoard');
    if (!r.items.length) {
      board.innerHTML = `<div class="empty-state">还没有已确认的岗位。去「找岗位」确认投递后，这里会出现跟踪卡片。</div>`;
      return;
    }
    board.innerHTML = r.items.map((a) => `
      <div class="track-item">
        <div class="ti-main">
          <h4>${esc(a.company)} · ${esc(a.title)}</h4>
          <div class="ti-meta">📍 ${esc(a.location)} ｜ ${esc(a.platform)} ${a.hasMaterials ? '｜ ✅ 材料已生成' : '｜ ⚠️ 材料未生成'}</div>
        </div>
        <span class="status-chip ${a.applyStatus}">${esc(a.applyStatus)}</span>
        <select class="status-sel" data-id="${a.id}">
          ${STATUS_LIST.map((s) => `<option ${a.applyStatus === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <div>
          ${a.url ? `<a class="jc-link" href="${esc(a.url)}" target="_blank" rel="noopener">投递入口 ↗</a>` : ''}
        </div>
      </div>`).join('');
    $$('.status-sel').forEach((sel) =>
      sel.addEventListener('change', async () => {
        try {
          await api(`/api/applications/${sel.dataset.id}/status`, { method: 'POST', body: JSON.stringify({ status: sel.value }) });
          toast(`已更新为「${sel.value}」`, 'success');
        } catch (e) {
          toast(e.message, 'error');
        }
      })
    );
  } catch (e) {
    toast(e.message, 'error');
  }
}
