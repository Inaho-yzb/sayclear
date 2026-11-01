use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub schema_version: u8,
    pub active_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component_catalog: Option<crate::component_catalog::ComponentCatalog>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_repository: Option<crate::git::GitRepository>,
    pub systems: Vec<SystemData>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SystemData {
    pub architecture: Architecture,
    pub contents: Vec<NodeContent>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Architecture {
    pub schema_version: u8,
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
    pub kind: String,
    pub boards: Vec<BoardNode>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardNode {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: String,
    pub parent_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeContent {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagram: Option<crate::diagram::Diagram>,
    pub messages: Vec<Message>,
    pub sections: Vec<Section>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub role: Role,
    pub text: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proposal: Option<Proposal>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub section_id: SectionId,
    pub content: String,
    pub status: ProposalStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProposalStatus {
    Pending,
    Accepted,
    Dismissed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Section {
    pub id: SectionId,
    pub content: String,
    pub confirmed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum SectionId {
    Overview,
    Audience,
    Features,
    Flow,
    Acceptance,
}

pub fn within_limit(text: &str, limit: usize) -> bool {
    // Match JavaScript String.length, including non-BMP characters.
    text.encode_utf16().take(limit + 1).count() <= limit
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn validate_node(id: &str, name: &str, description: &str) -> Result<(), String> {
    if !valid_id(id)
        || name.trim().is_empty()
        || name != name.trim()
        || !within_limit(name, 80)
        || !within_limit(description, 10000)
    {
        return Err("节点 ID、名称或说明无效".into());
    }
    Ok(())
}

impl Architecture {
    pub fn node_ids(&self) -> Vec<&str> {
        std::iter::once(self.id.as_str())
            .chain(self.boards.iter().map(|b| b.id.as_str()))
            .collect()
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 2
            || self.boards.len() > 2000
            || !["system", "application"].contains(&self.kind.as_str())
        {
            return Err("画板结构版本、类型或数量无效".into());
        }
        validate_node(&self.id, &self.name, &self.description)?;
        let nodes: HashMap<_, _> = self.boards.iter().map(|b| (b.id.as_str(), b)).collect();
        if nodes.len() != self.boards.len() || nodes.contains_key(self.id.as_str()) {
            return Err("架构中的节点 ID 重复".into());
        }
        let mut names = HashSet::new();
        for node in &self.boards {
            validate_node(&node.id, &node.name, &node.description)?;
            if !valid_id(&node.parent_id)
                || !["application", "aggregate", "atomic"].contains(&node.kind.as_str())
            {
                return Err("画板类型或归属无效".into());
            }
            if !names.insert((&node.parent_id, &node.name)) {
                return Err("同一层级下的名称不能重复".into());
            }
            let mut seen = HashSet::from([node.id.as_str()]);
            let mut parent_id = node.parent_id.as_str();
            let mut apps =
                usize::from(node.kind == "application") + usize::from(self.kind == "application");
            while parent_id != self.id {
                let parent = nodes.get(parent_id).ok_or("画板的归属节点不存在")?;
                if !seen.insert(parent_id) {
                    return Err("画板归属不能形成循环".into());
                }
                if parent.kind == "atomic" {
                    return Err("原子图不能包含子图".into());
                }
                if parent.kind == "application" {
                    apps += 1;
                }
                parent_id = &parent.parent_id;
            }
            if apps > 1 {
                return Err("应用边界不能嵌套".into());
            }
        }
        Ok(())
    }
}

impl NodeContent {
    pub fn validate(&self) -> Result<(), String> {
        if let Some(diagram) = &self.diagram {
            diagram.validate()?;
        }
        if !valid_id(&self.id) || self.messages.len() > 5000 {
            return Err("节点 ID 或消息数量无效".into());
        }
        let sections: HashSet<_> = self.sections.iter().map(|s| &s.id).collect();
        if self.sections.len() != 5 || sections.len() != 5 {
            return Err("文档章节缺失或重复".into());
        }
        if self
            .sections
            .iter()
            .any(|s| !within_limit(&s.content, 100_000))
            || self.messages.iter().any(|m| {
                !within_limit(&m.text, 100_000)
                    || m.proposal
                        .as_ref()
                        .is_some_and(|p| !within_limit(&p.content, 100_000))
            })
        {
            return Err("章节或消息内容超出长度限制".into());
        }
        Ok(())
    }
}

impl Workspace {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 2 {
            return Err("不支持的工作区版本".into());
        }
        if self.systems.len() > 100 {
            return Err("应用系统数量无效".into());
        }
        if let Some(repository) = &self.git_repository {
            repository.validate()?;
        }
        let catalog = self.component_catalog.clone().unwrap_or_default();
        catalog.validate()?;
        let mut nodes = HashSet::new();
        for system in &self.systems {
            system.architecture.validate()?;
            for id in system.architecture.node_ids() {
                if !nodes.insert(id) {
                    return Err("工作区中的节点 ID 重复".into());
                }
            }
            if system.contents.len() > 25000 {
                return Err("节点内容数量超限".into());
            }
            let mut content_ids = HashSet::new();
            for content in &system.contents {
                content.validate()?;
                if let Some(diagram) = &content.diagram {
                    catalog.validate_diagram(diagram)?;
                }
                if !content_ids.insert(content.id.as_str()) {
                    return Err("节点内容 ID 重复".into());
                }
            }
            if system
                .architecture
                .node_ids()
                .iter()
                .any(|id| !content_ids.contains(id))
            {
                return Err("架构节点缺少对应的需求内容".into());
            }
        }
        match &self.active_node_id {
            None if nodes.is_empty() => {}
            Some(id) if nodes.contains(id.as_str()) => {}
            _ => return Err("当前节点不存在或空工作区仍有选中节点".into()),
        }
        Ok(())
    }
    pub fn delete_system(&mut self, system_id: &str) -> Result<(), String> {
        if !self
            .systems
            .iter()
            .any(|system| system.architecture.id == system_id)
        {
            return Err("应用系统不存在".into());
        }
        self.systems
            .retain(|system| system.architecture.id != system_id);
        let active_exists = self.active_node_id.as_ref().is_some_and(|id| {
            self.systems
                .iter()
                .any(|system| system.architecture.node_ids().contains(&id.as_str()))
        });
        if !active_exists {
            self.active_node_id = self
                .systems
                .first()
                .map(|system| system.architecture.id.clone());
        }
        self.validate()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyWorkspace {
    schema_version: u8,
    active_project_id: String,
    projects: Vec<LegacyProject>,
}
#[derive(Deserialize)]
struct LegacyProject {
    name: String,
    #[serde(flatten)]
    content: NodeContent,
}

pub fn migrate_legacy(value: serde_json::Value) -> Result<Workspace, String> {
    let legacy: LegacyWorkspace = serde_json::from_value(value).map_err(|e| e.to_string())?;
    if legacy.schema_version != 1 {
        return Err("不支持的旧工作区版本".into());
    }
    let workspace = Workspace {
        schema_version: 2,
        active_node_id: Some(legacy.active_project_id),
        component_catalog: None,
        git_repository: None,
        systems: legacy
            .projects
            .into_iter()
            .map(|project| {
                let description = project
                    .content
                    .sections
                    .iter()
                    .find(|s| s.id == SectionId::Overview)
                    .map(|s| {
                        let mut length = 0;
                        s.content
                            .chars()
                            .take_while(|c| {
                                length += c.len_utf16();
                                length <= 10000
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let name = project.name.trim();
                SystemData {
                    architecture: Architecture {
                        schema_version: 2,
                        kind: "application".into(),
                        id: project.content.id.clone(),
                        name: if name.is_empty() {
                            "未命名系统".into()
                        } else {
                            name.into()
                        },
                        description,
                        created_at: project.content.created_at.clone(),
                        updated_at: project.content.updated_at.clone(),
                        boards: vec![],
                    },
                    contents: vec![project.content],
                }
            })
            .collect(),
    };
    workspace.validate()?;
    Ok(workspace)
}

#[cfg(test)]
mod composition_tests {
    use super::*;
    #[test]
    fn validates_deep_composition_and_rejects_cycles_and_nested_boundaries() {
        let mut a: Architecture = serde_json::from_value(serde_json::json!({
            "schemaVersion": 2, "id": "system", "kind": "system", "name": "业务系统",
            "description": "", "createdAt": "", "updatedAt": "", "boards": []
        }))
        .unwrap();
        for i in 0..12 {
            a.boards.push(BoardNode {
                id: format!("layer-{i}"),
                name: format!("层 {i}"),
                description: String::new(),
                kind: "aggregate".into(),
                parent_id: if i == 0 {
                    a.id.clone()
                } else {
                    format!("layer-{}", i - 1)
                },
            });
        }
        assert!(a.validate().is_ok());
        a.boards[0].parent_id = "layer-11".into();
        assert!(a.validate().unwrap_err().contains("循环"));
        a.boards[0].parent_id = "missing".into();
        assert!(a.validate().unwrap_err().contains("不存在"));
        a.boards[0].parent_id = "system".into();
        a.boards[0].kind = "atomic".into();
        assert!(a.validate().unwrap_err().contains("原子图"));
        a.boards[0].kind = "application".into();
        assert!(a.validate().is_ok());
        a.boards[1].kind = "application".into();
        assert!(a.validate().unwrap_err().contains("嵌套"));
    }
}
