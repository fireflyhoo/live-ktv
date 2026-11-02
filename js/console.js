/* ============================================================
   console.js — 控制台
   舞台页是画面，这一页是遥控器。两者通过 Link 通道通信。
   舞台才是配置的主人：控制台启动时先问舞台要当前状态。
   ============================================================ */

(function () {
  const $ = id => document.getElementById(id);

  const cfg = { mode: 'stage', ratio: 'wide', source: 'sim', rate: 0.8, max: 30 };
  try {
    Object.assign(cfg, JSON.parse(localStorage.getItem('ddisco') || '{}'));
  } catch (e) {}

  let syncLock = 0;      // 用户正在操作时，别被回传的状态覆盖 UI
  let stageWin = null;

  // 真实舞台（独立窗口 / OBS）和预览 iframe 都会回传状态，
  // 数字分开存：有真实舞台就显示它的，否则退而显示预览的
  let realState = null, realAt = 0;
  let prevState = null, prevAt = 0;

  const link = Link.join('console', { preview: false });

  /* ---------- 接收舞台状态 ---------- */
  link.on(msg => {
    if (msg.type !== 'state') return;
    const snap = {
      live: msg.live, total: msg.total, conn: msg.conn || '—',
      mode: msg.mode, ratio: msg.ratio, source: msg.source, rate: msg.rate, max: msg.max
    };
    if (msg.preview) {
      prevState = snap; prevAt = Date.now();
      return;                              // 配置同步只听真实舞台的
    }
    realState = snap; realAt = Date.now();

    if (Date.now() < syncLock) return;     // 用户正在拖滑块，不打断
    if (snap.ratio && snap.ratio !== cfg.ratio) { cfg.ratio = snap.ratio; paintRatio(); }
    if (snap.mode && snap.mode !== cfg.mode) { cfg.mode = snap.mode; paintMode(); }
    if (snap.source && snap.source !== cfg.source) { cfg.source = snap.source; paintSource(); }
    if (snap.rate && Math.abs(snap.rate - cfg.rate) > 0.01) { cfg.rate = snap.rate; paintRate(); }
    if (snap.max && snap.max !== cfg.max) { cfg.max = snap.max; paintMax(); }
  });

  /* ---------- 下发指令 ---------- */
  function send(action, value) {
    syncLock = Date.now() + 700;
    link.post({ to: 'stage', type: 'control', action, value });
    persist();
  }

  function persist() {
    try { localStorage.setItem('ddisco', JSON.stringify(cfg)); } catch (e) {}
  }

  function sendDanmaku(m) {
    link.post({ to: 'stage', type: 'danmaku', user: m.user, text: m.text });
  }

  /* ---------- UI 绘制 ---------- */
  function paintRatio() {
    const vert = cfg.ratio === 'vertical';
    document.querySelectorAll('#seg-ratio button').forEach(b =>
      b.classList.toggle('on', b.dataset.ratio === cfg.ratio));
    const box = $('preview-box');
    // 预览框跟着换长宽比，所见即所得
    box.style.aspectRatio = vert ? '9 / 16' : '16 / 9';
    box.style.maxWidth = vert ? 'calc((100vh - 190px) * 9 / 16)' : '100%';
    $('ratio-note').textContent = vert
      ? '1080×1920 竖屏，适合手机竖直播 / 短视频竖版'
      : '1920×1080 横屏，适合 OBS 采集 / 大屏';
  }

  function paintMode() {
    document.querySelectorAll('#seg-mode button').forEach(b =>
      b.classList.toggle('on', b.dataset.mode === cfg.mode));
    const box = $('preview-box');
    if (box) box.classList.toggle('checker', cfg.mode === 'transparent');
    updateObsUrl();
  }

  function updateObsUrl() {
    const host = location.host || '127.0.0.1:8787';
    $('obs-url').textContent =
      `${location.protocol}//${host}/?mode=${cfg.mode}&ratio=${cfg.ratio}&panel=0`;
  }

  function paintSource() {
    document.querySelectorAll('#seg-source button').forEach(b =>
      b.classList.toggle('on', b.dataset.src === cfg.source));
    $('row-rate').style.opacity = cfg.source === 'sim' ? '1' : '0.4';
    $('rng-rate').disabled = cfg.source !== 'sim';
    $('src-note').textContent = cfg.source === 'sim'
      ? '本地模拟，用来看效果'
      : '等外部推弹幕进来（HTTP / WS / postMessage）';
  }

  function paintRate() {
    $('rng-rate').value = Math.round(cfg.rate * 10);
    $('val-rate').textContent = `每秒 ${cfg.rate.toFixed(1)} 条`;
  }

  function paintMax() {
    $('rng-max').value = cfg.max;
    $('val-max').textContent = cfg.max;
  }

  /* ---------- 绑定 ---------- */
  document.querySelectorAll('#seg-ratio button').forEach(b =>
    b.addEventListener('click', () => {
      cfg.ratio = b.dataset.ratio;
      paintRatio();
      updateObsUrl();
      send('ratio', cfg.ratio);
    }));

  document.querySelectorAll('#seg-mode button').forEach(b =>
    b.addEventListener('click', () => {
      cfg.mode = b.dataset.mode;
      paintMode();
      send('mode', cfg.mode);
    }));

  document.querySelectorAll('#seg-source button').forEach(b =>
    b.addEventListener('click', () => {
      cfg.source = b.dataset.src;
      paintSource();
      send('source', cfg.source);
    }));

  $('rng-rate').addEventListener('input', e => {
    cfg.rate = +e.target.value / 10;
    $('val-rate').textContent = `每秒 ${cfg.rate.toFixed(1)} 条`;
    send('rate', cfg.rate);
  });

  $('rng-max').addEventListener('input', e => {
    cfg.max = +e.target.value;
    $('val-max').textContent = cfg.max;
    send('max', cfg.max);
  });

  $('inp-manual').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const m = parseManual(e.target.value);
    if (m) { sendDanmaku(m); e.target.value = ''; }
  });

  $('btn-clear').addEventListener('click', () => send('clear'));
  $('btn-burst').addEventListener('click', () => send('burst', 24));

  $('btn-open').addEventListener('click', () => {
    if (stageWin && !stageWin.closed) { stageWin.focus(); return; }
    const host = location.host || '127.0.0.1:8787';
    const size = cfg.ratio === 'vertical' ? 'width=540,height=960' : 'width=1280,height=720';
    stageWin = window.open(`${location.protocol}//${host}/?ratio=${cfg.ratio}`, 'disco-stage', size);
  });

  $('btn-copy').addEventListener('click', async () => {
    const text = $('obs-url').textContent;
    try {
      await navigator.clipboard.writeText(text);
      const b = $('btn-copy');
      b.textContent = '已复制';
      setTimeout(() => { b.textContent = '复制'; }, 1600);
    } catch (e) {
      // 没有剪贴板权限时退回选中
      const r = document.createRange();
      r.selectNodeContents($('obs-url'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
  });

  /* ---------- 舞台在不在 + 统计刷新 ---------- */
  setInterval(() => {
    const hasReal = Date.now() - realAt < 2500;
    const hasPrev = Date.now() - prevAt < 2500;
    const s = hasReal ? realState : (hasPrev ? prevState : null);

    $('stat-live').textContent = s ? s.live : '—';
    $('stat-total').textContent = s ? s.total : '—';
    $('stat-conn').textContent = s ? s.conn : '—';

    const dot = $('live-dot');
    dot.classList.toggle('on', hasReal);
    dot.classList.toggle('warn', !hasReal);
    $('live-state').textContent = hasReal
      ? '舞台在线'
      : (hasPrev ? '舞台未打开 · 下面只是预览' : '舞台未打开');
  }, 600);

  /* ---------- 启动 ---------- */
  paintRatio();
  paintMode();
  paintSource();
  paintRate();
  paintMax();
  persist();

  // 问舞台要一次当前状态；舞台没开就等它自己上线
  setTimeout(() => link.post({ to: 'stage', type: 'ping' }), 250);
  setInterval(() => link.post({ to: 'stage', type: 'ping' }), 4000);
})();
