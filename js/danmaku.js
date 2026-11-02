/* ============================================================
   danmaku.js — 弹幕接入层
   统一出口：hub.onMessage(msg)
   来源：模拟器 / WebSocket / postMessage / 手动输入
   接真实平台时，只要把弹幕转成 {user, text, emote} 送进来即可
   ============================================================ */

const PLATFORMS = {
  bili:   { name: 'B站',   color: '#00a1d6', short: 'B' },
  douyin: { name: '抖音',  color: '#fe2c55', short: 'D' },
  wx:     { name: '视频号', color: '#fa9d3b', short: 'V' },
  other:  { name: '直播',  color: '#a86bff', short: '·' }
};

const NICKS = [
  '深夜不睡的鱼', '爱吃辣条的猫', '一只柯基', '摸鱼冠军', '柠檬不酸',
  '打工人小陈', '会飞的猪', '快乐星球', '奶茶三分糖', '南方有鹿',
  '橘子汽水', '路过的风', '小熊软糖', '菜就多练', '晚安电台',
  '泡泡龙', '皮卡丘的尾巴', '阿珍爱上了阿强', '西瓜太郎', '风一样的男子',
  '今天也要开心', '海边的卡夫卡', '不吃香菜', '上岸的咸鱼', '熬夜冠军',
  '咕咕咕', '星星点灯', '三月小雨', '可乐加冰', '半糖去冰',
  '你猜我是谁', '路过的甲', '社恐小张', '退休程序猿', '前排出售瓜子',
  '弹幕护法', '爱笑的猫头鹰', '小镇做题家', '周末不加班', '一米八的梦'
];

const LINES = [
  '主播好帅！', '这首歌我爱了', '666', '来啦来啦', '哈哈哈哈哈',
  '这舞跳得可以啊', '前方高能', 'awsl', '爷青回', '再来一首',
  '唱得真好', '打卡', '第一次来', '关注了', '这灯光绝了',
  '氛围感拉满', '点歌《晴天》', '爱了爱了', '太好听了', '有人吗',
  '主播看我看我', '哈哈哈笑死', '这波满分', '生日快乐！',
  '点歌《起风了》', '太顶了', '循环播放', '刚进来发生了什么',
  '麦有点糊', '主播喝口水', '这节奏上头', '跳起来了',
  '后排举爪', '一起蹦', '这灯好看', '已三连', '主播加油',
  '这个beat爱了', '声音好听', '什么时候下播', '来看你啦', '沙发！'
];

const EMOTES = ['😍', '😂', '❤️', '🔥', '🎉', '👏', '😭', '🤣', '✨', '💃', '🕺', '🎵', '🥳', '👀', '💯', '🌟', '🫶', '😎', '🎊', '🙏'];
const PLAT_KEYS = ['bili', 'douyin', 'wx'];

class DanmakuHub {
  constructor() {
    this.onMessage = null;
    this.source = 'sim';
    this.rate = 0.6;          // 条/秒
    this.total = 0;
    this.ws = null;
    this.wsState = 'idle';    // idle | open | connecting | closed
    this._acc = 0;
    this._timer = null;

    window.addEventListener('message', e => this._onPost(e));
    // WS 常连：外部推送任何时候都能进舞台，不受「模拟器 / 外部接入」开关影响
    this._openWs();
  }

  /* ---------- 来源切换（只控制要不要叠加模拟弹幕） ---------- */
  setSource(src) {
    this.source = src;
    if (src === 'sim') this._startSim();
    else this._stopSim();
    this._emitState();
  }

  setRate(r) { this.rate = r; }

  /* ---------- 对外统一出口 ---------- */
  push(msg) {
    const m = this.normalize(msg);
    if (!m) return;
    // quiet 来自观众榜的「在场续命」：人上台，但不进累计计数、不弹评论
    if (!m.quiet) this.total++;
    if (this.onMessage) this.onMessage(m);
  }

  /** 把各种来源的脏数据洗成统一结构 */
  normalize(raw) {
    if (!raw) return null;
    if (typeof raw === 'string') raw = { text: raw };

    // 有些转发器会包一层 {type:'danmaku', data:{...}}
    let d = raw.data && typeof raw.data === 'object' ? raw.data : raw;

    const user = String(d.user || d.username || d.nickname || d.uname || d.name || '匿名用户').trim().slice(0, 24);
    const text = String(d.text || d.content || d.msg || d.comment || d.desc || '').trim().slice(0, 60);
    let emote = d.emote || d.emoticon || d.face || d.sticker || '';
    // 图片表情包
    const emoteUrl = d.emoteUrl || d.emote_url || d.img || '';
    // 平台
    let platform = d.platform || d.plat || 'other';
    if (!PLATFORMS[platform]) {
      const p = String(platform).toLowerCase();
      platform = /bilibili|bili/.test(p) ? 'bili'
        : /douyin|dy|tiktok/.test(p) ? 'douyin'
        : /wx|weixin|channel|shipinhao|wechat/.test(p) ? 'wx' : 'other';
    }

    // 文本里夹带 emoji 时自动提取，作为头顶表情包
    if (!emote && !emoteUrl && text) {
      const found = text.match(/(\p{Extended_Pictographic}|[\u2600-\u27BF])/gu);
      if (found) emote = found[0];
    }

    return {
      user, text, emote,
      emoteUrl: typeof emoteUrl === 'string' ? emoteUrl : '',
      platform,
      isVip: !!(d.isVip || d.vip || d.fansLevel >= 10 || d.guard),
      // 观众榜（在场续命）标记：quiet 表示只让小人站着/续命，不弹评论、不飘屏
      role: d.role || '',
      quiet: !!d.quiet,
      ts: Date.now()
    };
  }

  /* ---------- 模拟器 ---------- */
  _startSim() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this._acc += this.rate * 0.1;
      while (this._acc >= 1) {
        this._acc -= 1;
        this.push(this._fake());
      }
    }, 100);
  }

  _stopSim() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _fake() {
    const user = pick(NICKS);
    const text = pick(LINES);
    const useEmote = Math.random() < 0.45;
    return {
      user,
      text,
      emote: useEmote ? pick(EMOTES) : '',
      emoteUrl: '',
      platform: pick(PLAT_KEYS),
      isVip: Math.random() < 0.12
    };
  }

  /** 一次性来一波，测试压力用 */
  burst(n = 24) {
    for (let i = 0; i < n; i++) {
      setTimeout(() => this.push(this._fake()), i * 55);
    }
  }

  /* ---------- WebSocket ---------- */
  _openWs() {
    if (this.ws) return;
    const url = this.wsUrl || `ws://${location.hostname || '127.0.0.1'}:8787`;
    this.wsState = 'connecting';
    this._emitState();
    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      this.wsState = 'closed';
      this.ws = null;
      this._emitState();
      return;
    }
    this.ws.onopen = () => { this.wsState = 'open'; this._emitState(); };
    this.ws.onclose = () => {
      this.wsState = 'closed';
      this.ws = null;
      this._emitState();
      setTimeout(() => this._openWs(), 2500);   // 常连，断了就自动重连
    };
    this.ws.onerror = () => { try { this.ws && this.ws.close(); } catch (e) {} };
    this.ws.onmessage = e => {
      let data;
      try { data = JSON.parse(e.data); }
      catch (err) { this.push({ user: '弹幕', text: String(e.data).slice(0, 60) }); return; }

      // 同一个服务也会转发控制台↔舞台的 control / state / ping，
      // 还有带 type:'danmaku' 的手动投喂（那条由 Link 通道处理）。
      // 这些都不能当成弹幕，否则会凭空长出「匿名用户」或重复计数。
      const list = Array.isArray(data) ? data : [data];
      for (const m of list) {
        if (!m || typeof m !== 'object') continue;
        const t = m.type;
        if (t === 'control' || t === 'state' || t === 'ping' || t === 'sync' || t === 'danmaku') continue;
        if (!m.user && !m.username && !m.nickname && !m.name && !m.text && !m.content) continue;
        this.push(m);
      }
    };
  }

  _closeWs() {
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch (e) {} this.ws = null; }
  }

  /* ---------- postMessage ---------- */
  _onPost(e) {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'danmaku' || d.user || d.text) this.push(d);
  }

  /* ---------- 状态回调 ---------- */
  onStateChange(fn) { this._stateFn = fn; this._emitState(); }
  _emitState() {
    if (!this._stateFn) return;
    // 模拟模式下外部通道也常连，状态要如实反映，别让人以为推送没生效
    const st = this.source === 'sim'
      ? (this.wsState === 'open' ? 'sim+live' : 'sim')
      : this.wsState;
    this._stateFn(st);
  }
}

/** 解析手动输入：支持 "昵称: 内容" 或直接一段话 */
function parseManual(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  const m = s.match(/^([^:：]{1,20})[:：]\s*([\s\S]+)$/);
  if (m) return { user: m[1].trim(), text: m[2].trim() };
  return { user: '我', text: s };
}
