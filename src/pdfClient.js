// Python PDF 服务（core/pdf_generator）的 HTTP 客户端
//
// 职责边界：Node 端不碰 Python 代码、不 subprocess 调脚本，只通过 HTTP 调用
// 常驻的 services/pdf_service.py。这里封装「服务就绪探测 + 生成 PDF 的请求」。
// 服务由 server.js 启动时自动拉起（child_process.spawn 一次性常驻），
// 因此首次请求可能撞上服务刚起、端口未监听，waitReady() 负责短时重试。

const BASE = process.env.PDF_SERVICE_URL || 'http://127.0.0.1:8766';
const REQUEST_TIMEOUT_MS = 180000; // Edge 无头打印可能较慢，放宽超时

// 等 Python 服务就绪（启动瞬间 Node 就收到请求时能自动重试，避免用户看到失败）
async function waitReady(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch (_) {
      // 服务还没起来，稍后重试
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

// 生成 PDF：POST /api/pdf/path → {ok, name, path}（已写入 output/）
async function generatePdfPath(resumeData, filename) {
  if (!(await waitReady())) {
    throw new Error('PDF 服务未就绪，请确认 services/pdf_service.py 已启动');
  }
  const r = await fetch(`${BASE}/api/pdf/path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resume_data: resumeData, filename }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    throw new Error(data.error || `PDF 生成失败（服务返回 ${r.status}）`);
  }
  return data; // { ok, name, path }
}

module.exports = { BASE, waitReady, generatePdfPath };
