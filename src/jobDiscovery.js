// Job Discovery Agent（预留壳）
// 设计目标：未来让"主动发现岗位"成为独立 Agent —— 定时/持续扫描公开岗位数据，
// 面向单条 JD 页面富化，而不是仅依赖用户点击分析。下游（jdIntel 分析 / match 匹配 /
// 岗位推荐）只认统一的 job 对象，与岗位从哪来（搜索 or Agent）完全解耦。
//
// 未来 Job Discovery Agent 契约（上线时实现）：
//   const agent = {
//     name: 'job-discoverer',
//     async discover(ctx) {
//       // ctx = { settings, profile, jobs(已入库) }
//       // 返回增量岗位数组 [{ title, company, url, jdSummary, ... }]
//     },
//     onResult(job) {
//       // 逐岗回调：可在这里判重、打分、入库、触发分析
//     },
//   };
// 当前阶段：不实现主动发现调度（定时任务明确延后），仅保留接口与适配层。
const jobSearch = require('./jobSearch');

/**
 * 岗位发现统一入口（适配层）。
 * 当前实现 = 包装现有搜索式发现（jobSearch.runSearch），
 * 未来替换为 Job Discovery Agent 内部实现时，下游零改动。
 * @param {{ onProgress?: (msg:string)=>void }} ctx
 * @returns {Promise<{done:number,total:number}>}
 */
async function runDiscovery(ctx) {
  return jobSearch.runSearch(ctx && ctx.onProgress);
}

function getSources() {
  return jobSearch.getSources();
}

module.exports = { runDiscovery, getSources };
