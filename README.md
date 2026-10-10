<div align="center">

# QuarkDownloader

**夸克网盘分享链接批量下载工具**

[![Tauri 2](https://img.shields.io/badge/Tauri-2.0-blue?logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS-lightgrey)]()

一个基于 **Tauri 2 + React 19** 构建的跨平台桌面应用，用于解析夸克网盘分享链接并批量下载文件。
支持扫码登录、Cookie 登录（含后端校验）、递归目录解析、文件树展示、可调并发批量下载。

**绿色便携版** — 无需安装，双击即用（exe 与 `WebView2Loader.dll` 需放在同一目录）；Windows 同时提供 MSI / NSIS 安装包  ☛[前往 Releases 下载](https://github.com/OUT8486/QuarkDownloader/releases)

</div>

---

## ✨ 功能特性

- **双模式登录** — 支持夸克 APP 扫码登录和手动 Cookie 输入（保存前自动校验有效性），自动管理 Cookie 生命周期
- **智能链接解析** — 粘贴分享链接自动提取，支持带提取码 / 子目录的链接格式
- **递归目录扫描** — 自动遍历分享链接中的所有子目录，完整还原文件树结构
- **可视化文件树** — 树形展示分享内容，支持展开/折叠、按类型图标区分、勾选下载
- **多线程分片下载** — Rust 原生并行下载引擎，默认每文件 16 线程（可调范围 1–64），≥ 10 MiB 文件自动启用 HTTP Range 分片加速，小文件回退单线程；实时速度与进度反馈，支持暂停/继续与一键取消
- **批量并发处理** — 支持 1-10 文件并发度调节，自动完成「转存 → 获取直链 → 下载到本地 → 清理转存文件」全流程
- **暂停 / 继续** — 暂停时任务不退出（挂起等待、已下进度与临时分片全部保留），恢复后接着下；与取消互不干扰，取消会顺带清理半成品与临时目录
- **下载管理** — 每个文件都是一条独立任务（排队中 / 转存中 / 准备中 / 下载中 / 已暂停 / 已完成 / 失败 / 已取消），可在「下载管理」页对**单个任务**暂停、继续、取消、移除，也可一键全部暂停 / 继续 / 取消；暂停的任务不占用并发额度，不会阻塞队列里的其它文件
- **解析历史** — 自动记录解析过的分享链接（文件数 / 目录数 / 总大小 / 时间），支持一键重新解析、单条删除与清空，最多保留 50 条
- **软件设置** — 自定义下载目录（原生目录选择器 + 绝对路径/写权限校验，保存前会实际写入探针文件验证）、调节每文件线程数与文件并发度、管理解析历史、在文件管理器中打开下载目录
- **绕过限速机制** — 使用特殊UA，绕过夸克23018错误
- **容量信息展示** — 登录后自动获取并展示网盘容量使用情况
- **流畅动效体验** — 基于 Framer Motion 的全局过渡动画，毛玻璃 UI 设计风格
- **单文件分发** — 后端 API 代理已内嵌至 Rust 二进制，无需外部依赖，开箱即用
- **跨平台支持** — 支持 Windows (x64 / ARM64) 和 macOS (x64 / ARM64 / Universal)

---

## 🏗 架构说明

```
┌──────────────────────────────────────────────────┐
│              Tauri 2 (单一 Rust 进程)             │
│                                                  │
│  ┌──────────────┐    ┌────────────────────────┐  │
│  │  WebView     │    │  内嵌 HTTP 服务 (axum) │  │
│  │  React 19    │◄──►│  127.0.0.1:3000        │  │
│  │  frontend/   │    │  API 代理              │  │
│  └──────────────┘    └──────────┬─────────────┘  │
│                                 │                 │
└─────────────────────────────────┼─────────────────┘
                                  │ HTTPS
                            夸克网盘 API / CDN
                  (pan.quark.cn / drive.quark.cn)
```

| 层级 | 技术 | 说明 |
|------|------|------|
| **Tauri Shell** | Rust + Tauri v2 | 桌面窗口容器 + 多线程下载引擎 + 内嵌 HTTP 服务 |
| **内嵌 API 服务** | axum + reqwest | 替代原 Node.js sidecar，编译到同一二进制中，随窗口自动启停 |
| **Frontend** | React 19 + TypeScript + Vite 6 + TailwindCSS + Zustand + Axios | 单页应用，通过 HTTP 调用内嵌 API 服务 |

**数据流**：
- API 调用：`前端 → Axios(http://127.0.0.1:3000/api/*) → 内嵌 axum 服务 → HTTPS → 夸克网盘官方 API`
- 文件下载：`前端 → Tauri IPC(invoke) → Rust 多线程下载引擎(reqwest · 默认每文件 16 线程分片，可调 1–64) → HTTPS → CDN`

---

## 🚀 快速开始

### 环境要求

| 工具 | 版本要求 |
|------|----------|
| [Node.js](https://nodejs.org/) | >= 18.x |
| [Rust](https://www.rust-lang.org/tools/install) | >= 1.77.2 |
| [Tauri CLI](https://v2.tauri.app/start/prerequisites/) | v2.x |

> **Windows 用户**：需安装 [Microsoft Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
> **macOS 用户**：需安装 Xcode Command Line Tools：`xcode-select --install`
>
> **Rust 版本下限为何是 1.77.2**：`src-tauri/Cargo.lock` 锁定 tauri **2.12.2**（在 `Cargo.toml` 中声明为 `>= 2.11.1`），上游声明的 `rust-version = "1.77.2"`，低于此版本的编译器无法构建。

> **关于 Tauri 版本**：`src-tauri/Cargo.toml` 要求 `tauri >= 2.11.1` —— 2.11.1 之前的版本在未配置 AppManifest 时存在 IPC/ACL 安全问题（自定义命令可被远程来源调用），**请勿降级**。升级 `Cargo.toml` 里的版本后记得刷新锁文件（`cargo update -p tauri`，或直接跑一次 `cargo build` 让 Cargo 重写 `Cargo.lock`）。

### 安装依赖

```bash
# 克隆项目
git clone https://github.com/OUT8486/QuarkDownloader.git
cd QuarkDownloader

# 安装根目录依赖
npm install

# 安装前端依赖
cd frontend && npm install && cd ..
```

### 开发模式

```bash
npm run tauri:dev
```

一条命令即可启动 Tauri 桌面开发模式（自动编译 Rust + 启动前端 dev server + 内嵌 API 服务）。

### 构建生产版本

```bash
npm run tauri:build
```

#### 分平台 / 分架构构建

| 命令 | 平台 | 产物 |
|------|------|------|
| `npm run tauri:build` | 当前平台默认架构 | Windows：便携 exe + MSI + NSIS 安装包；macOS：.app + .dmg |
| `npm run tauri:build:win-x64` | Windows x86_64 | 便携 exe + MSI + NSIS 安装包 |
| `npm run tauri:build:win-arm64` | Windows ARM64 | 便携 exe + MSI + NSIS 安装包 |
| `npm run tauri:build:mac-x64` | macOS Intel | .app + .dmg |
| `npm run tauri:build:mac-arm64` | macOS Apple Silicon | .app + .dmg |
| `npm run tauri:build:mac-universal` | macOS 通用二进制 | .app + .dmg (兼容所有 Mac) |

> `src-tauri/tauri.conf.json` 中 `bundle.targets` 为 `"all"`，所以 Windows 除了独立便携 exe，还会额外生成 MSI 与 NSIS 安装包。
> 各脚本中的 `-t <target-triple>` 是 Tauri CLI 自身的 `--target` 参数（不要写成 `-- --target`，那样会被当成传给 cargo runner 的参数）。

> 交叉编译需先安装对应 target：`rustup target add <target-triple>`

> **Windows 产物必须带 `WebView2Loader.dll`**：本项目的 Windows 构建使用 `x86_64-pc-windows-gnu`（GNU）工具链，Tauri 的 WebView2 绑定在 GNU 下是**动态链接**（只有 MSVC 工具链才会静态链接进 exe），因此 `QuarkDownloader.exe` 必须与 `WebView2Loader.dll` 放在同一目录才能启动 —— 单独把 exe 拷到别处会一闪而过（缺 DLL，退出码 `0xC0000135`）。MSI / NSIS 安装包与免安装 ZIP 都已包含该 DLL，配置见 `src-tauri/tauri.windows.conf.json`。

#### 产物路径

| 平台 | 产物 | 路径 |
|------|------|------|
| **Windows** | 独立便携 exe，双击直接运行 | `src-tauri/target/release/QuarkDownloader.exe` |
| **Windows** | MSI 安装包 | `src-tauri/target/release/bundle/msi/*.msi` |
| **Windows** | NSIS 安装包（`*-setup.exe`） | `src-tauri/target/release/bundle/nsis/*.exe` |
| **macOS** | .app + .dmg | `src-tauri/target/release/bundle/macos/` 和 `bundle/dmg/` |

> 上表为 `npm run tauri:build`（不带 `--target`，使用宿主默认架构）的路径。使用 `npm run tauri:build:<平台>` 时因为指定了 target triple，产物位于 `src-tauri/target/<target-triple>/release/` 下，其后的目录结构与上表一致。

---

## 📖 使用指南

### 1. 登录账号

启动应用后，点击侧边栏 **「立即登录」** 按钮，选择登录方式：

- **扫码登录**：点击「获取二维码」，使用夸克 APP 扫码，二维码有效期 120 秒
- **Cookie 登录**：打开 [pan.quark.cn](https://pan.quark.cn) 登录后，从浏览器 DevTools 提取 Cookie 并粘贴，点击「保存配置」后会自动向后端校验有效性

### 2. 解析分享链接

在搜索栏粘贴夸克网盘分享链接（支持带提取码），点击 **「解析提取」** 或按 Enter 键。

支持的链接格式：
```
https://pan.quark.cn/s/xxxxxxxxx
https://pan.quark.cn/s/xxxxxxxxx?pwd=xxxx
https://pan.quark.cn/s/xxxxxxxxx#/list/share/xxxx
```

### 3. 选择并下载文件

- 解析完成后，文件以树形结构展示，支持展开/折叠目录
- 勾选需要下载的文件（支持「全选」）
- 并发度与每文件线程数在 **「软件设置」** 中调节（下载面板上也会实时显示当前值）
- 点击 **「开始任务」** 启动批量下载
- 下载流程全自动：转存 → 获取直链 → Rust 多线程分片下载到本地 → 清理转存文件

### 4. 下载管理（逐任务控制）

点「开始任务」后，每个文件都会在 **「下载管理」** 页生成一条任务，状态依次为：排队中 → 转存中 → 准备中 → 下载中 → 已完成（或 已暂停 / 失败 / 已取消）。

**逐任务操作**（每一行右侧）：

| 按钮 | 可用状态 | 行为 |
|------|----------|------|
| **暂停** | 排队中 / 转存中 / 准备中 / 下载中 | 已在下载的任务在 chunk 之间挂起（连接与临时分片保留），恢复后从当前进度继续；还没进入下载阶段的任务会被前端闸门挡住，**不会开始下载**（注意：已经发出的转存请求无法中断，网盘侧仍会完成这一次转存，随后按正常流程清理）。**暂停的任务不占并发额度**，队列里的其它文件照常下载 |
| **继续** | 已暂停 | 唤醒该任务，从当前进度接着下；若暂停过久导致连接被判超时，该分片会自动整片重试（不会错位） |
| **取消** | 任意进行中的状态 | **只结束这一个任务**：删除它的半成品与临时分片、清理网盘侧转存文件，其它任务不受影响 |
| **移除** | 已完成 / 失败 / 已取消 | 只从列表里移除记录，不动磁盘文件 |

页面顶部还有批次级操作：**全部暂停 / 全部继续 / 全部取消**，以及 **清理已结束**（一次性移除所有已完成/失败/已取消的行）。

下载面板（勾选文件后自动弹出）保留同一套批次按钮与实时日志；顶部进度岛显示正在进行的任务。

> 暂停是内存态：程序退出或页面刷新后不保留（刷新本身等价于取消）。
> 批次「取消」= 取消全部任务并递增取消代际；单任务「取消」只影响该行。

### 5. 解析历史

侧边栏 **「解析历史」** 会记录每次成功解析的分享链接：

- 展示：分享链接、解析时间、文件数 / 目录数 / 总大小
- **重新解析**：回到「解析提取」页并用原链接（含提取码）重新解析一次 —— 不直接复用旧数据，因为分享令牌会过期，重新解析拿到的一定是有效令牌
- **删除** / **清空全部**：只影响本机记录（存在浏览器 localStorage，不上传）
- 最多保留 50 条，同一链接重复解析只更新最新一条

### 6. 软件设置

侧边栏 **「软件设置」**：

- **下载目录**：可手动填写绝对路径（如 `D:\Downloads`），或点 **浏览…** 用系统目录选择器选取；保存前会校验"是否为绝对路径、是否指向文件、能否创建、是否可写"，通过后才写入配置
  - **恢复默认**：清除自定义目录，回到系统「下载」文件夹
  - **打开目录**：在资源管理器中打开当前生效的下载目录
  - 配置文件位置：`%APPDATA%\com.quark.downloader\settings.json`
- **下载线程 / 同时下载**：即每文件分片线程数（1–64，默认 16）与文件并发度（1–10，默认 5）
- **解析历史**：查看条数、一键清空

### 7. 退出登录

侧边栏底部点击 **「退出登录」**，会同时清除本地 Cookie 并通知夸克服务端注销。

---

## 📁 项目结构

```
QuarkDownloader/
├── frontend/                    # 前端 React SPA
│   ├── src/
│   │   ├── components/          # 通用 UI 组件
│   │   │   ├── ui/              # 基础组件 (Button, Card, Dialog, Checkbox...)
│   │   │   ├── MainLayout.tsx   # 主布局框架（侧边栏 + Toast + 全局进度条）
│   │   │   ├── Sidebar.tsx      # 侧边栏导航
│   │   │   └── TitleBar.tsx     # 自定义无边框标题栏
│   │   ├── features/            # 业务功能模块
│   │   │   ├── auth/            # 登录认证（扫码 + Cookie，含后端校验）
│   │   │   ├── share-parse/     # 分享链接解析
│   │   │   ├── file-tree/       # 文件树展示
│   │   │   ├── download/        # 下载管理器（批次工具栏 + 任务调度 + 逐任务控制）
│   │   │   ├── manager/         # 下载管理页（任务列表：逐任务 暂停/继续/取消/移除）
│   │   │   ├── history/         # 解析历史
│   │   │   ├── settings/        # 软件设置（下载目录 / 线程 / 并发）
│   │   │   ├── capacity/        # 容量统计
│   │   │   └── help/            # 帮助与关于
│   │   ├── services/
│   │   │   ├── http.ts          # Axios 实例（拦截器自动注入 Cookie）
│   │   │   └── quarkApi.ts      # 夸克网盘 API 封装
│   │   ├── store/
│   │   │   └── useQuarkStore.ts # Zustand 全局状态
│   │   ├── types/quark.ts       # TypeScript 类型定义
│   │   └── utils/index.ts       # 工具函数
│   ├── package.json
│   ├── .env.example             # 前端环境变量示例（复制为 .env.local）
│   ├── vite.config.ts
│   └── tailwind.config.js
│
├── src-tauri/                   # Tauri 桌面容器 + 内嵌 API 服务
│   ├── src/
│   │   ├── main.rs              # Rust 入口，启动 Tauri 窗口 + 内嵌 axum 服务 + 下载引擎/取消/暂停
│   │   ├── api_server.rs        # axum HTTP 路由（全部 API 端点 + 流式下载代理）
│   │   ├── quark_client.rs      # 夸克 API 代理核心（reqwest HTTP 客户端）
│   │   └── settings.rs          # 设置持久化（下载目录）与路径校验
│   ├── capabilities/            # Tauri 权限配置
│   ├── icons/                   # 应用图标
│   ├── tauri.conf.json          # Tauri 核心配置
│   └── Cargo.toml               # Rust 依赖
│
├── .github/
│   └── workflows/release.yml    # 发布流水线（lint 校验 + 三平台构建）
│
├── package.json                 # 根 monorepo 脚本
└── README.md
```

---

## 🛠 技术栈

### 前端

| 技术 | 版本 | 用途 |
|------|------|------|
| [React](https://react.dev/) | 19 | UI 框架 |
| [TypeScript](https://www.typescriptlang.org/) | 5.7 | 类型安全 |
| [Vite](https://vite.dev/) | 6 | 构建工具 |
| [TailwindCSS](https://tailwindcss.com/) | 3.4 | 原子化 CSS |
| [Zustand](https://zustand.docs.pmnd.rs/) | 5 | 状态管理 |
| [Axios](https://axios-http.com/) | 1.7 | HTTP 客户端 |
| [Radix UI](https://www.radix-ui.com/) | latest | 无障碍基础组件 |
| [Framer Motion](https://motion.dev/) | 12 | 动画引擎 |
| [Lucide React](https://lucide.dev/) | latest | 图标库 |
| [qrcode.react](https://github.com/zpao/qrcode.react) | 4 | 二维码生成 |

### Rust 后端（内嵌于 Tauri 二进制）

| 技术 | 版本 | 用途 |
|------|------|------|
| [Tauri](https://v2.tauri.app/) | 2 | 桌面应用框架 |
| [axum](https://github.com/tokio-rs/axum) | 0.8 | 内嵌 HTTP 服务框架 |
| [reqwest](https://github.com/seanmonstar/reqwest) | 0.12 | HTTPS 客户端，代理请求至夸克 API |
| [tokio](https://tokio.rs/) | 1 | 异步运行时 |
| [tower-http](https://github.com/tower-rs/tower-http) | 0.6 | CORS 中间件 |
| [serde](https://serde.rs/) / [serde_json](https://github.com/serde-rs/json) | 1 | JSON 序列化 |

---

## 🔌 API 接口

内嵌 axum 服务作为代理层，将前端请求转发至夸克官方 API：

| 本地接口 | 说明 |
|----------|------|
| `GET  /api/health` | 健康检查 |
| `GET  /api/qrlogin/token` | 获取扫码登录 Token |
| `GET  /api/qrlogin/query` | 轮询扫码登录状态 |
| `GET  /api/qrlogin/cookie` | 用 service_ticket 换取完整 Cookie（含多步 __puus 补全） |
| `POST /api/share/token` | 获取分享访问令牌（stoken） |
| `GET  /api/share/detail` | 获取分享文件列表（支持分页） |
| `POST /api/share/save` | 转存文件到自己网盘 |
| `GET  /api/task` | 查询异步任务状态 |
| `POST /api/file/download` | 获取文件下载直链 |
| `POST /api/file/delete` | 删除文件（清理临时转存） |
| `GET  /api/member` | 获取会员/容量信息 |
| `POST /api/logout` | 退出登录（含服务端注销 + 状态验证） |

> Cookie 通过 `x-cookie` 请求头传递，服务端通过 `x-append-cookie` 响应头自动补全。

---

## ❓ 常见问题

**Q：提示「本地接口服务不可用（127.0.0.1:3000 可能被其它程序占用）」怎么办？**

本应用通过内嵌的本地服务（固定 `127.0.0.1:3000`）访问夸克接口。如果该端口已被其它程序（或本应用的另一个实例）占用，应用无法工作。为了避免把登录凭证发给占用该端口的陌生程序，前端会**先探测服务身份**（`/api/health`），确认不是本应用就拒绝发送任何请求。解决办法：关闭占用 3000 端口的程序（或退出多余的实例）后重启本应用。

**Q：为什么我的网盘里会多出文件？**

批量下载采用「先转存到自己网盘 → 取直链 → 下载 → 删除转存文件」的方式。正常情况下转存文件会在拿到直链后立即删除；若转存轮询超时（网络较慢），该文件可能残留在网盘根目录，应用会在日志里给出提示，可手动删除。

**Q：下载的临时分片在哪里？中断后会不会留垃圾？**

大文件会被切成多个分片放在下载目录下的 `.quark_temp_*` 临时文件夹里，合并完成后自动清理；下载失败或被取消时也会清理。程序被强制结束时可能残留该目录，手动删除即可（不影响已完成的文件）。

**Q：日志在哪里看？**

解析页与下载面板都有实时日志（最近 6 条），下载管理页有每个任务的状态与失败原因。开发模式下运行还可以在终端看到后端日志（下载目录、接口服务、取消/暂停等）。

---

## 🤝 贡献指南

欢迎贡献代码！请遵循以下流程：

1. **Fork** 本仓库
2. 创建功能分支：`git checkout -b feature/your-feature`
3. 提交更改：`git commit -m 'feat: add your feature'`
4. 推送分支：`git push origin feature/your-feature`
5. 提交 **Pull Request**

### 开发规范

- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范
- 前端代码使用 ESLint 检查：`npm run lint`（等价于 `cd frontend && npm run lint`），CI 的 release 流水线会执行同一命令
- 组件按功能模块组织在 `features/` 目录下
- 通用 UI 组件放置在 `components/ui/` 目录下

---

## 🙏 鸣谢

- [muyan556/gopeed-extension-quark](https://github.com/muyan556/gopeed-extension-quark) — 核心解析逻辑参考

---

## ⚠️ 免责声明

本软件仅用于**技术学习与交流**，严禁用于任何非法用途。用户在使用过程中的一切行为需自行承担法律责任。开发者不保证软件的绝对稳定性与持续性，请根据需要合理使用。

---

## 📄 License

[MIT](./LICENSE)
