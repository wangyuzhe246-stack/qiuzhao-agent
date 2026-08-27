// 岗位简历版本管理（Resume Asset Management）
//
// 存储：data/resume_versions.json，keyed by jobId，沿用 store.js 的 JSON 文件存储，
// 不引入数据库。数据结构：
//   {
//     "<jobId>": {
//       "jobId", "company", "position",
//       "nextVer": 1,                       // 定制版序号自增，保证删除最旧后标签不乱
//       "base":  { type:"base", version:1, label:"基础版", createdAt, resumeUpdatedAt },
//       "custom": [ { id, version, label, type:"custom", createdAt, content,
//                     optimizationReason[], jdMatchPoints[], jdKeywords[],
//                     pdfPath, pdfExists, status } ]
//     }
//   }
//
// 语义：
//   - 基础版 = data/resume.json（唯一基础资产，不复制内容，只记录更新时间）
//   - 每次「生成投递材料」追加一个新定制版快照（历史版本）
//   - 每次「生成PDF简历」回填最新定制版的 pdfPath / status（若用户手动改过定制简历，
//     用当前编辑内容刷新 content）
const store = require('./store');

// 每岗定制版上限，超出自动删最旧
const MAX_CUSTOM = 5;

function loadAll() {
  return store.load('resume_versions', {});
}

function saveAll(all) {
  store.save('resume_versions', all);
}

// 在 all 上取某岗记录，不存在则初始化（含 base 行）；调用方负责 saveAll
function _ensureRec(all, job) {
  let rec = all[job.id];
  if (!rec) {
    const resume = store.load('resume', null);
    rec = {
      jobId: job.id,
      company: job.company || '',
      position: job.title || '',
      nextVer: 1,
      base: {
        type: 'base',
        version: 1,
        label: '基础版',
        createdAt: (resume && resume.updatedAt) || new Date().toISOString(),
        resumeUpdatedAt: (resume && resume.updatedAt) || null,
      },
      custom: [],
    };
    all[job.id] = rec;
  }
  return rec;
}

// 生成投递材料后调用：追加一个定制版快照，返回最新一条
function recordTailor(job, { content, optimizationReason, jdMatchPoints, jdKeywords }) {
  const all = loadAll();
  const rec = _ensureRec(all, job);
  const n = rec.nextVer || 1;
  rec.nextVer = n + 1;
  rec.custom.push({
    id: store.newId(),
    version: 1 + n, // 基础版=1，定制版从 2 开始
    label: `定制版 v${n}`,
    type: 'custom',
    createdAt: new Date().toISOString(),
    content: content || '',
    optimizationReason: optimizationReason || [],
    jdMatchPoints: jdMatchPoints || [],
    jdKeywords: jdKeywords || [],
    pdfPath: null,
    pdfExists: false,
    status: 'no_pdf',
  });
  if (rec.custom.length > MAX_CUSTOM) {
    rec.custom.splice(0, rec.custom.length - MAX_CUSTOM);
  }
  saveAll(all);
  return rec.custom[rec.custom.length - 1];
}

// 生成 PDF 后调用：回填最新定制版的 pdfPath / status；content 传入则以当前内容为准
function backfillPdf(jobId, { pdfPath, content }) {
  const all = loadAll();
  const rec = all[jobId];
  if (!rec || !rec.custom.length) return null;
  const latest = rec.custom[rec.custom.length - 1];
  if (content) latest.content = content;
  latest.pdfPath = pdfPath || null;
  latest.pdfExists = !!latest.pdfPath;
  latest.status = latest.pdfExists ? 'generated' : 'no_pdf';
  saveAll(all);
  return latest;
}

// 读取某岗版本（只读，不存在返回 null）
function listForJob(jobId) {
  return loadAll()[jobId] || null;
}

module.exports = { MAX_CUSTOM, recordTailor, backfillPdf, listForJob };
