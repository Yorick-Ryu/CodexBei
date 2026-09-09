use crate::config::Result;
use serde_json::Value;
fn sensitive(name: &str) -> bool {
    let camel = regex::Regex::new("([a-z])([A-Z])")
        .unwrap()
        .replace_all(name, "${1}_${2}")
        .to_lowercase();
    if [
        "env_key",
        "env_http_headers",
        "bearer_token_env_var",
        "preferred_auth_method",
        "max_tokens",
        "max_output_tokens",
        "max_completion_tokens",
        "model_max_tokens",
    ]
    .contains(&camel.as_str())
    {
        return false;
    }
    regex::Regex::new(
        "(?:^|[_-])(?:key|token|secret|password|passwd|authorization|credential)s?(?:$|[_-])",
    )
    .unwrap()
    .is_match(&camel)
}
fn text(value: &str) -> String {
    let mut result = regex::Regex::new(r"\bsk-[A-Za-z0-9_-]+")
        .unwrap()
        .replace_all(value, "（已隐藏）")
        .into_owned();
    result = regex::Regex::new(r#"(?i)\bBearer\s+[^\s"']+"#)
        .unwrap()
        .replace_all(&result, "Bearer （已隐藏）")
        .into_owned();
    if let Ok(mut url) = url::Url::parse(&result) {
        let mut changed = false;
        if url.password().is_some() {
            let _ = url.set_password(Some("REDACTED"));
            changed = true;
        }
        let pairs: Vec<_> = url
            .query_pairs()
            .map(|(k, v)| {
                if sensitive(&k) {
                    changed = true;
                    (k.into_owned(), "（已隐藏）".into())
                } else {
                    (k.into_owned(), v.into_owned())
                }
            })
            .collect();
        if changed {
            if !pairs.is_empty() {
                url.query_pairs_mut().clear().extend_pairs(pairs);
            }
            result = url.to_string();
        }
    }
    result
}
fn redact(value: &mut Value, path: &mut Vec<String>, original: &Value, hidden: bool) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                path.push(key.clone());
                let actor = path.len() == 4
                    && path[0] == "model_providers"
                    && path[2] == "http_headers"
                    && key.eq_ignore_ascii_case("x-openai-actor-authorization")
                    && child.as_str().is_some_and(|s| {
                        original["model_providers"][&path[1]]["base_url"] == s
                            && crate::config::endpoint(s).is_ok()
                    });
                redact(child, path, original, hidden || (sensitive(key) && !actor));
                path.pop();
            }
        }
        Value::Array(array) => {
            let mut next_hidden = false;
            for child in array {
                let current_flag = child
                    .as_str()
                    .filter(|s| s.starts_with('-'))
                    .map(str::to_owned);
                let hide = hidden || next_hidden;
                next_hidden = current_flag
                    .as_ref()
                    .is_some_and(|s| !s.contains('=') && sensitive(s.trim_start_matches('-')));
                if !hide {
                    if let Some(flag) = current_flag {
                        if let Some((key, _)) = flag.split_once('=') {
                            if sensitive(key.trim_start_matches('-')) {
                                *child = Value::String(format!("{key}=（已隐藏）"));
                                continue;
                            }
                        }
                    }
                }
                redact(child, path, original, hide);
            }
        }
        _ if hidden => *value = Value::String("（已隐藏）".into()),
        Value::String(s) => *s = text(s),
        _ => {}
    }
}
pub fn preview(bytes: &[u8]) -> Result<String> {
    let source =
        std::str::from_utf8(bytes).map_err(|_| "备份不是有效的 UTF-8 TOML。".to_string())?;
    let original: Value = toml_edit::de::from_str(source)
        .map_err(|_| "备份不是有效的 TOML，无法预览。".to_string())?;
    let mut value = original.clone();
    redact(&mut value, &mut Vec::new(), &original, false);
    let doc = toml_edit::ImDocument::parse(source)
        .map_err(|_| "备份不是有效的 TOML，无法预览。".to_string())?;
    let mut edits = Vec::new();
    item_edits(doc.as_item(), &original, &value, &mut edits)?;
    comment_edits(source, &mut edits);
    edits.sort_by_key(|(range, _)| std::cmp::Reverse(range.start));
    let mut result = source.to_owned();
    let mut boundary = result.len();
    for (range, replacement) in edits {
        if range.end > boundary
            || !result.is_char_boundary(range.start)
            || !result.is_char_boundary(range.end)
        {
            return Err("无法生成脱敏预览。".into());
        }
        boundary = range.start;
        result.replace_range(range, &replacement);
    }
    Ok(result)
}

type Edits = Vec<(std::ops::Range<usize>, String)>;
fn item_edits(
    item: &toml_edit::Item,
    before: &Value,
    after: &Value,
    edits: &mut Edits,
) -> Result<()> {
    match item {
        toml_edit::Item::Table(table) => {
            for (key, child) in table {
                item_edits(child, &before[key], &after[key], edits)?;
            }
        }
        toml_edit::Item::ArrayOfTables(tables) => {
            for (index, table) in tables.iter().enumerate() {
                for (key, child) in table {
                    item_edits(child, &before[index][key], &after[index][key], edits)?;
                }
            }
        }
        toml_edit::Item::Value(value) => value_edits(value, before, after, edits)?,
        toml_edit::Item::None => {}
    }
    Ok(())
}
fn value_edits(
    value: &toml_edit::Value,
    before: &Value,
    after: &Value,
    edits: &mut Edits,
) -> Result<()> {
    match value {
        toml_edit::Value::InlineTable(table) => {
            for (key, child) in table {
                value_edits(child, &before[key], &after[key], edits)?;
            }
        }
        toml_edit::Value::Array(array) => {
            for (index, child) in array.iter().enumerate() {
                value_edits(child, &before[index], &after[index], edits)?;
            }
        }
        _ if before != after => {
            let range = value.span().ok_or("无法定位备份中的敏感字段。")?;
            let replacement = after.as_str().ok_or("无法生成脱敏预览。")?;
            edits.push((range, toml_edit::Value::from(replacement).to_string()));
        }
        _ => {}
    }
    Ok(())
}
// The document is already parsed. Scan only comments, skipping quoted keys and
// all four TOML string forms so literal '#' characters remain untouched.
fn comment_edits(source: &str, edits: &mut Edits) {
    let bytes = source.as_bytes();
    let mut i = 0;
    let mut quote: Option<(u8, bool)> = None;
    let urls = regex::Regex::new(r#"(?i)[a-z][a-z0-9+.-]*://[^\s"'<>]+"#).unwrap();
    let assignment =
        regex::Regex::new(r#"([\w-]+)(\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)"#).unwrap();
    while i < bytes.len() {
        if let Some((delimiter, multiline)) = quote {
            if delimiter == b'"' && bytes[i] == b'\\' {
                i += 2;
                continue;
            }
            if bytes[i] == delimiter {
                let run = bytes[i..].iter().take_while(|&&v| v == delimiter).count();
                if !multiline || run >= 3 {
                    quote = None;
                    i += if multiline { run.min(5) } else { 1 };
                    continue;
                }
            }
        } else if bytes[i] == b'"' || bytes[i] == b'\'' {
            let delimiter = bytes[i];
            let multiline = bytes
                .get(i..i + 3)
                .is_some_and(|v| v.iter().all(|&v| v == delimiter));
            quote = Some((delimiter, multiline));
            i += if multiline { 3 } else { 1 };
            continue;
        } else if bytes[i] == b'#' {
            let start = i;
            while i < bytes.len() && !b"\r\n".contains(&bytes[i]) {
                i += 1;
            }
            let comment = &source[start..i];
            let safe_urls = urls.replace_all(comment, |caps: &regex::Captures| text(&caps[0]));
            let replacement = assignment
                .replace_all(&text(&safe_urls), |caps: &regex::Captures| {
                    if sensitive(&caps[1]) {
                        format!("{}{}（已隐藏）", &caps[1], &caps[2])
                    } else {
                        caps[0].to_owned()
                    }
                })
                .into_owned();
            if replacement != comment {
                edits.push((start..i, replacement));
            }
            continue;
        }
        i += 1;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn masks_mcp_credentials_arguments_urls_and_comments() {
        let source = "# password=comment-secret\n[mcp_servers.demo]\nargs=['--api-key', 'argument-secret', '--token=flag-secret']\nenv={ API_KEY='mcp-secret', normal='sk-fixture-secret-12345' }\nurl='https://user:password-secret@example.com?api_key=query-secret&debug=true'\n";
        let out = preview(source.as_bytes()).unwrap();
        for secret in [
            "comment-secret",
            "argument-secret",
            "flag-secret",
            "mcp-secret",
            "fixture-secret",
            "password-secret",
            "query-secret",
        ] {
            assert!(!out.contains(secret));
        }
        assert!(out.contains("debug=true"));
    }
    #[test]
    fn retains_actor_endpoint_but_masks_other_authorization() {
        let src="[model_providers.custom]\nbase_url='https://example.com/v1'\nhttp_headers={x-openai-actor-authorization='https://example.com/v1', Authorization='secret'}\n";
        let out = preview(src.as_bytes()).unwrap();
        assert!(out.contains("https://example.com/v1"));
        assert!(!out.contains("secret"));
    }
    #[test]
    fn preserves_snapshot_layout_inline_headers_and_line_endings() {
        let source = "# 我的配置\r\nmodel = 'gpt-6-astra' # chosen\r\n\r\n[model_providers.custom]\r\nbase_url = 'https://example.com/v1'\r\nhttp_headers = { \"x-openai-actor-authorization\" = 'https://example.com/v1', Authorization = 'fixture-secret' } # headers\r\nexperimental_bearer_token = 'fixture-key'\r\n";
        let expected = source
            .replace("'fixture-secret'", "\"（已隐藏）\"")
            .replace("'fixture-key'", "\"（已隐藏）\"");
        assert_eq!(preview(source.as_bytes()).unwrap(), expected);
        let blocked = source.replace("http_headers = { \"x-openai-actor-authorization\" = 'https://example.com/v1', Authorization = 'fixture-secret' } # headers", "[model_providers.custom.http_headers]\r\nAuthorization = 'fixture-secret'");
        assert!(preview(blocked.as_bytes())
            .unwrap()
            .contains("[model_providers.custom.http_headers]"));
    }
    #[test]
    fn preserves_arrays_dotted_keys_and_multiline_strings_while_redacting_comments() {
        let source = "title = '''hello\n# ordinary literal text\nend''' # token=comment-fixture\nname = \"# literal\" # safe\n[mcp_servers.demo]\nenv.API_KEY = 'dotted-fixture'\nargs = [\n '--token', # keep this comment\n 'argument-fixture',\n]\n[[items]]\nname = 'one'\npassword = 'array-fixture'\n";
        let expected = source
            .replace("token=comment-fixture", "token=（已隐藏）")
            .replace("'dotted-fixture'", "\"（已隐藏）\"")
            .replace("'argument-fixture'", "\"（已隐藏）\"")
            .replace("'array-fixture'", "\"（已隐藏）\"");
        let out = preview(source.as_bytes()).unwrap();
        assert_eq!(out, expected);
        toml_edit::ImDocument::parse(&out).unwrap();
    }
}
