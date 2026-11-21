//! Read-only, conservative project linting; warnings are not validation errors.
use anyhow::{Result, ensure};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Advisory thresholds, not official upload limits.
pub const LARGE_RESOURCE_BYTES: u64 = 5 * 1024 * 1024;
pub const LARGE_IMAGE_DIMENSION: u64 = 4096;

/// A location in the original document, never in a converted workspace.
#[derive(Debug, Clone, Serialize)]
pub struct Location {
    /// RFC 6901 JSON Pointer.
    pub path: String,
    pub owner_kind: Option<String>,
    pub owner_id: Option<String>,
    pub owner_name: Option<String>,
    pub block_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Diagnostic {
    pub severity: &'static str,
    pub code: &'static str,
    pub message: String,
    pub suggestion: &'static str,
    pub location: Location,
}

impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "警告 [{}] {}", self.code, self.message)?;
        if let Some(name) = &self.location.owner_name {
            write!(f, "（{}）", name)?;
        }
        if let Some(id) = &self.location.block_id {
            write!(f, "，积木 {id}")?;
        }
        write!(f, "\n  建议：{}", self.suggestion)
    }
}

#[derive(Debug, Serialize)]
pub struct LintReport {
    pub format: &'static str,
    pub diagnostics: Vec<Diagnostic>,
}

fn pointer(parent: &str, key: &str) -> String {
    format!("{parent}/{}", key.replace('~', "~0").replace('/', "~1"))
}

fn location(path: String) -> Location {
    Location {
        path,
        owner_kind: None,
        owner_id: None,
        owner_name: None,
        block_id: None,
    }
}

fn warn(
    out: &mut Vec<Diagnostic>,
    code: &'static str,
    message: String,
    suggestion: &'static str,
    location: Location,
) {
    out.push(Diagnostic {
        severity: "warning",
        code,
        message,
        suggestion,
        location,
    });
}

struct Block<'a> {
    value: &'a Value,
    message: Option<&'a Value>,
    // Nested KN paths are relative to this parent in the collected block list.
    // Materializing every full path would use quadratic memory for next chains.
    parent: Option<usize>,
    location: Location,
    root: bool,
    disabled: bool,
}

fn block_location(blocks: &[Block<'_>], index: usize) -> Location {
    let mut location = blocks[index].location.clone();
    let mut parts = Vec::new();
    let mut current = Some(index);
    while let Some(index) = current {
        parts.push(blocks[index].location.path.as_str());
        current = blocks[index].parent;
    }
    location.path = parts.into_iter().rev().collect();
    location
}

/// Inspect original KN and native K4 data without compiling or fetching assets.
pub fn build_report(project: &Value) -> Result<LintReport> {
    ensure!(project.is_object(), "作品顶层必须是 JSON 对象");
    let k4 = crate::kitten4::is_kitten4(project);
    ensure!(
        k4 || (project
            .pointer("/scenes/scenesDict")
            .is_some_and(Value::is_object)
            && project
                .pointer("/actors/actorsDict")
                .is_some_and(Value::is_object)),
        "lint 需要 Kitten N 或 Kitten 4 作品（缺少场景或角色字典）"
    );
    if !k4 {
        crate::bcmkn::check_containers(project)?;
    } else {
        for path in ["/theatre/scenes", "/theatre/actors"] {
            ensure!(
                project.pointer(path).is_some_and(Value::is_object),
                "作品缺少对象 {path}"
            );
        }
    }
    let blocks = collect_blocks(project, k4)?;
    let mut diagnostics = Vec::new();
    lint_variables(project, k4, &blocks, &mut diagnostics);
    lint_scripts(&blocks, &mut diagnostics);
    lint_broadcasts(&blocks, &mut diagnostics);
    lint_resources(project, k4, &mut diagnostics);
    Ok(LintReport {
        format: if k4 { "kitten4" } else { "kitten-n" },
        diagnostics,
    })
}

fn collect_blocks(project: &Value, k4: bool) -> Result<Vec<Block<'_>>> {
    let owners: &[(&str, &str)] = if k4 {
        &[("/theatre/scenes", "scene"), ("/theatre/actors", "actor")]
    } else {
        &[
            ("/scenes/scenesDict", "scene"),
            ("/actors/actorsDict", "actor"),
            ("/procedures/proceduresDict", "procedure"),
        ]
    };
    let mut out = Vec::new();
    for &(dict_path, kind) in owners {
        for (id, owner) in project
            .pointer(dict_path)
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            let mut owner_location = location(pointer(dict_path, id));
            owner_location.owner_kind = Some(kind.into());
            owner_location.owner_id = Some(id.clone());
            owner_location.owner_name = Some(owner["name"].as_str().unwrap_or(id).into());
            if k4 {
                ensure!(
                    owner
                        .pointer("/block_data_json/blocks")
                        .is_some_and(Value::is_object)
                        && owner
                            .pointer("/block_data_json/connections")
                            .is_some_and(Value::is_object),
                    "{} 缺少 block_data_json 工作区；lint 需要带原始积木的作品，不支持仅含发布 AST 的作品",
                    owner_location.path
                );
                let incoming: BTreeSet<&str> = owner
                    .pointer("/block_data_json/connections")
                    .and_then(Value::as_object)
                    .into_iter()
                    .flat_map(|m| m.values())
                    .filter_map(Value::as_object)
                    .flat_map(|m| m.keys().map(String::as_str))
                    .collect();
                // Disabling a block suppresses its inputs and their full chains,
                // but not the disabled block's own following sibling.
                let mut disabled = BTreeSet::new();
                let mut pending: Vec<(&str, bool)> = owner
                    .pointer("/block_data_json/blocks")
                    .and_then(Value::as_object)
                    .into_iter()
                    .flatten()
                    .filter(|(_, b)| b["disabled"] == true)
                    .map(|(id, _)| (id.as_str(), false))
                    .collect();
                let mut visited = BTreeSet::new();
                while let Some((id, inherited)) = pending.pop() {
                    if !visited.insert((id, inherited)) {
                        continue;
                    }
                    disabled.insert(id);
                    for (child, edge) in owner
                        .pointer("/block_data_json/connections")
                        .and_then(|c| c.get(id))
                        .and_then(Value::as_object)
                        .into_iter()
                        .flatten()
                    {
                        if inherited || edge["type"] == "input" {
                            pending.push((child, true));
                        }
                    }
                }
                for (id, block) in owner
                    .pointer("/block_data_json/blocks")
                    .and_then(Value::as_object)
                    .into_iter()
                    .flatten()
                {
                    let mut loc = owner_location.clone();
                    loc.path = pointer(&format!("{}/block_data_json/blocks", loc.path), id);
                    loc.block_id = Some(id.clone());
                    let message = owner
                        .pointer("/block_data_json/connections")
                        .and_then(|c| c.get(id))
                        .and_then(Value::as_object)
                        .into_iter()
                        .flatten()
                        .find(|(_, edge)| {
                            edge["type"] == "input"
                                && edge["input_name"] == "message"
                                && edge["input_type"] == "value"
                        })
                        .and_then(|(child, _)| {
                            owner
                                .pointer("/block_data_json/blocks")
                                .and_then(|b| b.get(child))
                        });
                    out.push(Block {
                        value: block,
                        message,
                        parent: None,
                        location: loc,
                        root: !incoming.contains(id.as_str())
                            && block["parent_id"].as_str().is_none(),
                        disabled: disabled.contains(id.as_str()),
                    });
                }
            } else {
                let mut pending = Vec::new();
                for (index, block) in owner["nekoBlockJsonList"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                    .iter()
                    .enumerate()
                    .rev()
                {
                    pending.push((
                        block,
                        format!("{}/nekoBlockJsonList/{index}", owner_location.path),
                        kind != "procedure",
                        false,
                        None,
                    ));
                }
                while let Some((block, path, root, inherited_disabled, parent)) = pending.pop() {
                    if !block.is_object() {
                        continue;
                    }
                    let disabled = inherited_disabled || block["disabled"] == true;
                    let mut loc = owner_location.clone();
                    loc.path = path.clone();
                    loc.block_id = block["id"].as_str().map(str::to_owned);
                    let index = out.len();
                    out.push(Block {
                        value: block,
                        message: block.pointer("/inputs/message"),
                        parent,
                        location: loc,
                        root,
                        disabled,
                    });
                    for container in ["statements", "inputs"] {
                        for (key, child) in block[container]
                            .as_object()
                            .into_iter()
                            .flat_map(|m| m.iter().rev())
                        {
                            pending.push((
                                child,
                                pointer(&format!("/{container}"), key),
                                false,
                                disabled,
                                Some(index),
                            ));
                        }
                    }
                    if let Some(next) = block.get("next") {
                        pending.push((
                            next,
                            "/next".into(),
                            false,
                            inherited_disabled,
                            Some(index),
                        ));
                    }
                }
            }
        }
    }
    Ok(out)
}

fn lint_variables(project: &Value, k4: bool, blocks: &[Block<'_>], out: &mut Vec<Diagnostic>) {
    let path = if k4 {
        "/variables"
    } else {
        "/variables/variablesDict"
    };
    // Count reads, writes and monitor references alike, including detached code.
    // Unknown extension fields can refer to IDs too; prefer missed advice to a false warning.
    let references: BTreeSet<&str> = blocks
        .iter()
        .flat_map(|b| {
            b.value["fields"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.values())
        })
        .filter_map(Value::as_str)
        .collect();
    for (id, variable) in project
        .pointer(path)
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let name = variable["name"].as_str().unwrap_or(id);
        if variable["visible"] == true
            || references.contains(id.as_str())
            || references.contains(name)
        {
            continue;
        }
        let list = variable["type"] == "list";
        let mut loc = location(pointer(path, id));
        let owner_id = variable
            .get("current_entity")
            .or_else(|| variable.get("currentEntity"))
            .and_then(Value::as_str);
        for (owners, kind) in if k4 {
            [("/theatre/scenes", "scene"), ("/theatre/actors", "actor")]
        } else {
            [
                ("/scenes/scenesDict", "scene"),
                ("/actors/actorsDict", "actor"),
            ]
        } {
            if let Some(id) = owner_id
                && let Some(owner) = project.pointer(owners).and_then(|v| v.get(id))
            {
                loc.owner_id = Some(id.into());
                loc.owner_name = Some(owner["name"].as_str().unwrap_or(id).into());
                loc.owner_kind = Some(kind.into());
            }
        }
        warn(
            out,
            if list {
                "unused_list"
            } else {
                "unused_variable"
            },
            format!(
                "{}“{name}”没有积木引用，也未显示监视器",
                if list { "列表" } else { "变量" }
            ),
            "确认不需要保留初始数据或扩展引用后，删除此项。",
            loc,
        );
    }
}

fn lint_scripts(blocks: &[Block<'_>], out: &mut Vec<Diagnostic>) {
    for (index, block) in blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| b.root && b.value["is_shadow"] != true && b.value["is_output"] != true)
    {
        let kind = block.value["type"].as_str().unwrap_or("");
        // Deliberately a small known-command set, not a closed list of event hats:
        // unknown extension hats must not become false unreachable warnings.
        let detached = matches!(
            kind,
            "variables_set"
                | "change_variables"
                | "change_variable"
                | "self_go_forward"
                | "self_move_to"
                | "self_rotate"
                | "self_dialog"
                | "wait"
                | "controls_if"
                | "repeat_n_times"
                | "repeat_forever"
                | "list_append"
                | "lists_append"
                | "self_broadcast"
                | "self_broadcast_with_param"
                | "self_broadcast_and_wait"
        );
        if block.disabled || detached {
            warn(
                out,
                "untriggered_script",
                if block.disabled {
                    "脚本入口已禁用，不会自动触发".into()
                } else {
                    "游离命令没有事件入口，不会自动触发".into()
                },
                "启用脚本，或将命令连接到启动、按键、消息等事件入口；若为草稿可忽略。",
                block_location(blocks, index),
            );
        }
    }
}

fn message(block: &Block<'_>) -> Option<String> {
    let value = block.message?;
    match value["type"].as_str()? {
        "broadcast_input" => value["fields"]
            .get("message")
            .or_else(|| value["fields"].get("MESSAGE"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        "text" => value["fields"]["TEXT"].as_str().map(str::to_owned),
        _ => None,
    }
}

fn lint_broadcasts(blocks: &[Block<'_>], out: &mut Vec<Diagnostic>) {
    let mut receivers = BTreeSet::new();
    let mut dynamic_receiver = false;
    for block in blocks.iter().filter(|b| {
        b.root
            && !b.disabled
            && matches!(
                b.value["type"].as_str(),
                Some("self_listen" | "self_listen_with_param")
            )
    }) {
        if let Some(name) = message(block) {
            receivers.insert(name);
        } else {
            dynamic_receiver = true;
        }
    }
    if dynamic_receiver {
        return;
    }
    for (index, block) in blocks.iter().enumerate().filter(|(_, b)| {
        !b.disabled
            && matches!(
                b.value["type"].as_str(),
                Some("self_broadcast" | "self_broadcast_with_param" | "self_broadcast_and_wait")
            )
    }) {
        if let Some(name) = message(block)
            && !receivers.contains(&name)
        {
            warn(
                out,
                "broadcast_without_receiver",
                format!("广播“{name}”没有静态消息接收入口"),
                "检查消息名是否拼写一致，或添加接收此消息的事件；外部或扩展接收者需人工确认。",
                block_location(blocks, index),
            );
        }
    }
}

fn lint_resources(project: &Value, k4: bool, out: &mut Vec<Diagnostic>) {
    let paths: &[(&str, &str)] = if k4 {
        &[
            ("/theatre/styles", "造型"),
            ("/audio", "声音"),
            ("/theatre/videos", "视频"),
        ]
    } else {
        &[
            ("/styles/stylesDict", "造型"),
            ("/audios/audiosDict", "声音"),
            ("/videos/videosDict", "视频"),
        ]
    };
    let mut costumes = BTreeMap::<&str, &str>::new();
    for &(dict_path, kind) in paths {
        for (id, resource) in project
            .pointer(dict_path)
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            let name = resource["name"].as_str().unwrap_or(id);
            let url = resource["url"].as_str().filter(|s| !s.is_empty());
            let declared = ["size", "fileSize", "file_size", "byteLength"]
                .iter()
                .filter_map(|key| resource[*key].as_u64())
                .max();
            let bytes = declared
                .into_iter()
                .chain(url.and_then(data_url_bytes))
                .max();
            let width = resource["width"].as_u64().unwrap_or(0);
            let height = resource["height"].as_u64().unwrap_or(0);
            if bytes.is_some_and(|n| n > LARGE_RESOURCE_BYTES)
                || width > LARGE_IMAGE_DIMENSION
                || height > LARGE_IMAGE_DIMENSION
            {
                let size = bytes
                    .map(|n| format!("{n} 字节"))
                    .unwrap_or_else(|| "字节大小未知".into());
                warn(
                    out,
                    "large_resource",
                    format!(
                        "{kind}“{name}”资源较大：{size}，尺寸 {width}×{height}；建议阈值为 5 MiB / 单边 4096 像素"
                    ),
                    "按实际显示尺寸压缩或缩小资源；这是静态建议阈值，不是官方上传限制。",
                    location(pointer(dict_path, id)),
                );
            }
            if kind == "造型"
                && let Some(url) = url
            {
                if let Some(first) = costumes.get(url) {
                    warn(
                        out,
                        "duplicate_costume",
                        format!("造型“{name}”与造型 ID“{first}”使用相同资源地址"),
                        "确认是否可合并；同图不同名称或旋转中心也可能是有意设计，不会自动删除。",
                        location(pointer(dict_path, id)),
                    );
                } else {
                    costumes.insert(url, id);
                }
            }
        }
    }
}

/// Count embedded bytes without allocating a decoded copy or reading external URLs.
fn data_url_bytes(url: &str) -> Option<u64> {
    let (header, data) = url.strip_prefix("data:")?.split_once(',')?;
    if header.ends_with(";base64") {
        let mut count = 0u64;
        let mut padding = 0u64;
        for byte in data.bytes().filter(|b| !b.is_ascii_whitespace()) {
            if byte == b'=' {
                padding += 1;
            } else if padding > 0 || !(byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
            {
                return None;
            }
            count += 1;
        }
        if padding > 2 || count % 4 == 1 || (padding > 0 && !count.is_multiple_of(4)) {
            return None;
        }
        Some(count * 3 / 4 - padding)
    } else {
        let mut bytes = data.bytes();
        let mut count = 0;
        while let Some(byte) = bytes.next() {
            if byte == b'%'
                && !(bytes.next()?.is_ascii_hexdigit() && bytes.next()?.is_ascii_hexdigit())
            {
                return None;
            }
            count += 1;
        }
        Some(count)
    }
}
