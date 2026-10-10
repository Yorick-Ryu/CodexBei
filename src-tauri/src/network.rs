use crate::config::Result;
use serde_json::Value;
use std::time::Duration;
pub fn client() -> Result<reqwest::Client> {
    build_client(true)
}
pub fn api_client() -> Result<reqwest::Client> {
    build_client(false)
}
fn build_client(https_only: bool) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .https_only(https_only)
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化安全网络请求。".into())
}
pub async fn bounded_json(mut response: reqwest::Response, limit: usize) -> Result<Value> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("响应内容过大。".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "网络响应中断。".to_string())?
    {
        if bytes.len() + chunk.len() > limit {
            return Err("响应内容过大。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "响应格式无效。".into())
}
pub fn model_list(value: &Value) -> Result<Vec<String>> {
    let models = value["models"]
        .as_array()
        .filter(|v| v.len() <= 5000)
        .ok_or_else(|| "模型列表格式无效。".to_string())?;
    if value
        .get("error")
        .is_some_and(|v| !v.is_null() && v != &Value::Bool(false))
        || value["success"] == false
    {
        return Err("模型列表获取失败。".into());
    }
    let mut result = Vec::new();
    for model in models
        .iter()
        .filter(|v| v["visibility"] == "list" && v["supported_in_api"] == true)
    {
        let id = crate::config::model(model["slug"].as_str().unwrap_or_default())?;
        if !result.contains(&id) {
            result.push(id);
        }
    }
    Ok(result)
}
pub async fn models(
    client: &reqwest::Client,
    connection: crate::config::Connection,
    version: &str,
) -> Result<Vec<String>> {
    model_list(&catalog(client, connection, version).await?)
}
pub async fn catalog(
    client: &reqwest::Client,
    connection: crate::config::Connection,
    version: &str,
) -> Result<Value> {
    if !crate::versions::valid_version(version) {
        return Err("请先选择 Codex 内核版本。".into());
    }
    let url = format!("{}/models", crate::config::endpoint(&connection.base_url)?);
    let client = if url.starts_with("http://") {
        api_client()?
    } else {
        client.clone()
    };
    let response = client
        .get(url)
        .query(&[("client_version", version)])
        .bearer_auth(crate::config::key(&connection.api_key)?)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| "模型列表获取失败，请稍后重试。".to_string())?;
    if [401, 403].contains(&response.status().as_u16()) {
        return Err("无法获取模型，请检查密钥及访问权限。".into());
    }
    if !response.status().is_success() {
        return Err("模型列表获取失败，请稍后重试。".into());
    }
    let value = bounded_json(response, 1024 * 1024)
        .await
        .map_err(|_| "模型列表获取失败，请稍后重试。".to_string())?;
    if model_list(&value)?.is_empty() {
        return Err("没有可用模型，已保留原配置。".into());
    }
    Ok(value)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_accepts_http_api_with_https_default_client() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).unwrap();
                assert_ne!(count, 0);
                request.extend_from_slice(&buffer[..count]);
            }
            assert!(String::from_utf8(request)
                .unwrap()
                .starts_with("GET /v1/models?client_version=0.154.0 HTTP/1.1"));
            let body = r#"{"models":[{"slug":"gpt-6-astra","visibility":"list","supported_in_api":true}]}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let value = runtime
            .block_on(catalog(
                &client().unwrap(),
                crate::config::Connection {
                    base_url: format!("http://{address}/v1"),
                    api_key: "sk-http-test-fixture-only".into(),
                    model: "gpt-6-astra".into(),
                },
                "0.154.0",
            ))
            .unwrap();
        server.join().unwrap();
        assert_eq!(model_list(&value).unwrap(), vec!["gpt-6-astra"]);
    }
    #[test]
    fn accepts_only_visible_api_models() {
        let v = serde_json::json!({"models":[{"slug":"gpt-6-astra","visibility":"list","supported_in_api":true},{"slug":"hidden","visibility":"hidden","supported_in_api":true},{"slug":"gpt-6-astra","visibility":"list","supported_in_api":true}]});
        assert_eq!(model_list(&v).unwrap(), vec!["gpt-6-astra"]);
        assert!(model_list(&serde_json::json!({"data":[]})).is_err());
    }
}
