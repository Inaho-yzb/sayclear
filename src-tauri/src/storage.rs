pub use crate::legacy_storage::{atomic_write, export_filename};
use crate::{
    component_catalog::ComponentCatalog,
    diagram::{Diagram, GraphSnapshot, HistoricalVersion, Iteration},
    legacy_storage::LegacyWorkspaceStore,
    model::{valid_id, Architecture, NodeContent, SystemData, Workspace},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
type Files = BTreeMap<String, Vec<u8>>;
type Observed = BTreeMap<String, String>;
#[derive(Default)]
struct StoreState {
    observed: Option<Observed>,
    workspace: Option<Workspace>,
}
pub struct WorkspaceStore {
    file_path: PathBuf,
    legacy_path: Option<PathBuf>,
    lock: Mutex<StoreState>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceIndex {
    schema_version: u8,
    active_node_id: Option<String>,
    system_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    component_catalog: Option<ComponentCatalog>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    git_repository: Option<crate::git::GitRepository>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SystemIndex {
    schema_version: u8,
    board_ids: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BoardIndex {
    schema_version: u8,
    content: NodeContent,
    diagram: Option<DiagramIndex>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagramIndex {
    iteration_id: Option<String>,
    history: Vec<HistoricalVersion>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IterationFile {
    schema_version: u8,
    id: String,
    name: String,
    started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    git: Option<crate::git::GitIteration>,
    baseline_version_id: String,
    baseline_digest: String,
    draft: GraphSnapshot,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Mutation {
    path: String,
    before: Option<String>,
    after: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    schema_version: u8,
    stage: String,
    changes: Vec<Mutation>,
    deleted_system_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedHistory {
    board_id: String,
    history: Vec<HistoricalVersion>,
}

// Stable checksum for accidental corruption/conflicts, not a security boundary.
fn digest(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for b in bytes {
        hash = (hash ^ u64::from(*b)).wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}
fn encode(value: &impl Serialize) -> Result<Vec<u8>, String> {
    // Sort map keys, including user metadata, so identical data never causes a rewrite.
    let bytes = serde_json::to_vec_pretty(&serde_json::to_value(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("单个数据文件超过 64 MiB，原文件已保留".into());
    }
    Ok(bytes)
}
fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("JSON 格式无效，原文件已保留：{e}"))
}
fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err("系统数据路径不能是符号链接".into()),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    reject_symlink(path)?;
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let mut bytes = vec![];
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("单个数据文件超过 64 MiB，原文件已保留".into());
    }
    Ok(Some(bytes))
}
fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| e.to_string())?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
fn owned_path(path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    match parts.as_slice() {
        ["workspace.json"] => true,
        ["systems", system, file] => {
            valid_id(system) && ["architecture.json", "index.json"].contains(file)
        }
        ["systems", system, "boards", board, file] => {
            valid_id(system) && valid_id(board) && ["index.json", "current.json"].contains(file)
        }
        ["systems", system, "boards", board, kind, file] => {
            valid_id(system)
                && valid_id(board)
                && ["iterations", "versions"].contains(kind)
                && file.strip_suffix(".json").is_some_and(valid_id)
        }
        _ => false,
    }
}
fn board_path(system: &str, board: &str) -> String {
    format!("systems/{system}/boards/{board}")
}
impl WorkspaceStore {
    pub fn new(file_path: PathBuf, legacy_path: Option<PathBuf>) -> Self {
        Self {
            file_path,
            legacy_path,
            lock: Mutex::new(StoreState::default()),
        }
    }
    fn root(&self) -> Result<&Path, String> {
        self.file_path
            .parent()
            .ok_or_else(|| "工作区路径无效".into())
    }
    fn journal(&self) -> Result<PathBuf, String> {
        Ok(self.root()?.join(".pending-files.json"))
    }
    fn path(&self, relative: &str) -> Result<PathBuf, String> {
        if !owned_path(relative) {
            return Err("数据文件路径无效".into());
        }
        let mut path = self.root()?.to_path_buf();
        reject_symlink(&path)?;
        for part in relative.split('/') {
            path.push(part);
            reject_symlink(&path)?;
        }
        Ok(path)
    }
    fn read(&self, relative: &str) -> Result<Option<Vec<u8>>, String> {
        read_bytes(&self.path(relative)?)
    }
    fn required(&self, relative: &str) -> Result<Vec<u8>, String> {
        self.read(relative)?
            .ok_or_else(|| format!("缺少数据文件 {relative}，原文件已保留"))
    }
    fn check_observed(&self, state: &StoreState) -> Result<(), String> {
        if self.journal()?.exists() {
            return Err("上次操作尚未完成，请重新读取文件恢复".into());
        }
        if let Some(observed) = &state.observed {
            for (path, expected) in observed {
                if self.read(path)?.as_deref().map(digest).as_ref() != Some(expected) {
                    return Err(format!(
                        "本地 JSON 已在外部修改：{path}，请先重新读取文件再编辑"
                    ));
                }
            }
        } else if self.file_path.exists() {
            return Err("请先读取现有工作区再保存".into());
        }
        Ok(())
    }
    pub fn load(&self) -> Result<Option<Workspace>, String> {
        let mut state = self.lock.lock().map_err(|_| "工作区锁不可用")?;
        self.recover()?;
        let bytes = self.read("workspace.json")?;
        let version = bytes
            .as_ref()
            .map(|b| decode::<serde_json::Value>(b))
            .transpose()?
            .and_then(|v| v["schemaVersion"].as_u64());
        if version != Some(3) {
            if version.is_some_and(|v| v != 1 && v != 2) {
                return Err("不支持的工作区版本，原文件已保留".into());
            }
            let legacy =
                LegacyWorkspaceStore::new(self.file_path.clone(), self.legacy_path.clone());
            let Some(workspace) = legacy.load()? else {
                *state = StoreState {
                    observed: Some(Observed::new()),
                    workspace: None,
                };
                return Ok(None);
            };
            // Legacy snapshots must be complete; missing bodies must never become empty histories.
            if workspace
                .systems
                .iter()
                .flat_map(|s| &s.contents)
                .filter_map(|c| c.diagram.as_ref())
                .any(|d| d.history.iter().any(|h| h.snapshot.is_none()))
            {
                return Err("旧工作区历史快照缺失，原文件已保留".into());
            }
            self.backup_legacy(&workspace)?;
            let (files, _) = self.files_for(&workspace, None)?;
            self.commit(files, vec![], vec![], true)?;
        }
        let (workspace, observed) = self.read_split(&Files::new(), &HashSet::new())?;
        state.observed = Some(observed);
        state.workspace = Some(workspace.clone());
        Ok(Some(workspace))
    }
    fn backup_legacy(&self, workspace: &Workspace) -> Result<(), String> {
        let backup = self.root()?.join("migration-v2-backup");
        reject_symlink(&backup)?;
        let mut paths = vec!["workspace.json".to_owned()];
        for s in &workspace.systems {
            paths.push(format!("systems/{}/architecture.json", s.architecture.id));
            paths.push(format!("systems/{}/content.json", s.architecture.id));
        }
        for relative in paths {
            let bytes = read_bytes(&self.root()?.join(&relative))?.ok_or("旧数据备份来源缺失")?;
            let target = backup.join(&relative);
            let mut prefix = backup.clone();
            for part in relative.split('/') {
                prefix.push(part);
                reject_symlink(&prefix)?;
            }
            if let Some(existing) = read_bytes(&target)? {
                if existing != bytes {
                    return Err("旧版备份已存在且内容不同，原文件已保留".into());
                }
            } else {
                fs::create_dir_all(target.parent().ok_or("备份路径无效")?)
                    .map_err(|e| e.to_string())?;
                atomic_write(&target, &bytes)?;
            }
        }
        Ok(())
    }
    fn files_for(
        &self,
        workspace: &Workspace,
        previous: Option<&Workspace>,
    ) -> Result<(Files, Workspace), String> {
        workspace.validate()?;
        let mut compact = workspace.clone();
        let mut files = Files::new();
        let catalog = workspace.component_catalog.clone().unwrap_or_default();
        let mut known_versions = BTreeMap::new();
        if let Some(previous) = previous {
            for s in &previous.systems {
                for c in &s.contents {
                    if let Some(d) = &c.diagram {
                        let base = board_path(&s.architecture.id, &c.id);
                        for h in &d.history {
                            if let Some(hash) = &h.snapshot_digest {
                                known_versions
                                    .insert(format!("{base}/versions/{}.json", h.id), hash.clone());
                            }
                        }
                        if let Some(i) = &d.iteration {
                            known_versions.insert(
                                format!("{base}/versions/{}.json", i.id),
                                digest(&encode(&i.baseline)?),
                            );
                        }
                    }
                }
            }
        }
        for system in &mut compact.systems {
            let system_id = &system.architecture.id;
            files.insert(
                format!("systems/{system_id}/architecture.json"),
                encode(&system.architecture)?,
            );
            files.insert(
                format!("systems/{system_id}/index.json"),
                encode(&SystemIndex {
                    schema_version: 1,
                    board_ids: system.contents.iter().map(|c| c.id.clone()).collect(),
                })?,
            );
            for content in &mut system.contents {
                let base = board_path(system_id, &content.id);
                let mut diagram_index = None;
                if let Some(diagram) = &mut content.diagram {
                    if !diagram.history.is_empty()
                        && previous
                            .into_iter()
                            .flat_map(|w| &w.systems)
                            .flat_map(|s| &s.contents)
                            .find(|c| c.id == content.id)
                            .and_then(|c| c.diagram.as_ref())
                            .is_some_and(|old| old.scenario_id != diagram.scenario_id)
                    {
                        return Err("画板包含历史现状，不能更换场景".into());
                    }
                    let current = diagram
                        .iteration
                        .as_ref()
                        .map_or_else(|| diagram.snapshot(), |i| i.baseline.clone());
                    files.insert(format!("{base}/current.json"), encode(&current)?);
                    if let Some(iteration) = &diagram.iteration {
                        let bytes = encode(&iteration.baseline)?;
                        let hash = digest(&bytes);
                        self.add_version(
                            &mut files,
                            &known_versions,
                            &format!("{base}/versions/{}.json", iteration.id),
                            bytes,
                        )?;
                        files.insert(
                            format!("{base}/iterations/{}.json", iteration.id),
                            encode(&IterationFile {
                                schema_version: 1,
                                id: iteration.id.clone(),
                                name: iteration.name.clone(),
                                started_at: iteration.started_at.clone(),
                                git: iteration.git.clone(),
                                baseline_version_id: iteration.id.clone(),
                                baseline_digest: hash,
                                draft: diagram.snapshot(),
                            })?,
                        );
                    }
                    for history in &mut diagram.history {
                        let path = format!("{base}/versions/{}.json", history.id);
                        if let Some(snapshot) = history.snapshot.take() {
                            snapshot.validate()?;
                            catalog
                                .validate_snapshot(&snapshot.scenario_id, &snapshot.components)?;
                            let bytes = encode(&snapshot)?;
                            history.component_count = Some(snapshot.components.len());
                            history.connection_count = Some(snapshot.connections.len());
                            history.snapshot_digest = Some(digest(&bytes));
                            self.add_version(&mut files, &known_versions, &path, bytes)?;
                        } else if known_versions.get(&path) != history.snapshot_digest.as_ref() {
                            let bytes = self.required(&path)?;
                            let snapshot: GraphSnapshot = decode(&bytes)?;
                            self.validate_version(
                                &snapshot,
                                &bytes,
                                history,
                                &diagram.scenario_id,
                                &catalog,
                            )?;
                        }
                    }
                    diagram_index = Some(DiagramIndex {
                        iteration_id: diagram.iteration.as_ref().map(|i| i.id.clone()),
                        history: diagram.history.clone(),
                    });
                }
                let mut metadata = content.clone();
                metadata.diagram = None;
                files.insert(
                    format!("{base}/index.json"),
                    encode(&BoardIndex {
                        schema_version: 1,
                        content: metadata,
                        diagram: diagram_index,
                    })?,
                );
            }
        }
        files.insert(
            "workspace.json".into(),
            encode(&WorkspaceIndex {
                schema_version: 3,
                active_node_id: compact.active_node_id.clone(),
                system_ids: compact
                    .systems
                    .iter()
                    .map(|s| s.architecture.id.clone())
                    .collect(),
                component_catalog: compact.component_catalog.clone(),
                git_repository: compact.git_repository.clone(),
            })?,
        );
        compact.validate()?;
        Ok((files, compact))
    }
    fn add_version(
        &self,
        files: &mut Files,
        known: &BTreeMap<String, String>,
        path: &str,
        bytes: Vec<u8>,
    ) -> Result<(), String> {
        let hash = digest(&bytes);
        if let Some(expected) = known.get(path) {
            if expected != &hash {
                return Err("只读历史或迭代基线不能被覆盖".into());
            }
            return Ok(());
        }
        if let Some(existing) = files.get(path) {
            if existing != &bytes {
                return Err("迭代与历史版本 ID 冲突".into());
            }
            return Ok(());
        }
        if let Some(existing) = self.read(path)? {
            if existing != bytes {
                return Err("只读历史版本已存在且内容不同，原文件已保留".into());
            }
        } else {
            files.insert(path.into(), bytes);
        }
        Ok(())
    }
    pub fn save(&self, workspace: &Workspace) -> Result<(), String> {
        let mut state = self.lock.lock().map_err(|_| "工作区锁不可用")?;
        self.check_observed(&state)?;
        if let Some(previous) = &state.workspace {
            if previous.systems.iter().any(|s| {
                !workspace
                    .systems
                    .iter()
                    .any(|n| n.architecture.id == s.architecture.id)
            }) {
                return Err("请使用删除操作移除应用系统".into());
            }
        }
        let (files, compact) = self.files_for(workspace, state.workspace.as_ref())?;
        let catalog_changed = state.workspace.as_ref().is_some_and(|previous| {
            serde_json::to_value(&previous.component_catalog).ok()
                != serde_json::to_value(&workspace.component_catalog).ok()
        });
        if catalog_changed {
            self.validate_histories(&compact, &files)?;
        }
        let deletes = self.retired_files(state.workspace.as_ref(), &compact);
        self.ensure_known_targets(&state, &files)?;
        self.commit(files, deletes, vec![], false)?;
        let (loaded, observed) = self.read_split(&Files::new(), &HashSet::new())?;
        state.observed = Some(observed);
        state.workspace = Some(loaded);
        Ok(())
    }
    pub(crate) fn history_index(&self) -> Result<Vec<SavedHistory>, String> {
        let state = self.lock.lock().map_err(|_| "工作区锁不可用")?;
        Ok(state
            .workspace
            .as_ref()
            .into_iter()
            .flat_map(|w| &w.systems)
            .flat_map(|s| &s.contents)
            .filter_map(|c| {
                c.diagram
                    .as_ref()
                    .filter(|d| !d.history.is_empty())
                    .map(|d| SavedHistory {
                        board_id: c.id.clone(),
                        history: d.history.clone(),
                    })
            })
            .collect())
    }
    fn ensure_known_targets(&self, state: &StoreState, files: &Files) -> Result<(), String> {
        for path in files.keys() {
            if state
                .observed
                .as_ref()
                .is_none_or(|o| !o.contains_key(path))
                && self.path(path)?.exists()
            {
                return Err("目标画板目录已有数据，请重新读取文件，原文件已保留".into());
            }
        }
        Ok(())
    }
    fn retired_files(&self, previous: Option<&Workspace>, next: &Workspace) -> Vec<String> {
        let mut deleted = vec![];
        if let Some(previous) = previous {
            for system in &previous.systems {
                for content in &system.contents {
                    let next_content = next
                        .systems
                        .iter()
                        .find(|s| s.architecture.id == system.architecture.id)
                        .and_then(|s| s.contents.iter().find(|c| c.id == content.id));
                    if let Some(old) = &content.diagram {
                        if let Some(next_content) = next_content {
                            let base = board_path(&system.architecture.id, &content.id);
                            if next_content.diagram.is_none() {
                                deleted.push(format!("{base}/current.json"));
                            }
                            if let Some(i) = &old.iteration {
                                if next_content
                                    .diagram
                                    .as_ref()
                                    .and_then(|d| d.iteration.as_ref())
                                    .is_none_or(|n| n.id != i.id)
                                {
                                    deleted.push(format!("{base}/iterations/{}.json", i.id));
                                    if next_content
                                        .diagram
                                        .as_ref()
                                        .is_none_or(|d| !d.history.iter().any(|h| h.id == i.id))
                                    {
                                        deleted.push(format!("{base}/versions/{}.json", i.id));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        deleted
    }
    fn read_split(
        &self,
        overlay: &Files,
        deleted: &HashSet<String>,
    ) -> Result<(Workspace, Observed), String> {
        let mut observed = Observed::new();
        let mut read = |path: &str| -> Result<Vec<u8>, String> {
            if deleted.contains(path) {
                return Err(format!("数据文件被错误移除：{path}"));
            }
            let bytes = match overlay.get(path) {
                Some(b) => b.clone(),
                None => self.required(path)?,
            };
            observed.insert(path.into(), digest(&bytes));
            Ok(bytes)
        };
        let index: WorkspaceIndex = decode(&read("workspace.json")?)?;
        if index.schema_version != 3
            || index.system_ids.len() > 100
            || index.system_ids.iter().collect::<HashSet<_>>().len() != index.system_ids.len()
        {
            return Err("工作区索引无效".into());
        }
        let mut systems = vec![];
        for id in &index.system_ids {
            if !valid_id(id) {
                return Err("系统 ID 无效".into());
            }
            let architecture: Architecture =
                decode(&read(&format!("systems/{id}/architecture.json"))?)?;
            architecture.validate()?;
            if architecture.id != *id {
                return Err("架构 ID 与系统目录不一致".into());
            }
            let system_index: SystemIndex = decode(&read(&format!("systems/{id}/index.json"))?)?;
            if system_index.schema_version != 1
                || system_index.board_ids.len() > 25000
                || !system_index.board_ids.contains(id)
                || system_index.board_ids.iter().collect::<HashSet<_>>().len()
                    != system_index.board_ids.len()
            {
                return Err("系统画板索引无效或根节点缺失".into());
            }
            let mut contents = vec![];
            for board_id in system_index.board_ids {
                if !valid_id(&board_id) {
                    return Err("画板 ID 无效".into());
                }
                let base = board_path(id, &board_id);
                let board: BoardIndex = decode(&read(&format!("{base}/index.json"))?)?;
                if board.schema_version != 1
                    || board.content.id != board_id
                    || board.content.diagram.is_some()
                {
                    return Err("画板索引无效".into());
                }
                let mut content = board.content;
                if let Some(di) = board.diagram {
                    if di.history.iter().any(|h| h.snapshot.is_some()) {
                        return Err("历史索引不能包含快照正文".into());
                    }
                    let current: GraphSnapshot = decode(&read(&format!("{base}/current.json"))?)?;
                    let mut graph = current.clone();
                    let mut iteration = None;
                    if let Some(iteration_id) = di.iteration_id {
                        if !valid_id(&iteration_id) {
                            return Err("迭代 ID 无效".into());
                        }
                        let file: IterationFile =
                            decode(&read(&format!("{base}/iterations/{iteration_id}.json"))?)?;
                        if file.schema_version != 1
                            || file.id != iteration_id
                            || file.baseline_version_id != iteration_id
                        {
                            return Err("迭代索引无效".into());
                        }
                        let bytes = read(&format!(
                            "{base}/versions/{}.json",
                            file.baseline_version_id
                        ))?;
                        if digest(&bytes) != file.baseline_digest || encode(&current)? != bytes {
                            return Err("迭代基线与现状不一致，原文件已保留".into());
                        }
                        let baseline = decode(&bytes)?;
                        graph = file.draft;
                        iteration = Some(Iteration {
                            id: file.id,
                            name: file.name,
                            started_at: file.started_at,
                            git: file.git,
                            baseline,
                        });
                    }
                    content.diagram = Some(Diagram {
                        schema_version: graph.schema_version,
                        scenario_id: graph.scenario_id,
                        components: graph.components,
                        connections: graph.connections,
                        iteration,
                        history: di.history,
                    });
                }
                contents.push(content);
            }
            let mut system = SystemData {
                architecture,
                contents,
            };
            crate::legacy_storage::hydrate_new_nodes(&mut system);
            systems.push(system);
        }
        let active_node_id = index
            .active_node_id
            .filter(|id| {
                systems
                    .iter()
                    .any(|s| s.architecture.node_ids().contains(&id.as_str()))
            })
            .or_else(|| systems.first().map(|s| s.architecture.id.clone()));
        let workspace = Workspace {
            schema_version: 2,
            active_node_id,
            component_catalog: index.component_catalog,
            git_repository: index.git_repository,
            systems,
        };
        workspace.validate()?;
        Ok((workspace, observed))
    }
    fn validate_version(
        &self,
        snapshot: &GraphSnapshot,
        bytes: &[u8],
        history: &HistoricalVersion,
        scenario: &str,
        catalog: &ComponentCatalog,
    ) -> Result<(), String> {
        snapshot.validate()?;
        if snapshot.scenario_id != scenario
            || history.snapshot_digest.as_deref() != Some(digest(bytes).as_str())
            || history.component_count != Some(snapshot.components.len())
            || history.connection_count != Some(snapshot.connections.len())
        {
            return Err("历史快照与索引不一致，原文件已保留".into());
        }
        catalog.validate_snapshot(&snapshot.scenario_id, &snapshot.components)
    }
    fn validate_histories(&self, workspace: &Workspace, overlay: &Files) -> Result<(), String> {
        let catalog = workspace.component_catalog.clone().unwrap_or_default();
        for system in &workspace.systems {
            for content in &system.contents {
                if let Some(diagram) = &content.diagram {
                    for history in &diagram.history {
                        let path = format!(
                            "{}/versions/{}.json",
                            board_path(&system.architecture.id, &content.id),
                            history.id
                        );
                        let bytes = match overlay.get(&path) {
                            Some(b) => b.clone(),
                            None => self.required(&path)?,
                        };
                        let snapshot = decode(&bytes)?;
                        self.validate_version(
                            &snapshot,
                            &bytes,
                            history,
                            &diagram.scenario_id,
                            &catalog,
                        )
                        .map_err(|error| {
                            format!("历史「{}」无法使用此组件配置：{error}", history.name)
                        })?;
                    }
                }
            }
        }
        Ok(())
    }
    pub fn load_history(&self, board_id: &str, version_id: &str) -> Result<GraphSnapshot, String> {
        if !valid_id(board_id) || !valid_id(version_id) {
            return Err("画板或历史版本 ID 无效".into());
        }
        let state = self.lock.lock().map_err(|_| "工作区锁不可用")?;
        self.check_observed(&state)?;
        let workspace = state.workspace.as_ref().ok_or("请先读取工作区")?;
        for system in &workspace.systems {
            if let Some(diagram) = system
                .contents
                .iter()
                .find(|c| c.id == board_id)
                .and_then(|c| c.diagram.as_ref())
            {
                let history = diagram
                    .history
                    .iter()
                    .find(|h| h.id == version_id)
                    .ok_or("历史版本不存在")?;
                let bytes = self.required(&format!(
                    "{}/versions/{version_id}.json",
                    board_path(&system.architecture.id, board_id)
                ))?;
                let snapshot = decode(&bytes)?;
                self.validate_version(
                    &snapshot,
                    &bytes,
                    history,
                    &diagram.scenario_id,
                    &workspace.component_catalog.clone().unwrap_or_default(),
                )?;
                return Ok(snapshot);
            }
        }
        Err("画板不存在".into())
    }
    pub fn validate_catalog(&self, catalog: &ComponentCatalog) -> Result<(), String> {
        let state = self.lock.lock().map_err(|_| "工作区锁不可用")?;
        self.check_observed(&state)?;
        let mut workspace = state.workspace.clone().ok_or("请先读取工作区")?;
        workspace.component_catalog = Some(catalog.clone());
        workspace.validate()?;
        self.validate_histories(&workspace, &Files::new())
    }
    pub fn verify_unchanged(&self) -> Result<(), String> {
        let state = self.lock.lock().map_err(|_| "工作区锁不可用")?;
        self.check_observed(&state)
    }
    pub(crate) fn has_pending_transaction(&self) -> Result<bool, String> {
        Ok(self.journal()?.exists())
    }
    pub fn snapshot_for_copy(&self) -> Result<Workspace, String> {
        let state = self.lock.lock().map_err(|_| "工作区锁不可用")?;
        self.check_observed(&state)?;
        let (workspace, _) = self.read_split(&Files::new(), &HashSet::new())?;
        self.validate_histories(&workspace, &Files::new())?;
        self.check_observed(&state)?;
        Ok(workspace)
    }
    pub fn delete_system(&self, system_id: &str) -> Result<Workspace, String> {
        if !valid_id(system_id) {
            return Err("系统 ID 无效".into());
        }
        let mut state = self.lock.lock().map_err(|_| "工作区锁不可用")?;
        self.check_observed(&state)?;
        let mut workspace = state.workspace.clone().ok_or("请先读取工作区")?;
        workspace.delete_system(system_id)?;
        let (files, _) = self.files_for(&workspace, state.workspace.as_ref())?;
        self.commit(files, vec![], vec![system_id.into()], false)?;
        let (workspace, observed) = self.read_split(&Files::new(), &HashSet::new())?;
        state.observed = Some(observed);
        state.workspace = Some(workspace.clone());
        Ok(workspace)
    }
    fn commit(
        &self,
        files: Files,
        deletes: Vec<String>,
        deleted_system_ids: Vec<String>,
        migrating: bool,
    ) -> Result<(), String> {
        let mut changes = vec![];
        let mut changed_files = Files::new();
        for (path, bytes) in files {
            let existing = self.read(&path)?;
            if existing.as_ref() == Some(&bytes) {
                continue;
            }
            if migrating
                && existing.is_some()
                && path != "workspace.json"
                && !path.ends_with("/architecture.json")
            {
                return Err("迁移目标已有不同数据，原文件已保留".into());
            }
            changes.push(Mutation {
                path: path.clone(),
                before: existing.as_deref().map(digest),
                after: Some(digest(&bytes)),
            });
            changed_files.insert(path, bytes);
        }
        for path in deletes {
            if let Some(bytes) = self.read(&path)? {
                changes.push(Mutation {
                    path,
                    before: Some(digest(&bytes)),
                    after: None,
                });
            }
        }
        if changes.is_empty() && deleted_system_ids.is_empty() {
            return Ok(());
        }
        // Stage each changed file separately: journal size is independent of snapshot payloads.
        fs::create_dir_all(self.root()?).map_err(|e| e.to_string())?;
        let stage = tempfile::Builder::new()
            .prefix(".pending-files-")
            .tempdir_in(self.root()?)
            .map_err(|e| e.to_string())?;
        for (index, change) in changes.iter().enumerate() {
            if let Some(bytes) = changed_files.get(&change.path) {
                atomic_write(&stage.path().join(format!("{index}.json")), bytes)?;
            }
        }
        let journal = Journal {
            schema_version: 1,
            stage: stage
                .path()
                .file_name()
                .ok_or("事务路径无效")?
                .to_string_lossy()
                .into_owned(),
            changes,
            deleted_system_ids,
        };
        // Validate the complete projected live state before the first public mutation.
        self.validate_journal(&journal, &changed_files)?;
        // Retain staged bodies even if publishing the journal fails after its rename.
        let _ = stage.keep();
        atomic_write(&self.journal()?, &encode(&journal)?)?;
        self.recover()
    }
    fn validate_journal(&self, journal: &Journal, overlay: &Files) -> Result<(), String> {
        if journal.schema_version != 1
            || !journal.stage.starts_with(".pending-files-")
            || journal.stage.contains('/')
            || journal.stage.contains('\\')
            || journal.stage.contains("..")
            || journal.changes.len() > 100000
        {
            return Err("恢复事务无效，原文件已保留".into());
        }
        let mut seen = HashSet::new();
        let mut deleted = HashSet::new();
        for c in &journal.changes {
            if !owned_path(&c.path) || !seen.insert(&c.path) {
                return Err("恢复事务包含非法或重复路径".into());
            }
            if c.after.is_none() {
                if !c.path.ends_with("/current.json")
                    && !c.path.contains("/iterations/")
                    && !c.path.contains("/versions/")
                {
                    return Err("恢复事务不能删除索引或历史快照".into());
                }
                deleted.insert(c.path.clone());
            }
        }
        let (workspace, _) = self.read_split(overlay, &deleted)?;
        for system in &workspace.systems {
            for content in &system.contents {
                if let Some(diagram) = &content.diagram {
                    for history in &diagram.history {
                        if deleted.contains(&format!(
                            "{}/versions/{}.json",
                            board_path(&system.architecture.id, &content.id),
                            history.id
                        )) {
                            return Err("不能删除仍在历史索引中的快照".into());
                        }
                    }
                }
            }
        }
        if journal.deleted_system_ids.len() > 100
            || journal
                .deleted_system_ids
                .iter()
                .collect::<HashSet<_>>()
                .len()
                != journal.deleted_system_ids.len()
            || journal.deleted_system_ids.iter().any(|id| {
                !valid_id(id)
                    || workspace.systems.iter().any(|s| &s.architecture.id == id)
                    || journal
                        .changes
                        .iter()
                        .any(|c| c.path.starts_with(&format!("systems/{id}/")))
            })
        {
            return Err("删除事务中的系统 ID 无效".into());
        }
        let catalog = workspace.component_catalog.clone().unwrap_or_default();
        for (path, bytes) in overlay {
            if path.contains("/versions/") {
                let snapshot: GraphSnapshot = decode(bytes)?;
                snapshot.validate()?;
                catalog.validate_snapshot(&snapshot.scenario_id, &snapshot.components)?;
            }
        }
        Ok(())
    }
    fn recover(&self) -> Result<(), String> {
        let Some(bytes) = read_bytes(&self.journal()?)? else {
            return Ok(());
        };
        let journal: Journal = decode(&bytes)?;
        if !journal.stage.starts_with(".pending-files-")
            || journal.stage.contains('/')
            || journal.stage.contains('\\')
            || journal.stage.contains("..")
        {
            return Err("恢复目录无效".into());
        }
        let stage = self.root()?.join(&journal.stage);
        reject_symlink(&stage)?;
        let mut overlay = Files::new();
        for (index, change) in journal.changes.iter().enumerate() {
            if let Some(hash) = &change.after {
                let bytes = read_bytes(&stage.join(format!("{index}.json")))?
                    .ok_or("恢复数据缺失，原文件已保留")?;
                if digest(&bytes) != *hash {
                    return Err("恢复数据校验失败，原文件已保留".into());
                }
                overlay.insert(change.path.clone(), bytes);
            }
        }
        self.validate_journal(&journal, &overlay)?;
        // Check every destination before writing, even when resuming a partly applied transaction.
        for change in &journal.changes {
            let actual = self.read(&change.path)?.as_deref().map(digest);
            if actual != change.before && actual != change.after {
                return Err("恢复期间文件被外部修改，请保留恢复日志并检查数据".into());
            }
        }
        // Publish bodies before indices; the workspace index is always last.
        let mut ordered: Vec<_> = journal.changes.iter().collect();
        ordered.sort_by_key(|c| {
            if c.path == "workspace.json" {
                3
            } else if c.path.ends_with("/index.json") {
                2
            } else {
                1
            }
        });
        for change in ordered {
            let path = self.path(&change.path)?;
            if let Some(bytes) = overlay.get(&change.path) {
                if read_bytes(&path)?.as_deref().map(digest) != change.after {
                    fs::create_dir_all(path.parent().ok_or("数据路径无效")?)
                        .map_err(|e| e.to_string())?;
                    atomic_write(&path, bytes)?;
                }
            } else {
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.to_string()),
                }
                sync_directory(path.parent().ok_or("数据路径无效")?)?;
            }
        }
        for id in &journal.deleted_system_ids {
            let path = self.root()?.join("systems").join(id);
            reject_symlink(&self.root()?.join("systems"))?;
            reject_symlink(&path)?;
            match fs::remove_dir_all(path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
            sync_directory(&self.root()?.join("systems"))?;
        }
        fs::remove_file(self.journal()?).map_err(|e| e.to_string())?;
        sync_directory(self.root()?)?;
        let _ = fs::remove_dir_all(stage);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Workspace {
        serde_json::from_str(include_str!("../../tests/fixtures/workspace-v2.json")).unwrap()
    }
    fn sample() -> Workspace {
        let mut w = fixture();
        w.systems[0]
            .contents
            .iter_mut()
            .find(|c| c.id == "leads")
            .unwrap()
            .diagram = Some(
            serde_json::from_str(include_str!("../../tests/fixtures/iteration-v2.json")).unwrap(),
        );
        w
    }
    fn graph(w: &mut Workspace) -> &mut Diagram {
        w.systems[0]
            .contents
            .iter_mut()
            .find(|c| c.id == "leads")
            .unwrap()
            .diagram
            .as_mut()
            .unwrap()
    }
    fn publish(w: &mut Workspace) {
        let g = graph(w);
        let i = g.iteration.take().unwrap();
        g.history.push(HistoricalVersion {
            id: i.id,
            name: i.name,
            published_at: "2026-11-01T00:00:00.000Z".into(),
            snapshot: Some(i.baseline),
            git: i.git,
            component_count: None,
            connection_count: None,
            snapshot_digest: None,
        });
    }
    fn new_store(root: &Path) -> WorkspaceStore {
        WorkspaceStore::new(root.join("workspace.json"), None)
    }
    fn contents(path: &Path) -> BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)> {
        let mut files = BTreeMap::new();
        if !path.exists() {
            return files;
        }
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            if entry.path().is_dir() {
                files.extend(contents(&entry.path()));
            } else {
                files.insert(
                    entry.path(),
                    (
                        fs::read(entry.path()).unwrap(),
                        entry.metadata().unwrap().modified().unwrap(),
                    ),
                );
            }
        }
        files
    }
    #[test]
    fn writes_boards_independently_and_skips_every_unchanged_file() {
        let root = tempfile::tempdir().unwrap();
        let store = new_store(root.path());
        let mut w = sample();
        store.save(&w).unwrap();
        assert_eq!(
            decode::<WorkspaceIndex>(&fs::read(root.path().join("workspace.json")).unwrap())
                .unwrap()
                .schema_version,
            3
        );
        assert!(!root
            .path()
            .join("systems/fixture-project/content.json")
            .exists());
        let before = contents(root.path());
        store.save(&w).unwrap();
        assert_eq!(contents(root.path()), before);
        graph(&mut w).components[0].name = "新的注册能力".into();
        store.save(&w).unwrap();
        let after = contents(root.path());
        let changed: Vec<_> = after
            .iter()
            .filter(|(p, value)| before.get(*p) != Some(*value))
            .collect();
        assert_eq!(changed.len(), 1);
        assert!(changed[0].0.to_string_lossy().contains("/iterations/"));
        assert_eq!(
            serde_json::to_value(store.load().unwrap().unwrap()).unwrap(),
            serde_json::to_value(w).unwrap()
        );
    }
    #[test]
    fn publishes_without_copying_baseline_and_loads_only_requested_history() {
        let root = tempfile::tempdir().unwrap();
        let store = new_store(root.path());
        let mut w = sample();
        store.save(&w).unwrap();
        let i = graph(&mut w).iteration.clone().unwrap();
        let path = root.path().join(format!(
            "systems/fixture-project/boards/leads/versions/{}.json",
            i.id
        ));
        let before = fs::metadata(&path).unwrap().modified().unwrap();
        publish(&mut w);
        store.save(&w).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before);
        assert!(!root
            .path()
            .join(format!(
                "systems/fixture-project/boards/leads/iterations/{}.json",
                i.id
            ))
            .exists());
        let mut loaded = new_store(root.path()).load().unwrap().unwrap();
        assert!(graph(&mut loaded).history[0].snapshot.is_none());
        assert_eq!(
            encode(&store.load_history("leads", &i.id).unwrap()).unwrap(),
            encode(&i.baseline).unwrap()
        );
        fs::write(&path, b"broken history").unwrap();
        let fresh = new_store(root.path());
        let loaded = fresh.load().unwrap().unwrap();
        assert!(fresh.load_history("leads", &i.id).is_err());
        fresh.save(&loaded).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"broken history");
    }
    #[test]
    fn migration_preserves_exact_backups_detached_content_and_history() {
        let root = tempfile::tempdir().unwrap();
        let old = LegacyWorkspaceStore::new(root.path().join("workspace.json"), None);
        let mut w = sample();
        publish(&mut w);
        let mut detached = w.systems[0].contents[0].clone();
        detached.id = "detached".into();
        w.systems[0].contents.push(detached);
        old.save(&w).unwrap();
        let index = fs::read(root.path().join("workspace.json")).unwrap();
        let content = fs::read(root.path().join("systems/fixture-project/content.json")).unwrap();
        let store = new_store(root.path());
        let mut loaded = store.load().unwrap().unwrap();
        assert_eq!(
            fs::read(root.path().join("migration-v2-backup/workspace.json")).unwrap(),
            index
        );
        assert_eq!(
            fs::read(
                root.path()
                    .join("migration-v2-backup/systems/fixture-project/content.json")
            )
            .unwrap(),
            content
        );
        assert_eq!(
            loaded.systems[0].contents.len(),
            w.systems[0].contents.len()
        );
        let history = graph(&mut loaded).history[0].clone();
        assert!(history.snapshot.is_none());
        assert_eq!(
            encode(&store.load_history("leads", &history.id).unwrap()).unwrap(),
            encode(graph(&mut w).history[0].snapshot.as_ref().unwrap()).unwrap()
        );
        let before = contents(root.path());
        new_store(root.path()).load().unwrap();
        assert_eq!(contents(root.path()), before);
    }
    #[test]
    fn rejects_invalid_legacy_and_immutable_replacement_without_touching_source() {
        let root = tempfile::tempdir().unwrap();
        let old = LegacyWorkspaceStore::new(root.path().join("workspace.json"), None);
        old.save(&sample()).unwrap();
        let path = root.path().join("systems/fixture-project/content.json");
        fs::write(&path, b"bad JSON").unwrap();
        let before = contents(root.path());
        assert!(new_store(root.path()).load().is_err());
        assert_eq!(contents(root.path()), before);
        let root = tempfile::tempdir().unwrap();
        let store = new_store(root.path());
        let mut w = sample();
        store.save(&w).unwrap();
        let before = contents(root.path());
        graph(&mut w)
            .iteration
            .as_mut()
            .unwrap()
            .baseline
            .components[0]
            .name = "非法覆盖".into();
        assert!(store.save(&w).is_err());
        assert_eq!(contents(root.path()), before);
    }
    #[test]
    fn catalog_validation_reads_unloaded_history_and_rejects_breaking_change() {
        let root = tempfile::tempdir().unwrap();
        let store = new_store(root.path());
        let mut w = sample();
        publish(&mut w);
        let g = graph(&mut w);
        g.components.clear();
        g.connections.clear();
        store.save(&w).unwrap();
        let mut loaded = store.load().unwrap().unwrap();
        assert!(graph(&mut loaded).history[0].snapshot.is_none());
        let mut catalog = serde_json::to_value(ComponentCatalog::default()).unwrap();
        catalog["scenarios"][0]["components"]
            .as_array_mut()
            .unwrap()
            .retain(|t| t["type"] != "ui");
        let catalog: ComponentCatalog = serde_json::from_value(catalog).unwrap();
        assert!(store.validate_catalog(&catalog).is_err());
        loaded.component_catalog = Some(catalog);
        let before = contents(root.path());
        assert!(store.save(&loaded).is_err());
        assert_eq!(contents(root.path()), before);
    }
    fn stage(store: &WorkspaceStore, next: &Workspace, deletes: Vec<String>) -> Journal {
        let (files, _) = store
            .files_for(next, store.lock.lock().unwrap().workspace.as_ref())
            .unwrap();
        let staging = tempfile::Builder::new()
            .prefix(".pending-files-")
            .tempdir_in(store.root().unwrap())
            .unwrap();
        let mut changes = vec![];
        for (path, bytes) in files {
            let old = store.read(&path).unwrap();
            if old.as_ref() == Some(&bytes) {
                continue;
            }
            let index = changes.len();
            atomic_write(&staging.path().join(format!("{index}.json")), &bytes).unwrap();
            changes.push(Mutation {
                path,
                before: old.as_deref().map(digest),
                after: Some(digest(&bytes)),
            });
        }
        let journal = Journal {
            schema_version: 1,
            stage: staging.path().file_name().unwrap().to_str().unwrap().into(),
            changes,
            deleted_system_ids: deletes,
        };
        atomic_write(&store.journal().unwrap(), &encode(&journal).unwrap()).unwrap();
        let _ = staging.keep();
        journal
    }
    #[test]
    fn recovery_rolls_forward_partial_updates_and_refuses_external_conflicts() {
        for partial in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let store = new_store(root.path());
            let mut w = sample();
            store.save(&w).unwrap();
            graph(&mut w).components[0].name = "恢复后的名称".into();
            w.active_node_id = Some("leads".into());
            let journal = stage(&store, &w, vec![]);
            if partial {
                let first = &journal.changes[0];
                atomic_write(
                    &store.path(&first.path).unwrap(),
                    &fs::read(root.path().join(&journal.stage).join("0.json")).unwrap(),
                )
                .unwrap();
            }
            let restored = new_store(root.path()).load().unwrap().unwrap();
            assert_eq!(encode(&restored).unwrap(), encode(&w).unwrap());
            assert!(!store.journal().unwrap().exists());
        }
        let root = tempfile::tempdir().unwrap();
        let store = new_store(root.path());
        let mut w = sample();
        store.save(&w).unwrap();
        graph(&mut w).components[0].name = "next".into();
        let journal = stage(&store, &w, vec![]);
        let path = store.path(&journal.changes[0].path).unwrap();
        fs::write(&path, b"external").unwrap();
        assert!(new_store(root.path())
            .load()
            .unwrap_err()
            .contains("外部修改"));
        assert_eq!(fs::read(path).unwrap(), b"external");
    }
    #[test]
    fn deletion_recovery_retains_backups_and_empty_workspace() {
        let root = tempfile::tempdir().unwrap();
        let old = LegacyWorkspaceStore::new(root.path().join("workspace.json"), None);
        old.save(&sample()).unwrap();
        let store = new_store(root.path());
        let mut w = store.load().unwrap().unwrap();
        w.delete_system("fixture-project").unwrap();
        stage(&store, &w, vec!["fixture-project".into()]);
        let loaded = new_store(root.path()).load().unwrap().unwrap();
        assert!(loaded.systems.is_empty());
        assert!(!root.path().join("systems/fixture-project").exists());
        assert!(root
            .path()
            .join("migration-v2-backup/systems/fixture-project/content.json")
            .exists());
    }
    #[test]
    fn rejects_journal_path_escape_and_kept_system_deletion() {
        let root = tempfile::tempdir().unwrap();
        let store = new_store(root.path());
        store.save(&fixture()).unwrap();
        let original = fs::read(root.path().join("workspace.json")).unwrap();
        for id in ["../outside", "fixture-project"] {
            let w = fixture();
            stage(&store, &w, vec![id.into()]);
            assert!(new_store(root.path()).load().is_err());
            fs::remove_file(store.journal().unwrap()).unwrap();
        }
        let journal = Journal {
            schema_version: 1,
            stage: "../outside".into(),
            changes: vec![],
            deleted_system_ids: vec![],
        };
        atomic_write(&store.journal().unwrap(), &encode(&journal).unwrap()).unwrap();
        assert!(store.load().is_err());
        assert_eq!(
            fs::read(root.path().join("workspace.json")).unwrap(),
            original
        );
    }

    #[test]
    fn discarding_cleans_draft_and_unused_baseline_and_can_be_undone() {
        let root = tempfile::tempdir().unwrap();
        let store = new_store(root.path());
        let mut w = sample();
        let draft = graph(&mut w).clone();
        let iteration = draft.iteration.clone().unwrap();
        store.save(&w).unwrap();
        let mut baseline = serde_json::to_value(&iteration.baseline).unwrap();
        baseline["history"] = serde_json::json!([]);
        *graph(&mut w) = serde_json::from_value(baseline).unwrap();
        store.save(&w).unwrap();
        for kind in ["iterations", "versions"] {
            assert!(!root
                .path()
                .join(format!(
                    "systems/fixture-project/boards/leads/{kind}/{}.json",
                    iteration.id
                ))
                .exists());
        }
        *graph(&mut w) = draft;
        store.save(&w).unwrap();
        assert_eq!(
            encode(&store.load().unwrap().unwrap()).unwrap(),
            encode(&w).unwrap()
        );
    }

    #[test]
    fn migration_recovers_after_partial_file_publication() {
        let root = tempfile::tempdir().unwrap();
        let w = sample();
        LegacyWorkspaceStore::new(root.path().join("workspace.json"), None)
            .save(&w)
            .unwrap();
        let store = new_store(root.path());
        store.backup_legacy(&w).unwrap();
        let journal = stage(&store, &w, vec![]);
        let change = journal
            .changes
            .iter()
            .enumerate()
            .find(|(_, c)| c.path.ends_with("/index.json"))
            .unwrap();
        let target = store.path(&change.1.path).unwrap();
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        atomic_write(
            &target,
            &fs::read(
                root.path()
                    .join(&journal.stage)
                    .join(format!("{}.json", change.0)),
            )
            .unwrap(),
        )
        .unwrap();
        let migrated = new_store(root.path()).load().unwrap().unwrap();
        assert_eq!(encode(&migrated).unwrap(), encode(&w).unwrap());
        let backup: serde_json::Value =
            decode(&fs::read(root.path().join("migration-v2-backup/workspace.json")).unwrap())
                .unwrap();
        assert_eq!(backup["schemaVersion"], 2);
        assert!(!store.journal().unwrap().exists());
    }

    #[test]
    fn large_history_collection_is_loaded_as_metadata_without_aggregate_file_limit() {
        let root = tempfile::tempdir().unwrap();
        let store = new_store(root.path());
        let mut w = sample();
        publish(&mut w);
        store.save(&w).unwrap();
        let mut graph_value = serde_json::to_value(graph(&mut w).snapshot()).unwrap();
        let mut component = graph_value["components"][0].clone();
        component["description"] = serde_json::Value::String("大".repeat(10000));
        component["ownerId"] = serde_json::Value::Null;
        graph_value["components"] = (0..300)
            .map(|i| {
                let mut c = component.clone();
                c["id"] = serde_json::Value::String(format!("node-{i}"));
                c
            })
            .collect();
        graph_value["connections"] = serde_json::json!([]);
        let snapshot: GraphSnapshot = serde_json::from_value(graph_value).unwrap();
        snapshot.validate().unwrap();
        let body = encode(&snapshot).unwrap();
        let board_dir = root.path().join("systems/fixture-project/boards/leads");
        let mut index: BoardIndex =
            decode(&fs::read(board_dir.join("index.json")).unwrap()).unwrap();
        let history = &mut index.diagram.as_mut().unwrap().history;
        history.clear();
        for i in 0..9 {
            let id = format!("large-history-{i}");
            fs::write(board_dir.join(format!("versions/{id}.json")), &body).unwrap();
            history.push(HistoricalVersion {
                id,
                name: "大型历史画板".into(),
                published_at: "2026-11-01T00:00:00.000Z".into(),
                git: None,
                snapshot: None,
                component_count: Some(300),
                connection_count: Some(0),
                snapshot_digest: Some(digest(&body)),
            });
        }
        assert!(body.len() as u64 * 9 > MAX_FILE_BYTES);
        atomic_write(&board_dir.join("index.json"), &encode(&index).unwrap()).unwrap();
        let fresh = new_store(root.path());
        let mut loaded = fresh.load().unwrap().unwrap();
        assert!(graph(&mut loaded)
            .history
            .iter()
            .all(|h| h.snapshot.is_none()));
        fresh.save(&loaded).unwrap();
        assert_eq!(
            fresh
                .load_history("leads", "large-history-8")
                .unwrap()
                .components
                .len(),
            300
        );
    }
}
