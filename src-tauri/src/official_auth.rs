use serde_json::Value;
use std::{fs::File, io::Read, path::Path};

// Presence check only: credentials never leave the backend and are not refreshed.
pub fn detected(config_file: &Path) -> bool {
    let Some(parent) = config_file.parent() else {
        return false;
    };
    let Ok(file) = File::open(parent.join("auth.json")) else {
        return false;
    };
    if !file.metadata().is_ok_and(|meta| meta.is_file()) {
        return false;
    }
    const MAX_BYTES: u64 = 1024 * 1024;
    let mut bytes = Vec::new();
    if file.take(MAX_BYTES + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > MAX_BYTES {
        return false;
    }
    let Ok(auth) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    let present = |value: &Value| value.as_str().is_some_and(|text| !text.trim().is_empty());
    let tokens = &auth["tokens"];
    match auth["auth_mode"].as_str() {
        None | Some("chatgpt") => {
            present(&tokens["id_token"])
                && present(&tokens["access_token"])
                && present(&tokens["refresh_token"])
        }
        Some("chatgptAuthTokens") => {
            present(&tokens["access_token"])
                && (present(&tokens["id_token"]) || present(&tokens["account_id"]))
        }
        Some("personalAccessToken") => present(&auth["personal_access_token"]),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[test]
    fn detects_official_credentials_in_the_selected_config_directory_without_writes() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        let tokens = json!({"id_token":"fixture-id", "access_token":"fixture-access", "refresh_token":"fixture-refresh"});
        for mode in [Value::Null, json!("chatgpt"), json!("chatgptAuthTokens")] {
            let bytes = serde_json::to_vec(&json!({"auth_mode":mode, "tokens":tokens})).unwrap();
            fs::write(first.join("auth.json"), &bytes).unwrap();
            assert!(detected(&first.join("config.toml")));
            assert!(!detected(&second.join("config.toml")));
            assert_eq!(fs::read(first.join("auth.json")).unwrap(), bytes);
            assert!(!first.join("config.toml").exists());
        }
    }

    #[test]
    fn missing_invalid_empty_or_api_only_auth_does_not_count_as_official_login() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("config.toml");
        let auth = root.path().join("auth.json");
        assert!(!detected(&config));
        for bytes in [
            "",
            "not json",
            "null",
            "{}",
            r#"{"OPENAI_API_KEY":"fixture-api-key"}"#,
            r#"{"auth_mode":"chatgpt","tokens":{}}"#,
            r#"{"tokens":{"id_token":"id","access_token":" ","refresh_token":"refresh"}}"#,
            r#"{"tokens":{"access_token":"access","refresh_token":"refresh"}}"#,
            r#"{"auth_mode":"apikey","tokens":{"id_token":"id","access_token":"access","refresh_token":"refresh"}}"#,
        ] {
            fs::write(&auth, bytes).unwrap();
            assert!(!detected(&config));
            assert_eq!(fs::read_to_string(&auth).unwrap(), bytes);
        }
        fs::write(&auth, vec![b' '; 1024 * 1024 + 1]).unwrap();
        assert!(!detected(&config));
        fs::remove_file(&auth).unwrap();
        fs::create_dir(&auth).unwrap();
        assert!(!detected(&config));
    }
}
