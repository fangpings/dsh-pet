/**
 * claude-pet：用 dsh-pet 的 Electron 桌面小窗显示 Claude Code 的状态，不需要 DSH。
 *
 * 基于 dsh-pet/scripts/dev/mock-server.mjs 和 scripts/start-desktop.mjs（MIT）改写。
 * 动画素材来自 https://github.com/PC2005-cloud/dsh-pet（素材禁止商用，二创须注明出处）。
 *
 * 模拟 DSH 宿主的这几个端点：
 *   GET /dsh-pet-7340/config          dsh-pet 自带的动画配置，宠物列表换成一只只在桌面显示的
 *   GET /dsh-pet-7340/work-status     读 ~/.cache/claude-agent-status/，合并成一个状态
 *   GET /dsh-pet-7340/thumb/<id>/<name>.webm   动画素材
 * 其他端点（balance / whisper / chat / broadcast ...）一律 404，helper 会静默忽略。
 * 服务起来后自己拉起 Electron 小窗；小窗退出，服务也退出。
 *
 * 用法：node server.mjs [port]，默认 8231。平时用同目录的 claude-pet 脚本在后台跑。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || 8231);
const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PACKAGE_ROOT = resolve(here, '..', 'dsh-pet');
const WEBM_ROOT = join(PACKAGE_ROOT, 'assets', 'webm');
const CONFIG_FILE = join(PACKAGE_ROOT, 'assets', 'config.jsonc');
const STATUS_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'claude-agent-status');

const stripJsonc = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .trim();

const sendJson = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
};

function loadConfig() {
  const cfg = JSON.parse(stripJsonc(readFileSync(CONFIG_FILE, 'utf8')));
  // 不要 workStatusTexts：/work-status 的 task 也是 null，helper 就只播动画、不弹气泡。
  // 具体是哪个 Claude 在等，zellij 底栏里看
  const { workStatusTexts: _texts, ...base } = cfg.pets?.[0] ?? {};
  cfg.pets = [
    {
      ...base,
      id: 'main',
      size: Number(process.env.PET_SIZE) || 200,
      display: 'desktop',
      balanceEnabled: false,
      whisperEnabled: false,
      workStatusEnabled: true,
      position: { corner: 'bottom-right', marginX: 24, marginY: 80 },
    },
  ];
  cfg.notificationsEnabled = false;
  return cfg;
}

// ---- Claude 状态 → dsh-pet 工作状态 ----
// 状态文件格式见 dotfiles 的 zellij/scripts/agent-status.sh：第一个字段是状态，\x1f 分隔
function readStates() {
  if (!existsSync(STATUS_DIR)) return [];
  const states = [];
  for (const name of readdirSync(STATUS_DIR)) {
    if (name.startsWith('.')) continue;
    try {
      states.push(readFileSync(join(STATUS_DIR, name), 'utf8').split('\x1f')[0]);
    } catch {
      /* 文件刚好被删：跳过 */
    }
  }
  return states;
}

// 多个 Claude 合并成一个：有人等你 > 有人在跑 > 有人做完 > 空闲
const PRIORITY = [
  ['blocked', 'waiting'],
  ['working', 'working'],
  ['done', 'success'],
];

// helper 只在 ts 变化时切动画，所以只有状态变了才更新 ts
let last = { state: null, task: null, ts: 0 };
function workStatus() {
  const states = readStates();
  const state = PRIORITY.find(([ours]) => states.includes(ours))?.[1] ?? null;
  if (state !== last.state) last = { state, task: null, ts: Date.now() };
  return last;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/dsh-pet-7340/config') {
    sendJson(res, 200, { main: loadConfig() });
    return;
  }

  if (pathname === '/dsh-pet-7340/work-status') {
    sendJson(res, 200, workStatus());
    return;
  }

  if (pathname.startsWith('/dsh-pet-7340/thumb/')) {
    let rel = pathname.slice('/dsh-pet-7340/thumb/'.length);
    const slash = rel.indexOf('/');
    rel = slash >= 0 ? rel.slice(slash + 1) : rel;
    const candidate = normalize(join(WEBM_ROOT, rel));
    if (!rel || !candidate.startsWith(WEBM_ROOT + sep) || !existsSync(candidate)) {
      res.writeHead(404);
      res.end('asset not found');
      return;
    }
    res.writeHead(200, {
      'content-type': 'video/webm',
      'content-length': statSync(candidate).size,
      'cache-control': 'public, max-age=3600',
    });
    createReadStream(candidate).pipe(res);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`claude-pet: not found ${pathname}`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[claude-pet] http://127.0.0.1:${PORT}/dsh-pet-7340/config`);
  console.log(`[claude-pet] 状态目录: ${STATUS_DIR}`);
  startHelper(`http://127.0.0.1:${PORT}/dsh-pet-7340/config`);
});

// ---- 拉起 Electron 小窗（同 dsh-pet/scripts/start-desktop.mjs） ----
// DSH_PET_HOST_PID 设成本进程：helper 每 2s 检查一次，本进程退出它就自己退出
function startHelper(configUrl) {
  const electronRel =
    process.platform === 'darwin' ? join('Electron.app', 'Contents', 'MacOS', 'Electron') : 'electron';
  const electron = [
    process.env.DSH_PET_ELECTRON_PATH,
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'electron', electronRel),
  ].find((p) => p && existsSync(p));
  if (!electron) {
    console.error('[claude-pet] 找不到 Electron，先在 dsh-pet/ 里运行 npm run ensure:electron');
    process.exit(1);
  }
  const env = {
    ...process.env,
    DSH_PET_CONFIG_URL: configUrl,
    DSH_PET_SCALE: '1',
    DSH_PET_HOST_PID: String(process.pid),
  };
  // 带着 ELECTRON_RUN_AS_NODE 启动会变成纯 Node 模式；必须删键，设空串会让 Electron abort
  delete env.ELECTRON_RUN_AS_NODE;
  const helper = spawn(electron, [join(PACKAGE_ROOT, 'runtime', 'electron-helper', 'main.js')], {
    env,
    stdio: 'inherit',
  });
  // 小窗被关掉就整个退出，不留一个没有窗口的服务
  helper.on('exit', (code, signal) => {
    console.log(`[claude-pet] 小窗已退出 (code=${code}, signal=${signal})`);
    process.exit(0);
  });
  const stop = () => {
    helper.kill();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
