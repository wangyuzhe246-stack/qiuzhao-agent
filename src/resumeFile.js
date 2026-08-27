// 每岗定制简历导出（Word 兼容 .doc）
// 用 Office/WPS 原生支持的「HTML 格式 .doc」实现，零第三方依赖。
// Word 识别 UTF-8 BOM 按正确编码打开，避免中文乱码。

/**
 * 轻量 Markdown → HTML 转换（只覆盖定制简历里会出现的语法）
 *  - # / ## / ### 标题
 *  - **加粗**
 *  - - 无序列表
 *  - 普通段落（| / ｜ 分隔符按纯文本保留）
 */
function markdownToHtml(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let inUl = false;
  let inP = false;

  const closeUl = () => { if (inUl) { html.push('</ul>'); inUl = false; } };
  const closeP = () => { if (inP) { html.push('</p>'); inP = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const escLine = escapeHtml(line);
    const boldLine = escLine.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      closeUl(); closeP();
      const level = h[1].length;
      html.push(`<h${level}>${boldLine.replace(/^#{1,6}\s*/, '')}</h${level}>`);
      continue;
    }
    // 无序列表
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (li) {
      closeP();
      if (!inUl) { html.push('<ul>'); inUl = true; }
      html.push(`<li>${boldLine.replace(/^\s*[-*]\s+/, '')}</li>`);
      continue;
    }
    // 空行
    if (!line.trim()) { closeUl(); closeP(); continue; }
    // 普通段落
    closeUl();
    if (!inP) { html.push('<p>'); inP = true; }
    html.push(boldLine);
  }
  closeUl(); closeP();
  return html.join('\n');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 文件名清理：去掉 Windows 非法字符 */
function safeFilename(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * 构建该岗位定制简历的 .doc 文件
 * @returns {{ buffer: Buffer, filename: string }}
 */
function buildDoc(job, materials) {
  const company = safeFilename(job.company || '公司');
  const title = safeFilename((job.title || '岗位').replace(/（.*?）|\(.*?\)/g, '')) || '岗位';
  const filename = `${company}-${title}-定制简历.doc`;

  const genAt = (materials && materials.generatedAt ? new Date(materials.generatedAt) : new Date());
  const genStr = `${genAt.getFullYear()}-${String(genAt.getMonth() + 1).padStart(2, '0')}-${String(genAt.getDate()).padStart(2, '0')}`;

  const head = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${escapeHtml((job.company || '') + ' - 定制简历')}</title>
<style>
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; font-size: 10.5pt; line-height: 1.6; color: #1d2733; }
  h1 { font-size: 18pt; color: #17365d; border-bottom: 2px solid #c9a227; padding-bottom: 6px; }
  h2 { font-size: 13pt; color: #1f4a80; margin-top: 14px; border-left: 4px solid #c9a227; padding-left: 8px; }
  h3 { font-size: 11.5pt; color: #1f4a80; margin: 10px 0 4px; }
  ul { margin: 4px 0 8px; padding-left: 20px; }
  li { margin-bottom: 3px; }
  p { margin: 6px 0; }
  .meta { font-size: 9.5pt; color: #7a8698; border-top: 1px solid #e3e8ef; margin-top: 18px; padding-top: 8px; }
</style>
</head>
<body>`;

  const meta = `<p class="meta">岗位：${escapeHtml(job.title || '')} ｜ 平台：${escapeHtml((materials && materials.guide && materials.guide.platform) || '')} ｜ 由「秋招智能投递助手」按 JD 定制生成于 ${genStr}</p>`;

  const tail = `</body>
</html>`;

  const body = markdownToHtml((materials && materials.tailoredResume) || '');
  const html = head + body + meta + tail;

  // UTF-8 BOM + HTML：Word/WPS 双击直接打开，中文不乱码
  const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(html, 'utf8')]);
  return { buffer, filename };
}

module.exports = { markdownToHtml, buildDoc };
