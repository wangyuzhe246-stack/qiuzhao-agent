// 职业画像层（Job Intelligence Layer 的第一层）
// 从结构化简历 + 求职设置，综合提炼"我是谁、擅长什么、要找什么"的可复用画像。
// 画像存 data/profile.json（职业记忆库），供 JD 语义分析 / 能力匹配 / 简历优化复用。
const llm = require('./llm');

// 把结构化简历 + 设置压平成画像提示词用的文本块
function flattenResume(resume) {
  const basic = resume.basic || {};
  const edu = (resume.education || []).map((e) => `${e.school} ${e.degree} ${e.major} ${e.period}${e.gpa ? ' GPA:' + e.gpa : ''}`).join('；');
  const intern = (resume.internship || [])
    .filter((i) => i.company || i.role || i.description)
    .map((i) => `${i.company}｜${i.role}｜${i.period}\n${i.description}`)
    .join('\n');
  const project = (resume.project || [])
    .filter((p) => p.name || p.role || p.description)
    .map((p) => `${p.name}｜${p.role}｜${p.period}\n${p.description}`)
    .join('\n');
  return {
    basic: `${basic.name || '（未填）'} | ${basic.birthYear || ''}年 | ${basic.party || ''} | ${basic.status || ''}`,
    edu: edu || '（未填）',
    intern: intern || '（未填）',
    project: project || '（未填）',
    skills: (resume.skills || []).join('、') || '（未填）',
    awards: (resume.awards || []).join('、') || '（未填）',
    certs: (resume.certifications || []).join('、') || '（未填）',
    selfEval: resume.selfEval || '（未填）',
  };
}

const PROFILE_PROMPT = `你是资深 HR + 职业规划顾问。请阅读求职者的完整简历，提炼一份"职业画像"（professional profile），用于后续给每个岗位做匹配分析和简历优化。

要求：
- 画像必须忠于简历事实，禁止编造；可以提炼、归纳、分类。
- coreCompetencies（核心能力）用"能被 JD 要求直接对上号"的词组表述（如"内容策划与增长"、"达人营销与BD"、"数据分析"、"活动运营"），不要堆砌工具名词。
- industryExperience（行业经验）给出行业 + 深浅程度（几段实习/项目）+ 证据。
- strengths（优势标签）每条必须锚定简历里的具体事实作 evidence，可追溯到某段实习/项目/成果；禁止"沟通能力强"这类空泛词。
- achievements（成果数据）尽量列出简历里的量化数字（增长、曝光、转化等）。
- careerGoal（职业目标）基于简历与求职方向推断一句话，尽量具体。
- targetRoles 给出 3-5 个该求职者最该投的目标岗位方向（具体岗位名，如"内容运营"、"用户增长"、"市场策划"，不要给"运营类岗位"这种大类）。
- 全部中文。

严格只输出一个 JSON 对象，不要任何多余文字：
{
  "summary": "3-4 句话的画像：我是谁（背景）+ 擅长什么（核心能力）+ 找什么样的工作",
  "professionalIdentity": "职业定位一句话，如：内容营销方向的内容运营/用户增长，2 段新媒体实习",
  "coreCompetencies": ["内容策划与增长", "达人营销与BD", "数据分析"],
  "industryExperience": [{"industry": "互联网电商/内容社区", "depth": "2段实习+1个项目", "evidence": "小红书/抖音平台实操"}],
  "skills": ["内容策划", "达人BD", "Excel/Python数据分析"],
  "strengths": [{"tag": "小红书内容增长", "evidence": "实习期间主推账号粉丝增长X%，爆款笔记Y篇"}],
  "achievements": ["主推账号粉丝从A增长到B（+X%）", "策划活动带来转化率提升Y%"],
  "careerGoal": "职业目标一句话",
  "targetRoles": ["内容运营", "用户增长", "市场策划"]
}`;

async function buildProfile(resume, settings) {
  const r = flattenResume(resume);
  const resumeBlock = [
    `【基本】${r.basic}`,
    `【教育】${r.edu}`,
    `【实习】\n${r.intern}`,
    `【项目】\n${r.project}`,
    `【技能】${r.skills}`,
    `【荣誉】${r.awards}`,
    `【证书】${r.certs}`,
    `【自我评价】${r.selfEval}`,
  ].join('\n');
  const settingsBlock = [
    `求职方向偏好：${settings.companyPref || '央企/国企优先，其次大厂'}`,
    `期望城市：${((settings.cities || []).join('、')) || '未设置'}`,
    `专业：${settings.major || '未设置'}`,
  ].join('\n');

  const prompt = `${PROFILE_PROMPT}\n\n【我的简历】\n${resumeBlock}\n\n【求职设置】\n${settingsBlock}`;
  const out = await llm.chat(prompt, { reasoning: 'medium' });
  const parsed = llm.extractJson(out);

  // 规范化：缺字段补默认
  const profile = {
    summary: String(parsed.summary || '').trim(),
    professionalIdentity: String(parsed.professionalIdentity || '').trim(),
    coreCompetencies: Array.isArray(parsed.coreCompetencies) ? parsed.coreCompetencies.map((x) => String(x).trim()).filter(Boolean) : [],
    industryExperience: Array.isArray(parsed.industryExperience) ? parsed.industryExperience.map((x) => ({
      industry: String((x && x.industry) || '').trim(),
      depth: String((x && x.depth) || '').trim(),
      evidence: String((x && x.evidence) || '').trim(),
    })).filter((x) => x.industry || x.evidence) : [],
    skills: Array.isArray(parsed.skills) ? parsed.skills.map((x) => String(x).trim()).filter(Boolean) : [],
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map((x) => ({
      tag: String((x && x.tag) || '').trim(),
      evidence: String((x && x.evidence) || '').trim(),
    })).filter((x) => x.tag) : [],
    achievements: Array.isArray(parsed.achievements) ? parsed.achievements.map((x) => String(x).trim()).filter(Boolean) : [],
    careerGoal: String(parsed.careerGoal || '').trim(),
    targetRoles: Array.isArray(parsed.targetRoles) ? parsed.targetRoles.map((x) => String(x).trim()).filter(Boolean) : [],
  };
  profile.generatedAt = new Date().toISOString();
  profile.resumeUpdatedAt = resume.updatedAt || null;
  return profile;
}

module.exports = { buildProfile, flattenResume };
