//! The graph command contract shared by the desktop bridge and the headless CLI.
//! Commands produce a candidate workspace; persistence and UI scheduling belong to the host.
use crate::model::{valid_id, Workspace};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeSet,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GraphRequest {
    pub command: String,
    #[serde(default)]
    pub graph_id: Option<String>,
    #[serde(default)]
    pub item_id: Option<String>,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub expected_revision: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct CommandError {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for CommandError {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphOutcome {
    pub workspace: Workspace,
    pub result: Value,
    pub changed: bool,
    pub changed_board_ids: Vec<String>,
}

fn error(code: &str, message: impl Into<String>) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
    }
}
fn invalid(message: impl Into<String>) -> CommandError {
    error("INVALID_INPUT", message)
}
fn object(value: &Value) -> Result<Map<String, Value>, CommandError> {
    match value {
        Value::Null => Ok(Map::new()),
        Value::Object(map) => Ok(map.clone()),
        _ => Err(invalid("input 必须为 JSON 对象")),
    }
}
fn keys(map: &Map<String, Value>, allowed: &[&str]) -> Result<(), CommandError> {
    if let Some(key) = map.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid(format!("不支持的字段：{key}")));
    }
    Ok(())
}
fn string<'a>(map: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, CommandError> {
    map.get(key)
        .map(|v| {
            v.as_str()
                .ok_or_else(|| invalid(format!("{key} 必须为字符串")))
        })
        .transpose()
}
fn required<'a>(map: &'a Map<String, Value>, key: &str) -> Result<&'a str, CommandError> {
    string(map, key)?.ok_or_else(|| invalid(format!("缺少 {key}")))
}
fn id(map: &Map<String, Value>, prefix: &str) -> Result<String, CommandError> {
    if let Some(value) = string(map, "id")? {
        if !valid_id(value) {
            return Err(invalid(
                "ID 只能包含字母、数字、下划线和连字符，最长 80 字符",
            ));
        }
        return Ok(value.into());
    }
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(format!(
        "{prefix}-{nanos:x}-{:x}",
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}
fn timestamp() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    chrono::DateTime::from_timestamp(duration.as_secs() as i64, duration.subsec_nanos())
        .expect("current UTC timestamp")
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn hash(value: &Value) -> String {
    // Sort recursively even when another dependency enables serde_json/preserve_order.
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
            Value::Object(map) => {
                let mut sorted = Map::new();
                let mut keys: Vec<_> = map.keys().collect();
                keys.sort();
                for key in keys {
                    sorted.insert(key.clone(), canonical(&map[key]));
                }
                Value::Object(sorted)
            }
            _ => value.clone(),
        }
    }
    let bytes = serde_json::to_vec(&canonical(value)).expect("JSON value serialization");
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}
fn catalog(workspace: &Workspace) -> Value {
    serde_json::to_value(workspace.component_catalog.clone().unwrap_or_default())
        .expect("catalog serialization")
}
fn locate(
    workspace: &Value,
    graph_id: &str,
) -> Result<(usize, Option<usize>, usize), CommandError> {
    for (si, system) in workspace["systems"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let architecture = &system["architecture"];
        let node = if architecture["id"] == graph_id {
            Some(None)
        } else {
            architecture["boards"]
                .as_array()
                .and_then(|boards| boards.iter().position(|b| b["id"] == graph_id))
                .map(Some)
        };
        if let Some(node) = node {
            let ci = system["contents"]
                .as_array()
                .and_then(|contents| contents.iter().position(|c| c["id"] == graph_id))
                .ok_or_else(|| error("INVALID_WORKSPACE", "画板内容缺失"))?;
            return Ok((si, node, ci));
        }
    }
    Err(error("NOT_FOUND", format!("画板不存在：{graph_id}")))
}
fn node(workspace: &Value, graph_id: &str) -> Result<Value, CommandError> {
    let (si, ni, _) = locate(workspace, graph_id)?;
    let architecture = &workspace["systems"][si]["architecture"];
    let item = ni.map_or(architecture, |i| &architecture["boards"][i]);
    Ok(
        json!({"id":graph_id,"systemId":architecture["id"],"name":item["name"],"description":item["description"],
        "kind":item["kind"],"parentId":item.get("parentId").cloned().unwrap_or(Value::Null)}),
    )
}
fn empty_graph() -> Value {
    json!({"schemaVersion":2,"scenarioId":"general","components":[],"connections":[],"history":[]})
}
fn diagram(workspace: &Value, graph_id: &str) -> Result<Value, CommandError> {
    let (si, _, ci) = locate(workspace, graph_id)?;
    Ok(workspace["systems"][si]["contents"][ci]
        .get("diagram")
        .cloned()
        .unwrap_or_else(empty_graph))
}
fn normalized_graph(mut graph: Value) -> Value {
    if let Some(history) = graph.get_mut("history").and_then(Value::as_array_mut) {
        for history in history {
            if let Some(map) = history.as_object_mut() {
                // These fields change when an immutable version is loaded/compacted, not when edited.
                for key in [
                    "snapshot",
                    "snapshotDigest",
                    "componentCount",
                    "connectionCount",
                ] {
                    map.remove(key);
                }
            }
        }
    }
    graph
}
fn scope(workspace: &Value, graph_id: &str, catalog_revision: &str) -> Result<Value, CommandError> {
    let (si, _, _) = locate(workspace, graph_id)?;
    let children: Vec<_> = workspace["systems"][si]["architecture"]["boards"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["parentId"] == graph_id)
        .cloned()
        .collect();
    Ok(
        json!({"node":node(workspace,graph_id)?,"children":children,"diagram":normalized_graph(diagram(workspace,graph_id)?),"catalogRevision":catalog_revision}),
    )
}
fn revision(
    workspace: &Value,
    graph_id: &str,
    catalog_revision: &str,
) -> Result<String, CommandError> {
    Ok(hash(&scope(workspace, graph_id, catalog_revision)?))
}
fn graph_ids(workspace: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    for system in workspace["systems"].as_array().into_iter().flatten() {
        if let Some(id) = system["architecture"]["id"].as_str() {
            ids.push(id.into());
        }
        for board in system["architecture"]["boards"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(id) = board["id"].as_str() {
                ids.push(id.into());
            }
        }
    }
    ids
}
fn workspace_revision(workspace: &Value, catalog_revision: &str) -> Result<String, CommandError> {
    let scopes: Result<Vec<_>, _> = graph_ids(workspace)
        .iter()
        .map(|id| scope(workspace, id, catalog_revision))
        .collect();
    Ok(hash(
        &json!({"graphs":scopes?,"catalogRevision":catalog_revision}),
    ))
}
fn selected_graph(
    workspace: &Value,
    graph_id: &str,
    input: &Map<String, Value>,
) -> Result<Value, CommandError> {
    let graph = diagram(workspace, graph_id)?;
    match string(input, "version")?.unwrap_or("editable") {
        "editable" => Ok(graph),
        "current" => Ok(graph
            .get("iteration")
            .and_then(|i| i.get("baseline"))
            .cloned()
            .unwrap_or(graph)),
        "iteration" => {
            if graph.get("iteration").is_some_and(|v| !v.is_null()) {
                Ok(graph)
            } else {
                Err(error("NOT_FOUND", "当前画板没有进行中迭代"))
            }
        }
        "history" => {
            let history_id = required(input, "historyId")?;
            let history = graph["history"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|h| h["id"] == history_id)
                .ok_or_else(|| error("NOT_FOUND", "历史版本不存在"))?;
            history
                .get("snapshot")
                .cloned()
                .ok_or_else(|| error("HISTORY_REQUIRED", "请先加载指定历史快照"))
        }
        _ => Err(invalid(
            "version 必须为 editable、current、iteration 或 history",
        )),
    }
}
fn check_write_version(graph: &Value, input: &Map<String, Value>) -> Result<(), CommandError> {
    match string(input, "version")?.unwrap_or("editable") {
        "editable" => Ok(()),
        "iteration" if graph.get("iteration").is_some_and(|v| !v.is_null()) => Ok(()),
        "current" if graph.get("iteration").is_none_or(Value::is_null) => Ok(()),
        "current" | "iteration" | "history" => Err(error(
            "READ_ONLY",
            "该版本不可编辑，请修改当前活动迭代或可编辑现状",
        )),
        _ => Err(invalid("version 无效")),
    }
}
fn require_revision(request: &GraphRequest, actual: &str) -> Result<(), CommandError> {
    match request.expected_revision.as_deref() {
        None => Err(error(
            "REVISION_REQUIRED",
            "写操作必须携带 --if-match；先查询图或图列表获取 revision",
        )),
        Some(value) if value == actual => Ok(()),
        Some(_) => Err(error(
            "REVISION_CONFLICT",
            "画板已变化，请重新查询后提交修改",
        )),
    }
}
fn graph_data(
    workspace: &Value,
    graph_id: &str,
    input: &Map<String, Value>,
) -> Result<Value, CommandError> {
    let mut data = node(workspace, graph_id)?;
    data["diagram"] = selected_graph(workspace, graph_id, input)?;
    Ok(data)
}

fn graph_summary(workspace: &Value, graph_id: &str) -> Result<Value, CommandError> {
    let mut data = node(workspace, graph_id)?;
    let graph = diagram(workspace, graph_id)?;
    data["componentCount"] = json!(graph["components"].as_array().map_or(0, Vec::len));
    data["connectionCount"] = json!(graph["connections"].as_array().map_or(0, Vec::len));
    Ok(data)
}

fn collection_changes(before: &Value, after: &Value, field: &str) -> Value {
    let previous: Vec<_> = before[field].as_array().into_iter().flatten().collect();
    let next: Vec<_> = after[field].as_array().into_iter().flatten().collect();
    let created: Vec<_> = next
        .iter()
        .filter(|item| !previous.iter().any(|old| old["id"] == item["id"]))
        .map(|item| item["id"].clone())
        .collect();
    let deleted: Vec<_> = previous
        .iter()
        .filter(|item| !next.iter().any(|new| new["id"] == item["id"]))
        .map(|item| item["id"].clone())
        .collect();
    let updated: Vec<_> = next
        .iter()
        .filter(|item| {
            previous
                .iter()
                .any(|old| old["id"] == item["id"] && old != *item)
        })
        .map(|item| item["id"].clone())
        .collect();
    json!({"created":created,"updated":updated,"deleted":deleted})
}

fn template(catalog: &Value, scenario_id: &str, template_id: &str) -> Result<Value, CommandError> {
    let scene = catalog["scenarios"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|s| s["id"] == scenario_id)
        .ok_or_else(|| invalid("画板场景不存在"))?;
    scene["components"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|t| t["id"] == template_id)
        .cloned()
        .ok_or_else(|| invalid("组件模板不属于当前场景"))
}
fn create_component(
    catalog: &Value,
    scenario_id: &str,
    input: &Map<String, Value>,
) -> Result<Value, CommandError> {
    keys(
        input,
        &[
            "id",
            "templateId",
            "type",
            "name",
            "description",
            "boundary",
            "metadata",
            "position",
            "inputs",
            "outputs",
            "ownerId",
            "exposed",
            "validation",
        ],
    )?;
    let template = template(catalog, scenario_id, required(input, "templateId")?)?;
    if input.get("type").is_some_and(|v| *v != template["type"]) {
        return Err(invalid("组件类型必须与模板一致"));
    }
    let mut metadata = Map::new();
    for field in template["fields"].as_array().into_iter().flatten() {
        metadata.insert(
            field["id"].as_str().unwrap_or_default().into(),
            field["defaultValue"].clone(),
        );
    }
    if let Some(provided) = input.get("metadata") {
        if !provided.is_object() {
            return Err(invalid("metadata 必须为对象"));
        }
        let provided = object(provided)?;
        metadata.extend(provided);
    }
    let mut component = json!({"id":id(input,"component")?,"templateId":template["id"],"type":template["type"],
        "name":template["name"],"description":template["description"],"boundary":"internal","metadata":metadata,
        "inputs":template["inputs"],"outputs":template["outputs"],"ownerId":null,"position":{"x":80,"y":80}});
    if template["type"] == "validation" {
        component["validation"] = json!({"passCondition":"all","strategy":"collectAll","rules":[]});
    }
    for (key, value) in input {
        if key != "metadata" {
            component[key] = value.clone();
        }
    }
    Ok(component)
}
fn create_connection(input: &Map<String, Value>) -> Result<Value, CommandError> {
    keys(
        input,
        &[
            "id",
            "name",
            "type",
            "sourceId",
            "targetId",
            "sourcePortId",
            "targetPortId",
            "description",
            "protocol",
            "condition",
        ],
    )?;
    required(input, "sourceId")?;
    required(input, "targetId")?;
    let mut value = json!({"id":id(input,"connection")?,"name":"连接","type":"dependency", "sourceId":"","targetId":"",
        "sourcePortId":null,"targetPortId":null,"description":"","protocol":"","condition":""});
    for (key, item) in input {
        value[key] = item.clone();
    }
    Ok(value)
}
fn reference_guard(
    workspace: &Value,
    graph_id: &str,
    component_id: Option<&str>,
    edited_graph: Option<&Value>,
) -> Result<(), CommandError> {
    for system in workspace["systems"].as_array().into_iter().flatten() {
        for content in system["contents"].as_array().into_iter().flatten() {
            // A batch may already have removed a local reference. Inspect its candidate
            // graph rather than the workspace's copy from before the batch started.
            let effective = if content["id"] == graph_id {
                edited_graph.or_else(|| content.get("diagram"))
            } else {
                content.get("diagram")
            };
            let Some(graph) = effective else {
                continue;
            };
            let mut snapshots = vec![graph];
            if let Some(baseline) = graph.get("iteration").and_then(|i| i.get("baseline")) {
                snapshots.push(baseline)
            }
            for history in graph["history"].as_array().into_iter().flatten() {
                snapshots.push(history.get("snapshot").ok_or_else(|| {
                    error(
                        "HISTORY_REQUIRED",
                        "删除前必须加载全部历史快照，以检查跨画板引用",
                    )
                })?);
            }
            for snapshot in snapshots {
                for component in snapshot["components"].as_array().into_iter().flatten() {
                    let reference = &component["reference"];
                    if reference["boardId"] == graph_id
                        && component_id.is_none_or(|id| {
                            reference["componentId"] == id
                                || reference["outputIds"]
                                    .as_array()
                                    .is_some_and(|ids| ids.iter().any(|v| v == id))
                        })
                    {
                        return Err(error(
                            "REFERENCED",
                            format!(
                                "仍被画板 {} 的组件 {} 引用，请先处理引用",
                                content["id"], component["id"]
                            ),
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}
fn apply_item(
    workspace: &Value,
    graph: &mut Value,
    graph_id: &str,
    command: &str,
    item_id: Option<&str>,
    input: &Map<String, Value>,
    catalog: &Value,
) -> Result<Option<String>, CommandError> {
    let (kind, action) = command
        .split_once('.')
        .ok_or_else(|| invalid("无效的图操作"))?;
    let collection = match kind {
        "component" => "components",
        "connection" => "connections",
        _ => return Err(invalid("不支持的图操作")),
    };
    match action {
        "create" => {
            let value = if kind == "component" {
                create_component(
                    catalog,
                    graph["scenarioId"].as_str().unwrap_or("general"),
                    input,
                )?
            } else {
                create_connection(input)?
            };
            let new_id = value["id"]
                .as_str()
                .ok_or_else(|| invalid("ID 必须为字符串"))?
                .to_owned();
            if graph[collection]
                .as_array()
                .into_iter()
                .flatten()
                .any(|v| v["id"] == new_id)
            {
                return Err(error("ALREADY_EXISTS", "组件或连接 ID 已存在"));
            }
            graph[collection]
                .as_array_mut()
                .expect("validated graph array")
                .push(value);
            Ok(Some(new_id))
        }
        "update" | "delete" => {
            let item_id = item_id.ok_or_else(|| invalid("缺少组件或连接 ID"))?;
            let index = graph[collection]
                .as_array()
                .into_iter()
                .flatten()
                .position(|v| v["id"] == item_id)
                .ok_or_else(|| error("NOT_FOUND", "组件或连接不存在"))?;
            if action == "delete" {
                keys(input, &[])?;
                if kind == "component" {
                    reference_guard(workspace, graph_id, Some(item_id), Some(graph))?;
                }
                graph[collection]
                    .as_array_mut()
                    .expect("validated graph array")
                    .remove(index);
                if kind == "component" {
                    graph["connections"]
                        .as_array_mut()
                        .expect("validated connections")
                        .retain(|v| v["sourceId"] != item_id && v["targetId"] != item_id);
                    for component in graph["components"]
                        .as_array_mut()
                        .expect("validated components")
                    {
                        if component["ownerId"] == item_id {
                            component["ownerId"] = Value::Null;
                        }
                    }
                }
            } else {
                let allowed = if kind == "component" {
                    &[
                        "name",
                        "description",
                        "boundary",
                        "metadata",
                        "position",
                        "inputs",
                        "outputs",
                        "ownerId",
                        "exposed",
                        "validation",
                    ][..]
                } else {
                    &[
                        "name",
                        "type",
                        "sourceId",
                        "targetId",
                        "sourcePortId",
                        "targetPortId",
                        "description",
                        "protocol",
                        "condition",
                    ][..]
                };
                keys(input, allowed)?;
                if kind == "component" && graph[collection][index].get("reference").is_some() {
                    return Err(error("READ_ONLY", "引用组件请通过引用编辑器更新"));
                }
                for (key, value) in input {
                    // Metadata is a field patch. Other structured values replace their field atomically.
                    if key == "metadata" {
                        if !value.is_object() {
                            return Err(invalid("metadata 必须为对象"));
                        }
                        let metadata = object(value)?;
                        if !graph[collection][index][key].is_object() {
                            graph[collection][index][key] = json!({});
                        }
                        for (field, value) in metadata {
                            graph[collection][index][key][field] = value;
                        }
                    } else {
                        graph[collection][index][key] = value.clone();
                    }
                }
                if kind == "component" {
                    let component = graph[collection][index].clone();
                    graph["connections"]
                        .as_array_mut()
                        .expect("validated connections")
                        .retain(|edge| {
                            !(edge["sourceId"] == item_id
                                && !edge["sourcePortId"].is_null()
                                && !component["outputs"].as_array().is_some_and(|ports| {
                                    ports.iter().any(|p| p["id"] == edge["sourcePortId"])
                                }))
                                && !(edge["targetId"] == item_id
                                    && !edge["targetPortId"].is_null()
                                    && !component["inputs"].as_array().is_some_and(|ports| {
                                        ports.iter().any(|p| p["id"] == edge["targetPortId"])
                                    }))
                        });
                }
            }
            Ok(Some(item_id.into()))
        }
        _ => Err(invalid("不支持的组件或连接操作")),
    }
}

fn new_content(graph_id: &str, graph: Value, now: &str) -> Value {
    json!({"id":graph_id,"createdAt":now,"updatedAt":now,"revision":0,"messages":[],
        "sections":[{"id":"overview","content":"","confirmed":false},{"id":"audience","content":"","confirmed":false},
        {"id":"features","content":"","confirmed":false},{"id":"flow","content":"","confirmed":false},{"id":"acceptance","content":"","confirmed":false}],"diagram":graph})
}
fn create_graph(
    workspace: &mut Value,
    input: &Map<String, Value>,
    catalog: &Value,
) -> Result<String, CommandError> {
    keys(
        input,
        &[
            "id",
            "name",
            "description",
            "parentId",
            "kind",
            "scenarioId",
        ],
    )?;
    let name = required(input, "name")?;
    let graph_id = id(input, "graph")?;
    if workspace["systems"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|system| {
            system["contents"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|c| c["id"] == graph_id)
        })
    {
        return Err(error(
            "ALREADY_EXISTS",
            "画板 ID 已存在（包括脱离结构的内容）",
        ));
    }
    let parent_id = string(input, "parentId")?;
    let parent = parent_id.map(|id| locate(workspace, id)).transpose()?;
    let default_scene = parent_id
        .map(|id| diagram(workspace, id))
        .transpose()?
        .and_then(|g| g["scenarioId"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "general".into());
    let scene = string(input, "scenarioId")?.unwrap_or(&default_scene);
    let scene_value = catalog["scenarios"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|s| s["id"] == scene)
        .ok_or_else(|| invalid("场景不存在"))?;
    let entry_template = scene_value["components"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|t| t["type"] == "capability")
        .ok_or_else(|| invalid("场景需要一个能力模板作为画板公开入口"))?;
    let entry = create_component(
        catalog,
        scene,
        &object(
            &json!({"id":"board-entry","templateId":entry_template["id"],"name":name,"description":input.get("description").cloned().unwrap_or(json!("")),"exposed":true}),
        )?,
    )?;
    let graph = json!({"schemaVersion":2,"scenarioId":scene,"components":[entry],"connections":[],"history":[]});
    let now = timestamp();
    let description = input.get("description").cloned().unwrap_or(json!(""));
    let content = new_content(&graph_id, graph, &now);
    if let Some((si, _, _)) = parent {
        let kind = string(input, "kind")?.unwrap_or("atomic");
        workspace["systems"][si]["architecture"]["boards"].as_array_mut().expect("validated boards").push(json!({"id":graph_id,"parentId":parent_id,"name":name,"description":description,"kind":kind}));
        workspace["systems"][si]["contents"]
            .as_array_mut()
            .expect("validated contents")
            .push(content);
    } else {
        let kind = string(input, "kind")?.unwrap_or("application");
        workspace["systems"].as_array_mut().expect("validated systems").push(json!({"architecture":{"schemaVersion":2,"id":graph_id,"name":name,"description":description,"kind":kind,"createdAt":now,"updatedAt":now,"boards":[]},"contents":[content]}));
        if workspace["activeNodeId"].is_null() {
            workspace["activeNodeId"] = json!(graph_id);
        }
    }
    Ok(graph_id)
}

pub(crate) fn execute(
    workspace: &Workspace,
    request: &GraphRequest,
) -> Result<GraphOutcome, CommandError> {
    workspace
        .validate()
        .map_err(|e| error("INVALID_WORKSPACE", e))?;
    let before = serde_json::to_value(workspace).map_err(|e| invalid(e.to_string()))?;
    let catalog = catalog(workspace);
    // A large catalog is hashed once, rather than copied into every board scope.
    let catalog_revision = hash(&catalog);
    let input = object(&request.input)?;
    let mut candidate = before.clone();
    let mut target = request.graph_id.clone();
    let mut item_id = request.item_id.clone();
    let command = request.command.as_str();
    let read = matches!(
        command,
        "graph.list"
            | "graph.get"
            | "component.list"
            | "component.get"
            | "connection.list"
            | "connection.get"
            | "catalog.list"
    );
    let write = matches!(
        command,
        "graph.create"
            | "graph.update"
            | "graph.delete"
            | "component.create"
            | "component.update"
            | "component.delete"
            | "connection.create"
            | "connection.update"
            | "connection.delete"
    );
    if !read && !write {
        return Err(error("UNKNOWN_COMMAND", format!("未知命令：{command}")));
    }
    if command != "graph.list"
        && command != "graph.create"
        && command != "catalog.list"
        && target.is_none()
    {
        return Err(invalid("缺少 graphId"));
    }
    let base_revision = if command == "graph.create" {
        if let Some(parent_id) = string(&input, "parentId")? {
            revision(&before, parent_id, &catalog_revision)?
        } else {
            workspace_revision(&before, &catalog_revision)?
        }
    } else if let Some(id) = target.as_deref() {
        revision(&before, id, &catalog_revision)?
    } else {
        workspace_revision(&before, &catalog_revision)?
    };
    if write {
        require_revision(request, &base_revision)?;
    }
    let mut data = Value::Null;
    if read {
        match command {
            "catalog.list" => {
                keys(&input, &[])?;
                data = catalog.clone();
            }
            "graph.list" => {
                keys(&input, &["systemId", "parentId", "query"])?;
                let filter_system = string(&input, "systemId")?;
                let filter_parent = string(&input, "parentId")?;
                let query = string(&input, "query")?.unwrap_or("").to_lowercase();
                let mut items = Vec::new();
                for id in graph_ids(&before) {
                    let mut item = node(&before, &id)?;
                    if filter_system.is_some_and(|id| item["systemId"] != id)
                        || filter_parent.is_some_and(|id| item["parentId"] != id)
                    {
                        continue;
                    }
                    if !query.is_empty()
                        && !format!("{} {} {}", item["id"], item["name"], item["description"])
                            .to_lowercase()
                            .contains(&query)
                    {
                        continue;
                    }
                    let graph = diagram(&before, &id)?;
                    item["componentCount"] =
                        json!(graph["components"].as_array().map_or(0, Vec::len));
                    item["connectionCount"] =
                        json!(graph["connections"].as_array().map_or(0, Vec::len));
                    item["revision"] = json!(revision(&before, &id, &catalog_revision)?);
                    items.push(item);
                }
                data = json!(items);
            }
            "graph.get" => {
                keys(&input, &["version", "historyId"])?;
                data = graph_data(&before, target.as_deref().unwrap(), &input)?;
            }
            _ => {
                keys(&input, &["version", "historyId"])?;
                let graph = selected_graph(&before, target.as_deref().unwrap(), &input)?;
                let field = if command.starts_with("component.") {
                    "components"
                } else {
                    "connections"
                };
                data = if command.ends_with(".get") {
                    let id = item_id.as_deref().ok_or_else(|| invalid("缺少 itemId"))?;
                    graph[field]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|v| v["id"] == id)
                        .cloned()
                        .ok_or_else(|| error("NOT_FOUND", "组件或连接不存在"))?
                } else {
                    graph[field].clone()
                };
            }
        }
    } else if command == "graph.create" {
        target = Some(create_graph(&mut candidate, &input, &catalog)?);
    } else {
        let graph_id = target.as_deref().unwrap();
        let (si, ni, ci) = locate(&candidate, graph_id)?;
        let mut graph = diagram(&candidate, graph_id)?;
        check_write_version(&graph, &input)?;
        match command {
            "graph.delete" => {
                keys(&input, &["version"])?;
                if candidate["systems"][si]["architecture"]["boards"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|b| b["parentId"] == graph_id)
                {
                    return Err(error("HAS_CHILDREN", "画板仍有下级，请先处理下级画板"));
                }
                reference_guard(&candidate, graph_id, None, None)?;
                if let Some(ni) = ni {
                    candidate["systems"][si]["architecture"]["boards"]
                        .as_array_mut()
                        .expect("validated boards")
                        .remove(ni);
                    if candidate["activeNodeId"] == graph_id {
                        candidate["activeNodeId"] =
                            candidate["systems"][si]["architecture"]["id"].clone();
                    }
                    // Match the architecture editor: retain detached content and immutable history.
                    data = json!({"id":graph_id,"detached":true,"contentRetained":true});
                } else {
                    candidate["systems"]
                        .as_array_mut()
                        .expect("validated systems")
                        .remove(si);
                    if candidate["activeNodeId"] == graph_id {
                        candidate["activeNodeId"] = candidate["systems"]
                            .as_array()
                            .and_then(|s| s.first())
                            .map(|s| s["architecture"]["id"].clone())
                            .unwrap_or(Value::Null);
                    }
                    data = json!({"id":graph_id,"detached":false,"contentRetained":false,"deletedSystemId":graph_id});
                }
            }
            "graph.update" => {
                keys(&input, &["name", "description", "operations", "version"])?;
                if let Some(operations) = input.get("operations") {
                    let operations = operations
                        .as_array()
                        .ok_or_else(|| invalid("operations 必须为数组"))?;
                    if operations.len() > 1000 {
                        return Err(invalid("单批最多 1000 个操作"));
                    }
                    for operation in operations {
                        let operation = object(operation)?;
                        keys(&operation, &["op", "id", "value", "changes"])?;
                        let op = required(&operation, "op")?;
                        if operation.contains_key("value") && operation.contains_key("changes") {
                            return Err(invalid("value 与 changes 不能同时提供"));
                        }
                        let changes = object(
                            operation
                                .get("value")
                                .or_else(|| operation.get("changes"))
                                .unwrap_or(&Value::Null),
                        )?;
                        apply_item(
                            &candidate,
                            &mut graph,
                            graph_id,
                            op,
                            string(&operation, "id")?,
                            &changes,
                            &catalog,
                        )?;
                    }
                }
                for key in ["name", "description"] {
                    if let Some(value) = input.get(key) {
                        if let Some(ni) = ni {
                            candidate["systems"][si]["architecture"]["boards"][ni][key] =
                                value.clone();
                        } else {
                            candidate["systems"][si]["architecture"][key] = value.clone();
                        }
                    }
                }
                candidate["systems"][si]["contents"][ci]["diagram"] = graph;
            }
            _ => {
                let mut changes = input.clone();
                changes.remove("version");
                item_id = apply_item(
                    &candidate,
                    &mut graph,
                    graph_id,
                    command,
                    item_id.as_deref(),
                    &changes,
                    &catalog,
                )?;
                candidate["systems"][si]["contents"][ci]["diagram"] = graph;
            }
        }
    }
    let parsed: Workspace =
        serde_json::from_value(candidate.clone()).map_err(|e| invalid(e.to_string()))?;
    parsed.validate().map_err(invalid)?;
    let before_revision = workspace_revision(&before, &catalog_revision)?;
    let after_revision = workspace_revision(&candidate, &catalog_revision)?;
    let would_change = write && before_revision != after_revision;
    let mut changed_board_ids = Vec::new();
    if would_change {
        let ids: BTreeSet<_> = graph_ids(&before)
            .into_iter()
            .chain(graph_ids(&candidate))
            .collect();
        for id in ids {
            if revision(&before, &id, &catalog_revision).ok()
                != revision(&candidate, &id, &catalog_revision).ok()
            {
                changed_board_ids.push(id);
            }
        }
        let now = timestamp();
        for id in &changed_board_ids {
            if let Ok((si, _, ci)) = locate(&candidate, id) {
                candidate["systems"][si]["contents"][ci]["updatedAt"] = json!(now);
                candidate["systems"][si]["architecture"]["updatedAt"] = json!(now);
            }
        }
    }
    // A write response must stay small even when the board itself is large.
    // The host receives the complete candidate workspace separately; callers can
    // explicitly graph.get when they need its full contents.
    if write && command != "graph.delete" {
        data = graph_summary(&candidate, target.as_deref().unwrap())?;
    }
    let new_revision = if let Some(id) = target.as_deref() {
        revision(&candidate, id, &catalog_revision).unwrap_or_else(|_| after_revision.clone())
    } else {
        after_revision
    };
    let changed = would_change && !request.dry_run;
    let mut result = json!({
        "command":command,"graphId":target,"itemId":item_id,"revision":if request.dry_run {&base_revision}else{&new_revision},
        "proposedRevision":new_revision,"dryRun":request.dry_run,"changed":changed,"wouldChange":would_change,"changedBoardIds":changed_board_ids,
        "summary":if would_change {"修改已通过校验"}else{"未修改工作区"},"data":data
    });
    if write {
        let id = target.as_deref().expect("write command target");
        let previous = diagram(&before, id).unwrap_or_else(|_| empty_graph());
        let next = diagram(&candidate, id).unwrap_or_else(|_| empty_graph());
        result["changes"] = json!({
            "components":collection_changes(&previous,&next,"components"),
            "connections":collection_changes(&previous,&next,"connections"),
            "metadataChanged":node(&before,id).ok()!=node(&candidate,id).ok(),
            "graphCreated":command=="graph.create",
            "graphDeleted":command=="graph.delete"
        });
    }
    let outcome_workspace =
        serde_json::from_value(candidate).map_err(|e| invalid(e.to_string()))?;
    Ok(GraphOutcome {
        workspace: outcome_workspace,
        changed,
        changed_board_ids: changed_board_ids.clone(),
        result,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Workspace {
        serde_json::from_str(include_str!("../../tests/fixtures/workspace-v2.json")).unwrap()
    }
    fn request(command: &str, graph: Option<&str>, input: Value) -> GraphRequest {
        GraphRequest {
            command: command.into(),
            graph_id: graph.map(str::to_owned),
            item_id: None,
            input,
            expected_revision: None,
            dry_run: false,
        }
    }
    fn read_revision(workspace: &Workspace, graph: &str) -> String {
        execute(workspace, &request("graph.get", Some(graph), Value::Null))
            .unwrap()
            .result["revision"]
            .as_str()
            .unwrap()
            .into()
    }
    fn write(
        workspace: &Workspace,
        command: &str,
        graph: &str,
        input: Value,
    ) -> Result<GraphOutcome, CommandError> {
        let mut request = request(command, Some(graph), input);
        request.expected_revision = Some(read_revision(workspace, graph));
        execute(workspace, &request)
    }
    #[test]
    fn creates_graph_with_template_defaults_and_requires_fresh_revision() {
        let workspace = fixture();
        let mut create = request(
            "graph.create",
            None,
            json!({"id":"new-board","name":"新画板","parentId":"sales"}),
        );
        assert_eq!(
            execute(&workspace, &create).err().unwrap().code,
            "REVISION_REQUIRED"
        );
        create.expected_revision = Some(read_revision(&workspace, "sales"));
        let outcome = execute(&workspace, &create).unwrap();
        assert!(outcome.changed);
        assert!(outcome.changed_board_ids.contains(&"new-board".into()));
        let created = execute(
            &outcome.workspace,
            &request("graph.get", Some("new-board"), Value::Null),
        )
        .unwrap();
        assert_eq!(
            created.result["data"]["diagram"]["components"][0]["id"],
            "board-entry"
        );
        assert_eq!(
            created.result["data"]["diagram"]["components"][0]["exposed"],
            true
        );
        assert_eq!(
            execute(&outcome.workspace, &create).err().unwrap().code,
            "REVISION_CONFLICT"
        );
    }
    #[test]
    fn batch_is_atomic_and_preserves_unrelated_content() {
        let workspace = fixture();
        let operations = json!({"operations":[
            {"op":"component.create","value":{"id":"a","templateId":"builtin-action","name":"开始"}},
            {"op":"component.create","value":{"id":"b","templateId":"builtin-action","name":"结束"}},
            {"op":"connection.create","value":{"id":"edge","sourceId":"a","targetId":"b"}}
        ]});
        let outcome = write(&workspace, "graph.update", "leads", operations).unwrap();
        let value = serde_json::to_value(&outcome.workspace).unwrap();
        let graph = diagram(&value, "leads").unwrap();
        assert_eq!(graph["components"].as_array().unwrap().len(), 2);
        assert_eq!(graph["connections"].as_array().unwrap().len(), 1);
        assert_eq!(
            serde_json::to_value(&workspace.systems[0].contents[0].messages).unwrap(),
            value["systems"][0]["contents"][0]["messages"]
        );
        let bad = json!({"operations":[{"op":"component.create","value":{"id":"valid","templateId":"builtin-action"}},
            {"op":"connection.create","value":{"sourceId":"valid","targetId":"missing"}}]});
        assert_eq!(
            write(&workspace, "graph.update", "leads", bad)
                .err()
                .unwrap()
                .code,
            "INVALID_INPUT"
        );
        assert!(workspace.systems[0]
            .contents
            .iter()
            .find(|c| c.id == "leads")
            .unwrap()
            .diagram
            .is_none());
    }
    #[test]
    fn dry_run_does_not_commit_and_unknown_fields_are_rejected() {
        let workspace = fixture();
        let mut update = request("graph.update", Some("leads"), json!({"name":"新名称"}));
        update.expected_revision = Some(read_revision(&workspace, "leads"));
        update.dry_run = true;
        let outcome = execute(&workspace, &update).unwrap();
        assert!(!outcome.changed);
        assert_eq!(outcome.result["wouldChange"], true);
        assert_eq!(
            read_revision(&workspace, "leads"),
            outcome.result["revision"]
        );
        update.input = json!({"history":[]});
        assert_eq!(
            execute(&workspace, &update).err().unwrap().code,
            "INVALID_INPUT"
        );
        assert_eq!(workspace.systems[0].architecture.boards[1].name, "销售线索");
    }
    #[test]
    fn component_deletion_cleans_connections_and_ownership() {
        let workspace = fixture();
        let outcome=write(&workspace,"graph.update","leads",json!({"operations":[
            {"op":"component.create","value":{"id":"parent","templateId":"builtin-action"}},
            {"op":"component.create","value":{"id":"child","templateId":"builtin-action","ownerId":"parent"}},
            {"op":"connection.create","value":{"id":"edge","sourceId":"parent","targetId":"child"}},
            {"op":"component.delete","id":"parent"}
        ]})).unwrap();
        let graph = diagram(&serde_json::to_value(outcome.workspace).unwrap(), "leads").unwrap();
        assert_eq!(graph["components"][0]["id"], "child");
        assert!(graph["components"][0]["ownerId"].is_null());
        assert!(graph["connections"].as_array().unwrap().is_empty());
    }
    #[test]
    fn deleting_graph_is_explicit_detach_and_roots_children_are_protected() {
        let workspace = fixture();
        assert_eq!(
            write(&workspace, "graph.delete", "fixture-project", Value::Null)
                .err()
                .unwrap()
                .code,
            "HAS_CHILDREN"
        );
        assert_eq!(
            write(&workspace, "graph.delete", "sales", Value::Null)
                .err()
                .unwrap()
                .code,
            "HAS_CHILDREN"
        );
        let outcome = write(&workspace, "graph.delete", "leads", Value::Null).unwrap();
        assert_eq!(outcome.result["data"]["contentRetained"], true);
        assert!(outcome.workspace.systems[0]
            .contents
            .iter()
            .any(|c| c.id == "leads"));
        assert!(!outcome.workspace.systems[0]
            .architecture
            .boards
            .iter()
            .any(|b| b.id == "leads"));
    }
    #[test]
    fn revision_ignores_selection_and_history_cache_but_checks_catalog() {
        let workspace = fixture();
        let original = read_revision(&workspace, "leads");
        let mut selected = workspace.clone();
        selected.active_node_id = Some("sales".into());
        assert_eq!(original, read_revision(&selected, "leads"));
        let catalog =
            serde_json::to_value(crate::component_catalog::ComponentCatalog::default()).unwrap();
        let mut changed = catalog.clone();
        changed["scenarios"][0]["description"] = json!("场景变化");
        selected.component_catalog = Some(serde_json::from_value(changed).unwrap());
        assert_ne!(original, read_revision(&selected, "leads"));
    }
    #[test]
    fn iteration_edits_preserve_baseline_and_history_cache_does_not_change_revision() {
        let mut value = serde_json::to_value(fixture()).unwrap();
        let baseline =
            json!({"schemaVersion":2,"scenarioId":"general","components":[],"connections":[]});
        let mut graph = empty_graph();
        graph["iteration"] = json!({"id":"iteration-1","name":"下一迭代","startedAt":"2026-10-31T00:00:00.000Z","baseline":baseline});
        graph["history"] = json!([{ "id":"history-1","name":"历史","publishedAt":"2026-10-30T00:00:00.000Z","snapshot":baseline}]);
        let (si, _, ci) = locate(&value, "leads").unwrap();
        value["systems"][si]["contents"][ci]["diagram"] = graph.clone();
        let workspace: Workspace = serde_json::from_value(value.clone()).unwrap();
        let original_revision = read_revision(&workspace, "leads");
        let history = &mut value["systems"][si]["contents"][ci]["diagram"]["history"][0];
        history.as_object_mut().unwrap().remove("snapshot");
        history["componentCount"] = json!(0);
        history["connectionCount"] = json!(0);
        history["snapshotDigest"] = json!("0000000000000000");
        let compacted: Workspace = serde_json::from_value(value).unwrap();
        assert_eq!(original_revision, read_revision(&compacted, "leads"));
        let outcome = write(
            &workspace,
            "component.create",
            "leads",
            json!({"id":"new","templateId":"builtin-action"}),
        )
        .unwrap();
        let updated = diagram(&serde_json::to_value(outcome.workspace).unwrap(), "leads").unwrap();
        assert_eq!(updated["iteration"], graph["iteration"]);
        assert_eq!(updated["history"], graph["history"]);
        assert_eq!(
            write(
                &workspace,
                "graph.update",
                "leads",
                json!({"version":"current","name":"不可修改"})
            )
            .err()
            .unwrap()
            .code,
            "READ_ONLY"
        );
    }
    #[test]
    fn graph_delete_checks_cross_board_references_and_unloaded_history() {
        let mut value = serde_json::to_value(fixture()).unwrap();
        let catalog = catalog(&fixture());
        let mut component = create_component(
            &catalog,
            "general",
            &object(&json!({"id":"reference","templateId":"builtin-capability"})).unwrap(),
        )
        .unwrap();
        component["reference"] = json!({"boardId":"leads","componentId":"entry","version":"current","outputIds":[],"definitionHash":"0000000000000000"});
        let mut graph = empty_graph();
        graph["components"] = json!([component]);
        let (si, _, ci) = locate(&value, "sales").unwrap();
        value["systems"][si]["contents"][ci]["diagram"] = graph;
        let workspace: Workspace = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(
            write(&workspace, "graph.delete", "leads", Value::Null)
                .err()
                .unwrap()
                .code,
            "REFERENCED"
        );
        value["systems"][si]["contents"][ci]["diagram"]["components"] = json!([]);
        value["systems"][si]["contents"][ci]["diagram"]["history"] = json!([{ "id":"old","name":"历史","publishedAt":"2026-10-30T00:00:00.000Z","componentCount":0,"connectionCount":0,"snapshotDigest":"0000000000000000"}]);
        let workspace: Workspace = serde_json::from_value(value).unwrap();
        assert_eq!(
            write(&workspace, "graph.delete", "leads", Value::Null)
                .err()
                .unwrap()
                .code,
            "HISTORY_REQUIRED"
        );
    }
    #[test]
    fn empty_workspace_can_create_and_delete_a_root_with_explicit_revision() {
        let workspace: Workspace =
            serde_json::from_value(json!({"schemaVersion":2,"activeNodeId":null,"systems":[]}))
                .unwrap();
        let listed = execute(&workspace, &request("graph.list", None, Value::Null)).unwrap();
        let mut create = request("graph.create", None, json!({"id":"root","name":"新系统"}));
        create.expected_revision = Some(listed.result["revision"].as_str().unwrap().into());
        let created = execute(&workspace, &create).unwrap();
        let deleted = write(&created.workspace, "graph.delete", "root", Value::Null).unwrap();
        assert!(deleted.workspace.systems.is_empty());
        assert!(deleted.workspace.active_node_id.is_none());
        assert_eq!(deleted.result["data"]["deletedSystemId"], "root");
    }
    #[test]
    fn batch_deletes_local_reference_before_its_source_using_candidate_state() {
        let workspace = fixture();
        let created = write(
            &workspace,
            "component.create",
            "leads",
            json!({"id":"source","templateId":"builtin-capability","exposed":true}),
        )
        .unwrap();
        let mut value = serde_json::to_value(created.workspace).unwrap();
        let mut reference = create_component(
            &catalog(&workspace),
            "general",
            &object(&json!({"id":"ref","templateId":"builtin-capability"})).unwrap(),
        )
        .unwrap();
        reference["reference"] = json!({"boardId":"leads","componentId":"source","version":"current","outputIds":[],"definitionHash":"0000000000000000"});
        let (si, _, ci) = locate(&value, "leads").unwrap();
        value["systems"][si]["contents"][ci]["diagram"]["components"]
            .as_array_mut()
            .unwrap()
            .push(reference);
        let workspace: Workspace = serde_json::from_value(value).unwrap();
        let mut delete = request("component.delete", Some("leads"), Value::Null);
        delete.item_id = Some("source".into());
        delete.expected_revision = Some(read_revision(&workspace, "leads"));
        assert_eq!(
            execute(&workspace, &delete).err().unwrap().code,
            "REFERENCED"
        );
        let deleted=write(&workspace,"graph.update","leads",json!({"operations":[{"op":"component.delete","id":"ref"},{"op":"component.delete","id":"source"}]})).unwrap();
        let diagram = diagram(&serde_json::to_value(deleted.workspace).unwrap(), "leads").unwrap();
        assert!(diagram["components"].as_array().unwrap().is_empty());
    }
    #[test]
    fn component_identity_and_reference_definitions_cannot_be_overwritten() {
        let workspace = fixture();
        let created = write(
            &workspace,
            "component.create",
            "leads",
            json!({"id":"entry","templateId":"builtin-capability"}),
        )
        .unwrap();
        for patch in [
            json!({"id":"other"}),
            json!({"templateId":"builtin-action"}),
            json!({"type":"action"}),
            json!({"reference":null}),
        ] {
            let mut update = request("component.update", Some("leads"), patch);
            update.item_id = Some("entry".into());
            update.expected_revision = Some(read_revision(&created.workspace, "leads"));
            assert_eq!(
                execute(&created.workspace, &update).err().unwrap().code,
                "INVALID_INPUT"
            );
        }
        let mut value = serde_json::to_value(created.workspace).unwrap();
        let (si, _, ci) = locate(&value, "leads").unwrap();
        value["systems"][si]["contents"][ci]["diagram"]["components"][0]["reference"] = json!({"boardId":"sales","componentId":"entry","version":"current","outputIds":[],"definitionHash":"0000000000000000"});
        let referenced: Workspace = serde_json::from_value(value).unwrap();
        let mut update = request(
            "component.update",
            Some("leads"),
            json!({"name":"不能覆盖"}),
        );
        update.item_id = Some("entry".into());
        update.expected_revision = Some(read_revision(&referenced, "leads"));
        assert_eq!(
            execute(&referenced, &update).err().unwrap().code,
            "READ_ONLY"
        );
    }
    #[test]
    fn explicit_graph_ids_cannot_rebind_detached_content() {
        let workspace = fixture();
        let detached = write(&workspace, "graph.delete", "leads", Value::Null).unwrap();
        let mut create = request(
            "graph.create",
            None,
            json!({"id":"leads","parentId":"sales","name":"复用ID"}),
        );
        create.expected_revision = Some(read_revision(&detached.workspace, "sales"));
        assert_eq!(
            execute(&detached.workspace, &create).err().unwrap().code,
            "ALREADY_EXISTS"
        );
    }
    #[test]
    fn partial_metadata_preserves_template_defaults_and_removed_ports_clean_edges() {
        let workspace = fixture();
        let created=write(&workspace,"graph.update","leads",json!({"operations":[
            {"op":"component.create","value":{"id":"source","templateId":"builtin-action","metadata":{"executor":"worker"}}},
            {"op":"component.create","value":{"id":"target","templateId":"builtin-action"}},
            {"op":"connection.create","value":{"id":"edge","sourceId":"source","targetId":"target","sourcePortId":"action-output-0","targetPortId":"action-input-0","type":"data"}}
        ]})).unwrap();
        let value = serde_json::to_value(&created.workspace).unwrap();
        let graph = diagram(&value, "leads").unwrap();
        assert_eq!(graph["components"][0]["metadata"]["executor"], "worker");
        assert_eq!(graph["components"][0]["metadata"]["failure"], "");
        let mut update = request("component.update", Some("leads"), json!({"outputs":[]}));
        update.item_id = Some("source".into());
        update.expected_revision = Some(read_revision(&created.workspace, "leads"));
        let updated = execute(&created.workspace, &update).unwrap();
        assert!(
            diagram(&serde_json::to_value(updated.workspace).unwrap(), "leads").unwrap()
                ["connections"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn writes_return_small_summaries_and_precise_implicit_connection_changes() {
        let workspace = fixture();
        let created = write(
            &workspace,
            "graph.update",
            "leads",
            json!({"operations":[
                {"op":"component.create","value":{"id":"a","templateId":"builtin-action"}},
                {"op":"component.create","value":{"id":"b","templateId":"builtin-action"}},
                {"op":"connection.create","value":{"id":"edge","sourceId":"a","targetId":"b"}}
            ]}),
        )
        .unwrap();
        assert!(created.result["data"].get("diagram").is_none());
        assert_eq!(created.result["data"]["componentCount"], 2);
        assert_eq!(
            created.result["changes"]["components"]["created"],
            json!(["a", "b"])
        );
        let mut delete = request("component.delete", Some("leads"), Value::Null);
        delete.item_id = Some("a".into());
        delete.expected_revision = Some(read_revision(&created.workspace, "leads"));
        let removed = execute(&created.workspace, &delete).unwrap();
        assert_eq!(
            removed.result["changes"]["components"]["deleted"],
            json!(["a"])
        );
        assert_eq!(
            removed.result["changes"]["connections"]["deleted"],
            json!(["edge"])
        );
        assert_eq!(removed.result["data"]["componentCount"], 1);
        let full = execute(
            &removed.workspace,
            &request("graph.get", Some("leads"), Value::Null),
        )
        .unwrap();
        assert!(full.result["data"]["diagram"].is_object());
    }
    #[test]
    fn revisions_are_independent_of_nested_json_and_metadata_key_order() {
        let first: Value = serde_json::from_str(
            r#"{"outer":{"a":1,"z":{"first":true,"last":false}},"items":[{"x":1,"y":2}]}"#,
        )
        .unwrap();
        let reordered: Value = serde_json::from_str(
            r#"{"items":[{"y":2,"x":1}],"outer":{"z":{"last":false,"first":true},"a":1}}"#,
        )
        .unwrap();
        assert_eq!(hash(&first), hash(&reordered));
        let created=write(&fixture(),"component.create","leads",json!({"id":"entry","templateId":"builtin-action","metadata":{"executor":"worker","failure":"retry"}})).unwrap();
        let mut first = serde_json::to_value(&created.workspace).unwrap();
        let mut reordered = first.clone();
        let (si, _, ci) = locate(&first, "leads").unwrap();
        first["systems"][si]["contents"][ci]["diagram"]["components"][0]["metadata"] =
            serde_json::from_str(r#"{"executor":"worker","failure":"retry"}"#).unwrap();
        reordered["systems"][si]["contents"][ci]["diagram"]["components"][0]["metadata"] =
            serde_json::from_str(r#"{"failure":"retry","executor":"worker"}"#).unwrap();
        let first: Workspace = serde_json::from_value(first).unwrap();
        let reordered: Workspace = serde_json::from_value(reordered).unwrap();
        assert_eq!(
            read_revision(&first, "leads"),
            read_revision(&reordered, "leads")
        );
        assert_eq!(
            execute(&first, &request("graph.list", None, Value::Null))
                .unwrap()
                .result["revision"],
            execute(&reordered, &request("graph.list", None, Value::Null))
                .unwrap()
                .result["revision"]
        );
    }
}
