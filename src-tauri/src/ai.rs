use crate::storage::atomic_write;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Codex,
    Qodercli,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolConfig {
    pub executable: String,
    pub model: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSettings {
    pub provider: Provider,
    pub codex: ToolConfig,
    pub qodercli: ToolConfig,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            provider: Provider::Codex,
            codex: ToolConfig {
                executable: "codex".into(),
                model: String::new(),
            },
            qodercli: ToolConfig {
                executable: "qodercli".into(),
                model: String::new(),
            },
        }
    }
}

impl AiSettings {
    fn tool(&self) -> &ToolConfig {
        match self.provider {
            Provider::Codex => &self.codex,
            Provider::Qodercli => &self.qodercli,
        }
    }
    fn validate(&self) -> Result<(), String> {
        for tool in [&self.codex, &self.qodercli] {
            if tool.executable.trim().is_empty()
                || tool.executable.len() > 4096
                || tool.executable.contains(['\0', '\n', '\r'])
                || tool.model.len() > 200
                || tool.model.contains(['\0', '\n', '\r'])
            {
                return Err("AI 设置无效，请填写命令名称或可执行文件的完整路径".into());
            }
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiRequest {
    pub request_id: String,
    pub session_id: Option<String>,
    pub prompt: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiResponse {
    pub session_id: String,
    pub output: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProgress {
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    stage: &'static str,
    message: String,
}

struct ProgressStream<'a> {
    offset: usize,
    event: AiProgress,
    report: &'a dyn Fn(AiProgress),
}

impl ProgressStream<'_> {
    fn emit(&mut self, stage: &'static str, message: impl Into<String>) {
        self.event.stage = stage;
        self.event.message = message.into();
        (self.report)(self.event.clone());
    }

    fn consume(&mut self, output: &[u8]) -> bool {
        // Parse complete lines only: reads may split JSON or a UTF-8 character.
        while let Some(length) = output[self.offset..].iter().position(|byte| *byte == b'\n') {
            let line = &output[self.offset..self.offset + length];
            self.offset += length + 1;
            let Ok(value) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            if let Some(session) = value["thread_id"]
                .as_str()
                .or_else(|| value["session_id"].as_str())
            {
                if valid_id(session) {
                    self.event.session_id = Some(session.to_owned());
                }
            }
            match value["type"].as_str().unwrap_or("") {
                "thread.started" | "system" => {
                    self.emit("connected", "会话已连接，正在准备模型请求…")
                }
                "turn.started" => self.emit("thinking", "请求已提交，等待模型回复…"),
                "error" => self.emit(
                    "retrying",
                    format!(
                        "连接异常，工具正在重试：{}",
                        value["message"]
                            .as_str()
                            .unwrap_or("等待重新连接")
                            .chars()
                            .take(400)
                            .collect::<String>()
                    ),
                ),
                "item.started" | "item.completed" => {
                    match value["item"]["type"].as_str().unwrap_or("") {
                        "agent_message" => self.emit("responding", "正在接收 AI 回复…"),
                        "reasoning" => self.emit("thinking", "模型正在处理画板…"),
                        "error"
                            if value["item"]["message"]
                                .as_str()
                                .is_some_and(|message| message.contains("Falling back")) =>
                        {
                            self.emit("retrying", "正在切换连接方式并重试…")
                        }
                        _ => {}
                    }
                }
                "turn.completed" | "result" => {
                    self.emit("completed", "已收到结果，正在校验…");
                    return true;
                }
                "turn.failed" => return true,
                _ => {}
            }
        }
        false
    }
}

pub struct AiManager {
    root: PathBuf,
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
    settings_lock: Mutex<()>,
}

impl AiManager {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            running: Mutex::new(HashMap::new()),
            settings_lock: Mutex::new(()),
        }
    }
    pub fn load(&self) -> Result<AiSettings, String> {
        let _guard = self.settings_lock.lock().map_err(|e| e.to_string())?;
        match fs::read(self.root.join("ai-settings.json")) {
            Ok(bytes) => {
                let settings: AiSettings = serde_json::from_slice(&bytes)
                    .map_err(|_| "AI 设置文件损坏，请在 AI 设置中重新保存".to_string())?;
                settings.validate()?;
                Ok(settings)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AiSettings::default()),
            Err(e) => Err(format!("无法读取 AI 设置：{e}")),
        }
    }
    pub fn save(&self, settings: &AiSettings) -> Result<(), String> {
        settings.validate()?;
        let _guard = self.settings_lock.lock().map_err(|e| e.to_string())?;
        fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        atomic_write(
            &self.root.join("ai-settings.json"),
            &serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?,
        )
    }
    pub fn register(&self, id: &str) -> Result<Arc<AtomicBool>, String> {
        if !valid_id(id) {
            return Err("AI 请求 ID 无效".into());
        }
        let mut running = self.running.lock().map_err(|e| e.to_string())?;
        if running.values().any(|flag| !flag.load(Ordering::SeqCst)) {
            return Err("已有 AI 请求正在执行，请稍后重试".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        running.insert(id.into(), cancelled.clone());
        Ok(cancelled)
    }
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        if let Some(flag) = self.running.lock().map_err(|e| e.to_string())?.get(id) {
            flag.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
    pub fn cancel_all(&self) {
        if let Ok(running) = self.running.lock() {
            for flag in running.values() {
                flag.store(true, Ordering::SeqCst);
            }
        }
        // Keep the app alive briefly so the worker can kill and reap its child on exit.
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(2) {
            if self
                .running
                .lock()
                .map(|running| running.is_empty())
                .unwrap_or(true)
            {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
    pub fn run(
        &self,
        request: AiRequest,
        cancelled: Arc<AtomicBool>,
        report: impl Fn(AiProgress),
    ) -> Result<AiResponse, String> {
        let result = (|| {
            if request.prompt.trim().is_empty() || request.prompt.len() > 4 * 1024 * 1024 {
                return Err("AI 请求为空或画板上下文过大".into());
            }
            if request
                .session_id
                .as_deref()
                .is_some_and(|id| !valid_id(id))
            {
                return Err("AI 会话 ID 无效，请新建会话".into());
            }
            let settings = self.load()?;
            // The CLI operates in its own directory, never in the workspace data directory.
            let cwd = self.root.join("ai-workdir");
            fs::create_dir_all(&cwd).map_err(|e| e.to_string())?;
            let args = turn_args(&settings, request.session_id.as_deref());
            let mut stream = ProgressStream {
                offset: 0,
                event: AiProgress {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    stage: "starting",
                    message: String::new(),
                },
                report: &report,
            };
            stream.emit("starting", "正在启动 AI 工具…");
            let output = execute(
                &settings.tool().executable,
                &args,
                Some(&cwd),
                &request.prompt,
                &cancelled,
                Duration::from_secs(300),
                |output| stream.consume(output),
            )
            .map_err(|error| format!("{error}。最后状态：{}", stream.event.message))?;
            parse_output(&settings.provider, &output, request.session_id.as_deref())
        })();
        if let Ok(mut running) = self.running.lock() {
            running.remove(&request.request_id);
        }
        result
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn turn_args(settings: &AiSettings, session: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = match settings.provider {
        Provider::Codex => vec![
            "exec",
            "--sandbox",
            "read-only",
            "-c",
            "approval_policy=\"never\"",
        ],
        Provider::Qodercli => vec![
            "--print",
            "--output-format",
            "json",
            "--permission-mode",
            "dont_ask",
            "--tools",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            "{\"mcpServers\":{}}",
        ],
    }
    .into_iter()
    .map(String::from)
    .collect();
    if let Some(id) = session {
        args.push(
            if settings.provider == Provider::Codex {
                "resume"
            } else {
                "--resume"
            }
            .into(),
        );
        args.push(id.into());
    }
    if settings.provider == Provider::Codex {
        // Put output flags on the resume subcommand as well as on new executions.
        args.extend(["--json".into(), "--skip-git-repo-check".into()]);
    }
    if !settings.tool().model.trim().is_empty() {
        args.extend(["--model".into(), settings.tool().model.trim().into()]);
    }
    if settings.provider == Provider::Codex {
        args.push("-".into());
    }
    args
}

// Desktop launches don't inherit a login shell's PATH. Also find common user installs.
fn tool_path() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        paths.extend([
            home.join(".local/bin"),
            home.join(".npm-global/bin"),
            home.join(".volta/bin"),
            home.join(".cargo/bin"),
        ]);
    }
    paths.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from(
            "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS",
        ),
    ]);
    paths
}

fn executable_path(executable: &str, paths: &[PathBuf]) -> PathBuf {
    let executable = executable.trim();
    let path = PathBuf::from(executable);
    if path.is_absolute() {
        return path;
    }
    for dir in paths {
        let candidate = dir.join(executable);
        if candidate.is_file() {
            return candidate;
        }
        #[cfg(windows)]
        for extension in ["exe", "cmd", "bat"] {
            let candidate = dir.join(format!("{executable}.{extension}"));
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    path
}

fn execute(
    executable: &str,
    args: &[String],
    cwd: Option<&Path>,
    input: &str,
    cancelled: &AtomicBool,
    timeout: Duration,
    mut on_output: impl FnMut(&[u8]) -> bool,
) -> Result<String, String> {
    let paths = tool_path();
    let mut command = Command::new(executable_path(executable, &paths));
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    if let Ok(path) = std::env::join_paths(paths) {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut stdin = tempfile::tempfile().map_err(|e| e.to_string())?;
    stdin
        .write_all(input.as_bytes())
        .map_err(|e| e.to_string())?;
    stdin.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let stdout = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    // reopen(), unlike try_clone(), has an independent offset from the child writer.
    let mut stdout_reader = stdout.reopen().map_err(|e| e.to_string())?;
    let mut stderr = tempfile::tempfile().map_err(|e| e.to_string())?;
    command
        .stdin(Stdio::from(stdin))
        .stdout(Stdio::from(stdout.reopen().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(stderr.try_clone().map_err(|e| e.to_string())?));
    if cancelled.load(Ordering::SeqCst) {
        return Err("已停止 AI 请求".into());
    }
    let mut child = command.spawn().map_err(|e| {
        format!(
            "无法启动 {executable}：{e}。请在 AI 设置中检查命令路径，并确认工具已安装、已登录。"
        )
    })?;
    let started = Instant::now();
    let mut output = Vec::new();
    let status = loop {
        let oversized = [stdout.as_file(), &stderr]
            .iter()
            .any(|f| f.metadata().map(|m| m.len() > OUTPUT_LIMIT).unwrap_or(true));
        let error = if cancelled.load(Ordering::SeqCst) {
            Some("已停止 AI 请求")
        } else if started.elapsed() > timeout {
            Some("AI 请求超时，请检查工具登录和网络后重试")
        } else if oversized {
            Some("AI 输出过大，已停止请求；请缩小修改范围")
        } else {
            None
        };
        if let Some(error) = error {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.into());
        }
        match read_available(&mut stdout_reader, &mut output) {
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            Ok(true) if on_output(&output) => {
                // The protocol's terminal event is authoritative. Some CLI cleanup
                // tasks keep the process alive even after the answer is complete.
                for _ in 0..5 {
                    if child.try_wait().ok().flatten().is_some() {
                        return Ok(String::from_utf8_lossy(&output).into_owned());
                    }
                    thread::sleep(Duration::from_millis(20));
                }
                let _ = child.kill();
                let _ = child.wait();
                return Ok(String::from_utf8_lossy(&output).into_owned());
            }
            _ => {}
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
    };
    read_available(&mut stdout_reader, &mut output)?;
    if !status.success() {
        let details = read_output(&mut stderr)?;
        let details = if details.trim().is_empty() {
            String::from_utf8_lossy(&output).into_owned()
        } else {
            details
        };
        let details = serde_json::from_str::<Value>(&details)
            .ok()
            .and_then(|value| {
                value["result"]
                    .as_str()
                    .or_else(|| value["error"]["message"].as_str())
                    .or_else(|| value["message"].as_str())
                    .map(str::to_owned)
            })
            .unwrap_or(details);
        return Err(format!(
            "AI 工具执行失败（{status}）：{}",
            details.chars().take(2000).collect::<String>()
        ));
    }
    Ok(String::from_utf8_lossy(&output).into_owned())
}

fn read_available(file: &mut File, output: &mut Vec<u8>) -> Result<bool, String> {
    let before = output.len();
    file.take(OUTPUT_LIMIT.saturating_sub(before as u64) + 1)
        .read_to_end(output)
        .map_err(|error| error.to_string())?;
    if output.len() as u64 > OUTPUT_LIMIT {
        return Err("AI 输出超出大小限制".into());
    }
    Ok(output.len() != before)
}

fn read_output(file: &mut File) -> Result<String, String> {
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(OUTPUT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > OUTPUT_LIMIT {
        return Err("AI 输出超出大小限制".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn check(settings: &AiSettings) -> Result<String, String> {
    settings.validate()?;
    let version = execute(
        &settings.tool().executable,
        &["--version".into()],
        None,
        "",
        &AtomicBool::new(false),
        Duration::from_secs(10),
        |_| false,
    )?;
    Ok(version.trim().chars().take(500).collect())
}

fn parse_output(
    provider: &Provider,
    output: &str,
    previous: Option<&str>,
) -> Result<AiResponse, String> {
    let mut session = previous.map(str::to_owned);
    let mut message = None;
    let mut complete = false;
    let mut last_error = None;
    let events: Vec<Value> = if *provider == Provider::Qodercli {
        match serde_json::from_str::<Value>(output) {
            Ok(Value::Array(events)) => events,
            Ok(value) => vec![value],
            Err(_) => output
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect(),
        }
    } else {
        output
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    };
    for event in events {
        if let Some(id) = event["thread_id"]
            .as_str()
            .or_else(|| event["session_id"].as_str())
        {
            if valid_id(id) {
                session = Some(id.into());
            }
        }
        if event["type"] == "turn.failed" || event["is_error"] == true {
            return Err(format!(
                "AI 会话失败：{}",
                event["error"]["message"]
                    .as_str()
                    .or_else(|| event["message"].as_str())
                    .or_else(|| event["result"].as_str())
                    .unwrap_or("请检查工具登录状态，或新建会话后重试")
                    .chars()
                    .take(2000)
                    .collect::<String>()
            ));
        }
        if event["type"] == "error" {
            // Reconnect attempts can recover after switching transports.
            last_error = event["message"].as_str().map(str::to_owned);
            complete = false;
            continue;
        }
        if *provider == Provider::Codex {
            if event["type"] == "item.completed" && event["item"]["type"] == "agent_message" {
                message = event["item"]["text"].as_str().map(str::to_owned);
            }
            if event["type"] == "turn.completed" {
                complete = true;
            }
        } else if event["type"] == "result" || event.get("result").is_some() {
            if event["subtype"].as_str().is_some_and(|s| s != "success") {
                return Err("Qoder 会话未成功完成，请重试".into());
            }
            message = event["result"].as_str().map(str::to_owned);
            complete = true;
        }
    }
    if !complete {
        return Err(last_error
            .map(|error| {
                format!(
                    "AI 会话未完成：{}",
                    error.chars().take(2000).collect::<String>()
                )
            })
            .unwrap_or_else(|| "AI 会话未完成，未应用修改。请重试。".into()));
    }
    Ok(AiResponse {
        session_id: session.ok_or("AI 工具未返回会话 ID，请升级工具后重试")?,
        output: message
            .filter(|m| !m.trim().is_empty())
            .ok_or("AI 未返回有效内容，请重试")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_round_trip_and_validation() {
        let dir = tempfile::tempdir().unwrap();
        let manager = AiManager::new(dir.path().into());
        assert_eq!(manager.load().unwrap().provider, Provider::Codex);
        let mut settings = AiSettings::default();
        settings.provider = Provider::Qodercli;
        manager.save(&settings).unwrap();
        assert_eq!(manager.load().unwrap().provider, Provider::Qodercli);
        settings.codex.executable = "\n".into();
        assert!(manager.save(&settings).is_err());
    }
    #[test]
    fn parses_codex_completed_turn_and_rejects_partial_or_failed() {
        let events = "{\"type\":\"thread.started\",\"thread_id\":\"session-1\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello\"}}";
        assert!(parse_output(&Provider::Codex, events, None).is_err());
        let done = format!("{events}\n{{\"type\":\"turn.completed\"}}");
        let result = parse_output(&Provider::Codex, &done, None).unwrap();
        assert_eq!(result.session_id, "session-1");
        assert_eq!(result.output, "hello");
        assert!(parse_output(
            &Provider::Codex,
            &format!("{done}\n{{\"type\":\"turn.failed\"}}"),
            None
        )
        .is_err());
    }
    #[test]
    fn parses_qoder_envelopes_and_errors() {
        let event = r#"{"type":"result","subtype":"success","session_id":"qoder-1","result":"hello","is_error":false}"#;
        assert_eq!(
            parse_output(&Provider::Qodercli, event, None)
                .unwrap()
                .output,
            "hello"
        );
        assert!(parse_output(&Provider::Qodercli, &event.replace("false", "true"), None).is_err());
        assert!(parse_output(
            &Provider::Qodercli,
            &event.replace("success", "error_max_turns"),
            None
        )
        .is_err());
    }
    #[test]
    fn codex_reconnect_can_recover_but_unfinished_stream_is_rejected() {
        let retry = "{\"type\":\"error\",\"message\":\"Reconnecting...\"}\n";
        assert!(parse_output(&Provider::Codex, retry, Some("session-1")).is_err());
        let recovered = format!("{retry}{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\"ok\"}}}}\n{{\"type\":\"turn.completed\"}}");
        assert_eq!(
            parse_output(&Provider::Codex, &recovered, Some("session-1"))
                .unwrap()
                .output,
            "ok"
        );
    }
    #[test]
    fn request_registration_and_cancel_are_scoped() {
        let dir = tempfile::tempdir().unwrap();
        let manager = AiManager::new(dir.path().into());
        let flag = manager.register("request-1").unwrap();
        assert!(manager.register("request-2").is_err());
        manager.cancel("request-2").unwrap();
        assert!(!flag.load(Ordering::SeqCst));
        manager.cancel("request-1").unwrap();
        assert!(flag.load(Ordering::SeqCst));
        let request = AiRequest {
            request_id: "request-1".into(),
            session_id: None,
            prompt: String::new(),
        };
        assert!(manager.run(request, flag, |_| {}).is_err());
        assert!(manager.register("request-2").is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn terminal_event_finishes_without_waiting_for_process_exit() {
        let seen = std::cell::RefCell::new(Vec::new());
        let report = |event: AiProgress| seen.borrow_mut().push(event);
        let mut stream = ProgressStream {
            offset: 0,
            event: AiProgress {
                request_id: "test".into(),
                session_id: None,
                stage: "starting",
                message: String::new(),
            },
            report: &report,
        };
        let script = r#"printf '%s\n' '{"type":"thread.started","thread_id":"session-1"}'; sleep 0.15; printf '%s\n' '{"type":"error","message":"Reconnecting"}'; sleep 0.15; printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"你好"}}' '{"type":"turn.completed"}'; while :; do :; done"#;
        let started = Instant::now();
        let output = execute(
            "/bin/sh",
            &["-c".into(), script.into()],
            None,
            "",
            &AtomicBool::new(false),
            Duration::from_secs(3),
            |output| stream.consume(output),
        )
        .unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(
            parse_output(&Provider::Codex, &output, None)
                .unwrap()
                .output,
            "你好"
        );
        let events = seen.borrow();
        assert_eq!(
            events.iter().map(|event| event.stage).collect::<Vec<_>>(),
            vec!["connected", "retrying", "responding", "completed"]
        );
        assert_eq!(events[0].session_id.as_deref(), Some("session-1"));
    }
    #[test]
    fn progress_preserves_split_utf8_and_partial_lines() {
        let seen = std::cell::RefCell::new(Vec::new());
        let report = |event: AiProgress| seen.borrow_mut().push(event);
        let mut stream = ProgressStream {
            offset: 0,
            event: AiProgress {
                request_id: "test".into(),
                session_id: None,
                stage: "starting",
                message: String::new(),
            },
            report: &report,
        };
        let line = "{\"type\":\"error\",\"message\":\"连接重试\"}\n".as_bytes();
        for end in 1..=line.len() {
            assert!(!stream.consume(&line[..end]));
        }
        let events = seen.borrow();
        assert_eq!(events.len(), 1);
        assert!(events[0].message.contains("连接重试"));
    }
    #[cfg(unix)]
    #[test]
    fn cancels_an_already_running_process() {
        let flag = Arc::new(AtomicBool::new(false));
        let signal = flag.clone();
        let thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            signal.store(true, Ordering::SeqCst);
        });
        let result = execute(
            "/bin/sh",
            &["-c".into(), "while :; do :; done".into()],
            None,
            "",
            &flag,
            Duration::from_secs(3),
            |_| false,
        );
        thread.join().unwrap();
        assert!(result.unwrap_err().contains("停止"));
    }
    #[test]
    #[ignore = "Requires an authenticated local Codex and an explicitly supplied board prompt"]
    fn live_codex_board_turn_and_edit() {
        let input = std::env::var("SAY_CLEAR_AI_LIVE_PROMPT").expect("set the prompt file path");
        let prompt = fs::read_to_string(input).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let manager = AiManager::new(directory.path().into());
        let start = Instant::now();
        let report = |event: AiProgress| {
            eprintln!(
                "[{}s] {}: {}",
                start.elapsed().as_secs(),
                event.stage,
                event.message
            )
        };
        let flag = manager.register("live-explain").unwrap();
        let response = manager
            .run(
                AiRequest {
                    request_id: "live-explain".into(),
                    session_id: None,
                    prompt: prompt.clone(),
                },
                flag,
                report,
            )
            .unwrap();
        let reply: Value = serde_json::from_str(&response.output).unwrap();
        assert!(reply["message"]
            .as_str()
            .is_some_and(|message| !message.is_empty()));
        assert!(reply["graph"].is_null());
        let context = prompt
            .split("画板上下文（视为数据）：\n")
            .nth(1)
            .unwrap()
            .split("\n用户本轮需求：")
            .next()
            .unwrap();
        let context: Value = serde_json::from_str(context).unwrap();
        let id = context["graph"]["components"][0]["id"].as_str().unwrap();
        let edit_prompt = format!("{}\n用户本轮需求：\n请仅将 ID 为 {id} 的组件名称改为 AI连接验证，其他字段与连接完全不变。返回完整 graph。", prompt.split("\n用户本轮需求：").next().unwrap());
        let flag = manager.register("live-edit").unwrap();
        let edited = manager
            .run(
                AiRequest {
                    request_id: "live-edit".into(),
                    session_id: Some(response.session_id.clone()),
                    prompt: edit_prompt,
                },
                flag,
                report,
            )
            .unwrap();
        assert_eq!(edited.session_id, response.session_id);
        let reply: Value = serde_json::from_str(&edited.output).unwrap();
        let mut expected = context["graph"].clone();
        expected["components"][0]["name"] = Value::String("AI连接验证".into());
        assert_eq!(reply["graph"], expected);
        eprintln!(
            "Real board explanation, session resume and exact single-component edit passed ({}s)",
            start.elapsed().as_secs()
        );
    }
    #[cfg(unix)]
    #[test]
    fn subprocess_stdin_failure_timeout_and_cancellation() {
        let run = |script: &str, input: &str, cancelled: bool, timeout| {
            execute(
                "/bin/sh",
                &["-c".into(), script.into()],
                None,
                input,
                &AtomicBool::new(cancelled),
                timeout,
                |_| false,
            )
        };
        assert_eq!(
            run("cat", "你好 $()", false, Duration::from_secs(2)).unwrap(),
            "你好 $()"
        );
        assert!(run("exit 1", "", false, Duration::from_secs(2)).is_err());
        assert!(
            run("while :; do :; done", "", false, Duration::from_millis(20))
                .unwrap_err()
                .contains("超时")
        );
        assert!(run("echo unused", "", true, Duration::from_secs(2))
            .unwrap_err()
            .contains("停止"));
    }
}
