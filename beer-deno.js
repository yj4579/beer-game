// 啤酒游戏 · Deno Deploy 版（Deno KV 原子状态，单文件）
const WEEKS = 1;
const ROLE_INFO = [
  { key: "retail",   name: "零售商", color: "#4fc3f7", cap: 13 },
  { key: "distr",    name: "分销商", color: "#ffd54f", cap: 13 },
  { key: "factory",  name: "制造商", color: "#ff8a65", cap: 13 },
  { key: "supplier", name: "供应商", color: "#aed581", cap: 13 }
];

function defaultGame() {
  const pool = {};
  ROLE_INFO.forEach(r => pool[r.key] = r.cap);
  return {
    phase: "lobby", week: 1, stage: 0, demand: null,
    subs: {}, stageAvgs: [null, null, null, null],
    history: [], pool, students: {}, nextId: 1
  };
}

function stageRoleCount(G) {
  let n = 0;
  for (const t in G.students) if (G.students[t].role === G.stage) n++;
  return Math.max(1, n);   // 按实际该角色人数等待；无人时由老师强制推进
}
function stageSubCount(G) {
  let n = 0;
  for (const t in G.subs) {
    const st = G.students[t];
    if (st && st.role === G.stage) n++;
  }
  return n;
}
function stageAvg(G) {
  let sum = 0, n = 0;
  for (const t in G.subs) {
    const st = G.students[t];
    if (st && st.role === G.stage) { sum += G.subs[t]; n++; }
  }
  return n ? Math.round((sum / n) * 10) / 10 : 0;
}
function finishStage(G) {
  G.stageAvgs[G.stage] = stageAvg(G);
  if (G.stage < 3) { G.stage++; G.subs = {}; }
  else {
    G.history.push({ demand: G.demand, avgs: G.stageAvgs.slice() });
    if (G.week >= WEEKS) G.phase = "done";
    else { G.week++; G.stage = 0; G.demand = null; G.subs = {}; G.stageAvgs = [null, null, null, null]; }
  }
}

const kv = await Deno.openKv();

// 读取当前状态
async function loadGame() {
  const r = await kv.get(["game"]);
  return r.value ?? defaultGame();
}

// 原子变更：CAS 重试，保证 52 人并发提交不丢数据
async function mutate(fn) {
  for (let i = 0; i < 30; i++) {
    const cur = await kv.get(["game"]);
    const G = cur.value ?? defaultGame();
    const changed = fn(G);
    if (!changed) return;
    const res = await kv.atomic()
      .check({ key: ["game"], versionstamp: cur.versionstamp })
      .set(["game"], G)
      .commit();
    if (res.ok) return;
  }
  throw new Error("并发冲突，请重试");
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
function html(body, status) {
  return new Response(body, { status: status || 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function handleApi(request) {
  const url = new URL(request.url);
  const p = url.pathname;

  if (p === "/join" || p.startsWith("/join/")) {
    let out = null;
    await mutate(G => {
      // 总人数上限 52
      if (Object.keys(G.students).length >= 52) { out = { full: true }; return true; }
      let role = -1;
      const want = url.pathname.split("/")[2];
      if (want) {
        role = ROLE_INFO.findIndex(r => r.key === want);
      }
      if (role < 0) {
        // 随机分配：优先从还未满 13 人的角色里随机挑；都满则给人最少的角色
        const counts = {};
        ROLE_INFO.forEach(r => counts[r.key] = 0);
        for (const t in G.students) counts[ROLE_INFO[G.students[t].role].key]++;
        const notFull = ROLE_INFO.map((r, i) => i).filter(i => counts[ROLE_INFO[i].key] < ROLE_INFO[i].cap);
        if (notFull.length) role = notFull[Math.floor(Math.random() * notFull.length)];
        else {
          let min = Infinity;
          ROLE_INFO.forEach((r, i) => { if (counts[ROLE_INFO[i].key] < min) { min = counts[ROLE_INFO[i].key]; role = i; } });
        }
      }
      const key = ROLE_INFO[role].key;
      G.pool[key]--;
      const token = "stu" + (G.nextId++);
      G.students[token] = { role: role, name: ROLE_INFO[role].name + (ROLE_INFO[role].cap - G.pool[key]) };
      out = { token };
      return true;
    });
    if (out.full) return html(FULL_PAGE);
    return new Response(null, { status: 302, headers: { "Location": "/s/" + out.token } });
  }

  if (p === "/api/state") {
    const token = url.searchParams.get("token");
    const G = await loadGame();
    const base = {
      phase: G.phase, week: G.week, weeks: WEEKS, stage: G.stage,
      pool: G.pool, students: Object.keys(G.students).length,
      avgs: G.stageAvgs, hist: G.history
    };
    if (!token) {
      if (G.phase === "week" && G.demand != null) {
        base.demand = G.demand;
        base.total = stageRoleCount(G);
        base.subCount = stageSubCount(G);
      }
      return json(base);
    }
    const st = G.students[token];
    if (!st) return json({ error: "full" });
    base.role = st.role;
    if (G.phase === "week") {
      base.total = stageRoleCount(G);
      base.subCount = stageSubCount(G);
      base.submitted = token in G.subs;
      base.myOrder = G.subs[token];
      if (G.stage === st.role && G.demand != null) {
        base.demand = G.stage === 0 ? G.demand : G.stageAvgs[G.stage - 1];
      }
    }
    return json(base);
  }

  if (p === "/api/order" && request.method === "POST") {
    const o = await request.json().catch(() => null);
    if (!o) return json({ error: "请求错误" }, 400);
    let err = null;
    await mutate(G => {
      const st = G.students[o.token];
      if (!st) { err = { msg: "学生不存在", code: 404 }; return true; }
      if (G.phase !== "week") { err = { msg: "游戏未在进行中", code: 400 }; return true; }
      if (st.role !== G.stage) { err = { msg: "还没轮到你的角色", code: 400 }; return true; }
      if (o.token in G.subs) { err = { msg: "已提交过", code: 400 }; return true; }
      if (G.demand == null) { err = { msg: "老师还没公布需求", code: 400 }; return true; }
      G.subs[o.token] = o.value;
      if (stageSubCount(G) >= stageRoleCount(G)) finishStage(G);
      return true;
    });
    if (err) return json({ error: err.msg }, err.code);
    return json({});
  }

  if (p === "/api/teacher" && request.method === "POST") {
    const o = await request.json().catch(() => null);
    if (!o) return json({ error: "请求错误" }, 400);
    await mutate(G => {
      if (o.action === "start" && G.phase === "lobby") G.phase = "week";
      else if (o.action === "demand" && G.phase === "week" && G.demand == null) G.demand = Math.max(0, o.value | 0);
      else if (o.action === "force" && G.phase === "week" && G.demand != null) finishStage(G);
      else if (o.action === "finishweek" && G.phase === "week" && G.demand != null) {
        let guard = 0;
        while (G.phase === "week" && G.demand != null && G.stageAvgs[3] == null && guard++ < 10) finishStage(G);
      } else if (o.action === "restart") {
        const fresh = defaultGame();
        Object.keys(fresh).forEach(k => G[k] = fresh[k]);
        G.nextId = 1;
      }
      return true;
    });
    return json({});
  }

  return json({ error: "Not Found" }, 404);
}

Deno.serve((request) => {
  const p = new URL(request.url).pathname;
  if (p === "/teacher") return html(TEACHER_PAGE);
  if (p.startsWith("/s/")) return html(STUDENT_PAGE);
  if (p === "/join" || p.startsWith("/join/") || p.startsWith("/api/")) return handleApi(request);
  return html("<div style='background:#0f1b2d;min-height:100vh;padding-top:60px;text-align:center;font-family:sans-serif;'><h1 style='color:#eaf2fb;'>🍺 啤酒游戏</h1><p style='color:#8fa8c4;margin-top:12px;'><a style='color:#4fc3f7;' href='/teacher'>老师控制台</a> ｜ <a style='color:#4fc3f7;' href='/join'>学生入口</a></p></div>");
});

const COMMON_STYLE = `
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:#0f1b2d;color:#eaf2fb;font-family:"Microsoft YaHei","PingFang SC",sans-serif;padding:16px;min-height:100vh;}
  .wrap{max-width:1000px;margin:0 auto;}
  h1{font-size:22px;text-align:center;margin-bottom:6px;}
  .sub{text-align:center;color:#8fa8c4;font-size:13px;margin-bottom:14px;}
  .panel{background:#16283f;border:1px solid #2c4568;border-radius:12px;padding:16px;margin-bottom:14px;}
  button{cursor:pointer;border:none;border-radius:8px;padding:12px 26px;font-size:17px;font-weight:bold;color:#102030;background:#ffd54f;transition:filter .15s, transform .1s;}
  button:hover{filter:brightness(1.1);} button:active{transform:scale(.96);}
  button.ghost{background:#1d3350;color:#eaf2fb;border:1px solid #2c4568;font-size:14px;padding:8px 16px;}
  button:disabled{opacity:.4;cursor:not-allowed;}
  input[type=number]{width:110px;padding:10px;font-size:20px;text-align:center;border-radius:8px;border:1px solid #2c4568;background:#1d3350;color:#eaf2fb;}
  .big{font-size:34px;font-weight:bold;}
  .tag{display:inline-block;padding:4px 14px;border-radius:20px;font-size:15px;font-weight:bold;}
  .hint{background:rgba(255,213,79,.1);border:1px dashed #ffd54f;border-radius:10px;padding:12px;font-size:15px;line-height:1.8;margin:12px 0;}
  .demand{background:rgba(240,98,146,.12);border:1px dashed #f06292;border-radius:10px;padding:12px;text-align:center;font-size:15px;margin-bottom:12px;}
  .demand b{color:#f06292;font-size:30px;}
  .stat{color:#8fa8c4;font-size:13px;text-align:center;margin-top:8px;}
  .qb{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin:14px 0;}
  .legend{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;margin-bottom:8px;font-size:13px;}
  .legend .dot{width:12px;height:12px;border-radius:3px;display:inline-block;}
  canvas{width:100%;background:#1d3350;border-radius:8px;}
  table{width:100%;border-collapse:collapse;font-size:13px;}
  th,td{border:1px solid #2c4568;padding:6px;text-align:center;}
  th{background:#1d3350;color:#8fa8c4;font-weight:normal;}
  .center{text-align:center;}
  .warn{color:#ef5350;font-weight:bold;}
  .joinbtn{display:inline-block;padding:14px 26px;border-radius:12px;font-size:18px;font-weight:bold;color:#102030;text-decoration:none;transition:filter .15s, transform .1s;}
  .joinbtn:hover{filter:brightness(1.12);} .joinbtn:active{transform:scale(.96);}
  .joinfull{opacity:.35;pointer-events:none;text-decoration:line-through;}
`;

const CHART_JS = `
function drawChart(cv, hist){
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  ctx.clearRect(0,0,W,H);
  const padL=46, padR=16, padT=20, padB=30;
  const n = hist.length;
  if (n < 1) return;
  if (n === 1){
    const cols = ["#f06292","#4fc3f7","#ffd54f","#ff8a65","#aed581"];
    const labels = ["顾客需求","零售商平均订货","分销商平均订货","制造商平均订料","供应商平均备货"];
    const vals = [hist[0].demand].concat(hist[0].avgs);
    let maxV = Math.max(4, ...vals.map(v => Math.max(v, 1)));
    const step = maxV > 60 ? Math.ceil(maxV/5/10)*10 : Math.max(2, Math.ceil(maxV/5));
    maxV = Math.ceil((maxV+step)/step)*step;
    const y = v => padT + (H-padT-padB)*(1 - v/maxV);
    const bw = (W-padL-padR)/5;
    ctx.strokeStyle="#2c4568"; ctx.fillStyle="#8fa8c4"; ctx.font="11px sans-serif"; ctx.lineWidth=1;
    for (let v=0; v<=maxV; v+=step){
      ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(W-padR, y(v)); ctx.stroke();
      ctx.fillText(v, 12, y(v)+4);
    }
    vals.forEach((v, i) => {
      const bx = padL + bw*i + bw*0.18, w2 = bw*0.64;
      const by = y(Math.max(0, v));
      ctx.fillStyle = cols[i];
      ctx.fillRect(bx, by, w2, H-padB-by);
      ctx.fillStyle = "#eaf2fb"; ctx.font="bold 16px sans-serif";
      ctx.fillText(v, bx + w2/2 - 8, by - 6);
      ctx.fillStyle = "#8fa8c4"; ctx.font="11px sans-serif";
      ctx.fillText(labels[i].slice(0,4), bx + w2/2 - 18, H-12);
    });
    return;
  }
  let maxV = 8;
  hist.forEach(h => { maxV = Math.max(maxV, h.demand, ...h.avgs); });
  const step = maxV > 60 ? Math.ceil(maxV/6/10)*10 : 4;
  maxV = Math.ceil((maxV+step)/step)*step;
  const x = i => padL + i*(W-padL-padR)/Math.max(1, n-1);
  const y = v => padT + (H-padT-padB)*(1 - v/maxV);
  ctx.strokeStyle="#2c4568"; ctx.fillStyle="#8fa8c4"; ctx.font="11px sans-serif"; ctx.lineWidth=1;
  for (let v=0; v<=maxV; v+=step){
    ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(W-padR, y(v)); ctx.stroke();
    ctx.fillText(v, 12, y(v)+4);
  }
  for (let i=0; i<n; i++) ctx.fillText(i+1, x(i)-4, H-10);
  const series = [{color:"#f06292", vals: hist.map(h=>h.demand)}];
  const cols = ["#4fc3f7","#ffd54f","#ff8a65","#aed581"];
  for (let s=0; s<4; s++) series.push({color:cols[s], vals: hist.map(h=>h.avgs[s])});
  series.forEach(s=>{
    ctx.strokeStyle=s.color; ctx.lineWidth=2.5; ctx.beginPath();
    s.vals.forEach((v,i)=>{ if(v==null) return; if(i===0||s.vals[i-1]==null) ctx.moveTo(x(i),y(v)); else ctx.lineTo(x(i),y(v)); });
    ctx.stroke();
    s.vals.forEach((v,i)=>{ if(v==null) return; ctx.beginPath(); ctx.arc(x(i),y(v),3.5,0,Math.PI*2); ctx.fillStyle=s.color; ctx.fill(); });
  });
}`;

const STUDENT_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>啤酒游戏 · 学生端</title><style>` + COMMON_STYLE + `</style></head><body>
<div class="wrap">
  <h1>🍺 啤酒游戏</h1>
  <div id="content"><p class="sub">连接中…</p></div>
</div>
<script>
const TOKEN = location.pathname.split("/")[2];
const ROLE_NAMES = ["零售商","分销商","制造商","供应商"];
const ROLE_COLORS = ["#4fc3f7","#ffd54f","#ff8a65","#aed581"];
let lastSig = null;
` + CHART_JS + `
async function poll(){
  try{
    const r = await fetch("/api/state?token=" + TOKEN);
    const s = await r.json();
    render(s);
  }catch(e){}
}
function render(s){
  const sig = [s.phase, s.week, s.stage, s.demand, s.subCount, s.submitted, s.role].join("|");
  if (sig === lastSig) return;
  lastSig = sig;
  const c = document.getElementById("content");
  if (s.error === "full"){ c.innerHTML = '<div class="panel center"><h1>😅 名额已满</h1><p class="sub">每个角色只有 13 个名额，请联系老师。</p></div>'; return; }
  if (s.phase === "lobby"){
    c.innerHTML = '<div class="panel center"><h1>⏳ 等待老师开始游戏…</h1><p style="margin:12px 0;">你被分配到的角色：</p><span class="tag" style="background:'+ROLE_COLORS[s.role]+';color:#102030;font-size:22px;padding:8px 24px;">'+ROLE_NAMES[s.role]+'</span><p class="sub" style="margin-top:12px;">规则：你只能看到下游的需求，决定向上游订多少。<br>运输途中可能损坏 1~2 箱，可以多订一点点做缓冲。</p></div>';
    return;
  }
  const rc = ROLE_COLORS[s.role];
  let html = '<div class="panel">' +
    '<div class="rolecard" style="display:flex;align-items:center;gap:16px;justify-content:center;"><span class="tag" style="background:'+rc+';color:#102030;">你的角色：' + ROLE_NAMES[s.role] + '</span>' +
    '<span class="sub" style="margin:0;">第 ' + s.week + ' / ' + s.weeks + ' 周</span></div>';
  if (s.phase === "done"){
    html += '<div class="demand" style="margin-top:12px;">🏁 游戏结束！老师正在公布牛鞭效应结果</div></div>';
    if (s.hist && s.hist.length){
      html += '<div class="panel"><div class="legend">' +
        '<span><i class="dot" style="background:#f06292"></i>顾客需求</span>' +
        '<span><i class="dot" style="background:#4fc3f7"></i>零售商平均订货</span>' +
        '<span><i class="dot" style="background:#ffd54f"></i>分销商平均订货</span>' +
        '<span><i class="dot" style="background:#ff8a65"></i>制造商平均订料</span>' +
        '<span><i class="dot" style="background:#aed581"></i>供应商备货</span></div>' +
        '<canvas id="cv" width="960" height="300"></canvas></div>';
    }
    c.innerHTML = html;
    const cv = document.getElementById("cv");
    if (cv) drawChart(cv, s.hist);
    return;
  }
  const myStage = s.role;
  if (s.stage !== myStage){
    html += '<div class="hint" style="margin-top:14px;">⏳ 请稍等，还没轮到你的环节…<br>正在决策：' + ROLE_NAMES[s.stage] + '组（已提交 ' + s.subCount + '/' + s.total + ' 人）</div></div>';
    c.innerHTML = html;
    return;
  }
  if (s.demand == null){
    html += '<div class="hint" style="margin-top:14px;">⏳ 等待老师公布本周需求…</div></div>';
    c.innerHTML = html;
    return;
  }
  if (s.submitted){
    html += '<div class="hint" style="margin-top:14px;">✔ 你已提交下单 <b>' + s.myOrder + '</b> 箱。<br>等待其他 ' + ROLE_NAMES[s.role] + '组同学提交…（' + s.subCount + '/' + s.total + '）</div></div>';
    c.innerHTML = html;
    return;
  }
  html += '<div class="demand" style="margin-top:14px;">你的下游（' + (s.role===0 ? "顾客" : ROLE_NAMES[s.role-1] + "组平均") + '）本周要买：<br><b>' + s.demand + '</b> 箱</div>';
  html += '<div class="hint">💡 提示：运输途中可能损坏 1~2 箱啤酒，请确定向上游（' + ROLE_NAMES[Math.min(3, s.role+1)] + '）的订货量。</div>';
  html += '<div class="qb" id="qb"></div>';
  html += '<div class="center"><span>或手动输入：</span><input type="number" id="oi" min="0" value="' + s.demand + '"> 箱 <button id="ok">✔ 确认下单</button></div>';
  html += '</div>';
  c.innerHTML = html;
  const qb = document.getElementById("qb");
  const d = s.demand;
  [...new Set([d, d+1, d+2, d*2])].forEach(v => {
    const b = document.createElement("button");
    b.textContent = v + " 箱";
    b.addEventListener("click", () => submit(v));
    qb.appendChild(b);
  });
  document.getElementById("ok").addEventListener("click", () => {
    const v = parseInt(document.getElementById("oi").value, 10);
    if (isNaN(v) || v < 0 || v > 200){ alert("请输入 0~200 之间的数量"); return; }
    submit(v);
  });
}
async function submit(v){
  const r = await fetch("/api/order", {method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({token: TOKEN, value: v})});
  if (r.ok) poll(); else alert((await r.json()).error || "提交失败");
}
poll();
setInterval(poll, 2500);
</script></body></html>`;

const FULL_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>名额已满</title></head>
<body style="background:#0f1b2d;color:#eaf2fb;font-family:sans-serif;text-align:center;padding-top:80px;">
<h1>😅 角色名额已满</h1><p style="color:#8fa8c4;">零售商/分销商/制造商/供应商各 13 人已分配完毕，请联系老师。</p></body></html>`;

const TEACHER_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>啤酒游戏 · 主持人（顾客）</title><style>` + COMMON_STYLE + `</style></head><body>
<div class="wrap">
  <h1>🍺 啤酒游戏 · 主持人控制台</h1>
  <p class="sub">你是<b style="color:#f06292;">顾客</b>：公布本周需求，然后四级学生依次决策，全部提交后自动出结果。</p>

  <div class="panel center" id="p-lobby">
    <h2>准备开始</h2>
    <p class="sub" style="margin:10px 0;">把下面的入口发给学生（手机/电脑浏览器直接打开）：</p>
    <div id="join-links" style="display:flex; gap:12px; flex-wrap:wrap; justify-content:center; margin:12px 0;">
      <a id="join-url" class="joinbtn" style="background:#eaf2fb;">🎲 随机分配</a>
      <a id="join-retail" class="joinbtn" style="background:#4fc3f7;">🟦 我是零售商</a>
      <a id="join-distr" class="joinbtn" style="background:#ffd54f;">🟨 我是分销商</a>
      <a id="join-factory" class="joinbtn" style="background:#ff8a65;">🟧 我是制造商</a>
      <a id="join-supplier" class="joinbtn" style="background:#aed581;">🟩 我是供应商</a>
    </div>
    <p class="stat">点击按钮即可进入对应角色 · 名额：零售 <span id="cnt-retail">13</span> · 分销 <span id="cnt-distr">13</span> · 制造 <span id="cnt-factory">13</span> · 供应 <span id="cnt-supplier">13</span> / 13</p>
    <p class="stat" id="pool-stat"></p>
    <button id="btn-start">▶ 开始游戏</button>
  </div>

  <div class="panel center hide" id="p-game">
    <div style="font-size:18px; margin-bottom:10px;" id="week-label"></div>
    <div class="demand">顾客（你）本周要买：<b id="t-demand">?</b> 箱</div>
    <div id="t-controls"></div>
    <div class="stat" id="t-progress"></div>
    <div style="margin-top:12px;">
      <button class="ghost" id="btn-force">⏭ 强行汇总本级</button>
      <button class="ghost" id="btn-finish">⏩ 一键完成本周剩余环节</button>
      <button class="ghost" id="btn-restart">🔄 重开一局</button>
    </div>
  </div>

  <div class="panel hide" id="p-chart">
    <div class="legend">
      <span><i class="dot" style="background:#f06292"></i>顾客需求</span>
      <span><i class="dot" style="background:#4fc3f7"></i>零售商平均订货</span>
      <span><i class="dot" style="background:#ffd54f"></i>分销商平均订货</span>
      <span><i class="dot" style="background:#ff8a65"></i>制造商平均订料</span>
      <span><i class="dot" style="background:#aed581"></i>供应商平均备货</span>
    </div>
    <canvas id="cv" width="960" height="320"></canvas>
    <div class="panel" id="lesson" style="margin-top:14px; text-align:left;"></div>
  </div>
</div>
<script>
` + CHART_JS + `
function $(id){ return document.getElementById(id); }
let lastSig = null;
async function api(body){
  const r = await fetch("/api/teacher", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body || {})});
  return r.json();
}
async function poll(){ try{ render(await (await fetch("/api/state")).json()); }catch(e){} }
function render(s){
  const sig = [s.phase, s.week, s.stage, s.demand, (s.avgs||[]).join(","), s.subCount].join("|");
  if (sig === lastSig){ $("pool-stat").textContent = "已加入学生：" + s.students + " / 52"; return; }
  lastSig = sig;
  $("pool-stat").textContent = "已加入学生：" + s.students + " / 52";
  if (s.phase === "lobby"){
    $("p-game").classList.add("hide"); $("p-lobby").classList.remove("hide");
    const base = location.origin;
    $("join-url").textContent = base + "/join";
    $("join-url").href = base + "/join";
    ["retail","distr","factory","supplier"].forEach(k => {
      const a = $("join-" + k);
      a.href = base + "/join/" + k;
      $("cnt-" + k).textContent = s.pool[k];
      if (s.pool[k] <= 0) a.classList.add("joinfull");
    });
    return;
  }
  $("p-lobby").classList.add("hide"); $("p-game").classList.remove("hide");
  $("week-label").textContent = s.phase === "done" ? "🏁 本周结束——看下方牛鞭效应对比图" : "当前环节：" + ["零售商","分销商","制造商","供应商"][s.stage] + "组决策";
  if (s.phase === "done"){
    $("t-demand").textContent = "—";
    $("t-controls").innerHTML = '<div class="hint center">🎉 本轮结束！下方就是你的牛鞭效应效果图。</div>';
    $("btn-force").classList.add("hide");
    $("btn-finish").classList.add("hide");
    $("p-chart").classList.remove("hide");
    drawChart($("cv"), s.hist);
    const h = s.hist[0];
    const d = h.demand;
    const maxA = Math.max.apply(null, h.avgs);
    const names = ["零售商","分销商","制造商","供应商"];
    let chain = "顾客 " + d + " 箱";
    names.forEach((n, i) => { chain += " → " + n + " 平均 " + h.avgs[i] + " 箱"; });
    const ratio = maxA / Math.max(1, d);
    $("lesson").innerHTML = ratio > 1.5
      ? '<b>🔍 讲解要点：</b>' + chain + '。<br>顾客只要 <b>' + d + ' 箱</b>，到最上游却备了 <b class="warn">' + maxA + ' 箱</b>——需求被放大了 <b class="warn">' + Math.round(ratio * 10) / 10 + ' 倍</b>！这就是<b class="warn">牛鞭效应</b>。<br>原因：①对缺货的恐慌 ②"运输损坏 1~2 箱"的层层加码 ③每级只看到上一级、看不到真实需求 ④决策层层传导。<br>应对：信息共享、缩短提前期、VMI 供应商管理库存。'
      : '<b>🔍 讲解要点：</b>' + chain + '。<br>本轮放大不明显（最大 ' + maxA + ' 箱，' + Math.round(ratio * 10) / 10 + ' 倍）。可再来一轮：故意制造"可能缺货"的紧张感，让学生翻倍下单，牛鞭效应立刻出现。';
    return;
  }
  $("btn-force").classList.remove("hide");
  $("btn-finish").classList.remove("hide");
  $("btn-force").disabled = (s.demand == null);
  $("btn-finish").disabled = (s.demand == null || s.avgs[3] != null);
  $("t-demand").textContent = s.demand == null ? "?" : s.demand;
  if (s.demand == null){
    $("t-controls").innerHTML = '<span>公布本周需求：</span><input type="number" id="ti" value="4" min="0" style="width:90px;"> 箱 <button id="tok">公布，开始本轮决策</button>' +
      '<div class="stat">提示：你就是市场！公布一个需求量（例如 4 箱），看看传到最上游会变成多少</div>';
    $("tok").addEventListener("click", () => {
      const v = parseInt($("ti").value, 10);
      if (isNaN(v) || v < 0) { alert("请输入有效数量"); return; }
      api({action:"demand", value:v});
    });
    $("t-progress").textContent = "";
  } else {
    const names = ["零售商","分销商","制造商","供应商"];
    let av = "";
    names.forEach((n,i)=>{ av += n + " " + (s.avgs[i]==null ? "…" : "平均 " + s.avgs[i] + " 箱") + "　"; });
    $("t-controls").innerHTML = '<div style="font-size:16px;">本轮进展：' + av + '</div>';
    $("t-progress").textContent = names[s.stage] + "组已提交 " + s.subCount + " / " + s.total + " 人";
    if (s.avgs[3] != null){
      $("t-progress").textContent += "　✔ 本周完成，等待公布下一周需求";
    }
  }
}
$("btn-start").addEventListener("click", () => api({action:"start"}));
$("btn-force").addEventListener("click", () => api({action:"force"}));
$("btn-finish").addEventListener("click", () => api({action:"finishweek"}));
$("btn-restart").addEventListener("click", () => { if (confirm("确定重开一局？所有数据清零。")) api({action:"restart"}); });
poll(); setInterval(poll, 2000);
</script></body></html>`;


