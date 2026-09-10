use crate::config::Result;
use std::{ffi::OsStr, path::Path, process::Command};

fn editor_command(file: &Path, platform: &str, windows_root: Option<&OsStr>) -> Result<Command> {
    match platform {
        "windows" => {
            let root = windows_root.ok_or_else(|| "无法定位 Windows 系统目录。".to_string())?;
            let mut command = Command::new(Path::new(root).join("System32/notepad.exe"));
            // Older Notepad versions do not accept canonical extended-length paths.
            let path = file.to_string_lossy();
            let path = if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
                format!(r"\\{unc}")
            } else {
                path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned()
            };
            command.arg(path);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            Ok(command)
        }
        "macos" => {
            let mut command = Command::new("/usr/bin/open");
            command.args(["-b", "com.apple.TextEdit"]).arg(file);
            Ok(command)
        }
        _ => Err("当前系统暂不支持打开配置文件。".into()),
    }
}

pub async fn open(file: &Path) -> Result<()> {
    use std::process::Stdio;
    let root = std::env::var_os("SystemRoot");
    let mut command =
        tokio::process::Command::from(editor_command(file, std::env::consts::OS, root.as_deref())?);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        command
            .spawn()
            .map_err(|_| "无法启动记事本，请检查系统应用是否可用。".to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        command.kill_on_drop(true);
        let status = tokio::time::timeout(std::time::Duration::from_secs(8), command.status())
            .await
            .map_err(|_| "打开文本编辑超时，请重试。".to_string())?
            .map_err(|_| "无法启动文本编辑，请检查系统应用是否可用。".to_string())?;
        if !status.success() {
            return Err("无法使用文本编辑打开配置文件。".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_system_editors_and_passes_paths_as_one_literal_argument() {
        let path = Path::new(r"\\?\C:\Users\A B\$literal&file.config.toml");
        let command = editor_command(path, "windows", Some(OsStr::new(r"C:\Windows"))).unwrap();
        assert_eq!(
            command.get_program(),
            Path::new(r"C:\Windows").join("System32/notepad.exe")
        );
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [OsStr::new(r"C:\Users\A B\$literal&file.config.toml")]
        );
        let unc = editor_command(
            Path::new(r"\\?\UNC\server\share\config.toml"),
            "windows",
            Some(OsStr::new(r"C:\Windows")),
        )
        .unwrap();
        assert_eq!(
            unc.get_args().collect::<Vec<_>>(),
            [OsStr::new(r"\\server\share\config.toml")]
        );
        let path = Path::new("/Users/A B/$literal&file.config.toml");
        let command = editor_command(path, "macos", None).unwrap();
        assert_eq!(command.get_program(), "/usr/bin/open");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                OsStr::new("-b"),
                OsStr::new("com.apple.TextEdit"),
                path.as_os_str()
            ]
        );
        assert!(editor_command(path, "windows", None).is_err());
        assert!(editor_command(path, "linux", None).is_err());
    }
}
