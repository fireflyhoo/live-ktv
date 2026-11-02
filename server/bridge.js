#!/usr/bin/env node
/* ============================================================
   bridge.js — 弹幕中转服务（零依赖，只用 Node 内置模块）
     · 静态托管舞台页面       http://127.0.0.1:8787/
     · HTTP 收单条弹幕        POST http://127.0.0.1:8787/danmaku
     · 视频号直播整包推送     POST http://127.0.0.1:8787/video-channel-live
     · WebSocket 广播弹幕     ws://127.0.0.1:8787
   所有 POST 接口都支持跨域（含预检与自定义请求头）。
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const ROOT = path.resolve(__dirname, '..');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

/* ---------- 极简 WebSocket ---------- */

const clients = new Set();

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81;   // FIN + text
  return Buffer.concat([header, payload]);
}

/** 从累积 buffer 里切出一个个完整帧，返回 [帧数组, 剩余] */
function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off], b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p)); p += 8;
    }
    let mask = null;
    if (masked) {
      if (buf.length - p < 4) break;
      mask = buf.slice(p, p + 4); p += 4;
    }
    if (buf.length - p < len) break;
    let payload = buf.slice(p, p + len);
    if (mask) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    p += len;
    frames.push({ opcode, payload });
    off = p;
  }
  return [frames, buf.slice(off)];
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );
  socket.setNoDelay(true);
  clients.add(socket);
  log(`WS 客户端接入（当前 ${clients.size} 个）`);

  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    let frames;
    [frames, buf] = decodeFrames(buf);
    for (const f of frames) {
      if (f.opcode === 0x8) {           // close
        clients.delete(socket);
        socket.end();
        return;
      }
      if (f.opcode === 0x9) {           // ping -> pong
        socket.write(Buffer.from([0x8a, 0]));
        continue;
      }
      if (f.opcode === 0x1) {           // text
        const raw = f.payload.toString('utf8');
        try {
          const data = JSON.parse(raw);
          const list = Array.isArray(data) ? data : [data];
          list.forEach(m => broadcast(m));
        } catch (e) {
          broadcast({ user: '弹幕', text: raw.slice(0, 60) });
        }
      }
    }
  });
  socket.on('close', () => {
    clients.delete(socket);
    log(`WS 客户端断开（当前 ${clients.size} 个）`);
  });
  socket.on('error', () => clients.delete(socket));
}

function broadcast(msg) {
  const frame = encodeFrame(JSON.stringify(msg));
  for (const c of clients) {
    try { c.write(frame); } catch (e) { clients.delete(c); }
  }
  // 控制台和舞台之间还会互发 control / state / ping，那些不用打日志
  const t = msg && msg.type;
  if (t === 'control' || t === 'state' || t === 'ping') return;
  // 整包推送已经在 logPush() 里逐条打印过了，这里不再重复刷屏
  if (msg && msg.source === 'video_channel_live') return;
  const who = msg && msg.user ? msg.user : '?';
  log(`弹幕 ${who}：${String((msg && msg.text) || '').slice(0, 30)}`);
}

/* ---------- 视频号直播整包数据适配 ---------- */

/* 抓取脚本往往是「定时推送当前快照」，同一条评论会被反复推过来。
   两级去重：
     · 长窗口：username + content + capturedAt（10 分钟）—— 快照里的老评论不再上台
     · 短窗口：username + content（20 秒）—— 兜底，防止脚本每次重写 capturedAt
*/
const seenLong = new Map();
const seenShort = new Map();
const LONG_TTL = 10 * 60 * 1000;
const SHORT_TTL = 20 * 1000;
const SEEN_MAX = 4000;
let lastSweep = 0;

/* 观众榜是「在座名单」，每次快照都会重复带上来。
   这里不做「推过就不再推」，而是每隔 VIEWER_GAP 给同一位观众续命一次 ——
   舞台上人一直站着，又不会每秒刷一遍。                                     */
const viewerLast = new Map();
const VIEWER_GAP = 12 * 1000;

function sweepSeen(now) {
  if (now - lastSweep < 30000) return;
  lastSweep = now;
  for (const [k, t] of seenLong) if (now - t > LONG_TTL) seenLong.delete(k);
  for (const [k, t] of seenShort) if (now - t > SHORT_TTL) seenShort.delete(k);
  for (const [k, t] of viewerLast) if (now - t > 60000) viewerLast.delete(k);
  if (seenLong.size > SEEN_MAX) {
    const extra = seenLong.size - SEEN_MAX;
    let n = 0;
    for (const k of seenLong.keys()) { seenLong.delete(k); if (++n >= extra) break; }
  }
}

function isDuplicate(name, text, at) {
  const now = Date.now();
  sweepSeen(now);
  const longKey = name + '\u0001' + text + '\u0001' + at;
  const shortKey = name + '\u0001' + text;
  if (seenLong.has(longKey) || seenShort.has(shortKey)) return true;
  seenLong.set(longKey, now);
  seenShort.set(shortKey, now);
  return false;
}

function commentToDanmaku(c) {
  const user = String(c.username || c.name || c.nickname || c.user || '匿名观众').trim().slice(0, 24);
  const text = String(c.content || c.text || c.desc || '').trim().slice(0, 60);
  return {
    user,
    text,
    emote: c.emote || '',
    platform: 'wx',
    // 主播自己的发言给个 VIP 名牌，方便在人群里认出来
    isVip: c.type === '主播' || !!c.isVip,
    source: 'video_channel_live'
  };
}

/* ---------- 终端打印：把一次推送原样读给开发者看 ---------- */

const C = {
  dim:     s => `\x1b[2m${s}\x1b[0m`,
  gray:    s => `\x1b[90m${s}\x1b[0m`,
  cyan:    s => `\x1b[36m${s}\x1b[0m`,
  green:   s => `\x1b[32m${s}\x1b[0m`,
  yellow:  s => `\x1b[33m${s}\x1b[0m`,
  magenta: s => `\x1b[35m${s}\x1b[0m`,
  red:     s => `\x1b[31m${s}\x1b[0m`,
  bold:    s => `\x1b[1m${s}\x1b[0m`
};

const LINE_W = 62;

/** 终端显示宽度：中文 / emoji 占两列，避免表格错位 */
function dispWidth(s) {
  let n = 0;
  for (const ch of String(s)) n += /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 2 : 1;
  return n;
}

function fit(s, cols) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ');
  let out = '', w = 0;
  for (const ch of s) {
    const cw = dispWidth(ch);
    if (w + cw > cols) return out + '…';
    out += ch; w += cw;
  }
  return out + ' '.repeat(Math.max(0, cols - w));
}

function hhmmss(ts) {
  if (ts === undefined || ts === null || ts === '') return '';
  const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
  if (isNaN(d.getTime())) return String(ts).slice(0, 10);
  return d.toTimeString().slice(0, 8);
}

/**
 * 打印一次 video-channel-live 推送的完整内容。
 * entries 每条是 {name, text, type, at, fate}，fate: 'on' | 'dup' | 'batch'
 */
function logPush(data, entries, stat, origin) {
  const got = C.magenta('◀');
  console.log('');
  console.log(
    `${got} ${C.bold('video_channel_live')} ${C.gray('推送')}` +
    C.gray(`  ${hhmmss(Date.now())}  from ${origin || '?'}`)
  );

  const meta = [];
  if (data.type) meta.push(`type=${data.type}`);
  if (data.capturedAt) meta.push(`capturedAt=${data.capturedAt}`);
  if (meta.length) console.log(`  ${C.gray(meta.join('  '))}`);
  console.log(
    `  ${C.cyan('评论')} ${String(stat.comments).padStart(2)} 条   ` +
    `${C.cyan('观众')} ${String(stat.viewers).padStart(2)} 位   ` +
    `${C.cyan('原始 JSON')} ${stat.bytes} B`
  );

  if (!entries.length) {
    console.log(`  ${C.gray('（comments 是空的，没有可上台的人）')}`);
  }

  const NAME_W = 14, TEXT_W = 30;
  for (const e of entries) {
    const tag = e.type === '主播' ? C.yellow('主播') : C.gray('观众');
    const name = e.name ? C.bold(fit(e.name, NAME_W)) : C.bold(fit('匿名观众', NAME_W));
    const text = e.text ? fit(e.text, TEXT_W) : C.dim(fit('（空内容）', TEXT_W));
    let mark;
    if (e.fate === 'on') mark = C.green('✓ 上台');
    else if (e.fate === 'batch') mark = C.yellow('· 同批重名');
    else if (e.fate === 'dup') mark = C.gray('· 已推过');
    else mark = C.red('× 字段异常');
    console.log(`  ${tag} ${name}${C.gray(hhmmss(e.at).padEnd(8))} ${text} ${mark}`);
  }

  if (stat.viewers) {
    const on = new Set(stat.viewerNames || []);
    const vs = (data.viewers || [])
      .slice(0, 6)
      .map(v => {
        const n = v.name || v.username || '?';
        const val = v.value && String(v.value) !== '0' ? '(' + v.value + ')' : '';
        return `#${v.rank || '-'} ${n}${val}` + (on.has(String(n).trim()) ? C.green('+') : '');
      })
      .join('  ');
    console.log(
      `  ${C.gray('观众榜')} ${C.gray(vs)}` +
      (data.viewers.length > 6 ? C.gray(` …共 ${data.viewers.length} 位`) : '') +
      C.gray(on.size ? '   （+ 表示已上台 / 续命）' : '')
    );
  }

  const tail = [`上台 ${C.green(String(stat.accepted))}`];
  if (stat.viewerOn) tail.push(`其中观众榜 ${C.cyan(String(stat.viewerOn))}`);
  tail.push(`跳过 ${C.gray(String(stat.duplicates))}`);
  if (stat.skippedEmpty) tail.push(`空内容 ${C.gray(String(stat.skippedEmpty))}`);
  console.log(`  ${C.gray('→')} ${tail.join('   ')}`);
  console.log('');
}

/** 把一整包 {type:'video_channel_live', comments, viewers} 拆成弹幕广播出去 */
function ingestVideoChannel(data, includeViewers, origin, bytes, maxViewers) {
  const comments = Array.isArray(data.comments) ? data.comments : [];
  const viewers = Array.isArray(data.viewers) ? data.viewers : [];
  let accepted = 0, duplicates = 0, skippedEmpty = 0;
  const entries = [];

  // 先记下每个昵称最后一次出现在哪 —— 同批只留最新那条，其余标记为重名
  const lastIdx = new Map();
  comments.forEach((c, i) => {
    if (!c || typeof c !== 'object') return;
    lastIdx.set(String(c.username || c.name || c.nickname || c.user || '匿名观众').trim(), i);
  });

  comments.forEach((c, i) => {
    if (!c || typeof c !== 'object') {
      entries.push({ name: '', text: '', fate: 'bad' });
      return;
    }
    const name = String(c.username || c.name || c.nickname || c.user || '匿名观众').trim();
    const text = String(c.content || c.text || c.desc || '').trim();
    const at = c.capturedAt || c.timestamp || c.ts || '';
    const row = { name, text, type: c.type, at };

    if (lastIdx.get(name) !== i) {           // 同一批里更早的同名发言
      duplicates++;
      entries.push({ ...row, fate: 'batch' });
      return;
    }

    const m = commentToDanmaku(c);
    if (!m.text) { skippedEmpty++; }         // 空内容也让人上台，只是不占名额的判断
    if (isDuplicate(m.user, m.text, at)) {
      duplicates++;
      entries.push({ ...row, fate: 'dup' });
      return;
    }
    broadcast(m);
    accepted++;
    entries.push({ ...row, fate: 'on' });
  });

  /* 观众榜也上台：他们本来就在直播间里坐着。
     但不是「来一条新弹幕」，而是给已经在台上的同名小人续命：
       · 按 rank 取前 maxViewers 位（默认 30，0 = 不限）
       · 同一位观众 VIEWER_GAP 内只推一次，避免每个快照都刷屏
       · quiet=true：舞台只让他站着 / 续命，不弹评论气泡、不进底部飘屏 */
  let viewerOn = 0;
  const viewerNames = [];
  if (includeViewers && viewers.length) {
    const batchNames = new Set(entries.map(e => e.name));
    const now = Date.now();
    sweepSeen(now);
    const ranked = viewers
      .filter(v => v && typeof v === 'object')
      .sort((a, b) => (+a.rank || 9999) - (+b.rank || 9999));
    const pool = maxViewers > 0 ? ranked.slice(0, maxViewers) : ranked;

    for (const v of pool) {
      const name = String(v.name || v.username || '').trim().slice(0, 24);
      if (!name || batchNames.has(name)) continue;   // 这一批已经说过话的人不重复上台
      if (now - (viewerLast.get(name) || 0) < VIEWER_GAP) continue;
      viewerLast.set(name, now);
      broadcast({
        user: name,
        text: '',                                   // 观众没有发言，别弹气泡
        platform: 'wx',
        isVip: !!v.rank && +v.rank <= 3,            // 榜单前三给 VIP 名牌
        role: 'viewer',
        quiet: true,
        source: 'video_channel_live'
      });
      accepted++;
      viewerOn++;
      viewerNames.push(name);
    }
  }

  logPush(data, entries, {
    comments: comments.length,
    viewers: viewers.length,
    accepted,
    viewerOn,
    viewerNames,
    duplicates,
    skippedEmpty,
    bytes: bytes === undefined ? '-' : bytes
  }, origin);

  return {
    ok: true,
    accepted,
    duplicates,
    comments: comments.length,
    viewers: viewers.length,
    viewersOnStage: viewerOn,
    onStageHint: '同名人物在舞台上只会存在一个；人数过多时会随机退场'
  };
}

/* ---------- HTTP ---------- */

function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] || 'Content-Type, *');
  res.setHeader('Access-Control-Max-Age', '86400');
  // 从公网页面推到本地服务时，Chrome 的私有网络访问会额外发这个预检头
  if (req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, res, cb) {
  let body = '';
  let tooLarge = false;
  req.setEncoding('utf8');
  req.on('data', c => {
    if (tooLarge) return;
    body += c;
    if (body.length > 2e6) {
      tooLarge = true;
      json(res, 413, { ok: false, error: 'payload too large (max 2MB)' });
    }
  });
  req.on('end', () => { if (!tooLarge) cb(body); });
}

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const VIDEO_PATHS = new Set(['/video-channel-live', '/api/video-channel-live']);

/** 请求来源，日志里用来区分是脚本推的还是手 curl 的 */
function originOf(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (fwd ? String(fwd).split(',')[0] : req.socket.remoteAddress || '?')
    .replace(/^::ffff:/, '');
  return /^(127\.0\.0\.1|::1|localhost)$/.test(ip) ? '本机' : ip;
}

const server = http.createServer((req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  const urlPath = (req.url || '').split('?')[0];
  const query = new URLSearchParams((req.url || '').split('?')[1] || '');

  // 观众榜默认上台（?includeViewers=0 关掉），默认最多取榜单前 20 位
  const includeViewers = query.get('includeViewers') !== '0';
  const maxViewers = query.has('maxViewers') ? Math.max(0, +query.get('maxViewers') || 0) : 20;

  if (req.method === 'POST' && VIDEO_PATHS.has(urlPath)) {
    readBody(req, res, body => {
      let data;
      try { data = JSON.parse(body || '{}'); }
      catch (e) {
        console.log(`  ${C.red('×')} 推送的 JSON 解析失败（${Buffer.byteLength(body)} B）：${C.gray(fit(body, 120))}`);
        json(res, 400, { ok: false, error: 'invalid json' });
        return;
      }
      if (!Array.isArray(data.comments)) {
        console.log(`  ${C.red('×')} 推送缺少 comments 数组：${C.gray(fit(body, 120))}`);
        json(res, 400, { ok: false, error: 'missing comments array' });
        return;
      }
      json(res, 200, ingestVideoChannel(
        data, includeViewers, originOf(req), Buffer.byteLength(body), maxViewers
      ));
    });
    return;
  }

  if (req.method === 'POST' && (urlPath === '/danmaku' || urlPath === '/api/danmaku')) {
    readBody(req, res, body => {
      let data;
      try { data = JSON.parse(body || '{}'); }
      catch (e) { json(res, 400, { ok: false, error: 'invalid json' }); return; }
      // 顺手兼容：整包结构推到旧地址也能用
      if (!Array.isArray(data) && Array.isArray(data.comments)) {
        json(res, 200, ingestVideoChannel(
          data, includeViewers, originOf(req), Buffer.byteLength(body), maxViewers
        ));
        return;
      }
      const list = Array.isArray(data) ? data : [data];
      list.forEach(m => broadcast(m));
      json(res, 200, { ok: true, count: list.length });
    });
    return;
  }

  if (req.method === 'GET' && urlPath === '/health') {
    json(res, 200, { ok: true, clients: clients.size, seen: seenLong.size });
    return;
  }

  serveStatic(req, res, req.url);
});

server.on('upgrade', (req, socket) => handleUpgrade(req, socket));

function log(s) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`\x1b[35m[${t}]\x1b[0m ${s}`);
}

server.listen(PORT, () => {
  console.log('');
  console.log('  \x1b[36m弹幕蹦迪舞台 · 中转服务已启动\x1b[0m');
  console.log('');
  console.log(`  舞台画面    \x1b[33mhttp://127.0.0.1:${PORT}/\x1b[0m        ← 这一页给 OBS 采集，没有任何 UI`);
  console.log(`  控制台      \x1b[33mhttp://127.0.0.1:${PORT}/console.html\x1b[0m ← 这一页是你操作的地方`);
  console.log(`  单条弹幕    POST http://127.0.0.1:${PORT}/danmaku`);
  console.log(`  视频号整包  \x1b[33mPOST http://127.0.0.1:${PORT}/video-channel-live\x1b[0m  (支持跨域)`);
  console.log(`  WebSocket   ws://127.0.0.1:${PORT}`);
  console.log('');
  console.log('  \x1b[2m推送过来的每条评论都会在下面逐条打印（昵称 / 内容 / 上台还是去重）\x1b[0m');
  console.log('  \x1b[2m舞台不足 10 人时不会自然退场，够人之后才陆续离开\x1b[0m');
  console.log('');
  console.log('  Ctrl+C 停止');
  console.log('');
});
