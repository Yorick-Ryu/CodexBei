use crate::config::{endpoint, Result};
use toml_edit::{DocumentMut, Item};

pub fn base(doc: &DocumentMut, id: &str) -> Option<String> {
    doc.get("model_providers")?
        .get(id)?
        .get("base_url")?
        .as_str()
        .and_then(|s| endpoint(s).ok())
}

pub fn name(base_url: &str) -> Result<String> {
    let url = url::Url::parse(base_url).map_err(|_| "API 地址无效。".to_string())?;
    let host = url
        .host_str()
        .ok_or("API 地址无效。")?
        .trim_end_matches('.');
    let domain = if matches!(url.host(), Some(url::Host::Domain(_))) {
        psl::domain_str(host)
            .unwrap_or(host)
            .split('.')
            .next()
            .unwrap_or(host)
    } else {
        host
    };
    let mut id: String = domain
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if id.is_empty() {
        id = "gateway".into();
    }
    if ["openai", "ollama", "lmstudio", "custom"].contains(&id.as_str()) {
        id = format!("codexbei-{id}");
    }
    Ok(id)
}

fn compatible(doc: &DocumentMut, id: &str, base_url: &str) -> bool {
    if base(doc, id).as_deref() != Some(base_url) {
        return false;
    }
    let Some(provider) = doc
        .get("model_providers")
        .and_then(|t| t.get(id))
        .and_then(Item::as_table_like)
    else {
        return false;
    };
    if ["env_key", "env_key_instructions", "auth"]
        .iter()
        .any(|k| provider.contains_key(k))
    {
        return false;
    }
    for section in ["http_headers", "env_http_headers"] {
        if let Some(headers) = provider.get(section) {
            let Some(headers) = headers.as_table_like() else {
                return false;
            };
            if headers.iter().any(|(key, _)| {
                key.eq_ignore_ascii_case("authorization")
                    || (key.eq_ignore_ascii_case("x-openai-actor-authorization")
                        && (section == "env_http_headers" || key != "x-openai-actor-authorization"))
            }) {
                return false;
            }
        }
    }
    true
}

// Reuse only a matching, compatible provider. Occupied names are never overwritten.
pub fn for_write(doc: &DocumentMut, base_url: &str) -> Result<String> {
    let stem = name(base_url)?;
    let providers = doc
        .get("model_providers")
        .map(|v| {
            v.as_table_like()
                .ok_or("model_providers 必须是 TOML 表。".to_string())
        })
        .transpose()?;
    // Keep using an existing matching name even if an earlier suffix becomes free.
    let matches_name = |id: &str| {
        id == stem
            || id
                .strip_prefix(&format!("{stem}-"))
                .is_some_and(|suffix| suffix.parse::<u32>().is_ok())
    };
    if let Some(active) = doc.get("model_provider").and_then(Item::as_str) {
        if matches_name(active) && compatible(doc, active, base_url) {
            return Ok(active.into());
        }
    }
    if let Some(providers) = providers {
        if let Some((id, _)) = providers
            .iter()
            .find(|(id, _)| matches_name(id) && compatible(doc, id, base_url))
        {
            return Ok(id.into());
        }
    }
    for n in 1..=1000 {
        let id = if n == 1 {
            stem.clone()
        } else {
            format!("{stem}-{n}")
        };
        if providers.is_none_or(|p| !p.contains_key(&id)) || compatible(doc, &id, base_url) {
            return Ok(id);
        }
    }
    Err("同名供应商过多，请检查配置文件。".into())
}

pub fn for_read(doc: &DocumentMut, base_url: &str) -> Option<String> {
    let active = doc.get("model_provider").and_then(Item::as_str);
    if let Some(id) =
        active.filter(|id| *id != "openai" && base(doc, id).as_deref() == Some(base_url))
    {
        return Some(id.into());
    }
    let managed = for_write(doc, base_url).ok()?;
    if base(doc, &managed).as_deref() == Some(base_url) {
        return Some(managed);
    }
    if base(doc, "custom").as_deref() == Some(base_url) {
        return Some("custom".into());
    }
    None
}

pub fn active(doc: &DocumentMut, remembered: Option<&str>) -> Option<String> {
    if let Some(id) = doc
        .get("model_provider")
        .and_then(Item::as_str)
        .filter(|id| *id != "openai" && base(doc, id).is_some())
    {
        return Some(id.into());
    }
    if let Some(id) = remembered.filter(|id| *id != "openai" && base(doc, id).is_some()) {
        return Some(id.into());
    }
    if base(doc, "custom").is_some() {
        return Some("custom".into());
    }
    let providers = doc.get("model_providers")?.as_table_like()?;
    let mut candidates = providers.iter().filter_map(|(id, _)| {
        let endpoint = base(doc, id)?;
        let stem = name(&endpoint).ok()?;
        (id == stem
            || id
                .strip_prefix(&format!("{stem}-"))
                .is_some_and(|tail| tail.parse::<u32>().is_ok()))
        .then(|| id.to_owned())
    });
    let candidate = candidates.next()?;
    if candidates.next().is_some() {
        None
    } else {
        Some(candidate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn derives_domain_names_with_public_suffixes_and_protects_reserved_ids() {
        for (url, expected) in [
            ("https://api.beiapi.cn/v1", "beiapi"),
            ("https://api.example.co.uk/v1", "example"),
            ("https://api.openai.com/v1", "codexbei-openai"),
            ("https://api.custom.com/v1", "codexbei-custom"),
            ("https://127.0.0.1/v1", "127-0-0-1"),
            ("https://localhost/v1", "localhost"),
        ] {
            assert_eq!(name(url).unwrap(), expected);
        }
    }
}
