/* ============================================================
   link.js — 舞台页与控制台页之间的通道
   同机同源走 BroadcastChannel（零延迟、不需要服务）
   同时挂一条 WebSocket，跨设备 / 跨浏览器窗口也能控制
   ============================================================ */

const CHANNEL = 'danmaku-disco';

const Link = {
  role: 'stage',
  ch: null,
  ws: null,
  handlers: [],
  preview: false,
  wsUrl: null,

  join(role, opts) {
    opts = opts || {};
    this.role = role;
    this.preview = !!opts.preview;

    if (this.ch) { try { this.ch.close(); } catch (e) {} this.ch = null; }
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.ch = new BroadcastChannel(CHANNEL);
        this.ch.onmessage = e => this._recv(e.data);
      } catch (e) { this.ch = null; }
    }

    // 服务端兜底通道：没连上也无所谓，只是不能跨设备控制
    const url = opts.wsUrl || `ws://${location.hostname || '127.0.0.1'}:8787`;
    this.wsUrl = url;
    try {
      this.ws = new WebSocket(url);
      this.ws.onmessage = e => {
        try { this._recv(JSON.parse(e.data)); } catch (err) {}
      };
      this.ws.onclose = () => {
        this.ws = null;
        setTimeout(() => this.join(role, opts), 3000);   // 服务没开就一直重试，反正有 BroadcastChannel 兜底
      };
      this.ws.onerror = () => {};
    } catch (e) { this.ws = null; }

    return this;
  },

  on(fn) { this.handlers.push(fn); return this; },

  _recv(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.from === this.role) return;          // 不收自己发的
    if (msg.to && msg.to !== this.role) return;  // 定向消息
    for (const fn of this.handlers) fn(msg);
  },

  post(msg) {
    msg.from = this.role;
    msg.preview = this.preview;
    msg.ts = Date.now();

    // 广播通道优先：同机同源零延迟
    let viaBC = false;
    if (this.ch) {
      try { this.ch.postMessage(msg); viaBC = true; } catch (e) {}
    }
    // WS 走服务端中转（跨设备用）。指令和弹幕只发一条通道，
    // 否则舞台会通过 BC 和 WS 各收到一次，被执行两遍。
    // 状态广播是覆盖式更新，重复一次无所谓，所以两条都发。
    if ((!viaBC || msg.type === 'state') && this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(msg)); } catch (e) {}
    }
  }
};
