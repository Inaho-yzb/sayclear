use crate::model::{valid_id, within_limit};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Diagram {
    pub(crate) schema_version: u8,
    pub(crate) scenario_id: String,
    pub(crate) components: Vec<Component>,
    pub(crate) connections: Vec<Connection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) iteration: Option<Iteration>,
    pub(crate) history: Vec<HistoricalVersion>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GraphSnapshot {
    pub(crate) schema_version: u8,
    pub(crate) scenario_id: String,
    pub(crate) components: Vec<Component>,
    pub(crate) connections: Vec<Connection>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Iteration {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) started_at: String,
    pub(crate) baseline: GraphSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) git: Option<crate::git::GitIteration>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HistoricalVersion {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) published_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) git: Option<crate::git::GitIteration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) snapshot: Option<GraphSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) component_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) connection_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) snapshot_digest: Option<String>,
}
pub(crate) fn valid_component_type(value: &str) -> bool {
    [
        "actor",
        "capability",
        "ui",
        "action",
        "rule",
        "validation",
        "data",
        "state",
        "event",
        "api",
        "service",
        "store",
    ]
    .contains(&value)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Port {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) data_type: String,
    pub(crate) description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Position {
    x: f64,
    y: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Component {
    id: String,
    pub(crate) r#type: String,
    pub(crate) template_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) exposed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reference: Option<DiagramReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) metadata: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    validation: Option<Validation>,
    boundary: String,
    pub(crate) name: String,
    description: String,
    inputs: Vec<Port>,
    outputs: Vec<Port>,
    owner_id: Option<String>,
    position: Position,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Validation {
    pass_condition: String,
    strategy: String,
    rules: Vec<ValidationRule>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ValidationRule {
    id: String,
    name: String,
    condition: String,
    when: String,
    failure_message: String,
}
impl Validation {
    fn valid(&self) -> bool {
        let mut ids = HashSet::new();
        ["all", "any"].contains(&self.pass_condition.as_str())
            && ["collectAll", "stopWhenDecided"].contains(&self.strategy.as_str())
            && self.rules.len() <= 32
            && self.rules.iter().all(|r| {
                valid_id(&r.id)
                    && ids.insert(&r.id)
                    && valid_name(&r.name)
                    && !r.condition.trim().is_empty()
                    && r.condition == r.condition.trim()
                    && within_limit(&r.condition, 1000)
                    && within_limit(&r.when, 1000)
                    && within_limit(&r.failure_message, 1000)
            })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DiagramReference {
    board_id: String,
    component_id: String,
    version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    iteration_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    history_id: Option<String>,
    output_ids: Vec<String>,
    definition_hash: String,
}
impl DiagramReference {
    fn valid(&self) -> bool {
        valid_id(&self.board_id)
            && valid_id(&self.component_id)
            && ["current", "iteration", "history"].contains(&self.version.as_str())
            && (self.version == "iteration") == self.iteration_id.is_some()
            && (self.version == "history") == self.history_id.is_some()
            && self.history_id.as_ref().is_none_or(|id| valid_id(id))
            && self.iteration_id.as_ref().is_none_or(|id| valid_id(id))
            && self.output_ids.len() <= 32
            && self
                .output_ids
                .iter()
                .all(|id| valid_id(id) && id != &self.component_id)
            && self.output_ids.iter().collect::<HashSet<_>>().len() == self.output_ids.len()
            && self.definition_hash.len() == 16
            && self
                .definition_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Connection {
    id: String,
    name: String,
    r#type: String,
    source_id: String,
    target_id: String,
    source_port_id: Option<String>,
    target_port_id: Option<String>,
    description: String,
    protocol: String,
    condition: String,
}

fn valid_name(name: &str) -> bool {
    !name.trim().is_empty() && name == name.trim() && within_limit(name, 80)
}

impl GraphSnapshot {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_graph(
            self.schema_version,
            &self.scenario_id,
            &self.components,
            &self.connections,
        )
    }
}
impl Diagram {
    pub(crate) fn snapshot(&self) -> GraphSnapshot {
        GraphSnapshot {
            schema_version: self.schema_version,
            scenario_id: self.scenario_id.clone(),
            components: self.components.clone(),
            connections: self.connections.clone(),
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        validate_graph(
            self.schema_version,
            &self.scenario_id,
            &self.components,
            &self.connections,
        )?;
        if let Some(iteration) = &self.iteration {
            if !valid_id(&iteration.id)
                || !valid_name(&iteration.name)
                || !valid_timestamp(&iteration.started_at)
                || iteration.baseline.scenario_id != self.scenario_id
            {
                return Err("迭代字段无效或现状场景不一致".into());
            }
            iteration.baseline.validate()?;
            if let Some(binding) = &iteration.git {
                binding.validate()?;
            }
        }
        if self.history.len() > 50 {
            return Err("最多保留 50 个历史现状".into());
        }
        let mut ids = HashSet::new();
        for version in &self.history {
            if !valid_id(&version.id)
                || !ids.insert(&version.id)
                || !valid_name(&version.name)
                || !valid_timestamp(&version.published_at)
                || version
                    .snapshot
                    .as_ref()
                    .is_some_and(|snapshot| snapshot.scenario_id != self.scenario_id)
                || (version.snapshot.is_none()
                    && (version.component_count.is_none()
                        || version.connection_count.is_none()
                        || version.snapshot_digest.is_none()))
                || version.component_count.is_some_and(|count| count > 300)
                || version.connection_count.is_some_and(|count| count > 1200)
                || version.snapshot_digest.as_ref().is_some_and(|hash| {
                    hash.len() != 16 || !hash.bytes().all(|b| b.is_ascii_hexdigit())
                })
            {
                return Err("历史现状字段无效或场景不一致".into());
            }
            if let Some(binding) = &version.git {
                binding.validate()?;
            }
            if let Some(snapshot) = &version.snapshot {
                snapshot.validate()?;
            }
        }
        Ok(())
    }
}
fn valid_timestamp(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok() && value.ends_with('Z')
}
fn validate_graph(
    schema_version: u8,
    scenario_id: &str,
    components: &[Component],
    connections: &[Connection],
) -> Result<(), String> {
    if schema_version != 2 || components.len() > 300 || connections.len() > 1200 {
        return Err("系统图版本或数量限制无效".into());
    }
    if !valid_id(scenario_id) {
        return Err("场景 ID 无效".into());
    }
    let component_map: HashMap<_, _> = components.iter().map(|c| (c.id.as_str(), c)).collect();
    if component_map.len() != components.len() {
        return Err("组件 ID 不能重复".into());
    }
    for c in components {
        if (c.r#type == "validation") != c.validation.is_some()
            || c.validation.as_ref().is_some_and(|v| !v.valid())
        {
            return Err("校验组件的规则或策略无效".into());
        }
        if c.reference
            .as_ref()
            .is_some_and(|r| !r.valid() || c.exposed == Some(true))
            || !valid_id(&c.template_id)
            || c.metadata.as_ref().is_some_and(|values| {
                values.len() > 32
                    || values
                        .iter()
                        .any(|(key, value)| !valid_id(key) || !within_limit(value, 10000))
            })
            || !valid_id(&c.id)
            || !valid_name(&c.name)
            || !within_limit(&c.description, 10000)
            || !["internal", "external"].contains(&c.boundary.as_str())
            || !valid_component_type(&c.r#type)
            || c.inputs.len() > 32
            || c.outputs.len() > 32
            || !c.position.x.is_finite()
            || !c.position.y.is_finite()
            || c.position.x.abs() > 100000.0
            || c.position.y.abs() > 100000.0
        {
            return Err("组件字段无效".into());
        }
        let mut ports = HashSet::new();
        for port in c.inputs.iter().chain(&c.outputs) {
            if !valid_id(&port.id)
                || !valid_name(&port.name)
                || !within_limit(&port.data_type, 120)
                || !within_limit(&port.description, 10000)
                || !ports.insert(&port.id)
            {
                return Err("端口字段无效或 ID 重复".into());
            }
        }
        let mut visited = HashSet::from([c.id.as_str()]);
        let mut owner = c.owner_id.as_deref();
        while let Some(id) = owner {
            if !visited.insert(id) {
                return Err("组件归属不能形成循环".into());
            }
            owner = component_map
                .get(id)
                .ok_or("归属组件不存在")?
                .owner_id
                .as_deref();
        }
    }
    let mut ids = HashSet::new();
    let mut signatures = HashSet::new();
    for edge in connections {
        if !valid_id(&edge.id)
            || !ids.insert(&edge.id)
            || !valid_name(&edge.name)
            || !within_limit(&edge.description, 10000)
            || !within_limit(&edge.protocol, 120)
            || !within_limit(&edge.condition, 1000)
            || ![
                "data",
                "control",
                "dependency",
                "event",
                "contains",
                "calls",
                "implements",
                "reads",
                "writes",
                "constrains",
                "transitions",
            ]
            .contains(&edge.r#type.as_str())
        {
            return Err("连接字段无效或 ID 重复".into());
        }
        let source = component_map
            .get(edge.source_id.as_str())
            .ok_or("连接起点不存在")?;
        let target = component_map
            .get(edge.target_id.as_str())
            .ok_or("连接终点不存在")?;
        if edge.source_id == edge.target_id {
            return Err("请连接两个不同组件".into());
        }
        if edge
            .source_port_id
            .as_ref()
            .is_some_and(|id| !source.outputs.iter().any(|p| &p.id == id))
            || edge
                .target_port_id
                .as_ref()
                .is_some_and(|id| !target.inputs.iter().any(|p| &p.id == id))
        {
            return Err("连接端口不存在或方向错误".into());
        }
        if edge.r#type == "data" && (edge.source_port_id.is_none() || edge.target_port_id.is_none())
        {
            return Err("数据流需要指定输入和输出端口".into());
        }
        if !signatures.insert((
            &edge.r#type,
            &edge.source_id,
            &edge.source_port_id,
            &edge.target_id,
            &edge.target_port_id,
        )) {
            return Err("相同类型和端点的连接已存在".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tests/fixtures/diagram-v2.json")).unwrap()
    }
    fn valid(value: serde_json::Value) -> bool {
        serde_json::from_value::<Diagram>(value).is_ok_and(|d| d.validate().is_ok())
    }
    #[test]
    fn validates_rules_and_preserves_validation_across_disk_restart() {
        use crate::{
            component_catalog::ComponentCatalog, model::Workspace, storage::WorkspaceStore,
        };
        let sample: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/validation-v2.json")).unwrap();
        let diagram: Diagram = serde_json::from_value(sample.clone()).unwrap();
        diagram.validate().unwrap();
        ComponentCatalog::default()
            .validate_diagram(&diagram)
            .unwrap();
        let expected = serde_json::to_value(&diagram).unwrap();
        let mut workspace: Workspace =
            serde_json::from_str(include_str!("../../tests/fixtures/workspace-v2.json")).unwrap();
        workspace.systems[0].contents[0].diagram = Some(diagram);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let store = WorkspaceStore::new(path.clone(), None);
        store.save(&workspace).unwrap();
        let restored = WorkspaceStore::new(path, None).load().unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(restored.systems[0].contents[0].diagram.as_ref().unwrap())
                .unwrap(),
            expected
        );
        for (path, value) in [
            (
                "/components/0/validation/passCondition",
                serde_json::json!("custom"),
            ),
            (
                "/components/0/validation/strategy",
                serde_json::json!("parallel"),
            ),
            (
                "/components/0/validation/rules/0/condition",
                serde_json::json!("  "),
            ),
            (
                "/components/0/validation/rules/1/id",
                serde_json::json!("email-format"),
            ),
            ("/components/0/type", serde_json::json!("rule")),
            ("/components/0/validation", serde_json::Value::Null),
        ] {
            let mut invalid = sample.clone();
            *invalid.pointer_mut(path).unwrap() = value;
            assert!(!valid(invalid), "{path}");
        }
        let mut invalid = sample.clone();
        invalid["components"][0]["validation"]["rules"] = serde_json::json!((0..33)
            .map(|i| {
                let mut rule = sample["components"][0]["validation"]["rules"][0].clone();
                rule["id"] = format!("r-{i}").into();
                rule
            })
            .collect::<Vec<_>>());
        assert!(!valid(invalid));
        let mut baseline = sample.clone();
        baseline.as_object_mut().unwrap().remove("history");
        baseline["components"][0]["validation"]["rules"][0]["condition"] = "".into();
        let mut invalid = sample.clone();
        invalid["iteration"] = serde_json::json!({"id":"edit", "name":"变更", "startedAt":"2026-10-31T00:00:00.000Z", "baseline":baseline});
        assert!(!valid(invalid));
        let mut invalid = sample;
        invalid["history"] = serde_json::json!([{"id":"old", "name":"历史", "publishedAt":"2026-10-31T00:00:00.000Z", "snapshot":baseline}]);
        assert!(!valid(invalid));
    }
    #[test]
    fn accepts_shared_fixture_and_rejects_dangling_ports_and_cycles() {
        assert!(valid(fixture()));
        let mut v = fixture();
        v["connections"][0]["targetPortId"] = "missing".into();
        assert!(!valid(v));
        let mut v = fixture();
        v["components"][0]["ownerId"] = "store".into();
        v["components"][1]["ownerId"] = "form".into();
        assert!(!valid(v));
        let mut v = fixture();
        v["connections"][0]["sourceId"] = "missing".into();
        assert!(!valid(v));
        let mut v = fixture();
        v["connections"][0]["sourcePortId"] = serde_json::Value::Null;
        assert!(!valid(v));
    }

    #[test]
    fn validates_cross_board_references_and_preserves_broken_source_snapshots() {
        let sample: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/reference-v2.json")).unwrap();
        assert!(valid(sample.clone()));
        let diagram: Diagram = serde_json::from_value(sample.clone()).unwrap();
        let encoded = serde_json::to_value(diagram).unwrap();
        assert_eq!(
            encoded["components"][0]["reference"],
            sample["components"][0]["reference"]
        );
        assert_eq!(
            encoded["iteration"]["baseline"]["components"][0]["reference"],
            sample["iteration"]["baseline"]["components"][0]["reference"]
        );
        assert!(valid(encoded));
        for (key, value) in [
            ("version", serde_json::json!("history")),
            ("iterationId", serde_json::Value::Null),
            ("outputIds", serde_json::json!(["registered", "registered"])),
            ("definitionHash", serde_json::json!("bad")),
            ("boardId", serde_json::json!("../escape")),
        ] {
            let mut invalid = sample.clone();
            invalid["components"][0]["reference"][key] = value;
            assert!(!valid(invalid));
        }
        let mut invalid = sample.clone();
        invalid["components"][0]["exposed"] = true.into();
        assert!(!valid(invalid));
        let mut missing = sample;
        missing["components"][0]["reference"]["boardId"] = "deleted-source".into();
        assert!(valid(missing));
    }

    #[test]
    fn validates_pinned_historical_reference_contract() {
        let mut sample: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/reference-v2.json")).unwrap();
        let reference = &mut sample["components"][0]["reference"];
        reference["version"] = "history".into();
        reference.as_object_mut().unwrap().remove("iterationId");
        reference["historyId"] = "release-before-change".into();
        assert!(valid(sample.clone()));
        sample["components"][0]["reference"]["version"] = "current".into();
        assert!(!valid(sample));
    }

    #[test]
    fn validates_iteration_baseline_history_and_new_types() {
        let sample: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/iteration-v2.json")).unwrap();
        assert!(valid(sample.clone()));
        let mut invalid = sample.clone();
        invalid["iteration"]["baseline"]["connections"][0]["targetId"] = "missing".into();
        assert!(!valid(invalid));
        let mut invalid = sample.clone();
        invalid["iteration"]["baseline"]["components"][0]["type"] = "custom".into();
        assert!(!valid(invalid));
        let mut published = sample.clone();
        published.as_object_mut().unwrap().remove("iteration");
        published["history"] = serde_json::json!([{
            "id": "first-release", "name": "第一次迭代前", "publishedAt": "2026-10-31T10:00:00.000Z",
            "snapshot": sample["iteration"]["baseline"]
        }]);
        assert!(valid(published.clone()));
        published["history"][0]["snapshot"]["scenarioId"] = "another".into();
        assert!(!valid(published));
    }
}
