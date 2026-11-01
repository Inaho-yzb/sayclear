//! The command-line adapter and the local desktop command bridge.
//!
//! Business rules live in graph_commands. A running desktop owns its workspace:
//! CLI requests go through the WebView's current state, rather than stale files.
use crate::{
    graph_commands::{CommandError, GraphRequest},
    storage::WorkspaceStore,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{hash_map::RandomState, HashMap},
    fs::{self, File, OpenOptions},
    hash::{BuildHasher, Hasher},
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;

const MAX_BYTES: u64 = 8 * 1024 * 1024;
// Reads may include a full editable graph plus its immutable iteration baseline.
// Keep the smaller request limit without truncating valid stored graph responses.
const MAX_RESPONSE_BYTES: u64 = 256 * 1024 * 1024;
const ENDPOINT: &str = ".sayclear-cli.json";
const TIMEOUT: Duration = Duration::from_secs(30);

const HELP: &str = r#"Say Clear business CLI

Usage:
  sayclear graph list [--parent ID] [--system ID] [--query TEXT] [--json]
  sayclear graph get GRAPH_ID [--graph-version editable|current|iteration|history]
  sayclear graph create --name NAME --if-match REVISION [--parent ID] [--kind KIND]
  sayclear graph update GRAPH_ID --input FILE|- --if-match REVISION
  sayclear graph delete GRAPH_ID --if-match REVISION [--dry-run]
  sayclear component list --graph GRAPH_ID
  sayclear component get COMPONENT_ID --graph GRAPH_ID
  sayclear component create --graph GRAPH_ID --input FILE|- --if-match REVISION
  sayclear component update COMPONENT_ID --graph GRAPH_ID --input FILE|- --if-match REVISION
  sayclear component delete COMPONENT_ID --graph GRAPH_ID --if-match REVISION
  sayclear connection list|get|create|update|delete [CONNECTION_ID] --graph GRAPH_ID
  sayclear catalog list

Options:
  --workspace DIR    Use this business data directory directly.
  --data-dir DIR     Read data-directory.json from this application configuration directory.
  --input FILE|-     JSON object from a UTF-8 file or standard input (maximum 8 MiB).
  --if-match REV     Revision returned by a previous graph query; required for writes.
  --dry-run          Validate and report changes without saving.
  --json             Machine-readable JSON (also the default).
  --id ID            Stable ID for a newly created graph/component/connection.
  --name NAME        Set a graph or component name.
  --description TEXT Set a description.
  --parent ID        Parent graph for creation/list filtering.
  --kind KIND        Graph kind for creation.
  --scenario ID      Scenario for graph creation.
  --system ID        Filter graph list by application system.
  --query TEXT       Search graph names/descriptions.
  --graph-version V  Read editable (default), current, iteration, or history.
  --history ID       Historical version ID; use with --graph-version history.
  --help, -h         Print this help.
  --version, -V      Print the program version.

Graph updates accept {"name":...,"description":...,"operations":[...]}; each operation
uses op (component.create/update/delete or connection.create/update/delete), id,
and value (create) or changes (update). Component/connection create inputs are
objects; update inputs contain only changed fields. IDs are stable, not names.

Success: {"ok":true,"result":...} on stdout. Errors: {"ok":false,"error":
{"code":...,"message":...}} on stderr. Exit codes: 0 success, 2 invalid input,
3 not found, 4 revision conflict, 5 workspace busy, 6 unavailable/timeout, 1 other.
When the desktop is running, commands are sent to its current workspace state.
When closed, commands acquire the same operating-system workspace lock before
loading, validating and saving. A reported write success has been persisted.
"#;

fn error(code: &str, message: impl Into<String>) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
    }
}

fn io_error(message: impl Into<String>) -> CommandError {
    error("IO_ERROR", message)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<CommandError>,
}

impl WireResponse {
    fn from_result(result: Result<Value, CommandError>) -> Self {
        match result {
            Ok(result) => Self {
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(error) => Self {
                ok: false,
                result: None,
                error: Some(error),
            },
        }
    }
    fn into_result(self) -> Result<Value, CommandError> {
        match (self.ok, self.result, self.error) {
            (true, Some(result), None) => Ok(result),
            (false, None, Some(error)) => Err(error),
            _ => Err(error("PROTOCOL_ERROR", "桌面返回了无效的命令响应")),
        }
    }
}

/// Kept open for the entire workspace ownership lifetime. OS releases it on crash.
pub(crate) struct WorkspaceLock {
    file: File,
}

impl WorkspaceLock {
    pub(crate) fn new(directory: &Path) -> Result<Self, String> {
        fs::create_dir_all(directory).map_err(|e| format!("无法创建工作区目录：{e}"))?;
        let path = directory.join(".sayclear-workspace.lock");
        if fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
            return Err("工作区锁文件无效，拒绝跟随符号链接".into());
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(&path)
            .map_err(|e| format!("无法打开工作区锁：{e}"))?;
        file.try_lock()
            .map_err(|e| format!("工作区正由其他进程使用：{e}"))?;
        Ok(Self { file })
    }
}

impl Drop for WorkspaceLock {
    fn drop(&mut self) {
        // Unix file-description locks survive closing this handle while a clone
        // (including the brief fork-before-exec window of another thread's
        // child process) remains open. Release ownership explicitly before close.
        let _ = self.file.unlock();
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Endpoint {
    version: u8,
    address: SocketAddr,
    token: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireRequest {
    token: String,
    request: GraphRequest,
}

type PendingResult = Result<Value, CommandError>;

struct BridgeState {
    pending: Mutex<HashMap<String, SyncSender<PendingResult>>>,
    ready: AtomicBool,
    closed: AtomicBool,
}

pub(crate) struct Bridge {
    state: Arc<BridgeState>,
    descriptor: PathBuf,
    token: String,
}

impl Bridge {
    pub(crate) fn ready(&self, ready: bool) {
        self.state.ready.store(ready, Ordering::SeqCst);
    }

    pub(crate) fn complete(&self, request_id: &str, result: PendingResult) -> Result<(), String> {
        let sender = self
            .state
            .pending
            .lock()
            .map_err(|e| e.to_string())?
            .remove(request_id)
            .ok_or("CLI 请求已过期或不存在")?;
        sender.send(result).map_err(|_| "CLI 请求已断开".into())
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.state.ready.store(false, Ordering::SeqCst);
        self.state.closed.store(true, Ordering::SeqCst);
        if let Ok(mut pending) = self.state.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err(error("UNAVAILABLE", "桌面工作区已关闭或切换")));
            }
        }
        // A newly started bridge may have replaced the file. Never remove its token.
        if read_endpoint(&self.descriptor).is_ok_and(|e| e.token == self.token) {
            let _ = fs::remove_file(&self.descriptor);
        }
    }
}

fn token() -> String {
    let random = RandomState::new();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    (0..4u8)
        .map(|part| {
            let mut hasher = random.build_hasher();
            hasher.write_u128(now);
            hasher.write_u32(std::process::id());
            hasher.write_u8(part);
            format!("{:016x}", hasher.finish())
        })
        .collect()
}

pub(crate) fn start_bridge(app: tauri::AppHandle, directory: PathBuf) -> Result<Bridge, String> {
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("无法启动 CLI 桥接：{e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let secret = token();
    let endpoint = Endpoint {
        version: 1,
        address: listener.local_addr().map_err(|e| e.to_string())?,
        token: secret.clone(),
    };
    let descriptor = directory.join(ENDPOINT);
    // Publish by rename so a CLI can never observe half an endpoint.
    let mut file = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    serde_json::to_writer(&mut file, &endpoint).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(&descriptor).map_err(|e| e.to_string())?;
    let state = Arc::new(BridgeState {
        pending: Mutex::new(HashMap::new()),
        ready: AtomicBool::new(false),
        closed: AtomicBool::new(false),
    });
    let worker_state = Arc::clone(&state);
    let worker_token = secret.clone();
    thread::spawn(move || {
        while !worker_state.closed.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, peer)) if peer.ip().is_loopback() => {
                    serve(stream, &app, &worker_state, &worker_token);
                }
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(30));
                }
                Err(_) => break,
            }
        }
    });
    Ok(Bridge {
        state,
        descriptor,
        token: secret,
    })
}

fn read_line(stream: &mut TcpStream) -> Result<Vec<u8>, CommandError> {
    read_frame(stream, MAX_BYTES, "请求")
}

fn read_frame(reader: impl Read, limit: u64, kind: &str) -> Result<Vec<u8>, CommandError> {
    let mut bytes = Vec::new();
    let count = BufReader::new(reader)
        .take(limit + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|e| error("PROTOCOL_ERROR", format!("无法读取 CLI {kind}：{e}")))?;
    if count == 0 || count as u64 > limit || bytes.last() != Some(&b'\n') {
        return Err(error(
            "PROTOCOL_ERROR",
            format!("CLI {kind}缺失、未结束或超过 {} MiB", limit / 1024 / 1024),
        ));
    }
    Ok(bytes)
}

fn serve(mut stream: TcpStream, app: &tauri::AppHandle, state: &BridgeState, secret: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let result = (|| {
        let bytes = read_line(&mut stream)?;
        let request = decode_request(
            &bytes,
            secret,
            state.ready.load(Ordering::SeqCst) && !state.closed.load(Ordering::SeqCst),
        )?;
        let id = token();
        let (sender, receiver) = mpsc::sync_channel(1);
        {
            let mut pending = state
                .pending
                .lock()
                .map_err(|_| error("INTERNAL_ERROR", "命令队列不可用"))?;
            // Drop closes the state before draining under the same mutex. A
            // request cannot be registered just after that drain and hang.
            if state.closed.load(Ordering::SeqCst) || !state.ready.load(Ordering::SeqCst) {
                return Err(error("NOT_READY", "桌面工作区连接已切换，请重试"));
            }
            pending.insert(id.clone(), sender);
        }
        if let Err(e) = app.emit_to(
            "main",
            "sayclear://cli-request",
            json!({"id":id,"request":request}),
        ) {
            if let Ok(mut pending) = state.pending.lock() {
                pending.remove(&id);
            }
            return Err(error("UNAVAILABLE", format!("无法提交桌面命令：{e}")));
        }
        let result = receiver.recv_timeout(TIMEOUT).unwrap_or_else(|_| {
            Err(error(
                "TIMEOUT",
                "桌面命令等待超时，结果可能尚未返回；请先查询当前状态再决定是否重试",
            ))
        });
        if let Ok(mut pending) = state.pending.lock() {
            pending.remove(&id);
        }
        result
    })();
    if let Ok(mut bytes) = serde_json::to_vec(&WireResponse::from_result(result)) {
        bytes.push(b'\n');
        let _ = stream.write_all(&bytes);
    }
}

fn decode_request(bytes: &[u8], secret: &str, ready: bool) -> Result<GraphRequest, CommandError> {
    let wire: WireRequest =
        serde_json::from_slice(bytes).map_err(|_| error("PROTOCOL_ERROR", "CLI 请求格式无效"))?;
    if wire.token != secret {
        return Err(error("UNAUTHORIZED", "CLI 连接凭据无效"));
    }
    if !ready {
        return Err(error("NOT_READY", "桌面工作区尚未就绪，请稍后重试"));
    }
    Ok(wire.request)
}

fn read_endpoint(path: &Path) -> Result<Endpoint, CommandError> {
    let metadata = fs::symlink_metadata(path).map_err(|e| io_error(e.to_string()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 16384 {
        return Err(error("PROTOCOL_ERROR", "CLI 连接描述文件无效"));
    }
    let endpoint: Endpoint =
        serde_json::from_slice(&fs::read(path).map_err(|e| io_error(e.to_string()))?)
            .map_err(|_| error("PROTOCOL_ERROR", "CLI 连接描述文件损坏"))?;
    if endpoint.version != 1 || !endpoint.address.ip().is_loopback() || endpoint.token.len() != 64 {
        return Err(error(
            "PROTOCOL_ERROR",
            "CLI 连接描述文件版本、地址或凭据无效",
        ));
    }
    Ok(endpoint)
}

fn desktop_request(
    mut stream: TcpStream,
    endpoint: Endpoint,
    request: &GraphRequest,
) -> Result<Value, CommandError> {
    stream
        .set_read_timeout(Some(TIMEOUT + Duration::from_secs(5)))
        .map_err(|e| io_error(e.to_string()))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| io_error(e.to_string()))?;
    let mut bytes = serde_json::to_vec(&json!({"token":endpoint.token,"request":request}))
        .map_err(|e| error("INVALID_INPUT", e.to_string()))?;
    if bytes.len() as u64 >= MAX_BYTES {
        return Err(error("INVALID_INPUT", "命令超过 8 MiB"));
    }
    bytes.push(b'\n');
    stream
        .write_all(&bytes)
        .map_err(|e| error("UNAVAILABLE", format!("CLI 请求发送失败：{e}")))?;
    let bytes = read_frame(&mut stream, MAX_RESPONSE_BYTES, "响应").map_err(|e| {
        error(
            "UNAVAILABLE",
            format!("{}；结果未知，请先查询再重试", e.message),
        )
    })?;
    let response: WireResponse =
        serde_json::from_slice(&bytes).map_err(|_| error("PROTOCOL_ERROR", "桌面响应格式无效"))?;
    response.into_result()
}

struct Parsed {
    workspace: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    request: GraphRequest,
}

fn load_input(path: &str) -> Result<Value, CommandError> {
    let mut bytes = Vec::new();
    let reader: Box<dyn Read> = if path == "-" {
        Box::new(std::io::stdin())
    } else {
        Box::new(File::open(path).map_err(|e| io_error(format!("无法读取输入文件：{e}")))?)
    };
    reader
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| io_error(e.to_string()))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(error("INVALID_INPUT", "JSON 输入超过 8 MiB"));
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|e| error("INVALID_INPUT", format!("JSON 输入无效：{e}")))?;
    if !value.is_object() {
        return Err(error("INVALID_INPUT", "JSON 输入必须是对象"));
    }
    Ok(value)
}

fn parse_args(
    args: &[String],
    read_input: impl Fn(&str) -> Result<Value, CommandError>,
) -> Result<Parsed, CommandError> {
    if args.len() < 2 {
        return Err(error(
            "INVALID_ARGUMENT",
            "需要资源和操作；运行 sayclear --help 查看用法",
        ));
    }
    let resource = args[0].as_str();
    let action = match args[1].as_str() {
        "add" => "create",
        "remove" => "delete",
        other => other,
    };
    if !["graph", "component", "connection", "catalog"].contains(&resource)
        || !["list", "get", "create", "update", "delete"].contains(&action)
        || (resource == "catalog" && action != "list")
    {
        return Err(error(
            "INVALID_ARGUMENT",
            "未知命令；运行 sayclear --help 查看用法",
        ));
    }
    let mut parsed = Parsed {
        workspace: None,
        data_dir: None,
        request: GraphRequest {
            command: format!("{resource}.{action}"),
            graph_id: None,
            item_id: None,
            input: Value::Null,
            expected_revision: None,
            dry_run: false,
        },
    };
    let mut input_path: Option<String> = None;
    let mut fields = Map::new();
    let mut positional: Option<String> = None;
    let mut seen = std::collections::HashSet::new();
    let mut i = 2;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--json" || arg == "--dry-run" {
            if !seen.insert(arg.to_owned()) {
                return Err(error("INVALID_ARGUMENT", format!("参数重复：{arg}")));
            }
            if arg == "--dry-run" {
                parsed.request.dry_run = true;
            }
            i += 1;
            continue;
        }
        if arg.starts_with('-') {
            if ![
                "--workspace",
                "--data-dir",
                "--graph",
                "--input",
                "--if-match",
                "--id",
                "--name",
                "--description",
                "--parent",
                "--kind",
                "--scenario",
                "--system",
                "--query",
                "--graph-version",
                "--history",
            ]
            .contains(&arg)
            {
                return Err(error("INVALID_ARGUMENT", format!("未知参数：{arg}")));
            }
            if !seen.insert(arg.to_owned()) {
                return Err(error("INVALID_ARGUMENT", format!("参数重复：{arg}")));
            }
            i += 1;
            let value = args
                .get(i)
                .filter(|v| !v.starts_with("--"))
                .ok_or_else(|| error("INVALID_ARGUMENT", format!("参数缺少值：{arg}")))?;
            match arg {
                "--workspace" => parsed.workspace = Some(PathBuf::from(value)),
                "--data-dir" => parsed.data_dir = Some(PathBuf::from(value)),
                "--graph" => parsed.request.graph_id = Some(value.clone()),
                "--if-match" => parsed.request.expected_revision = Some(value.clone()),
                "--input" => input_path = Some(value.clone()),
                _ => {
                    let key = match arg {
                        "--parent" => "parentId",
                        "--scenario" => "scenarioId",
                        "--system" => "systemId",
                        "--graph-version" => "version",
                        "--history" => "historyId",
                        _ => &arg[2..],
                    };
                    fields.insert(key.into(), Value::String(value.clone()));
                }
            }
        } else if positional.replace(arg.into()).is_some() {
            return Err(error("INVALID_ARGUMENT", "只接受一个位置 ID"));
        }
        i += 1;
    }
    if parsed.workspace.is_some() && parsed.data_dir.is_some() {
        return Err(error(
            "INVALID_ARGUMENT",
            "--workspace 与 --data-dir 不能同时使用",
        ));
    }
    if resource == "graph" {
        if let Some(id) = positional {
            if parsed.request.graph_id.is_some() {
                return Err(error("INVALID_ARGUMENT", "画板 ID 重复"));
            }
            parsed.request.graph_id = Some(id);
        }
    } else {
        parsed.request.item_id = positional;
    }
    if resource == "catalog"
        && (parsed.request.item_id.is_some() || parsed.request.graph_id.is_some())
    {
        return Err(error(
            "INVALID_ARGUMENT",
            "catalog list 不接受画板或对象 ID",
        ));
    }
    if resource == "graph"
        && ["get", "update", "delete"].contains(&action)
        && parsed.request.graph_id.is_none()
    {
        return Err(error("INVALID_ARGUMENT", "需要画板 ID"));
    }
    if resource == "graph"
        && ["list", "create"].contains(&action)
        && parsed.request.graph_id.is_some()
    {
        return Err(error(
            "INVALID_ARGUMENT",
            "graph list/create 不接受位置 ID；创建画板请使用 --id",
        ));
    }
    if ["component", "connection"].contains(&resource) {
        if parsed.request.graph_id.is_none() {
            return Err(error("INVALID_ARGUMENT", "需要 --graph 指定画板"));
        }
        if ["get", "update", "delete"].contains(&action) && parsed.request.item_id.is_none() {
            return Err(error("INVALID_ARGUMENT", "需要组件或连接 ID"));
        }
        if ["list", "create"].contains(&action) && parsed.request.item_id.is_some() {
            return Err(error(
                "INVALID_ARGUMENT",
                "list/create 不接受位置 ID；创建对象请使用 --id",
            ));
        }
    }
    let mut input = if let Some(path) = input_path {
        read_input(&path)?
    } else {
        json!({})
    };
    let object = input
        .as_object_mut()
        .ok_or_else(|| error("INVALID_INPUT", "JSON 输入必须是对象"))?;
    for (key, value) in fields {
        if object.insert(key.clone(), value).is_some() {
            return Err(error("INVALID_ARGUMENT", format!("输入字段重复：{key}")));
        }
    }
    parsed.request.input = input;
    Ok(parsed)
}

fn default_directory() -> Result<PathBuf, CommandError> {
    #[cfg(target_os = "windows")]
    return std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|p| p.join("com.sayclear.desktop"))
        .ok_or_else(|| error("INVALID_ARGUMENT", "缺少 APPDATA；请使用 --workspace"));
    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(target_os = "linux")]
        if let Some(path) = std::env::var_os("XDG_DATA_HOME") {
            if !path.is_empty() {
                return Ok(PathBuf::from(path).join("com.sayclear.desktop"));
            }
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| error("INVALID_ARGUMENT", "缺少 HOME；请使用 --workspace"))?;
        #[cfg(target_os = "macos")]
        return Ok(home.join("Library/Application Support/com.sayclear.desktop"));
        #[cfg(not(target_os = "macos"))]
        return Ok(home.join(".local/share/com.sayclear.desktop"));
    }
}

fn resolve_directory(parsed: &Parsed) -> Result<PathBuf, CommandError> {
    let path = if let Some(path) = &parsed.workspace {
        path.clone()
    } else {
        let default = match &parsed.data_dir {
            Some(path) => path.clone(),
            None => default_directory()?,
        };
        let config = default.join("data-directory.json");
        match fs::read(&config) {
            Ok(bytes) => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Config {
                    data_directory: PathBuf,
                }
                if bytes.len() > 16384 {
                    return Err(error("INVALID_INPUT", "数据目录配置过大"));
                }
                let config: Config = serde_json::from_slice(&bytes)
                    .map_err(|e| error("INVALID_INPUT", format!("数据目录配置无效：{e}")))?;
                if !config.data_directory.is_absolute() {
                    return Err(error("INVALID_INPUT", "配置的数据目录必须为绝对路径"));
                }
                if !config.data_directory.join("workspace.json").is_file() {
                    return Err(error("NOT_FOUND", "配置的数据目录不可用或工作区文件缺失"));
                }
                config.data_directory
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => default,
            Err(e) => return Err(io_error(format!("无法读取数据目录配置：{e}"))),
        }
    };
    if path.is_absolute() {
        Ok(path)
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(|e| io_error(e.to_string()))
    }
}

fn run(parsed: Parsed) -> Result<Value, CommandError> {
    let directory = resolve_directory(&parsed)?;
    let endpoint = directory.join(ENDPOINT);
    if endpoint.try_exists().map_err(|e| io_error(e.to_string()))? {
        let descriptor = read_endpoint(&endpoint)?;
        match TcpStream::connect_timeout(&descriptor.address, Duration::from_secs(3)) {
            Ok(stream) => return desktop_request(stream, descriptor, &parsed.request),
            Err(connection_error) => {
                // No request was sent. Acquiring the OS lock proves the old
                // owner has gone away, allowing its stale endpoint to retire.
                let lock = WorkspaceLock::new(&directory).map_err(|message| {
                    error(
                        "UNAVAILABLE",
                        format!("无法连接桌面工作区：{connection_error}；{message}"),
                    )
                })?;
                if endpoint.try_exists().map_err(|e| io_error(e.to_string()))? {
                    let current = read_endpoint(&endpoint)?;
                    if current.token != descriptor.token {
                        return Err(error("BUSY", "工作区连接已切换，请重试"));
                    }
                    fs::remove_file(&endpoint).map_err(|e| io_error(e.to_string()))?;
                }
                return run_offline(&directory, &parsed.request, lock);
            }
        }
    }
    let lock = WorkspaceLock::new(&directory).map_err(|message| error("BUSY", message))?;
    run_offline(&directory, &parsed.request, lock)
}

fn run_offline(
    directory: &Path,
    request: &GraphRequest,
    _lock: WorkspaceLock,
) -> Result<Value, CommandError> {
    let endpoint = directory.join(ENDPOINT);
    // The lock closes the race with a desktop starting between endpoint detection
    // and acquisition. The descriptor is checked again while we own the lock.
    if endpoint.try_exists().map_err(|e| io_error(e.to_string()))? {
        return Err(error("BUSY", "工作区连接状态发生变化，请重试"));
    }
    let store = WorkspaceStore::new(directory.join("workspace.json"), None);
    crate::graph_service::execute_in_store(&store, request)
}

fn exit_code(code: &str) -> i32 {
    match code {
        "INVALID_ARGUMENT"
        | "INVALID_INPUT"
        | "VALIDATION_ERROR"
        | "UNSUPPORTED_COMMAND"
        | "REVISION_REQUIRED" => 2,
        "NOT_FOUND" => 3,
        "CONFLICT" | "REVISION_CONFLICT" => 4,
        "BUSY" => 5,
        "NOT_READY" | "UNAVAILABLE" | "TIMEOUT" => 6,
        _ => 1,
    }
}

/// Separate from the GUI binary so the desktop window never opens for CLI calls.
pub fn main_entry() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{HELP}");
        return 0;
    }
    if args.len() == 1 && ["--version", "-V"].contains(&args[0].as_str()) {
        println!("sayclear {}", env!("CARGO_PKG_VERSION"));
        return 0;
    }
    match parse_args(&args, load_input).and_then(run) {
        Ok(result) => {
            println!("{}", json!({"ok":true,"result":result}));
            0
        }
        Err(error) => {
            let code = exit_code(&error.code);
            eprintln!("{}", json!({"ok":false,"error":error}));
            code
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Parsed, CommandError> {
        parse_args(
            &args.iter().map(|a| (*a).into()).collect::<Vec<_>>(),
            |_| Ok(json!({})),
        )
    }

    #[test]
    fn parses_graph_and_item_commands_with_machine_input() {
        let parsed = parse_args(
            &[
                "component",
                "update",
                "node-1",
                "--graph",
                "board-1",
                "--input",
                "-",
                "--if-match",
                "abc",
                "--json",
            ]
            .map(str::to_owned),
            |_| Ok(json!({"name":"新名称"})),
        )
        .unwrap();
        assert_eq!(parsed.request.command, "component.update");
        assert_eq!(parsed.request.graph_id.as_deref(), Some("board-1"));
        assert_eq!(parsed.request.item_id.as_deref(), Some("node-1"));
        assert_eq!(parsed.request.expected_revision.as_deref(), Some("abc"));
        assert_eq!(parsed.request.input["name"], "新名称");
        let parsed = parse(&[
            "graph",
            "create",
            "--parent",
            "root",
            "--name",
            "新画板",
            "--id",
            "new",
            "--dry-run",
        ])
        .unwrap();
        assert_eq!(parsed.request.input["parentId"], "root");
        assert!(parsed.request.dry_run);
    }

    #[test]
    fn rejects_unknown_missing_duplicate_and_ambiguous_arguments() {
        for args in [
            vec!["graph", "get"],
            vec!["component", "get", "component-1"],
            vec!["graph", "list", "--unknown"],
            vec!["graph", "list", "--workspace"],
            vec!["graph", "list", "--json", "--json"],
            vec!["graph", "list", "--workspace", "a", "--data-dir", "b"],
            vec!["graph", "get", "one", "two"],
            vec!["connection", "create", "id", "--graph", "board"],
            vec!["catalog", "list", "id"],
        ] {
            assert!(parse(&args).is_err(), "accepted {args:?}");
        }
        assert!(parse_args(
            &["graph", "create", "--input", "-", "--name", "new"].map(str::to_owned),
            |_| Ok(json!({"name":"old"}))
        )
        .is_err());
    }

    #[test]
    fn operating_system_lock_is_exclusive_and_released_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let lock = WorkspaceLock::new(dir.path()).unwrap();
        assert!(WorkspaceLock::new(dir.path()).is_err());
        drop(lock);
        assert!(WorkspaceLock::new(dir.path()).is_ok());
    }

    #[test]
    fn dropping_workspace_owner_releases_lock_even_if_a_handle_was_inherited() {
        let dir = tempfile::tempdir().unwrap();
        let lock = WorkspaceLock::new(dir.path()).unwrap();
        // try_clone shares the open file description just as fork does, making
        // the inherited-descriptor case deterministic without racing a child.
        let inherited = lock.file.try_clone().unwrap();
        drop(lock);
        let next_owner = WorkspaceLock::new(dir.path()).unwrap();
        drop(inherited);
        assert!(WorkspaceLock::new(dir.path()).is_err());
        drop(next_owner);
        assert!(WorkspaceLock::new(dir.path()).is_ok());
    }

    #[test]
    fn configuration_resolves_custom_data_and_rejects_missing_index() {
        let config = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        fs::write(
            config.path().join("data-directory.json"),
            json!({"dataDirectory":data.path()}).to_string(),
        )
        .unwrap();
        let parsed = parse(&[
            "graph",
            "list",
            "--data-dir",
            config.path().to_str().unwrap(),
        ])
        .unwrap();
        assert_eq!(resolve_directory(&parsed).unwrap_err().code, "NOT_FOUND");
        fs::write(data.path().join("workspace.json"), "{}").unwrap();
        assert_eq!(resolve_directory(&parsed).unwrap(), data.path());
    }

    #[test]
    fn descriptor_cannot_redirect_cli_to_a_remote_address() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ENDPOINT);
        fs::write(
            &path,
            json!({"version":1,"address":"192.0.2.1:1234","token":"a".repeat(64)}).to_string(),
        )
        .unwrap();
        assert_eq!(read_endpoint(&path).unwrap_err().code, "PROTOCOL_ERROR");
    }

    #[test]
    fn bridge_completes_a_request_once_and_rejects_late_results() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let dir = tempfile::tempdir().unwrap();
        let bridge = Bridge {
            state: Arc::new(BridgeState {
                pending: Mutex::new(HashMap::from([("one".into(), sender)])),
                ready: AtomicBool::new(false),
                closed: AtomicBool::new(false),
            }),
            descriptor: dir.path().join(ENDPOINT),
            token: "unused".into(),
        };
        bridge.complete("one", Ok(json!({"saved":true}))).unwrap();
        assert_eq!(receiver.recv().unwrap().unwrap()["saved"], true);
        assert!(bridge.complete("one", Ok(Value::Null)).is_err());
    }

    #[test]
    fn query_filters_and_graph_version_are_structured_input() {
        let parsed = parse(&[
            "graph", "list", "--query", "注册", "--system", "crm", "--parent", "users",
        ])
        .unwrap();
        assert_eq!(
            parsed.request.input,
            json!({"query":"注册","systemId":"crm","parentId":"users"})
        );
        let parsed = parse(&[
            "graph",
            "get",
            "board",
            "--graph-version",
            "history",
            "--history",
            "v1",
        ])
        .unwrap();
        assert_eq!(
            parsed.request.input,
            json!({"version":"history","historyId":"v1"})
        );
    }

    #[test]
    fn bridge_requires_authentication_and_frontend_readiness() {
        let request = parse(&["graph", "list"]).unwrap().request;
        let wrong = serde_json::to_vec(&json!({"token":"wrong","request":request})).unwrap();
        assert_eq!(
            decode_request(&wrong, "secret", true).unwrap_err().code,
            "UNAUTHORIZED"
        );
        let correct = serde_json::to_vec(&json!({"token":"secret","request":request})).unwrap();
        assert_eq!(
            decode_request(&correct, "secret", false).unwrap_err().code,
            "NOT_READY"
        );
        assert_eq!(
            decode_request(&correct, "secret", true).unwrap().command,
            "graph.list"
        );
        assert_eq!(
            decode_request(b"{}", "secret", true).unwrap_err().code,
            "PROTOCOL_ERROR"
        );
    }

    #[test]
    fn native_socket_client_round_trips_without_a_webview() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let endpoint = Endpoint {
            version: 1,
            address: listener.local_addr().unwrap(),
            token: token(),
        };
        let secret = endpoint.token.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let request = decode_request(&read_line(&mut stream).unwrap(), &secret, true).unwrap();
            assert_eq!(request.command, "graph.list");
            let mut bytes = serde_json::to_vec(&WireResponse::from_result(Ok(
                json!({"revision":"rev1","data":[]}),
            )))
            .unwrap();
            bytes.push(b'\n');
            stream.write_all(&bytes).unwrap();
        });
        let stream = TcpStream::connect(endpoint.address).unwrap();
        let result = desktop_request(
            stream,
            endpoint,
            &parse(&["graph", "list"]).unwrap().request,
        )
        .unwrap();
        assert_eq!(result["revision"], "rev1");
        server.join().unwrap();
    }

    #[test]
    fn responses_can_exceed_the_request_limit_without_lifting_request_bounds() {
        let mut bytes = vec![b'x'; MAX_BYTES as usize + 1024];
        bytes.push(b'\n');
        let response =
            read_frame(std::io::Cursor::new(&bytes), MAX_RESPONSE_BYTES, "响应").unwrap();
        assert_eq!(response.len(), bytes.len());
        let request_error =
            read_frame(std::io::Cursor::new(&bytes), MAX_BYTES, "请求").unwrap_err();
        assert!(request_error.message.contains("请求"));
        assert!(request_error.message.contains("8 MiB"));
        // A small artificial bound exercises the same response-limit branch.
        let response_error =
            read_frame(std::io::Cursor::new(b"oversized\n"), 4, "响应").unwrap_err();
        assert!(response_error.message.contains("响应"));
    }

    #[test]
    fn malformed_desktop_response_is_not_replayed_offline() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let endpoint = Endpoint {
            version: 1,
            address: listener.local_addr().unwrap(),
            token: token(),
        };
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_line(&mut stream).unwrap();
            stream
                .write_all(b"{\"ok\":true,\"error\":{\"code\":\"BAD\",\"message\":\"bad\"}}\n")
                .unwrap();
        });
        let stream = TcpStream::connect(endpoint.address).unwrap();
        assert_eq!(
            desktop_request(
                stream,
                endpoint,
                &parse(&["graph", "list"]).unwrap().request
            )
            .unwrap_err()
            .code,
            "PROTOCOL_ERROR"
        );
        server.join().unwrap();
    }

    fn stale_descriptor(directory: &Path) -> PathBuf {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let endpoint = Endpoint {
            version: 1,
            address: listener.local_addr().unwrap(),
            token: token(),
        };
        drop(listener);
        let path = directory.join(ENDPOINT);
        fs::write(&path, serde_json::to_vec(&endpoint).unwrap()).unwrap();
        path
    }

    #[test]
    fn stale_endpoint_recovers_only_after_acquiring_workspace_ownership() {
        let directory = tempfile::tempdir().unwrap();
        let endpoint = stale_descriptor(directory.path());
        let args = [
            "graph",
            "list",
            "--workspace",
            directory.path().to_str().unwrap(),
        ];
        let lock = WorkspaceLock::new(directory.path()).unwrap();
        assert_eq!(run(parse(&args).unwrap()).unwrap_err().code, "UNAVAILABLE");
        assert!(endpoint.exists());
        drop(lock);
        let result = run(parse(&args).unwrap()).unwrap();
        assert!(result["revision"].is_string());
        assert!(!endpoint.exists());
    }
}
