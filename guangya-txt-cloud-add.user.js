// ==UserScript==
// @name        光鸭网盘 - txt 磁力链接批量云添加
// @namespace   winter-maple
// @version      1.3.0
// @description 选择本地 txt 文件,自动提取里面的磁力链接/种子URL,批量云添加到光鸭网盘。基于光鸭官方 API cloudcollection/v1。v1.3: 拦截器改到 document-start 立即挂载;token 每请求现取,支持轮换与失效后等待重捕;5xx/429 真正进入重试;同 infohash 去重;失败黑名单批量淘汰;跨标签页记忆同步。
// @author      winter-maple
// @match       *://*.guangyapan.com/*
// @run-at      document-start
// @noframes
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_addValueChangeListener
// @grant       GM_xmlhttpRequest
// @connect     api.guangyapan.com
// @updateURL   https://raw.githubusercontent.com/winter-maple/guangya-magnet-txt-cloud/main/guangya-txt-cloud-add.user.js
// @downloadURL https://raw.githubusercontent.com/winter-maple/guangya-magnet-txt-cloud/main/guangya-txt-cloud-add.user.js
// @license     MIT
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
     * 光鸭官方 API(从官方客户端逆向确认,2026-08)
     * ============================================================ */
    const API_BASE = "https://api.guangyapan.com";
    const URL_RESOLVE  = API_BASE + "/cloudcollection/v1/resolve_res";   // 解析磁力链 → 返回任务信息
    const URL_CREATE   = API_BASE + "/cloudcollection/v1/create_task";   // 创建云下载任务
    const URL_TASKS    = API_BASE + "/cloudcollection/v1/list_task";     // 任务列表(可选)
    const URL_FILE_LIST = API_BASE + "/userres/v1/file/get_file_list";   // 文件/文件夹列表
    const URL_SEARCH = API_BASE + "/userres/v1/file/search_files";       // 全局搜索(文件夹)

    const KEY_TOKEN = "gy_token";

    // 单次请求超时:没有它时挂起的请求会让 worker 永久 await,整批卡死
    const REQUEST_TIMEOUT_MS = 15000;
    const SUBMIT_INTERVAL_MS = 400;

    // 记忆存储 key
    const KEY_SUBMITTED_MAP = "gy_submitted_map";   // hash -> timestamp(已成功提交的磁力链)
    const KEY_DAILY = "gy_daily_count";             // { "YYYY-MM-DD": {count, limit} }
    const KEY_TOTAL = "gy_total_submitted";         // 历史累计提交数
    const KEY_TARGET_FOLDER = "gy_target_folder";   // {fileId, name} 目标文件夹
    const KEY_FAILED_MAP = "gy_failed_map";         // {hash: {reason, ts}} 永久失败黑名单

    // 每日限额(光鸭每天最多提交次数,可在 UI 修改;默认 1000)
    const KEY_LIMIT = "gy_daily_limit";
    function getDailyLimit() {
        try {
            const v = Number(GM_getValue(KEY_LIMIT, 1000));
            return (v > 0 && v <= 100000) ? v : 1000;
        } catch (e) { return 1000; }
    }
    function setDailyLimit(n) {
        try { GM_setValue(KEY_LIMIT, n); } catch (e) { /* ignore */ }
    }

    /* ============================================================
     * 记忆系统 — 已提交磁力链记忆 + 每日限额
     * ============================================================ */
    function todayStr() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
    }

    // 从磁力链提取稳定哈希(info_hash),用于去重记忆
    // hex 统一小写、base32 统一大写,保证同一 hash 的不同写法命中同一条记忆
    function magnetHash(magnet) {
        const s = String(magnet || "");
        const m1 = s.match(/urn:btih:([0-9a-fA-F]{32,40})/i);
        if (m1) {
            const h = m1[1];
            return h.length === 32 ? h.toUpperCase() : h.toLowerCase();
        }
        const m2 = s.match(/\b([0-9a-fA-F]{40})\b/);
        if (m2) return m2[1].toLowerCase();
        const m3 = s.match(/\b([A-Z2-7]{32})\b/i);
        if (m3) return m3[1].toUpperCase();
        // .torrent URL 用 URL 本身
        if (/^https?:\/\//i.test(s)) return "url:" + s;
        return "raw:" + s;
    }

    // 已提交记忆 — 内存缓存 + 批量落盘
    // 脚本启动时读一次进内存,之后全操作内存,flush 才写 GM 存储。
    // 避免每次 isSubmitted 都反序列化整个大 map(几万条会卡)。
    let _memMap = null;      // 内存中的 submitted map 缓存
    let _memDirty = false;
    let _memTimer = null;

    // 存储层:优先用 GM_setValue,部分管理器(脚本猫)对超大对象有坑,
    // 序列化失败时退化成字符串存,读取侧两者都兼容
    function gmGet(key, dflt) {
        try {
            const v = GM_getValue(key, dflt);
            return v === undefined ? dflt : v;
        } catch (e) { return dflt; }
    }
    function gmSet(key, val) {
        try { GM_setValue(key, val); return true; }
        catch (e) {
            try { GM_setValue(key, JSON.stringify(val)); return true; }
            catch (e2) { return false; }
        }
    }
    // 统一解析:值可能是对象,也可能是被降级存成 JSON 的字符串
    function asObject(v) {
        if (v && typeof v === "object") return v;
        if (typeof v === "string") {
            try { const o = JSON.parse(v); return (o && typeof o === "object") ? o : null; }
            catch (e) { return null; }
        }
        return null;
    }

    function loadMemMap() {
        if (_memMap) return _memMap;
        _memMap = asObject(gmGet(KEY_SUBMITTED_MAP, null)) || {};
        return _memMap;
    }
    function getSubmittedMap() {
        return loadMemMap();   // 返回内存缓存,不重复读存储
    }
    function isSubmitted(hash) {
        const m = loadMemMap();
        return Object.prototype.hasOwnProperty.call(m, hash);
    }
    function flushSubmitted() {
        if (!_memDirty || !_memMap) return;
        _memDirty = false;
        _memTimer = null;
        gmSet(KEY_SUBMITTED_MAP, _memMap);
    }
    function markSubmitted(hash) {
        const m = loadMemMap();
        m[hash] = Date.now();
        _memDirty = true;
        if (_memTimer) clearTimeout(_memTimer);
        _memTimer = setTimeout(flushSubmitted, 3000);   // 3 秒攒一批,写一次
    }

    // 每日限额
    // 计数单独存,避免和 limit 字段一起做 read-modify-write 时互相覆盖
    function getDaily() {
        return asObject(gmGet(KEY_DAILY, null)) || {};
    }
    function getTodayCount() {
        const d = getDaily();
        const t = d[todayStr()];
        if (t && typeof t === "object") return Number(t.count) || 0;   // 兼容旧结构 {count,limit}
        return Number(t) || 0;
    }
    function todayLimitReached() {
        return getTodayCount() >= getDailyLimit();
    }
    // 跨标签页同步:别的标签页提交成功后,本页额度不应再按旧值派发
    let _dailyEpoch = 0;
    function bumpDailyCount() {
        const d = getDaily();
        const t = d[todayStr()];
        const prev = (t && typeof t === "object") ? (Number(t.count) || 0) : (Number(t) || 0);
        d[todayStr()] = prev + 1;
        gmSet(KEY_DAILY, d);
        _dailyEpoch++;
    }
    function getTotalSubmitted() {
        return Number(gmGet(KEY_TOTAL, 0)) || 0;
    }
    function bumpTotal() {
        gmSet(KEY_TOTAL, getTotalSubmitted() + 1);
    }
    function clearAllMemory() {
        if (_memTimer) clearTimeout(_memTimer);
        _memTimer = null;
        _memDirty = false;
        _memMap = {};
        if (_failTimer) clearTimeout(_failTimer);
        _failTimer = null;
        _failDirty = false;
        _failMap = {};
        // 内存里的鉴权状态也要清,否则界面显示已清空但请求仍用旧 token
        capturedToken = "";
        capturedAuth = { did: "", smid: "" };
        _authFailed = false;
        gmSet(KEY_SUBMITTED_MAP, {});
        gmSet(KEY_DAILY, {});
        gmSet(KEY_TOTAL, 0);
        gmSet(KEY_TOKEN, null);
        gmSet(KEY_FAILED_MAP, {});
    }

    /* ============================================================
     * 失败黑名单 — 永久失败的磁力链下次不再上传
     * ============================================================ */
    // 临时失败特征(网络/超时/限频/5xx):不记黑名单,下次可重试
    // 注意 \brate\b 会命中 "generate"/"regenerate",裸 5\d\d 会命中"剩余 500 次",
    // 都加了边界约束;真正的 HTTP 状态码由 apiPost 直接标成 _httpStatus,不靠文案匹配
    const TEMP_FAIL_RE = /网络|timeout|超时|\b429\b|限频|速率|rate.?limit|too many|timed out|ETIMEDOUT|ECONN|socket|proxy|连接|中断|暂时|稍后|太频繁|频繁|请求过多|服务繁忙|服务异常|系统繁忙|稍后再试|HTTP 5\d\d|状态码 5\d\d/i;
    // 今日额度超限(服务端硬限额,应立即停止)
    const QUOTA_FAIL_RE = /超限|次数已用|次数不足|次数用完|额度|quota|每日|自然日|明天|已达上限|达到上限|上限已满/i;

    function isTempFailure(msg) {
        const s = String(msg || "");
        if (isQuotaExceeded(s)) return false;   // 额度类优先,避免被 rate/limit 误判成临时失败
        return TEMP_FAIL_RE.test(s);
    }
    function isQuotaExceeded(msg) {
        return QUOTA_FAIL_RE.test(String(msg || ""));
    }
    // 失败 map 内存缓存 + 批量写(避免每次 markFailed 都序列化整个 map)
    let _failMap = null;
    let _failDirty = false;
    let _failTimer = null;
    const FAIL_MAP_MAX = 50000;   // 黑名单上限,超出淘汰最旧条目,防止 GM 存储无限膨胀
    let _failOverflowAt = 0;      // 上次淘汰时间:淘汰是 O(n log n),不能每条失败都做
    function loadFailMap() {
        if (_failMap) return _failMap;
        _failMap = asObject(gmGet(KEY_FAILED_MAP, null)) || {};
        return _failMap;
    }
    function getFailedMap() {
        return loadFailMap();   // 内存缓存,不重复读存储
    }
    function isFailed(hash) {
        const m = loadFailMap();
        return Object.prototype.hasOwnProperty.call(m, hash);
    }
    function flushFailedMap() {
        if (!_failDirty || !_failMap) return;
        _failDirty = false;
        _failTimer = null;
        gmSet(KEY_FAILED_MAP, _failMap);
    }
    // 超出上限时批量淘汰 10%,而不是每次删一个:全量 sort 是 O(n log n),
    // 连续失败时每条都排序会直接把主线程拖死
    function trimFailMap(m) {
        const keys = Object.keys(m);
        if (keys.length <= FAIL_MAP_MAX) return;
        const now = Date.now();
        if (now - _failOverflowAt < 60000) return;   // 一分钟内最多整理一次
        _failOverflowAt = now;
        const target = Math.floor(FAIL_MAP_MAX * 0.9);
        keys.sort((a, b) => ((m[a] && m[a].ts) || 0) - ((m[b] && m[b].ts) || 0));
        for (let i = 0; i < keys.length - target; i++) delete m[keys[i]];
    }
    function markFailed(hash, reason) {
        const m = loadFailMap();
        m[hash] = { reason: String(reason || "").slice(0, 200), ts: Date.now() };
        trimFailMap(m);
        _failDirty = true;
        if (_failTimer) clearTimeout(_failTimer);
        _failTimer = setTimeout(flushFailedMap, 3000);   // 3 秒攒一批,写一次
    }

    /* ============================================================
     * 记忆导出/导入 — 删脚本前导出,重装后导入,防数据丢失
     * ============================================================ */
    function exportMemory() {
        const data = {
            version: 1,
            exportedAt: Date.now(),
            submitted: loadMemMap(),
            failed: getFailedMap(),
            daily: getDaily(),
            total: getTotalSubmitted(),
            targetFolder: getTargetFolder(),
        };
        const json = JSON.stringify(data);
        // 下载成 JSON 文件
        const blob = new Blob([json], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "guangya-memory-backup-" + todayStr() + ".json";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 500);
        return Object.keys(data.submitted).length;
    }

    function importMemory(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const data = JSON.parse(reader.result);
                    if (!data || typeof data !== "object") throw new Error("无效备份文件");
                    if (data.submitted && typeof data.submitted === "object") {
                        _memMap = data.submitted;
                        _memDirty = true;
                        flushSubmitted();   // 立即写入
                    }
                    if (data.failed && typeof data.failed === "object") {
                        // 必须同步内存缓存,否则本次会话里 isFailed() 仍读旧 map
                        _failMap = data.failed;
                        _failDirty = true;
                        flushFailedMap();
                    }
                    if (data.daily && typeof data.daily === "object") {
                        gmSet(KEY_DAILY, data.daily);
                        _dailyEpoch++;
                    }
                    if (typeof data.total === "number") {
                        gmSet(KEY_TOTAL, data.total);
                    }
                    if (data.targetFolder && data.targetFolder.fileId) {
                        setTargetFolder(data.targetFolder);
                    }
                    resolve(Object.keys(data.submitted || {}).length);
                } catch (e) {
                    reject(e);
                }
            };
            reader.onerror = () => reject(new Error("读取文件失败"));
            reader.readAsText(file);
        });
    }

    /* ============================================================
     * 文件夹列表 + 目标文件夹
     * ============================================================ */
    function getTargetFolder() {
        try { return GM_getValue(KEY_TARGET_FOLDER, null) || null; }
        catch (e) { return null; }
    }
    function setTargetFolder(f) {
        try { GM_setValue(KEY_TARGET_FOLDER, f); } catch (e) { /* ignore */ }
    }

    // 列出某个文件夹下的一级文件夹(不递归,轻量)
    // 分页拉取:pageSize 是服务端上限,超出会漏,这里循环到空页或满 MAX_FOLDER_PAGES
    const MAX_FOLDER_PAGES = 20;
    async function listFoldersUnder(token, parentId) {
        const out = [];
        const seen = new Set();
        for (let page = 0; page < MAX_FOLDER_PAGES; page++) {
            const r = await apiPost(URL_FILE_LIST, {
                parentId: parentId || "",
                page: page,
                pageSize: 500,
                orderBy: 0,
                sortType: 0,
                resType: 2,   // 只列目录
            }, token);
            if (r.status !== 200) throw new Error("HTTP " + r.status);
            const body = r.body;
            if (body && body.code !== 0 && body.code != null) {
                throw new Error((body.msg || body.message) || "code " + body.code);
            }
            let data = body;
            if (body && typeof body === "object" && body.data && typeof body.data === "object") data = body.data;
            const items = (data && (data.list || data.files || data.items || data.records)) || [];
            let added = 0;
            for (const it of items) {
                if (!it || !(it.resType === 2 || it.dir === true || it.isDir === true)) continue;
                const fileId = String(it.fileId || it.id || it.file_id || "");
                const name = String(it.fileName || it.name || it.title || "");
                if (!fileId || !name || seen.has(fileId)) continue;
                seen.add(fileId);
                out.push({ fileId, name });
                added++;
            }
            const total = Number(data && (data.total || data.totalCount));
            if (items.length === 0 || added === 0) break;
            if (Number.isFinite(total) && out.length >= total) break;
        }
        return out;
    }

    // 全局搜索文件夹(官方 search_files,只搜文件夹 resType:2)
    async function searchFolders(token, keyword, pageSize) {
        const out = [];
        const seen = new Set();
        for (let page = 0; page < MAX_FOLDER_PAGES; page++) {
            const r = await apiPost(URL_SEARCH, {
                name: keyword,       // 官方字段名是 name,不是 keyword
                page: page,
                pageSize: pageSize || 100,
                orderBy: 0,
                sortType: 0,
                resType: 2,          // 只搜文件夹
            }, token);
            if (r.status !== 200) throw new Error("HTTP " + r.status);
            const body = r.body;
            if (body && body.code !== 0 && body.code != null) {
                throw new Error((body.msg || body.message) || "code " + body.code);
            }
            let data = body;
            if (body && typeof body === "object" && body.data && typeof body.data === "object") data = body.data;
            const items = (data && (data.list || data.files || data.items || data.records)) || [];
            let added = 0;
            // 解析:每项可能直接有 fileId/fileName,或包在 fileInfo 里;fullParentIds 可拼路径
            for (const it of items) {
                const fi = (it && it.fileInfo) || it || {};
                const fileId = String(fi.fileId || it.fileId || it.id || "");
                const name = String(fi.fileName || fi.name || it.fileName || it.name || "");
                if (!fileId || !name || seen.has(fileId)) continue;
                seen.add(fileId);
                out.push({ fileId, name });
                added++;
            }
            const total = Number(data && (data.total || data.totalCount));
            if (items.length === 0 || added === 0) break;
            if (Number.isFinite(total) && out.length >= total) break;
        }
        return out;
    }

    /* ============================================================
     * Token 多策略提取
     * 1. cookie
     * 2. localStorage 深度扫描(JSON 结构)
     * 3. 请求头拦截(最可靠:网页版自己用的鉴权)
     * ============================================================ */

    // 策略3:拦截真实请求,从 Authorization 头抓 token
    let capturedToken = "";
    let capturedHeaders = [];
    let captureStarted = false;

    function startCapture() {
        if (captureStarted) return;
        captureStarted = true;

        // 拦截 XHR setRequestHeader — 记录所有发往 api.guangyapan.com 的请求头
        // 用 defineProperty 抢在页面自己的 polyfill 之前拿到原型方法引用
        const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
            try {
                captureHeader(name, value);
                // 记录所有自定义头(含非 Authorization 的鉴权头)
                if (!/^(content-type|accept|referer|origin|user-agent|accept-encoding|accept-language|cookie|sec-|:)/i.test(name)) {
                    const h = capturedHeaders;
                    const line = name + ": " + String(value || "").slice(0, 120);
                    if (h.length < 40 && h.indexOf(line) === -1) h.push(line);
                }
            } catch (e) { /* ignore */ }
            return origSetHeader.apply(this, arguments);
        };

        // 拦截 fetch
        const origFetch = window.fetch;
        window.fetch = function (input, init) {
            try {
                const h = init && init.headers;
                if (h) {
                    if (h instanceof Headers) {
                        const a = h.get("authorization");
                        if (a) captureHeader("authorization", a);
                        const did = h.get("did");
                        if (did) captureHeader("did", did);
                        const smid = h.get("smid");
                        if (smid) captureHeader("smid", smid);
                    } else if (typeof h === "object") {
                        const a = h["authorization"] || h["Authorization"];
                        if (a) captureHeader("authorization", a);
                        if (h["did"]) captureHeader("did", h["did"]);
                        if (h["smid"]) captureHeader("smid", h["smid"]);
                    }
                }
                // Request 对象形式的 fetch(new Request(url, {headers}))
                if (input && typeof input === "object" && input.headers && input.headers.get) {
                    const a = input.headers.get("authorization");
                    if (a) captureHeader("authorization", a);
                    const did = input.headers.get("did");
                    if (did) captureHeader("did", did);
                    const smid = input.headers.get("smid");
                    if (smid) captureHeader("smid", smid);
                }
            } catch (e) { /* ignore */ }
            return origFetch.apply(this, arguments);
        };

        // 拦截 axios 风格:部分版本网页用 XHR 但在 open 里直接塞 headers 对象,已由 setRequestHeader 覆盖
        console.log("[gy-txt] 已开启请求头 token 捕获");
    }

    function extractTokenFromCookie() {
        const c = document.cookie || "";
        if (!c) return "";
        // 常见 token cookie 名
        const names = ["access_token", "token", "Authorization", "auth", "auth_token", "user_token", "gy_token", "session"];
        for (const n of names) {
            const m = c.match(new RegExp("(?:^|;\\s*)" + n + "=([^;]+)"));
            if (m && m[1]) return decodeURIComponent(m[1].trim());
        }
        // 兜底:任何含 token 的 cookie 值
        const m = c.match(/[^;=]*token[^;=]*=([^;]+)/i);
        if (m && m[1]) return decodeURIComponent(m[1].trim());
        return "";
    }

    function deepExtract(obj, depth, seen) {
        if (depth > 4 || obj == null) return "";
        if (typeof obj === "string") {
            if (obj.length > 20 && obj.length < 500) {
                // 裸 token 形态
                if (/^[A-Za-z0-9._~-]{30,}$/.test(obj) && looksLikeAuthToken(obj)) return obj;
            }
            return "";
        }
        if (typeof obj !== "object") return "";
        if (seen.has(obj)) return "";
        seen.add(obj);
        for (const k of Object.keys(obj)) {
            const v = obj[k];
            // key 含 token/auth/session/key 只是线索,值还必须通过 token 形态校验,
            // 否则 tokenExpire 之类的时间戳会被当成 token
            if (/token|auth|session|key/i.test(k) && typeof v === "string" && v.length > 20 && looksLikeAuthToken(v)) {
                return v;
            }
            const r = deepExtract(v, depth + 1, seen);
            if (r) return r;
        }
        return "";
    }

    // token 是否已标记过期(等待重新捕获)
    let _authFailed = false;

    // 读取存储的完整 token 信息 {token, did, smid, ts}
    function getStoredAuth() {
        try {
            const v = GM_getValue(KEY_TOKEN, null);
            if (!v) return null;
            if (typeof v === "string") return { token: v, did: "", smid: "", ts: 0 };  // 兼容旧格式
            return v;
        } catch (e) { return null; }
    }
    function setStoredAuth(auth) {
        try { GM_setValue(KEY_TOKEN, auth); } catch (e) { /* ignore */ }
    }

    function getAccessToken() {
        // 0. 请求头拦截到的(最新)
        if (capturedToken) return capturedToken;
        // 1. 存储的(优先)
        const stored = getStoredAuth();
        if (stored && stored.token && !_authFailed) return stored.token;
        // 2. cookie
        let t = extractTokenFromCookie();
        if (t && !_authFailed) return t;
        // 3. localStorage 深度扫描
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                const v = localStorage.getItem(k);
                if (!v || v.length < 20) continue;
                try {
                    const parsed = JSON.parse(v);
                    const r = deepExtract(parsed, 0, new Set());
                    if (r) return r;
                } catch { /* not json */ }
                const m = v.match(/["']?(?:access_token|token|Authorization)["']?\s*[:=]\s*["']?([A-Za-z0-9._-]{30,})["']?/i);
                if (m) {
                    const cand = m[1];
                    // 排除 deviceid 等非 token 长串(deviceid 以 wdi10. 开头,不是 JWT)
                    if (!/^wdi\d+\./i.test(cand) && looksLikeAuthToken(cand)) return cand;
                }
                const raw = v.trim();
                // 裸 token:必须是 JWT 形态(含 2 个点)或明显 token 特征,排除 deviceid
                if (/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+$/.test(raw)) return raw;
            }
        } catch (e) { /* ignore */ }
        return "";
    }
    // 判断是否像认证 token(JWT 两段点,或长度>60 的非 deviceid)
    function looksLikeAuthToken(s) {
        if (/^wdi\d+\./i.test(s)) return false;
        if (/\./.test(s) && s.length > 50) return true;   // JWT 形态
        return s.length > 80;   // 长串(非 deviceid 短格式)
    }

    // 保存 token(带时间戳 + 相关头)
    // 手动设置 / 重新捕获的 token 视为新凭据,必须清掉 _authFailed,否则 getAccessToken 会跳过它
    let _lastPersistTs = 0;
    const PERSIST_DEBOUNCE_MS = 1500;
    function setToken(t, did, smid) {
        const stored = getStoredAuth() || {};
        const auth = {
            token: t || stored.token || "",
            did: did || capturedAuth.did || stored.did || "",
            smid: smid || capturedAuth.smid || stored.smid || "",
            ts: Date.now(),
        };
        // 网页版每发一个请求都会带 Authorization,不去重的话每个请求都写一次 GM 存储
        if (stored.token === auth.token && stored.did === auth.did && stored.smid === auth.smid
            && Date.now() - _lastPersistTs < 60000) {
            return;
        }
        _lastPersistTs = Date.now();
        setStoredAuth(auth);
        if (auth.token) {
            capturedToken = auth.token;
            resetAuthFailed();
        }
    }

    // 标记认证失败(401/117) → 清 token,等重新捕获
    // 注意:不清 capturedToken。页面自己拿同一枚死 token 重发请求时,若 captureHeader 又把它塞回来,
    // 会形成 "失效 → 重捕 → 再失效" 死循环。这里记录失效指纹,同一枚 token 不再被重新采纳
    let _deadTokenSig = "";
    function tokenSig(t) {
        // 只留首尾,避免把完整凭据写进日志/存储
        const s = String(t || "");
        return s.length <= 24 ? s : (s.slice(0, 12) + "…" + s.slice(-8) + ":" + s.length);
    }
    function markAuthFailed() {
        _authFailed = true;
        if (capturedToken) _deadTokenSig = tokenSig(capturedToken);
        gmSet(KEY_TOKEN, null);
        capturedToken = "";
        console.log("[gy-txt] token 失效,等待重新捕获(刷新页面或重新触发页面请求)");
    }
    function isAuthFailed() { return _authFailed; }
    function resetAuthFailed() { _authFailed = false; _deadTokenSig = ""; }
    function isDeadToken(t) {
        return !!_deadTokenSig && tokenSig(t) === _deadTokenSig;
    }

    function createTraceparent() {
        const hex = (len) => {
            const u = new Uint8Array(len);
            crypto.getRandomValues(u);
            return [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
        };
        return `00-${hex(16)}-${hex(8)}-01`;
    }

    /* ============================================================
     * API 调用
     * ============================================================ */
    // 捕获的请求头(鉴权相关)
    let capturedAuth = { did: "", smid: "" };

    function captureHeader(name, value) {
        const v = String(value || "");
        if (/^did$/i.test(name)) {
            if (capturedAuth.did === v.trim()) return;
            capturedAuth.did = v.trim();
            // 有 token 时连 did/smid 一起存
            if (capturedToken) setToken(capturedToken, capturedAuth.did, capturedAuth.smid);
        }
        else if (/^smid$/i.test(name)) {
            if (capturedAuth.smid === v.trim()) return;
            capturedAuth.smid = v.trim();
            if (capturedToken) setToken(capturedToken, capturedAuth.did, capturedAuth.smid);
        }
        else if (/^authorization$/i.test(name)) {
            const t = /^Bearer\s+/i.test(v) ? v.replace(/^Bearer\s+/i, "").trim() : v.trim();
            if (!t) return;
            // 同一枚已判定失效的 token 被页面重发时忽略,避免死循环重捕
            if (isDeadToken(t)) return;
            if (capturedToken === t) return;   // 没变化,不重复写存储
            capturedToken = t;
            resetAuthFailed();   // 新 token 有效
            setToken(t, capturedAuth.did, capturedAuth.smid);
        }
    }

    // 业务错误带上 HTTP 状态码,让 withRetry 能识别 5xx / 429(原来 apiPost 永不 reject,重试形同虚设)
    function httpError(r, body) {
        const msg = (body && typeof body === "object" && (body.msg || body.message))
            ? (body.msg || body.message)
            : ("HTTP " + r.status);
        const err = new Error(msg);
        err.httpStatus = r.status;
        err.businessCode = body && typeof body === "object" ? body.code : null;
        err.isHttp5xx = r.status >= 500;
        err.isRateLimited = r.status === 429;
        err.isTemp = err.isHttp5xx || err.isRateLimited || isTempFailure(msg);
        return err;
    }

    function apiPost(url, data, token) {
        return new Promise((resolve, reject) => {
            const headers = {
                "Content-Type": "application/json;charset=utf-8",
                "Authorization": "Bearer " + token,
                "dt": "4",
                "traceparent": createTraceparent(),
                "Origin": location.origin,
                "Referer": location.href,
            };
            if (capturedAuth.did) headers["did"] = capturedAuth.did;
            if (capturedAuth.smid) headers["smid"] = capturedAuth.smid;
            GM_xmlhttpRequest({
                method: "POST",
                url,
                headers,
                data: JSON.stringify(data),
                timeout: REQUEST_TIMEOUT_MS,
                onload: (r) => {
                    let body;
                    try { body = JSON.parse(r.responseText); }
                    catch { body = r.responseText; }
                    // 认证失效检测:HTTP 401 或业务码 117(无效token)
                    const code = body && typeof body === "object" ? body.code : null;
                    if (r.status === 401 || code === 117) {
                        markAuthFailed();
                        console.log("[gy-txt] 检测到认证失效(status=" + r.status + " code=" + code + "),已清 token 等待重新捕获");
                    }
                    resolve({ status: r.status, body });
                },
                // 超时必须显式处理:GM_xmlhttpRequest 没有 timeout 时请求可能永久挂起,worker 会卡死
                ontimeout: () => {
                    const e = new Error("timeout: 请求超时(" + (REQUEST_TIMEOUT_MS / 1000) + "s)");
                    e.isTemp = true;
                    reject(e);
                },
                onerror: (e) => {
                    const err = new Error("网络错误: " + ((e && e.error) || "unknown"));
                    err.isTemp = true;
                    reject(err);
                },
            });
        });
    }

    async function resolveUrl(url, token) {
        const r = await apiPost(URL_RESOLVE, { url }, token);
        return r;
    }

    async function createTask(url, token, opts) {
        const payload = {
            url: url,
            parentId: (opts && opts.parentId) || "",
        };
        if (opts && opts.fileIndexes && opts.fileIndexes.length) payload.fileIndexes = opts.fileIndexes;
        if (opts && opts.newName) payload.newName = opts.newName;
        const r = await apiPost(URL_CREATE, payload, token);
        return r;
    }

    /* ============================================================
     * 从 txt 提取磁力链接
     * ============================================================ */
    // 非全局、无状态正则(避免 /g lastIndex 问题 + 灾难性回溯)
    // base32 用 i 标志:BTIH 的 base32 形式常见小写,magnet 行不能漏
    // 前后用 [^\s"'<>]* 吃掉 dn/tr 等参数,整条链原样提交
    // 参数用非贪婪 + 前瞻锚定 btih,避免一行里两条 magnet 被吞成一条
    const MAGNET_RE2 = /magnet:\?[^\s"'<>]*?xt=urn:btih:[0-9a-z]{32,40}[^\s"'<>]*/i;
    const HASH40_RE2 = /\b[0-9a-fA-F]{40}\b/;
    const HASH32_RE2 = /\b[A-Z2-7]{32}\b/i;
    const TORRENT_URL_RE2 = /^https?:\/\/\S+\.torrent(?:[?#]\S*)?$/i;
    // .torrent 可能出现在行中间("标题 | https://x.torrent"),单独抽出来
    const TORRENT_ANY_RE2 = /https?:\/\/[^\s"'<>]+\.torrent(?:[?#][^\s"'<>]*)?/i;
    const ED2K_RE2 = /^ed2k:\/\/\|file\|[^|]+\|/i;

    // 一行可能含多个磁力/种子(空格或标点分隔),全部提取
    function extractLineMagnets(line) {
        const s = (line || "").trim();
        if (!s || s.startsWith("#") || s.startsWith("//")) return [];
        const out = [];
        // 全链 magnet:用 matchAll 拿一行里的所有
        const mg = new RegExp(MAGNET_RE2.source, "gi");
        let m;
        while ((m = mg.exec(s)) !== null) out.push(m[0]);
        if (out.length) return out;
        // .torrent URL(整行或行内)
        if (TORRENT_URL_RE2.test(s)) return [s];
        const ta = s.match(TORRENT_ANY_RE2);
        if (ta) return [ta[0]];
        // ed2k
        if (ED2K_RE2.test(s)) return [s];
        // 纯 40 位 hex
        const h40 = s.match(HASH40_RE2);
        if (h40) return ["magnet:?xt=urn:btih:" + h40[0].toLowerCase()];
        // 纯 32 位 base32(大小写都认)
        const h32 = s.match(HASH32_RE2);
        if (h32) return ["magnet:?xt=urn:btih:" + h32[0].toUpperCase()];
        return [];
    }

    // 兼容旧调用:返回单条或 null
    function extractLineMagnet(line) {
        const r = extractLineMagnets(line);
        return r.length ? r[0] : null;
    }

    // 分片解析大文件:用 FileReader 按块读取,避免 file.text() 一次性把几百 MB 塞进内存
    const PARSE_CHUNK_BYTES = 4 * 1024 * 1024;   // 每块 4MB
    async function extractMagnetsFromFile(file, onProgress) {
        const found = new Set();
        const total = file.size || 1;
        let offset = 0;
        let tail = "";
        let linesDone = 0;
        while (offset < total) {
            const end = Math.min(offset + PARSE_CHUNK_BYTES, total);
            const chunkText = await readBlobSlice(file, offset, end);
            offset = end;
            const text = tail + chunkText;
            const lines = text.split(/\r?\n/);
            // 最后一段可能被截断,留到下一块拼接
            tail = offset < total ? (lines.pop() || "") : "";
            for (const line of lines) {
                const ms = extractLineMagnets(line);
                for (const m of ms) found.add(m);
                linesDone++;
            }
            if (onProgress) {
                try { onProgress(offset / total, linesDone); } catch (e) { /* ignore */ }
            }
            // 让出主线程,避免 UI 冻结
            await new Promise(r => setTimeout(r, 0));
        }
        if (tail) {
            for (const m of extractLineMagnets(tail)) found.add(m);
        }
        return [...found];
    }

    function readBlobSlice(blob, start, end) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(new Error("读取文件失败"));
            reader.readAsText(blob.slice(start, end));
        });
    }

    // 兼容旧调用:整段文本解析(小文件 / 控制台调试用)
    async function extractMagnetsAsync(text, onProgress) {
        const lines = text.split(/\r?\n/);
        const found = new Set();
        const CHUNK = 2000;
        for (let i = 0; i < lines.length; i += CHUNK) {
            const end = Math.min(i + CHUNK, lines.length);
            for (let j = i; j < end; j++) {
                for (const m of extractLineMagnets(lines[j])) found.add(m);
            }
            if (onProgress) {
                try { onProgress(Math.min(1, (end / lines.length)), end); } catch (e) { /* ignore */ }
            }
            await new Promise(r => setTimeout(r, 0));
        }
        return [...found];
    }

    /* ============================================================
     * UI
     * ============================================================ */
    // 文件夹名截断显示,防止长名把 select 撑得太宽
    function truncateFolder(name, maxLen) {
        const s = String(name || "");
        const max = maxLen || 40;
        return s.length > max ? s.slice(0, max) + "…" : s;
    }

    // 面板关闭后的重开入口:右下角一个小圆钮,点击重新构建面板
    function ensureLauncher() {
        if (document.getElementById("gy-txt-launcher")) return;
        const b = document.createElement("div");
        b.id = "gy-txt-launcher";
        b.textContent = "☁";
        b.title = "打开光鸭磁力批量添加面板";
        b.style.cssText = [
            "position:fixed", "right:20px", "bottom:20px", "z-index:2147483646",
            "width:44px", "height:44px", "border-radius:50%",
            "background:linear-gradient(135deg,#007AFF,#5856D6)", "color:#fff",
            "display:flex", "align-items:center", "justify-content:center",
            "font-size:20px", "cursor:pointer", "user-select:none",
            "box-shadow:0 8px 24px rgba(0,122,255,0.35)",
            "transition:transform 0.16s ease",
        ].join(";");
        b.onmouseenter = () => { b.style.transform = "scale(1.06)"; };
        b.onmouseleave = () => { b.style.transform = "scale(1)"; };
        b.onclick = () => { b.remove(); buildUI(); };
        document.body.appendChild(b);
    }

    function buildUI() {
        if (document.getElementById("gy-txt-panel")) return;

        // 注入苹果风格 CSS 样式表 (包含深色模式、毛玻璃、胶囊按钮、微交互动画)
        if (!document.getElementById("gy-txt-style")) {
            const style = document.createElement("style");
            style.id = "gy-txt-style";
            style.textContent = `
                #gy-txt-panel {
                    position: fixed;
                    right: 20px;
                    bottom: 20px;
                    z-index: 2147483646;
                    width: 420px;
                    box-sizing: border-box;
                    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", "Segoe UI", Arial, sans-serif;
                    border-radius: 18px;
                    background: rgba(255, 255, 255, 0.78);
                    -webkit-backdrop-filter: blur(25px) saturate(190%);
                    backdrop-filter: blur(25px) saturate(190%);
                    border: 1px solid rgba(255, 255, 255, 0.5);
                    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.15), 0 0 0 0.5px rgba(0, 0, 0, 0.08);
                    color: #1c1c1e;
                    overflow: hidden;
                    user-select: none;
                    transition: box-shadow 0.3s ease, border-color 0.3s ease;
                }
                @media (prefers-color-scheme: dark) {
                    #gy-txt-panel {
                        background: rgba(32, 32, 36, 0.82);
                        border: 1px solid rgba(255, 255, 255, 0.15);
                        box-shadow: 0 20px 48px rgba(0, 0, 0, 0.55), 0 0 0 0.5px rgba(255, 255, 255, 0.1);
                        color: #f2f2f7;
                    }
                }
                #gy-txt-head {
                    padding: 12px 16px;
                    background: rgba(255, 255, 255, 0.45);
                    border-bottom: 1px solid rgba(0, 0, 0, 0.06);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    cursor: move;
                    font-weight: 600;
                    font-size: 13.5px;
                    letter-spacing: -0.2px;
                }
                @media (prefers-color-scheme: dark) {
                    #gy-txt-head {
                        background: rgba(255, 255, 255, 0.05);
                        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                    }
                }
                .gy-apple-header-title {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .gy-apple-badge {
                    width: 20px;
                    height: 20px;
                    border-radius: 6px;
                    background: linear-gradient(135deg, #007AFF, #5856D6);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: #fff;
                    font-size: 11px;
                    font-weight: bold;
                    box-shadow: 0 2px 5px rgba(0, 122, 255, 0.3);
                }
                #gy-txt-close {
                    width: 22px;
                    height: 22px;
                    border-radius: 50%;
                    background: rgba(120, 120, 128, 0.16);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    font-size: 11px;
                    color: #8e8e93;
                    transition: all 0.2s ease;
                }
                #gy-txt-close:hover {
                    background: rgba(255, 59, 48, 0.2);
                    color: #ff3b30;
                }
                .gy-apple-content {
                    padding: 14px;
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    user-select: text;
                }
                .gy-apple-btn {
                    border: none;
                    border-radius: 10px;
                    padding: 7px 10px;
                    font-size: 12px;
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.16s cubic-bezier(0.4, 0, 0.2, 1);
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 4px;
                    outline: none;
                    line-height: 1.2;
                    white-space: nowrap;
                    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
                }
                .gy-apple-btn:active {
                    transform: scale(0.96);
                    opacity: 0.85;
                }
                .gy-btn-blue {
                    background: #007AFF;
                    color: #ffffff;
                    box-shadow: 0 2px 8px rgba(0, 122, 255, 0.25);
                }
                .gy-btn-blue:hover {
                    background: #0066CC;
                }
                .gy-btn-gray {
                    background: rgba(120, 120, 128, 0.12);
                    color: inherit;
                }
                .gy-btn-gray:hover {
                    background: rgba(120, 120, 128, 0.2);
                }
                @media (prefers-color-scheme: dark) {
                    .gy-btn-gray {
                        background: rgba(255, 255, 255, 0.1);
                    }
                    .gy-btn-gray:hover {
                        background: rgba(255, 255, 255, 0.18);
                    }
                }
                .gy-btn-orange {
                    background: rgba(255, 149, 0, 0.15);
                    color: #FF9500;
                }
                .gy-btn-orange:hover {
                    background: rgba(255, 149, 0, 0.25);
                }
                @media (prefers-color-scheme: dark) {
                    .gy-btn-orange {
                        color: #FF9F0A;
                    }
                }
                .gy-btn-purple {
                    background: rgba(175, 82, 222, 0.15);
                    color: #AF52DE;
                }
                .gy-btn-purple:hover {
                    background: rgba(175, 82, 222, 0.25);
                }
                @media (prefers-color-scheme: dark) {
                    .gy-btn-purple {
                        color: #BF5AF2;
                    }
                }
                .gy-btn-green {
                    background: rgba(52, 199, 89, 0.15);
                    color: #34C759;
                }
                .gy-btn-green:hover {
                    background: rgba(52, 199, 89, 0.25);
                }
                @media (prefers-color-scheme: dark) {
                    .gy-btn-green {
                        color: #30D158;
                    }
                }
                .gy-btn-red {
                    background: rgba(255, 59, 48, 0.15);
                    color: #FF3B30;
                }
                .gy-btn-red:hover {
                    background: rgba(255, 59, 48, 0.25);
                }
                @media (prefers-color-scheme: dark) {
                    .gy-btn-red {
                        color: #FF453A;
                    }
                }
                .gy-btn-main {
                    width: 100%;
                    background: linear-gradient(180deg, #007AFF 0%, #0062CC 100%);
                    color: #ffffff;
                    font-size: 13.5px;
                    font-weight: 600;
                    padding: 10px;
                    border-radius: 12px;
                    box-shadow: 0 4px 14px rgba(0, 122, 255, 0.35);
                    letter-spacing: -0.1px;
                }
                .gy-btn-main:hover {
                    background: linear-gradient(180deg, #0066CC 0%, #004F9E 100%);
                    box-shadow: 0 6px 18px rgba(0, 122, 255, 0.45);
                }
                .gy-btn-pause-style {
                    width: 100%;
                    background: #FF9500;
                    color: #ffffff;
                    font-size: 12.5px;
                    font-weight: 600;
                    padding: 8px;
                    border-radius: 12px;
                    box-shadow: 0 3px 10px rgba(255, 149, 0, 0.3);
                }
                .gy-apple-input {
                    background: rgba(255, 255, 255, 0.65);
                    border: 1px solid rgba(0, 0, 0, 0.1);
                    border-radius: 10px;
                    padding: 7px 10px;
                    font-size: 12px;
                    color: inherit;
                    outline: none;
                    transition: all 0.2s ease;
                    box-sizing: border-box;
                    font-family: inherit;
                }
                .gy-apple-input:focus {
                    border-color: #007AFF;
                    background: #ffffff;
                    box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.18);
                }
                @media (prefers-color-scheme: dark) {
                    .gy-apple-input {
                        background: rgba(0, 0, 0, 0.3);
                        border-color: rgba(255, 255, 255, 0.12);
                    }
                    .gy-apple-input:focus {
                        background: rgba(0, 0, 0, 0.5);
                        border-color: #0A84FF;
                        box-shadow: 0 0 0 3px rgba(10, 132, 255, 0.25);
                    }
                }
                .gy-apple-select {
                    appearance: none;
                    -webkit-appearance: none;
                    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%238e8e93' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E");
                    background-repeat: no-repeat;
                    background-position: right 10px center;
                    padding-right: 24px !important;
                }
                .gy-card-box {
                    background: rgba(120, 120, 128, 0.06);
                    border-radius: 12px;
                    padding: 8px 10px;
                    border: 1px solid rgba(0, 0, 0, 0.03);
                }
                @media (prefers-color-scheme: dark) {
                    .gy-card-box {
                        background: rgba(255, 255, 255, 0.04);
                        border-color: rgba(255, 255, 255, 0.06);
                    }
                }
                .gy-progress-track-style {
                    background: rgba(120, 120, 128, 0.16);
                    border-radius: 6px;
                    height: 6px;
                    overflow: hidden;
                }
                .gy-progress-bar-style {
                    background: linear-gradient(90deg, #34C759, #30D158);
                    height: 100%;
                    width: 0%;
                    border-radius: 6px;
                    transition: width 0.25s ease;
                }
                #gy-txt-log {
                    max-height: 170px;
                    overflow-y: auto;
                    background: rgba(0, 0, 0, 0.03);
                    border: 1px solid rgba(0, 0, 0, 0.06);
                    border-radius: 10px;
                    padding: 8px 10px;
                    font-size: 11px;
                    font-family: SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
                    white-space: pre-wrap;
                    word-break: break-all;
                    color: inherit;
                    line-height: 1.45;
                }
                @media (prefers-color-scheme: dark) {
                    #gy-txt-log {
                        background: rgba(0, 0, 0, 0.35);
                        border-color: rgba(255, 255, 255, 0.08);
                    }
                }
                #gy-txt-log::-webkit-scrollbar {
                    width: 5px;
                }
                #gy-txt-log::-webkit-scrollbar-track {
                    background: transparent;
                }
                #gy-txt-log::-webkit-scrollbar-thumb {
                    background: rgba(120, 120, 128, 0.3);
                    border-radius: 3px;
                }
                #gy-txt-log::-webkit-scrollbar-thumb:hover {
                    background: rgba(120, 120, 128, 0.5);
                }
            `;
            document.head.appendChild(style);
        }

        const panel = document.createElement("div");
        panel.id = "gy-txt-panel";
        panel.innerHTML = `
            <div id="gy-txt-head">
                <div class="gy-apple-header-title">
                    <div class="gy-apple-badge">☁</div>
                    <span>光鸭网盘 - txt 磁力批量云添加</span>
                </div>
                <span id="gy-txt-close" title="关闭">✕</span>
            </div>
            <div class="gy-apple-content">
                <!-- 工具栏第一行按钮 -->
                <div style="display:flex;gap:6px;">
                    <button id="gy-txt-pick" class="gy-apple-btn gy-btn-blue" style="flex:1;">📄 选择txt文件</button>
                    <button id="gy-txt-token" class="gy-apple-btn gy-btn-gray">🔑 设置Token</button>
                    <button id="gy-txt-verify" class="gy-apple-btn gy-btn-orange">🧪 验证Token</button>
                    <button id="gy-txt-mem" class="gy-apple-btn gy-btn-purple">🧠 记忆状态</button>
                </div>
                <!-- 工具栏第二行按钮 -->
                <div style="display:flex;gap:6px;">
                    <button id="gy-txt-export" class="gy-apple-btn gy-btn-red" style="flex:1;">💾 导出记忆</button>
                    <button id="gy-txt-import" class="gy-apple-btn gy-btn-green" style="flex:1;">📥 导入记忆</button>
                    <button id="gy-txt-page" class="gy-apple-btn gy-btn-purple" style="flex:1;">🔍 抓取本页</button>
                </div>
                <!-- 每日限额设置 -->
                <div style="display:flex;gap:6px;align-items:center;">
                    <span style="font-size:11px;color:#8e8e93;white-space:nowrap;">每日限额</span>
                    <input id="gy-txt-limit" type="number" min="1" max="100000" value="" class="gy-apple-input" style="flex:1;min-width:0;" title="光鸭每天最多提交次数">
                    <button id="gy-txt-limit-btn" class="gy-apple-btn gy-btn-gray" style="white-space:nowrap;">保存</button>
                </div>
                <!-- 开始与暂停上传 -->
                <div>
                    <button id="gy-txt-start" class="gy-apple-btn gy-btn-main">▶ 开始上传</button>
                    <button id="gy-txt-pause" class="gy-apple-btn gy-btn-pause-style" style="margin-top:6px;display:none;">⏸ 暂停上传</button>
                </div>
                <!-- 文件夹搜索区 -->
                <div style="display:flex;gap:6px;align-items:center;">
                    <input id="gy-txt-search" type="text" class="gy-apple-input" placeholder="🔍 搜索文件夹(回车搜索)..." style="flex:1;">
                    <button id="gy-txt-search-btn" class="gy-apple-btn gy-btn-gray" style="white-space:nowrap;">搜索</button>
                </div>
                <!-- 文件夹选择下拉框 -->
                <div style="display:flex;gap:6px;align-items:center;">
                    <select id="gy-txt-folder" class="gy-apple-input gy-apple-select" style="flex:1;min-width:0;max-width:275px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                        <option value="">(根目录)</option>
                    </select>
                    <button id="gy-txt-folder-btn" class="gy-apple-btn gy-btn-gray" style="white-space:nowrap;">📁 全部文件夹</button>
                </div>
                <!-- 隐藏的文件选择 input -->
                <input id="gy-txt-file" type="file" accept=".txt,.text,.m3u,.csv,text/plain" style="display:none;">
                <!-- 状态与规则提示 -->
                <div class="gy-card-box">
                    <div id="gy-txt-info" style="font-size:12px;font-weight:500;margin-bottom:2px;">未选择文件</div>
                    <div style="font-size:11px;color:#8e8e93;line-height:1.35;">
                        规则: 磁力链接 magnet:、40位hex、32位base32、.torrent URL、ed2k 链接。每行一个。
                    </div>
                </div>
                <!-- 进度条 -->
                <div id="gy-txt-progress" style="display:none;">
                    <div class="gy-progress-track-style">
                        <div id="gy-txt-bar" class="gy-progress-bar-style"></div>
                    </div>
                    <div id="gy-txt-count" style="margin-top:4px;font-size:11px;color:#8e8e93;text-align:right;"></div>
                </div>
                <!-- 日志区 -->
                <div id="gy-txt-log"></div>
            </div>`;
        document.body.appendChild(panel);

        // 拖拽
        const head = document.getElementById("gy-txt-head");
        let dragging = false, sx, sy, ox, oy;
        head.addEventListener("mousedown", (e) => {
            dragging = true; sx = e.clientX; sy = e.clientY;
            const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
        });
        document.addEventListener("mousemove", (e) => {
            if (!dragging) return;
            panel.style.left = (ox + e.clientX - sx) + "px";
            panel.style.top = (oy + e.clientY - sy) + "px";
            panel.style.right = "auto"; panel.style.bottom = "auto";
        });
        document.addEventListener("mouseup", () => dragging = false);

        document.getElementById("gy-txt-close").onclick = () => {
            panel.remove();
            ensureLauncher();   // 面板关掉后留一个悬浮按钮,否则只能刷新页面才能找回
        };
        document.getElementById("gy-txt-pick").onclick = () => document.getElementById("gy-txt-file").click();
        document.getElementById("gy-txt-token").onclick = () => {
            const t = prompt("粘贴光鸭网盘的 access_token(登录后自动提取,留空取消):", getAccessToken());
            if (t) { setToken(t.trim()); log("✓ Token 已保存"); }
        };
        document.getElementById("gy-txt-verify").onclick = async () => {
            if (capturedHeaders.length) {
                log("=== 捕获到网页版请求头 ===");
                capturedHeaders.forEach(h => log("  " + h));
                log("=== 结束 ===");
            } else {
                log("(未捕获到自定义请求头 — 网页版可能只用 cookie 鉴权)");
            }
            let token = getAccessToken();
            if (!token) {
                token = prompt("未提取到 token。可先在 localStorage 找(DevTools → Application → Local Storage → guangyapan.com)。");
                if (!token) { log("✗ 无 token,取消验证"); return; }
                setToken(token);
            }
            log("验证 Token: " + token.slice(0, 12) + "...(" + token.length + " 字符)");
            try {
                const r = await apiPost(URL_TASKS, { pageSize: 5, status: [0,1,2,3,4,5] }, token);
                log("响应状态: HTTP " + r.status);
                if (typeof r.body === "string") log("响应(文本): " + r.body.slice(0, 300));
                else log("响应(JSON): " + JSON.stringify(r.body).slice(0, 400));
            } catch (e) {
                log("✗ 验证失败: " + e.message);
            }
        };
        document.getElementById("gy-txt-mem").onclick = () => {
            const submitted = Object.keys(getSubmittedMap()).length;
            const today = getTodayCount();
            const total = getTotalSubmitted();
            const failedCount = Object.keys(getFailedMap()).length;
            log("=== 记忆状态 ===");
            log("今日已用: " + today + "/" + getDailyLimit());
            log("今日剩余: " + Math.max(0, getDailyLimit() - today));
            log("已成功记忆: " + submitted + " 个");
            log("永久失败黑名单: " + failedCount + " 个");
            log("历史累计提交: " + total + " 次");
            log("今日日期: " + todayStr());
            log("(每日自动重置,明天额度自动恢复)");
            const r = confirm("要清空全部记忆吗?\n清空后已提交的磁力链会被重新提交!\n(仅调试用,不建议)");
            if (r) {
                clearAllMemory();
                log("✗ 记忆已清空");
            }
        };
        // 导出记忆:下载 JSON 备份(删脚本前导出)
        document.getElementById("gy-txt-export").onclick = () => {
            flushSubmitted();   // 先把内存写入存储
            const n = exportMemory();
            log("✓ 已导出记忆: 成功 " + n + " 个 + 失败黑名单 " + Object.keys(getFailedMap()).length + " 个 + 每日计数。");
            log("  下载文件: guangya-memory-backup-*.json (删脚本前保存好)");
        };
        // 导入记忆:恢复备份
        const importInput = document.createElement("input");
        importInput.type = "file";
        importInput.accept = ".json,application/json";
        importInput.style.display = "none";
        document.body.appendChild(importInput);
        importInput.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const n = await importMemory(file);
                log("✓ 已导入记忆: " + n + " 个已提交磁力链。");
                log("  包含:失败黑名单、每日计数、目标文件夹。");
            } catch (err) {
                log("✗ 导入失败: " + err.message);
            }
            e.target.value = "";
        };
        document.getElementById("gy-txt-import").onclick = () => importInput.click();
        // 每日限额:显示当前值 + 保存
        const limitInput = document.getElementById("gy-txt-limit");
        const limitBtn = document.getElementById("gy-txt-limit-btn");
        limitInput.value = getDailyLimit();
        limitBtn.onclick = () => {
            const v = parseInt(limitInput.value, 10);
            if (!(v > 0 && v <= 100000)) {
                log("✗ 限额必须是 1-100000 的整数");
                limitInput.value = getDailyLimit();
                return;
            }
            setDailyLimit(v);
            log("✓ 每日限额已设为 " + v + "(今日已用 " + getTodayCount() + ", 剩余 " + Math.max(0, v - getTodayCount()) + ")");
        };
        // 抓取本页:扫描当前页面 DOM 里的 magnet/hash/.torrent 链接
        document.getElementById("gy-txt-page").onclick = () => {
            const found = new Set();
            const src = document.documentElement.outerHTML;
            // 全链 magnet(大小写 base32 都认,保留 dn/tr 等参数)
            const mm = src.matchAll(/magnet:\?[^\s"'<>]*xt=urn:btih:[0-9a-z]{32,40}[^\s"'<>]*/gi);
            for (const m of mm) found.add(m[0]);
            // 40hex / 32base32(独立 token,排除 HTML 属性碎片)
            const h40 = src.matchAll(/\b[0-9a-fA-F]{40}\b/g);
            for (const m of h40) found.add("magnet:?xt=urn:btih:" + m[0].toLowerCase());
            const h32 = src.matchAll(/\b[A-Z2-7]{32}\b/gi);
            for (const m of h32) found.add("magnet:?xt=urn:btih:" + m[0].toUpperCase());
            // .torrent URL
            const tu = src.matchAll(/https?:\/\/[^\s"'<>]+\.torrent(?:[?#][^\s"'<>]*)?/gi);
            for (const m of tu) found.add(m[0]);
            const list = [...found];
            log("本页抓取: 识别到 " + list.length + " 个磁力/种子");
            if (list.length === 0) { log("⚠ 本页未发现磁力链接"); return; }
            list.slice(0, 5).forEach((m, i) => log((i + 1) + ". " + m.slice(0, 70)));
            if (list.length > 5) log("... 共 " + list.length + " 个");
            pendingMagnets = list;
            const todayUsed = getTodayCount();
            const remaining = Math.max(0, getDailyLimit() - todayUsed);
            log("今日已用 " + todayUsed + "/" + getDailyLimit() + ", 剩余 " + remaining);
            log("▶ 确认无误后点「开始上传」执行");
        };
        document.getElementById("gy-txt-folder-btn").onclick = async () => {
            let token = getAccessToken();
            if (!token) {
                token = prompt("未提取到 token,请先点验证Token");
                if (!token) return;
            }
            const sel = document.getElementById("gy-txt-folder");
            sel.innerHTML = '<option value="">(加载中...)</option>';
            try {
                const folders = await listFoldersUnder(token, "");
                sel.innerHTML = '<option value="">(根目录)</option>';
                folders.forEach(f => {
                    const opt = document.createElement("option");
                    opt.value = f.fileId;
                    opt.textContent = truncateFolder(f.name, 36);
                    sel.appendChild(opt);
                });
                // 恢复之前选的(用 fileId 匹配)
                const saved = getTargetFolder();
                if (saved && saved.fileId) {
                    if ([...sel.options].some(o => o.value === saved.fileId)) {
                        sel.value = saved.fileId;
                        log("已恢复上次文件夹: " + saved.name);
                    }
                }
                log("已加载根目录 " + folders.length + " 个文件夹(搜索框可全盘搜子文件夹)");
                sel.onchange = () => {
                    const fid = sel.value;
                    const full = folders.find(f => f.fileId === fid);
                    const name = full ? full.name : "(根目录)";
                    setTargetFolder(fid ? { fileId: fid, name } : null);
                    log("目标文件夹: " + name);
                };
            } catch (e) {
                sel.innerHTML = '<option value="">(根目录)</option>';
                log("✗ 加载文件夹失败: " + e.message);
            }
        };
        // 搜索文件夹(官方 search_files,快速全盘搜)
        const doSearch = async () => {
            const kw = document.getElementById("gy-txt-search").value.trim();
            if (!kw) { log("请输入搜索关键字"); return; }
            let token = getAccessToken();
            if (!token) {
                token = prompt("未提取到 token,请先点验证Token");
                if (!token) return;
            }
            const sel = document.getElementById("gy-txt-folder");
            sel.innerHTML = '<option value="">(搜索中...)</option>';
            log("搜索文件夹: " + kw);
            try {
                const folders = await searchFolders(token, kw, 100);
                sel.innerHTML = '<option value="">(根目录)</option>';
                folders.forEach(f => {
                    const opt = document.createElement("option");
                    opt.value = f.fileId;
                    opt.textContent = truncateFolder(f.name, 30) + " [命中]";
                    sel.appendChild(opt);
                });
                if (folders.length === 0) {
                    sel.innerHTML = '<option value="">(根目录)</option>';
                    log("✗ 未搜到含 '" + kw + "' 的文件夹");
                    return;
                }
                log("搜到 " + folders.length + " 个文件夹");
                sel.onchange = () => {
                    const fid = sel.value;
                    const full = folders.find(f => f.fileId === fid);
                    const name = full ? full.name : "(根目录)";
                    setTargetFolder(fid ? { fileId: fid, name } : null);
                    log("目标文件夹: " + name);
                };
                // 自动选第一个
                if (folders.length === 1) {
                    sel.value = folders[0].fileId;
                    setTargetFolder({ fileId: folders[0].fileId, name: folders[0].name });
                    log("已自动选择: " + folders[0].name);
                }
            } catch (e) {
                sel.innerHTML = '<option value="">(根目录)</option>';
                log("✗ 搜索失败: " + e.message);
            }
        };
        document.getElementById("gy-txt-search-btn").onclick = doSearch;
        document.getElementById("gy-txt-search").addEventListener("keydown", (e) => {
            if (e.key === "Enter") doSearch();
        });
        // 已解析待上传的磁力链(点"开始上传"才执行)
        let pendingMagnets = [];

        document.getElementById("gy-txt-file").onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            log("读取文件: " + file.name + " (" + (file.size / 1024).toFixed(1) + " KB)");
            log("解析中(大文件请稍候)...");
            let magnets;
            try {
                // 按块流式解析,几百 MB 的 txt 也不会一次性占满内存
                magnets = await extractMagnetsFromFile(file, (p, lines) => {
                    setProgress(Math.round(p * 100), "解析中 " + lines + " 行...");
                });
            } catch (err) {
                log("✗ 解析失败: " + err.message);
                e.target.value = "";
                return;
            }
            setProgress(100, "解析完成");
            log("识别到 " + magnets.length + " 个磁力链接");
            if (magnets.length === 0) { log("⚠ 未识别到有效磁力链接"); e.target.value = ""; return; }

            // 记忆过滤:预览将跳过多少已提交
            const alreadyDone = magnets.filter(m => isSubmitted(magnetHash(m)));
            const todayUsed = getTodayCount();
            const remaining = Math.max(0, getDailyLimit() - todayUsed);
            pendingMagnets = magnets;

            log("已提交跳过: " + alreadyDone.length + " 个");
            log("今日已用 " + todayUsed + "/" + getDailyLimit() + ", 剩余 " + remaining);
            log("本次待提交(最多 " + Math.min(remaining, magnets.length - alreadyDone.length) + " 个)");
            // 只显示前 5 个预览
            magnets.slice(0, 5).forEach((m, i) => log((i + 1) + ". " + m.slice(0, 70)));
            if (magnets.length > 5) log("... 共 " + magnets.length + " 个");
            log("▶ 确认无误后点「开始上传」执行");
            e.target.value = "";
        };

        document.getElementById("gy-txt-start").onclick = async () => {
            if (!pendingMagnets || pendingMagnets.length === 0) {
                log("请先选择 txt 文件(解析完成后此按钮才可用)");
                return;
            }
            // 先检查凭据,避免用户确认后才在 runBatch 里弹 prompt 或直接失败
            if (!getAccessToken()) {
                log("✗ 未提取到 token。请先登录网页版并点「🧪 验证Token」,或用「🔑 设置Token」粘贴");
                return;
            }
            if (isAuthFailed()) {
                log("✗ token 已失效。请刷新页面重新捕获,或手动设置新 token");
                return;
            }
            const n = pendingMagnets.length;
            const ok = confirm("确认开始上传 " + n + " 个磁力链?\n\n将自动跳过已提交的,并遵守今日 " + getDailyLimit() + " 上限。");
            if (!ok) { log("已取消"); return; }
            const list = pendingMagnets;
            pendingMagnets = [];   // 防重复点击
            // 显示暂停按钮,开始上传
            const pauseBtn = document.getElementById("gy-txt-pause");
            if (pauseBtn) { pauseBtn.style.display = "block"; pauseBtn.textContent = "⏸ 暂停上传"; pauseBtn.style.background = "#FF9500"; }
            try {
                await runBatch(list);
            } finally {
                // 无论成功/异常/提前 return,都要复位暂停状态,否则下次开始会卡在暂停
                resumeUpload();
                if (pauseBtn) pauseBtn.style.display = "none";
            }
        };
        // 暂停/继续按钮
        const pauseBtn = document.getElementById("gy-txt-pause");
        pauseBtn.onclick = () => {
            if (!_pauseRequested) {
                pauseUpload();
                pauseBtn.textContent = "▶ 继续上传";
                pauseBtn.style.background = "#34C759";
                log("⏸ 已暂停(当前请求完成/中断后停止,点「继续上传」恢复)");
            } else {
                resumeUpload();
                pauseBtn.textContent = "⏸ 暂停上传";
                pauseBtn.style.background = "#FF9500";
                log("▶ 已继续上传");
            }
        };
    }

    // 批量渲染日志:log 先入缓冲,每 80ms 一次性刷 DOM,避免逐条写入卡死
    let logBuf = [];
    let logTimer = null;
    function log(msg) {
        const el = document.getElementById("gy-txt-log");
        if (!el) return;
        logBuf.push((new Date().toLocaleTimeString()) + " " + msg + "\n");
        if (logTimer) return;
        logTimer = setTimeout(() => {
            logTimer = null;
            if (!logBuf.length) return;
            const chunk = logBuf.join("");
            logBuf = [];
            // 防止日志无限增长:超过 50000 字符截断前半段
            // 按行切而不是按字符切,避免把中文/emoji 劈成半个
            if (el.textContent.length + chunk.length > 50000) {
                const lines = (el.textContent + chunk).split("\n");
                while (lines.length > 1 && lines.join("\n").length > 30000) lines.shift();
                el.textContent = lines.join("\n");
                el.scrollTop = el.scrollHeight;
                return;
            }
            el.textContent += chunk;
            el.scrollTop = el.scrollHeight;
        }, 80);
    }

    function setProgress(pct, text) {
        const bar = document.getElementById("gy-txt-bar");
        const cnt = document.getElementById("gy-txt-count");
        const wrap = document.getElementById("gy-txt-progress");
        if (bar) bar.style.width = pct + "%";
        if (cnt) cnt.textContent = text || "";
        if (wrap) wrap.style.display = "block";
    }

    // 暂停控制(全局标志 + 等待 promise)
    let _pauseRequested = false;
    let _resumeResolve = null;
    let _pausePromise = null;

    function pauseUpload() {
        if (!_pauseRequested) {
            _pauseRequested = true;
            _pausePromise = new Promise((resolve) => { _resumeResolve = resolve; });
        }
    }
    function resumeUpload() {
        if (_pauseRequested) {
            _pauseRequested = false;
            if (_resumeResolve) { _resumeResolve(); _resumeResolve = null; }
            _pausePromise = null;
        }
    }
    // 在循环里调用:暂停时挂起,恢复后继续
    async function waitIfPaused() {
        while (_pauseRequested) {
            if (!_pausePromise) _pausePromise = new Promise((resolve) => { _resumeResolve = resolve; });
            await _pausePromise;
            _pausePromise = null;
        }
    }

    // 等待新的 token 被页面捕获(失效后不要立刻派发,否则整批瞬间全挂)
    async function waitForFreshToken(timeoutMs) {
        const deadline = Date.now() + (timeoutMs || 20000);
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 400));
            const t = getAccessToken();
            if (t) return t;
        }
        return "";
    }

    async function runBatch(magnets) {
        let token = getAccessToken();
        if (!token) {
            token = prompt("未提取到 access_token。请粘贴光鸭网盘的 token(登录网页版后浏览器 DevTools → localStorage 里可找到):");
            if (!token) { log("✗ 未提供 token,取消"); return; }
            setToken(token.trim());
            token = token.trim();
        }
        if (isAuthFailed()) {
            log("⚠ 上次 token 已失效,等待页面重新捕获...");
            token = await waitForFreshToken(20000);
            if (!token) {
                log("✗ 20s 内未捕获到新 token。请刷新页面后重试(已提交的已记录,下次自动跳过)");
                return;
            }
        }
        log("Token: " + token.slice(0, 8) + "...");

        // === 记忆过滤:跳过已提交 + 永久失败黑名单 + 同 infohash 去重 ===
        // 去重键用 magnetHash(infohash),不是整条 URL:同一资源不同 tr/dn 参数不该提交两次
        const todayUsed = getTodayCount();
        const remainingToday = Math.max(0, getDailyLimit() - todayUsed);
        const alreadyDone = [];
        const alreadyFailed = [];
        const dupInRun = [];
        const pending = [];
        const seenHash = new Set();
        for (const m of magnets) {
            const h = magnetHash(m);
            if (isSubmitted(h)) { alreadyDone.push(m); continue; }
            if (isFailed(h)) { alreadyFailed.push(m); continue; }
            if (seenHash.has(h)) { dupInRun.push(m); continue; }
            seenHash.add(h);
            pending.push(m);
        }
        log("今日已用 " + todayUsed + "/" + getDailyLimit() + " (剩 " + remainingToday + ")");
        log("本次识别 " + magnets.length + " 个: 已提交跳过 " + alreadyDone.length
            + ", 永久失败跳过 " + alreadyFailed.length
            + ", 同 infohash 去重 " + dupInRun.length
            + ", 待提交 " + pending.length);

        if (pending.length === 0) { log("全部已提交/失败过,无需操作"); return; }
        if (remainingToday <= 0) { log("✗ 今日额度已用完,明天再跑。今日剩余: 0"); return; }

        const targetFolder = getTargetFolder();
        const parentId = (targetFolder && targetFolder.fileId) || "";
        if (parentId) log("目标文件夹: " + targetFolder.name + " (ID " + parentId + ")");
        else log("目标文件夹: (根目录)");

        // === v1.3: 并发池 + 自适应退避 + 额度原子占用 + token 热更新 ===
        const MAX_CONCURRENCY = 3;
        const MIN_CONCURRENCY = 1;
        let concurrency = MAX_CONCURRENCY;
        // 额度用"本地成功 + 在途"占位;跨标签页由 _dailyEpoch 检测后回填
        const quota = remainingToday;
        const total = pending.length;
        let ok = 0, fail = 0, done = 0;
        let noMore = false;      // 只停止派发新任务;已派发的任务必须跑完
        let inflight = 0;
        let lastSpacingAt = 0;
        let cooldownUntil = 0;   // 触发限频后全局冷却,避免继续撞墙
        const failReasons = {};
        const queue = [...pending];
        let cursor = 0;
        const localStartCount = getTodayCount();

        function currentLimit() {
            return Math.max(MIN_CONCURRENCY, Math.min(concurrency, MAX_CONCURRENCY));
        }
        function noteFailReason(key) {
            failReasons[key] = (failReasons[key] || 0) + 1;
            const keys = Object.keys(failReasons);
            if (keys.length > 200) delete failReasons[keys[0]];
        }
        function updateProgress() {
            setProgress(
                Math.round(done / total * 100),
                "提交 " + done + "/" + total + " (成功 " + ok + "/" + quota + " 失败 " + fail + " 并发 " + currentLimit() + ")"
            );
        }
        // 别的标签页也在提交时,本页额度要跟着收:不然后两个标签页会各自按旧剩余量派发
        function refreshQuotaFromStore() {
            const usedNow = getTodayCount();
            if (usedNow > localStartCount + ok) {
                const extra = usedNow - localStartCount - ok;
                if (extra > 0) {
                    log("⚠ 检测到其他标签页已提交 " + extra + " 个,同步额度");
                    // 把差额记成已用:直接抬高本地成功计数会污染统计,用 noMore 收敛更安全
                    if (usedNow >= getDailyLimit()) {
                        noMore = true;
                        log("⚠ 今日额度已被其他标签页用满,停止派发");
                    }
                }
            }
        }
        // 全局最小间隔:不是每个 worker 各睡一次,而是派发时统一节流
        async function throttle() {
            const now = Date.now();
            if (now < cooldownUntil) await new Promise(r => setTimeout(r, cooldownUntil - now));
            const wait = SUBMIT_INTERVAL_MS - (Date.now() - lastSpacingAt);
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
            lastSpacingAt = Date.now();
        }

        // 带退避的重试包装:靠 err.isTemp 判定,HTTP 5xx / 429 / 超时 / 网络错误都算
        async function withRetry(fn, baseDelay, label) {
            let delay = baseDelay;
            for (let attempt = 1; ; attempt++) {
                try {
                    return await fn();
                } catch (e) {
                    const msg = e.message || "未知异常";
                    const temp = (e && e.isTemp) || isTempFailure(msg);
                    if (!temp || attempt >= 3) throw e;
                    log("↻ " + label + " 重试 " + attempt + "/2 (" + msg + ")");
                    await new Promise(r => setTimeout(r, delay));
                    delay *= 2;   // 500ms -> 1s -> 2s
                }
            }
        }

        // 处理单条:返回 "ok" | "fail" | "stop" | "skip"
        // token 每步现取:页面刷新/重新登录后无需中断整批
        async function processOne(m) {
            await waitIfPaused();
            let tk = getAccessToken();
            if (!tk) {
                if (isAuthFailed()) {
                    log("⚠ token 失效,等待重新捕获(最多 20s)...");
                    tk = await waitForFreshToken(20000);
                }
                if (!tk) {
                    log("⚠ 无可用 token,停止派发新任务。已提交的已记录,下次自动跳过");
                    return "stop";
                }
            }
            const hash = magnetHash(m);
            try {
                await throttle();
                // 1. 解析磁力链
                const rr = await withRetry(() => resolveUrl(m, tk), 500, "解析");
                const rbody = rr.body && typeof rr.body === "object" ? rr.body : null;
                const rcode = rbody ? rbody.code : null;
                if (rr.status !== 200 || (rcode !== 0 && rcode != null)) {
                    const msg = (rbody && (rbody.msg || rbody.message)) || ("HTTP " + rr.status);
                    noteFailReason("解析失败: " + msg);
                    const err = httpError(rr, rbody);
                    if (!err.isTemp && !isQuotaExceeded(msg)) markFailed(hash, "解析失败: " + msg);
                    log("✗ 解析失败: " + m.slice(0, 50) + " → " + msg);
                    if (isQuotaExceeded(msg)) {
                        log("⚠ 今日云添加次数已超限,立即停止。剩余磁力明天再跑(记忆断点已保存)");
                        return "stop";
                    }
                    if (err.isRateLimited) { cooldownUntil = Date.now() + 5000; concurrency = MIN_CONCURRENCY; }
                    else if (err.isTemp) concurrency = Math.max(MIN_CONCURRENCY, concurrency - 1);
                    return "fail";
                }
                // 2. 创建任务
                const ct = await withRetry(() => createTask(m, tk, { parentId }), 500, "提交");
                const cbody = ct.body && typeof ct.body === "object" ? ct.body : null;
                const ccode = cbody ? cbody.code : null;
                if (ccode === 0 || (ccode == null && ct.status === 200)) {
                    markSubmitted(hash);
                    bumpDailyCount();
                    bumpTotal();
                    // 成功只温和恢复并发,避免"成功一次就拉满 → 撞限频 → 降档"的锯齿
                    if (concurrency < MAX_CONCURRENCY && Math.random() < 0.34) concurrency++;
                    log("✓ 已添加: " + m.slice(0, 60));
                    return "ok";
                }
                const msg = (cbody && (cbody.msg || cbody.message)) || ("HTTP " + ct.status);
                noteFailReason(msg);
                const err = httpError(ct, cbody);
                if (!err.isTemp && !isQuotaExceeded(msg)) markFailed(hash, msg);
                log("✗ 添加失败: " + m.slice(0, 50) + " → " + msg);
                if (isQuotaExceeded(msg)) {
                    log("⚠ 今日云添加次数已超限,立即停止。剩余磁力明天再跑(记忆断点已保存)");
                    return "stop";
                }
                if (err.isRateLimited) { cooldownUntil = Date.now() + 5000; concurrency = MIN_CONCURRENCY; }
                else if (err.isTemp) concurrency = Math.max(MIN_CONCURRENCY, concurrency - 1);
                return "fail";
            } catch (e) {
                const msg = e.message || "未知异常";
                noteFailReason("异常: " + msg);
                const temp = (e && e.isTemp) || isTempFailure(msg);
                if (!temp) markFailed(hash, "异常: " + msg);
                log("✗ 异常: " + m.slice(0, 50) + " → " + msg);
                if (temp) concurrency = Math.max(MIN_CONCURRENCY, concurrency - 1);
                return "fail";
            }
        }

        setProgress(0, "开始提交 0/" + total);
        log("并发上限 " + MAX_CONCURRENCY + ",初始并发 " + concurrency + ",本次额度 " + quota);

        // 调度器:每轮按 currentLimit() 补满在途任务;并发被调低时自然收缩,调高时自动补位
        const pool = new Set();
        while (true) {
            if (noMore && pool.size === 0) break;
            if (pool.size === 0 && cursor < queue.length) refreshQuotaFromStore();
            while (!noMore && pool.size < currentLimit() && cursor < queue.length) {
                // 额度原子占用:成功数 + 在途数 不能超过今日剩余,避免并发越过限额
                if (ok + inflight >= quota) {
                    noMore = true;
                    log("⚠ 今日额度已用满(" + (ok + inflight) + "/" + quota + "),停止派发新任务");
                    break;
                }
                const m = queue[cursor++];
                inflight++;
                let p;
                p = processOne(m).then(res => {
                    if (res === "ok") ok++;
                    else if (res === "fail") fail++;
                    else if (res === "stop") noMore = true;
                }).catch(e => {
                    fail++;
                    noteFailReason("调度异常: " + (e && e.message));
                }).finally(() => {
                    inflight--;
                    done++;
                    pool.delete(p);
                    updateProgress();
                });
                pool.add(p);
            }
            if (pool.size === 0) break;
            await Promise.race(pool);
        }
        await Promise.all(pool);

        // 汇总失败原因
        const reasonLines = Object.entries(failReasons)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([k, v]) => "  " + v + "× " + k);
        if (reasonLines.length) {
            log("失败原因 TOP:");
            reasonLines.forEach(l => log(l));
        }
        setProgress(100, "完成: 成功 " + ok + " / 失败 " + fail);
        log("=== 完成: 成功 " + ok + " / 失败 " + fail + " ===");
        log("今日已用 " + getTodayCount() + "/" + getDailyLimit() + ", 剩余 " + Math.max(0, getDailyLimit() - getTodayCount()));
        flushSubmitted();
        flushFailedMap();
        log("记忆已保存,下次运行自动跳过已提交/失败的");
    }
    // 挂载
    // @run-at document-start:此时 document.body 还不存在,必须等 DOM 可写
    // 拦截器要尽早挂上,否则页面首屏的鉴权请求已经发完;UI 则等 body 可用
    function waitForBody(cb) {
        if (document.body) { cb(); return; }
        const mo = new MutationObserver(() => {
            if (document.body) { mo.disconnect(); cb(); }
        });
        mo.observe(document.documentElement || document, { childList: true, subtree: true });
        // 兜底:某些情况下 DOMContentLoaded 先到
        document.addEventListener("DOMContentLoaded", () => {
            mo.disconnect();
            if (document.body) cb();
        }, { once: true });
    }

    const flushAll = () => { flushSubmitted(); flushFailedMap(); };

    // 跨标签页同步:其他标签页提交/清空记忆后,本页缓存立即失效重读
    function setupCrossTabSync() {
        if (typeof GM_addValueChangeListener !== "function") return;
        try {
            GM_addValueChangeListener(KEY_SUBMITTED_MAP, (name, oldV, newV, remote) => {
                if (!remote || _memDirty) return;   // 本页有未落盘改动时不覆盖,等 flush
                _memMap = asObject(newV) || {};
            });
            GM_addValueChangeListener(KEY_FAILED_MAP, (name, oldV, newV, remote) => {
                if (!remote || _failDirty) return;
                _failMap = asObject(newV) || {};
            });
            GM_addValueChangeListener(KEY_DAILY, (name, oldV, newV, remote) => {
                if (!remote) return;
                _dailyEpoch++;
            });
        } catch (e) { /* 管理器不支持,忽略 */ }
    }

    // @run-at document-start:拦截器必须在这里立刻挂,不能等 DOMContentLoaded,
    // 否则页面首屏的鉴权请求已经发完,token 永远捕不到。UI 才等 body。
    function inject() {
        if (!location.hostname.includes("guangyapan.com")) return;
        startCapture();          // 同步,越早越好
        setupCrossTabSync();
        waitForBody(() => {
            buildUI();
            // 关页面/切后台时立刻落盘,避免 debounce 窗口内的已提交记录丢失
            window.addEventListener("beforeunload", flushAll);
            document.addEventListener("visibilitychange", () => {
                if (document.visibilityState === "hidden") flushAll();
            });
        });
    }
    inject();   // 直接执行:document-start 下 startCapture 必须在页面脚本之前

    // 控制台暴露
    window.gyTxtCloud = {
        extractMagnets: extractLineMagnet,
        extractAll: extractLineMagnets,
        extractMagnetsAsync,
        extractMagnetsFromFile,
        runBatch, getAccessToken, setToken,
        memory: {
            getSubmittedMap, isSubmitted, markSubmitted,
            getTodayCount, todayLimitReached, getTotalSubmitted,
            clearAllMemory, todayStr,
            get dailyLimit() { return getDailyLimit(); },
            set dailyLimit(v) { setDailyLimit(v); },
        },
        failed: {
            getFailedMap, isFailed, markFailed, isTempFailure, isQuotaExceeded,
        },
        backup: {
            exportMemory, importMemory,
        },
    };
    console.log("[gy-txt] 已加载。API: window.gyTxtCloud, 记忆: .memory, 失败黑名单: .failed, 备份: .backup");
})();
