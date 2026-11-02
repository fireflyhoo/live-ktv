// ==UserScript==
// @name         直播间弹幕转发器 → 弹幕蹦迪舞台
// @namespace    danmaku-disco
// @version      0.1
// @description  抓取网页直播间的弹幕，转发到本地舞台服务
// @match        *://live.douyin.com/*
// @match        *://*.weixin.qq.com/*
// @match        *://channels.weixin.qq.com/*
// @grant        none
// ==/UserScript==

/* ============================================================
   用法：
   1. 先起本地服务： node server/bridge.js
   2. 打开你自己的直播间，脚本会开始抓
   3. 控制台上把弹幕来源切到「外部接入」（关掉模拟弹幕，只看真实弹幕）

   如果你的采集器已经产出整包快照 {type:'video_channel_live', comments, viewers}，
   不用逐条发，直接 POST 到 http://127.0.0.1:8787/video-channel-live，
   服务端会拆包、跨批次去重、同名合并。本脚本仍走单条 /danmaku，两条路互不冲突。

   平台的页面结构会变，下面 SELECTORS 需要按你看到的实际 DOM 调。
   调的方法：F12 找到一条弹幕的元素，看它的 class / 结构，把选择器填进来。
   ============================================================ */

(function () {
  'use strict';

  const CONFIG = {
    endpoint: 'http://127.0.0.1:8787/danmaku',
    // 自动判断，也可以手动写死 'douyin' / 'wx'
    platform: location.hostname.includes('douyin') ? 'douyin'
            : (location.hostname.includes('weixin') || location.hostname.includes('channels')) ? 'wx'
            : 'other',
    dedupeWindow: 3000,   // 同一个 (昵称+内容) 在这个毫秒数内只发一次
    debug: true
  };

  /* ---------- 需要按实际页面调整的部分 ---------- */
  const SELECTORS = {
    // 一条弹幕的容器。给多个候选，命中哪个用哪个
    item: [
      '[class*="comment-item"]',
      '[class*="danmu-item"]',
      '[class*="chat-item"]',
      '[class*="webcast-chat"]',
      '[class*="message-item"]'
    ],
    // 容器内部：昵称和文本。留空表示取容器的 innerText 兜底
    user: [
      '[class*="user-name"]',
      '[class*="nickname"]',
      '[class*="user-info"] [class*="name"]'
    ],
    text: [
      '[class*="content"]',
      '[class*="text"]',
      '[class*="message"]'
    ],
    emote: [
      'img[class*="emoticon"]',
      'img[class*="emoji"]',
      'img[class*="face"]'
    ]
  };

  const sent = new Set();
  let posted = 0;

  function log(...a) {
    if (CONFIG.debug) console.log('%c[grab]', 'color:#35e8ff', ...a);
  }

  function first(el, selectors) {
    for (const sel of selectors) {
      const hit = el.querySelector(sel);
      if (hit) return hit;
    }
    return null;
  }

  function matchesAny(el, selectors) {
    return selectors.some(sel => {
      try { return el.matches(sel); } catch (e) { return false; }
    });
  }

  function extract(el) {
    let user = '', text = '', emoteUrl = '';

    const uEl = first(el, SELECTORS.user);
    if (uEl) user = (uEl.innerText || '').trim().replace(/[：:]\s*$/, '');

    const tEl = first(el, SELECTORS.text);
    if (tEl) text = (tEl.innerText || '').trim();

    // 兜底：拿不到结构化字段就按「昵称：内容」拆一行文本
    if (!user || !text) {
      const raw = (el.innerText || '').trim();
      if (!raw) return null;
      const m = raw.match(/^([^:：\n]{1,20})[:：]\s*([\s\S]+)$/);
      if (m) { user = user || m[1].trim(); text = text || m[2].trim(); }
      else text = text || raw;
    }

    const eEl = first(el, SELECTORS.emote);
    if (eEl && eEl.src) emoteUrl = eEl.src;

    if (!user && !text) return null;
    return {
      user: (user || '匿名用户').slice(0, 24),
      text: text.slice(0, 60),
      emoteUrl,
      platform: CONFIG.platform
    };
  }

  function post(msg) {
    const key = msg.user + '|' + msg.text;
    if (sent.has(key)) return;

    fetch(CONFIG.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg)
    })
      .then(() => { sent.add(key); posted++; })
      .catch(e => log('发送失败：', e));

    // 去重记录定期清理，避免内存无限涨
    setTimeout(() => sent.delete(key), CONFIG.dedupeWindow);
  }

  function handleNode(node) {
    if (node.nodeType !== 1) return;
    let hit = null;
    if (matchesAny(node, SELECTORS.item)) hit = node;
    else hit = SELECTORS.item.map(s => node.querySelector(s)).find(x => x);
    if (!hit) return;

    const msg = extract(hit);
    if (msg) { post(msg); log('→', msg.user, msg.text.slice(0, 20)); }
  }

  const observer = new MutationObserver(muts => {
    for (const m of muts) {
      for (const node of m.addedNodes) handleNode(node);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  console.log(
    `%c[弹幕转发器] 已启动，目标 ${CONFIG.endpoint}，platform=${CONFIG.platform}`,
    'color:#b6ff3c;font-weight:bold'
  );
  console.log('[弹幕转发器] 没有弹幕进来？多半是 SELECTORS 没命中，打开 F12 看 [grab] 日志。');
})();
