// 找岗引擎：多角度联网搜索 → 解析候选 → 去重/过滤 → 打分 → 入库
const llm = require('./llm');
const store = require('./store');

// 用户默认岗位关键词（可被设置覆盖）
const DEFAULT_KEYWORDS = [
  '数字化运营', '市场分析', '综合管理', '内容运营', '用户增长',
  '电商运营', '文旅营销', '用户运营', '数据分析', '新媒体运营',
  '市场营销', '品牌运营', '供应链运营',
];

// 数据来源平台清单（用户提供，按类别组织；搜索/提词时告知 AI 优先采用这些官方与招聘平台）
const SOURCE_PLATFORMS = [
  { group: '国家官方校招平台', sites: ['国聘网 iguopin.com', '中国公共招聘网 job.mohrss.gov.cn', '24365国家大学生就业服务平台 job.ncss.cn', '就业在线 jobonline.cn'] },
  { group: '央企/国企专项', sites: ['国家电网招聘平台 zhaopin.sgcc.com.cn', '中智招聘 ciicsjob.com', '中国烟草招聘系统 tobacco.gov.cn'] },
  { group: '地方政府人才网', sites: ['北京人才网 bjrc.com.cn', '上海外服 fsq.com.cn', '广东人才网 gdrc.com', '浙江人才网 zjrc.com'] },
  { group: '综合招聘平台', sites: ['应届生求职网 yingjiesheng.com', '前程无忧 51job.com', 'BOSS直聘 zhipin.com', '智联招聘 zhaopin.com', '实习僧 shixiseng.com', '猎聘网 liepin.com', '拉勾网 lagou.com', '牛客网 nowcoder.com', '海投网 haitou.cc', '刺猬实习 ciwei.net'] },
  { group: '企业官方校招', sites: ['腾讯校招 join.qq.com', '阿里巴巴校招 campus.alibaba.com', '华为招聘 career.huawei.com', '字节跳动校招 job.bytedance.com/campus', '宝洁校招 pgcareers.com'] },
  { group: '国际/外企', sites: ['领英全球版 linkedin.com', '领英中国 linkedin.cn', 'Indeed indeed.com', '外企德科 fescoadecco.com'] },
];

function sourceListText() {
  return SOURCE_PLATFORMS.map((g) => `${g.group}：${g.sites.join('、')}`).join('\n');
}

function getSources() {
  return SOURCE_PLATFORMS.map((g) => ({ group: g.group, sites: g.sites }));
}

// 央企/国企识别特征词
const SOE_HINTS = [
  '中国', '中建', '中铁', '中交', '中电', '中核', '中航', '中船', '中车',
  '中石油', '中石化', '中海油', '国家电网', '南方电网', '中国移动', '中国联通',
  '中国电信', '中国银行', '工商银行', '农业银行', '建设银行', '交通银行',
  '中国烟草', '招商局', '华润', '华侨城', '中旅', '首旅', '国旅', '携程旅游',
  '文旅', '文广', '广电', '日报', '报业', '出版', '广播电视台', '传媒集团',
  '旅游集团', '交通投资', '交投', '城投', '建工', '建投', '农投', '产业投资',
  '国投', '金控', '担保', '农商', '银行', '证券', '保险', '基金', '信托',
  '烟草', '盐业', '电力', '能源集团', '燃气', '供水', '地铁', '机场', '港口',
  '轨道交通', '水务', '邮储', '信用合作社',
];

// 大厂识别特征词
const BIGTECH_HINTS = [
  '字节', '腾讯', '阿里巴巴', '阿里', '百度', '美团', '京东', '拼多多',
  '网易', '快手', '小红书', '哔哩哔哩', 'bilibili', '滴滴', '携程集团',
  'SHEIN', '米哈游', '小米', '华为', 'OPPO', 'vivo', '荣耀', '360', '新浪',
  '搜狐', '唯品会', '得物', '途家', '去哪儿', 'boss', '智联', '前程无忧',
];

// 一、构造搜索 query 列表（多角度 + 平台定向）
function buildQueries(settings) {
  const cities = (settings.cities && settings.cities.length) ? settings.cities : ['北京', '上海', '广州', '深圳', '杭州'];
  const cityStr = cities.join('、');
  const major = settings.major || '电子商务';
  return [
    `2027届秋招 央国企 运营/管理岗 校园招聘 正在网申 数字化运营 市场分析 综合管理 工作地点${cityStr} 2026`,
    `2027届秋招 央企 省属国企 校招 运营岗 新媒体运营 数据分析 网申 投递 ${cityStr} 2026年 最新`,
    `2027届秋招 互联网大厂 运营岗 内容运营 用户增长 电商运营 校招 网申入口 ${cityStr}`,
    `2027届秋招 文旅集团 文旅营销 用户运营 品牌 校园招聘 华侨城 中旅 首旅 ${cityStr}`,
    `2027届秋招 国企 管培生 综合管理 市场推广 电商运营 校招 投递链接 ${cityStr}`,
    `2027届秋招 国企子公司 运营岗 ${major}专业可投 网申 截止时间 ${cityStr}`,
    // ---- 平台定向轮：针对用户提供的数据来源平台逐类深挖 ----
    `2027届秋招 正在网申 site:iguopin.com 央企 国企 运营岗 管理岗 投递`,
    `2027届秋招 央企 校招官网 国家电网 中国烟草 中智招聘 华润 运营 综合管理 网申入口`,
    `2027届秋招 应届生求职网 yingjiesheng.com 牛客网 海投网 国企 运营岗 电商 网申`,
    `2027届秋招 腾讯 阿里巴巴 字节跳动 华为 宝洁 校招官网 运营岗 内容运营 电商 网申`,
    `2027届秋招 北京人才网 上海外服 广东人才网 浙江人才网 国企 运营岗 综合管理 招聘`,
  ];
}

// 二、单轮搜索的 prompt
function searchPrompt(query, settings) {
  const cities = (settings.cities && settings.cities.length) ? settings.cities : ['北京', '上海', '广州', '深圳', '杭州'];
  const keywords = (settings.keywords && settings.keywords.length) ? settings.keywords : DEFAULT_KEYWORDS;
  return `你是秋招岗位信息搜索助手，请联网搜索"2027届毕业生秋招"正在开放投递的岗位。

【本次搜索主题】${query}

【候选岗位要求】
- 面向 2027 届应届毕业生（2027 年毕业）
- 工作地点：${cities.join('/')}（全国不限的也可以列）
- 岗位类型：央国企运营/管理岗（数字化运营、市场分析、综合管理、管培生），互联网运营岗（内容运营、用户增长、电商运营、新媒体运营），文旅集团岗（文旅营销、用户运营、品牌运营）
- 必须是 2026 年 7 月之后仍然开放投递的秋招岗位（提前批/正式批均可）

【优先数据来源】以下平台/渠道是我们认可的来源，请优先在其中寻找，并采用它们的官方投递入口；找不到的再从其他可信渠道补充：
${sourceListText()}

【输出要求】只输出一个 JSON 数组，不要任何其他文字、不要 markdown。数组每一项格式：
{"title":"岗位名称","company":"招聘单位全称","location":"工作地点城市","platform":"实际发布平台名（如 国聘网/应届生求职网/公司官网校招页），从上述【优先数据来源】或实际来源填，不要编造","url":"投递入口链接，优先采用上述平台的官方链接，无则空字符串","deadline":"投递截止，未知填未知","jd_summary":"一句话职责摘要","requirement":"学历要求，如本科/硕士，未知填未知","keywords_matched":["命中的用户关键词，从这些里选：${keywords.join('/')}"],"salary":"岗位薪资，如 8-12K·13薪，招聘公告/官网未标注就填 未知","work_days":"双休/大小周/单休，从招聘信息推断，确实没有信息就填 未知","insurance":"六险一金/五险一金/六险二金，从招聘信息推断，未知填 未知","subsidies":["已确认的补贴，从 房补/餐补/路补/交通补贴/住房补贴 中选；没有或未知就填空数组 []"]}

要求：最多返回 6 个真正相关、且有实际投递意义的岗位，宁缺毋滥；不要编造，搜索不到就给空数组。`;
}

// 二·补、把搜索结果文本二次结构化提取为岗位 JSON 数组（用于模型没直接给 JSON 时）
function extractJobsPrompt(searchText) {
  return `下面是联网搜索到的秋招岗位信息（可能是不规整的文本）。请把其中"面向 2027 届应届生、目前开放投递"的岗位提取出来，严格只输出一个 JSON 数组，不要任何其他文字、不要 markdown、不要解释。

每项格式：
{"title":"岗位名称","company":"招聘单位全称","location":"工作地点","platform":"实际发布平台名，如 国聘网/应届生求职网/公司官网校招页，不要编造","url":"投递入口链接，优先采用官方/招聘平台链接，无则空字符串","deadline":"截止时间，未知填未知","jd_summary":"一句话职责","requirement":"学历要求，未知填未知","keywords_matched":["命中的关键词，从这些里选：数字化运营/市场分析/综合管理/内容运营/用户增长/电商运营/文旅营销/用户运营/数据分析/新媒体运营/市场营销"],"salary":"岗位薪资，如 8-12K·13薪，没标注就填 未知","work_days":"双休/大小周/单休，推断不出来填 未知","insurance":"六险一金/五险一金/六险二金，推断不出来填 未知","subsidies":["已确认补贴，如 房补/餐补/路补/交通补贴/住房补贴；没有或未知填 []"]}

要求：只保留有明确招聘单位和岗位的；不要编造岗位或链接；没有符合条件的就输出 []。

【搜索结果文本】
${searchText.slice(0, 16000)}`;
}

// 三、候选规范化
function normalize(c, citations) {
  const title = String(c.title || '').trim();
  let company = String(c.company || '').trim();
  const location = String(c.location || '').trim();
  let url = String(c.url || '').trim();
  if (!url && citations && citations.length) url = citations[0].url || '';
  // 去掉公司名称里冗余的招聘文案
  company = company.replace(/（.*?招聘.*?）/g, '').replace(/招聘$/g, '').trim();
  return {
    title,
    company,
    location,
    platform: String(c.platform || '').trim() || '未知平台',
    url,
    deadline: String(c.deadline || '').trim() || '未知',
    jdSummary: String(c.jd_summary || '').trim(),
    requirement: String(c.requirement || '').trim() || '未知',
    keywordsMatched: Array.isArray(c.keywords_matched) ? c.keywords_matched : [],
    salary: String(c.salary || '').trim() || '未知',
    workDays: String(c.work_days || '').trim() || '未知',
    insurance: String(c.insurance || '').trim() || '未知',
    subsidies: Array.isArray(c.subsidies) ? c.subsidies.map((s) => String(s).trim()).filter(Boolean) : [],
  };
}

// 五·补、福利待遇评级：只输出一个等级 优/良/中/差/未知
// 规则（用户要求）：该有的福利都有的才能打「优」
//   - 优 = 明确「五险一金或六险一金」+ 明确「双休」+ 至少一项房补/餐补/路补等补贴
//   - 有保险 + 双休但无补贴 → 良；有保险但单休/大小周 → 中；其他 → 差
//   - 三项都查不到任何信息 → 未知（不误导）
// 保险是否达到"五险一金"水平（含 六险二金/五险二金/补充公积金/企业年金 等变体）
function hasFullInsurance(ins) {
  return /[五六]险/.test(ins) && /金/.test(ins);
}
// 保险打分：六险(含一金/二金) > 五险一金/二金 > 只有五险 > 未知
function insurancePoints(ins) {
  const hasFund = /金/.test(ins);
  if (/六险/.test(ins)) return hasFund ? 32 : 24;
  if (/五险/.test(ins)) return hasFund ? 30 : 15;
  return 8;
}
// 休假制度归一化：优先按"双休"判定（AI 可能输出 双休（做五休二）/周末双休 等带说明的文本）
function daysKind(days) {
  if (days.includes('双休')) return 'double';
  if (days.includes('大小周')) return 'size';
  if (days.includes('单休')) return 'single';
  return 'unknown';
}
function benefitsScore(job) {
  const ins = String(job.insurance || '').trim();
  const days = String(job.workDays || '').trim();
  const subs = job.subsidies || [];
  const insOk = /险/.test(ins) && ins !== '未知';
  const daysKindOf = daysKind(days);
  const anyData = insOk || daysKindOf !== 'unknown' || subs.length > 0;

  let s = insurancePoints(ins);
  if (daysKindOf === 'double') s += 32;
  else if (daysKindOf === 'size') s += 16;
  else if (daysKindOf === 'single') s += 5;
  else s += 8; // 未知
  s += Math.min(30, subs.length * 10); // 每项补贴 +10

  const allBest = hasFullInsurance(ins) && daysKindOf === 'double' && subs.length >= 1;
  let grade;
  if (allBest) grade = '优';
  else if (s >= 70) grade = '良';
  else if (s >= 45) grade = '中';
  else grade = '差';
  if (!anyData) grade = '未知';
  return { score: Math.min(100, Math.round(s)), grade };
}

// 公司类型识别
function classifyCompany(company) {
  const s = company || '';
  if (SOE_HINTS.some((k) => s.includes(k))) return 'soe';
  if (BIGTECH_HINTS.some((k) => s.toLowerCase().includes(k.toLowerCase()))) return 'bigtech';
  // 集团/股份+国企常见后缀
  if (/(集团|股份)有限公司$/.test(s)) return 'soe';
  return 'unknown';
}

// 四、硬条件过滤
function passesFilters(job) {
  const req = job.requirement || '';
  if (/硕士|研究生|博士/.test(req)) return false; // 只投本科可申的岗位
  if (/博士/.test(req)) return false;
  if (!job.title || !job.company) return false;
  if (/实习|校园大使/.test(job.title)) return false;
  return true;
}

// 五、打分（0-100）
function score(job, settings) {
  let s = 0;
  const type = job.companyType;
  if (type === 'soe') s += 40;
  else if (type === 'bigtech') s += 30;
  else s += 22;

  // 关键词命中（最多 30 分，每命中一个+7，取标题与匹配词交集）
  const keywords = (settings.keywords && settings.keywords.length) ? settings.keywords : DEFAULT_KEYWORDS;
  const text = `${job.title} ${job.jdSummary} ${(job.keywordsMatched || []).join(' ')}`;
  let hits = 0;
  for (const k of keywords) {
    if (text.includes(k) || (job.keywordsMatched || []).some((m) => m.includes(k) || k.includes(m))) hits++;
  }
  s += Math.min(30, hits * 7);

  // 学历要求
  const req = job.requirement || '';
  if (/本科/.test(req) || req === '未知' || !req) s += 10;
  else s += 3;

  // 城市
  const cities = (settings.cities && settings.cities.length) ? settings.cities : [];
  if (!cities.length || /全国|不限|多地/.test(job.location)) s += 15;
  else if (cities.some((c) => job.location.includes(c))) s += 20;
  else s += 5;

  return Math.min(100, Math.round(s));
}

// 去重 key（精确匹配，用于搜索过程中快速判重）
function dedupeKey(job) {
  return `${job.company}|${job.title}|${job.location}`;
}

// ---------- 近似去重（同一公司的同一岗位，标题措辞不同） ----------
// 公司名归一化：去掉括号说明与 集团/股份/有限…等后缀
function normCompany(c) {
  let s = String(c || '').replace(/[（(].*?[)）]/g, '').trim();
  s = s.replace(/(股份有限公司|有限责任公司|集团有限公司|集团公司|有限公司|公司)$/, '');
  s = s.replace(/集团$|股份$|科技$|技术$|网络$|信息$|控股$|投资$|研究院$/, '');
  return s.trim();
}

// 标题去噪词（不含"生"，避免误伤 运营商/生产 等词）
const ROLE_NOISE = ['2027届', '2027', '校园', '校招', '招聘', '应届生', '提前批', '正式批', '秋招', '网申', '投递', '方向', '岗位', '类', '等', '的', '及', '与', '或', '和', '管培生岗位'];

// 提取岗位"角色核心词"：括号里的内容（如 内容运营/用户运营）是有效信号，只当分隔符保留
function roleTokens(title) {
  let s = String(title || '');
  s = s.replace(/[（(]/g, ' ').replace(/[)）]/g, ' '); // 括号当空格，内容保留
  for (const n of ROLE_NOISE) s = s.split(n).join(' ');
  s = s.replace(/[\/、,，.·•\-—]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.split(' ').filter((w) => w.length >= 3);
}

// 去噪后的标题核心串（如 "运营方向（2027校园招聘）" → "运营方向"），用于兜底匹配
function titleCore(title) {
  let s = String(title || '').replace(/[（(]/g, ' ').replace(/[)）]/g, ' ');
  for (const n of ROLE_NOISE) s = s.split(n).join(' ');
  s = s.replace(/[\/、,，.·•\-—\s]/g, '');
  return s;
}

// 两个岗位是否算"同一岗位"（角色核心词有包含/重叠；或去噪标题核心串互为包含）
function isDupRole(a, b) {
  const ta = roleTokens(a.title);
  const tb = roleTokens(b.title);
  if (ta.length && tb.length && ta.some((x) => tb.some((y) => x.includes(y) || y.includes(x)))) return true;
  const ca = titleCore(a.title);
  const cb = titleCore(b.title);
  if (ca.length >= 2 && cb.length >= 2 && (ca.includes(cb) || cb.includes(ca))) return true;
  return false;
}

// 信息丰富度（决定近似重复时保留哪份：已确认/有材料 > 有福利 > 有链接 > 有摘要）
function jobQuality(j) {
  let q = j.score || 0;
  if (j.status === 'confirmed') q += 30;
  try {
    const mats = store.load('materials', {});
    if (mats[j.id]) q += 50;
  } catch (e) { /* 忽略 */ }
  if (j.benefitsGrade && j.benefitsGrade !== '未知') q += 20;
  if (j.url) q += 10;
  if (j.jdSummary) q += 5;
  return q;
}

// 把 drop 里更全的信息补进 keep（keep 缺失的字段用 drop 的）
function mergeInfo(keep, drop) {
  const pick = ['salary', 'workDays', 'insurance', 'subsidies', 'benefitsNotes', 'benefitsGrade', 'benefitsScore', 'url', 'jdSummary', 'deadline', 'requirement', 'platform'];
  for (const k of pick) {
    const kEmpty = keep[k] == null || keep[k] === '' || keep[k] === '未知' || (Array.isArray(keep[k]) && !keep[k].length);
    const dHas = drop[k] != null && drop[k] !== '' && drop[k] !== '未知' && (!Array.isArray(drop[k]) || drop[k].length);
    if (kEmpty && dHas) keep[k] = drop[k];
  }
  // 关键词并集
  const kw = new Set([...(keep.keywordsMatched || []), ...(drop.keywordsMatched || [])]);
  keep.keywordsMatched = [...kw];
}

// 对整个岗位列表做近似去重，返回 { jobs, removed }
function dedupeNear(jobs) {
  const groups = [];
  for (const j of jobs) {
    const key = normCompany(j.company);
    let g = groups.find((gr) => gr.key.includes(key) || key.includes(gr.key));
    if (!g) {
      g = { key, list: [] };
      groups.push(g);
    }
    g.list.push(j);
  }
  const kept = [];
  let removed = 0;
  for (const g of groups) {
    const list = [];
    for (const j of g.list) {
      const dup = list.find((k) => isDupRole(k, j));
      if (dup) {
        removed++;
        const better = jobQuality(j) > jobQuality(dup) ? j : dup;
        if (better === j) list[list.indexOf(dup)] = j;
        mergeInfo(better, better === j ? dup : j);
      } else {
        list.push(j);
      }
    }
    kept.push(...list);
  }
  return { jobs: kept, removed };
}

// 六、完整搜索流程（可停止）
let searchState = { running: false, stop: false, step: '', log: [], found: 0, startedAt: null };
// 福利补充任务状态（给已有岗位批量补薪资/双休/险种/补贴）
let enrichState = { running: false, stop: false, step: '', log: [], done: 0, total: 0 };

function getSearchState() {
  return { ...searchState, enrich: { ...enrichState } };
}

async function runSearch(onProgress) {
  if (searchState.running) {
    throw new Error('已有搜索正在进行，请等待完成或先停止。');
  }
  const settings = store.load('settings', {});
  const jobs = store.load('jobs', []);
  const seen = new Set(jobs.map((j) => dedupeKey(j)));

  searchState = { running: true, stop: false, step: '准备中', log: [], found: 0, startedAt: new Date().toISOString() };
  const log = (msg) => {
    searchState.log.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);
    if (searchState.log.length > 200) searchState.log.shift();
    if (onProgress) onProgress(msg);
  };

  const queries = buildQueries(settings);
  let found = 0;
  try {
    for (let i = 0; i < queries.length; i++) {
      if (searchState.stop) {
        log('已停止（用户手动中断）');
        break;
      }
      const q = queries[i];
      searchState.step = `搜索中 ${i + 1}/${queries.length}：${q.slice(0, 24)}…`;
      log(`▶ 第 ${i + 1}/${queries.length} 轮：${q}`);
      let result;
      try {
        result = await llm.search(searchPrompt(q, settings), { searchContextSize: 'high' });
      } catch (e) {
        log(`  该轮失败：${e.message.slice(0, 120)}`);
        continue;
      }
      let candidates = [];
      try {
        candidates = llm.extractJson(result.text);
        if (!Array.isArray(candidates)) candidates = [candidates];
      } catch (e) {
        // 模型没直接给 JSON：用一次普通对话把搜索结果二次结构化为 JSON
        try {
          log(`  该轮直接解析失败，尝试二次结构化…`);
          const jsonText = await llm.chat(extractJobsPrompt(result.text), { reasoning: 'low' });
          candidates = llm.extractJson(jsonText);
          if (!Array.isArray(candidates)) candidates = [candidates];
        } catch (e2) {
          log(`  二次结构化失败，跳过该轮。`);
          continue;
        }
      }
      for (const c of candidates) {
        if (searchState.stop) break;
        const job = normalize(c, result.citations);
        if (!passesFilters(job)) continue;
        const key = dedupeKey(job);
        if (seen.has(key)) continue;
        seen.add(key);
        job.id = store.newId();
        job.companyType = classifyCompany(job.company);
        job.score = score(job, settings);
        const bs = benefitsScore(job);
        job.benefitsScore = bs.score;
        job.benefitsGrade = bs.grade;
        job.status = 'pending';
        job.verified = false;
        job.source = 'search';
        job.foundAt = new Date().toISOString();
        jobs.push(job);
        found++;
        log(`  ✓ ${job.company} · ${job.title}（${job.location}）分${job.score}`);
      }
      if (!candidates.length) log('  本轮未找到符合条件的新岗位。');
    }
    const dedup = dedupeNear(jobs);
    store.save('jobs', dedup.jobs);
    if (dedup.removed > 0) log(`近似去重：合并移除 ${dedup.removed} 条重复岗位，库中共 ${dedup.jobs.length} 个。`);
    log(`搜索完成：本次新增 ${found} 个岗位，库中共 ${dedup.jobs.length} 个。`);
  } finally {
    searchState.running = false;
    searchState.step = searchState.stop ? '已停止' : '完成';
    searchState.found = found;
  }
  return { found, total: jobs.length };
}

function stopSearch() {
  searchState.stop = true;
}

// 七、批量补充福利信息（给已有岗位联网查 薪资/双休/险种/补贴）
const ENRICH_PROMPT = (job) => `你是岗位福利信息核查助手。请联网搜索「${job.company} ${job.title} 校园招聘」的福利待遇信息，重点查这家单位对校招生承诺的薪资、休假制度、社保公积金、各类补贴。
严格只输出一个 JSON 对象，不要任何其他文字、不要 markdown：
{"salary":"该岗位或该公司校招薪资范围，如 8-12K·13薪；确实查不到就填 未知","work_days":"双休/大小周/单休；查不到填 未知","insurance":"六险一金/五险一金/五险；查不到填 未知","subsidies":["已确认存在的补贴，从 房补/餐补/路补/交通补贴/住房补贴 中选；没有或查不到就输出空数组"],"benefits_notes":"一句话补充其他福利，如 补充公积金/年终奖/带薪年假/节日礼金；查不到则空字符串"}
要求：基于搜索结果如实填写，禁止编造；查不到的就用 未知 或空数组。`;

function runEnrichBenefits(onProgress) {
  if (enrichState.running) {
    return Promise.reject(new Error('已有福利补充任务正在进行，请等待完成或先停止。'));
  }
  const jobs = store.load('jobs', []);
  // 只补充还没有确认福利评级的岗位（已有 优/良/中/差 的跳过），保证可重复点击且更快
  const targets = jobs.filter((j) => j.status !== 'skipped' && (!j.benefitsGrade || j.benefitsGrade === '未知'));
  if (!targets.length) return Promise.resolve({ done: 0, total: 0 });

  enrichState = { running: true, stop: false, step: '准备中', log: [], done: 0, total: targets.length };
  const log = (msg) => {
    enrichState.log.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);
    if (enrichState.log.length > 200) enrichState.log.shift();
    if (onProgress) onProgress(msg);
  };

  return (async () => {
    let done = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        if (enrichState.stop) {
          log('已停止（用户手动中断）');
          break;
        }
        const job = targets[i];
        enrichState.step = `补充中 ${i + 1}/${targets.length}：${job.company} ${job.title}`;
        log(`▶ ${job.company} · ${job.title}`);
        try {
          const r = await llm.search(ENRICH_PROMPT(job), { searchContextSize: 'medium' });
          const p = llm.extractJson(r.text);
          if (p && typeof p === 'object' && !Array.isArray(p)) {
            job.salary = String(p.salary || '').trim() || '未知';
            job.workDays = String(p.work_days || '').trim() || '未知';
            job.insurance = String(p.insurance || '').trim() || '未知';
            job.subsidies = Array.isArray(p.subsidies) ? p.subsidies.map((s) => String(s).trim()).filter(Boolean) : [];
            job.benefitsNotes = String(p.benefits_notes || '').trim();
            const bs = benefitsScore(job);
            job.benefitsScore = bs.score;
            job.benefitsGrade = bs.grade;
            job.enrichedAt = new Date().toISOString();
            const sub = job.subsidies.length ? `补贴[${job.subsidies.join('/')}]` : '无补贴信息';
            log(`  ✓ 薪资 ${job.salary}｜${job.workDays}｜${job.insurance}｜${sub} → 福利${job.benefitsGrade}`);
          } else {
            log('  ✗ 该次返回无法解析为对象，跳过。');
          }
        } catch (e) {
          log(`  ✗ 补充失败：${e.message.slice(0, 80)}`);
        }
        done++;
        enrichState.done = done;
        store.save('jobs', jobs); // 每补一个保存一次，避免中途中断丢进度
      }
      log(`补充完成：成功处理 ${done}/${targets.length} 个岗位。`);
    } finally {
      enrichState.running = false;
      enrichState.step = enrichState.stop ? '已停止' : '完成';
      enrichState.done = done;
    }
    return { done, total: targets.length };
  })();
}

function stopEnrich() {
  enrichState.stop = true;
}

module.exports = { runSearch, stopSearch, runEnrichBenefits, stopEnrich, getSearchState, benefitsScore, getSources, dedupeNear };
