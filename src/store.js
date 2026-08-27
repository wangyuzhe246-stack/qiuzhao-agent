// 极简 JSON 文件存储：单用户本地数据持久化
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function fileFor(name) {
  return path.join(DATA_DIR, name + '.json');
}

// 读取；不存在或损坏时返回 fallback
function load(name, fallback) {
  ensureDir();
  try {
    const f = fileFor(name);
    if (!fs.existsSync(f)) return fallback;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

// 原子写入（先写临时文件再改名，避免写一半损坏）
function save(name, data) {
  ensureDir();
  const f = fileFor(name);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

// 简单自增/随机 id
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = { load, save, newId, DATA_DIR };
