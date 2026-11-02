/* ============================================================
   dancer.js — 像素小人
   本地坐标系：脚底中心为原点，向上为负 y
   头 -23~-15 / 躯干 -15~-7 / 腿 -7~0，总高 23px
   ============================================================ */

/* ---------- 舞台规格 ---------- */
/* 两套画面的共同点是「场景高 360 上下」：像素块和小人的相对大小不变，
   换规格只是把取景框横向裁窄 / 加高，不会让小人变成大人。
   scaleMin / scaleSpan：小人深浅方向的缩放范围（前排大、后排小）        */
const SCENE_PRESETS = {
  wide: {
    label: 'PC 横版 16:9', ar: [16, 9], vertical: false,
    W: 640, H: 360,
    floorTop: 196,        // 地平线：地板从这里开始
    backY: 238,           // 最后一排的脚底 y
    frontY: 342,          // 最前一排的脚底 y
    minX: 34, maxX: 606,
    scaleMin: 0.62, scaleSpan: 0.50
  },
  vertical: {
    label: '手机竖版 9:16', ar: [9, 16], vertical: true,
    W: 180, H: 320,
    floorTop: 158,        // 地平线：地板从这里开始
    backY: 172,           // 最后一排的脚底 y
    frontY: 306,          // 最前一排的脚底 y
    minX: 24, maxX: 156,
    scaleMin: 0.74, scaleSpan: 0.62
  }
};

const SCENE = Object.assign({ name: 'wide' }, SCENE_PRESETS.wide);

/** 切换舞台规格；返回是否真的变了 */
function applyScene(name) {
  const p = SCENE_PRESETS[name] || SCENE_PRESETS.wide;
  if (SCENE.name === name && SCENE.W === p.W) return false;
  Object.assign(SCENE, p, { name: SCENE_PRESETS[name] ? name : 'wide' });
  return true;
}

const OUTLINE = '#0d0a18';

const DANCES = ['jump', 'raise', 'swing', 'robot', 'spin', 'step'];

/* ---------- 像素绘制原语 ---------- */

/** 带 1px 深色描边的方块 —— 描边是像素风的灵魂 */
function pxRect(g, x, y, w, h, color, outline) {
  x = Math.round(x); y = Math.round(y);
  if (outline !== false) {
    g.fillStyle = OUTLINE;
    g.fillRect(x - 1, y - 1, w + 2, h + 2);
  }
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
}

/** Bresenham 粗线，用来画任意角度的手臂和腿 */
function pxLine(g, x1, y1, x2, y2, color, th) {
  x1 = Math.round(x1); y1 = Math.round(y1);
  x2 = Math.round(x2); y2 = Math.round(y2);
  const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
  const sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1;
  let err = dx - dy;
  const o = (th - 1) >> 1;
  g.fillStyle = color;
  for (;;) {
    g.fillRect(x1 - o, y1 - o, th, th);
    if (x1 === x2 && y1 === y2) break;
    const e2 = err << 1;
    if (e2 > -dy) { err -= dy; x1 += sx; }
    if (e2 < dx)  { err += dx; y1 += sy; }
  }
}

/** 地面光斑：用三层矩形堆出椭圆的像素近似 */
function pxGlow(g, cx, cy, rx, ry, color, alpha) {
  g.save();
  g.globalAlpha = alpha;
  g.fillStyle = color;
  const x = Math.round(cx - rx), w = Math.round(rx * 2);
  g.fillRect(x + 1, Math.round(cy - ry), w - 2, Math.round(ry * 2));
  g.fillRect(x + 3, Math.round(cy - ry) - 1, w - 6, Math.round(ry * 2) + 2);
  g.restore();
}

/* ---------- 小人 ---------- */

class Dancer {
  constructor(msg) {
    this.key = msg.user;
    this.user = msg.user;
    this.text = msg.text || '';
    this.emote = msg.emote || '';
    this.platform = msg.platform || '';
    this.isVip = !!msg.isVip;

    // 同一个昵称每次上台长得一样
    const rnd = seededRandom(hashStr(msg.user) || 7);
    this.look = {
      skin:  Palette.skin [(rnd() * Palette.skin.length)  | 0],
      hair:  Palette.hair [(rnd() * Palette.hair.length)  | 0],
      shirt: Palette.shirt[(rnd() * Palette.shirt.length) | 0],
      pants: Palette.pants[(rnd() * Palette.pants.length) | 0],
      shoe:  Palette.shoe [(rnd() * Palette.shoe.length)  | 0],
      tag:   Palette.tag  [(rnd() * Palette.tag.length)   | 0]
    };

    this.dance = DANCES[(rnd() * DANCES.length) | 0];
    this.phase = rnd() * Math.PI * 2;
    this.beatOff = rnd() < 0.72 ? 0 : BAR * 0.5;   // 多数人踩在同一个拍子上
    this.speed = 0.92 + rnd() * 0.22;
    this.depth = rnd();

    this.x = 0;
    this.y = SCENE.backY;
    this.setDepth(this.depth);

    // 生命周期
    this.state = 'in';
    this.age = 0;
    this.life = 22 + rnd() * 10;
    this.hold = false;        // 舞台人数不足保底值时置 true：到点也不退场
    this.hype = 1.4;          // 刚发言的欢呼时间
    this.alpha = 0;
    this.dead = false;
    this.topY = this.y;       // 头顶屏幕 y，给覆盖层定位用
  }

  setDepth(d) {
    this.depth = d;
    this.y = SCENE.backY + d * (SCENE.frontY - SCENE.backY);
    this.scale = SCENE.scaleMin + d * SCENE.scaleSpan;
  }

  /** 同一昵称再次发言：刷新内容并续命 */
  refresh(msg) {
    this.text = msg.text || this.text;
    this.emote = msg.emote !== undefined ? msg.emote : this.emote;
    // 观众榜的续命是静默的，不让人群每隔 12 秒集体欢呼一次
    if (!msg.quiet) this.hype = 1.4;
    this.age = Math.min(this.age, this.life * 0.35);
    if (this.state === 'out') { this.state = 'idle'; this.exitT = 0; }
    return this;
  }

  retire() {
    if (this.state !== 'out') { this.state = 'out'; this.exitT = 0; }
  }

  update(dt, now) {
    this.age += dt;
    if (this.hype > 0) this.hype -= dt;

    if (this.state === 'in') {
      const t = Math.min(1, this.age / 0.55);
      this.enterT = t;
      this.alpha = Math.min(1, t * 2.4);
      this.enterScale = Ease.outBack(t);
      if (t >= 1) { this.state = 'idle'; }
    } else if (this.state === 'out') {
      this.exitT = Math.min(1, (this.exitT || 0) + dt / 0.7);
      this.alpha = 1 - this.exitT;
      if (this.exitT >= 1) this.dead = true;
    } else {
      this.enterT = 1;
      this.enterScale = 1;
      this.alpha = 1;
      if (this.age > this.life) {
        if (this.hold) {
          // 台上人太少：不退场，只把寿命往后顺延一段随机时间。
          // 顺延而不是原地卡住，是为了等人数上来后大家错开时间陆续走，不会集体消失。
          this.life = this.age + 6 + Math.random() * 10;
        } else {
          this.retire();
        }
      }
    }
  }

  /** 计算当前姿态 */
  pose(t) {
    const tt = t * this.speed;
    const p = (((tt + this.beatOff) / BEAT) % 1 + 1) % 1;   // 拍内相位 0..1
    const s = this.phase;
    const d = this.dance;
    const hype = this.hype > 0 ? Math.min(1, this.hype / 0.5) : 0;

    let bodyY = 0, hipX = 0, lean = 0, narrow = 1, flip = 1;
    let aL = { x: -6, y: 3 }, aR = { x: 6, y: 3 };
    let fL = { x: -2, y: 7 }, fR = { x: 2, y: 7 };

    switch (d) {
      case 'jump': {
        const j = Math.pow(Math.abs(Math.sin(p * Math.PI)), 0.65);
        bodyY = -j * 6;
        const lift = j * 5;
        fL.y = fR.y = 7 - lift;
        const ay = 3 - j * 12;
        aL = { x: -6, y: ay }; aR = { x: 6, y: ay };
        break;
      }
      case 'raise': {
        const j = Math.pow(Math.abs(Math.sin(p * Math.PI)), 0.65);
        bodyY = -j * 5.5;
        fL.y = fR.y = 7 - j * 4.5;
        aL = { x: -4, y: -11 - j * 2 }; aR = { x: 4, y: -11 - j * 2 };
        break;
      }
      case 'swing': {
        const sw = Math.sin(p * Math.PI * 2 + s);
        hipX = sw * 2.6; lean = -sw * 2.6;
        bodyY = -Math.abs(sw) * 1.8;
        aL = { x: -6, y: -1 + sw * 7 }; aR = { x: 6, y: -1 - sw * 7 };
        fL = { x: -2 - sw * 1.5, y: 7 }; fR = { x: 2 - sw * 1.5, y: 7 };
        break;
      }
      case 'robot': {
        const steps = [
          [-6, 3, 6, -7, 0],
          [-6, -7, 6, 3, -1],
          [-2, -10, 2, -10, 1],
          [-7, 0, 7, 0, 0]
        ];
        const st = steps[(Math.floor(p * 4) + (s | 0)) % 4];
        aL = { x: st[0], y: st[1] }; aR = { x: st[2], y: st[3] };
        hipX = st[4]; bodyY = -1;
        fL.y = fR.y = 7 - (st[1] < -5 ? 1 : 0);
        break;
      }
      case 'spin': {
        const a = tt * 3.4 + s;
        narrow = Math.max(0.32, Math.abs(Math.cos(a)));
        flip = Math.cos(a) >= 0 ? 1 : -1;
        bodyY = -Math.abs(Math.sin(p * Math.PI)) * 3;
        aL = { x: -7, y: -3 }; aR = { x: 7, y: -3 };
        break;
      }
      default: { // step
        const sw = Math.sin(p * Math.PI * 2 + s);
        fL = { x: -2, y: 7 - Math.max(0, sw) * 4.5 };
        fR = { x: 2,  y: 7 - Math.max(0, -sw) * 4.5 };
        hipX = sw * 1.6;
        bodyY = -1.5 - Math.abs(sw) * 1.2;
        aL = { x: -5, y: 2 - sw * 3 }; aR = { x: 5, y: 2 + sw * 3 };
      }
    }

    // 刚发言：双手举高 + 多蹦两下
    if (hype > 0) {
      bodyY -= hype * 2.5;
      aL = { x: aL.x * 0.6 - 2, y: aL.y * (1 - hype) - 11 * hype };
      aR = { x: aR.x * 0.6 + 2, y: aR.y * (1 - hype) - 11 * hype };
    }

    // 入场：从地里冒出来
    let scale = this.scale * (this.enterScale === undefined ? 1 : this.enterScale);
    let yOff = 0;
    if (this.state === 'in') {
      yOff = (1 - Ease.outCubic(this.enterT)) * 20;
      scale = this.scale * Math.max(0.05, this.enterScale);
    } else if (this.state === 'out') {
      yOff = Ease.inCubic(this.exitT) * 16;
      scale = this.scale * (1 - 0.35 * this.exitT);
    }
    scale *= narrow;

    return { bodyY, hipX, lean, flip, scale, yOff, aL, aR, fL, fR, beat: p };
  }

  draw(g, t) {
    const p = this.pose(t);
    const L = this.look;
    const sc = p.scale;
    const baseX = this.x + p.hipX;
    const baseY = this.y + p.yOff + p.bodyY * sc;

    // --- 地面光斑（踩点闪） ---
    const flash = Math.pow(1 - p.beat, 3);
    pxGlow(g, this.x + p.hipX, this.y + 1,
      (5 + flash * 2.5) * this.scale, 2 * this.scale,
      L.shirt, 0.16 + flash * 0.3);

    g.save();
    g.globalAlpha = this.alpha;
    g.translate(Math.round(baseX), Math.round(baseY));
    g.scale(p.flip * sc, sc);

    const hipY = -7, shY = -15;

    // --- 腿 ---
    pxLine(g, -2, hipY, p.fL.x, p.fL.y, OUTLINE, 5);
    pxLine(g, 2, hipY, p.fR.x, p.fR.y, OUTLINE, 5);
    pxLine(g, -2, hipY, p.fL.x, p.fL.y, L.pants, 3);
    pxLine(g, 2, hipY, p.fR.x, p.fR.y, L.pants, 3);
    // 鞋
    pxRect(g, p.fL.x - 2, p.fL.y - 1, 4, 2, L.shoe);
    pxRect(g, p.fR.x - 1, p.fR.y - 1, 4, 2, L.shoe);

    // --- 躯干 ---
    const tx = p.lean * 0.5;
    pxRect(g, -4 + tx * 0.4, -15, 8, 8, L.shirt);

    // --- 手臂 ---
    const lx = -4 + tx * 0.4, rx = 4 + tx * 0.4;
    pxLine(g, lx, shY + 1, lx + p.aL.x, shY + 1 + p.aL.y, OUTLINE, 4);
    pxLine(g, rx, shY + 1, rx + p.aR.x, shY + 1 + p.aR.y, OUTLINE, 4);
    pxLine(g, lx, shY + 1, lx + p.aL.x, shY + 1 + p.aL.y, L.shirt, 2);
    pxLine(g, rx, shY + 1, rx + p.aR.x, shY + 1 + p.aR.y, L.shirt, 2);
    // 手
    pxRect(g, lx + p.aL.x - 1, shY + p.aL.y, 2, 2, L.skin);
    pxRect(g, rx + p.aR.x - 1, shY + p.aR.y, 2, 2, L.skin);

    // --- 头 ---
    const hx = p.lean;
    pxRect(g, -4 + hx, -23, 8, 8, L.skin);           // 脸
    pxRect(g, -4 + hx, -24, 8, 3, L.hair);           // 头发
    pxRect(g, -5 + hx, -23, 1, 5, L.hair);           // 鬓角
    pxRect(g, 4 + hx, -23, 1, 5, L.hair);
    g.fillStyle = OUTLINE;                            // 眼睛
    g.fillRect(-3 + hx, -20, 1, 2);
    g.fillRect(2 + hx, -20, 1, 2);
    // 嘴（欢呼时张开）
    if (this.hype > 0.2) g.fillRect(-1 + hx, -17, 3, 2);
    else g.fillRect(-1 + hx, -17, 2, 1);

    g.restore();

    // 头顶位置（给覆盖层放昵称和表情包）
    this.topY = baseY + (-25) * sc;
    this.headX = baseX + p.lean * sc;
  }
}
