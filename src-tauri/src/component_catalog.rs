use crate::diagram::{valid_component_type, Component, Diagram, Port};
use crate::model::{valid_id, within_limit};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComponentCatalog {
    scenarios: Vec<Scenario>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Scenario {
    id: String,
    name: String,
    description: String,
    components: Vec<Template>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Template {
    id: String,
    name: String,
    r#type: String,
    description: String,
    inputs: Vec<Port>,
    outputs: Vec<Port>,
    fields: Vec<Field>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Field {
    id: String,
    name: String,
    r#type: String,
    required: bool,
    default_value: String,
}
fn valid_name(value: &str) -> bool {
    !value.trim().is_empty() && value == value.trim() && within_limit(value, 80)
}
fn valid_value(field: &Field, value: &str, required: bool) -> bool {
    if !within_limit(value, 10000) {
        return false;
    }
    if value.trim().is_empty() {
        return !required;
    }
    match field.r#type.as_str() {
        "text" => true,
        "boolean" => ["true", "false"].contains(&value),
        "number" => value.trim().parse::<f64>().is_ok_and(|n| n.is_finite()),
        _ => false,
    }
}
impl Default for ComponentCatalog {
    fn default() -> Self {
        serde_json::from_str(include_str!(
            "../../src/shared/default-component-catalog.json"
        ))
        .expect("bundled component catalog must be valid")
    }
}
impl ComponentCatalog {
    pub fn validate(&self) -> Result<(), String> {
        if self.scenarios.is_empty()
            || self.scenarios.len() > 50
            || !self.scenarios.iter().any(|s| s.id == "general")
        {
            return Err("场景数量无效或缺少默认场景".into());
        }
        let mut scene_ids = HashSet::new();
        let mut scene_names = HashSet::new();
        let mut template_ids = HashSet::new();
        for scene in &self.scenarios {
            if !valid_id(&scene.id)
                || !valid_name(&scene.name)
                || !within_limit(&scene.description, 10000)
                || scene.components.len() > 100
                || !scene_ids.insert(&scene.id)
                || !scene_names.insert(&scene.name)
            {
                return Err("场景字段无效或名称、ID 重复".into());
            }
            let mut names = HashSet::new();
            for template in &scene.components {
                if !valid_id(&template.id)
                    || !valid_name(&template.name)
                    || !within_limit(&template.description, 10000)
                    || !valid_component_type(&template.r#type)
                    || !template_ids.insert(&template.id)
                    || !names.insert(&template.name)
                    || template.inputs.len() > 32
                    || template.outputs.len() > 32
                    || template.fields.len() > 32
                {
                    return Err("组件模板字段无效或名称、ID 重复".into());
                }
                let mut ports = HashSet::new();
                for port in template.inputs.iter().chain(&template.outputs) {
                    if !valid_id(&port.id)
                        || !valid_name(&port.name)
                        || !within_limit(&port.data_type, 120)
                        || !within_limit(&port.description, 10000)
                        || !ports.insert(&port.id)
                    {
                        return Err("模板端口字段无效或 ID 重复".into());
                    }
                }
                let mut fields = HashSet::new();
                let mut field_names = HashSet::new();
                for field in &template.fields {
                    if !valid_id(&field.id)
                        || !valid_name(&field.name)
                        || !["text", "number", "boolean"].contains(&field.r#type.as_str())
                        || !fields.insert(&field.id)
                        || !field_names.insert(&field.name)
                        || !valid_value(field, &field.default_value, false)
                    {
                        return Err("组件属性无效、重复或默认值类型不匹配".into());
                    }
                }
            }
        }
        Ok(())
    }
    pub fn validate_diagram(&self, diagram: &Diagram) -> Result<(), String> {
        self.validate_snapshot(&diagram.scenario_id, &diagram.components)?;
        if let Some(iteration) = &diagram.iteration {
            self.validate_snapshot(
                &iteration.baseline.scenario_id,
                &iteration.baseline.components,
            )?;
        }
        for version in &diagram.history {
            if let Some(snapshot) = &version.snapshot {
                self.validate_snapshot(&snapshot.scenario_id, &snapshot.components)?;
            }
        }
        Ok(())
    }
    pub(crate) fn validate_snapshot(
        &self,
        scenario_id: &str,
        components: &[Component],
    ) -> Result<(), String> {
        let scene = self
            .scenarios
            .iter()
            .find(|s| s.id == scenario_id)
            .ok_or("画板场景不存在")?;
        for component in components {
            let templates: Vec<_> = if component.reference.is_some() {
                self.scenarios.iter().flat_map(|s| &s.components).collect()
            } else {
                scene.components.iter().collect()
            };
            let template = templates
                .into_iter()
                .find(|t| t.id == component.template_id)
                .filter(|t| t.r#type == component.r#type)
                .ok_or("组件不属于当前画板场景或类型不匹配")?;
            if component.metadata.as_ref().is_some_and(|values| {
                values
                    .keys()
                    .any(|key| !template.fields.iter().any(|f| &f.id == key))
            }) {
                return Err("组件包含未定义的属性".into());
            }
            for field in &template.fields {
                let value = component
                    .metadata
                    .as_ref()
                    .and_then(|values| values.get(&field.id))
                    .unwrap_or(&field.default_value);
                if !valid_value(field, value, field.required) {
                    return Err(format!(
                        "组件「{}」的属性「{}」缺失或类型不匹配",
                        component.name, field.name
                    ));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Workspace;
    use crate::storage::WorkspaceStore;

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tests/fixtures/component-catalog.json")).unwrap()
    }
    #[test]
    fn validates_shared_catalog_and_rejects_bypass_and_bad_metadata() {
        let value = fixture();
        let catalog: ComponentCatalog = serde_json::from_value(value["catalog"].clone()).unwrap();
        catalog.validate().unwrap();
        ComponentCatalog::default().validate().unwrap();
        let diagram: Diagram = serde_json::from_value(value["diagram"].clone()).unwrap();
        diagram.validate().unwrap();
        catalog.validate_diagram(&diagram).unwrap();
        for (path, invalid) in [
            ("/scenarioId", "general"),
            ("/components/0/templateId", "builtin-action"),
            ("/components/0/type", "store"),
            ("/components/0/metadata/assignee", ""),
            ("/components/0/metadata/timeout", "NaN"),
            ("/components/0/metadata/retry", "yes"),
        ] {
            let mut v = value["diagram"].clone();
            *v.pointer_mut(path).unwrap() = invalid.into();
            let graph: Diagram = serde_json::from_value(v).unwrap();
            assert!(catalog.validate_diagram(&graph).is_err(), "{path}");
        }
        let mut v = value["diagram"].clone();
        v["components"][0]["metadata"]["extra"] = "unregistered".into();
        assert!(catalog
            .validate_diagram(&serde_json::from_value(v).unwrap())
            .is_err());
        let mut bad = catalog.clone();
        bad.scenarios[1].components[0].fields[1].default_value = "abc".into();
        assert!(bad.validate().is_err());
        bad = catalog.clone();
        bad.scenarios[1].name = bad.scenarios[0].name.clone();
        assert!(bad.validate().is_err());
    }

    #[test]
    fn catalog_and_metadata_survive_disk_restart_and_conflict_checks() {
        let value = fixture();
        let mut workspace: Workspace =
            serde_json::from_str(include_str!("../../tests/fixtures/workspace-v2.json")).unwrap();
        workspace.component_catalog =
            Some(serde_json::from_value(value["catalog"].clone()).unwrap());
        workspace.systems[0].contents[0].diagram =
            Some(serde_json::from_value(value["diagram"].clone()).unwrap());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let store = WorkspaceStore::new(path.clone(), None);
        store.save(&workspace).unwrap();
        let restored = WorkspaceStore::new(path.clone(), None)
            .load()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(&restored).unwrap(),
            serde_json::to_value(&workspace).unwrap()
        );
        let mut invalid = restored.clone();
        invalid.component_catalog.as_mut().unwrap().scenarios.pop();
        assert!(invalid.validate().is_err());
        assert!(store.save(&invalid).is_err());
        // Catalog edits are part of the observed index and cannot be overwritten externally.
        let mut index: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        index["componentCatalog"]["scenarios"][1]["description"] = "external".into();
        std::fs::write(&path, serde_json::to_vec(&index).unwrap()).unwrap();
        assert!(store.save(&workspace).is_err());
    }
}
