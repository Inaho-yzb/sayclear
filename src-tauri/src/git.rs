use crate::model::within_limit;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitRepository {
    pub path: String,
    pub base_branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GitIteration {
    pub repository_path: String,
    pub branch: String,
    pub base_branch: String,
    pub base_commit: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryInfo {
    pub path: String,
    pub current_branch: Option<String>,
    pub branches: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
}

fn valid_path(value: &str) -> bool {
    !value.trim().is_empty() && within_limit(value, 4096) && !value.contains('\0')
}

fn valid_branch(value: &str) -> bool {
    !value.trim().is_empty() && within_limit(value, 240) && !value.chars().any(char::is_control)
}

impl GitRepository {
    pub fn validate(&self) -> Result<(), String> {
        if !valid_path(&self.path)
            || !valid_branch(&self.base_branch)
            || self
                .remote_url
                .as_deref()
                .is_some_and(|url| !valid_remote(url))
        {
            return Err("Git 仓库路径或基准分支无效".into());
        }
        Ok(())
    }
}

fn valid_remote(address: &str) -> bool {
    if address.is_empty()
        || !within_limit(address, 4096)
        || address.chars().any(char::is_control)
        || address.starts_with('-')
    {
        return false;
    }
    if let Some(path) = address.strip_prefix("file://") {
        return Path::new(path).is_absolute();
    }
    if address.chars().any(char::is_whitespace) || address.contains(['?', '#']) {
        return false;
    }
    for scheme in ["https://", "http://", "ssh://"] {
        if let Some(rest) = address.strip_prefix(scheme) {
            let Some((authority, path)) = rest.split_once('/') else {
                return false;
            };
            if path.is_empty() || authority.is_empty() || authority.starts_with('-') {
                return false;
            }
            let host = if scheme == "ssh://" {
                match authority.rsplit_once('@') {
                    Some((user, host)) if valid_ssh_user(user) => host,
                    Some(_) => return false,
                    None => authority,
                }
            } else {
                // Credentials belong in the user's Git credential helper, never workspace data.
                if authority.contains('@') {
                    return false;
                }
                authority
            };
            return valid_host(host);
        }
    }
    // Git's usual SSH spelling: git@example.com:team/repository.git.
    if let Some((authority, path)) = address.split_once(':') {
        if path.is_empty() || authority.contains('/') {
            return false;
        }
        if let Some((user, host)) = authority.split_once('@') {
            return valid_ssh_user(user) && valid_host(host) && !host.contains(':');
        }
    }
    false
}

fn valid_ssh_user(user: &str) -> bool {
    !user.is_empty()
        && !user.starts_with('-')
        && user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn valid_host(host: &str) -> bool {
    if host.is_empty() || host.starts_with('-') || host.contains(['@', '\\', '%']) {
        return false;
    }
    if let Some(ipv6) = host.strip_prefix('[') {
        let Some((address, port)) = ipv6.split_once(']') else {
            return false;
        };
        return address.parse::<std::net::Ipv6Addr>().is_ok()
            && (port.is_empty() || valid_port(port.strip_prefix(':').unwrap_or("")));
    }
    let (hostname, port) = host
        .split_once(':')
        .map_or((host, None), |(h, p)| (h, Some(p)));
    !hostname.is_empty()
        && hostname
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
        && port.is_none_or(valid_port)
}

fn valid_port(port: &str) -> bool {
    port.parse::<u16>().is_ok_and(|port| port != 0)
}

fn origin(path: &Path) -> Option<String> {
    // Reading the raw configured URL avoids credential-bearing `insteadOf` expansions.
    let output = command(path)
        .args(["config", "--get", "remote.origin.url"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim_end_matches(['\n', '\r']);
    valid_remote(value).then(|| value.to_owned())
}

pub(crate) fn resolve(address: &str, cache_directory: &Path) -> Result<RepositoryInfo, String> {
    let address = address.trim();
    if !valid_path(address) || address.chars().any(char::is_control) {
        return Err("请填写有效的 Git 仓库地址".into());
    }
    let local = if address == "~" || address.starts_with("~/") || address.starts_with("~\\") {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .ok_or("无法读取用户目录，请填写完整的本地仓库路径")?;
        Some(PathBuf::from(home).join(address.get(2..).unwrap_or("")))
    } else if Path::new(address).is_absolute() {
        Some(PathBuf::from(address))
    } else {
        None
    };
    if let Some(path) = local {
        return inspect(path.to_str().ok_or("本地仓库路径不是有效 UTF-8")?);
    }
    if !valid_remote(address) {
        return Err(
            "请填写本地仓库完整路径或有效的 HTTPS / SSH 仓库地址；登录信息请通过本机 Git 配置"
                .into(),
        );
    }
    clone_repository(address, cache_directory, Duration::from_secs(120))
}

fn clone_repository(
    address: &str,
    cache_directory: &Path,
    timeout: Duration,
) -> Result<RepositoryInfo, String> {
    if !cache_directory.is_absolute() {
        return Err("Git 仓库缓存目录必须是完整路径".into());
    }
    fs::create_dir_all(cache_directory).map_err(|e| format!("无法创建 Git 仓库保存目录：{e}"))?;
    let cache_directory = fs::canonicalize(cache_directory).map_err(|e| e.to_string())?;
    let mut hash = 0xcbf29ce484222325u64;
    for byte in address.bytes() {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    let slug: String = address
        .rsplit(['/', ':'])
        .find(|part| !part.is_empty())
        .unwrap_or("repository")
        .trim_end_matches(".git")
        .chars()
        .take(48)
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let destination = cache_directory.join(format!(
        "{}-{hash:016x}",
        if slug.is_empty() { "repository" } else { &slug }
    ));
    let repository = destination.join("repository");
    if destination.exists() {
        return cached_repository(&destination, &repository, address);
    }
    let staging = tempfile::Builder::new()
        .prefix(".clone-")
        .tempdir_in(&cache_directory)
        .map_err(|e| format!("无法准备 Git 仓库目录：{e}"))?;
    let cloned = staging.path().join("repository");
    let errors = fs::File::create(staging.path().join("clone.log")).map_err(|e| e.to_string())?;
    let mut cmd = command(staging.path());
    cmd.args(["clone", "--quiet", "--origin", "origin", "--", address])
        .arg(&cloned)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(errors))
        .env("GCM_INTERACTIVE", "Never");
    let custom_ssh = ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT"]
        .iter()
        .any(|key| std::env::var_os(key).is_some())
        || ["core.sshCommand", "ssh.variant"].iter().any(|key| {
            command(staging.path())
                .args(["config", "--get", key])
                .output()
                .is_ok_and(|output| output.status.success() && !output.stdout.is_empty())
        });
    if !custom_ssh {
        cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes -oConnectTimeout=15")
            .env("SSH_ASKPASS_REQUIRE", "never");
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法运行 Git，请检查本机 Git 安装：{e}"))?;
    let started = Instant::now();
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("克隆 Git 仓库超时，请检查网络后重试".to_owned());
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("无法读取 Git 克隆结果，请重试".to_owned());
            }
        }
    }?;
    if !result.success() {
        return Err("克隆 Git 仓库失败，请检查仓库地址、网络和本机 Git 登录权限".into());
    }
    let mut info = inspect(cloned.to_str().ok_or("Git 保存路径不是有效 UTF-8")?).map_err(|_| {
        "仓库已下载，但没有可用的默认分支或提交，请先在远程仓库完成首次提交".to_owned()
    })?;
    if info.remote_url.as_deref() != Some(address) {
        return Err("克隆后的仓库来源与填写地址不一致，请检查本机 Git 配置".into());
    }
    // Reserve a fresh container atomically; never replace a directory belonging to another process.
    match fs::create_dir(&destination) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return cached_repository(&destination, &repository, address);
        }
        Err(error) => return Err(format!("无法保存克隆后的仓库：{error}")),
    }
    if let Err(error) = fs::rename(&cloned, &repository) {
        let _ = fs::remove_dir(&destination);
        return Err(format!("无法保存克隆后的仓库：{error}"));
    }
    info.path = repository
        .to_str()
        .ok_or("Git 保存路径不是有效 UTF-8")?
        .to_owned();
    Ok(info)
}

fn cached_repository(
    destination: &Path,
    repository: &Path,
    address: &str,
) -> Result<RepositoryInfo, String> {
    if fs::symlink_metadata(destination)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
        || fs::symlink_metadata(repository).is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err("仓库保存位置包含链接，请选择其他仓库地址".into());
    }
    let info = inspect(repository.to_str().ok_or("Git 保存路径不是有效 UTF-8")?)
        .map_err(|_| "仓库保存位置不可用，或另一项克隆尚未完成，请稍后重试".to_owned())?;
    let root = fs::canonicalize(repository).map_err(|e| e.to_string())?;
    if Path::new(&info.path) != root {
        return Err("仓库保存位置不是独立的 Git 仓库，现有文件已保留".into());
    }
    if info.remote_url.as_deref() != Some(address) {
        return Err("仓库保存位置已有其他来源的仓库，现有文件已保留".into());
    }
    Ok(info)
}

impl GitIteration {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if !valid_path(&self.repository_path)
            || !valid_branch(&self.branch)
            || !valid_branch(&self.base_branch)
            || ![40, 64].contains(&self.base_commit.len())
            || !self
                .base_commit
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("迭代 Git 分支信息无效".into());
        }
        Ok(())
    }
}

fn command(path: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path);
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_NAMESPACE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ] {
        cmd.env_remove(key);
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

fn git(path: &Path, args: &[&str]) -> Result<String, String> {
    let output = command(path)
        .args(args)
        .output()
        .map_err(|e| format!("无法运行 Git，请检查本机 Git 安装：{e}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git 操作失败：{}", message.trim()));
    }
    String::from_utf8(output.stdout).map_err(|_| "Git 返回的路径或分支不是有效 UTF-8".into())
}

pub(crate) fn inspect(path: &str) -> Result<RepositoryInfo, String> {
    if !valid_path(path) || !Path::new(path).is_absolute() {
        return Err("请选择有效的本地 Git 仓库文件夹".into());
    }
    let selected = fs::canonicalize(path).map_err(|e| format!("无法访问 Git 仓库：{e}"))?;
    if !selected.is_dir() {
        return Err("请选择 Git 仓库文件夹".into());
    }
    if git(&selected, &["rev-parse", "--is-bare-repository"])?.trim() == "true" {
        return Err("请选择带工作目录的 Git 仓库，暂不支持裸仓库".into());
    }
    let root = git(&selected, &["rev-parse", "--show-toplevel"])?;
    let root = fs::canonicalize(root.trim_end_matches(['\n', '\r']))
        .map_err(|e| format!("无法访问 Git 仓库根目录：{e}"))?;
    let path = root
        .to_str()
        .filter(|value| valid_path(value))
        .ok_or("Git 仓库路径无效")?
        .to_owned();
    let branches: Vec<String> = git(
        &root,
        &[
            "for-each-ref",
            "--format=%(refname:strip=2)",
            "--sort=refname",
            "refs/heads/",
        ],
    )?
    .lines()
    .map(str::to_owned)
    .collect();
    if branches.is_empty() {
        return Err("Git 仓库还没有本地提交和分支，请先完成首次提交".into());
    }
    let output = command(&root)
        .args(["symbolic-ref", "--quiet", "HEAD"])
        .output()
        .map_err(|e| format!("无法读取当前 Git 分支：{e}"))?;
    let current_branch = if output.status.success() {
        let reference = String::from_utf8(output.stdout).map_err(|_| "Git 分支不是有效 UTF-8")?;
        Some(
            reference
                .trim_end_matches(['\n', '\r'])
                .strip_prefix("refs/heads/")
                .ok_or("当前 Git 引用不是本地分支")?
                .to_owned(),
        )
    } else if output.status.code() == Some(1) {
        None
    } else {
        return Err(format!(
            "无法读取当前 Git 分支：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    };
    Ok(RepositoryInfo {
        path,
        current_branch,
        branches,
        remote_url: origin(&root),
    })
}

pub(crate) fn create_branch(
    repository: &GitRepository,
    branch: &str,
    base_branch: &str,
) -> Result<GitIteration, String> {
    repository.validate()?;
    if !valid_branch(branch) || !valid_branch(base_branch) {
        return Err("Git 分支名无效或超出 240 个字符".into());
    }
    let info = inspect(&repository.path)?;
    let path = Path::new(&info.path);
    for name in [branch, base_branch] {
        if name.starts_with('-') || name == "@" {
            return Err("Git 分支名无效：不能以连字符开头或使用 @".into());
        }
        let checked = git(path, &["check-ref-format", "--branch", name])
            .map_err(|_| format!("Git 分支名无效：{name}"))?;
        if checked.trim_end_matches(['\n', '\r']) != name {
            return Err(format!("请填写完整 Git 分支名：{name}"));
        }
    }
    if info.branches.iter().any(|name| name == branch) {
        return Err(format!("Git 分支「{branch}」已存在，请使用其他名称"));
    }
    if !info.branches.iter().any(|name| name == base_branch) {
        return Err(format!("基准分支「{base_branch}」不存在，请刷新仓库分支"));
    }
    let reference = format!("refs/heads/{base_branch}^{{commit}}");
    let base_commit = git(
        path,
        &["rev-parse", "--verify", "--end-of-options", &reference],
    )?
    .trim()
    .to_owned();
    let binding = GitIteration {
        repository_path: info.path.clone(),
        branch: branch.to_owned(),
        base_branch: base_branch.to_owned(),
        base_commit,
    };
    binding.validate()?;
    // Branch creation is atomic and refuses an existing ref. No checkout or index changes.
    git(
        path,
        &["branch", "--no-track", "--", branch, &binding.base_commit],
    )?;
    Ok(binding)
}

pub(crate) fn rollback_branch(binding: &GitIteration) -> Result<(), String> {
    let reference = format!("refs/heads/{}", binding.branch);
    let worktrees = git(
        Path::new(&binding.repository_path),
        &["worktree", "list", "--porcelain"],
    )?;
    if worktrees
        .lines()
        .any(|line| line == format!("branch {reference}"))
    {
        return Err("新分支已被其他进程检出，已保留该分支".into());
    }
    // The expected object ID protects a branch changed by another process after creation.
    git(
        Path::new(&binding.repository_path),
        &["update-ref", "-d", &reference, &binding.base_commit],
    )?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn run(path: &Path, args: &[&str]) -> String {
        git(path, args).unwrap()
    }

    pub(crate) fn repository() -> tempfile::TempDir {
        let directory = tempfile::Builder::new()
            .prefix("仓库 with spaces-")
            .tempdir()
            .unwrap();
        run(directory.path(), &["init", "--initial-branch=main"]);
        run(
            directory.path(),
            &["config", "user.email", "test@example.invalid"],
        );
        run(directory.path(), &["config", "user.name", "Git Tests"]);
        run(
            directory.path(),
            &[
                "config",
                "core.hooksPath",
                "/nonexistent-say-clear-test-hooks",
            ],
        );
        run(
            directory.path(),
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "initial",
            ],
        );
        directory
    }

    #[test]
    fn creates_from_selected_local_base_and_preserves_checkout_and_dirty_files() {
        let directory = repository();
        let path = directory.path();
        run(path, &["branch", "other"]);
        run(
            path,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "second",
            ],
        );
        fs::write(path.join("untracked.txt"), "working file").unwrap();
        let info = inspect(path.to_str().unwrap()).unwrap();
        assert_eq!(info.current_branch.as_deref(), Some("main"));
        assert_eq!(info.branches, ["main", "other"]);
        let repo = GitRepository {
            path: info.path,
            base_branch: "main".into(),
            remote_url: None,
        };
        let binding = create_branch(&repo, "iteration/中文-branch", "other").unwrap();
        assert_eq!(
            binding.base_commit,
            run(path, &["rev-parse", "other"]).trim()
        );
        assert_eq!(
            binding.base_commit,
            run(path, &["rev-parse", "iteration/中文-branch"]).trim()
        );
        assert_eq!(run(path, &["branch", "--show-current"]).trim(), "main");
        assert_eq!(
            fs::read_to_string(path.join("untracked.txt")).unwrap(),
            "working file"
        );
        assert!(create_branch(&repo, "iteration/中文-branch", "other")
            .unwrap_err()
            .contains("已存在"));
        for branch in [
            "--help",
            "@",
            "@{-1}",
            "bad..branch",
            "bad branch",
            "topic@{1}",
            "bad\nbranch",
        ] {
            assert!(create_branch(&repo, branch, "main").is_err(), "{branch}");
        }
        run(path, &["checkout", "other"]);
        run(path, &["checkout", "main"]);
        assert!(create_branch(&repo, "@{-1}", "main").is_err());
        assert!(create_branch(&repo, "new", "missing")
            .unwrap_err()
            .contains("不存在"));
        assert!(create_branch(&repo, "new", "HEAD").is_err());
        rollback_branch(&binding).unwrap();
        assert!(!inspect(path.to_str().unwrap())
            .unwrap()
            .branches
            .contains(&binding.branch));
    }

    #[test]
    fn rollback_protects_a_branch_advanced_by_another_process() {
        let directory = repository();
        let path = directory.path();
        let binding = create_branch(
            &GitRepository {
                path: path.to_string_lossy().into(),
                base_branch: "main".into(),
                remote_url: None,
            },
            "iteration/test",
            "main",
        )
        .unwrap();
        run(
            path,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "second",
            ],
        );
        run(path, &["branch", "--force", "iteration/test", "main"]);
        assert!(rollback_branch(&binding).is_err());
        assert!(inspect(path.to_str().unwrap())
            .unwrap()
            .branches
            .contains(&binding.branch));
    }

    #[test]
    fn rollback_preserves_a_branch_checked_out_by_another_process() {
        let directory = repository();
        let path = directory.path();
        let binding = create_branch(
            &GitRepository {
                path: path.to_string_lossy().into(),
                base_branch: "main".into(),
                remote_url: None,
            },
            "iteration/checked-out",
            "main",
        )
        .unwrap();
        run(path, &["checkout", "iteration/checked-out"]);
        assert!(rollback_branch(&binding).unwrap_err().contains("检出"));
        assert_eq!(
            run(path, &["branch", "--show-current"]).trim(),
            binding.branch
        );
        assert!(inspect(path.to_str().unwrap())
            .unwrap()
            .branches
            .contains(&binding.branch));
    }

    #[test]
    fn handles_linked_worktrees_subfolders_and_detached_head() {
        let directory = repository();
        let worktree = tempfile::tempdir().unwrap();
        let target = worktree.path().join("linked tree");
        run(
            directory.path(),
            &["worktree", "add", "-b", "linked", target.to_str().unwrap()],
        );
        fs::create_dir(target.join("nested")).unwrap();
        let info = inspect(target.join("nested").to_str().unwrap()).unwrap();
        assert_eq!(
            info.path,
            fs::canonicalize(&target).unwrap().to_string_lossy()
        );
        assert_eq!(info.current_branch.as_deref(), Some("linked"));
        run(&target, &["checkout", "--detach"]);
        assert!(inspect(target.to_str().unwrap())
            .unwrap()
            .current_branch
            .is_none());
        let binding = create_branch(
            &GitRepository {
                path: info.path,
                base_branch: "main".into(),
                remote_url: None,
            },
            "from-detached",
            "main",
        )
        .unwrap();
        assert!(inspect(target.to_str().unwrap())
            .unwrap()
            .current_branch
            .is_none());
        rollback_branch(&binding).unwrap();
    }

    #[test]
    fn rejects_missing_empty_and_bare_repositories() {
        let directory = tempfile::tempdir().unwrap();
        assert!(inspect(directory.path().to_str().unwrap()).is_err());
        run(directory.path(), &["init", "--initial-branch=main"]);
        assert!(inspect(directory.path().to_str().unwrap())
            .unwrap_err()
            .contains("首次提交"));
        let bare = tempfile::tempdir().unwrap();
        run(bare.path(), &["init", "--bare"]);
        assert!(inspect(bare.path().to_str().unwrap())
            .unwrap_err()
            .contains("裸仓库"));
        assert!(inspect("relative/path").is_err());
        assert!(inspect("/missing-sayclear-git-repo").is_err());
    }

    #[test]
    fn validates_repository_addresses_without_accepting_embedded_credentials() {
        for address in [
            "https://example.com/team/repository.git",
            "http://localhost:3000/team/repository.git",
            "ssh://git@example.com:2222/team/repository.git",
            "ssh://git@[::1]:22/team/repository.git",
            "git@example.com:team/repository.git",
            "file:///tmp/local repository",
        ] {
            assert!(valid_remote(address), "{address}");
        }
        for address in [
            "",
            "--upload-pack=anything",
            "relative/path",
            "https://",
            "https://example.com",
            "https://example.com/",
            "https://user:secret@example.com/repository.git",
            "https://secret@example.com/repository.git",
            "ssh://user:secret@example.com/repository.git",
            "https://example.com/repository.git?token=secret",
            "git@host:",
            "file://relative/path",
            "https://example.com:invalid/repository",
            "https://example.com/repo\nother",
        ] {
            assert!(!valid_remote(address), "{address}");
        }
    }

    #[test]
    fn resolves_typed_local_paths_and_suppresses_unsafe_origin_urls() {
        let source = repository();
        let cache = tempfile::tempdir().unwrap();
        let canonical = fs::canonicalize(source.path()).unwrap();
        let typed = format!("  {}  ", source.path().display());
        let info = resolve(&typed, cache.path()).unwrap();
        assert_eq!(info.path, canonical.to_string_lossy());
        assert!(info.remote_url.is_none());
        run(
            source.path(),
            &[
                "remote",
                "add",
                "origin",
                "https://user:secret@example.com/repository.git",
            ],
        );
        assert!(inspect(source.path().to_str().unwrap())
            .unwrap()
            .remote_url
            .is_none());
        run(
            source.path(),
            &[
                "remote",
                "set-url",
                "origin",
                "git@example.com:team/repository.git",
            ],
        );
        assert_eq!(
            inspect(source.path().to_str().unwrap())
                .unwrap()
                .remote_url
                .as_deref(),
            Some("git@example.com:team/repository.git")
        );
        assert_eq!(fs::read_dir(cache.path()).unwrap().count(), 0);
    }

    #[test]
    fn clones_typed_file_url_and_reuses_only_the_matching_cached_repository() {
        let source = repository();
        let cache = tempfile::tempdir().unwrap();
        let address = format!("file://{}", source.path().display());
        let info = resolve(&address, cache.path()).unwrap();
        assert_ne!(info.path, source.path().to_string_lossy());
        assert_eq!(info.remote_url.as_deref(), Some(address.as_str()));
        assert_eq!(info.current_branch.as_deref(), Some("main"));
        assert_eq!(
            run(Path::new(&info.path), &["rev-parse", "HEAD"]),
            run(source.path(), &["rev-parse", "HEAD"])
        );
        fs::write(
            Path::new(&info.path).join("uncommitted.txt"),
            "keep local work",
        )
        .unwrap();
        let reused = resolve(&address, cache.path()).unwrap();
        assert_eq!(reused.path, info.path);
        assert_eq!(
            fs::read_to_string(Path::new(&reused.path).join("uncommitted.txt")).unwrap(),
            "keep local work"
        );
        assert_eq!(fs::read_dir(cache.path()).unwrap().count(), 1);
        run(
            Path::new(&info.path),
            &[
                "remote",
                "set-url",
                "origin",
                "https://example.com/different.git",
            ],
        );
        assert!(resolve(&address, cache.path())
            .unwrap_err()
            .contains("其他来源"));
        assert_eq!(
            fs::read_to_string(Path::new(&info.path).join("uncommitted.txt")).unwrap(),
            "keep local work"
        );
    }

    #[test]
    fn failed_or_empty_remote_clones_leave_no_partial_repository() {
        let cache = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let missing = format!("file://{}/missing", source.path().display());
        assert!(resolve(&missing, cache.path())
            .unwrap_err()
            .contains("克隆"));
        assert_eq!(fs::read_dir(cache.path()).unwrap().count(), 0);
        run(source.path(), &["init", "--initial-branch=main"]);
        let empty = format!("file://{}", source.path().display());
        assert!(resolve(&empty, cache.path())
            .unwrap_err()
            .contains("首次提交"));
        assert_eq!(fs::read_dir(cache.path()).unwrap().count(), 0);
        let error = resolve(
            "https://user:private-token@example.com/team/repository.git",
            cache.path(),
        )
        .unwrap_err();
        assert!(!error.contains("private-token"));
        assert_eq!(fs::read_dir(cache.path()).unwrap().count(), 0);
    }
}
