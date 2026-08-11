// ==UserScript==
// @name        光鸭网盘磁力链自动上传 (框架版)
// @namespace   winter-maple
// @version      0.1.0
// @description 光鸭网盘磁力链离线下载自动化框架:提交磁力链接 → 状态轮询 → 自动建目录。接口细节待抓包校准。
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
     * 配置区 — 接口地址(待抓包校准)
     * ------------------------------------------------------------
     * 光鸭 API base(与现有秒传脚本一致):
     *   https://api.guangyapan.com
     *
     * 离线下载接口未知。已知的 gRPC 命名空间模式:
     *   秒传:  nd.bizuserres.s/v1/...
     *   推断:  nd.offline.s / nd.task.s / nd.download.s / nd.bt.s
     *
     * 抓包方法:
     *   1. 打开光鸭网盘,登录
     *   2. 打开离线下载/磁力入口,手动提交一个磁力链接
     *   3. F12 → Network → 找 Name 形如 "get_res_center_token" 的 gRPC 请求
     *   4. 把请求 URL + Request Body + Response 贴给我,我填进来
     * ============================================================ */
    const GUANGYA_API_BASE = "https://api.guangyapan.com";

    // ★ 待抓包确认的接口(先用推断值占位)
    const GUANGYA_URL_OFFLINE_SUBMIT = GUANGYA_API_BASE + "/nd.offline.s/v1/create_task";      // 提交磁力链
    const GUANGYA_URL_OFFLINE_QUERY  = GUANGYA_API_BASE + "/nd.offline.s/v1/get_task";          // 查询任务状态
    const GUANGYA_URL_OFFLINE_LIST   = GUANGYA_API_BASE + "/nd.offline.s/v1/list_task";         // 任务列表

    // 业务码(参考秒传脚本,具体值待校准)
    const CODE_OK = 0;

    const KEY_TOKEN = "guangya_access_token";

    /* ============================================================
     * 登录态复用 — 与现有秒传脚本一致
     * ============================================================ */
    function getAccessToken() {
        let t = String(GM_getValue(KEY_TOKEN, "") || "").trim();
        if (t) return t;
        // 从页面 localStorage 找 token(光鸭前端存的字段名待确认)
        try {
            const keys = ["access_token", "token", "userToken", "user_token"];
            for (const k of keys) {
                const v = localStorage.getItem(k);
                if (v && v.length > 10) {
                    // 可能是 JSON 也可能是裸 token,尽量提取
                    try {
                        const obj = JSON.parse(v);
                        const cand = obj.accessToken || obj.token || obj.access_token;
                        if (cand) return cand;
                    } catch { /* not json */ }
                    if (!/^[{[]/.test(v)) return v;
                }
            }
        } catch (e) { /* ignore */ }
        return "";
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
     * 光鸭请求封装 — 与秒传脚本同款鉴权头
     * ============================================================ */
    function postGuangya(url, data, token) {
        const tok = String(token || "").replace(/^Bearer\s+/i, "").trim();
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "POST",
                url,
                headers: {
                    "Content-Type": "application/json;charset=utf-8",
                    "Authorization": "Bearer " + tok,
                    "dt": "4",
                    "traceparent": createTraceparent(),
                    "Origin": location.origin,
                    "Referer": location.href,
                },
                data: JSON.stringify(data),
                onload: (r) => {
                    try {
                        resolve({ status: r.status, data: JSON.parse(r.responseText) });
                    } catch (e) {
                        resolve({ status: r.status, data: r.responseText });
                    }
                },
                onerror: (e) => reject(new Error("网络错误 " + e.error)),
            });
        });
    }

    /* ============================================================
     * 核心逻辑
     * ============================================================ */
    async function submitMagnet(magnetLink, savePath) {
        const token = getAccessToken();
        if (!token) throw new Error("未找到光鸭 access_token,请先在光鸭网盘登录,或把 token 贴到配置里");

        // ★ 请求体结构待抓包校准 —— 这是推测的字段
        const payload = {
            url: magnetLink,        // 磁力链
            path: savePath || "/",  // 保存路径
            // 可能的其他字段:name, hash, parentId...
        };
        console.log("[guangya-magnet] 提交磁力链:", { url: GUANGYA_URL_OFFLINE_SUBMIT, payload });
        return await postGuangya(GUANGYA_URL_OFFLINE_SUBMIT, payload, token);
    }

    async function queryTask(taskId) {
        const token = getAccessToken();
        if (!token) throw new Error("未找到 access_token");
        // ★ 请求体待校准
        const payload = { taskId: taskId, task_id: taskId };
        return await postGuangya(GUANGYA_URL_OFFLINE_QUERY, payload, token);
    }

    /* ============================================================
     * UI — 悬浮面板
     * ============================================================ */
    function buildUI() {
        if (document.getElementById("guangya-magnet-panel")) return;
        const panel = document.createElement("div");
        panel.id = "guangya-magnet-panel";
        panel.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483646;width:360px;background:#fff;border:1px solid #ccc;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.2);font:13px system-ui;color:#333;";
        panel.innerHTML = `
            <div style="padding:10px 14px;background:#1677ff;color:#fff;border-radius:8px 8px 0 0;font-weight:600;cursor:move;">
                光鸭磁力链自动上传 <span id="gym-status" style="float:right;font-weight:400;font-size:12px;"></span>
            </div>
            <div style="padding:12px;">
                <label style="display:block;margin-bottom:4px;">磁力链接</label>
                <textarea id="gym-magnet" style="width:100%;height:60px;padding:6px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;resize:vertical;" placeholder="magnet:?xt=urn:btih:..."></textarea>
                <label style="display:block;margin:8px 0 4px;">保存路径(可选,默认根目录)</label>
                <input id="gym-path" style="width:100%;padding:6px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;" placeholder="/影视/2026">
                <div style="margin-top:10px;">
                    <button id="gym-submit" style="background:#1677ff;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;">提交磁力链</button>
                    <button id="gym-query" style="background:#67c23a;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;margin-left:6px;">查任务</button>
                </div>
                <div id="gym-log" style="margin-top:10px;max-height:160px;overflow-y:auto;background:#f6f8fa;border:1px solid #eee;border-radius:4px;padding:6px;font-size:12px;font-family:monospace;white-space:pre-wrap;"></div>
            </div>`;
        document.body.appendChild(panel);

        document.getElementById("gym-submit").onclick = async () => {
            const magnet = document.getElementById("gym-magnet").value.trim();
            if (!magnet) { log("请先填磁力链接"); return; }
            log("提交中: " + magnet.slice(0, 60) + "...");
            try {
                const r = await submitMagnet(magnet, document.getElementById("gym-path").value.trim());
                log("响应: " + JSON.stringify(r));
            } catch (e) {
                log("错误: " + e.message);
            }
        };
        document.getElementById("gym-query").onclick = async () => {
            const taskId = prompt("输入任务 ID:");
            if (!taskId) return;
            try {
                const r = await queryTask(taskId);
                log("查询: " + JSON.stringify(r));
            } catch (e) {
                log("错误: " + e.message);
            }
        };
    }

    function log(msg) {
        const el = document.getElementById("gym-log");
        if (el) el.textContent += (new Date().toLocaleTimeString()) + " " + msg + "\n";
    }

    // 页面加载后挂面板
    const inject = () => {
        if (location.hostname.includes("guangyapan.com")) buildUI();
    };
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", inject);
    } else {
        inject();
    }

    // 暴露给控制台方便测试
    window.guangyaMagnet = { submitMagnet, queryTask, getAccessToken };
    console.log("[guangya-magnet] 框架已加载。控制台可用: guangyaMagnet.submitMagnet('magnet:...', '/路径')");
})();
