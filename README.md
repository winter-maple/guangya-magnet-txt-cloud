# 光鸭网盘 - txt 磁力链接批量云添加

油猴(Tampermonkey)脚本:选择本地 txt 文件,自动提取里面的磁力链接/种子 URL,批量云添加到光鸭网盘。

基于光鸭官方 API `cloudcollection/v1` 逆向实现,自动处理鉴权、记忆去重、每日限额。

## 功能

- 📄 **txt 批量导入**:选本地 txt,自动识别磁力链接(magnet / 40hex / 32base32 大小写 / .torrent URL / ed2k)
- 🔍 **抓取本页**:扫描当前页面 DOM 里的磁力链接/纯哈希/.torrent,不进 txt 也能传
- 🔑 **自动鉴权**:拦截网页版真实请求头,自动提取 token + did + smid,持久化存储;手动设置 token 立即生效
- 🧠 **记忆去重**:已成功提交的自动跳过,支持断点续跑
- ❌ **失败黑名单**:永久失败的磁力链下次不再上传(临时失败如网络/超时/5xx/限频自动重试,不拉黑)
- 📅 **每日限额**:默认每天最多 1000 次(面板可配置),失败不占名额,成功数满额自动停
- ⚡ **并发提交**:3 路并发,遇 429/限频真正降为 1 路,恢复后自动回升
- 🔁 **自动重试**:临时失败自动重试 2 次(指数退避 500ms→1s→2s)
- 📁 **文件夹选择**:搜索或列出光鸭文件夹(自动分页),选择目标保存位置
- ⏸ **暂停/继续**:随时暂停上传,恢复后断点继续
- 💾 **导出/导入记忆**:删脚本前导出备份,重装后导入恢复
- 🚀 **防卡死**:4MB 流式解析大文件、15s 请求超时、日志批量渲染、记忆内存缓存

## 更新记录

### v1.3.0

- 修复 `@run-at document-start` 白给:注入逻辑原本挂在 `DOMContentLoaded`,首屏鉴权请求全漏。拦截器现在在 document-start 同步挂载,UI 仍等 body
- 修复 token 整批锁死:`runBatch` 开头取一次 token,刷新/轮换后整批报废。改为每步现取,失效时等待页面重新捕获(最多 20s)
- 修复 5xx 不重试:`apiPost` 永不 reject,`withRetry` 形同虚设。业务错误现在带 `httpStatus`,5xx/429/超时/网络错误都进重试
- 修复 token 失效死循环:页面把同一枚死 token 重新塞回请求头时不再被采纳(失效指纹比对)
- 修复 `importMemory` 只写存储不刷内存缓存,本会话内失败黑名单仍读旧 map
- 修复每日计数跨标签页 read-modify-write 丢计数;新增 `GM_addValueChangeListener` 同步
- 修复 `markFailed` 超上限时每条失败都全量 sort;改为每分钟最多整理一次、批量淘汰 10%
- 修复每次捕获 Authorization 头都写一次 GM 存储;改为去重 + 60s 节流
- 修复 `TEMP_FAIL_RE` 误报:`generate` 命中 `rate`、`剩余 500 次` 命中 `5\d\d`
- 修复同 infohash 不同 `tr`/`dn` 被当成多条重复提交;去重键统一为 infohash
- 修复一行两条 magnet 被贪婪正则吞成一条
- 修复 `window.gyTxtCloud.memory.dailyLimit` 是启动快照;改为 getter/setter
- 并发恢复从"成功一次就拉满"改为 34% 概率回升,避免与降档形成锯齿
- 请求节流从"每个 worker 各睡 400ms"改为派发端统一节流;429 触发 5s 全局冷却
- 存储层加降级:GM 对象写入失败时退化为 JSON 字符串,读取侧两者兼容

### v1.2.0

- 修复自适应并发失效:并发数此前只用于初始化 worker,降/升都不生效
- 修复额度竞态:改为"成功 + 在途"原子占用,并发下不会越过每日上限
- 修复 base32 漏识别:大写/小写 base32 都能识别,magnet 链完整保留 `dn`/`tr` 参数
- 修复手动设置 token 无效:设置后清除失效标记,无需刷新页面
- 修复 5xx 与中文限频提示被永久拉黑;`rate limit` 不再误判为额度耗尽
- 修复请求无超时导致整批卡死;大文件改为流式解析
- 文件夹列表/搜索支持分页;面板关闭后可从悬浮按钮重开
- `@run-at document-start`,能拦截首屏鉴权请求

## 安装

1. 先给浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 把 [guangya-txt-cloud-add.user.js](guangya-txt-cloud-add.user.js) 拖进 Tampermonkey 新建脚本,或复制内容粘贴保存
3. 打开光鸭网盘网页版并登录
4. 刷新页面,右下角出现悬浮面板

## 使用

1. **🔍 搜索文件夹**(可选):输入关键字搜索光鸭里的文件夹,选择目标保存位置
2. **📄 选择 txt 文件**:选你的磁力列表 txt,脚本自动解析
3. 检查统计信息(已提交跳过/失败跳过/今日额度)
4. **▶ 开始上传**:确认后开始批量云添加
5. 上传中可 **⏸ 暂停** / **▶ 继续**

## 参数

| 项 | 说明 | 默认 |
|---|---|---|
| 每日限额 | 面板"每日限额"输入框可改,存 GM 存储 | 1000 |
| 并发数 | 3 路并发,遇 429/限频自动降为 1,恢复后回升 | 3 |
| 限频 | 每个磁力提交基础间隔 400ms + 失败重试退避 500ms→1s→2s | — |
| 记忆存储 | `gy_submitted_map` 等 GM 存储 | 跟随脚本 |

## 原理

脚本通过拦截光鸭网页版的真实 API 请求(`Authorization: Bearer` + `did` + `smid` + `dt` + `traceparent` 头)自动获取鉴权信息,然后直接调用光鸭官方 API:

```
解析磁力链: POST /cloudcollection/v1/resolve_res
创建任务:   POST /cloudcollection/v1/create_task
任务列表:   POST /cloudcollection/v1/list_task
搜索文件夹: POST /userres/v1/file/search_files
```

## 注意事项

- 脚本自动从网页版请求头捕获 token,登录后无需手动配置
- 已提交/失败的磁力链存本地 GM 存储,删脚本前请 **💾 导出记忆** 备份
- 遵守光鸭每日限额,超限自动停止,次日自动恢复

## License

MIT
