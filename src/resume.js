// 简历解析：PDF/DOCX/TXT 文本提取 + LLM 结构化
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const llm = require('./llm');

// ---- 文件上传（multer 内存存储）----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ---- 文本提取 ----
async function extractText(buffer, originalName) {
  const ext = (originalName || '').split('.').pop().toLowerCase();
  if (ext === 'pdf') {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    return data.text || '';
  }
  if (ext === 'docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }
  if (ext === 'txt' || ext === 'md') {
    return buffer.toString('utf8');
  }
  throw new Error('暂只支持 PDF / DOCX / TXT 文件');
}

const STRUCTURE_PROMPT = `你是校招简历解析助手。请把用户上传的简历文本解析为结构化 JSON，用于后续按岗位定制投递材料。

请严格只输出一个 JSON 对象，不要任何多余文字。结构如下：
{
  "basic": { "name": "", "gender": "", "phone": "", "email": "", "birthYear": "", "party": "中共党员/共青团员/群众/未知", "city": "现居城市", "status": "2027届应届生" },
  "education": [ { "school": "", "degree": "本科/硕士", "major": "", "period": "如 2023.09-2027.06", "gpa": "", "rank": "如 前20%（无则空）" } ],
  "internship": [ { "company": "", "role": "", "period": "", "description": "用简洁的职责/成果描述，保留数字" } ],
  "project": [ { "name": "", "role": "", "period": "", "description": "" } ],
  "skills": [ "技能字符串" ],
  "certifications": [ "证书" ],
  "awards": [ "荣誉/奖学金" ],
  "selfEval": "一段 100 字左右的自我评价（如简历没有则根据经历归纳，以应届生视角）"
}
规则：
- 缺失字段留空字符串或空数组，不要编造简历里没有的信息。
- 描述里的量化数据（如涨粉、GMV、转化率、人数）必须原样保留。
- 学历取最高学历即可，education 数组按时间倒序放主要阶段。`;

async function structureResume(rawText) {
  const prompt = `${STRUCTURE_PROMPT}\n\n【简历文本开始】\n${rawText.slice(0, 20000)}\n【简历文本结束】`;
  const out = await llm.chat(prompt, { reasoning: 'medium' });
  const parsed = llm.extractJson(out);
  parsed.rawText = rawText;
  parsed.updatedAt = new Date().toISOString();
  return parsed;
}

module.exports = { upload, extractText, structureResume };
