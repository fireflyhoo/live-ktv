/* ============================================================
   overlay.js — 高清覆盖层
   小人头顶的昵称 / 表情包 / 评论气泡，以及底部飘屏弹幕
   用 DOM 而不是 canvas，保证中文和 emoji 永远清晰
   ============================================================ */

const SAY_HOLD = 4.0;   // 评论气泡停留秒数

class Overlay {
  constructor(root, tickerRoot) {
    this.root = root;
    this.tickerRoot = tickerRoot;
    this.map = new Map();     // dancer -> {el, name, emote, say}
    this.queue = [];
    this.items = [];          // 正在飘的弹幕
    this.lastTicker = 0;
  }

  /** 每帧同步：建、删、跟随 */
  sync(dancers, now, toScreen, dt) {
    // 移除已退场
    for (const [d, rec] of this.map) {
      if (!dancers.includes(d)) {
        rec.el.remove();
        if (rec.lead) rec.lead.remove();
        this.map.delete(d);
      }
    }

    const list = [];
    for (const d of dancers) {
      let rec = this.map.get(d);
      if (!rec) { rec = this._create(d); this.map.set(d, rec); }
      list.push({ d, rec });
    }
    // 前排的标签位置优先保留，后排的往上让
    list.sort((a, b) => b.d.depth - a.d.depth);

    const placed = [];
    for (const it of list) {
      const d = it.d, rec = it.rec;
      if (!rec.measured) {
        rec.w = rec.el.offsetWidth || 88;
        rec.h = rec.el.offsetHeight || 40;
        rec.measured = true;
      }

      // 透视：前排的牌子大，后排的小
      const s = 0.82 + d.depth * 0.3;
      const w = rec.w * s, h = rec.h * s;

      const p = toScreen(d.headX, d.topY - 6);
      const x = Math.round(p.x);
      let y = Math.round(p.y - 2);

      // 垂直避让：跟已放好的牌子打架就往上抬
      for (let guard = 0; guard < 10; guard++) {
        let moved = false;
        for (const q of placed) {
          const overlapX = Math.abs(q.x - x) < (q.w + w) / 2 - 5;
          const overlapY = y > q.y - q.h - 3 && y - h < q.y + 3;
          if (overlapX && overlapY) { y = q.y - q.h - 4; moved = true; }
        }
        if (!moved) break;
      }
      placed.push({ x, y, w, h });

      // 抬升量做低通平滑，避免抖动
      const targetOff = p.y - y;
      rec.offY = rec.offY === undefined ? targetOff : rec.offY + (targetOff - rec.offY) * 0.25;
      const finalY = p.y - rec.offY;

      // 挤到高处的牌子淡出，宁缺毋滥
      const off = rec.offY;
      let vis = d.alpha;
      if (off > 128) vis = 0;
      else if (off > 82) vis *= 1 - (off - 82) / 46;

      rec.el.style.transform =
        `translate(${Math.round(x - w / 2)}px, ${Math.round(finalY - h)}px) scale(${s.toFixed(3)})`;
      rec.el.style.opacity = vis;
      rec.el.style.zIndex = String(100 + Math.round(d.depth * 100));

      // 抬太高时画一条引线，标明这块牌子是谁的
      if (rec.lead === undefined) rec.lead = this._makeLead();
      const leadLen = Math.max(0, off - 8);
      rec.lead.style.height = leadLen > 10 ? leadLen + 'px' : '0px';
      rec.lead.style.transform =
        `translate(${x}px, ${Math.round(p.y - leadLen)}px)`;
      rec.lead.style.opacity = vis * (leadLen > 10 ? 0.45 : 0);

      // 表情包变化（含图片表情包）
      const key = (d.emote || '') + '|' + (d.emoteUrl || '');
      if (rec.emoteKey !== key) {
        rec.emoteKey = key;
        if (!key || key === '|') {
          rec.emote.style.display = 'none';
        } else {
          rec.emote.style.display = '';
          rec.emote.innerHTML = d.emoteUrl
            ? `<img src="${escapeAttr(d.emoteUrl)}" alt="">`
            : escapeHtml(d.emote);
          rec.measured = false;
          replayAnim(rec.emote);
        }
      }

      // 评论气泡：停留一会儿再淡出（保留占位，避免布局跳动）
      const age = now - (d.sayAt || 0);
      const sayAlpha = d.text && age < SAY_HOLD ? Math.max(0, Math.min(1, SAY_HOLD - age)) : 0;
      if (rec.sayVis !== sayAlpha) {
        rec.sayVis = sayAlpha;
        rec.say.style.opacity = sayAlpha;
      }
      if (rec.sayText !== d.text) {
        rec.sayText = d.text;
        rec.say.textContent = d.text || '';
        rec.measured = false;               // 高度变了，重新量
        if (d.text) replayAnim(rec.say);
      }
    }

    this._pumpTicker(now);
    this._updateTicker(dt || 0);
  }

  _create(d) {
    const el = document.createElement('div');
    el.className = 'dancer-tag';

    const emote = document.createElement('div');
    emote.className = 'dancer-emote';
    emote.style.display = 'none';

    const name = document.createElement('div');
    name.className = 'dancer-name' + (d.isVip ? ' vip' : '');
    const plat = PLATFORMS[d.platform] || PLATFORMS.other;
    name.innerHTML =
      `<i class="plat" style="background:${plat.color}" title="${plat.name}"></i>` +
      escapeHtml(d.user);
    name.style.borderColor = d.look.tag;

    const say = document.createElement('div');
    say.className = 'dancer-say';
    say.textContent = d.text || '';
    say.style.opacity = '0';

    el.appendChild(emote);
    el.appendChild(name);
    el.appendChild(say);
    this.root.appendChild(el);
    return { el, name, emote, say, emoteKey: null, sayVis: -1, sayText: null, offY: 0, measured: false, lead: undefined };
  }

  /** 标签被抬高时，从标签底连到小人头顶的细引线 */
  _makeLead() {
    const el = document.createElement('div');
    el.className = 'tag-lead';
    this.root.appendChild(el);
    return el;
  }

  /* ---------- 飘屏弹幕 ---------- */
  pushTicker(msg) {
    this.queue.push(msg);
    if (this.queue.length > 30) this.queue.shift();
  }

  /** 主循环驱动，不依赖 Web Animations，也不会前后追尾 */
  _pumpTicker(now) {
    if (!this.queue.length) return;
    if (now - this.lastTicker < 0.3) return;
    const trackW = this.tickerRoot.offsetWidth || 800;
    const last = this.items[this.items.length - 1];
    if (last && last.x + last.w > trackW - 16) return;   // 上一条还没完全进场
    this.lastTicker = now;
    this._runTicker(this.queue.shift(), trackW);
  }

  _runTicker(msg, trackW) {
    const el = document.createElement('div');
    el.className = 'ticker-item';
    const plat = PLATFORMS[msg.platform] || PLATFORMS.other;
    el.innerHTML =
      `<span class="u" style="color:${plat.color}">${escapeHtml(msg.user)}</span>` +
      `<span class="t">${escapeHtml(msg.text)}</span>` +
      (msg.emote ? `<span class="e">${escapeHtml(msg.emote)}</span>` : '');
    el.style.transform = `translateX(${trackW}px)`;
    this.tickerRoot.appendChild(el);

    // 最多同时飘 16 条
    if (this.items.length > 16) {
      const old = this.items.shift();
      old.el.remove();
    }
    this.items.push({ el, x: trackW, w: el.offsetWidth || 200, speed: 175 });
  }

  _updateTicker(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.x -= it.speed * dt;
      if (it.x + it.w < -30) {
        it.el.remove();
        this.items.splice(i, 1);
      } else {
        it.el.style.transform = `translateX(${Math.round(it.x)}px)`;
      }
    }
  }

  clear() {
    for (const [, rec] of this.map) {
      rec.el.remove();
      if (rec.lead) rec.lead.remove();
    }
    this.map.clear();
    this.tickerRoot.innerHTML = '';
    this.queue.length = 0;
    this.items.length = 0;
  }
}

/* ---------- 小工具 ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return String(s).replace(/["']/g, '');
}
/** 重启 CSS 动画 */
function replayAnim(el) {
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}
