// JD语义分析 + 岗位解释层（Job Intelligence Layer 的第二层）
// 输入 = 职业画像 + 岗位对象 + JD 文本（用户输入优先），1 次 LLM 调用，
// 输出 = 岗位结构化解读 + 岗位解释（实际做什么）+ 语义匹配分（60% 权重）+ 匹配理由/不足/简历建议。
// 页面抓取明确降级：不实现 fetchPageText 主路径；JD 文本以用户输入为主，缺省回退现有字段。
const llm = require('./llm');

// 把画像压平成提示词输入块
function flattenProfile(profile) {
  const core = (profile.coreCompetencies || []).join('、') || '（未提炼）';
  const industry = (profile.industryExperience || [])
    .map((x) => `${x.industry || ''}（${x.depth || ''}：${x.evidence || ''}）`)
    .join('；') || '（未提炼）';
  const skills = (profile.skills || []).join('、') || '（未提炼）';
  const strengths = (profile.strengths || [])
    .map((x) => `${x.tag}——证据：${x.evidence || '无'}`)
    .join('\n') || '（未提炼）';
  return {
    identity: profile.professionalIdentity || profile.summary || '（未提炼）',
    core,
    industry,
    skills,
    strengths,
    achievements: (profile.achievements || []).join('；') || '（未提炼）',
    goal: profile.careerGoal || '（未提炼）',
  };
}

// 解析"最终生效的 JD 文本"：用户输入优先，缺省回退岗位现有字段。
function buildJobText(job, jdText) {
  if (jdText && String(jdText).trim()) return String(jdText).trim();
  const fallback = [
    `岗位：${job.title || ''}（${job.company || ''}）`,
    `摘要：${job.jdSummary || ''}`,
    `要求：${job.requirement || ''}`,
    `匹配关键词：${(job.keywordsMatched || []).join('、')}`,
  ].filter((s) => !/：(空|)$/.test(s)).join('\n');
  return fallback || `岗位：${job.title || ''}（${job.company || ''}）`;
}

const ANALYZE_PROMPT = `你是一名懂求职、懂 HR 的资深岗位分析师，正以「应届生秋招」的视角帮求职者评估目标岗位。请分析下面的岗位 JD，结合求职者的职业画像，做六件事：
① 把岗位讲清楚（岗位本身实际做什么、日常工作、发展路径）——这就是"岗位解释"，要让外行也看得懂；
② 评估求职者与该岗位的匹配度，给出 0-100 的语义匹配分（看经历、能力、意愿与岗位的契合程度，不是看分数够不够高，是看匹配不匹配）；
③ 逐条对照 JD 要求与画像，给出有事实依据的匹配理由、明确不足、以及可落地的简历修改建议；
④ 评估岗位价值 careerValue：未来 3-5 年发展空间、行业趋势与岗位生命周期、是否企业核心业务线、能否积累高价值能力（用户/商业/增长/产品/数据）；
⑤ 评估成长空间 growth：能否接触核心业务指标、能否参与完整业务闭环、能否培养不可替代能力、向高级运营/业务负责人/产品负责人的晋升可能性；
⑥ 评估竞争难度 competition：该岗位的应届生竞争强度、求职者背景在这批候选人里的竞争力、学历/专业/技能壁垒；
⑦ 综合以上给出一句推荐理由 recommendReason 和风险提示 risks。

【应届生秋招视角（重要）】
- 不要用社招标准苛求：应届生普遍缺少大厂/名企实习是正常的，重点看培养潜力、成长性、可迁移能力，而不是"已有经验是否完全对口"。
- 学历/专业是软信号不是硬淘汰：只要能力方向对得上，就正常给分，不要因院校背景降分。
- competition 按"该岗位的应届生候选人池"判断（大厂/热门岗通常更激烈），不是按社招竞争算。
- 综合评分只评"岗位值不值得这个应届生投"，匹配一般但平台好、成长大的岗位仍然值得推荐（对应探索投递）。

评分参考（semanticScore，0-100）：
- 90+：画像核心能力与 JD 高度吻合，有多条可追溯证据直接命中岗位要求；
- 70-89：能力方向对得上，但某 1-2 条硬性要求（如行业/经验/工具）证据不足；
- 50-69：方向沾边但缺少关键要求对应的经历，或岗位与其经历差异较大；
- 50 以下：基本不匹配（如岗位是技术开发而画像全是运营）。
careerValue / growth 高分参考：≥80 = 核心业务/强成长；50-79 = 有发展但非最优；<50 = 偏边缘或夕阳。
competition 高分参考：≥75 = 竞争激烈（大厂热门/门槛高）；50-74 = 适中；<50 = 相对容易。
不要给敷衍分，必须结合下面的画像事实给出理由。

严格只输出一个 JSON 对象，不要任何多余文字：
{
  "unit": "事业群/部门（JD 未写则空字符串）",
  "position": "把岗位名细化成具体职位，如 JD 写'运营方向'则给出'内容运营专员'",
  "summary": "2-3 句这个岗位要做什么的摘要",
  "requirements": ["逐条列出 JD 里的岗位要求"],
  "status": "招聘状态（JD 未写则空字符串）",
  "publishDate": "发布时间（JD 未写则空字符串）",
  "explanation": {
    "overview": "用大白话讲这个岗位到底实际做什么，2-3 句",
    "daily": ["典型日常工作 3-5 条"],
    "growth": ["发展路径/晋升方向 2-3 条"]
  },
  "semanticScore": 85,
  "matchReasons": [{"requirement": "JD 里的某条要求", "evidence": "画像里能对上这条要求的具体事实（可追溯到某段经历/技能）"}],
  "gaps": ["明确不足 1-3 条，如'缺少大型品牌 campaign 经验'"],
  "resumeAdvice": ["可落地的简历修改建议 1-3 条，如'把第二段实习改写成突出营销策划与量化结果'"],
  "careerValue": {"score": 85, "reasons": ["3-5 条：发展空间/行业趋势/是否核心业务/能否积累高价值能力"]},
  "growth": {"score": 80, "reasons": ["3-5 条：核心业务指标/完整闭环/不可替代能力/晋升方向"]},
  "competition": {"score": 70, "reasons": ["2-3 条：应届生竞争强度/本人竞争力/壁垒"], "barrier": "学历/专业/技能壁垒一句话（无则空字符串）"},
  "recommendReason": "2-3 句综合推荐理由（结合匹配+价值+成长+竞争）",
  "risks": ["2-4 条风险提示，如：大厂校招竞争激烈/非核心业务线/该岗偏执行"]
}`;

async function analyzeJob(profile, job, jdText) {
  const p = flattenProfile(profile);
  const profileBlock = [
    `【职业定位】${p.identity}`,
    `【核心能力】${p.core}`,
    `【行业经验】${p.industry}`,
    `【技能】${p.skills}`,
    `【优势标签】\n${p.strengths}`,
    `【成果数据】${p.achievements}`,
    `【职业目标】${p.goal}`,
  ].join('\n');
  const jobBlock = `【公司】${job.company || ''}\n${buildJobText(job, jdText)}`;

  const prompt = `${ANALYZE_PROMPT}\n\n【求职者职业画像】\n${profileBlock}\n\n【目标岗位】\n${jobBlock}`;
  const out = await llm.chat(prompt, { reasoning: 'medium' });
  const parsed = llm.extractJson(out);

  const str = (v) => String(v || '').trim();
  const arr = (v) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : []);
  // 规范化后返回
  return {
    unit: str(parsed.unit),
    position: str(parsed.position),
    summary: str(parsed.summary),
    requirements: arr(parsed.requirements),
    status: str(parsed.status),
    publishDate: str(parsed.publishDate),
    explanation: {
      overview: str(parsed.explanation && parsed.explanation.overview),
      daily: arr(parsed.explanation && parsed.explanation.daily),
      growth: arr(parsed.explanation && parsed.explanation.growth),
    },
    semanticScore: clampScore(parsed.semanticScore),
    matchReasons: Array.isArray(parsed.matchReasons)
      ? parsed.matchReasons.map((x) => ({
          requirement: str(x && x.requirement),
          evidence: str(x && x.evidence),
        })).filter((x) => x.requirement)
      : [],
    gaps: arr(parsed.gaps),
    resumeAdvice: arr(parsed.resumeAdvice),
    careerValue: {
      score: clampScore(parsed.careerValue && parsed.careerValue.score),
      reasons: arr(parsed.careerValue && parsed.careerValue.reasons),
    },
    growth: {
      score: clampScore(parsed.growth && parsed.growth.score),
      reasons: arr(parsed.growth && parsed.growth.reasons),
    },
    competition: {
      score: clampScore(parsed.competition && parsed.competition.score),
      reasons: arr(parsed.competition && parsed.competition.reasons),
      barrier: str(parsed.competition && parsed.competition.barrier),
    },
    recommendReason: str(parsed.recommendReason),
    risks: arr(parsed.risks),
  };
}

function clampScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

module.exports = { analyzeJob, buildJobText, flattenProfile };
