// 在 release 模式下隐藏 Windows 控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// ── 日志宏 ───────────────────────────────────────────────
// release 版是 GUI 子系统程序：用户双击启动时进程没有控制台，
// stdout/stderr 句柄无效，此时 `log_line!` 会因为写失败而 panic
// （"failed printing to stdout: The handle is invalid"），表现为
// 窗口一闪而过、程序直接退出。所以日志一律用下面这两个宏，
// 写失败就静默忽略；从终端/重定向启动时行为与 log_line! 完全一致。
macro_rules! log_line {
    ($($arg:tt)*) => {{
        use std::io::Write;
        let _ = writeln!(std::io::stdout(), $($arg)*);
    }};
}

macro_rules! log_err {
    ($($arg:tt)*) => {{
        use std::io::Write;
        let _ = writeln!(std::io::stderr(), $($arg)*);
    }};
}

mod api_server;
mod quark_client;
mod settings;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;

/// 全局下载代际计数器（epoch）。
/// 每次取消时 +1，下载任务持有启动时的 epoch，
/// 发现不匹配即知道自己被取消，无需重置标志，天然无竞态。
static DOWNLOAD_EPOCH: AtomicU64 = AtomicU64::new(0);

/// 全局暂停开关。
/// 与"取消"不同：暂停时任务**不退出**，而是挂在 `wait_if_paused()` 里等待，
/// 已经建立的连接与已写入的临时分片都保留，恢复后可接着下。
/// 注意这是内存态：程序退出/页面刷新后暂停状态不保留（刷新本身等价于取消）。
static DOWNLOAD_PAUSED: AtomicBool = AtomicBool::new(false);

/// 判断某 epoch 的下载是否已被取消
fn is_cancelled(epoch: u64) -> bool {
    DOWNLOAD_EPOCH.load(Ordering::Relaxed) != epoch
}

/// 是否处于全局暂停状态（"全部暂停"）
fn is_paused() -> bool {
    DOWNLOAD_PAUSED.load(Ordering::SeqCst)
}

// ── 单任务控制（下载管理：按行 暂停 / 继续 / 取消） ──────

/// 单个下载任务的控制状态，按任务 id（由前端生成并传入）索引
#[derive(Default, Clone, Copy)]
struct TaskState {
    paused: bool,
    cancelled: bool,
}

static TASK_STATES: OnceLock<Mutex<HashMap<String, TaskState>>> = OnceLock::new();

fn task_states() -> &'static Mutex<HashMap<String, TaskState>> {
    TASK_STATES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 访问任务状态表。锁中毒（某次持锁 panic）也继续用旧数据，
/// 避免一次异常让整个"暂停/取消"能力失效。
fn with_task_states<T>(f: impl FnOnce(&mut HashMap<String, TaskState>) -> T) -> T {
    let mut guard = task_states()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut guard)
}

fn task_paused(task_id: &str) -> bool {
    with_task_states(|map| map.get(task_id).map(|s| s.paused).unwrap_or(false))
}

fn task_cancelled(task_id: &str) -> bool {
    with_task_states(|map| map.get(task_id).map(|s| s.cancelled).unwrap_or(false))
}

fn set_task_paused(task_id: &str, paused: bool) {
    with_task_states(|map| {
        map.entry(task_id.to_string()).or_default().paused = paused;
    });
}

fn set_task_cancelled(task_id: &str) {
    with_task_states(|map| {
        map.entry(task_id.to_string()).or_default().cancelled = true;
    });
}

/// 任务结束后清理状态，避免状态表随下载次数无限增长
fn clear_task(task_id: &str) {
    with_task_states(|map| {
        map.remove(task_id);
    });
}

/// 全局取消后一并清空，避免残留的暂停/取消标记影响下一批任务
fn clear_all_tasks() {
    with_task_states(|map| map.clear());
}

/// 暂停闸门：全局暂停或该任务暂停时在此挂起，恢复后继续；
/// 期间若被全局取消（epoch 变化）或该任务被取消，则立即返回错误。
/// 放在分片/单线程的读取循环顶部，所以暂停点一定落在两个 chunk 之间，
/// 不会写出半个 chunk、也不会破坏分片文件的完整性。
async fn wait_if_paused(task_id: &str, epoch: u64) -> Result<(), String> {
    loop {
        if is_cancelled(epoch) || task_cancelled(task_id) {
            return Err("下载已取消".into());
        }
        if !is_paused() && !task_paused(task_id) {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
}

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch";
const MIN_MULTITHREAD_SIZE: u64 = 10 * 1024 * 1024; // 10MB 以下走单线程
/// 每文件默认分片线程数（与前端滑块默认值保持一致）
const DEFAULT_THREADS: usize = 16;
/// 每文件最大分片线程数（与前端滑块上限保持一致）
const MAX_THREADS: usize = 64;
/// 单个分片的最大重试次数
const SEGMENT_MAX_ATTEMPTS: u32 = 3;

// ── 通用工具 ──────────────────────────────────────────────

/// 允许在 WebView 中导航的来源白名单。
/// 打包后前端来自 `tauri://localhost` / `http://tauri.localhost`，开发时来自 Vite dev server。
/// 其它来源一律拒绝，避免主 WebView 被带到远程页面（远程页面一旦加载，
/// 就处在应用自身的 IPC/权限上下文里，是安全上最危险的场景）。
fn is_trusted_origin(url: &url::Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("tauri.localhost") | Some("localhost") | Some("127.0.0.1")
        ),
        _ => false,
    }
}

/// 按字符（而非字节）截断，避免切断 UTF-8 多字节字符导致 panic
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    }
}

/// 只保留文件名本身：剥离任何目录成分（含 Windows 盘符、UNC 前缀与 `..` 穿越）、
/// 非法字符与 Windows 保留设备名，确保输出永远落在下载目录内。
fn sanitize_filename(filename: &str) -> Result<String, String> {
    let base = filename
        .split(['/', '\\'])
        .rfind(|seg| !seg.trim().is_empty())
        .unwrap_or("")
        .trim();
    if base.is_empty() || base == "." || base == ".." {
        return Err("文件名无效".to_string());
    }

    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control()
                || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    // Windows 上文件名不能以点或空格结尾
    let cleaned = cleaned.trim_end_matches(['.', ' ']).to_string();
    if cleaned.is_empty() {
        return Err("文件名无效".to_string());
    }

    // Windows 保留设备名不能作为文件名
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
            | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9"
            | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    );
    let cleaned = if reserved { format!("_{}", cleaned) } else { cleaned };

    // 限制单段文件名长度，避免超出文件系统上限
    Ok(cleaned.chars().take(200).collect())
}

/// 下载直链校验：只接受 http(s)，并拒绝本机/链路本地地址，
/// 避免把本进程变成"任意本地抓取 + 写盘"的工具。
fn validate_download_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("下载地址无效: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("不支持的下载协议: {}", parsed.scheme()));
    }
    let host = parsed.host_str().ok_or_else(|| "下载地址缺少主机名".to_string())?;
    let host_lower = host.to_ascii_lowercase();
    if host_lower == "localhost"
        || host_lower == "0.0.0.0"
        || host_lower == "::1"
        || host_lower.starts_with("127.")
        || host_lower.starts_with("169.254.")
        || host_lower.ends_with(".localhost")
    {
        return Err(format!("拒绝下载本机/链路本地地址: {}", host));
    }
    Ok(())
}

/// 原子预留输出路径：用 `create_new` 占位。
/// 这样并发下载同名文件时，后一个任务会拿到 `name (1).ext` 而不是同一个路径，
/// 从根上消除"两个任务同时写一个文件"的竞态。
fn reserve_save_path(downloads_dir: &Path, filename: &str) -> Result<PathBuf, String> {
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download")
        .to_string();
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_string();

    for i in 0..10_000u32 {
        let candidate = if i == 0 {
            filename.to_string()
        } else if ext.is_empty() {
            format!("{} ({})", stem, i)
        } else {
            format!("{} ({}).{}", stem, i, ext)
        };
        let candidate_path = downloads_dir.join(&candidate);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate_path)
        {
            Ok(_) => return Ok(candidate_path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("创建文件失败: {}", e)),
        }
    }

    Err("同名文件过多，无法生成可用的文件名".to_string())
}

/// 分片区间计算：连续、不重叠、完整覆盖 `0..total_size-1`。
/// 分片数会被限制为不超过总字节数，避免出现 0 长度区间与 `- 1` 下溢。
fn build_segments(total_size: u64, thread_count: usize) -> Vec<(u64, u64)> {
    if total_size == 0 {
        return Vec::new();
    }
    let cap = thread_count.clamp(1, MAX_THREADS);
    let count = total_size.min(cap as u64).max(1) as usize;
    let segment_size = total_size / count as u64;

    (0..count)
        .map(|i| {
            let start = i as u64 * segment_size;
            let end = if i == count - 1 {
                total_size - 1
            } else {
                (i as u64 + 1) * segment_size - 1
            };
            (start, end)
        })
        .collect()
}

/// 任务临时目录名：由前端传入的任务 id 派生。
/// 这样同一个任务在应用重启后还能找回上次留下的分片（进程被强杀时 RAII 不会执行，
/// 分片目录与日志会留在磁盘上），从而实现真正的断点续传。
fn sanitize_task_key(task_id: &str) -> String {
    let cleaned: String = task_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(48)
        .collect();
    if cleaned.is_empty() {
        "task".to_string()
    } else {
        cleaned
    }
}

fn temp_dir_for(downloads_dir: &Path, task_id: &str) -> PathBuf {
    downloads_dir.join(format!(".quark_temp_{}", sanitize_task_key(task_id)))
}

/// 断点续传日志：记录上次的输出路径与分片划分，重启后据此接着下。
const RESUME_JOURNAL_FILE: &str = "state.json";
const RESUME_JOURNAL_VERSION: u32 = 1;

#[derive(serde::Serialize, serde::Deserialize)]
struct ResumeJournal {
    version: u32,
    save_path: String,
    total_size: u64,
    segments: Vec<(u64, u64)>,
}

/// 续传方案：上次的日志 + 临时目录（分片文件就在里面）
struct ResumePlan {
    journal: ResumeJournal,
    temp_dir: PathBuf,
}

fn read_resume_journal(temp_dir: &Path) -> Option<ResumeJournal> {
    let raw = std::fs::read_to_string(temp_dir.join(RESUME_JOURNAL_FILE)).ok()?;
    let journal: ResumeJournal = serde_json::from_str(&raw).ok()?;
    if journal.version != RESUME_JOURNAL_VERSION || journal.segments.is_empty() {
        return None;
    }
    Some(journal)
}

fn write_resume_journal(temp_dir: &Path, journal: &ResumeJournal) {
    match serde_json::to_string(journal) {
        Ok(raw) => {
            if let Err(e) = std::fs::write(temp_dir.join(RESUME_JOURNAL_FILE), raw) {
                log_err!("[download] 写入续传日志失败: {}", e);
            }
        }
        Err(e) => log_err!("[download] 序列化续传日志失败: {}", e),
    }
}

/// 解析本次下载的输出路径：续传时复用上次的路径，否则原子预留一个新名字。
fn resolve_save_target(
    downloads_dir: &Path,
    filename: &str,
    task_id: &str,
    want_resume: bool,
) -> Result<(PathBuf, Option<ResumePlan>), String> {
    if want_resume {
        let temp_dir = temp_dir_for(downloads_dir, task_id);
        if let Some(journal) = read_resume_journal(&temp_dir) {
            let path = PathBuf::from(&journal.save_path);
            // 只接受仍在当前下载目录下的路径：用户改过下载目录就重新开始，避免写到别处
            if path.parent() == Some(downloads_dir) {
                if !path.exists() {
                    // 预留时创建的占位文件可能已被清理：重建一个空文件，续传不依赖它的长度
                    std::fs::OpenOptions::new()
                        .write(true)
                        .create(true)
                        .truncate(false)
                        .open(&path)
                        .map_err(|e| format!("创建文件失败: {}", e))?;
                }
                return Ok((path, Some(ResumePlan { journal, temp_dir })));
            }
        }
    }

    Ok((reserve_save_path(downloads_dir, filename)?, None))
}

/// 单线程下载同样登记续传日志。单线程没有 Range，做不到字节级续传，
/// 但记下输出路径后，应用被杀再重启时会复用同一个文件名，
/// 而不是留下一个截断的旧文件、再另外下一个「xxx (1).ext」。
async fn register_single_thread_resume(
    save_path: &Path,
    total_size: u64,
    task_id: &str,
) -> TempDirGuard {
    let downloads_dir = save_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    let temp_dir = temp_dir_for(&downloads_dir, task_id);
    let _ = tokio::fs::create_dir_all(&temp_dir).await;
    write_resume_journal(
        &temp_dir,
        &ResumeJournal {
            version: RESUME_JOURNAL_VERSION,
            save_path: save_path.to_string_lossy().to_string(),
            total_size,
            segments: vec![(0, total_size.saturating_sub(1))],
        },
    );
    TempDirGuard(temp_dir)
}

/// 临时分片目录的 RAII 清理器：任何提前返回（含 `?`）都会尝试删除该目录，
/// 不会把上千个分片留在用户的下载目录里。
struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(30))
        // 读取超时 = 两次读取之间的最大间隔。没有它时，一条半死不活的 CDN 连接
        // 会让 `resp.chunk()` 永远挂住；而取消只在读取间隙检查，届时连取消都无效。
        .read_timeout(std::time::Duration::from_secs(60))
        .tcp_keepalive(std::time::Duration::from_secs(60))
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .http1_only()
        .build()
        .map_err(|e| format!("创建下载客户端失败: {}", e))
}

fn add_headers(req: reqwest::RequestBuilder, cookie: &str) -> reqwest::RequestBuilder {
    let req = req
        .header("User-Agent", UA)
        .header("Referer", "https://pan.quark.cn/")
        .header("Accept", "*/*")
        .header("Accept-Language", "zh-CN,zh;q=0.9")
        .header("Accept-Encoding", "identity")
        .header("Connection", "keep-alive");
    if cookie.is_empty() {
        req
    } else {
        req.header("Cookie", cookie)
    }
}

/// 手动跟随 302 重定向，返回 (最终URL, 响应)。
/// 注意：跨主机跳转时会剥离 Cookie，避免把夸克会话泄露给重定向链上的第三方主机。
async fn follow_redirects(
    client: &reqwest::Client,
    url: &str,
    cookie: &str,
) -> Result<(String, reqwest::Response), String> {
    let mut current_url = url.to_string();
    let mut redirects = 0u32;
    let mut current_cookie = cookie.to_string();
    let mut current_host = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()));

    loop {
        if redirects > 5 {
            return Err("重定向次数过多".into());
        }

        let resp = add_headers(client.get(&current_url), &current_cookie)
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))?;

        if resp.status().is_redirection() {
            match resp.headers().get("location").and_then(|v| v.to_str().ok()) {
                Some(next) => {
                    let next_url = url::Url::parse(&current_url)
                        .and_then(|base| base.join(next))
                        .map(|u| u.to_string())
                        .unwrap_or_else(|_| next.to_string());
                    let next_host = url::Url::parse(&next_url)
                        .ok()
                        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()));
                    // 跳转目标同样要过一遍校验：初始 URL 合法不代表上游给的
                    // Location 合法（不能把请求带向 127.0.0.1 / 169.254.x 等本地地址）
                    if let Err(e) = validate_download_url(&next_url) {
                        return Err(format!("重定向目标被拒绝: {} ({})", e, next_url));
                    }
                    if next_host != current_host && !current_cookie.is_empty() {
                        log_line!(
                            "[download] 跳转到不同主机 {:?}，已剥离 Cookie",
                            next_host
                        );
                        current_cookie.clear();
                    }
                    current_host = next_host;
                    log_line!(
                        "[download] 重定向 #{}: {}...",
                        redirects + 1,
                        &next_url[..next_url.len().min(80)]
                    );
                    current_url = next_url;
                    redirects += 1;
                    continue;
                }
                // 3xx 但没有 Location：不能把重定向响应体当文件内容写下去
                None => {
                    return Err(format!(
                        "上游返回 {} 但没有 Location 头",
                        resp.status().as_u16()
                    ))
                }
            }
        }

        return Ok((current_url, resp));
    }
}

// ── 设置（下载目录） ─────────────────────────────────────

/// 应用配置目录（settings.json 存放处）；取不到时退到临时目录，保证功能仍可用
fn config_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("QuarkDownloader"))
}

/// 当前生效的下载目录：优先用用户设置的目录，否则用系统默认下载目录
fn resolve_download_dir(app: &tauri::AppHandle) -> PathBuf {
    let configured = settings::read_settings(&config_dir(app)).download_dir;
    if let Some(dir) = configured {
        let path = PathBuf::from(&dir);
        if path.is_dir() {
            return path;
        }
        // 目录被删/盘符掉线等情况：不要让下载直接失败，回退到系统默认并留下日志
        log_err!("[settings] 配置的下载目录不可用，回退到系统默认: {}", dir);
    }

    app.path()
        .download_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
}

/// 返回给前端的设置视图
#[derive(serde::Serialize)]
struct SettingsView {
    /// 当前实际生效的下载目录
    download_dir: String,
    /// 系统默认下载目录（用于"恢复默认"提示）
    default_dir: String,
    /// 是否正在使用系统默认目录
    is_default: bool,
}

fn settings_view(app: &tauri::AppHandle) -> SettingsView {
    let default_dir = app
        .path()
        .download_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let is_default = settings::read_settings(&config_dir(app))
        .download_dir
        .map(|d| d.trim().is_empty())
        .unwrap_or(true);

    SettingsView {
        download_dir: resolve_download_dir(app).to_string_lossy().to_string(),
        default_dir,
        is_default,
    }
}

/// 读取设置
#[tauri::command]
async fn get_settings(app: tauri::AppHandle) -> Result<SettingsView, String> {
    Ok(settings_view(&app))
}

/// 修改下载目录；`path` 传 null 或空串表示"恢复系统默认"
#[tauri::command]
async fn set_download_dir(
    app: tauri::AppHandle,
    path: Option<String>,
) -> Result<SettingsView, String> {
    let mut current = settings::read_settings(&config_dir(&app));

    match path {
        Some(p) if !p.trim().is_empty() => {
            // 目录不存在会被创建，并做写权限探针校验
            let validated = settings::validate_download_dir(&p)?;
            current.download_dir = Some(validated.to_string_lossy().to_string());
        }
        _ => current.download_dir = None,
    }

    settings::write_settings(&config_dir(&app), &current)?;
    log_line!("[settings] 下载目录已更新: {:?}", current.download_dir);

    Ok(settings_view(&app))
}

/// 在文件管理器里打开当前下载目录
#[tauri::command]
async fn open_download_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = resolve_download_dir(&app);
    if !dir.is_dir() {
        return Err(format!("目录不存在: {}", dir.to_string_lossy()));
    }

    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&dir).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(&dir).spawn();

    spawned.map(|_| ()).map_err(|e| format!("打开目录失败: {}", e))
}

/// 清理下载目录里不属于当前任务队列的残留分片目录。
/// 应用被强杀时不会执行 RAII 清理，重启后由前端把"还要继续的任务 id"传进来，
/// 其余的 `.quark_temp_*` 一律删掉，避免隐藏目录在下载目录里越积越多。
#[tauri::command]
async fn cleanup_stale_temp_dirs(
    app: tauri::AppHandle,
    keep_ids: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let downloads_dir = resolve_download_dir(&app);
    let keep: std::collections::HashSet<String> = keep_ids
        .unwrap_or_default()
        .iter()
        .map(|id| format!(".quark_temp_{}", sanitize_task_key(id)))
        .collect();

    let mut removed = 0u32;
    let mut entries = tokio::fs::read_dir(&downloads_dir)
        .await
        .map_err(|e| format!("读取下载目录失败: {}", e))?;

    loop {
        match entries.next_entry().await {
            Ok(Some(entry)) => {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with(".quark_temp_") || keep.contains(&name) {
                    continue;
                }
                if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false)
                    && tokio::fs::remove_dir_all(entry.path()).await.is_ok()
                {
                    removed += 1;
                }
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }

    if removed > 0 {
        log_line!("[download] 已清理 {} 个残留分片目录", removed);
    }
    Ok(serde_json::json!({ "removed": removed }))
}

// ── Tauri 命令入口 ───────────────────────────────────────

/// 取消所有正在进行的下载（epoch +1 → 旧任务自动失效）
#[tauri::command]
async fn cancel_downloads() -> Result<serde_json::Value, String> {
    // 取消会结束任务，因此必须同时清掉暂停与单任务标记，否则下一批任务会一启动就挂住
    DOWNLOAD_PAUSED.store(false, Ordering::SeqCst);
    clear_all_tasks();
    let old = DOWNLOAD_EPOCH.fetch_add(1, Ordering::SeqCst);
    log_line!("[download] 取消下载 (epoch {} → {})", old, old + 1);
    Ok(serde_json::json!({ "cancelled": true }))
}

/// 暂停单个任务：任务不退出，在 chunk 之间挂起等待恢复（已下进度保留）
#[tauri::command]
async fn pause_task(task_id: String) -> Result<serde_json::Value, String> {
    set_task_paused(&task_id, true);
    log_line!("[download] 任务 {} 已暂停", task_id);
    Ok(serde_json::json!({ "taskId": task_id, "paused": true }))
}

/// 恢复单个任务
#[tauri::command]
async fn resume_task(task_id: String) -> Result<serde_json::Value, String> {
    set_task_paused(&task_id, false);
    log_line!("[download] 任务 {} 已恢复", task_id);
    Ok(serde_json::json!({ "taskId": task_id, "paused": false }))
}

/// 取消单个任务：只结束这一个任务，其它任务继续
#[tauri::command]
async fn cancel_task(task_id: String) -> Result<serde_json::Value, String> {
    set_task_cancelled(&task_id);
    log_line!("[download] 任务 {} 已取消", task_id);
    Ok(serde_json::json!({ "taskId": task_id, "cancelled": true }))
}

/// 暂停所有下载：任务不退出，挂起等待恢复（已下进度保留）
#[tauri::command]
async fn pause_downloads() -> Result<serde_json::Value, String> {
    DOWNLOAD_PAUSED.store(true, Ordering::SeqCst);
    log_line!("[download] 已暂停（任务挂起，进度保留）");
    Ok(serde_json::json!({ "paused": true }))
}

/// 恢复下载：唤醒挂起的任务，继续从当前进度往下下
#[tauri::command]
async fn resume_downloads() -> Result<serde_json::Value, String> {
    DOWNLOAD_PAUSED.store(false, Ordering::SeqCst);
    log_line!("[download] 已恢复下载");
    Ok(serde_json::json!({ "paused": false }))
}

#[tauri::command]
async fn download_file(
    app: tauri::AppHandle,
    url: String,
    cookie: String,
    filename: String,
    thread_count: Option<usize>,
    task_id: Option<String>,
    resume: Option<bool>,
) -> Result<serde_json::Value, String> {
    // 线程数：1..=64（与前端滑块/数字框一致）
    let thread_count = thread_count.unwrap_or(DEFAULT_THREADS).clamp(1, MAX_THREADS);

    // 任务 id：优先用前端传入的（下载管理要按行控制），否则自己生成一个
    let download_id = task_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()[..8].to_string());

    // 先固化 epoch：若在本函数开始后发生了"取消全部"（epoch 递增），
    // 这次下载必须被判为已取消，而不是拿到递增后的新值继续下完
    let epoch = DOWNLOAD_EPOCH.load(Ordering::SeqCst);

    // 排队阶段（还没调到 download_file）就被取消的任务：直接失败，不要白干活
    if task_cancelled(&download_id) || is_cancelled(epoch) {
        clear_task(&download_id);
        return Err("下载已取消".into());
    }
    // 登记任务；若已有状态则保留（可能是"启动前就已暂停"）
    with_task_states(|map| {
        map.entry(download_id.clone()).or_default();
    });

    // 入参校验：只接受合法的远端直链与"纯文件名"。
    // 这些早退分支也要清掉刚登记的条目，否则状态表会随失败次数泄漏
    if let Err(e) = validate_download_url(&url) {
        clear_task(&download_id);
        return Err(e);
    }
    let filename = match sanitize_filename(&filename) {
        Ok(name) => name,
        Err(e) => {
            clear_task(&download_id);
            return Err(e);
        }
    };

    // 下载目录：优先用"软件设置"里配置的目录，否则系统默认下载目录
    let downloads_dir = resolve_download_dir(&app);
    // 输出路径：续传时复用上次的路径与分片，否则原子预留一个新名字
    // （原子预留保证并发下载同名文件时不会选中同一个目标）
    let (save_path, resume_plan) = match resolve_save_target(
        &downloads_dir,
        &filename,
        &download_id,
        resume.unwrap_or(false),
    ) {
        Ok(target) => target,
        Err(e) => {
            clear_task(&download_id);
            return Err(e);
        }
    };
    let save_path_display = save_path.to_string_lossy().to_string();
    let cleanup_path = save_path.clone();
    let cleanup_id = download_id.clone();

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<serde_json::Value, String>>();

    tokio::spawn(async move {
        let result = do_download(
            app,
            url,
            cookie,
            filename,
            save_path,
            epoch,
            download_id,
            thread_count,
            resume_plan,
        )
        .await;
        let _ = tx.send(result);
    });

    match rx.await {
        Ok(Ok(value)) => {
            clear_task(&cleanup_id);
            Ok(value)
        }
        Ok(Err(e)) => {
            // 失败时清掉预留的空文件/半成品，不把垃圾留在下载目录
            let _ = tokio::fs::remove_file(&cleanup_path).await;
            clear_task(&cleanup_id);
            Err(e)
        }
        Err(_) => {
            let _ = tokio::fs::remove_file(&cleanup_path).await;
            clear_task(&cleanup_id);
            Err(format!("下载任务异常终止: {}", save_path_display))
        }
    }
}

// ── 下载调度 ─────────────────────────────────────────────

// 下载路径上的函数参数较多（app/client/url/cookie/filename/save_path/epoch/...），
// 拆成上下文结构体收益有限且会牵动所有调用点，这里显式放行 clippy 的参数个数检查。
#[allow(clippy::too_many_arguments)]
async fn do_download(
    app: tauri::AppHandle,
    url: String,
    cookie: String,
    filename: String,
    save_path: PathBuf,
    epoch: u64,
    download_id: String,
    thread_count: usize,
    resume: Option<ResumePlan>,
) -> Result<serde_json::Value, String> {
    if is_cancelled(epoch) {
        return Err("下载已取消".into());
    }
    // 排队中的文件若在暂停期间被启动，先挂起等恢复
    wait_if_paused(&download_id, epoch).await?;

    log_line!("[download] 开始: {} -> {:?} (epoch={})", filename, save_path, epoch);

    let client = build_client()?;
    let (final_url, resp) = follow_redirects(&client, &url, &cookie).await?;

    if is_cancelled(epoch) {
        return Err("下载已取消".into());
    }

    if resp.status() != reqwest::StatusCode::OK {
        let status = resp.status().as_u16();
        let err = resp.text().await.unwrap_or_default();
        return Err(format!(
            "CDN 返回错误 {}: {}",
            status,
            truncate_chars(&err, 200)
        ));
    }

    let total_size: u64 = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let accept_ranges = resp
        .headers()
        .get("accept-ranges")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.contains("bytes"))
        .unwrap_or(false);

    log_line!(
        "[download] CDN 200, 大小: {} ({:.1} MB), 支持 Range: {}",
        total_size,
        total_size as f64 / 1024.0 / 1024.0,
        accept_ranges
    );

    if accept_ranges && total_size >= MIN_MULTITHREAD_SIZE {
        drop(resp);
        log_line!("[download] 启用 {} 线程并行下载", thread_count);
        download_multithread(
            app,
            client,
            final_url,
            cookie,
            filename,
            save_path,
            total_size,
            epoch,
            download_id,
            thread_count,
            resume,
        )
        .await
    } else {
        log_line!("[download] 使用单线程下载 (Range 不支持或文件较小)");
        let _single_guard = register_single_thread_resume(&save_path, total_size, &download_id).await;
        download_single(app, resp, filename, save_path, total_size, epoch, download_id).await
    }
}

// ── 多线程分段下载 ────────────────────────────────────────

#[allow(clippy::too_many_arguments)] // 理由见 do_download
async fn download_multithread(
    app: tauri::AppHandle,
    client: reqwest::Client,
    url: String,
    cookie: String,
    filename: String,
    save_path: PathBuf,
    total_size: u64,
    epoch: u64,
    download_id: String,
    thread_count: usize,
    resume: Option<ResumePlan>,
) -> Result<serde_json::Value, String> {
    // 1. 临时目录按任务 id 派生，重启后能找回上次的分片（RAII 兜底清理）
    let downloads_dir = save_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf();
    let temp_dir = match &resume {
        Some(plan) => plan.temp_dir.clone(),
        None => temp_dir_for(&downloads_dir, &download_id),
    };
    if resume.is_none() {
        // 全新下载：清掉同一任务可能残留的旧分片，避免和这次的数据混在一起
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| format!("创建临时目录失败: {}", e))?;
    let _temp_guard = TempDirGuard(temp_dir.clone());

    // 2. 计算各段字节范围（分片数不超过总字节数，避免 0 长度区间与下溢）。
    //    续传必须沿用上次的划分：chunk_i 与区间一一对应，线程数变了旧分片就对不上
    let segments = match &resume {
        Some(plan) if plan.journal.total_size == total_size => plan.journal.segments.clone(),
        _ => build_segments(total_size, thread_count),
    };
    if segments.is_empty() {
        return Err("文件大小异常（0 字节），无法分片下载".to_string());
    }
    let thread_count = segments.len();

    // 落盘续传日志：应用被强杀后，下次启动靠它找回输出路径与分片划分
    write_resume_journal(
        &temp_dir,
        &ResumeJournal {
            version: RESUME_JOURNAL_VERSION,
            save_path: save_path.to_string_lossy().to_string(),
            total_size,
            segments: segments.clone(),
        },
    );

    for (i, (s, e)) in segments.iter().enumerate() {
        log_line!(
            "[download] 段{}: {}-{} ({:.1} MB)",
            i,
            s,
            e,
            (*e - *s + 1) as f64 / 1024.0 / 1024.0
        );
    }

    // 3. 每段独立的进度原子计数器：续传时以已落盘的字节数作为初值，
    //    否则监控会从 0 起算，进度条先倒退再前进
    let mut seg_progresses: Vec<Arc<AtomicU64>> = Vec::with_capacity(thread_count);
    for (s, e) in segments.iter() {
        let seg_len = e - s + 1;
        let existing = tokio::fs::metadata(temp_dir.join(format!("chunk_{}", seg_progresses.len())))
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        seg_progresses.push(Arc::new(AtomicU64::new(existing.min(seg_len))));
    }

    // 4. 进度监控任务
    let monitor_app = app.clone();
    let monitor_filename = filename.clone();
    let monitor_id = download_id.clone();
    let monitor_segs: Vec<Arc<AtomicU64>> = seg_progresses.iter().map(Arc::clone).collect();
    let initial_downloaded: u64 = seg_progresses
        .iter()
        .map(|a| a.load(Ordering::Relaxed))
        .sum();
    let monitor = tokio::spawn(async move {
        // 从续传起点开始记账：第一帧速度才不会把"已下载的历史字节"当成瞬时速度
        let mut last_downloaded: u64 = initial_downloaded;
        let mut last_time = std::time::Instant::now();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if is_cancelled(epoch) {
                break;
            }
            let downloaded: u64 = monitor_segs
                .iter()
                .map(|a| a.load(Ordering::Relaxed))
                .sum();
            let now = std::time::Instant::now();
            let dt = now.duration_since(last_time).as_secs_f64();
            let speed = if dt > 0.0 {
                (downloaded.saturating_sub(last_downloaded)) as f64 / dt
            } else {
                0.0
            };
            last_downloaded = downloaded;
            last_time = now;
            let _ = monitor_app.emit(
                "download-progress",
                serde_json::json!({
                    "id": &monitor_id,
                    "filename": &monitor_filename,
                    "downloaded": downloaded,
                    "total": total_size,
                    "speed": speed,
                }),
            );
            if downloaded >= total_size {
                break;
            }
        }
    });

    // 5. 各段并行下载到临时文件
    let mut handles = Vec::with_capacity(thread_count);
    for (i, &(start, end)) in segments.iter().enumerate() {
        let client = client.clone();
        let url = url.clone();
        let cookie = cookie.clone();
        let chunk_path = temp_dir.join(format!("chunk_{}", i));
        let seg_progress = Arc::clone(&seg_progresses[i]);
        let task_id = download_id.clone();

        handles.push(tokio::spawn(async move {
            download_segment(&client, &url, &cookie, &chunk_path, start, end, seg_progress, i, epoch, &task_id)
                .await
        }));
    }

    // 6. 等待所有段完成
    let mut errors = Vec::new();
    for (i, handle) in handles.into_iter().enumerate() {
        match handle.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => errors.push(format!("段{}: {}", i, e)),
            Err(e) => errors.push(format!("段{} 任务崩溃: {}", i, e)),
        }
    }

    monitor.abort();

    if !errors.is_empty() {
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
        log_line!("[download] 已清理临时目录: {:?}", temp_dir);
        return Err(format!("多线程下载失败:\n{}", errors.join("\n")));
    }

    // 7. 合并前再检查一次
    if is_cancelled(epoch) {
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
        return Err("下载已取消".into());
    }

    // 8. 合并分片到最终文件（暂停期间不进入合并，避免暂停时还在写大文件）
    wait_if_paused(&download_id, epoch).await?;
    log_line!("[download] 合并 {} 个分片到最终文件...", thread_count);
    let _ = app.emit(
        "download-progress",
        serde_json::json!({
            "id": &download_id,
            "filename": &filename,
            "downloaded": total_size,
            "total": total_size,
            "status": "merging",
        }),
    );

    {
        let final_file = tokio::fs::File::create(&save_path)
            .await
            .map_err(|e| format!("创建最终文件失败: {}", e))?;
        let mut writer = tokio::io::BufWriter::with_capacity(8 * 1024 * 1024, final_file);

        for i in 0..thread_count {
            let chunk_path = temp_dir.join(format!("chunk_{}", i));
            let mut chunk_file = tokio::fs::File::open(&chunk_path)
                .await
                .map_err(|e| format!("打开分片 {} 失败: {}", i, e))?;
            tokio::io::copy(&mut chunk_file, &mut writer)
                .await
                .map_err(|e| format!("合并分片 {} 失败: {}", i, e))?;
        }

        writer
            .flush()
            .await
            .map_err(|e| format!("flush 失败: {}", e))?;
    }

    // 9. 校验最终文件长度：任何一个分片的长度不对都会在这里暴露，
    //    宁可报错，也不要交付一个静默损坏的文件
    let written = tokio::fs::metadata(&save_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if written != total_size {
        let _ = tokio::fs::remove_file(&save_path).await;
        return Err(format!(
            "文件长度校验失败：期望 {} 字节，实际 {} 字节",
            total_size, written
        ));
    }

    // 10. 合并结束后再检查一次取消（大文件合并期间可能已经被取消）。
    // 这里必须同时看全局代际与"单任务取消"标志：合并阶段没有暂停闸门，
    // 单任务取消若只看全局标志就会被忽略，导致用户点了取消却下完并报成功。
    if is_cancelled(epoch) || task_cancelled(&download_id) {
        let _ = tokio::fs::remove_file(&save_path).await;
        return Err("下载已取消".into());
    }

    // 11. 清理临时目录（TempDirGuard 亦会兜底）
    let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    log_line!("[download] 临时文件已清理");

    // 最终进度
    let _ = app.emit(
        "download-progress",
        serde_json::json!({
            "id": &download_id,
            "filename": &filename,
            "downloaded": written,
            "total": total_size,
            "status": "done",
        }),
    );

    Ok(serde_json::json!({
        "path": save_path.to_string_lossy(),
        "size": written,
    }))
}

/// 单个分片下载（含重试）：Range 请求 → 校验响应 → 落盘 → 校验字节数
#[allow(clippy::too_many_arguments)] // 理由见 do_download
async fn download_segment(
    client: &reqwest::Client,
    url: &str,
    cookie: &str,
    chunk_path: &PathBuf,
    start: u64,
    end: u64,
    progress: Arc<AtomicU64>,
    index: usize,
    epoch: u64,
    task_id: &str,
) -> Result<(), String> {
    let mut last_err = String::new();

    for attempt in 1..=SEGMENT_MAX_ATTEMPTS {
        if is_cancelled(epoch) {
            return Err("下载已取消".into());
        }
        if attempt > 1 {
            // 退避后重试：上一次尝试已落盘的字节会被续传逻辑复用，
            // 进度不会倒退，因此这里不再清零计数器
            log_line!("[download] 段{} 第 {} 次尝试", index, attempt);
            tokio::time::sleep(std::time::Duration::from_millis(500 * attempt as u64)).await;
        }

        match download_segment_once(client, url, cookie, chunk_path, start, end, &progress, epoch, task_id)
            .await
        {
            Ok(()) => return Ok(()),
            Err(e) => {
                if e.contains("下载已取消") {
                    return Err(e);
                }
                log_line!("[download] 段{} 失败: {}", index, e);
                last_err = e;
            }
        }
    }

    Err(format!("{}（已尝试 {} 次）", last_err, SEGMENT_MAX_ATTEMPTS))
}

/// 单次分片下载：Range 请求 → 校验 Content-Range → 写入独立临时文件 → 校验长度
#[allow(clippy::too_many_arguments)] // 理由见 do_download
async fn download_segment_once(
    client: &reqwest::Client,
    url: &str,
    cookie: &str,
    chunk_path: &PathBuf,
    start: u64,
    end: u64,
    progress: &AtomicU64,
    epoch: u64,
    task_id: &str,
) -> Result<(), String> {
    let expected = end - start + 1;

    // 断点续传：分片文件里已落盘的字节数就是这一段的进度（顺序追加，内容一定是前缀）。
    // 超过区间长度说明旧文件对不上，直接丢弃重来，避免错位合并
    let mut offset = tokio::fs::metadata(chunk_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if offset > expected {
        let _ = tokio::fs::remove_file(chunk_path).await;
        offset = 0;
    }
    if offset == expected {
        progress.store(offset, Ordering::Relaxed);
        return Ok(());
    }

    let range_start = start + offset;
    let range_header = format!("bytes={}-{}", range_start, end);

    let resp = add_headers(client.get(url), cookie)
        .header("Range", &range_header)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status().as_u16();
    if status != 206 {
        return Err(format!("CDN 返回 {} (期望 206)", status));
    }

    // 校验 Content-Range：确认服务端真的按请求的区间返回，
    // 否则会把别的区间/别的数据当成这一片写进去（错位合并）
    let expected_prefix = format!("bytes {}-{}", range_start, end);
    match resp
        .headers()
        .get("content-range")
        .and_then(|v| v.to_str().ok())
    {
        Some(cr) if cr.to_ascii_lowercase().starts_with(expected_prefix.as_str()) => {}
        Some(cr) => {
            return Err(format!(
                "Content-Range 不匹配: 期望以 {} 开头, 实际 {}",
                expected_prefix, cr
            ))
        }
        None => return Err("响应缺少 Content-Range 头".to_string()),
    }

    // 追加写入：已落盘的部分保留，只补后面缺的字节
    let file = tokio::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(chunk_path)
        .await
        .map_err(|e| format!("打开临时文件失败: {}", e))?;

    let mut writer = tokio::io::BufWriter::with_capacity(1024 * 1024, file);
    let mut resp = resp;
    let mut seg_downloaded: u64 = offset;

    loop {
        if is_cancelled(epoch) {
            return Err("下载已取消".into());
        }
        // 暂停点落在两个 chunk 之间：不会写出半个 chunk，分片文件始终完整可重试
        wait_if_paused(task_id, epoch).await?;
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                writer
                    .write_all(&chunk)
                    .await
                    .map_err(|e| format!("写入失败: {}", e))?;
                seg_downloaded += chunk.len() as u64;
                progress.store(seg_downloaded, Ordering::Relaxed);
            }
            Ok(None) => break,
            Err(e) => {
                return Err(format!(
                    "传输中断: {} (已下载 {}/{})",
                    e, seg_downloaded, expected
                ));
            }
        }
    }

    writer
        .flush()
        .await
        .map_err(|e| format!("flush 失败: {}", e))?;

    // 长度校验：少收或多收都判失败（由上层决定是否重试）
    if seg_downloaded != expected {
        return Err(format!(
            "分片长度不符: 期望 {} 字节, 实际 {} 字节",
            expected, seg_downloaded
        ));
    }

    Ok(())
}

// ── 单线程下载（Range 不可用时的回退） ───────────────────

async fn download_single(
    app: tauri::AppHandle,
    mut resp: reqwest::Response,
    filename: String,
    save_path: PathBuf,
    total_size: u64,
    epoch: u64,
    download_id: String,
) -> Result<serde_json::Value, String> {
    match download_single_once(
        &app,
        &mut resp,
        &filename,
        &save_path,
        total_size,
        epoch,
        &download_id,
    )
    .await
    {
        Ok(downloaded) => {
            let _ = app.emit(
                "download-progress",
                serde_json::json!({
                    "id": &download_id,
                    "filename": &filename,
                    "downloaded": downloaded,
                    "total": if total_size == 0 { downloaded } else { total_size },
                    "status": "done",
                }),
            );

            Ok(serde_json::json!({
                "path": save_path.to_string_lossy(),
                "size": downloaded,
            }))
        }
        Err(e) => {
            // 任何失败都删掉半成品，不把截断的文件留在最终文件名下
            let _ = tokio::fs::remove_file(&save_path).await;
            Err(e)
        }
    }
}

/// 单次单线程下载：写入 → 校验长度（分块传输无 Content-Length 时跳过校验）
async fn download_single_once(
    app: &tauri::AppHandle,
    resp: &mut reqwest::Response,
    filename: &str,
    save_path: &PathBuf,
    total_size: u64,
    epoch: u64,
    download_id: &str,
) -> Result<u64, String> {
    let file = tokio::fs::File::create(save_path)
        .await
        .map_err(|e| format!("创建文件失败: {}", e))?;
    let mut writer = tokio::io::BufWriter::with_capacity(8 * 1024 * 1024, file);

    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut last_downloaded: u64 = 0;

    loop {
        if is_cancelled(epoch) {
            return Err("下载已取消".into());
        }
        // 与多线程同样的暂停点：只在 chunk 之间挂起
        wait_if_paused(download_id, epoch).await?;
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                writer
                    .write_all(&chunk)
                    .await
                    .map_err(|e| format!("写入失败: {}", e))?;
                downloaded += chunk.len() as u64;

                if last_emit.elapsed() >= std::time::Duration::from_millis(500) {
                    let now = std::time::Instant::now();
                    let dt = now.duration_since(last_emit).as_secs_f64();
                    let speed = if dt > 0.0 {
                        (downloaded.saturating_sub(last_downloaded)) as f64 / dt
                    } else {
                        0.0
                    };
                    last_downloaded = downloaded;
                    let _ = app.emit(
                        "download-progress",
                        serde_json::json!({
                            "id": download_id,
                            "filename": filename,
                            "downloaded": downloaded,
                            "total": total_size,
                            "speed": speed,
                        }),
                    );
                    last_emit = now;
                }
            }
            Ok(None) => break,
            Err(e) => {
                return Err(format!("下载中断: {} (已下载 {})", e, downloaded));
            }
        }
    }

    writer
        .flush()
        .await
        .map_err(|e| format!("flush 失败: {}", e))?;

    if total_size > 0 && downloaded != total_size {
        return Err(format!(
            "文件长度校验失败：期望 {} 字节，实际 {} 字节",
            total_size, downloaded
        ));
    }

    // 单线程路径同样要在收尾复查取消：循环内的闸门只在每个 chunk 之间生效，
    // 少了这一步，最后一刻的取消会被吞掉、文件照旧算成功
    if is_cancelled(epoch) || task_cancelled(download_id) {
        return Err("下载已取消".into());
    }

    log_line!(
        "[download] 单线程完成: {} ({:.1} MB, {} bytes)",
        filename,
        downloaded as f64 / 1024.0 / 1024.0,
        downloaded
    );

    Ok(downloaded)
}

// ── 主入口 ───────────────────────────────────────────────

/// 弹出一个原生错误框（Windows 上直接调用 MessageBoxW，不引入任何新依赖）。
/// release 版是 GUI 子系统程序，没有控制台，启动失败时用户什么都看不到，
/// 这个弹窗是"双击没反应"唯一的自查线索。
#[cfg(windows)]
fn show_fatal_dialog(title: &str, text: &str) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut core::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            u_type: u32,
        ) -> i32;
    }

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    const MB_OK: u32 = 0x0000_0000;
    const MB_ICONERROR: u32 = 0x0000_0010;

    let text_w = wide(text);
    let title_w = wide(title);
    // SAFETY: 两个指针都指向以 NUL 结尾、在调用期间存活的 UTF-16 缓冲区
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text_w.as_ptr(),
            title_w.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(windows))]
fn show_fatal_dialog(title: &str, text: &str) {
    log_err!("[fatal] {}: {}", title, text);
}

fn main() {
    // 把 panic 变成用户看得见的错误框：否则启动失败（WebView2 缺失、
    // 数据目录不可写、被杀毒软件拦截等）时只会"一闪而过"，无法自查。
    std::panic::set_hook(Box::new(|info| {
        let detail = info.to_string();
        log_err!("[fatal] {}", detail);
        show_fatal_dialog(
            "QuarkDownloader 启动失败",
            &format!(
                "应用遇到错误并已退出。\n\n{}\n\n\
                 若为首次运行，请确认系统已安装 Microsoft Edge WebView2 运行时；\n\
                 若提示拒绝访问，请检查杀毒软件是否拦截了本程序。",
                detail
            ),
        );
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        // 目录选择对话框（"软件设置"里选下载目录用）
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            download_file,
            cancel_downloads,
            pause_downloads,
            resume_downloads,
            pause_task,
            resume_task,
            cancel_task,
            get_settings,
            set_download_dir,
            open_download_dir,
            cleanup_stale_temp_dirs
        ])
        .setup(|app| {
            // 手动创建主窗口（而非 tauri.conf.json 自动创建），
            // 这样才能在 Builder 上注册 on_navigation 回调
            let _main_window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("QuarkDownloader")
            .inner_size(1024.0, 750.0)
            .min_inner_size(1024.0, 700.0)
            .resizable(true)
            .decorations(false)
            .shadow(true)
            .center()
            .on_navigation(|url| {
                // 来源白名单：只允许应用自身页面（含开发服务器）。
                // 主 WebView 一旦被带到远程页面，那段远程内容就运行在应用的
                // IPC 上下文里，是安全上最危险的场景，因此这里必须拒绝。
                if !is_trusted_origin(url) {
                    log_err!("[security] 已阻止导航到非受信来源: {}", url);
                    return false;
                }

                // 允许的导航=页面重载/切换：旧页面已收不到进度事件，主动取消在跑的下载。
                // 这里同时清掉暂停与单任务标记，保证"刷新 == 取消"这一语义在
                // 后端也成立（否则刷新后新页面若不再发一次 resume，任务会永久挂起）。
                DOWNLOAD_PAUSED.store(false, Ordering::SeqCst);
                clear_all_tasks();
                let old = DOWNLOAD_EPOCH.fetch_add(1, Ordering::SeqCst);
                log_line!(
                    "[download] 检测到页面导航/刷新，取消下载 (epoch {} → {})",
                    old,
                    old + 1
                );
                true // 允许导航继续
            })
            .build()
            .expect("创建主窗口失败");

            // 打印一次当前生效的下载目录，便于排查"文件下到哪去了"
            log_line!("[settings] 下载目录: {:?}", resolve_download_dir(app.handle()));

            // 启动内嵌 HTTP 服务（axum）
            let port: u16 = std::env::var("PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(3000);
            if port != 3000 {
                log_err!(
                    "[quark-api] 警告: PORT={} 只改变后端监听端口，前端仍然固定请求 \
                     http://127.0.0.1:3000/api —— 除非用 VITE_API_BASE_URL 重新构建前端，\
                     否则所有请求都会失败",
                    port
                );
            }

            tauri::async_runtime::spawn(async move {
                let router = api_server::create_router();
                let addr = format!("127.0.0.1:{}", port);

                // 端口被占用时绝不能 panic：那样窗口照常打开，但所有接口都失效，
                // 用户只会看到"网络错误"。这里改为打印一条醒目的错误并让应用继续跑。
                let listener = match tokio::net::TcpListener::bind(&addr).await {
                    Ok(listener) => listener,
                    Err(e) => {
                        log_err!(
                            "[quark-api] 启动失败: 无法监听 {} —— {}。\
                             该端口可能被其它程序（或本应用的另一个实例）占用；\
                             请关闭占用方后重启本应用，否则界面上的所有操作都会失败。",
                            addr, e
                        );
                        return;
                    }
                };

                log_line!("[quark-api] 内嵌服务已启动: http://{}", addr);
                if let Err(e) = axum::serve(listener, router).await {
                    log_err!("[quark-api] 内嵌服务异常退出: {}", e);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── 单元测试 ─────────────────────────────────────────────
// 这些函数是上面"文件损坏/路径穿越"类问题的关键防线，先用纯函数测试锁住行为。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_cover_whole_file_without_gaps() {
        let total = 10 * 1024 * 1024 + 1;
        let segments = build_segments(total, 16);
        assert_eq!(segments.len(), 16);

        let mut expected_start = 0u64;
        for (start, end) in &segments {
            assert_eq!(*start, expected_start, "分片之间不应有缝隙或重叠");
            assert!(end >= start, "分片结束位置不得小于起始位置");
            expected_start = end + 1;
        }
        assert_eq!(expected_start, total, "所有分片应完整覆盖整个文件");
    }

    #[test]
    fn segments_never_underflow_for_tiny_files() {
        // 分片数超过字节数时不允许出现 0 长度区间（旧实现会在这里下溢）
        assert_eq!(build_segments(3, 64), vec![(0, 0), (1, 1), (2, 2)]);
        assert_eq!(build_segments(1, 64), vec![(0, 0)]);
        assert!(build_segments(0, 16).is_empty());
    }

    #[test]
    fn filename_is_reduced_to_basename() {
        assert_eq!(sanitize_filename("a/b/c.mp4").unwrap(), "c.mp4");
        assert_eq!(sanitize_filename("..\\..\\evil.exe").unwrap(), "evil.exe");
        assert_eq!(sanitize_filename("C:\\Windows\\x.dll").unwrap(), "x.dll");
        assert_eq!(sanitize_filename("CON.txt").unwrap(), "_CON.txt");
        assert_eq!(sanitize_filename("trailing. ").unwrap(), "trailing");
        assert!(sanitize_filename("..").is_err());
        assert!(sanitize_filename("").is_err());
    }

    #[test]
    fn download_url_rejects_local_and_non_http() {
        assert!(validate_download_url("https://cdn.quark.cn/a/b").is_ok());
        assert!(validate_download_url("http://127.0.0.1:3000/api/health").is_err());
        assert!(validate_download_url("http://localhost/x").is_err());
        assert!(validate_download_url("http://169.254.1.1/x").is_err());
        assert!(validate_download_url("file:///C:/Windows/x").is_err());
        assert!(validate_download_url("not a url").is_err());
    }

    #[test]
    fn trusted_origins_only() {
        assert!(is_trusted_origin(&url::Url::parse("tauri://localhost/index.html").unwrap()));
        assert!(is_trusted_origin(&url::Url::parse("http://tauri.localhost/").unwrap()));
        assert!(is_trusted_origin(&url::Url::parse("http://127.0.0.1:1420/").unwrap()));
        assert!(!is_trusted_origin(&url::Url::parse("https://evil.example.com/").unwrap()));
        assert!(!is_trusted_origin(&url::Url::parse("http://app.evil.com/").unwrap()));
        assert!(!is_trusted_origin(&url::Url::parse("file:///C:/x.html").unwrap()));
    }

    #[test]
    fn truncate_chars_never_splits_utf8() {
        let s = "错误".repeat(200); // 600 字节 / 400 字符
        let t = truncate_chars(&s, 200);
        assert_eq!(t.chars().count(), 201); // 200 字符 + 省略号
        assert_eq!(truncate_chars("短", 10), "短");
    }

    /// 下面两个测试都会操作全局暂停标志，用异步锁串行执行避免互相干扰
    static PAUSE_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// 全局暂停闸门：暂停期间挂起、恢复后放行、期间被取消则立即报错
    #[tokio::test]
    async fn pause_gate_blocks_then_resumes_and_yields_to_cancel() {
        let _serial = PAUSE_TEST_LOCK.lock().await;
        let epoch = DOWNLOAD_EPOCH.load(Ordering::SeqCst);
        let task = "test-gate-global";

        // 暂停中：不应放行
        DOWNLOAD_PAUSED.store(true, Ordering::SeqCst);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), wait_if_paused(task, epoch))
                .await
                .is_err(),
            "暂停期间闸门不应放行"
        );

        // 恢复后：立即放行
        DOWNLOAD_PAUSED.store(false, Ordering::SeqCst);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(500), wait_if_paused(task, epoch))
                .await
                .is_ok(),
            "恢复后闸门应立即放行"
        );

        // 暂停期间被全局取消：应立刻返回错误，而不是继续挂起
        DOWNLOAD_PAUSED.store(true, Ordering::SeqCst);
        let stale_epoch = DOWNLOAD_EPOCH.fetch_add(1, Ordering::SeqCst);
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            wait_if_paused(task, stale_epoch),
        )
        .await;
        DOWNLOAD_PAUSED.store(false, Ordering::SeqCst); // 恢复现场

        match result {
            Ok(Err(e)) => assert!(e.contains("已取消"), "错误信息应说明是取消: {}", e),
            other => panic!("取消应打断暂停等待，实际结果: {:?}", other),
        }
    }

    /// 单任务控制：只影响目标任务，互不干扰；取消能打断暂停；结束后状态被清理
    #[tokio::test]
    async fn per_task_pause_and_cancel_are_isolated() {
        let _serial = PAUSE_TEST_LOCK.lock().await;
        let epoch = DOWNLOAD_EPOCH.load(Ordering::SeqCst);
        let paused_task = "test-task-paused";
        let other_task = "test-task-other";

        DOWNLOAD_PAUSED.store(false, Ordering::SeqCst);
        set_task_paused(paused_task, true);

        // 被暂停的任务：闸门不放行
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(150),
                wait_if_paused(paused_task, epoch)
            )
            .await
            .is_err(),
            "被暂停的任务不应放行"
        );

        // 其它任务不受影响（单任务暂停必须隔离）
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(150),
                wait_if_paused(other_task, epoch)
            )
            .await
            .is_ok(),
            "其它任务不应受该任务暂停影响"
        );

        // 恢复该任务：立即放行
        set_task_paused(paused_task, false);
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(500),
                wait_if_paused(paused_task, epoch)
            )
            .await
            .is_ok(),
            "恢复后该任务应立即放行"
        );

        // 暂停状态下单任务取消：应立刻返回"已取消"，而不是继续挂起
        set_task_paused(paused_task, true);
        set_task_cancelled(paused_task);
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            wait_if_paused(paused_task, epoch),
        )
        .await;
        match result {
            Ok(Err(e)) => assert!(e.contains("已取消"), "错误信息应说明是取消: {}", e),
            other => panic!("单任务取消应打断暂停等待，实际结果: {:?}", other),
        }

        // 任务结束后清理：不再残留暂停/取消状态
        clear_task(paused_task);
        assert!(!task_paused(paused_task), "清理后不应残留暂停状态");
        assert!(!task_cancelled(paused_task), "清理后不应残留取消状态");
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(150),
                wait_if_paused(paused_task, epoch)
            )
            .await
            .is_ok(),
            "清理后该任务不应再被暂停影响"
        );
    }

    fn unique_temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("quark-test-{}-{}", tag, uuid::Uuid::new_v4()))
    }

    #[test]
    fn task_temp_dir_is_stable_and_sanitized() {
        // 同一个任务 id 必须映射到同一个目录（重启后才能找回分片）
        assert_eq!(sanitize_task_key("abc-123"), "abc-123");
        assert_eq!(sanitize_task_key("abc-123"), sanitize_task_key("abc-123"));
        // 路径分隔符等危险字符会被过滤，避免越出下载目录
        assert_eq!(sanitize_task_key("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_task_key("a\\b/c"), "abc");
        assert_eq!(sanitize_task_key(""), "task");
        assert_eq!(sanitize_task_key("///"), "task");

        let dir = Path::new("/downloads");
        assert_eq!(
            temp_dir_for(dir, "abc-123"),
            Path::new("/downloads/.quark_temp_abc-123")
        );
    }

    #[test]
    fn resume_journal_round_trips_and_rejects_junk() {
        let dir = unique_temp_dir("journal");
        std::fs::create_dir_all(&dir).unwrap();

        // 没有日志时不应误判为可续传
        assert!(read_resume_journal(&dir).is_none());

        let journal = ResumeJournal {
            version: RESUME_JOURNAL_VERSION,
            save_path: "/downloads/movie.zip".to_string(),
            total_size: 2048,
            segments: vec![(0, 1023), (1024, 2047)],
        };
        write_resume_journal(&dir, &journal);

        let read = read_resume_journal(&dir).expect("日志应能读回");
        assert_eq!(read.save_path, "/downloads/movie.zip");
        assert_eq!(read.total_size, 2048);
        assert_eq!(read.segments, vec![(0, 1023), (1024, 2047)]);

        // 损坏/过期日志必须被忽略，而不是拿来续传
        std::fs::write(dir.join(RESUME_JOURNAL_FILE), b"{ not json").unwrap();
        assert!(read_resume_journal(&dir).is_none());
        std::fs::write(
            dir.join(RESUME_JOURNAL_FILE),
            serde_json::to_string(&ResumeJournal {
                version: RESUME_JOURNAL_VERSION + 1,
                save_path: "/downloads/movie.zip".to_string(),
                total_size: 2048,
                segments: vec![(0, 2047)],
            })
            .unwrap(),
        )
        .unwrap();
        assert!(read_resume_journal(&dir).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_save_target_reuses_previous_path_only_when_asked() {
        let dir = unique_temp_dir("resolve-target");
        std::fs::create_dir_all(&dir).unwrap();
        let task_id = "task-abc";

        // 全新下载：原子预留一个新名字
        let (path, plan) = resolve_save_target(&dir, "movie.zip", task_id, false).unwrap();
        assert!(plan.is_none());
        assert_eq!(path.file_name().unwrap(), "movie.zip");

        // 模拟「下载中途被杀」：留下分片目录与续传日志
        let temp_dir = temp_dir_for(&dir, task_id);
        std::fs::create_dir_all(&temp_dir).unwrap();
        write_resume_journal(
            &temp_dir,
            &ResumeJournal {
                version: RESUME_JOURNAL_VERSION,
                save_path: path.to_string_lossy().to_string(),
                total_size: 1234,
                segments: vec![(0, 616), (617, 1233)],
            },
        );

        // 续传：必须复用同一个输出路径，否则会在下载目录里多出一个「movie (1).zip」
        let (resumed_path, plan) = resolve_save_target(&dir, "movie.zip", task_id, true).unwrap();
        assert_eq!(resumed_path, path);
        let plan = plan.expect("续传应带回日志");
        assert_eq!(plan.journal.total_size, 1234);
        assert_eq!(plan.journal.segments, vec![(0, 616), (617, 1233)]);

        // 明确不续传时：即使有日志也必须预留新路径，不能覆盖已有文件
        let (fresh, plan) = resolve_save_target(&dir, "movie.zip", task_id, false).unwrap();
        assert!(plan.is_none());
        assert_ne!(fresh, path);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 最小可用的 Range 服务器：按 `Range: bytes=x-y` 返回 206 + Content-Range，
    /// 用来真实验证「截断后继续下载」得到的文件逐字节正确。
    async fn spawn_range_server(body: Vec<u8>, hits: Arc<AtomicU64>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let body = body.clone();
                let hits = Arc::clone(&hits);
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};

                    let mut buf = vec![0u8; 8192];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    hits.fetch_add(1, Ordering::SeqCst);

                    let total = body.len();
                    let mut start = 0usize;
                    let mut end = total.saturating_sub(1);
                    let mut partial = false;

                    for line in req.lines() {
                        let is_range = line
                            .get(..6)
                            .map(|p| p.eq_ignore_ascii_case("range:"))
                            .unwrap_or(false);
                        if !is_range {
                            continue;
                        }
                        let spec = match line[6..].trim().strip_prefix("bytes=") {
                            Some(spec) => spec,
                            None => continue,
                        };
                        let parts: Vec<&str> = spec.split('-').collect();
                        if parts.len() != 2 {
                            continue;
                        }
                        start = parts[0].trim().parse().unwrap_or(0);
                        end = if parts[1].trim().is_empty() {
                            total.saturating_sub(1)
                        } else {
                            parts[1].trim().parse().unwrap_or(total.saturating_sub(1))
                        };
                        partial = true;
                    }

                    let end = end.min(total.saturating_sub(1));
                    let slice = if total == 0 {
                        &body[0..0]
                    } else {
                        &body[start..=end]
                    };
                    let header = if partial {
                        format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                            slice.len(), start, end, total
                        )
                    } else {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                            slice.len()
                        )
                    };
                    let _ = stream.write_all(header.as_bytes()).await;
                    let _ = stream.write_all(slice).await;
                    let _ = stream.flush().await;
                });
            }
        });

        format!("http://127.0.0.1:{}/file.bin", port)
    }

    /// 断点续传的核心保证：分片文件里已落盘的字节会被复用，
    /// 续传后拼出来的内容必须与原始文件逐字节一致（错位合并会在这里被抓到）
    #[tokio::test]
    async fn download_segment_resumes_from_existing_bytes() {
        // 与暂停/取消相关测试串行：它们会改全局暂停标志与 epoch，并发跑会互相干扰
        let _serial = PAUSE_TEST_LOCK.lock().await;
        let total: usize = 300_000;
        let body: Vec<u8> = (0..total).map(|i| (i % 251) as u8).collect();
        let hits = Arc::new(AtomicU64::new(0));
        let url = spawn_range_server(body.clone(), Arc::clone(&hits)).await;

        let dir = unique_temp_dir("segment-resume");
        std::fs::create_dir_all(&dir).unwrap();
        let client = build_client().unwrap();
        let epoch = DOWNLOAD_EPOCH.load(Ordering::SeqCst);
        let task = "test-resume";

        // 1) 首次：完整下载一个分片
        let chunk = dir.join("chunk_0");
        let progress = Arc::new(AtomicU64::new(0));
        let last = (total - 1) as u64;
        download_segment_once(&client, &url, "", &chunk, 0, last, &progress, epoch, task)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&chunk).unwrap(), body);
        assert_eq!(progress.load(Ordering::Relaxed), total as u64);

        // 2) 已经完整：直接返回，不再打扰 CDN
        let hits_before = hits.load(Ordering::SeqCst);
        download_segment_once(&client, &url, "", &chunk, 0, last, &progress, epoch, task)
            .await
            .unwrap();
        assert_eq!(
            hits.load(Ordering::SeqCst),
            hits_before,
            "已完整的分片不应重复下载"
        );

        // 3) 模拟「下到一半应用被杀」：截断尾部后继续
        let file = std::fs::OpenOptions::new().write(true).open(&chunk).unwrap();
        file.set_len(total as u64 - 1000).unwrap();
        drop(file);
        progress.store(0, Ordering::Relaxed);
        download_segment_once(&client, &url, "", &chunk, 0, last, &progress, epoch, task)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(&chunk).unwrap(),
            body,
            "续传后内容必须与原始文件逐字节一致"
        );
        assert_eq!(progress.load(Ordering::Relaxed), total as u64);

        // 4) 分片文件比区间还长（上一次运行的残留对不上）：丢弃重下，不得错位合并
        let file = std::fs::OpenOptions::new().write(true).open(&chunk).unwrap();
        file.set_len(total as u64 + 10).unwrap();
        drop(file);
        download_segment_once(&client, &url, "", &chunk, 0, last, &progress, epoch, task)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&chunk).unwrap(), body);

        // 5) 中间分片（start != 0）：截断后继续，拼接结果仍对应原始区间
        let (start, end) = (50_000u64, 99_999u64);
        let chunk2 = dir.join("chunk_1");
        let progress2 = Arc::new(AtomicU64::new(0));
        download_segment_once(&client, &url, "", &chunk2, start, end, &progress2, epoch, task)
            .await
            .unwrap();
        let expected = body[start as usize..=end as usize].to_vec();
        assert_eq!(std::fs::read(&chunk2).unwrap(), expected);

        let file = std::fs::OpenOptions::new().write(true).open(&chunk2).unwrap();
        file.set_len(end - start + 1 - 500).unwrap();
        drop(file);
        download_segment_once(&client, &url, "", &chunk2, start, end, &progress2, epoch, task)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&chunk2).unwrap(), expected);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
