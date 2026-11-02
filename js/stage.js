/* ============================================================
   stage.js — 舞池场景
   完整舞台模式：LED 墙 / disco 球 / 旋转灯 / 透视地板 / 音箱 / 人群剪影
   透明叠加模式：整层不画，只留小人和名牌
   所有尺寸都从 SCENE 推导，切 16:9 / 9:16 时整套布景自动重排
   ============================================================ */

/* 8x8 像素图案，给 LED 墙用 */
const ICONS = {
  heart: [
    '.##..##.', '########', '########', '########',
    '.######.', '..####..', '...##...', '........'
  ],
  note: [
    '....##..', '...###..', '..####..', '.#####..',
    '.#####..', '..#.#...', '.###....', '.###....'
  ],
  star: [
    '...##...', '...##...', '########', '.######.',
    '..####..', '.##..##.', '##....##', '........'
  ],
  arrow: [
    '...##...', '..####..', '.######.', '########',
    '...##...', '...##...', '...##...', '........'
  ]
};
const ICON_KEYS = ['heart', 'note', 'star', 'arrow'];

function pxCircle(g, cx, cy, r, color) {
  g.fillStyle = color;
  for (let y = -r; y <= r; y++) {
    const w = Math.floor(Math.sqrt(Math.max(0, r * r - y * y)));
    g.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2 + 1, 1);
  }
}

class Stage {
  constructor() {
    this._lW = 0; this._lH = 0;
    // 漂浮的灰尘/光点（位置随兽幕游走，切换规格后自动收敛到新画布）
    this.dust = [];
    for (let i = 0; i < 42; i++) {
      this.dust.push({
        x: Math.random() * SCENE.W,
        y: Math.random() * SCENE.H,
        s: 0.15 + Math.random() * 0.4,
        r: Math.random() < 0.3 ? 2 : 1,
        c: pick(Palette.neon),
        a: 0.2 + Math.random() * 0.5
      });
    }
    this.iconIdx = 0;
    this.iconFlip = 0;
    this.ledSeed = [];
    for (let i = 0; i < 60; i++) this.ledSeed.push(Math.random());
  }

  /* ---------- 布景尺寸：随画面规格重算 ---------- */
  _layout() {
    const W = SCENE.W, H = SCENE.H;
    if (this._lW === W && this._lH === H) return this.L;
    this._lW = W; this._lH = H;

    const top = SCENE.floorTop;
    const vert = !!SCENE.vertical;

    // --- LED 墙 ---
    const cols = vert ? 8 : 17;
    const rows = vert ? 6 : 7;
    const bw = vert ? 18 : 20;
    const bh = vert ? 16 : 15;
    const wallW = cols * bw, wallH = rows * bh;
    const led = {
      x0: Math.round((W - wallW) / 2),
      y0: vert ? 46 : 52,
      cols, rows, bw, bh, wallW, wallH,
      px: Math.max(3, Math.round(wallH / 34))   // 中央图案的像素块大小
    };

    // --- 桁架 + 灯头（光束也从这里打出来）---
    const trussY = Math.round(H * 0.061);
    const lampN = vert ? 5 : 8;
    const lampM = vert ? 12 : 40;
    const lampStep = (W - lampM * 2 - 12) / (lampN - 1);
    const lamps = [];
    for (let i = 0; i < lampN; i++) lamps.push(Math.round(lampM + i * lampStep));

    // --- 光束 ---
    const beamN = vert ? 4 : 5;
    const beamM = vert ? 18 : 60;
    const beamStep = (W - beamM * 2) / (beamN - 1);
    const beams = [];
    for (let i = 0; i < beamN; i++) beams.push(Math.round(beamM + i * beamStep));

    // --- 两侧音箱 ---
    const sw = vert ? Math.round(W * 0.1) : 46;

    this.L = {
      W, H, top, vert,
      led, trussY, lamps, beams, beamLen: Math.round(H * 1.17),
      speakerW: sw,
      // 地板网格
      hLines: vert ? 11 : 9,
      vStep: Math.round(W / (vert ? 6 : 8)),
      vSide: vert ? 5 : 7,
      reflectW: Math.round(W * 0.094),
      // 后排人群
      crowdN: vert ? 12 : 26,
      crowdStep: (W - 24) / ((vert ? 12 : 26) - 1),
      // disco 球
      ballR: vert ? 13 : 19,
      ballFY: vert ? 38 : 44
    };
    return this.L;
  }

  /** 背景 + 地板 + 灯光（小人之前画） */
  drawBack(g, t, pulse) {
    const L = this._layout();
    const W = L.W, H = L.H, top = L.top;

    // ---- 背景墙：横向条带，越往下越亮（被打光） ----
    g.fillStyle = '#0a0616';
    g.fillRect(0, 0, W, H);
    for (let y = 0; y < top; y += 4) {
      const f = y / top;
      g.fillStyle = `rgb(${10 + f * 26},${6 + f * 12},${22 + f * 44})`;
      g.fillRect(0, y, W, 4);
    }

    this._ledWall(g, t, pulse, L);
    this._truss(g, t, L);
    this._floor(g, t, pulse, L);
    this._crowd(g, t, pulse, L);
    this._beams(g, t, pulse, L);
    this._mirrorBall(g, t, L);
    this._speakers(g, t, pulse, L);
  }

  /** 前景：雾气、光点、闪光（小人之后画） */
  drawFront(g, t, pulse) {
    const L = this._layout();
    const W = L.W, H = L.H;

    // 节拍闪光
    if (pulse > 0.82) {
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = (pulse - 0.82) * 0.28;
      g.fillStyle = '#7a5cff';
      g.fillRect(0, 0, W, H);
      g.restore();
    }

    // 漂浮光点
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const d of this.dust) {
      d.y -= d.s * 0.35;
      if (d.y < -4 || d.x > W || d.x < 0) {
        d.y = H + 4; d.x = Math.random() * W;
      }
      g.globalAlpha = d.a * (0.5 + pulse * 0.5);
      g.fillStyle = d.c;
      g.fillRect(Math.round(d.x), Math.round(d.y), d.r, d.r);
    }
    g.restore();

    // 底部暗角，让人群站得住
    const vh = Math.round(H * 0.17);
    const grad = g.createLinearGradient(0, H - vh, 0, H);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = grad;
    g.fillRect(0, H - vh, W, vh);
  }

  /* ---------- LED 墙 ---------- */
  _ledWall(g, t, pulse, L) {
    const { x0, y0, cols, rows, bw, bh, wallW, wallH, px } = L.led;
    // 底板
    g.fillStyle = '#0d0718';
    g.fillRect(x0 - 3, y0 - 3, wallW + 6, wallH + 6);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const sd = this.ledSeed[i % this.ledSeed.length];
        const on = Math.sin(t * 3 + sd * 6.28 + r * 0.7 + c * 0.5) > -0.1;
        g.fillStyle = on
          ? Palette.neon[(i + ((t / BEAT) | 0)) % Palette.neon.length]
          : '#150d26';
        g.globalAlpha = on ? 0.45 + pulse * 0.4 : 1;
        g.fillRect(x0 + c * bw, y0 + r * bh, bw - 2, bh - 2);
      }
    }
    g.globalAlpha = 1;

    // 中央图案：每小节换一个
    const idx = ((t / BAR) | 0) % ICON_KEYS.length;
    const icon = ICONS[ICON_KEYS[idx]];
    const size = 8 * px;
    const ox = x0 + ((wallW - size) / 2) | 0;
    const oy = y0 + ((wallH - size) / 2) | 0;
    const col = Palette.neon[(t / BAR) % Palette.neon.length | 0];
    g.globalAlpha = 0.55 + pulse * 0.45;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (icon[r][c] === '#') {
          g.fillStyle = col;
          g.fillRect(ox + c * px, oy + r * px, px, px);
        }
      }
    }
    g.globalAlpha = 1;

    // 波浪扫描条
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.18;
    const sy = y0 + ((t * 60) % wallH);
    g.fillStyle = '#ffffff';
    g.fillRect(x0, sy, wallW, 3);
    g.restore();
  }

  /* ---------- 顶部桁架 + 灯头 ---------- */
  _truss(g, t, L) {
    const W = L.W, y = L.trussY;
    g.fillStyle = '#1a1430';
    g.fillRect(0, y, W, 8);
    g.fillStyle = '#241c42';
    for (let x = 0; x < W; x += 16) {
      g.fillRect(x, y, 2, 8);
      g.fillRect(x + 8, y + 8, 2, 3);
    }
    // 灯头
    const lw = L.vert ? 10 : 12;
    for (let i = 0; i < L.lamps.length; i++) {
      const x = L.lamps[i];
      g.fillStyle = '#12101f';
      g.fillRect(x, y + 8, lw, 9);
      const c = Palette.neon[(i + ((t / BEAT) | 0)) % Palette.neon.length];
      g.fillStyle = c;
      g.globalAlpha = 0.75;
      g.fillRect(x + 2, y + 16, lw - 4, 3);
      g.globalAlpha = 1;
    }
  }

  /* ---------- 透视地板 ---------- */
  _floor(g, t, pulse, L) {
    const W = L.W, H = L.H, top = L.top;
    // 地面底色
    g.fillStyle = '#150c28';
    g.fillRect(0, top, W, H - top);

    // 灯光在地上的倒影（竖向色带）
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 6; i++) {
      const c = Palette.neon[(i + ((t / (BEAT * 2)) | 0)) % Palette.neon.length];
      const x = ((i * 107 + t * 22) % (W + 160)) - 80;
      g.globalAlpha = 0.05 + pulse * 0.05;
      g.fillStyle = c;
      g.fillRect(Math.round(x), top, L.reflectW, H - top);
    }
    g.restore();

    // 横线（近处间距大）
    const vpx = W / 2;
    g.strokeStyle = '#5b3fa8';
    for (let i = 1; i <= L.hLines; i++) {
      const f = i / L.hLines;
      const y = top + Math.pow(f, 1.9) * (H - top);
      const c = Palette.neon[(i + ((t / (BEAT * 2)) | 0)) % Palette.neon.length];
      g.globalAlpha = 0.18 + pulse * 0.22;
      g.fillStyle = c;
      g.fillRect(0, Math.round(y), W, 1);
    }
    // 竖线（从消失点发散）
    for (let i = -L.vSide; i <= L.vSide; i++) {
      const xb = vpx + i * L.vStep;
      g.globalAlpha = 0.14;
      g.strokeStyle = '#7a5cd8';
      g.beginPath();
      g.moveTo(vpx, top);
      g.lineTo(xb, H);
      g.stroke();
    }
    g.globalAlpha = 1;

    // 舞池边缘霓虹条
    g.fillStyle = Palette.neon[(t / BEAT) % Palette.neon.length | 0];
    g.globalAlpha = 0.5 + pulse * 0.4;
    g.fillRect(0, top - 2, W, 2);
    g.globalAlpha = 1;
  }

  /* ---------- 后排人群剪影 ---------- */
  _crowd(g, t, pulse, L) {
    g.save();
    g.globalAlpha = 0.85;
    const step = L.crowdStep, jit = step * 0.33;
    for (let i = 0; i < L.crowdN; i++) {
      const sd = this.ledSeed[(i * 7) % this.ledSeed.length];
      const x = 12 + i * step + sd * jit;
      const depth = 0.06 + sd * 0.1;
      const y = L.top - 6 + depth * 46;
      const bob = Math.sin(t * 4 + i * 0.9) * (1 + pulse * 2);
      const s = 0.5 + depth;
      // 头 + 肩，纯剪影
      g.fillStyle = '#1d1436';
      g.fillRect(Math.round(x), Math.round(y - 9 * s + bob), Math.round(7 * s), Math.round(7 * s));
      g.fillRect(Math.round(x - 2 * s), Math.round(y - 2 * s + bob), Math.round(11 * s), Math.round(6 * s));
      // 举起的手
      if (sd > 0.62) {
        g.fillRect(Math.round(x - 3 * s), Math.round(y - 14 * s + bob), Math.round(2 * s), Math.round(6 * s));
        g.fillRect(Math.round(x + 8 * s), Math.round(y - 14 * s + bob), Math.round(2 * s), Math.round(6 * s));
      }
    }
    g.restore();
  }

  /* ---------- 旋转光束 ---------- */
  _beams(g, t, pulse, L) {
    g.save();
    g.globalCompositeOperation = 'lighter';
    const n = L.beams.length, oy = L.trussY + 16, len = L.beamLen;
    for (let i = 0; i < n; i++) {
      const a = t * 0.8 + (i * Math.PI * 2) / n;
      const ox = L.beams[i];
      const ex = ox + Math.sin(a) * len;
      const ey = oy + Math.abs(Math.cos(a)) * len * 0.85 + 60;
      const c = Palette.neon[(i * 3 + ((t / BEAT) | 0)) % Palette.neon.length];

      g.globalAlpha = 0.065 + pulse * 0.055;
      g.strokeStyle = c;
      g.lineWidth = (L.vert ? 9 : 11) + pulse * 6;
      g.beginPath();
      g.moveTo(ox, oy);
      g.lineTo(ex, ey);
      g.stroke();

      // 光束内部的亮芯
      g.globalAlpha = 0.07 + pulse * 0.07;
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(ox, oy);
      g.lineTo(ex, ey);
      g.stroke();

      // 打在地上的光斑
      const gx = ox + Math.sin(a) * len * 0.62;
      const gy = L.top + 60 + Math.abs(Math.cos(a)) * 80;
      pxGlow(g, gx, gy, 26, 7, c, 0.1 + pulse * 0.14);
    }
    g.restore();
  }

  /* ---------- disco 球 ---------- */
  _mirrorBall(g, t, L) {
    const cx = L.W / 2, cy = L.ballFY, r = L.ballR;
    const span = L.vert ? 120 : 190;
    // 吊杆
    g.fillStyle = '#241c42';
    g.fillRect(cx - 1, L.trussY, 2, cy - r - L.trussY);

    pxCircle(g, cx, cy, r, '#2a2350');
    // 镜面格子
    for (let y = -r; y <= r; y += 3) {
      const w = Math.floor(Math.sqrt(Math.max(0, r * r - y * y)));
      for (let x = -w; x <= w; x += 3) {
        const sh = Math.sin(x * 0.9 + y * 0.7 + t * 2.2);
        g.fillStyle = sh > 0.55 ? '#6f63c9' : (sh > 0.1 ? '#544a9e' : '#3b3474');
        g.fillRect(Math.round(cx + x), Math.round(cy + y), 2, 2);
      }
    }
    // 高光
    g.fillStyle = '#ffffff';
    g.globalAlpha = 0.85;
    g.fillRect(Math.round(cx + Math.cos(t * 1.4) * r * 0.5 - 2),
               Math.round(cy + Math.sin(t * 1.1) * r * 0.5 - 2), 3, 3);
    g.globalAlpha = 1;

    // 反射光点
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 14; i++) {
      const a = t * 1.6 + i * 0.9;
      const rr = (L.vert ? 40 : 60) + ((t * 40 + i * 33) % span);
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.abs(Math.sin(a * 1.3)) * rr * 0.55 + 20;
      if (x < 0 || x > L.W || y > L.H) continue;
      g.globalAlpha = 0.30 * (1 - rr / (span + 60));
      g.fillStyle = Palette.neon[i % Palette.neon.length];
      g.fillRect(Math.round(x), Math.round(y), 2, 2);
    }
    g.restore();
  }

  /* ---------- 两侧音箱 ---------- */
  _speakers(g, t, pulse, L) {
    const sw = L.speakerW;
    const edge = L.vert ? 2 : 6;
    const draw = (x) => {
      const top = L.top - 6, h = L.H - top - 6;
      g.fillStyle = '#191228';
      g.fillRect(x, top, sw, h);
      g.fillStyle = '#221a3a';
      g.fillRect(x + 2, top + 2, sw - 4, h - 4);

      // 喇叭：随节拍鼓
      const cones = [0.42, 0.78];
      for (let i = 0; i < cones.length; i++) {
        const cy = top + h * cones[i];
        const rr = sw * (i === 0 ? 0.30 : 0.20) * (1 + pulse * 0.12);
        pxCircle(g, x + sw / 2, cy, rr, '#0e0a1a');
        pxCircle(g, x + sw / 2, cy, rr - 2, '#2e2550');
        pxCircle(g, x + sw / 2, cy, Math.max(2, (rr - 5) * (1 + pulse * 0.3)), '#4a3d80');
      }
      // 指示灯
      g.fillStyle = Palette.neon[(t / BEAT) % Palette.neon.length | 0];
      g.globalAlpha = 0.5 + pulse * 0.5;
      g.fillRect(x + (sw >> 1) - 5, top + 6, 10, 2);
      g.globalAlpha = 1;
    };
    draw(edge);
    draw(L.W - sw - edge);
  }
}
