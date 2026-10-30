// 核心纯逻辑回归测试:从 userscript 里截取 API/UI 之前的部分在 vm 里跑
// 用法: node test-core.mjs
import fs from "node:fs";
import vm from "node:vm";

const FILE = "guangya-txt-cloud-add.user.js";
const src = fs.readFileSync(FILE, "utf8");
const body = src.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, "");

// 用行定位截断,不依赖换行符风格
const lines = body.split(/\r?\n/);
const marker = lines.findIndex(l => l.includes("* 文件夹列表 + 目标文件夹"));
if (marker < 0) { console.error("找不到截断点"); process.exit(1); }
// marker 是注释块的第二行,块头在它上一行
const open = marker - 1;
if (!lines[open].trim().startsWith("/*")) { console.error("截断点不是注释块开头: " + lines[open]); process.exit(1); }
const EXPORTS = "globalThis.__api = { magnetHash, isTempFailure, isQuotaExceeded, markSubmitted, flushSubmitted, isSubmitted, getTodayCount, bumpDailyCount, markFailed, getFailedMap, getDailyLimit, todayLimitReached, hasQuotaForDispatch, isRetryableHttp, todayStr };";
const core = lines.slice(0, open).join("\n") + "\n" + EXPORTS + "\n})();\n";

const store = {};
function XMLHttpRequest() {}
XMLHttpRequest.prototype.setRequestHeader = function () {};
function MutationObserver() { this.observe = () => {}; this.disconnect = () => {}; }

const ctx = {
  console, Date, Math, JSON, String, Number, Object, RegExp, Set, Map, Array, Error, Promise,
  GM_getValue: (k, d) => (k in store) ? store[k] : d,
  GM_setValue: (k, v) => { store[k] = v; },
  GM_addValueChangeListener: () => {},
  window: { fetch: function () {} },
  document: { addEventListener() {}, readyState: "loading", body: null, documentElement: null },
  location: { hostname: "x.guangyapan.com", origin: "https://x", href: "https://x" },
  crypto: { getRandomValues: () => new Uint8Array(16) },
  XMLHttpRequest, MutationObserver, Headers: function () {},
  setTimeout, clearTimeout,
};
vm.createContext(ctx);
try { vm.runInContext(core, ctx); }
catch (e) { console.error("CORE EVAL FAIL:", e.stack.split("\n").slice(0, 5).join("\n")); process.exit(1); }

const t = ctx.__api;
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? " -> " + extra : "")); }
};

console.log("[1] infohash 归一化");
ok("40hex 大小写归一", t.magnetHash("magnet:?xt=urn:btih:" + "A".repeat(40)) === t.magnetHash("magnet:?xt=urn:btih:" + "a".repeat(40)));
ok("base32 大小写归一", t.magnetHash("magnet:?xt=urn:btih:" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567") === t.magnetHash("magnet:?xt=urn:btih:" + "abcdefghijklmnopqrstuvwxyz234567"));
ok("同 infohash 不同 tr 同键",
  t.magnetHash("magnet:?xt=urn:btih:" + "a".repeat(40) + "&tr=udp://a:1") === t.magnetHash("magnet:?xt=urn:btih:" + "a".repeat(40) + "&tr=udp://b:2"));

console.log("[2] 临时失败判定(误报回归)");
ok("generate 不命中 rate", !t.isTempFailure("failed to generate token"));
ok("剩余 500 次 不命中 5xx", !t.isTempFailure("剩余 500 次"));
ok("HTTP 502 命中", t.isTempFailure("HTTP 502"));
ok("rate limit 命中", t.isTempFailure("rate limit exceeded"));
ok("HTTP 429 命中", t.isTempFailure("HTTP 429"));
ok("额度超限不算临时", !t.isTempFailure("今日次数已用完"));

console.log("[3] 额度超限判定");
ok("quota 中文命中", t.isQuotaExceeded("今日额度已满"));
ok("quota 英文命中", t.isQuotaExceeded("quota exceeded"));

console.log("[4] 行解析(从完整源码单独提取)");
{
  // 解析函数在 UI 段之前、截断点之后,单独抽出来执行
  const start = lines.findIndex(l => l.includes("function extractLineMagnets"));
  const end = lines.findIndex((l, i) => i > start && l.includes("function extractLineMagnet("));
  if (start < 0 || end < 0) { console.log("  SKIP 找不到解析函数"); }
  else {
    // 连同上方正则常量一起取
    const reStart = lines.findIndex(l => l.includes("const MAGNET_RE2"));
    const chunk = lines.slice(reStart, end).join("\n");
    const pctx = { ...ctx };
    vm.createContext(pctx);
    vm.runInContext(chunk + "\nglobalThis.__p = { extractLineMagnets };", pctx);
    const p = pctx.__p;
    ok("一行两条 magnet 不粘连",
      p.extractLineMagnets("magnet:?xt=urn:btih:" + "a".repeat(40) + " magnet:?xt=urn:btih:" + "b".repeat(40)).length === 2);
    ok("纯 40hex 转 magnet", p.extractLineMagnets("d".repeat(40))[0].startsWith("magnet:?xt=urn:btih:"));
    ok("注释行忽略", p.extractLineMagnets("# magnet:?xt=urn:btih:" + "a".repeat(40)).length === 0);
    ok("magnet 保留 tr 参数", p.extractLineMagnets("magnet:?xt=urn:btih:" + "a".repeat(40) + "&tr=udp://t:1")[0].includes("tr=udp"));
  }
}

console.log("[5] 记忆与额度");
t.markSubmitted("h1"); t.flushSubmitted();
ok("写入后可读", t.isSubmitted("h1"));
const before = t.getTodayCount(); t.bumpDailyCount();
ok("额度自增", t.getTodayCount() === before + 1, "got " + t.getTodayCount());
store["gy_daily_count"] = { [t.todayStr()]: 5 };
ok("旧结构 {count,limit} 兼容", t.getTodayCount() === 5, "got " + t.getTodayCount());

console.log("[6] 失败黑名单");
for (let i = 0; i < 300; i++) t.markFailed("k" + i, "reason");
ok("黑名单条数正确", Object.keys(t.getFailedMap()).length === 300);

console.log("[7] token 失效指纹(单独提取)");
{
  const start = lines.findIndex(l => l.includes("let _deadTokenSig"));
  const end = lines.findIndex((l, i) => i > start && l.includes("function createTraceparent"));
  if (start < 0 || end < 0) { console.log("  SKIP 找不到 token 段"); }
  else {
    const chunk = "let capturedToken = ''; const KEY_TOKEN = 'gy_token'; const gmSet = () => {};\n" + lines.slice(start, end).join("\n");
    const actx = { console, Date, String, Object, JSON, GM_getValue: () => null, GM_setValue: () => {}, isTempFailure: () => false };
    vm.createContext(actx);
    vm.runInContext(chunk + "\nglobalThis.__a = { markAuthFailed, isAuthFailed, resetAuthFailed, isDeadToken, tokenSig };", actx);
    const a = actx.__a;
    a.markAuthFailed("dead-token-abcdefghijklmnopqrstuvwxyz");
    ok("markAuthFailed 后 isAuthFailed", a.isAuthFailed());
    ok("失效 token 被指纹记录", a.isDeadToken("dead-token-abcdefghijklmnopqrstuvwxyz"));
    ok("新 token 不被误杀", !a.isDeadToken("fresh-token-abcdefghijklmnopqrstuvwxyz"));
    a.resetAuthFailed();
    ok("reset 后清除失效", !a.isAuthFailed());
    ok("reset 后清除指纹", !a.isDeadToken("dead-token-abcdefghijklmnopqrstuvwxyz"));
    ok("tokenSig 不泄露完整 token", a.tokenSig("y".repeat(200)).length < 60);
  }
}

console.log("[8] 派发额度与 HTTP 可重试判定");
ok("在途未占满可派发", t.hasQuotaForDispatch(10, 8, 1));
ok("在途占满停止", !t.hasQuotaForDispatch(10, 8, 2));
ok("已用满停止", !t.hasQuotaForDispatch(10, 10, 0));
ok("已超额停止", !t.hasQuotaForDispatch(10, 12, 0));
ok("5xx 可重试", t.isRetryableHttp(502));
ok("429 可重试", t.isRetryableHttp(429));
ok("401 不进 HTTP 重试层", !t.isRetryableHttp(401));
ok("400 不可重试", !t.isRetryableHttp(400));

console.log("[9] httpError 认证标记(单独提取)");
{
  const start = lines.findIndex(l => l.includes("function httpError"));
  const end = lines.findIndex((l, i) => i > start && l.includes("function apiPost"));
  if (start < 0 || end < 0) { console.log("  SKIP 找不到 httpError 段"); }
  else {
    const chunk = lines.slice(start, end).join("\n");
    const hctx = { Error, String, Object, isTempFailure: () => false, isQuotaExceeded: () => false };
    vm.createContext(hctx);
    vm.runInContext(chunk + "\nglobalThis.__h = { httpError };", hctx);
    const h = hctx.__h;
    ok("401 标记 isAuth", h.httpError({ status: 401 }, { code: 401 }).isAuth === true);
    ok("业务码 117 标记 isAuth", h.httpError({ status: 200 }, { code: 117 }).isAuth === true);
    ok("500 标记 isTemp", h.httpError({ status: 500 }, { code: 500 }).isTemp === true);
    ok("429 标记 isRateLimited", h.httpError({ status: 429 }, { code: 429 }).isRateLimited === true);
    ok("普通业务错误不标记 isAuth", h.httpError({ status: 200 }, { code: 1, msg: "无效磁力" }).isAuth !== true);
  }
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
