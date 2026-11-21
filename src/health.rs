//! Import health is a set of independent capabilities, not a compatibility score.
//! A successful compile is never evidence of full official semantic parity.
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const CATEGORIES: [(&str, &str); 5] = [
    ("preserve", "能保留导出"),
    ("executable", "能执行"),
    ("approximate", "语义近似"),
    ("unverified", "尚未验证"),
    ("unsupported", "不支持"),
];

struct Block<'a> {
    value: &'a Value,
    location: Value,
    pointer: String,
}

fn owner_location(project: &Value, kind: &str, id: &str, owner: &Value) -> Value {
    let scene = if kind == "scene" {
        Some(id)
    } else {
        project["scenes"]["scenesDict"]
            .as_object()
            .and_then(|scenes| {
                scenes.iter().find_map(|(scene, data)| {
                    data["actorIds"]
                        .as_array()
                        .is_some_and(|ids| ids.iter().any(|actor| actor == id))
                        .then_some(scene.as_str())
                })
            })
    };
    let scene_name = scene.and_then(|scene| {
        let data = &project["scenes"]["scenesDict"][scene];
        data["screenName"].as_str().or(data["name"].as_str())
    });
    json!({"scene":scene,"scene_name":scene_name,"owner":id,
        "owner_name":owner["screenName"].as_str().or(owner["name"].as_str()).unwrap_or(id),
        "owner_kind":kind,"block":null,"block_type":null})
}

fn blocks(project: &Value) -> Vec<Block<'_>> {
    let mut blocks = Vec::new();
    for (path, kind) in [
        ("/scenes/scenesDict", "scene"),
        ("/actors/actorsDict", "actor"),
        ("/procedures/proceduresDict", "procedure"),
    ] {
        for (id, owner) in project
            .pointer(path)
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            let location = owner_location(project, kind, id, owner);
            let token = id.replace('~', "~0").replace('/', "~1");
            let owner_path = format!("{path}/{token}/nekoBlockJsonList");
            let mut pending: Vec<_> = owner["nekoBlockJsonList"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .enumerate()
                .rev()
                .map(|(index, block)| (block, format!("{owner_path}/{index}")))
                .collect();
            while let Some((block, path)) = pending.pop() {
                if block["type"].is_string() {
                    let mut location = location.clone();
                    location["block"] = block["id"].clone();
                    location["block_type"] = block["type"].clone();
                    blocks.push(Block {
                        value: block,
                        location,
                        pointer: path.clone(),
                    });
                }
                if let Some(next) = block.get("next") {
                    pending.push((next, format!("{path}/next")));
                }
                for key in ["statements", "inputs"] {
                    if let Some(children) = block[key].as_object() {
                        pending.extend(children.iter().rev().map(|(name, child)| {
                            let token = name.replace('~', "~0").replace('/', "~1");
                            (child, format!("{path}/{key}/{token}"))
                        }));
                    }
                }
            }
        }
    }
    blocks
}

fn item(
    category: &str,
    code: &str,
    location: Option<&Value>,
    impact: &str,
    evidence: &str,
) -> Value {
    let mut item = location.cloned().unwrap_or_else(|| {
        json!({
            "scene":null,"scene_name":null,"owner":null,"owner_name":null,
            "owner_kind":null,"block":null,"block_type":null
        })
    });
    item["category"] = json!(category);
    item["code"] = json!(code);
    item["impact"] = json!(impact);
    item["evidence"] = json!(evidence);
    item
}

// An explicit, intentionally incomplete restriction list. Unlisted types remain
// unverified, not supported. Keep evidence tied to the existing implementation
// and archived official observations rather than guesses based on type prefixes.
fn limitation(block: &Value, kitten4: bool) -> Option<(&'static str, &'static str, &'static str)> {
    let kind = block["type"].as_str()?;
    if kitten4 {
        return match kind {
            "kitten4::enable_voice_detection"
            | "kitten4::get_voice_volume"
            | "kitten4::wood_block_set"
            | "kitten4::wood_block_get"
            | "kitten4::set_camera_status" => Some((
                "approximate",
                "K4 适配器保留此积木，但 VM 使用占位/无效果分支；设备效果不可用。",
                "src/kitten4.rs::is_stub；官方设备效果一致性未验证",
            )),
            _ => None,
        };
    }
    match kind {
        "bcm_translator_text_execution_block" if block["disabled"] == true => Some((
            "approximate",
            "已禁用的旧文本执行占位在语句链中被跳过，继续执行 next；不执行 mutation 描述、旧输入或嵌套语句，不代表原指令已还原或真实翻译服务可用。",
            "src/engine.rs::Compiler::chain 禁用占位分支；docs/kn-r3-translator-evidence.md；未实际运行本作品",
        )),
        "bcm_translator_text_execution_block" => Some((
            "unsupported",
            "仅保留未禁用的文本占位积木及 mutation；默认 VM 没有此类型的执行实现，不能据描述文字还原原指令。",
            "src/engine.rs::Compiler::chain 拒绝未禁用执行占位；本地编译回归 tests/r2_health.rs；官方行为未验证",
        )),
        "open_hide_camera" | "open_close_webcam" => {
            if block["fields"]["camera_status"] == "turn_off" {
                Some((
                    "approximate",
                    "仅覆盖摄像头从未开启时的关闭分支；真实设备关闭未实现。",
                    "docs/kn-panel-capture.md；src/engine/kn_capture.rs",
                ))
            } else {
                Some((
                    "unsupported",
                    "摄像头开启需要尚未实现的后端；可执行脚本包含此操作时默认 VM 编译拒绝，不能打开摄像头。",
                    "docs/kn-panel-capture.md；src/engine/kn_panel.rs",
                ))
            }
        }
        "translate" | "translate_result" => Some((
            "approximate",
            "仅实现离线失败/空白输入分支；成功翻译服务和对话框尚未实现，不能得到真实翻译。",
            "docs/kn-panel-services.md；src/engine/kn_panel.rs",
        )),
        "set_camera_alpha" | "set_webcam_alpha" => Some((
            "approximate",
            "仅更新离线透明度状态；没有实际摄像画面，完整异步时序未验证。",
            "docs/kn-panel-capture.md；src/engine/kn_capture.rs",
        )),
        "voice_recognition" | "get_voice_answer" => Some((
            "approximate",
            "仅未登录/未识别的提前返回或空缓存；真实语音识别后端未实现。",
            "docs/kn-panel-capture.md；src/engine/kn_services.rs",
        )),
        "ai_chat_ask"
        | "new_conversation"
        | "set_system_preset"
        | "ai_text_actor"
        | "ai_text_photo"
        | "enable_face_detect_by_actor"
        | "enable_face_detect_by_photo"
        | "enable_object_detect_by_actor"
        | "enable_object_detect_by_photo"
        | "evaluate_actor_style"
        | "evaluate_camera"
        | "evaluate_photo"
        | "get_evaluate_class_name"
        | "get_evaluate_class_accuracy" => Some((
            "approximate",
            "仅实现离线匿名拒绝/空缓存分支；真实 AI、OCR、检测或预测服务未实现。",
            "docs/kn-panel-ai.md；src/engine/kn_ai.rs",
        )),
        "username_get" | "user_id_get" => Some((
            "approximate",
            "仅使用未登录账户值；没有真实账户后端。",
            "docs/kn-async-services.md；src/engine/kn_services.rs",
        )),
        "get_orientation" => Some((
            "approximate",
            "仅桌面无设备分支的固定 0；不代表移动设备传感器支持。",
            "docs/kn-async-services.md；src/engine/kn_services.rs",
        )),
        _ => None,
    }
}

fn diagnostic_location<'a>(
    blocks: &'a [Block<'_>],
    diagnostic: &Value,
) -> Option<(&'a Value, bool)> {
    // Never search arbitrary error text for an ID-shaped substring. Only a
    // complete, known root-cause template reconstructed from that exact block
    // is evidence. Context/field/type strings are untrusted and may contain IDs.
    // New compiler error templates deliberately fall back to script precision.
    let message = diagnostic["root_error"].as_str().unwrap_or_default();
    let mut candidates = blocks.iter().filter(|block| {
        let id = &block.location["block"];
        let kind = block.value["type"].as_str().unwrap_or_default();
        let dialog_type = block.value["fields"]["type"].as_str().unwrap_or_default();
        id.as_str().is_some_and(|s| !s.is_empty())
            && [
                format!("unsupported fast-VM block {kind} ({id})"),
                format!("unsupported expression {kind} at block {id}"),
                // These three kinds share the KN dialog error branch.
                if matches!(
                    kind,
                    "self_dialog" | "self_dialog_wait" | "create_stage_dialog"
                ) {
                    format!("unknown dialog type {dialog_type} at {id}")
                } else {
                    String::new()
                },
            ]
            .iter()
            .any(|expected| !expected.is_empty() && message == expected)
            && (block.location["owner"] == diagnostic["owner"]
                || block.location["owner_kind"] == "procedure")
    });
    let candidate = candidates.next();
    let unique = candidates.next().is_none();
    candidate
        .filter(|candidate| {
            unique
                && blocks
                    .iter()
                    .filter(|block| {
                        block.location["owner"] == candidate.location["owner"]
                            && block.location["block"] == candidate.location["block"]
                    })
                    .count()
                    == 1
        })
        .map(|block| (&block.location, true))
        .or_else(|| {
            blocks
                .iter()
                .find(|block| {
                    block.location["owner"] == diagnostic["owner"]
                        && block.location["block"] == diagnostic["block"]
                })
                .map(|block| (&block.location, false))
        })
}

/// Build from the existing import diagnostics without compiling or executing a
/// second time. Call only after the import boundary has accepted the project.
pub fn build_report(project: &Value, import: &Value) -> Value {
    let kitten4 = project.get(crate::player::KITTEN4_METADATA).is_some();
    let blocks = blocks(project);
    let mut items = vec![item(
        "preserve",
        "source_preserved",
        None,
        if kitten4 {
            "原生 K4 数据保存在保真元数据中；导入时已验证可还原导出 .bcm。未验证外部资源可下载或官方编辑器可打开。"
        } else {
            "原始 JSON、未知字段与积木保留，可导出 .bcmkn；不代表结构正确、外部资源可用或官方编辑器可打开。"
        },
        if kitten4 {
            "src/player.rs::import；src/kitten4.rs::from_neko"
        } else {
            "src/bcmkn.rs::import"
        },
    )];
    if import["fast_runtime_ready"] == true {
        items.push(item("executable", "vm_compile_ready", None,
            "当前项目通过默认 VM 的静态编译，可尝试执行；未实际运行，游离积木、设备成功路径和运行期错误不在此结论内。",
            "src/engine.rs::Program::compile（本次导入）"));
    } else if import["fast_runtime_ready"] == false {
        items.push(item(
            "unsupported",
            "vm_compile_failed",
            None,
            import["runtime_error"]
                .as_str()
                .unwrap_or("默认 VM 编译未就绪；原因尚未验证。"),
            "src/engine.rs::Program::compile（本次导入）",
        ));
    } else {
        items.push(item(
            "unverified",
            "vm_compile_unknown",
            None,
            "未获得默认 VM 编译结果，执行能力尚未验证。",
            "缺少编译探测数据",
        ));
    }
    for issue in import["validation"]["issues"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let owner = issue["owner_id"]
            .as_str()
            .or(issue["actor_id"].as_str())
            .or(issue["scene_id"].as_str());
        let location = blocks
            .iter()
            .find(|block| {
                owner.is_none_or(|id| block.location["owner"] == id)
                    && issue["block_id"]
                        .as_str()
                        .is_some_and(|id| block.location["block"] == id)
            })
            .map(|block| block.location.clone())
            .or_else(|| {
                // Only match the validator's escaped JSON Pointer. Its legacy
                // display path can collide with properties outside the block
                // inventory (e.g. an unknown literal property named inputs.x).
                let pointer = issue["json_pointer"].as_str()?;
                let mut matches = blocks.iter().filter(|block| block.pointer == pointer);
                let found = matches.next()?;
                matches.next().is_none().then(|| found.location.clone())
            })
            .or_else(|| {
                let id = owner?;
                for (section, dict, kind) in [
                    ("actors", "actorsDict", "actor"),
                    ("scenes", "scenesDict", "scene"),
                    ("procedures", "proceduresDict", "procedure"),
                ] {
                    if let Some(data) = project[section][dict].get(id) {
                        return Some(owner_location(project, kind, id, data));
                    }
                }
                None
            });
        let location = location.unwrap_or_else(|| {
            json!({
                "scene":issue["scene_id"],"scene_name":null,"owner":owner,
                "owner_name":null,"owner_kind":issue["owner_kind"],
                "block":issue["block_id"],"block_type":null
            })
        });
        items.push(item(
            "unsupported",
            "invalid_structure",
            Some(&location),
            &format!("结构检查发现问题，可能阻止编辑器或运行时使用：{issue}"),
            "src/validate.rs::build_report（本次导入）",
        ));
    }
    for diagnostic in import["script_diagnostics"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let location = diagnostic_location(&blocks, diagnostic);
        let precise = location.is_some_and(|(_, precise)| precise);
        let mut issue = item(
            "unsupported",
            "script_compile_failed",
            location.map(|(location, _)| location),
            &format!(
                "{}（受影响脚本：{}；每个脚本只报告首个编译错误，后续积木仍待验证）",
                diagnostic["message"].as_str().unwrap_or("编译失败"),
                diagnostic["affected_scripts"].as_u64().unwrap_or(1)
            ),
            if precise {
                "src/bcmkn.rs::import 逐脚本编译；按错误中的积木 ID 定位"
            } else {
                "src/bcmkn.rs::import 逐脚本编译；无法确定失败块，位置仅为脚本入口"
            },
        );
        issue["location_precision"] = json!(if precise { "block" } else { "script" });
        items.push(issue);
    }
    let diagnosed: BTreeSet<_> = items
        .iter()
        .filter(|issue| {
            issue["code"] == "script_compile_failed" && issue["location_precision"] == "block"
        })
        .filter_map(|issue| {
            Some((
                issue["owner"].as_str()?.to_owned(),
                issue["block"].as_str()?.to_owned(),
            ))
        })
        .collect();
    for block in &blocks {
        let (category, impact, evidence) = limitation(block.value, kitten4).unwrap_or(("unverified",
            "已保留此积木；尚未逐积木验证所有字段、分支、运行效果与官方语义。游离/未调用代码不能因整件作品编译成功而判为通过。",
            "静态导入清点；无本作品逐积木运行/官方差分证据"));
        // Do not also label a precisely diagnosed compile failure as unknown.
        if category == "unverified"
            && diagnosed.contains(&(
                block.location["owner"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                block.location["block"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
            ))
        {
            continue;
        }
        items.push(item(
            category,
            if category == "unverified" {
                "semantics_unverified"
            } else {
                "known_limitation"
            },
            Some(&block.location),
            impact,
            evidence,
        ));
    }
    items.push(item("unverified", "runtime_not_exercised", None,
        "本报告只检查导入、结构及静态编译，未播放作品；素材可达性、设备权限、网络服务、交互和官方一致性尚未验证。",
        "检查范围声明"));
    let summary: BTreeMap<_, _> = CATEGORIES
        .iter()
        .map(|(category, _)| {
            (
                *category,
                items
                    .iter()
                    .filter(|item| item["category"] == *category)
                    .count(),
            )
        })
        .collect();
    let mut report = json!({"schema_version":1,"format":if kitten4 {"kitten4"} else {"kitten-n"},
        "project_name":project["projectName"].as_str().unwrap_or("未命名作品"),"summary":summary,"items":items});
    report["text"] = json!(text_summary(&report));
    report
}

/// Shared verbatim by CLI output and Web Studio's downloaded summary.
pub fn text_summary(report: &Value) -> String {
    let mut text = format!(
        "作品体检：{}\n格式：{}\n五类是独立能力维度；未知不等于通过，编译成功不等于官方语义一致。\n",
        report["project_name"].as_str().unwrap_or("未命名作品"),
        report["format"].as_str().unwrap_or("未知")
    );
    for (category, label) in CATEGORIES {
        text.push_str(&format!(
            "\n【{label}】{} 项\n",
            report["summary"][category]
        ));
        for item in report["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| item["category"] == category)
        {
            let field = |key: &str| item[key].as_str().unwrap_or("—").replace(['\n', '\r'], " ");
            text.push_str(&format!("- 场景：{} ({})；角色/所有者：{} ({})；积木 ID：{}；类型：{}\n  影响：{}\n  依据：{}\n",
                field("scene_name"),field("scene"),field("owner_name"),field("owner"),field("block"),field("block_type"),field("impact"),field("evidence")));
        }
    }
    text
}
