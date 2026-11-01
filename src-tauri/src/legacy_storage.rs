use crate::model::{
    migrate_legacy, valid_id, within_limit, Architecture, NodeContent, Section, SectionId,
    SystemData, Workspace,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
type ObservedFiles = Vec<(PathBuf, Vec<u8>)>;

#[derive(Default)]
struct StoreState {
    observed: Option<ObservedFiles>,
}

pub struct LegacyWorkspaceStore {
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
    component_catalog: Option<crate::component_catalog::ComponentCatalog>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    git_repository: Option<crate::git::GitRepository>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContentFile {
    schema_version: u8,
    contents: Vec<NodeContent>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingWrite {
    workspace: Workspace,
    deleted_system_ids: Vec<String>,
}
impl PendingWrite {
    fn validate(&self) -> Result<(), String> {
        self.workspace.validate()?;
        let ids: std::collections::HashSet<_> = self.deleted_system_ids.iter().collect();
        if ids.len() != self.deleted_system_ids.len()
            || ids.len() > 100
            || self.deleted_system_ids.iter().any(|id| {
                !valid_id(id)
                    || self
                        .workspace
                        .systems
                        .iter()
                        .any(|system| &system.architecture.id == id)
            })
        {
            return Err("删除事务中的系统 ID 无效，原文件已保留".into());
        }
        Ok(())
    }
}

// Accept recovery files written before system deletion was introduced.
#[derive(Deserialize)]
#[serde(untagged)]
enum RecoveryJournal {
    Transaction(PendingWrite),
    Legacy(Workspace),
}

impl LegacyWorkspaceStore {
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
        Ok(self.root()?.join(".pending-workspace.json"))
    }

    pub fn load(&self) -> Result<Option<Workspace>, String> {
        let mut state = self.lock.lock().map_err(|_| "工作区锁不可用")?;
        // Roll forward a validated, interrupted multi-file save before exposing any state.
        if let Some(bytes) = read_bytes(&self.journal()?)? {
            let pending = match decode::<RecoveryJournal>(&bytes)? {
                RecoveryJournal::Transaction(pending) => pending,
                RecoveryJournal::Legacy(workspace) => PendingWrite {
                    workspace,
                    deleted_system_ids: vec![],
                },
            };
            pending.validate()?;
            self.apply(&pending.workspace, &pending.deleted_system_ids)?;
            fs::remove_file(self.journal()?).map_err(|e| e.to_string())?;
        }
        let source = match read_bytes(&self.file_path)? {
            Some(bytes) => Some((self.file_path.clone(), bytes)),
            None => match &self.legacy_path {
                Some(path) => read_bytes(path)?.map(|bytes| (path.clone(), bytes)),
                None => None,
            },
        };
        let Some((source_path, bytes)) = source else {
            state.observed = Some(vec![]);
            return Ok(None);
        };
        let value: serde_json::Value = decode(&bytes)?;
        if value.get("schemaVersion").and_then(|v| v.as_u64()) == Some(1) {
            let workspace = migrate_legacy(value).map_err(|e| format!("{e}，原文件已保留"))?;
            fs::create_dir_all(self.root()?).map_err(|e| e.to_string())?;
            if source_path == self.file_path {
                let backup = self.root()?.join("workspace-v1.backup.json");
                if !backup.exists() {
                    atomic_write(&backup, &bytes)?;
                }
            }
            self.commit(&workspace, &[])?;
        } else if source_path != self.file_path {
            return Err("旧目录的工作区版本无效，原文件已保留".into());
        }
        let (workspace, observed) = self.read_current()?;
        state.observed = Some(observed);
        Ok(Some(workspace))
    }

    #[cfg(test)]
    pub fn save(&self, workspace: &Workspace) -> Result<(), String> {
        workspace.validate()?;
        let mut state = self.lock.lock().map_err(|_| "工作区锁不可用")?;
        self.check_observed(&state)?;
        if let Some(bytes) = read_bytes(&self.file_path)? {
            let index: WorkspaceIndex = decode(&bytes)?;
            if index.system_ids.iter().any(|id| {
                !workspace
                    .systems
                    .iter()
                    .any(|system| &system.architecture.id == id)
            }) {
                return Err("请使用删除操作移除应用系统".into());
            }
        }
        let files = self.files_for(workspace)?;
        for (path, _) in &files {
            let known = state
                .observed
                .as_ref()
                .is_some_and(|items| items.iter().any(|(p, _)| p == path));
            if !known && path.exists() {
                return Err("目标系统目录已有数据，请重新读取文件，原文件已保留".into());
            }
        }
        self.commit(workspace, &[])?;
        state.observed = Some(files);
        Ok(())
    }

    #[cfg(test)]
    fn check_observed(&self, state: &StoreState) -> Result<(), String> {
        if self.journal()?.exists() {
            return Err("上次操作尚未完成，请重新读取文件恢复".into());
        }
        // Never silently overwrite a JSON file changed by an external editor.
        if let Some(observed) = &state.observed {
            for (path, previous) in observed {
                if read_bytes(path)?.as_ref() != Some(previous) {
                    return Err("本地 JSON 已在外部修改，请先重新读取文件再编辑".into());
                }
            }
        } else if self.file_path.exists() {
            return Err("请先读取现有工作区再保存".into());
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn delete_system(&self, system_id: &str) -> Result<Workspace, String> {
        if !valid_id(system_id) {
            return Err("系统 ID 无效".into());
        }
        let mut state = self.lock.lock().map_err(|_| "工作区锁不可用")?;
        self.check_observed(&state)?;
        let (mut workspace, _) = self.read_current()?;
        workspace.delete_system(system_id)?;
        self.commit(&workspace, &[system_id.to_owned()])?;
        state.observed = Some(self.files_for(&workspace)?);
        Ok(workspace)
    }

    fn files_for(&self, workspace: &Workspace) -> Result<ObservedFiles, String> {
        let mut files = vec![];
        let systems_dir = self.root()?.join("systems");
        reject_symlink(&systems_dir)?;
        for system in &workspace.systems {
            let directory = systems_dir.join(&system.architecture.id);
            reject_symlink(&directory)?;
            let content = ContentFile {
                schema_version: 1,
                contents: system.contents.clone(),
            };
            files.push((directory.join("content.json"), encode(&content)?));
            files.push((
                directory.join("architecture.json"),
                encode(&system.architecture)?,
            ));
        }
        files.push((
            self.file_path.clone(),
            encode(&WorkspaceIndex {
                schema_version: 2,
                active_node_id: workspace.active_node_id.clone(),
                component_catalog: workspace.component_catalog.clone(),
                git_repository: workspace.git_repository.clone(),
                system_ids: workspace
                    .systems
                    .iter()
                    .map(|s| s.architecture.id.clone())
                    .collect(),
            })?,
        ));
        Ok(files)
    }
    fn commit(&self, workspace: &Workspace, deleted_system_ids: &[String]) -> Result<(), String> {
        let pending = PendingWrite {
            workspace: workspace.clone(),
            deleted_system_ids: deleted_system_ids.to_vec(),
        };
        pending.validate()?;
        let bytes = encode(&pending)?;
        // Preflight every destination before creating the recovery journal.
        self.files_for(workspace)?;
        for id in deleted_system_ids {
            reject_symlink(&self.root()?.join("systems").join(id))?;
        }
        fs::create_dir_all(self.root()?).map_err(|e| e.to_string())?;
        atomic_write(&self.journal()?, &bytes)?;
        self.apply(workspace, deleted_system_ids)?;
        fs::remove_file(self.journal()?).map_err(|e| e.to_string())?;
        Ok(())
    }
    fn apply(&self, workspace: &Workspace, deleted_system_ids: &[String]) -> Result<(), String> {
        PendingWrite {
            workspace: workspace.clone(),
            deleted_system_ids: deleted_system_ids.to_vec(),
        }
        .validate()?;
        for id in deleted_system_ids {
            reject_symlink(&self.root()?.join("systems").join(id))?;
        }
        for (path, bytes) in self.files_for(workspace)? {
            if read_bytes(&path)?.as_ref() == Some(&bytes) {
                continue;
            }
            fs::create_dir_all(path.parent().ok_or("保存目录无效")?).map_err(|e| e.to_string())?;
            atomic_write(&path, &bytes)?;
        }
        // The index is durable before removing directories. Recovery retries this idempotently.
        for id in deleted_system_ids {
            let path = self.root()?.join("systems").join(id);
            reject_symlink(&path)?;
            match fs::remove_dir_all(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("系统目录删除未完成，请重新读取文件恢复：{error}"))
                }
            }
        }
        Ok(())
    }
    fn read_current(&self) -> Result<(Workspace, ObservedFiles), String> {
        let bytes = required_bytes(&self.file_path)?;
        let index: WorkspaceIndex = decode(&bytes)?;
        if index.schema_version != 2 || index.system_ids.len() > 100 {
            return Err("工作区索引无效，原文件已保留".into());
        }
        let mut total_bytes = bytes.len() as u64;
        let mut observed = vec![(self.file_path.clone(), bytes)];
        let mut systems = vec![];
        let systems_dir = self.root()?.join("systems");
        reject_symlink(&systems_dir)?;
        for id in &index.system_ids {
            if !valid_id(id) {
                return Err("系统目录 ID 无效，原文件已保留".into());
            }
            let directory = systems_dir.join(id);
            reject_symlink(&directory)?;
            let architecture_path = directory.join("architecture.json");
            let bytes = required_bytes(&architecture_path)?;
            total_bytes += bytes.len() as u64;
            if total_bytes > MAX_FILE_BYTES {
                return Err("工作区超过 64 MiB，原文件已保留".into());
            }
            let architecture: Architecture = decode(&bytes)?;
            architecture
                .validate()
                .map_err(|e| format!("{e}，原文件已保留"))?;
            if &architecture.id != id {
                return Err("架构 ID 与系统目录不一致，原文件已保留".into());
            }
            observed.push((architecture_path, bytes));
            let content_path = directory.join("content.json");
            let bytes = required_bytes(&content_path)?;
            total_bytes += bytes.len() as u64;
            if total_bytes > MAX_FILE_BYTES {
                return Err("工作区超过 64 MiB，原文件已保留".into());
            }
            let content: ContentFile = decode(&bytes)?;
            if content.schema_version != 1 {
                return Err("需求内容版本无效，原文件已保留".into());
            }
            if !content
                .contents
                .iter()
                .any(|item| item.id == architecture.id)
            {
                return Err("系统根节点的需求内容缺失，原文件已保留".into());
            }
            observed.push((content_path, bytes));
            let mut system = SystemData {
                architecture,
                contents: content.contents,
            };
            hydrate_new_nodes(&mut system);
            systems.push(system);
        }
        let active_node_id = if index.active_node_id.as_ref().is_some_and(|id| {
            systems
                .iter()
                .any(|system| system.architecture.node_ids().contains(&id.as_str()))
        }) {
            index.active_node_id
        } else {
            systems.first().map(|system| system.architecture.id.clone())
        };
        let workspace = Workspace {
            schema_version: 2,
            active_node_id,
            component_catalog: index.component_catalog,
            git_repository: index.git_repository,
            systems,
        };
        workspace
            .validate()
            .map_err(|e| format!("{e}，原文件已保留"))?;
        Ok((workspace, observed))
    }
}

pub(crate) fn hydrate_new_nodes(system: &mut SystemData) {
    for id in system.architecture.node_ids() {
        if system.contents.iter().any(|c| c.id == id) {
            continue;
        }
        system.contents.push(NodeContent {
            id: id.into(),
            created_at: system.architecture.updated_at.clone(),
            updated_at: system.architecture.updated_at.clone(),
            revision: 1,
            diagram: None,
            messages: vec![],
            sections: [
                SectionId::Overview,
                SectionId::Audience,
                SectionId::Features,
                SectionId::Flow,
                SectionId::Acceptance,
            ]
            .into_iter()
            .map(|id| Section {
                id,
                content: String::new(),
                confirmed: false,
            })
            .collect(),
        });
    }
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err("系统数据路径不能是符号链接".into()),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
fn encode(value: &impl Serialize) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("工作区超过 64 MiB 存储限制".into());
    }
    Ok(bytes)
}
fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("JSON 格式无效，原文件已保留：{e}"))
}
fn required_bytes(path: &Path) -> Result<Vec<u8>, String> {
    read_bytes(path)?.ok_or_else(|| format!("缺少数据文件 {}，原文件已保留", path.display()))
}
fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    reject_symlink(path)?;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("无法读取本地文件，原文件已保留：{e}")),
    };
    let mut content = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut content)
        .map_err(|e| e.to_string())?;
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("文件超过 64 MiB，原文件已保留".into());
    }
    Ok(Some(content))
}

pub fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("保存路径无效")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temporary.write_all(content).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary
        .persist(path)
        .map_err(|e| format!("文件保存失败：{e}"))?;
    #[cfg(unix)]
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn export_filename(name: &str, content: &str) -> Result<String, String> {
    if !within_limit(name, 80) || !within_limit(content, 1_000_000) {
        return Err("导出名称或文档超出长度限制".into());
    }
    let name: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let name = name.trim().trim_end_matches('.');
    Ok(format!(
        "{}.md",
        if name.is_empty() {
            "需求文档"
        } else {
            name
        }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Workspace {
        serde_json::from_str(include_str!("../../tests/fixtures/workspace-v2.json")).unwrap()
    }
    fn legacy() -> &'static str {
        include_str!("../../tests/fixtures/workspace-v1.json")
    }
    fn architecture_path(dir: &Path) -> PathBuf {
        dir.join("systems/fixture-project/architecture.json")
    }
    #[test]
    fn diagram_round_trips_with_node_content_and_failed_validation_preserves_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let store = LegacyWorkspaceStore::new(path.clone(), None);
        let mut workspace = fixture();
        let diagram: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/diagram-v2.json")).unwrap();
        workspace.systems[0].contents[0].diagram =
            Some(serde_json::from_value(diagram.clone()).unwrap());
        let expected = serde_json::to_value(&workspace.systems[0].contents[0].diagram).unwrap();
        store.save(&workspace).unwrap();
        let restored = LegacyWorkspaceStore::new(path.clone(), None)
            .load()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(&restored.systems[0].contents[0].diagram).unwrap(),
            expected
        );
        assert!(restored.systems[0].contents[1].diagram.is_none());
        let mut invalid = diagram.clone();
        invalid["connections"][0]["targetId"] = "missing".into();
        workspace.systems[0].contents[0].diagram = Some(serde_json::from_value(invalid).unwrap());
        assert!(store.save(&workspace).is_err());
        let restored = LegacyWorkspaceStore::new(path, None)
            .load()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(&restored.systems[0].contents[0].diagram).unwrap(),
            expected
        );
    }
    #[test]
    fn iteration_round_trips_and_invalid_baseline_cannot_overwrite_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let store = LegacyWorkspaceStore::new(path.clone(), None);
        let mut workspace = fixture();
        let mut graph: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/iteration-v2.json")).unwrap();
        workspace.systems[0].contents[0].diagram =
            Some(serde_json::from_value(graph.clone()).unwrap());
        store.save(&workspace).unwrap();
        let expected = serde_json::to_value(&workspace).unwrap();
        assert_eq!(
            serde_json::to_value(
                LegacyWorkspaceStore::new(path.clone(), None)
                    .load()
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            expected
        );
        graph["iteration"]["baseline"]["connections"][0]["targetId"] = "missing".into();
        workspace.systems[0].contents[0].diagram = Some(serde_json::from_value(graph).unwrap());
        assert!(store.save(&workspace).is_err());
        assert_eq!(
            serde_json::to_value(
                LegacyWorkspaceStore::new(path, None)
                    .load()
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            expected
        );
    }
    #[test]
    fn creates_separate_system_files_and_restores_latest_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let store = LegacyWorkspaceStore::new(path.clone(), None);
        assert!(store.load().unwrap().is_none());
        let mut workspace = fixture();
        store.save(&workspace).unwrap();
        let index: serde_json::Value = decode(&fs::read(&path).unwrap()).unwrap();
        assert!(index.get("systems").is_none());
        assert_eq!(index["systemIds"][0], "fixture-project");
        let architecture: Architecture =
            decode(&fs::read(architecture_path(dir.path())).unwrap()).unwrap();
        assert_eq!(architecture.boards[1].name, "销售线索");
        workspace.systems[0].architecture.name = "新的系统 🚀".into();
        workspace.active_node_id = Some("leads".into());
        store.save(&workspace).unwrap();
        let loaded = LegacyWorkspaceStore::new(path, None)
            .load()
            .unwrap()
            .unwrap();
        assert_eq!(loaded.systems[0].architecture.name, "新的系统 🚀");
        assert_eq!(loaded.active_node_id.as_deref(), Some("leads"));
        assert_eq!(loaded.systems[0].contents[0].revision, 2);
        assert_eq!(fs::read_dir(dir.path().join("systems")).unwrap().count(), 1);
    }
    #[test]
    fn migrates_local_v1_with_backup_and_preserves_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        fs::write(&path, legacy()).unwrap();
        let store = LegacyWorkspaceStore::new(path, None);
        let workspace = store.load().unwrap().unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("workspace-v1.backup.json")).unwrap(),
            legacy()
        );
        assert_eq!(
            workspace.systems[0].contents[0].messages[0].text,
            "补充建议"
        );
        assert!(workspace.systems[0].contents[0].sections[0].confirmed);
        assert!(workspace.systems[0].architecture.boards.is_empty());
        assert_eq!(store.load().unwrap().unwrap().schema_version, 2);
    }
    #[test]
    fn migrates_electron_without_modifying_original_or_overwriting_current() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("electron.json");
        let new = dir.path().join("tauri/workspace.json");
        fs::write(&old, legacy()).unwrap();
        let store = LegacyWorkspaceStore::new(new, Some(old.clone()));
        let mut workspace = store.load().unwrap().unwrap();
        assert_eq!(fs::read_to_string(&old).unwrap(), legacy());
        workspace.systems[0].architecture.name = "迁移后的修改".into();
        store.save(&workspace).unwrap();
        assert_eq!(
            store.load().unwrap().unwrap().systems[0].architecture.name,
            "迁移后的修改"
        );
    }
    #[test]
    fn corrupt_current_file_is_not_replaced_with_legacy() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("electron.json");
        let new = dir.path().join("workspace.json");
        fs::write(&old, legacy()).unwrap();
        fs::write(&new, "{broken").unwrap();
        assert!(LegacyWorkspaceStore::new(new.clone(), Some(old))
            .load()
            .unwrap_err()
            .contains("原文件已保留"));
        assert_eq!(fs::read_to_string(new).unwrap(), "{broken");
    }
    #[test]
    fn invalid_legacy_file_is_not_migrated() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("electron.json");
        let new = dir.path().join("workspace.json");
        fs::write(&old, "{}").unwrap();
        assert!(LegacyWorkspaceStore::new(new.clone(), Some(old))
            .load()
            .is_err());
        assert!(!new.exists());
    }
    #[test]
    fn validates_before_overwriting_and_rejects_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let store = LegacyWorkspaceStore::new(dir.path().join("workspace.json"), None);
        let mut workspace = fixture();
        store.save(&workspace).unwrap();
        let previous = fs::read(architecture_path(dir.path())).unwrap();
        workspace.systems[0].contents[0].sections[1].id = SectionId::Overview;
        assert!(store.save(&workspace).is_err());
        assert_eq!(fs::read(architecture_path(dir.path())).unwrap(), previous);
        workspace = fixture();
        workspace.systems[0].architecture.id = "../outside".into();
        assert!(store.save(&workspace).is_err());
        assert!(!dir.path().join("outside").exists());
    }
    #[test]
    fn external_architecture_changes_are_loaded_and_never_silently_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let store = LegacyWorkspaceStore::new(dir.path().join("workspace.json"), None);
        let workspace = fixture();
        store.save(&workspace).unwrap();
        let mut architecture = workspace.systems[0].architecture.clone();
        architecture.name = "外部修改".into();
        fs::write(
            architecture_path(dir.path()),
            encode(&architecture).unwrap(),
        )
        .unwrap();
        assert!(store.save(&workspace).unwrap_err().contains("外部修改"));
        let loaded = store.load().unwrap().unwrap();
        assert_eq!(loaded.systems[0].architecture.name, "外部修改");
        store.save(&loaded).unwrap();
        fs::write(architecture_path(dir.path()), "{broken").unwrap();
        assert!(store.load().is_err());
        assert_eq!(
            fs::read_to_string(architecture_path(dir.path())).unwrap(),
            "{broken"
        );
    }
    #[test]
    fn manual_structure_additions_get_content_and_removals_keep_history() {
        let dir = tempfile::tempdir().unwrap();
        let store = LegacyWorkspaceStore::new(dir.path().join("workspace.json"), None);
        let mut workspace = fixture();
        workspace.active_node_id = Some("leads".into());
        store.save(&workspace).unwrap();
        let mut architecture = workspace.systems[0].architecture.clone();
        architecture.boards[1].id = "new-module".into();
        fs::write(
            architecture_path(dir.path()),
            encode(&architecture).unwrap(),
        )
        .unwrap();
        let loaded = store.load().unwrap().unwrap();
        assert_eq!(loaded.active_node_id.as_deref(), Some("fixture-project"));
        assert_eq!(loaded.systems[0].contents.len(), 4);
        assert!(loaded.systems[0].contents.iter().any(|c| c.id == "leads"));
        assert!(loaded.systems[0]
            .contents
            .iter()
            .any(|c| c.id == "new-module" && c.sections.len() == 5));
    }
    #[test]
    fn interrupted_multifile_save_rolls_forward_before_loading() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let store = LegacyWorkspaceStore::new(path.clone(), None);
        let mut workspace = fixture();
        store.save(&workspace).unwrap();
        workspace.systems[0].architecture.name = "事务恢复".into();
        workspace.systems[0].contents[2].sections[0].content = "同步恢复的需求".into();
        fs::write(store.journal().unwrap(), encode(&workspace).unwrap()).unwrap();
        // Simulate termination after content was saved but before architecture/index.
        let files = store.files_for(&workspace).unwrap();
        fs::write(&files[0].0, &files[0].1).unwrap();
        let loaded = LegacyWorkspaceStore::new(path, None)
            .load()
            .unwrap()
            .unwrap();
        assert_eq!(loaded.systems[0].architecture.name, "事务恢复");
        assert_eq!(
            loaded.systems[0].contents[2].sections[0].content,
            "同步恢复的需求"
        );
        assert!(!store.journal().unwrap().exists());
    }
    #[test]
    fn malformed_journal_and_missing_content_are_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let store = LegacyWorkspaceStore::new(dir.path().join("workspace.json"), None);
        store.save(&fixture()).unwrap();
        let original = fs::read(architecture_path(dir.path())).unwrap();
        fs::write(store.journal().unwrap(), "{broken").unwrap();
        assert!(store.load().is_err());
        assert_eq!(fs::read(architecture_path(dir.path())).unwrap(), original);
        fs::remove_file(store.journal().unwrap()).unwrap();
        fs::remove_file(dir.path().join("systems/fixture-project/content.json")).unwrap();
        assert!(store.load().unwrap_err().contains("缺少数据文件"));
    }
    #[test]
    fn missing_root_content_is_not_silently_reinitialized() {
        let dir = tempfile::tempdir().unwrap();
        let store = LegacyWorkspaceStore::new(dir.path().join("workspace.json"), None);
        store.save(&fixture()).unwrap();
        let content_path = dir.path().join("systems/fixture-project/content.json");
        let contents = ContentFile {
            schema_version: 1,
            contents: vec![],
        };
        fs::write(&content_path, encode(&contents).unwrap()).unwrap();
        assert!(store.load().unwrap_err().contains("系统根节点"));
        let unchanged: ContentFile = decode(&fs::read(content_path).unwrap()).unwrap();
        assert!(unchanged.contents.is_empty());
    }
    #[test]
    fn rejects_duplicate_ids_names_and_unknown_schema() {
        let mut workspace = fixture();
        workspace.systems[0].architecture.boards[0].id = "leads".into();
        assert!(workspace.validate().is_err());
        workspace = fixture();
        let mut duplicate = workspace.systems[0].architecture.boards[0].clone();
        duplicate.id = "duplicate".into();
        workspace.systems[0].architecture.boards.push(duplicate);
        assert!(workspace.validate().is_err());
        workspace = fixture();
        workspace.schema_version = 3;
        assert!(workspace.validate().is_err());
        workspace = fixture();
        workspace.active_node_id = Some("missing".into());
        assert!(workspace.validate().is_err());
    }
    fn with_second_system() -> Workspace {
        let mut workspace = fixture();
        let mut second = workspace.systems[0].clone();
        second.architecture.id = "other-system".into();
        second.architecture.name = "其他系统".into();
        second.architecture.boards.clear();
        second.contents.truncate(1);
        second.contents[0].id = "other-system".into();
        workspace.systems.push(second);
        workspace
    }
    #[test]
    fn deletion_removes_entire_directory_and_switches_from_descendant() {
        let dir = tempfile::tempdir().unwrap();
        let store = LegacyWorkspaceStore::new(dir.path().join("workspace.json"), None);
        let mut workspace = with_second_system();
        workspace.active_node_id = Some("leads".into());
        store.save(&workspace).unwrap();
        let system_dir = dir.path().join("systems/fixture-project");
        fs::create_dir_all(system_dir.join("attachments")).unwrap();
        fs::write(system_dir.join("attachments/notes.txt"), "系统附件").unwrap();
        let other_content = dir.path().join("systems/other-system/content.json");
        let before = fs::read(&other_content).unwrap();
        let deleted = store.delete_system("fixture-project").unwrap();
        assert_eq!(deleted.active_node_id.as_deref(), Some("other-system"));
        assert_eq!(deleted.systems.len(), 1);
        assert!(!system_dir.exists());
        assert_eq!(fs::read(other_content).unwrap(), before);
        assert_eq!(store.load().unwrap().unwrap().systems.len(), 1);
        store.save(&deleted).unwrap();
        assert!(!system_dir.exists());
    }
    #[test]
    fn deleting_unselected_system_keeps_active_module() {
        let dir = tempfile::tempdir().unwrap();
        let store = LegacyWorkspaceStore::new(dir.path().join("workspace.json"), None);
        let mut workspace = with_second_system();
        workspace.active_node_id = Some("leads".into());
        store.save(&workspace).unwrap();
        let deleted = store.delete_system("other-system").unwrap();
        assert_eq!(deleted.active_node_id.as_deref(), Some("leads"));
        assert!(architecture_path(dir.path()).exists());
    }
    #[test]
    fn deleting_last_system_persists_empty_workspace_without_legacy_resurrection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let legacy_path = dir.path().join("electron.json");
        fs::write(&legacy_path, legacy()).unwrap();
        let store = LegacyWorkspaceStore::new(path.clone(), Some(legacy_path.clone()));
        store.save(&fixture()).unwrap();
        let empty = store.delete_system("fixture-project").unwrap();
        assert!(empty.systems.is_empty());
        assert!(empty.active_node_id.is_none());
        let loaded = LegacyWorkspaceStore::new(path, Some(legacy_path.clone()))
            .load()
            .unwrap()
            .unwrap();
        assert!(loaded.systems.is_empty());
        assert!(loaded.active_node_id.is_none());
        assert_eq!(fs::read_to_string(legacy_path).unwrap(), legacy());
        store.save(&fixture()).unwrap();
        assert!(architecture_path(dir.path()).exists());
    }
    #[test]
    fn failed_or_invalid_delete_preserves_files_and_index() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let store = LegacyWorkspaceStore::new(path.clone(), None);
        store.save(&fixture()).unwrap();
        let index = fs::read(&path).unwrap();
        assert!(store.delete_system("missing").is_err());
        assert!(store.delete_system("../outside").is_err());
        assert_eq!(fs::read(&path).unwrap(), index);
        let mut architecture = fixture().systems[0].architecture.clone();
        architecture.name = "外部修改".into();
        fs::write(
            architecture_path(dir.path()),
            encode(&architecture).unwrap(),
        )
        .unwrap();
        assert!(store
            .delete_system("fixture-project")
            .unwrap_err()
            .contains("外部修改"));
        assert_eq!(fs::read(&path).unwrap(), index);
        assert!(architecture_path(dir.path()).exists());
        assert!(!store.journal().unwrap().exists());
    }
    #[test]
    fn ordinary_save_cannot_bypass_the_delete_operation() {
        let dir = tempfile::tempdir().unwrap();
        let store = LegacyWorkspaceStore::new(dir.path().join("workspace.json"), None);
        let mut workspace = fixture();
        store.save(&workspace).unwrap();
        workspace.delete_system("fixture-project").unwrap();
        assert!(store.save(&workspace).unwrap_err().contains("删除操作"));
        assert!(architecture_path(dir.path()).exists());
    }
    #[test]
    fn interrupted_deletion_completes_before_restart_at_each_stage() {
        for stage in 0..3 {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("workspace.json");
            let store = LegacyWorkspaceStore::new(path.clone(), None);
            let mut empty = fixture();
            store.save(&empty).unwrap();
            empty.delete_system("fixture-project").unwrap();
            let pending = PendingWrite {
                workspace: empty.clone(),
                deleted_system_ids: vec!["fixture-project".into()],
            };
            fs::write(store.journal().unwrap(), encode(&pending).unwrap()).unwrap();
            if stage >= 1 {
                for (file, bytes) in store.files_for(&empty).unwrap() {
                    fs::write(file, bytes).unwrap();
                }
                fs::remove_file(architecture_path(dir.path())).unwrap();
            }
            if stage == 2 {
                fs::remove_dir_all(dir.path().join("systems/fixture-project")).unwrap();
            }
            let loaded = LegacyWorkspaceStore::new(path, None)
                .load()
                .unwrap()
                .unwrap();
            assert!(loaded.systems.is_empty());
            assert!(!dir.path().join("systems/fixture-project").exists());
            assert!(!store.journal().unwrap().exists());
        }
    }
    #[test]
    fn invalid_delete_journal_cannot_remove_kept_systems_or_escape_directory() {
        let dir = tempfile::tempdir().unwrap();
        let store = LegacyWorkspaceStore::new(dir.path().join("workspace.json"), None);
        store.save(&fixture()).unwrap();
        for id in ["fixture-project", "../outside"] {
            let pending = PendingWrite {
                workspace: fixture(),
                deleted_system_ids: vec![id.into()],
            };
            fs::write(store.journal().unwrap(), encode(&pending).unwrap()).unwrap();
            assert!(store.load().is_err());
            assert!(architecture_path(dir.path()).exists());
        }
    }
    #[cfg(unix)]
    #[test]
    fn deleting_system_does_not_follow_attachment_symlinks() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let store = LegacyWorkspaceStore::new(dir.path().join("workspace.json"), None);
        store.save(&fixture()).unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("keep.txt"), "保留").unwrap();
        symlink(
            outside.path(),
            dir.path().join("systems/fixture-project/attachment-link"),
        )
        .unwrap();
        store.delete_system("fixture-project").unwrap();
        assert_eq!(
            fs::read_to_string(outside.path().join("keep.txt")).unwrap(),
            "保留"
        );
    }
    #[test]
    fn export_is_utf8_and_atomically_replaces_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("需求.md");
        fs::write(&path, "旧文档").unwrap();
        atomic_write(&path, "# 新需求\n中文与 emoji 🚀".as_bytes()).unwrap();
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "# 新需求\n中文与 emoji 🚀"
        );
        assert_eq!(
            export_filename("../需求:草稿", "正文").unwrap(),
            ".._需求_草稿.md"
        );
        assert!(!within_limit(&"🚀".repeat(41), 80));
    }
}
