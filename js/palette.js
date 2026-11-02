/* ============================================================
   palette.js — 像素调色板
   有限色板是像素风的灵魂：所有颜色都从这里取，不出现渐变
   ============================================================ */

const Palette = {
  // 霓虹灯色（舞台灯光 / 地板 / 光斑）
  neon: [
    '#ff2d78', '#ff6b35', '#ffd23f', '#b6ff3c',
    '#35e8ff', '#4d7cff', '#a86bff', '#ff4df0'
  ],

  // 肤色（4 档，从浅到深）
  skin: ['#ffe0bd', '#f7c999', '#e0a871', '#b87a4a'],

  // 发色
  hair: [
    '#2b1d17', '#4a2c1a', '#8b4a2b', '#c9913f',
    '#e8d9a0', '#9aa0a6', '#6b3fa0', '#ff4d9e', '#35e8ff'
  ],

  // 上衣
  shirt: [
    '#ff4d6d', '#ff8a3d', '#ffd23f', '#7bed4f',
    '#35e8ff', '#5b8cff', '#a86bff', '#ff4df0',
    '#f5f5f5', '#2f2a45'
  ],

  // 裤子
  pants: [
    '#2f3a6b', '#1f2440', '#5a3b7a', '#7a2f3f',
    '#2b6b5a', '#3d3d46', '#8a5a2b', '#c9407a'
    ],

  // 鞋
  shoe: ['#1a1626', '#f5f5f5', '#ff4d6d', '#35e8ff'],

  // 名牌配色（昵称气泡边框色）
  tag: ['#35e8ff', '#ff4d9e', '#b6ff3c', '#ffd23f', '#a86bff', '#ff8a3d']
};

/* 从数组里随机取一个 */
function pick(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

/* 生成一个完整的人物配色方案 */
function makeLook() {
  return {
    skin:  pick(Palette.skin),
    hair:  pick(Palette.hair),
    shirt: pick(Palette.shirt),
    pants: pick(Palette.pants),
    shoe:  pick(Palette.shoe),
    tag:   pick(Palette.tag)
  };
}

/* 全局节拍：128 BPM */
const BPM = 128;
const BEAT = 60 / BPM;          // 单拍时长（秒）≈ 0.469
const BAR  = BEAT * 4;          // 一小节

/* 常用缓动 */
const Ease = {
  outCubic: t => 1 - Math.pow(1 - t, 3),
  inCubic:  t => t * t * t,
  outBack:  t => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  outElastic: t => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  }
};

/* 确定性伪随机：同一个昵称每次上台长得一样 */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRandom(seed) {
  let s = seed || 1;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}
