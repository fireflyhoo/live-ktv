/* ============================================================
   app.js — 舞台页主控
   这一页只负责画面：缩放布局 / 主循环 / 弹幕转小人
   所有设置由控制台页（console.html）通过 Link 通道推过来
   ============================================================ */

(function () {
  const canvas = document.getElementById('stage');
  const g = canvas.getContext('2d', { alpha: true });
  const viewport = document.getElementById('viewport');
  const stage = new Stage();
  const overlay = new Overlay(
    document.getElementById('overlay'),
    document.getElementById('ticker-track')
  );
  const hub = new DanmakuHub();

  const dancers = [];
  const byName = new Map();
  const spawnQueue = [];   // 一次推几十条时排队上台，别一帧炸满整屏

  let mode = 'stage';
  let ratio = 'wide';
  let maxDancers = 30;
  let now = 0;
  let viewScale = 1;
  let connText = '—';
  let isPreview = false;

  // 舞台保底人数：不足这个数时谁都不许自然退场，别让舞池看着空
  const MIN_LIVE = 10;
  /** 实际生效的保底人数（同屏上限比 10 还小时，按上限来） */
  function liveFloor() {
    return Math.min(MIN_LIVE, maxDancers);
  }

  /* ---------- 布局：canvas 按比例 contain 居中 ---------- */
  function layout() {
    const W = window.innerWidth, H = window.innerHeight;
    const s = Math.min(W / SCENE.W, H / SCENE.H);
    const w = SCENE.W * s, h = SCENE.H * s;
    viewScale = s;
    viewport.style.width = w + 'px';
    viewport.style.height = h + 'px';
    viewport.style.left = Math.round((W - w) / 2) + 'px';
    viewport.style.top = Math.round((H - h) / 2) + 'px';
  }
  window.addEventListener('resize', layout);

  /* ---------- 舞台规格：横版 / 竖版 ---------- */
  function setRatio(name) {
    if (name !== 'vertical' && name !== 'wide') name = 'wide';
    const old = { min: SCENE.minX, span: SCENE.maxX - SCENE.minX };
    const changed = applyScene(name);
    ratio = name;
    canvas.width = SCENE.W;
    canvas.height = SCENE.H;

    // 已在场上的小人按比例挪到新画面里，不要凭空消失
    if (changed) {
      const span = SCENE.maxX - SCENE.minX;
      for (const d of dancers) {
        const nx = old.span > 0 ? (d.x - old.min) / old.span : 0.5;
        d.x = SCENE.minX + Math.min(1, Math.max(0, nx)) * span;
        d.setDepth(d.depth);
      }
    }
    layout();
    reportState();
    if (!isPreview) save();
  }

  function toScreen(x, y) {
    return { x: x * viewScale, y: y * viewScale };
  }

  /* ---------- 小人生成 ---------- */
  function findSpot() {
    let best = { x: SCENE.W / 2, depth: 0.5 }, bestD = -1;
    for (let i = 0; i < 20; i++) {
      const x = SCENE.minX + Math.random() * (SCENE.maxX - SCENE.minX);
      const depth = Math.random();
      const y = SCENE.backY + depth * (SCENE.frontY - SCENE.backY);
      let mind = 1e9;
      for (const d of dancers) {
        if (d.state === 'out') continue;
        const dx = d.x - x, dy = d.y - y;
        mind = Math.min(mind, Math.hypot(dx, dy * 1.7));
      }
      if (mind > bestD) { bestD = mind; best = { x, depth }; }
      if (bestD > 38) break;
    }
    return best;
  }

  function activeCount() {
    let n = 0;
    for (const d of dancers) if (d.state !== 'out' && !d.dead) n++;
    return n;
  }

  /** 人多时随机请走一位，而不是按年龄排队 —— 舞池要一直有流动感 */
  function retireRandom() {
    const pool = [];
    for (const d of dancers) if (d.state !== 'out' && !d.dead) pool.push(d);
    if (!pool.length) return null;
    const victim = pool[(Math.random() * pool.length) | 0];
    victim.retire();
    return victim;
  }

  /** 弹幕先排队，主循环每帧限量放人上台 */
  function enqueue(msg) {
    if (spawnQueue.length >= 200) spawnQueue.shift();   // 积压太狠就丢最旧的
    spawnQueue.push(msg);
  }

  function spawn(msg) {
    // 观众榜的续命消息不进底部飘屏，也不弹评论气泡 —— 人站着就行
    if (!msg.quiet) overlay.pushTicker(msg);

    // 同名只保留一个：不管第几次推送、走的哪条通道
    const exist = byName.get(msg.user) ||
      dancers.find(d => d.user === msg.user && !d.dead);
    if (exist && !exist.dead) {
      exist.refresh(msg);
      if (!msg.quiet) exist.sayAt = now;
      byName.set(msg.user, exist);
      return;
    }

    // 快挤满时才开始随机退人；人数没到保底值（默认 10）时一个都不许走
    const floor = liveFloor();
    const soft = Math.max(6, Math.round(maxDancers * 0.82));
    let live = activeCount();
    if (live > floor && live >= soft && Math.random() < 0.4) {
      retireRandom();
      live = activeCount();
    }

    // 真超员时退到装得下为止
    let guard = 0;
    while (live >= maxDancers && guard++ < 12) {
      if (!retireRandom()) break;
      live = activeCount();
    }

    const d = new Dancer(msg);
    const spot = findSpot();
    d.x = spot.x;
    d.setDepth(spot.depth);
    d.sayAt = now;
    dancers.push(d);
    byName.set(msg.user, d);
  }

  /* ---------- 主循环 ---------- */
  let last = 0;
  function frame(ts) {
    const t = ts / 1000;
    now = t;
    const dt = Math.min(0.05, t - last || 0.016);
    last = t;

    const beatPhase = ((t / BEAT) % 1 + 1) % 1;
    const pulse = Math.pow(1 - beatPhase, 2.2);

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, SCENE.W, SCENE.H);
    g.imageSmoothingEnabled = false;

    if (mode === 'stage') stage.drawBack(g, t, pulse);

    // 更新 + 清场
    // 先数一遍在场人数：不足保底值时所有小人都挂上 hold，到点也不退场
    const holding = activeCount() <= liveFloor();
    for (let i = dancers.length - 1; i >= 0; i--) {
      const d = dancers[i];
      d.hold = holding;
      d.update(dt, t);
      if (d.dead) {
        // 只删指向自己的那份索引，别把同名新人的映射一起删掉
        if (byName.get(d.user) === d) byName.delete(d.user);
        dancers.splice(i, 1);
      }
    }

    // 远的先画
    dancers.sort((a, b) => a.y - b.y);
    for (const d of dancers) d.draw(g, t);

    if (mode === 'stage') stage.drawFront(g, t, pulse);

    overlay.sync(dancers, now, toScreen, dt);

    requestAnimationFrame(frame);
  }

  /* ---------- 设置 ---------- */
  function setMode(m) {
    mode = m;
    document.body.classList.toggle('mode-stage', m === 'stage');
    document.body.classList.toggle('mode-transparent', m === 'transparent');
    // html 的背景也要跟着变，否则透明模式下整屏还是深色的
    document.documentElement.style.background = m === 'transparent' ? 'transparent' : '';
    if (!isPreview) save();
  }

  function setSource(s) {
    hub.setSource(s);
    if (!isPreview) save();
  }

  // 配置存 localStorage，控制台和舞台共用一份（同源）
  function save() {
    try {
      localStorage.setItem('ddisco', JSON.stringify({
        mode, source: hub.source, rate: hub.rate, max: maxDancers, ratio
      }));
    } catch (e) {}
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem('ddisco') || '{}');
      if (s.mode) mode = s.mode;
      if (s.max) maxDancers = s.max;
      if (s.rate) hub.rate = s.rate;
      else hub.rate = 0.8;
      if (s.source) hub._pendingSource = s.source;
      if (s.ratio === 'vertical' || s.ratio === 'wide') ratio = s.ratio;
    } catch (e) {}

    // URL 参数优先级最高：OBS 里直接改地址就能配
    const qs = new URLSearchParams(location.search);
    isPreview = qs.get('preview') === '1';
    if (qs.get('mode') === 'transparent' || qs.get('mode') === 'stage') mode = qs.get('mode');
    if (qs.get('max')) maxDancers = Math.max(5, Math.min(80, +qs.get('max') || 30));
    if (qs.get('rate')) hub.rate = Math.max(0.1, Math.min(2, +qs.get('rate') || 0.8));
    if (qs.get('src')) hub._pendingSource = qs.get('src');
    const ar = qs.get('ratio') || qs.get('ar');
    if (ar === 'vertical' || ar === 'wide') ratio = ar;
  }

  function clearAll() {
    spawnQueue.length = 0;
    dancers.forEach(d => d.retire());
    overlay.clear();
  }

  /* ---------- 控制台通道 ---------- */
  let channel = null;

  function setupLink() {
    channel = Link.join('stage', { preview: isPreview });
    channel.on(msg => {
      if (msg.type === 'control') applyControl(msg.action, msg.value);
      else if (msg.type === 'danmaku') hub.push(msg);
      else if (msg.type === 'ping') reportState();
    });
  }

  function applyControl(action, value) {
    switch (action) {
      case 'mode':   setMode(value); break;
      case 'source': setSource(value); break;
      case 'rate':   hub.setRate(value); break;
      case 'max':    maxDancers = Math.max(5, Math.min(80, +value || 30)); break;
      case 'ratio':  setRatio(value); break;
      case 'clear':  clearAll(); break;
      case 'burst':  hub.burst(+value || 20); break;
      case 'sync':   // 控制台把它持有的完整配置推过来
        if (value) {
          if (value.mode) setMode(value.mode);
          if (value.max) maxDancers = value.max;
          if (value.rate) hub.setRate(value.rate);
          if (value.source) setSource(value.source);
          if (value.ratio) setRatio(value.ratio);
        }
        break;
    }
    if (!isPreview) save();
  }

  function reportState() {
    if (!channel) return;
    // 带上 preview 标记：控制台优先采纳真实舞台的，没有真实舞台时才用预览的数字
    channel.post({
      to: 'console',
      type: 'state',
      live: dancers.filter(d => d.state !== 'out').length,
      total: hub.total,
      mode, ratio, source: hub.source, rate: hub.rate, max: maxDancers, conn: connText
    });
  }

  /* ---------- 指路提示 ---------- */
  function setupHint() {
    const hint = document.getElementById('hint');
    if (!hint || isPreview) { if (hint) hint.remove(); return; }
    const qs = new URLSearchParams(location.search);
    // OBS 采集时不显示；用户看过后也不再打扰
    let seen = false;
    try { seen = localStorage.getItem('ddisco-hinted') === '1'; } catch (e) {}
    if (qs.get('panel') === '0' || seen) { hint.remove(); return; }

    hint.querySelector('a').addEventListener('click', () => {
      try { localStorage.setItem('ddisco-hinted', '1'); } catch (e) {}
    });
    setTimeout(() => hint.classList.add('fade'), 4500);
    setTimeout(() => hint.remove(), 6000);
  }

  function bindKeys() {
    if (isPreview) return;
    window.addEventListener('keydown', e => {
      const k = e.key.toLowerCase();
      if (k === 'h') {
        const hint = document.getElementById('hint');
        if (hint) hint.remove();
      } else if (k === 'c') clearAll();
      else if (k === 'b') hub.burst(20);
      else if (k === 'f') {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
      }
    });
  }

  /* ---------- 启动 ---------- */
  const CONN_TEXT = {
    sim: '模拟', 'sim+live': '模拟+外部', open: '已连接',
    connecting: '连接中', closed: '未连接', idle: '待机'
  };
  hub.onStateChange(st => { connText = CONN_TEXT[st] || st; });

  load();
  setRatio(ratio);          // 先按规格定下画布尺寸，再算布局
  layout();
  setupLink();
  setupHint();
  bindKeys();
  setMode(mode);
  setSource(hub._pendingSource || 'sim');
  hub.onMessage = enqueue;

  // 上台节拍器：用定时器而不是 rAF 驱动。rAF 在后台标签页 / 部分 OBS 采集场景会被节流，
  // 弹幕是数据不是动画，不该跟着渲染一起停。每 70ms 放 2 个人，一批几十条也能平滑铺开。
  setInterval(() => {
    if (spawnQueue.length) now = performance.now() / 1000;   // rAF 被节流时也能有正确的发言时间戳
    let budget = 2;
    while (spawnQueue.length && budget-- > 0) spawn(spawnQueue.shift());
  }, 70);

  // 开场先来一波，别让舞台空着（只限模拟器模式；外部接入时舞台应该是干净的空场）
  if (hub.source === 'sim') hub.burst(10);

  // 定时把状态喂给控制台；控制台据此判断舞台在不在
  setInterval(reportState, 600);
  reportState();

  requestAnimationFrame(frame);
})();
