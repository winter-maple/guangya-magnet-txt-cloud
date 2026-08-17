// ==UserScript==
// @name        光鸭网盘 - txt 磁力链接批量云添加
// @namespace   winter-maple
// @version      1.1.0
// @description 选择本地 txt 文件,自动提取里面的磁力链接/种子URL,批量云添加到光鸭网盘。基于光鸭官方 API cloudcollection/v1。v1.1: 并发提交 + 自适应退避 + 临时失败重试 + 限额可配置 + 页面抓取。
// @author      winter-maple
// @match       *://*.guangyapan.com/*
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_xmlhttpRequest
// @connect     api.guangyapan.com
// @connect     *
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
    function todayLimitReached() {
        return getTodayCount() >= getDailyLimit();
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
    function magnetHash(magnet) {
        const s = String(magnet || "");
        // magnet:?xt=urn:btih:HASH
        const m1 = s.match(/urn:btih:([0-9a-fA-F]{32,40})/i);
        if (m1) return m1[1].toUpperCase();
        // 纯 40hex / 32base32
        const m2 = s.match(/\b([0-9a-fA-F]{40})\b/i);
        if (m2) return m2[1].toUpperCase();
        const m3 = s.match(/\b([A-Z2-7]{32})\b/i);
        if (m3) return m3[1];
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

    function loadMemMap() {
        if (_memMap) return _memMap;
        try { _memMap = GM_getValue(KEY_SUBMITTED_MAP, {}) || {}; }
        catch (e) { _memMap = {}; }
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
        try { GM_setValue(KEY_SUBMITTED_MAP, _memMap); } catch (e) { /* ignore */ }
    }
    function markSubmitted(hash) {
        const m = loadMemMap();
        m[hash] = Date.now();
        _memDirty = true;
        if (_memTimer) clearTimeout(_memTimer);
        _memTimer = setTimeout(flushSubmitted, 3000);   // 3 秒攒一批,写一次
    }

    // 每日限额
    function getDaily() {
        try { return GM_getValue(KEY_DAILY, {}) || {}; }
        catch (e) { return {}; }
    }
    function getTodayCount() {
        const d = getDaily();
        const t = d[todayStr()];
        return t ? (t.count || 0) : 0;
    }
    function todayLimitReached() {
        return getTodayCount() >= getDailyLimit();
    }
    function bumpDailyCount() {
        const d = getDaily();
        const t = d[todayStr()];
        d[todayStr()] = { count: (t ? t.count : 0) + 1, limit: getDailyLimit() };
        try { GM_setValue(KEY_DAILY, d); } catch (e) { /* ignore */ }
    }
    function getTotalSubmitted() {
        try { return Number(GM_getValue(KEY_TOTAL, 0)) || 0; }
        catch (e) { return 0; }
    }
    function bumpTotal() {
        try { GM_setValue(KEY_TOTAL, getTotalSubmitted() + 1); } catch (e) { /* ignore */ }
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
        try {
            GM_setValue(KEY_SUBMITTED_MAP, {});
            GM_setValue(KEY_DAILY, {});
            GM_setValue(KEY_TOTAL, 0);
            GM_setValue(KEY_TOKEN, null);
            GM_setValue(KEY_FAILED_MAP, {});
        } catch (e) { /* ignore */ }
    }

    /* ============================================================
     * 失败黑名单 — 永久失败的磁力链下次不再上传
     * ============================================================ */
    // 临时失败特征(网络/超时/限频):不记黑名单,下次可重试
    const TEMP_FAIL_RE = /网络|timeout|超时|429|限频|速率|rate|timed out|ETIMEDOUT|ECONN|socket|proxy|连接|中断|暂时|稍后|太频繁/i;
    // 今日额度超限(服务端硬限额,应立即停止)
    const QUOTA_FAIL_RE = /超限|次数已用|次数不足|额度|quota|limit|每日|自然日|明天|已达上限/i;

    function isTempFailure(msg) {
        return TEMP_FAIL_RE.test(String(msg || ""));
    }
    function isQuotaExceeded(msg) {
        return QUOTA_FAIL_RE.test(String(msg || ""));
    }
    // 失败 map 内存缓存 + 批量写(避免每次 markFailed 都序列化整个 map)
    let _failMap = null;
    let _failDirty = false;
    let _failTimer = null;
    function loadFailMap() {
        if (_failMap) return _failMap;
        try { _failMap = GM_getValue(KEY_FAILED_MAP, {}) || {}; }
        catch (e) { _failMap = {}; }
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
        try { GM_setValue(KEY_FAILED_MAP, _failMap); } catch (e) { /* ignore */ }
    }
    function markFailed(hash, reason) {
        const m = loadFailMap();
        m[hash] = { reason: String(reason || "").slice(0, 200), ts: Date.now() };
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
                        try { GM_setValue(KEY_FAILED_MAP, data.failed); } catch (e) { /* ignore */ }
                    }
                    if (data.daily && typeof data.daily === "object") {
                        try { GM_setValue(KEY_DAILY, data.daily); } catch (e) { /* ignore */ }
                    }
                    if (typeof data.total === "number") {
                        try { GM_setValue(KEY_TOTAL, data.total); } catch (e) { /* ignore */ }
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
    async function listFoldersUnder(token, parentId) {
        const r = await apiPost(URL_FILE_LIST, {
            parentId: parentId || "",
            page: 0,
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
        return items
            .filter(it => it && (it.resType === 2 || it.dir === true || it.isDir === true))
            .map(it => ({
                fileId: String(it.fileId || it.id || it.file_id || ""),
                name: String(it.fileName || it.name || it.title || ""),
            }))
            .filter(f => f.fileId && f.name);
    }

    // 全局搜索文件夹(官方 search_files,只搜文件夹 resType:2)
    async function searchFolders(token, keyword, pageSize) {
        const r = await apiPost(URL_SEARCH, {
            name: keyword,       // 官方字段名是 name,不是 keyword
            page: 0,
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
        // 解析:每项可能直接有 fileId/fileName,或包在 fileInfo 里;fullParentIds 可拼路径
        return items.map(it => {
            const fi = (it && it.fileInfo) || it || {};
            const fileId = String(fi.fileId || it.fileId || it.id || "");
            const name = String(fi.fileName || fi.name || it.fileName || it.name || "");
            return { fileId, name };
        }).filter(f => f.fileId && f.name);
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
        const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
            try {
                captureHeader(name, value);
                // 记录所有自定义头(含非 Authorization 的鉴权头)
                if (!/^(content-type|accept|referer|origin|user-agent|accept-encoding|accept-language|cookie|sec-|:)/i.test(name)) {
                    const h = capturedHeaders;
                    if (h.length < 40) {
                        h.push(name + ": " + String(value || "").slice(0, 120));
                    }
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
            } catch (e) { /* ignore */ }
            return origFetch.apply(this, arguments);
        };

        // XHR open 之后、send 之前可能也有 headers 对象形式(open 传 headers 少见,主要靠 setRequestHeader 捕获)
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
                if (/^[A-Za-z0-9._~-]{30,}$/.test(obj)) return obj;
            }
            return "";
        }
        if (typeof obj !== "object") return "";
        if (seen.has(obj)) return "";
        seen.add(obj);
        for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (/token|auth|session|key/i.test(k) && typeof v === "string" && v.length > 20) {
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
    function setToken(t, did, smid) {
        const stored = getStoredAuth() || {};
        const auth = {
            token: t || stored.token || "",
            did: did || capturedAuth.did || stored.did || "",
            smid: smid || capturedAuth.smid || stored.smid || "",
            ts: Date.now(),
        };
        setStoredAuth(auth);
    }

    // 标记认证失败(401/117) → 清 token,等重新捕获
    function markAuthFailed() {
        _authFailed = true;
        try { GM_setValue(KEY_TOKEN, null); } catch (e) { /* ignore */ }
        capturedToken = "";
        console.log("[gy-txt] token 失效,等待重新捕获(刷新页面或重新触发页面请求)");
    }
    function isAuthFailed() { return _authFailed; }
    function resetAuthFailed() { _authFailed = false; }

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
            capturedAuth.did = v.trim();
            // 有 token 时连 did/smid 一起存
            if (capturedToken) setToken(capturedToken, capturedAuth.did, capturedAuth.smid);
        }
        else if (/^smid$/i.test(name)) {
            capturedAuth.smid = v.trim();
            if (capturedToken) setToken(capturedToken, capturedAuth.did, capturedAuth.smid);
        }
        else if (/^authorization$/i.test(name)) {
            const t = /^Bearer\s+/i.test(v) ? v.replace(/^Bearer\s+/i, "").trim() : v.trim();
            if (t) {
                capturedToken = t;
                resetAuthFailed();   // 新 token 有效
                setToken(t, capturedAuth.did, capturedAuth.smid);
            }
        }
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
                onerror: (e) => reject(new Error("网络错误: " + e.error)),
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
    const MAGNET_RE2 = /magnet:\?xt=urn:btih:[0-9a-fA-F]{32,40}/i;
    const HASH40_RE2 = /\b[0-9a-fA-F]{40}\b/;
    const HASH32_RE2 = /\b[A-Z2-7]{32}\b/;
    const TORRENT_URL_RE2 = /^https?:\/\/\S+\.torrent(?:[?#]\S*)?$/i;
    const ED2K_RE2 = /^ed2k:\/\/\|file\|[^|]+\|/i;

    // 高性能提取:逐行解析,避免灾难性回溯;大文件用分片解析避免卡 UI
    function extractLineMagnet(line) {
        const s = (line || "").trim();
        if (!s || s.startsWith("#") || s.startsWith("//")) return null;
        // 直接全链匹配优先
        const mm = s.match(MAGNET_RE2);
        if (mm) return mm[0];
        // .torrent URL(整行)
        if (TORRENT_URL_RE2.test(s)) return s;
        // ed2k
        if (ED2K_RE2.test(s)) return s;
        // 纯 40 位 hex
        const h40 = s.match(HASH40_RE2);
        if (h40) return "magnet:?xt=urn:btih:" + h40[0];
        // 纯 32 位 base32
        const h32 = s.match(HASH32_RE2);
        if (h32) return "magnet:?xt=urn:btih:" + h32[0];
        return null;
    }

    // 分片解析大文件,避免卡死 UI;每片 yield 让浏览器刷新
    async function extractMagnetsAsync(text, onProgress) {
        const lines = text.split(/\r?\n/);
        const found = new Set();
        const CHUNK = 2000;   // 每片 2000 行
        for (let i = 0; i < lines.length; i += CHUNK) {
            const end = Math.min(i + CHUNK, lines.length);
            for (let j = i; j < end; j++) {
                const m = extractLineMagnet(lines[j]);
                if (m) found.add(m);
            }
            if (onProgress) {
                try { onProgress(Math.min(1, (end / lines.length)), end); } catch (e) { /* ignore */ }
            }
            // 让出主线程,避免 UI 冻结
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
                    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%3C%238e8e93%3E' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E");
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

        document.getElementById("gy-txt-close").onclick = () => panel.remove();
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
            // 全链 magnet
            const mm = src.matchAll(/magnet:\?xt=urn:btih:[0-9a-fA-F]{32,40}/g);
            for (const m of mm) found.add(m[0]);
            // 40hex / 32base32(独立 token,排除 HTML 属性碎片)
            const h40 = src.matchAll(/\b[0-9a-fA-F]{40}\b/g);
            for (const m of h40) found.add("magnet:?xt=urn:btih:" + m[0].toUpperCase());
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
            const text = await file.text();
            log("解析中(大文件请稍候)...");
            // 异步分片解析,显示进度,不卡 UI
            const magnets = await extractMagnetsAsync(text, (p, done) => {
                setProgress(Math.round(p * 100), "解析中 " + done + " 行...");
            });
            setProgress(100, "解析完成");
            log("识别到 " + magnets.length + " 个磁力链接");
            if (magnets.length === 0) { log("⚠ 未识别到有效磁力链接"); return; }

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
            const n = pendingMagnets.length;
            const ok = confirm("确认开始上传 " + n + " 个磁力链?\n\n将自动跳过已提交的,并遵守今日 " + getDailyLimit() + " 上限。");
            if (!ok) { log("已取消"); return; }
            const list = pendingMagnets;
            pendingMagnets = [];   // 防重复点击
            // 显示暂停按钮,开始上传
            const pauseBtn = document.getElementById("gy-txt-pause");
            if (pauseBtn) pauseBtn.style.display = "block";
            await runBatch(list);
            // 上传结束隐藏暂停按钮
            if (pauseBtn) pauseBtn.style.display = "none";
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
            if (el.textContent.length > 50000) {
                el.textContent = el.textContent.slice(-30000);
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

    async function runBatch(magnets) {
        let token = getAccessToken();
        if (!token) {
            token = prompt("未提取到 access_token。请粘贴光鸭网盘的 token(登录网页版后浏览器 DevTools → localStorage 里可找到):");
            if (!token) { log("✗ 未提供 token,取消"); return; }
            setToken(token);
        }
        if (isAuthFailed()) {
            log("⚠ 上次 token 已失效。请刷新页面(脚本会自动捕获新 token)后重试。");
            return;
        }
        log("Token: " + token.slice(0, 8) + "...");

        // === 记忆过滤:跳过已提交 + 永久失败黑名单 ===
        const todayUsed = getTodayCount();
        const remainingToday = Math.max(0, getDailyLimit() - todayUsed);
        const alreadyDone = [];
        const alreadyFailed = [];
        const pending = [];
        for (const m of magnets) {
            const h = magnetHash(m);
            if (isSubmitted(h)) alreadyDone.push(m);
            else if (isFailed(h)) alreadyFailed.push(m);
            else pending.push(m);
        }
        log("今日已用 " + todayUsed + "/" + getDailyLimit() + " (剩 " + remainingToday + ")");
        log("本次识别 " + magnets.length + " 个, 已提交跳过 " + alreadyDone.length + " 个, 永久失败跳过 " + alreadyFailed.length + " 个, 待提交 " + pending.length + " 个");

        if (pending.length === 0) { log("全部已提交/失败过,无需操作"); return; }
        if (remainingToday <= 0) { log("✗ 今日额度已用完,明天再跑。今日剩余: 0"); return; }

        const targetFolder = getTargetFolder();
        const parentId = (targetFolder && targetFolder.fileId) || "";
        if (parentId) log("目标文件夹: " + targetFolder.name + " (ID " + parentId + ")");
        else log("目标文件夹: (根目录)");

        // === v1.1: 并发池 + 自适应退避 + 临时失败重试 ===
        const MAX_CONCURRENCY = 3;      // 初始并发
        const MIN_CONCURRENCY = 1;
        let concurrency = MAX_CONCURRENCY;
        const quota = remainingToday;
        const total = pending.length;
        let ok = 0, fail = 0, done = 0;
        let stopped = false;
        const failReasons = {};
        const seenThisRun = new Set();
        const queue = [...pending];

        // 带退避的重试包装:临时失败(网络/超时/429)自动重试 attempts-1 次
        async function withRetry(fn, baseDelay, label) {
            let delay = baseDelay;
            for (let attempt = 1; ; attempt++) {
                try {
                    return await fn();
                } catch (e) {
                    const msg = e.message || "未知异常";
                    const temp = isTempFailure(msg);
                    if (!temp || attempt >= 3) throw e;
                    log("↻ " + label + " 重试 " + attempt + "/2 (" + msg + ")");
                    await new Promise(r => setTimeout(r, delay));
                    delay *= 2;   // 500ms -> 1s -> 2s
                }
            }
        }

        async function worker() {
            while (!stopped && queue.length > 0) {
                const m = queue.shift();
                const hash = magnetHash(m);
                if (seenThisRun.has(hash)) {
                    log("⏭ 跳过重复: " + m.slice(0, 50));
                    done++;
                    continue;
                }
                seenThisRun.add(hash);
                if (ok >= quota) { stopped = true; break; }
                if (isAuthFailed()) { stopped = true; break; }
                await waitIfPaused();

                try {
                    // 1. 解析磁力链(临时失败自动重试)
                    const rr = await withRetry(() => resolveUrl(m, token), 500, "解析");
                    if (rr.status !== 200 || (rr.body && rr.body.code !== 0 && rr.body.code != null)) {
                        const msg = (rr.body && (rr.body.msg || rr.body.message)) || ("HTTP " + rr.status);
                        fail++;
                        failReasons["解析失败: " + msg] = (failReasons["解析失败: " + msg] || 0) + 1;
                        if (!isTempFailure(msg)) markFailed(hash, "解析失败: " + msg);
                        log("✗ 解析失败: " + m.slice(0, 50) + " → " + msg);
                        if (isQuotaExceeded(msg)) {
                            log("⚠ 今日云添加次数已超限,立即停止。剩余磁力明天再跑(记忆断点已保存)");
                            stopped = true; break;
                        }
                        if (isTempFailure(msg)) concurrency = Math.max(MIN_CONCURRENCY, concurrency - 1);
                        done++;
                        continue;
                    }
                    // 2. 创建任务(临时失败自动重试)
                    const ct = await withRetry(() => createTask(m, token, { parentId }), 500, "提交");
                    const cbody = ct.body && typeof ct.body === "object" ? ct.body : null;
                    const ccode = cbody ? cbody.code : null;
                    if (ccode === 0 || (cbody && ccode == null && ct.status === 200)) {
                        ok++;
                        markSubmitted(hash);
                        bumpDailyCount();
                        bumpTotal();
                        if (concurrency < MAX_CONCURRENCY) concurrency++;   // 恢复并发
                        log("✓ 已添加: " + m.slice(0, 60));
                    } else {
                        const msg = (cbody && (cbody.msg || cbody.message)) || ("HTTP " + ct.status);
                        fail++;
                        failReasons[msg] = (failReasons[msg] || 0) + 1;
                        if (!isTempFailure(msg)) markFailed(hash, msg);
                        log("✗ 添加失败: " + m.slice(0, 50) + " → " + msg);
                        if (isQuotaExceeded(msg)) {
                            log("⚠ 今日云添加次数已超限,立即停止。剩余磁力明天再跑(记忆断点已保存)");
                            stopped = true; break;
                        }
                        if (isTempFailure(msg)) concurrency = Math.max(MIN_CONCURRENCY, concurrency - 1);
                    }
                } catch (e) {
                    const msg = e.message || "未知异常";
                    fail++;
                    failReasons["异常: " + msg] = (failReasons["异常: " + msg] || 0) + 1;
                    if (!isTempFailure(msg)) markFailed(hash, "异常: " + msg);
                    log("✗ 异常: " + m.slice(0, 50) + " → " + msg);
                }
                done++;
                if (done % 5 === 0 || done === total) {
                    setProgress(Math.round(done / total * 100), "提交 " + done + "/" + total + " (成功 " + ok + "/" + quota + " 失败 " + fail + ")");
                }
                await new Promise(r => setTimeout(r, 400));   // 基础间隔,防洪峰
            }
        }

        setProgress(0, "开始提交 0/" + total);
        const workers = [];
        for (let w = 0; w < concurrency; w++) workers.push(worker());
        await Promise.all(workers);

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
    const inject = () => {
        if (location.hostname.includes("guangyapan.com")) {
            startCapture();
            buildUI();
        }
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject);
    else inject();

    // 控制台暴露
    window.gyTxtCloud = {
        extractMagnets: extractLineMagnet, runBatch, getAccessToken, setToken,
        memory: {
            getSubmittedMap, isSubmitted, markSubmitted,
            getTodayCount, todayLimitReached, getTotalSubmitted,
            clearAllMemory, todayStr,
            dailyLimit: getDailyLimit(),
        },
        failed: {
            getFailedMap, isFailed, markFailed, isTempFailure,
        },
        backup: {
            exportMemory, importMemory,
        },
    };
    console.log("[gy-txt] 已加载。API: window.gyTxtCloud, 记忆: .memory, 失败黑名单: .failed, 备份: .backup");
})();
