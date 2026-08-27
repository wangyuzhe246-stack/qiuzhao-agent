// 秋招智能投递助手 — 本地服务入口
require('dotenv').config();
const { spawn } = require('child_process');
const express = require('express');
const path = require('path');
const routes = require('./src/routes');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api', routes);

// 静态资源：根目录直接提供 agent.html / app.js / style.css
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'agent.html')));

// 启动常驻 Python PDF 服务（一次性拉起，Node 只通过 HTTP 调用它，不逐次 subprocess）
// 环境变量可覆盖：PDF_SERVICE_DISABLE=1 关闭；PYTHON=/path/to/python.exe 指定解释器
let pdfServiceProc = null;
function startPdfService() {
  if (process.env.PDF_SERVICE_DISABLE === '1') {
    console.log('  [PDF 服务] 已通过 PDF_SERVICE_DISABLE=1 关闭，生成 PDF 功能不可用。');
    return;
  }
  const py = process.env.PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
  const script = path.join(__dirname, '..', 'services', 'pdf_service.py');
  pdfServiceProc = spawn(py, ['-3', script, '--port', process.env.PDF_SERVICE_PORT || '8766'], {
    stdio: 'inherit', // 复用本窗口打印服务日志，便于排查
    cwd: path.join(__dirname, '..'),
  });
  pdfServiceProc.on('error', (err) => console.log(`  [PDF 服务] 启动失败：${err.message}`));
  pdfServiceProc.on('exit', (code) => console.log(`  [PDF 服务] 已退出（code=${code}），请查看上方日志。`));
}
// 主服务退出时一并收掉 PDF 服务，避免留下孤儿进程
process.on('exit', () => { if (pdfServiceProc && !pdfServiceProc.killed) pdfServiceProc.kill(); });

const PORT = process.env.PORT || 8787;
app.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log('──────────────────────────────────────');
  console.log('  秋招智能投递助手已启动');
  console.log(`  访问地址： ${url}`);
  console.log('  关闭本窗口即停止服务');
  console.log('──────────────────────────────────────');
  startPdfService(); // PDF 生成能力：随主服务自动拉起
  // 服务就绪后再打开默认浏览器（Windows；可用环境变量 OPEN_BROWSER=0 关闭）
  if (process.env.OPEN_BROWSER !== '0' && process.platform === 'win32') {
    openBrowser(url);
  } else {
    console.log('  请手动在浏览器打开上面的地址。');
  }
});

// Windows 下依次尝试多种方式打开默认浏览器，并打印用了哪种方式，便于排查
function openBrowser(url) {
  const { exec } = require('child_process');
  console.log('  正在打开浏览器…');
  const methods = [
    ['cmd start',    `start "" "${url}"`],
    ['PowerShell',   `powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process '${url}'"`],
    ['rundll32',     `rundll32.exe url.dll,FileProtocolHandler "${url}"`],
    ['explorer',     `explorer "${url}"`],
  ];
  let i = 0;
  const tryNext = () => {
    if (i >= methods.length) {
      console.log(`  自动打开未成功，请手动访问： ${url}`);
      return;
    }
    const [name, cmd] = methods[i++];
    exec(cmd, (err) => {
      if (err) {
        console.log(`  [${name}] 触发失败，换下一种…`);
        tryNext();
      } else {
        console.log(`  已通过 [${name}] 触发浏览器打开；若未弹出窗口，请手动访问： ${url}`);
      }
    });
  };
  tryNext();
}
