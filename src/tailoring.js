// 投递材料定制：按岗位 JD 生成定制简历 / 自我评价 / 网申答案 / 自我介绍 / 投递指引
const llm = require('./llm');

function promptForJob(resume, job) {
  const basic = resume.basic || {};
  const edu = (resume.education || []).map((e) => `${e.school} ${e.degree} ${e.major} ${e.period}${e.gpa ? ' GPA:' + e.gpa : ''}`).join('；');
  const intern = (resume.internship || []).map((i) => `${i.company}｜${i.role}｜${i.period}\n${i.description}`).join('\n');
  const project = (resume.project || []).map((p) => `${p.name}｜${p.role}｜${p.period}\n${p.description}`).join('\n');
  return {
    basic,
    edu,
    intern,
    project,
    skills: (resume.skills || []).join('、'),
    awards: (resume.awards || []).join('、'),
    certs: (resume.certifications || []).join('、'),
    selfEval: resume.selfEval || '',
  };
}

const MATERIALS_PROMPT = `你是校招网申材料定制专家。根据【我的简历】和【目标岗位JD】，为这位求职者生成一份精准的网申材料包，用于投递该岗位。

要求：
- 突出简历中与 JD 最匹配的经历和能力，按 JD 关键词重新组织语言；不要编造简历里没有的事实，但允许对真实经历做"营销化"表述。
- 应届生视角，避免空话套话，尽量具体、有数据感（数据只能来自简历原文）。
- tailoredResume 里实习/项目/教育的条目标题统一用「**机构 ｜ 角色 ｜ 日期**」格式（如：**杭州门之外文化创意有限公司 ｜ 电商运营实习生 ｜ 2026.07-至今**），用于 PDF 排版。
- optimizationReason 逐条给出"这次为什么这样改"：original 必须真实引用简历原文/概述，optimized 为针对 JD 强化后的表述，reason 点明对应 JD 的哪条要求（约3条）。
- jdMatchPoints 列出 JD 核心要求与简历中支撑它的真实经历（约3条）。
- 所有文本用中文。

严格只输出一个 JSON 对象，不要任何多余文字：
{
  "tailoredResume": "Markdown 格式的定制简历正文：个人简介(2-3行) + 教育背景 + 实习经历 + 项目经历 + 技能证书 + 荣誉，经历描述已针对JD强化",
  "selfEval": "网申自我评价，120字左右",
  "answers": {
    "为什么选择我们公司/这个岗位": "150字左右",
    "你的核心优势是什么": "150字左右",
    "你的职业规划": "120字左右"
  },
  "selfIntro": "1分钟自我介绍（用于面试或网申，120字左右）",
  "optimizationReason": [
    { "original": "简历里的原文/概述", "optimized": "改写后的表述", "reason": "为什么这样改，对应JD哪条要求" }
  ],
  "jdMatchPoints": [
    { "requirement": "JD要求的能力", "evidence": "简历里支撑这条要求的真实经历" }
  ],
  "guide": {
    "platform": "应在哪个平台投递（如国聘网/公司官网，参考岗位信息）",
    "url": "投递入口链接",
    "steps": ["填写清单，如：注册实名→上传学信网学籍报告→填写个人基本信息…"],
    "notes": ["注意事项，如截止时间、需要准备的材料、笔试题型等"]
  }
}`;

async function generateMaterials(job, resume) {
  const r = promptForJob(resume, job);
  const resumeBlock = [
    `【基本】姓名${r.basic.name || '（未填）'} | ${r.basic.phone || ''} | ${r.basic.email || ''} | ${r.basic.birthYear || ''}年 | ${r.basic.party || ''}`,
    `【教育】${r.edu || '（未填）'}`,
    r.intern ? `【实习】\n${r.intern}` : '',
    r.project ? `【项目】\n${r.project}` : '',
    `【技能】${r.skills || '（未填）'}`,
    `【证书】${r.certs || '（未填）'}`,
    `【荣誉】${r.awards || '（未填）'}`,
    `【自我评价】${r.selfEval || '（未填）'}`,
  ].filter(Boolean).join('\n');

  const prompt = `${MATERIALS_PROMPT}\n\n【我的简历】\n${resumeBlock}\n\n【目标岗位】\n岗位：${job.title}\n单位：${job.company}\n地点：${job.location}\nJD摘要：${job.jdSummary}\n要求：${job.requirement}\n平台：${job.platform}\n链接：${job.url}`;

  const out = await llm.chat(prompt, { reasoning: 'medium' });
  const parsed = llm.extractJson(out);

  // 规范化：缺字段补默认
  parsed.tailoredResume = parsed.tailoredResume || '';
  parsed.selfEval = parsed.selfEval || '';
  parsed.answers = parsed.answers || {};
  parsed.selfIntro = parsed.selfIntro || '';
  parsed.guide = parsed.guide || { platform: '', url: job.url || '', steps: [], notes: [] };
  parsed.optimizationReason = Array.isArray(parsed.optimizationReason)
    ? parsed.optimizationReason.filter((r) => r && r.original && r.optimized && r.reason)
    : [];
  parsed.jdMatchPoints = Array.isArray(parsed.jdMatchPoints)
    ? parsed.jdMatchPoints.filter((p) => p && p.requirement && p.evidence)
    : [];
  parsed.generatedAt = new Date().toISOString();
  return parsed;
}

// 导出为 Markdown 文本，方便用户复制
function materialsToMarkdown(job, materials) {
  const g = materials.guide || {};
  const answers = materials.answers || {};
  return [
    `# 投递材料包：${job.company} · ${job.title}`,
    ``,
    `> 地点：${job.location}｜平台：${job.platform}｜链接：${materials.url || job.url || ''}`,
    ``,
    `## 一、定制简历`,
    materials.tailoredResume,
    ``,
    `## 二、自我评价`,
    materials.selfEval,
    ``,
    `## 三、网申常见问题`,
    ...Object.entries(answers).map(([q, a]) => `**${q}**\n${a}`),
    ``,
    `## 四、自我介绍`,
    materials.selfIntro,
    ``,
    `## 五、投递指引`,
    `**平台**：${g.platform || ''}`,
    `**入口**：${g.url || job.url || ''}`,
    `**步骤**：`,
    ...(g.steps || []).map((s) => `- ${s}`),
    `**注意**：`,
    ...(g.notes || []).map((s) => `- ${s}`),
  ].join('\n');
}

module.exports = { generateMaterials, materialsToMarkdown };
