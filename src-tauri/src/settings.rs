//! 应用设置（当前主要是"下载目录"）的持久化与校验。
//!
//! 存储位置为 Tauri 的 app_config_dir（Windows 上约等于
//! `%APPDATA%\com.quark.downloader\settings.json`）。
//! 设计原则：设置文件缺失、损坏、字段不认识，一律回退到默认值，
//! 绝不让"设置读取失败"演变成"应用不可用"。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SETTINGS_FILE: &str = "settings.json";

/// 写权限探针文件名前缀（校验完立即删除；名字带唯一后缀，避免与用户文件撞名）
const WRITE_PROBE_PREFIX: &str = ".quark_write_probe_";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    /// 用户指定的下载目录（绝对路径）；`None` 表示使用系统默认下载目录
    #[serde(default)]
    pub download_dir: Option<String>,
}

/// 读取设置：文件不存在或内容损坏都返回默认值（不报错、不 panic）
pub fn read_settings(config_dir: &Path) -> Settings {
    let file = config_dir.join(SETTINGS_FILE);
    match std::fs::read_to_string(&file) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

/// 写入设置（配置目录会自动创建）。
/// 采用"写临时文件 + 原子替换"：避免截断写入期间被并发读到半截内容，
/// 那样 read_settings 会回退默认值，导致下载目录悄悄变回系统默认目录。
pub fn write_settings(config_dir: &Path, settings: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
    let text =
        serde_json::to_string_pretty(settings).map_err(|e| format!("序列化设置失败: {}", e))?;

    let target = config_dir.join(SETTINGS_FILE);
    let temp = config_dir.join(format!("{}.tmp", SETTINGS_FILE));
    std::fs::write(&temp, text).map_err(|e| format!("写入设置失败: {}", e))?;
    // 同一目录内 rename 在 Windows 上是原子替换
    std::fs::rename(&temp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("保存设置失败: {}", e)
    })
}

/// 校验并规范化下载目录：
/// 必须是非空绝对路径、不能指向一个已存在的文件、能被创建，并且真的可写。
/// 用"写探针文件"验证可写性，避免出现"设置保存成功、下载却全部失败"。
pub fn validate_download_dir(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("目录不能为空".to_string());
    }

    let candidate = PathBuf::from(trimmed);
    if !candidate.is_absolute() {
        return Err("请填写绝对路径，例如 D:\\Downloads".to_string());
    }
    if candidate.is_file() {
        return Err(format!("{} 是一个文件，不是目录", trimmed));
    }

    std::fs::create_dir_all(&candidate).map_err(|e| format!("无法创建目录: {}", e))?;

    // 唯一文件名 + create_new：既不覆盖用户目录里恰好同名的文件，
    // 也不会被上次异常退出残留的探针影响判定
    let probe = candidate.join(format!("{}{}", WRITE_PROBE_PREFIX, uuid::Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|e| format!("目录不可写: {}", e))?;
    use std::io::Write;
    file.write_all(b"ok").map_err(|e| format!("目录不可写: {}", e))?;
    drop(file);
    let _ = std::fs::remove_file(&probe);

    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "quark_settings_{}_{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("创建测试目录失败");
        dir
    }

    #[test]
    fn settings_roundtrip_and_fallback_on_missing_or_broken() {
        let dir = temp_dir("roundtrip");

        // 文件不存在 -> 默认值
        assert_eq!(read_settings(&dir), Settings::default());

        // 正常读写
        let settings = Settings { download_dir: Some(dir.to_string_lossy().to_string()) };
        write_settings(&dir, &settings).expect("写入设置失败");
        assert_eq!(read_settings(&dir), settings);

        // 文件损坏 -> 回退默认值而不是 panic
        std::fs::write(dir.join(SETTINGS_FILE), b"{ this is not json").unwrap();
        assert_eq!(read_settings(&dir), Settings::default());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validates_download_dir_strictly() {
        let dir = temp_dir("validate");
        let dir_str = dir.to_string_lossy().to_string();

        // 合法目录：通过，且探针文件已清理
        let ok = validate_download_dir(&dir_str).expect("合法目录应通过");
        assert_eq!(ok, dir);
        let leftovers = std::fs::read_dir(&dir)
            .expect("读取目录失败")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(WRITE_PROBE_PREFIX)
            })
            .count();
        assert_eq!(leftovers, 0, "探针文件应被清理");

        // 空 / 全是空白 -> 拒绝
        assert!(validate_download_dir("   ").is_err());
        // 相对路径 -> 拒绝（避免相对进程 CWD 产生歧义）
        assert!(validate_download_dir("relative/downloads").is_err());
        // 指向一个已存在的文件 -> 拒绝
        let file = dir.join("a.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(validate_download_dir(&file.to_string_lossy()).is_err());

        // 不存在的目录会被自动创建
        let nested = dir.join("a").join("b");
        assert!(validate_download_dir(&nested.to_string_lossy()).is_ok());
        assert!(nested.is_dir());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
