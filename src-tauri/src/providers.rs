use crate::config::{endpoint, Result};
use toml_edit::DocumentMut;

pub fn base(doc: &DocumentMut, id: &str) -> Option<String> {
    doc.get("model_providers")?
        .get(id)?
        .get("base_url")?
        .as_str()
        .and_then(|s| endpoint(s).ok())
}

// Keep the provider ID stable: local conversations are associated with it.
pub fn for_write(doc: &DocumentMut, base_url: &str) -> Result<String> {
    endpoint(base_url)?;
    if doc
        .get("model_providers")
        .is_some_and(|v| v.as_table_like().is_none())
    {
        return Err("model_providers 必须是 TOML 表。".into());
    }
    Ok("custom".into())
}

pub fn for_read(doc: &DocumentMut, base_url: &str) -> Option<String> {
    (base(doc, "custom").as_deref() == Some(base_url)).then(|| "custom".into())
}
