use crate::{
    model::Workspace,
    storage::{atomic_write, WorkspaceStore},
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectorySettings {
    data_directory: PathBuf,
}

struct ActiveStore {
    directory: PathBuf,
    custom: bool,
    workspace: WorkspaceStore,
    _lease: Option<crate::cli::WorkspaceLock>,
}

pub struct WorkspaceManager {
    default_directory: PathBuf,
    legacy_path: Option<PathBuf>,
    active: Mutex<Option<ActiveStore>>,
    lock_workspace: bool,
}

impl WorkspaceManager {
    pub fn new(default_directory: PathBuf, legacy_path: Option<PathBuf>) -> Self {
        Self {
            default_directory,
            legacy_path,
            active: Mutex::new(None),
            lock_workspace: false,
        }
    }

    pub fn new_locked(default_directory: PathBuf, legacy_path: Option<PathBuf>) -> Self {
        Self {
            lock_workspace: true,
            ..Self::new(default_directory, legacy_path)
        }
    }

    fn settings_path(&self) -> PathBuf {
        self.default_directory.join("data-directory.json")
    }

    fn active<'a>(
        &self,
        state: &'a mut Option<ActiveStore>,
    ) -> Result<&'a mut ActiveStore, String> {
        if state.is_none() {
            let settings = match fs::read(self.settings_path()) {
                Ok(bytes) => Some(
                    serde_json::from_slice::<DirectorySettings>(&bytes)
                        .map_err(|e| format!("数据目录设置无效：{e}"))?,
                ),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(format!("无法读取数据目录设置：{e}")),
            };
            let custom = settings.is_some();
            let directory =
                settings.map_or_else(|| self.default_directory.clone(), |s| s.data_directory);
            if !directory.is_absolute() {
                return Err("数据目录必须是绝对路径".into());
            }
            let legacy = if custom {
                None
            } else {
                self.legacy_path.clone()
            };
            if custom && (!directory.is_dir() || !directory.join("workspace.json").is_file()) {
                return Err(format!(
                    "数据目录不可用或工作区文件缺失：{}",
                    directory.display()
                ));
            }
            let lease = self
                .lock_workspace
                .then(|| crate::cli::WorkspaceLock::new(&directory))
                .transpose()?;
            *state = Some(ActiveStore {
                workspace: WorkspaceStore::new(directory.join("workspace.json"), legacy),
                directory,
                custom,
                _lease: lease,
            });
        }
        let active = state.as_mut().ok_or("数据目录未初始化")?;
        // A disconnected drive must not silently create a fresh workspace or restore an old copy.
        if active.custom
            && (!active.directory.is_dir() || !active.directory.join("workspace.json").is_file())
        {
            return Err(format!(
                "数据目录不可用或工作区文件缺失：{}。请恢复文件夹或连接存储设备后重试。",
                active.directory.display()
            ));
        }
        Ok(active)
    }

    pub fn directory(&self) -> Result<PathBuf, String> {
        let mut state = self.active.lock().map_err(|_| "数据目录锁不可用")?;
        Ok(self.active(&mut state)?.directory.clone())
    }

    pub fn load(&self) -> Result<Option<Workspace>, String> {
        let mut state = self.active.lock().map_err(|_| "数据目录锁不可用")?;
        self.active(&mut state)?.workspace.load()
    }

    #[cfg(test)]
    pub fn save(&self, workspace: &Workspace) -> Result<(), String> {
        let mut state = self.active.lock().map_err(|_| "数据目录锁不可用")?;
        self.active(&mut state)?.workspace.save(workspace)
    }
    pub(crate) fn save_with_index(
        &self,
        workspace: &Workspace,
    ) -> Result<Vec<crate::storage::SavedHistory>, String> {
        let mut state = self.active.lock().map_err(|_| "数据目录锁不可用")?;
        let store = &self.active(&mut state)?.workspace;
        store.save(workspace)?;
        store.history_index()
    }

    pub(crate) fn create_git_iteration(
        &self,
        mut workspace: Workspace,
        board_id: &str,
        branch: &str,
        base_branch: &str,
    ) -> Result<Workspace, String> {
        workspace.validate()?;
        let mut state = self.active.lock().map_err(|_| "数据目录锁不可用")?;
        let active = self.active(&mut state)?;
        let previous = active.workspace.snapshot_for_copy()?;
        let repository = workspace
            .git_repository
            .clone()
            .ok_or("请先关联 Git 仓库")?;
        if serde_json::to_value(&previous.git_repository).ok()
            != serde_json::to_value(&workspace.git_repository).ok()
        {
            return Err("Git 仓库设置发生变化，请保存后重试".into());
        }
        let (si, ci) = workspace
            .systems
            .iter()
            .enumerate()
            .find_map(|(si, system)| {
                if !system.architecture.node_ids().contains(&board_id) {
                    return None;
                }
                system
                    .contents
                    .iter()
                    .position(|content| content.id == board_id)
                    .map(|ci| (si, ci))
            })
            .ok_or("迭代所属画板不存在")?;
        let previous_content = previous
            .systems
            .iter()
            .flat_map(|s| &s.contents)
            .find(|c| c.id == board_id)
            .ok_or("迭代所属画板已变化，请重新读取工作区")?;
        if previous_content
            .diagram
            .as_ref()
            .is_some_and(|d| d.iteration.is_some())
        {
            return Err("该画板已有进行中的迭代".into());
        }
        let content = &workspace.systems[si].contents[ci];
        let diagram = content.diagram.as_ref().ok_or("创建迭代缺少画板数据")?;
        let iteration = diagram.iteration.as_ref().ok_or("创建迭代缺少迭代数据")?;
        if iteration.git.is_some() {
            return Err("新迭代已有关联 Git 分支".into());
        }
        if serde_json::to_value(diagram.snapshot()).ok()
            != serde_json::to_value(&iteration.baseline).ok()
        {
            return Err("新迭代内容必须与现状基线一致".into());
        }
        if let Some(before) = &previous_content.diagram {
            if serde_json::to_value(before.snapshot()).ok()
                != serde_json::to_value(&iteration.baseline).ok()
            {
                return Err("画板现状已变化，请保存后重试".into());
            }
        } else if !diagram.components.is_empty()
            || !diagram.connections.is_empty()
            || !diagram.history.is_empty()
        {
            return Err("新画板的迭代基线必须为空".into());
        }
        // Only creation of this iteration may differ from the last queued save. Ignore cached
        // history bodies and selection, which carry no editable business data.
        let mut expected = workspace.clone();
        let expected_content = &mut expected.systems[si].contents[ci];
        expected_content.updated_at = previous_content.updated_at.clone();
        if previous_content.diagram.is_some() {
            expected_content.diagram.as_mut().unwrap().iteration = None;
        } else {
            expected_content.diagram = None;
        }
        if comparable_workspace(&expected)? != comparable_workspace(&previous)? {
            return Err("工作区已变化，请保存后重试创建迭代".into());
        }
        let binding = crate::git::create_branch(&repository, branch, base_branch)?;
        workspace.systems[si].contents[ci]
            .diagram
            .as_mut()
            .unwrap()
            .iteration
            .as_mut()
            .unwrap()
            .git = Some(binding.clone());
        if let Err(error) = active.workspace.save(&workspace) {
            // Storage journals roll forward. A staged durable transaction owns its branch;
            // deleting that ref would leave a recovered iteration pointing at no branch.
            if active.workspace.has_pending_transaction()? {
                if let Ok(Some(recovered)) = active.workspace.load() {
                    return Ok(recovered);
                }
                return Err(format!(
                    "迭代保存待恢复，Git 分支「{}」已保留。请恢复数据目录后重新读取：{error}",
                    binding.branch
                ));
            }
            if let Err(rollback) = crate::git::rollback_branch(&binding) {
                return Err(format!(
                    "迭代保存失败：{error}。Git 分支「{}」已保留：{rollback}",
                    binding.branch
                ));
            }
            return Err(format!("迭代保存失败，已撤回新建的 Git 分支：{error}"));
        }
        // Return the persisted compact model so front-end autosave can safely continue.
        active.workspace.snapshot_for_copy()
    }

    pub fn load_history(
        &self,
        board_id: &str,
        version_id: &str,
    ) -> Result<crate::diagram::GraphSnapshot, String> {
        let mut state = self.active.lock().map_err(|_| "数据目录锁不可用")?;
        self.active(&mut state)?
            .workspace
            .load_history(board_id, version_id)
    }

    pub fn validate_catalog(
        &self,
        catalog: &crate::component_catalog::ComponentCatalog,
    ) -> Result<(), String> {
        let mut state = self.active.lock().map_err(|_| "数据目录锁不可用")?;
        self.active(&mut state)?.workspace.validate_catalog(catalog)
    }

    pub fn delete_system(&self, system_id: &str) -> Result<Workspace, String> {
        let mut state = self.active.lock().map_err(|_| "数据目录锁不可用")?;
        self.active(&mut state)?.workspace.delete_system(system_id)
    }

    pub fn change_directory(&self, selected: &Path) -> Result<PathBuf, String> {
        let mut state = self.active.lock().map_err(|_| "数据目录锁不可用")?;
        let active = self.active(&mut state)?;
        let target = fs::canonicalize(selected).map_err(|e| format!("无法访问所选文件夹：{e}"))?;
        if !target.is_dir() {
            return Err("请选择一个本地文件夹".into());
        }
        let source = fs::canonicalize(&active.directory).map_err(|e| e.to_string())?;
        if target == source {
            return Ok(active.directory.clone());
        }
        if target.starts_with(&source) {
            return Err("请选择当前数据目录之外的空文件夹".into());
        }
        if !empty_migration_target(&target)? {
            return Err("所选文件夹不是空文件夹，请选择空文件夹，已有文件不会被覆盖".into());
        }
        let next_lease = self
            .lock_workspace
            .then(|| crate::cli::WorkspaceLock::new(&target))
            .transpose()?;
        if !empty_migration_target(&target)? {
            return Err("目标文件夹在取得工作区锁时出现其他文件，请重新选择".into());
        }
        let current = active.workspace.snapshot_for_copy()?;
        let staging = tempfile::Builder::new()
            .prefix(".say-clear-migration-")
            .tempdir_in(&target)
            .map_err(|e| format!("所选文件夹不可写：{e}"))?;
        // Stage all owned data, including attachments and the legacy backup, before publishing.
        for name in [
            "workspace.json",
            "systems",
            "workspace-v1.backup.json",
            "migration-v2-backup",
        ] {
            let path = source.join(name);
            match fs::symlink_metadata(&path) {
                Ok(_) => copy_entry(&path, &staging.path().join(name))?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && name != "workspace.json" => {}
                Err(e) => return Err(format!("无法复制数据：{e}")),
            }
        }
        let copied_store = WorkspaceStore::new(staging.path().join("workspace.json"), None);
        copied_store.load()?.ok_or("复制后的工作空间不存在")?;
        let copied = copied_store.snapshot_for_copy()?;
        if serde_json::to_value(&current).map_err(|e| e.to_string())?
            != serde_json::to_value(&copied).map_err(|e| e.to_string())?
        {
            return Err("复制期间数据发生变化，请重试".into());
        }
        active.workspace.verify_unchanged()?;

        let mut published: Vec<PathBuf> = vec![];
        let result = (|| {
            for entry in fs::read_dir(staging.path()).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let destination = target.join(entry.file_name());
                if destination.exists() {
                    return Err("目标文件夹在复制期间出现同名文件，请重新选择空文件夹".into());
                }
                fs::rename(entry.path(), &destination)
                    .map_err(|e| format!("无法写入新数据目录：{e}"))?;
                published.push(destination);
            }
            let next = WorkspaceStore::new(target.join("workspace.json"), None);
            next.load()?;
            active.workspace.verify_unchanged()?;
            let settings = serde_json::to_vec_pretty(&DirectorySettings {
                data_directory: target.clone(),
            })
            .map_err(|e| e.to_string())?;
            // Persist the pointer last. Until this succeeds all commands still use the old store.
            atomic_write(&self.settings_path(), &settings)
                .map_err(|e| format!("无法保存数据目录设置：{e}"))?;
            Ok(next)
        })();
        match result {
            Ok(next) => {
                *active = ActiveStore {
                    directory: target.clone(),
                    custom: true,
                    workspace: next,
                    _lease: next_lease,
                };
                Ok(target)
            }
            Err(error) => {
                for path in published {
                    if path.is_dir() {
                        let _ = fs::remove_dir_all(path);
                    } else {
                        let _ = fs::remove_file(path);
                    }
                }
                Err(error)
            }
        }
    }
}

fn comparable_workspace(workspace: &Workspace) -> Result<serde_json::Value, String> {
    let mut value = serde_json::to_value(workspace).map_err(|e| e.to_string())?;
    value.as_object_mut().unwrap().remove("activeNodeId");
    for system in value["systems"].as_array_mut().into_iter().flatten() {
        for content in system["contents"].as_array_mut().into_iter().flatten() {
            for history in content["diagram"]["history"]
                .as_array_mut()
                .into_iter()
                .flatten()
            {
                for key in [
                    "snapshot",
                    "componentCount",
                    "connectionCount",
                    "snapshotDigest",
                ] {
                    history.as_object_mut().unwrap().remove(key);
                }
            }
        }
    }
    Ok(value)
}

fn empty_migration_target(path: &Path) -> Result<bool, String> {
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        // OS lock files persist after their owner exits; an unlocked valid lock is not data.
        if entry.file_name() == ".sayclear-workspace.lock"
            && entry.file_type().map_err(|e| e.to_string())?.is_file()
        {
            continue;
        }
        return Ok(false);
    }
    Ok(true)
}

fn copy_entry(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        fs::create_dir(target).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_entry(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|e| format!("复制文件失败：{e}"))?;
        output.sync_all().map_err(|e| e.to_string())?;
    } else {
        return Err(format!(
            "数据目录包含符号链接或特殊文件，无法复制：{}",
            source.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_workspace(repository: &Path) -> Workspace {
        let mut workspace = fixture();
        workspace.git_repository = Some(crate::git::GitRepository {
            path: crate::git::inspect(repository.to_str().unwrap())
                .unwrap()
                .path,
            base_branch: "main".into(),
            remote_url: None,
        });
        workspace
    }

    fn with_git_iteration(mut workspace: Workspace) -> Workspace {
        workspace.systems[0].contents[0].diagram = Some(serde_json::from_value(serde_json::json!({
            "schemaVersion": 2, "scenarioId": "general", "components": [], "connections": [], "history": [],
            "iteration": { "id": "git-iteration", "name": "开发新功能", "startedAt": "2026-11-01T00:00:00.000Z",
                "baseline": { "schemaVersion": 2, "scenarioId": "general", "components": [], "connections": [] }
            }
        })).unwrap());
        workspace
    }

    #[test]
    fn git_creation_persists_repository_iteration_and_published_history_across_restart() {
        let repository = crate::git::tests::repository();
        let directory = tempfile::tempdir().unwrap();
        let manager = WorkspaceManager::new(directory.path().to_owned(), None);
        let workspace = git_workspace(repository.path());
        manager.save(&workspace).unwrap();
        let mut created = manager
            .create_git_iteration(
                with_git_iteration(workspace),
                "fixture-project",
                "iteration/new-feature",
                "main",
            )
            .unwrap();
        let binding = created.systems[0].contents[0]
            .diagram
            .as_ref()
            .unwrap()
            .iteration
            .as_ref()
            .unwrap()
            .git
            .clone()
            .unwrap();
        assert_eq!(binding.branch, "iteration/new-feature");
        assert_eq!(
            binding.base_commit,
            crate::git::tests::run(repository.path(), &["rev-parse", "main"]).trim()
        );
        let restarted = WorkspaceManager::new(directory.path().to_owned(), None);
        let loaded = restarted.load().unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&created).unwrap(),
            serde_json::to_value(loaded).unwrap()
        );
        let graph = created.systems[0].contents[0].diagram.as_mut().unwrap();
        let iteration = graph.iteration.take().unwrap();
        graph.history.push(crate::diagram::HistoricalVersion {
            id: iteration.id,
            name: iteration.name,
            published_at: "2026-11-01T01:00:00.000Z".into(),
            snapshot: Some(iteration.baseline),
            git: iteration.git,
            component_count: None,
            connection_count: None,
            snapshot_digest: None,
        });
        restarted.save(&created).unwrap();
        let published = WorkspaceManager::new(directory.path().to_owned(), None)
            .load()
            .unwrap()
            .unwrap();
        assert_eq!(
            published.systems[0].contents[0]
                .diagram
                .as_ref()
                .unwrap()
                .history[0]
                .git
                .as_ref()
                .unwrap()
                .branch,
            binding.branch
        );
        let migrated = tempfile::tempdir().unwrap();
        let legacy = crate::legacy_storage::LegacyWorkspaceStore::new(
            migrated.path().join("workspace.json"),
            None,
        );
        legacy.save(&created).unwrap();
        let migrated = WorkspaceManager::new(migrated.path().to_owned(), None)
            .load()
            .unwrap()
            .unwrap();
        assert!(migrated.git_repository.is_some());
        assert!(migrated.systems[0].contents[0]
            .diagram
            .as_ref()
            .unwrap()
            .history[0]
            .git
            .is_some());
    }

    #[test]
    fn git_creation_rolls_back_branch_on_save_failure_and_refuses_stale_or_duplicate_creation() {
        let repository = crate::git::tests::repository();
        let directory = tempfile::tempdir().unwrap();
        let manager = WorkspaceManager::new(directory.path().to_owned(), None);
        let workspace = git_workspace(repository.path());
        manager.save(&workspace).unwrap();
        let conflict = directory
            .path()
            .join("systems/fixture-project/boards/fixture-project/versions/git-iteration.json");
        fs::create_dir_all(conflict.parent().unwrap()).unwrap();
        fs::write(&conflict, "external content").unwrap();
        let error = manager
            .create_git_iteration(
                with_git_iteration(workspace.clone()),
                "fixture-project",
                "iteration/rollback",
                "main",
            )
            .unwrap_err();
        assert!(error.contains("已撤回"), "{error}");
        assert!(!crate::git::inspect(repository.path().to_str().unwrap())
            .unwrap()
            .branches
            .contains(&"iteration/rollback".into()));
        assert_eq!(fs::read_to_string(&conflict).unwrap(), "external content");
        fs::remove_file(conflict).unwrap();
        let mut stale = with_git_iteration(workspace.clone());
        stale.systems[0].architecture.name = "stale change".into();
        assert!(manager
            .create_git_iteration(stale, "fixture-project", "iteration/stale", "main")
            .unwrap_err()
            .contains("已变化"));
        let created = manager
            .create_git_iteration(
                with_git_iteration(workspace),
                "fixture-project",
                "iteration/success",
                "main",
            )
            .unwrap();
        assert!(manager
            .create_git_iteration(created, "fixture-project", "iteration/duplicate", "main")
            .unwrap_err()
            .contains("已有"));
        let branches = crate::git::inspect(repository.path().to_str().unwrap())
            .unwrap()
            .branches;
        assert_eq!(branches, ["iteration/success", "main"]);
    }

    fn fixture() -> Workspace {
        serde_json::from_str(include_str!("../../tests/fixtures/workspace-v2.json")).unwrap()
    }

    #[test]
    fn locked_manager_owns_workspace_and_failed_migration_can_be_retried() {
        let original = tempfile::tempdir().unwrap();
        let selected = tempfile::tempdir().unwrap();
        let manager = WorkspaceManager::new_locked(original.path().to_owned(), None);
        assert!(manager.load().unwrap().is_none());
        assert!(crate::cli::WorkspaceLock::new(original.path()).is_err());
        manager.save(&fixture()).unwrap();
        fs::create_dir(manager.settings_path()).unwrap();
        assert!(manager.change_directory(selected.path()).is_err());
        assert_eq!(manager.directory().unwrap(), original.path());
        assert!(selected.path().join(".sayclear-workspace.lock").is_file());
        fs::remove_dir(manager.settings_path()).unwrap();
        manager.change_directory(selected.path()).unwrap();
        assert!(crate::cli::WorkspaceLock::new(original.path()).is_ok());
        assert!(crate::cli::WorkspaceLock::new(selected.path()).is_err());
        drop(manager);
        assert!(crate::cli::WorkspaceLock::new(selected.path()).is_ok());
    }

    #[test]
    fn migrates_all_data_and_restart_uses_new_directory_for_save_and_delete() {
        let original = tempfile::tempdir().unwrap();
        let selected = tempfile::tempdir().unwrap();
        let manager = WorkspaceManager::new(original.path().to_owned(), None);
        assert!(manager.load().unwrap().is_none());
        let mut workspace = fixture();
        manager.save(&workspace).unwrap();
        let attachment = "systems/fixture-project/attachments/说明.txt";
        fs::create_dir_all(original.path().join("systems/fixture-project/attachments")).unwrap();
        fs::write(original.path().join(attachment), "中文附件 🚀").unwrap();
        fs::write(original.path().join("workspace-v1.backup.json"), "旧版备份").unwrap();
        let target = manager.change_directory(selected.path()).unwrap();
        assert_eq!(target, fs::canonicalize(selected.path()).unwrap());
        assert_eq!(
            fs::read_to_string(target.join(attachment)).unwrap(),
            "中文附件 🚀"
        );
        assert_eq!(
            fs::read_to_string(target.join("workspace-v1.backup.json")).unwrap(),
            "旧版备份"
        );
        assert!(!target.join("data-directory.json").exists());
        let restarted = WorkspaceManager::new(original.path().to_owned(), None);
        assert_eq!(restarted.directory().unwrap(), target);
        let loaded = restarted.load().unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&loaded).unwrap(),
            serde_json::to_value(&workspace).unwrap()
        );
        workspace.systems[0].architecture.name = "新目录中的修改".into();
        restarted.save(&workspace).unwrap();
        let old = WorkspaceStore::new(original.path().join("workspace.json"), None)
            .load()
            .unwrap()
            .unwrap();
        assert_ne!(
            old.systems[0].architecture.name,
            workspace.systems[0].architecture.name
        );
        restarted.delete_system("fixture-project").unwrap();
        assert!(!target.join("systems/fixture-project").exists());
        assert!(original.path().join(attachment).exists());
        assert!(WorkspaceManager::new(original.path().to_owned(), None)
            .load()
            .unwrap()
            .unwrap()
            .systems
            .is_empty());
    }

    #[test]
    fn unchanged_directory_is_a_noop_and_nonempty_or_nested_directories_are_rejected() {
        let original = tempfile::tempdir().unwrap();
        let selected = tempfile::tempdir().unwrap();
        let manager = WorkspaceManager::new(original.path().to_owned(), None);
        manager.save(&fixture()).unwrap();
        assert_eq!(
            manager.change_directory(original.path()).unwrap(),
            original.path()
        );
        assert!(!manager.settings_path().exists());
        fs::write(selected.path().join("keep.txt"), "保留").unwrap();
        assert!(manager
            .change_directory(selected.path())
            .unwrap_err()
            .contains("不是空文件夹"));
        assert_eq!(
            fs::read_to_string(selected.path().join("keep.txt")).unwrap(),
            "保留"
        );
        let nested = original.path().join("nested");
        fs::create_dir(&nested).unwrap();
        assert!(manager
            .change_directory(&nested)
            .unwrap_err()
            .contains("之外"));
        assert_eq!(manager.directory().unwrap(), original.path());
    }

    #[test]
    fn directory_copy_validates_and_retains_unloaded_history_and_migration_backups() {
        let original = tempfile::tempdir().unwrap();
        let selected = tempfile::tempdir().unwrap();
        let manager = WorkspaceManager::new(original.path().to_owned(), None);
        let mut workspace = fixture();
        let mut diagram: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/iteration-v2.json")).unwrap();
        let baseline = diagram["iteration"]["baseline"].clone();
        let id = diagram["iteration"]["id"].as_str().unwrap().to_string();
        diagram["history"] = serde_json::json!([{
            "id": id, "name": "迁移前的现状", "publishedAt": "2026-11-01T00:00:00.000Z", "snapshot": baseline,
        }]);
        diagram.as_object_mut().unwrap().remove("iteration");
        workspace.systems[0].contents[0].diagram = Some(serde_json::from_value(diagram).unwrap());
        crate::legacy_storage::LegacyWorkspaceStore::new(
            original.path().join("workspace.json"),
            None,
        )
        .save(&workspace)
        .unwrap();
        let loaded = manager.load().unwrap().unwrap();
        assert!(loaded.systems[0].contents[0]
            .diagram
            .as_ref()
            .unwrap()
            .history[0]
            .snapshot
            .is_none());
        let target = manager.change_directory(selected.path()).unwrap();
        assert!(target.join("migration-v2-backup/workspace.json").exists());
        assert_eq!(
            serde_json::to_value(manager.load_history("fixture-project", &id).unwrap()).unwrap(),
            serde_json::to_value(
                serde_json::from_value::<crate::diagram::GraphSnapshot>(baseline).unwrap()
            )
            .unwrap()
        );
        let third = tempfile::tempdir().unwrap();
        fs::write(
            target.join(format!(
                "systems/fixture-project/boards/fixture-project/versions/{id}.json"
            )),
            "damaged",
        )
        .unwrap();
        assert!(manager.change_directory(third.path()).is_err());
        assert_eq!(fs::read_dir(third.path()).unwrap().count(), 0);
        assert_eq!(manager.directory().unwrap(), target);
        assert!(original
            .path()
            .join(format!(
                "systems/fixture-project/boards/fixture-project/versions/{id}.json"
            ))
            .exists());
    }

    #[test]
    fn configuration_failure_rolls_back_published_files_and_keeps_old_store() {
        let original = tempfile::tempdir().unwrap();
        let selected = tempfile::tempdir().unwrap();
        let manager = WorkspaceManager::new(original.path().to_owned(), None);
        manager.save(&fixture()).unwrap();
        fs::create_dir(manager.settings_path()).unwrap();
        assert!(manager
            .change_directory(selected.path())
            .unwrap_err()
            .contains("无法保存数据目录设置"));
        assert_eq!(fs::read_dir(selected.path()).unwrap().count(), 0);
        assert_eq!(manager.directory().unwrap(), original.path());
        manager.save(&fixture()).unwrap();
    }

    #[test]
    fn external_edits_block_migration_without_touching_target() {
        let original = tempfile::tempdir().unwrap();
        let selected = tempfile::tempdir().unwrap();
        let manager = WorkspaceManager::new(original.path().to_owned(), None);
        manager.save(&fixture()).unwrap();
        let path = original
            .path()
            .join("systems/fixture-project/architecture.json");
        fs::write(&path, "外部修改").unwrap();
        assert!(manager
            .change_directory(selected.path())
            .unwrap_err()
            .contains("外部修改"));
        assert_eq!(fs::read_to_string(path).unwrap(), "外部修改");
        assert_eq!(fs::read_dir(selected.path()).unwrap().count(), 0);
        assert!(!manager.settings_path().exists());
    }

    #[test]
    fn missing_custom_data_never_recreates_or_falls_back_to_the_old_copy() {
        let original = tempfile::tempdir().unwrap();
        let selected = tempfile::tempdir().unwrap();
        let manager = WorkspaceManager::new(original.path().to_owned(), None);
        manager.save(&fixture()).unwrap();
        let target = manager.change_directory(selected.path()).unwrap();
        selected.close().unwrap();
        assert!(manager
            .save(&fixture())
            .unwrap_err()
            .contains("数据目录不可用"));
        let restarted = WorkspaceManager::new(original.path().to_owned(), None);
        assert!(restarted.load().unwrap_err().contains("数据目录不可用"));
        assert!(!target.exists());
        assert!(original.path().join("workspace.json").exists());
    }

    #[test]
    fn empty_workspace_and_subsequent_directory_changes_persist() {
        let original = tempfile::tempdir().unwrap();
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let manager = WorkspaceManager::new(original.path().to_owned(), None);
        let empty = Workspace {
            schema_version: 2,
            active_node_id: None,
            component_catalog: None,
            git_repository: None,
            systems: vec![],
        };
        manager.save(&empty).unwrap();
        manager.change_directory(first.path()).unwrap();
        manager.change_directory(second.path()).unwrap();
        let restarted = WorkspaceManager::new(original.path().to_owned(), None);
        assert_eq!(
            restarted.directory().unwrap(),
            fs::canonicalize(second.path()).unwrap()
        );
        assert!(restarted.load().unwrap().unwrap().systems.is_empty());
        assert!(first.path().join("workspace.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_attachments_fail_without_leaving_partial_data() {
        let original = tempfile::tempdir().unwrap();
        let selected = tempfile::tempdir().unwrap();
        let manager = WorkspaceManager::new(original.path().to_owned(), None);
        manager.save(&fixture()).unwrap();
        std::os::unix::fs::symlink(
            original.path(),
            original.path().join("systems/fixture-project/link"),
        )
        .unwrap();
        assert!(manager
            .change_directory(selected.path())
            .unwrap_err()
            .contains("符号链接"));
        assert_eq!(fs::read_dir(selected.path()).unwrap().count(), 0);
        assert_eq!(manager.directory().unwrap(), original.path());
    }

    #[cfg(unix)]
    #[test]
    fn read_only_target_preserves_the_current_directory() {
        use std::os::unix::fs::PermissionsExt;
        let original = tempfile::tempdir().unwrap();
        let selected = tempfile::tempdir().unwrap();
        let manager = WorkspaceManager::new(original.path().to_owned(), None);
        manager.save(&fixture()).unwrap();
        fs::set_permissions(selected.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let result = manager.change_directory(selected.path());
        fs::set_permissions(selected.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.unwrap_err().contains("不可写"));
        assert_eq!(manager.directory().unwrap(), original.path());
        assert_eq!(fs::read_dir(selected.path()).unwrap().count(), 0);
    }
}
