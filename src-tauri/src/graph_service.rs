//! Persistence boundary shared by offline CLI and the desktop's command executor.
use crate::{
    graph_commands::{self, CommandError, GraphRequest},
    model::Workspace,
    storage::WorkspaceStore,
};
use serde_json::Value;

fn storage_error(message: String) -> CommandError {
    CommandError {
        code: "STORAGE_ERROR".into(),
        message,
    }
}

pub(crate) fn execute_in_store(
    store: &WorkspaceStore,
    request: &GraphRequest,
) -> Result<Value, CommandError> {
    let mut workspace = store.load().map_err(storage_error)?.unwrap_or(Workspace {
        schema_version: 2,
        active_node_id: None,
        component_catalog: None,
        git_repository: None,
        systems: vec![],
    });
    // A deletion must account for references in every retained historical version.
    let removes_components = request.command == "component.delete"
        || (request.command == "graph.update"
            && request.input["operations"]
                .as_array()
                .is_some_and(|ops| ops.iter().any(|op| op["op"] == "component.delete")));
    let reads_history = request.input["version"] == "history";
    if request.command == "graph.delete" || removes_components || reads_history {
        for system in &mut workspace.systems {
            for content in &mut system.contents {
                if reads_history
                    && request.command != "graph.delete"
                    && !removes_components
                    && request.graph_id.as_deref() != Some(&content.id)
                {
                    continue;
                }
                if let Some(diagram) = &mut content.diagram {
                    for history in &mut diagram.history {
                        if reads_history
                            && request.command != "graph.delete"
                            && !removes_components
                            && request.input["historyId"].as_str() != Some(&history.id)
                        {
                            continue;
                        }
                        if history.snapshot.is_none() {
                            history.snapshot = Some(
                                store
                                    .load_history(&content.id, &history.id)
                                    .map_err(storage_error)?,
                            );
                        }
                    }
                }
            }
        }
    }
    let outcome = graph_commands::execute(&workspace, request)?;
    if outcome.changed {
        let removed: Vec<_> = workspace
            .systems
            .iter()
            .filter(|s| {
                !outcome
                    .workspace
                    .systems
                    .iter()
                    .any(|next| next.architecture.id == s.architecture.id)
            })
            .collect();
        if removed.is_empty() {
            store.save(&outcome.workspace).map_err(storage_error)?;
        } else if removed.len() == 1 && request.command == "graph.delete" {
            store
                .delete_system(&removed[0].architecture.id)
                .map_err(storage_error)?;
        } else {
            return Err(CommandError {
                code: "INVALID_INPUT".into(),
                message: "请单独删除应用系统".into(),
            });
        }
    }
    Ok(outcome.result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(
        command: &str,
        graph: Option<&str>,
        input: Value,
        revision: Option<&str>,
    ) -> GraphRequest {
        GraphRequest {
            command: command.into(),
            graph_id: graph.map(str::to_owned),
            item_id: None,
            input,
            expected_revision: revision.map(str::to_owned),
            dry_run: false,
        }
    }

    #[test]
    fn commands_bootstrap_persist_and_reject_stale_writes_after_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(directory.path().join("workspace.json"), None);
        let listing =
            execute_in_store(&store, &request("graph.list", None, Value::Null, None)).unwrap();
        let create = execute_in_store(
            &store,
            &request(
                "graph.create",
                None,
                json!({"id":"application","name":"测试系统","kind":"application"}),
                listing["revision"].as_str(),
            ),
        )
        .unwrap();
        assert!(create["wouldChange"].as_bool().unwrap());
        let reopened = WorkspaceStore::new(directory.path().join("workspace.json"), None);
        let get = execute_in_store(
            &reopened,
            &request("graph.get", Some("application"), Value::Null, None),
        )
        .unwrap();
        let previous = get["revision"].as_str().unwrap();
        execute_in_store(
            &reopened,
            &request(
                "graph.update",
                Some("application"),
                json!({"description":"修改后"}),
                Some(previous),
            ),
        )
        .unwrap();
        let error = execute_in_store(
            &reopened,
            &request(
                "graph.update",
                Some("application"),
                json!({"description":"旧版本不得覆盖"}),
                Some(previous),
            ),
        )
        .unwrap_err();
        assert_eq!(error.code, "REVISION_CONFLICT");
        let get = execute_in_store(
            &reopened,
            &request("graph.get", Some("application"), Value::Null, None),
        )
        .unwrap();
        assert_eq!(get["data"]["description"], "修改后");
    }

    #[test]
    fn dry_run_does_not_publish_files_and_root_delete_uses_storage_transaction() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(directory.path().join("workspace.json"), None);
        let listing =
            execute_in_store(&store, &request("graph.list", None, Value::Null, None)).unwrap();
        let mut create = request(
            "graph.create",
            None,
            json!({"id":"root","name":"测试"}),
            listing["revision"].as_str(),
        );
        create.dry_run = true;
        execute_in_store(&store, &create).unwrap();
        assert!(!directory.path().join("workspace.json").exists());
        create.dry_run = false;
        execute_in_store(&store, &create).unwrap();
        let get = execute_in_store(
            &store,
            &request("graph.get", Some("root"), Value::Null, None),
        )
        .unwrap();
        execute_in_store(
            &store,
            &request(
                "graph.delete",
                Some("root"),
                Value::Null,
                get["revision"].as_str(),
            ),
        )
        .unwrap();
        assert!(!directory.path().join("systems/root").exists());
        assert!(store.load().unwrap().unwrap().systems.is_empty());
    }
}
