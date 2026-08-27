// 简历数据 → 公共 PDF 模块 resume_data 的映射层
//
// 职责：只做「数据到数据」的转换，不含任何 PDF 生成逻辑。
//   - core/pdf_generator 已内置对 data/resume.json 形态的归一化
//     （basic/education/internship/project/skills/certifications/awards/selfEval），
//     因此这里基本是透传 + 补岗位字段 + 裁剪冗余，不复制 Python 代码。
//   - 生成岗位版文件名：`岗位名称_简历.pdf`（与「简历自动生成器」命名风格一致）。
const store = require('./store');

// 岗位标题里的括号说明（如「运营类岗位（内容/用户运营）」）会拉长文件名，去掉。
// 与 resumeFile.js 里 buildDoc 的命名策略保持一致。
function cleanTitle(title) {
  return String(title || '')
    .replace(/（.*?）|\(.*?\)/g, '')
    .replace(/[\\/:*?"<>|]/g, '_') // Windows 文件名非法字符
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

// 从 data/resume.json 构造 resume_data（岗位信息来自 job，用于补 position 与命名）
function buildResumeData(job) {
  const resume = store.load('resume', null);
  if (!resume || !resume.basic) {
    throw new Error('还没有简历，请先到「我的简历」上传或填写');
  }
  // 深拷贝，避免污染 store 里缓存的对象；rawText 很大且 PDF 模板用不到，去掉
  const resumeData = JSON.parse(JSON.stringify(resume));
  delete resumeData.rawText;
  delete resumeData.updatedAt;
  if (job && job.title) resumeData.position = job.title; // 求职意向行兜底 / 模块默认命名
  return resumeData;
}

// 组装输出文件名：`岗位名称_简历.pdf`（自动清理非法字符、限长）
function buildFilename(job) {
  const title = job && job.title ? cleanTitle(job.title) : '未填写岗位';
  return `${title || '未填写岗位'}_简历.pdf`;
}

// ---------------- 定制版（tailoredResume markdown → 模板 4 版块） ----------------
// 模块 core/pdf_generator 支持 resume_data = {name, sections:{个人优势,工作经历,项目经历,教育经历}}
// （sections 显式覆盖）。这里把 LLM 生成的 Markdown 定制简历拆到模板 4 版块，复用模板版式。

// markdown 版块标题 → 模板版块（按包含关系匹配，顺序即优先级）
const SECTION_MAP = [
  ['教育', '教育经历'],
  ['实习', '工作经历'],
  ['工作', '工作经历'],
  ['项目', '项目经历'],
  ['技能', '个人优势'],
  ['证书', '个人优势'],
  ['荣誉', '个人优势'],
  ['自我', '个人优势'],
  ['简介', '个人优势'],
];

// 行内标签 → 模板版块：定制内容可能用三种形态表示版块标签：
//   「教育背景：」带冒号  /  「**教育背景**」加粗包裹  /  「### 教育背景」H3 标题
// 匹配前会剥掉整行 ** 包裹与 # 前缀，冒号可选。
// 命中即切换当前版块；与 ## 标题一样可把内容拆到对应版块，让定制版右栏
// 版块结构与基础简历保持一致。
// 数组第三项 keep=true 时，标签行本身仍输出进该版块（不消费）：
// 技能证书/技能 需要保留标记行，由模板脚本识别后把内容搬进左栏「技能清单」。
const LABEL_TO_SECTION = [
  [/^(教育背景|教育经历)[:：]?\s*$/, '教育经历'],
  [/^(实习经历|工作经历|工作内容)[:：]?\s*$/, '工作经历'],
  [/^(项目经历|实践经历)[:：]?\s*$/, '项目经历'],
  [/^(个人简介|自我介绍|自我评价|个人优势|荣誉奖项|荣誉|获奖|奖项)[:：]?\s*$/, '个人优势'],
  [/^(技能证书|技能)[:：]?\s*$/, '个人优势', true],
];

function sectionKey(text) {
  const hit = SECTION_MAP.find(([kw]) => String(text).includes(kw));
  return hit ? hit[1] : null;
}

// 把 tailoredResume（Markdown）映射为模板 4 版块文本。
// 规则：
//   - `## 版块标题` → 切换当前版块；`# 姓名行` 跳过
//   - `### 机构 ｜ 角色 ｜ 日期` → 保留为条目行（模块原生识别 | ｜ 与末段日期）
//   - 整行包裹 **...** 时剥掉（否则模板会显示字面 ** ）
//   - 其他行原样进当前版块
// 把「机构｜职位（日期）」形态统一成模板可识别的三段式条目行
// 「机构 ｜ 职位 ｜ 日期」，让各岗位定制版与基础简历的条目排版一致。
function normalizeEntryLine(line) {
  const m = line.match(/^(.*?)[|｜]\s*(.*?)[（(](\d{4}[^）)]*)[）)]\s*$/);
  if (!m) return line;
  return `${m[1].trim()} ｜ ${m[2].trim()} ｜ ${m[3].trim()}`;
}

function sectionsFromTailoredResume(md) {
  const sections = { 个人优势: '', 工作经历: '', 项目经历: '', 教育经历: '' };
  let cur = '个人优势';
  const push = (line) => {
    const l = line.includes('|') || line.includes('｜') ? normalizeEntryLine(line) : line;
    sections[cur] = (sections[cur] ? sections[cur] + '\n' : '') + l;
  };
  for (const line of String(md || '').replace(/\r/g, '').split('\n')) {
    const trimmed = line.trim();
    // 联系方式头行（如「**王宇哲** ｜ 手机 ｜ 邮箱 ｜ 政治面貌」）：基础简历合并后
    // 左栏基本信息已展示，这里丢弃，避免与左栏重复。
    if ((trimmed.includes('|') || trimmed.includes('｜')) && trimmed.includes('@')) continue;
    // 标签行可能带冒号 / 整行 **加粗** / 前导 #（如「教育背景：」「**教育背景**」
    // 「### 教育背景」），统一剥掉 ** 与 # 后匹配 → 切换版块；keep=true 仍输出
    const labelText = trimmed.replace(/^\*\*(.+)\*\*$/, '$1').replace(/^#{1,3}\s*/, '').trim();
    const labelHit = LABEL_TO_SECTION.find(([re]) => re.test(labelText));
    if (labelHit) {
      cur = labelHit[1];
      if (labelHit[2]) push(labelText);
      continue;
    }
    const h = line.match(/^(#{1,3})\s*(.*)/);
    if (!h) {
      if (trimmed) push(line);
      continue;
    }
    const [, hashes, text] = h;
    if (hashes.length === 1) continue; // `# 王宇哲`
    if (hashes.length === 2) {
      const key = sectionKey(text);
      if (key) cur = key;
      continue; // 版块标题本身不输出
    }
    // ### 条目行：剥掉整行 **...** 包裹，保留 | ｜ 分隔（模块会自动渲染）
    const bare = text.trim().replace(/^\*\*(.+)\*\*$/, '$1');
    push(bare);
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].trim();
  return sections;
}

// 由某岗投递材料构造定制版 resume_data。
// 返回「完整基础简历 + 定制版 4 版块」：让定制版也带上联系方式/基本信息，
// 左栏基本信息与基础简历保持一致；版块内容由定制 Markdown 拆分而来并显式覆盖。
function buildTailoredResumeData(materials, job) {
  const resume = store.load('resume', null);
  // 深拷贝，避免污染 store 里缓存的对象；rawText 很大且 PDF 模板用不到，去掉
  const resumeData = resume ? JSON.parse(JSON.stringify(resume)) : {};
  if (resumeData.basic) {
    delete resumeData.rawText;
    delete resumeData.updatedAt;
  }
  const position = (job && job.title) || '';
  // 求职意向横幅以定制版岗位为准（否则 basic.status 会把横幅写成基础简历的岗位）
  if (resumeData.basic) resumeData.basic.status = position ? `求职意向：${position}` : '';
  resumeData.name = (resumeData.basic && resumeData.basic.name) || '';
  resumeData.position = position;
  resumeData.sections = sectionsFromTailoredResume((materials && materials.tailoredResume) || '');
  return resumeData;
}

module.exports = { buildResumeData, buildFilename, cleanTitle, sectionsFromTailoredResume, buildTailoredResumeData };
