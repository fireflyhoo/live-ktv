# live-ktv 项目长期笔记

## 这是什么
「弹幕蹦迪舞台 · Danmaku Disco」——直播弹幕驱动的像素风可视化舞台。一条评论 = 一个上台蹦迪的小人，头顶顶昵称，带表情包就在头顶弹出来。

## 怎么跑
```bash
node server/bridge.js     # 或 npm start
# 打开 http://127.0.0.1:8787/
```
OBS 用：`http://127.0.0.1:8787/?mode=transparent&panel=0`（竖屏加 `&ratio=vertical`）

## 架构要点（改代码前先看这里）
- 弹幕统一结构：`{user, text, emote, emoteUrl, platform, isVip}`。不管从 HTTP / WS / postMessage 哪条路进来，都在 `js/danmaku.js` 的 `normalize()` 里洗干净。**新接平台时只需要把数据转成这个结构 POST 到 8787，不要改舞台代码。**
- 入口三个：`POST /danmaku`（单条或数组）、`POST /video-channel-live`（视频号整包 `{type,comments,viewers}`，服务端拆包+两级去重+同批同名去重，支持跨域）、`ws://:8787`。整包推到 /danmaku 也能识别。
- **舞台的 DanmakuHub WS 是常连的**（构造时即连），外部推送任何时刻都生效，与「模拟器/外部接入」开关无关；开关只控制要不要叠加模拟弹幕。WS onmessage 必须过滤 `control/state/ping/sync/danmaku`，否则心跳会长出「匿名用户」。
- **上台节拍器用 setInterval（70ms 放 2 个），别用 rAF** —— rAF 在后台标签页/OBS 会被节流，弹幕是数据不是动画。`spawnQueue` 上限 200。
- **同名只留一个**：spawn 用 byName + dancers.find 双兜底；退场清理时只在 `byName.get(d.user)===d` 时删索引（防竞态误删同名新人）。人多了 `retireRandom()` 随机退场（不是按年龄）。
- **保底 10 人**：`MIN_LIVE`（js/app.js），主循环每帧算 `holding = activeCount() <= min(10, maxDancers)` 写进 `d.hold`；`Dancer.update()` 到点若 hold 则顺延寿命 6~16s（不是原地卡住），人数够了才错开陆续走。随机退人也受这个下限保护。
- **观众榜（viewers）走「续命」通道，不是普通弹幕**：服务端 `viewerLast` 12 秒节流，消息带 `quiet:true`；舞台收到只在同名小人上 `refresh()`，**不弹气泡、不进飘屏、不 hype**。别把它并回 `isDuplicate` —— 那个 10 分钟长窗口会让观众上台一次后再也不回来。
- 终端日志：`server/bridge.js` 的 `logPush()` 每次整包推送打印一块（逐条标 `✓上台/·同批重名/·已推过`，观众榜 `+` 表示续命），`fit()` 按显示宽度对齐中文。
- 渲染分两层：**低分辨率 canvas 画像素世界 + 高清 DOM 覆盖层画文字**。别把中文挪进 canvas，会糊。
- 舞台规格两套：`SCENE_PRESETS`（js/dancer.js）—— wide 640×360 / vertical 180×320，两种场景高度都约等于 360。所有绘制都从 `SCENE` 读尺寸，`Stage._layout()` 集中算布景布局；加新规格只需加一项 preset + 在 _layout 里补分支。
- 舞台是全画面页（不带 UI），控制台是 console.html（带预览 + 控件），两者靠 js/link.js 的 BroadcastChannel + WS 通信；**指令只走一条通道**，否则会被执行两遍。
- 节拍常量 `BPM = 128` 在 `js/palette.js`，改这里全场跟着变。
- 小人的长相由昵称哈希决定（`seededRandom(hashStr(user))`），保证老观众回来还是那个人 —— 别改成纯随机。

## 用户偏好（本项目）
- 中文沟通，喜欢结构化输出
- 先看效果再接真实数据源：所以模拟器是默认入口
- 合规提示要写进文档（只用在自己的直播间）

## 环境备忘
- 本机 headless 截图用 `/Applications/Google Chrome for Testing.app/.../Google Chrome for Testing` + `--no-sandbox --disable-gpu --use-gl=swiftshader`
- `--dump-dom` 不驱动 rAF，验证只能靠 `--screenshot`
- **`--virtual-time-budget` 下虚拟时钟跑得比真实网络快**：fetch/POST 响应常在截图之后才落地，`--dump-dom` 取的是早期快照，console.log 探针过早采样会得到空结果。要验网络链路：① 用 Node 手写 WS 客户端探针（最可靠）② 或页面里用 setTimeout 给 WS 留连上的时间 ③ 只信最终 `--screenshot`
- `node server/bridge.js &` 起的进程会被 Bash 工具回收，必须用 run_in_background 启动
