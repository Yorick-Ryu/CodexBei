use crate::{
    config::{Result, Store},
    network,
};
use serde_json::{json, Value};

pub enum Source {
    Official(std::path::PathBuf),
    Api(crate::config::Connection),
}
pub fn source(store: &Store, channel: &str) -> Result<Source> {
    let info = store.inspect()?;
    if channel == "official" {
        Ok(Source::Official(store.selected.with_file_name("auth.json")))
    } else if channel == "api" {
        Ok(Source::Api(store.credentials(
            "",
            info["baseUrl"].as_str().ok_or("请先完成 API 配置。")?,
        )?))
    } else {
        Err("未知额度来源。".into())
    }
}
async fn get(
    client: &reqwest::Client,
    url: &str,
    key: Option<&str>,
    account: Option<&str>,
) -> Result<Value> {
    let mut req = client.get(url);
    if let Some(key) = key {
        req = req.bearer_auth(key);
    }
    if let Some(account) = account {
        req = req.header("ChatGPT-Account-Id", account);
    }
    let response = req.send().await.map_err(|_| "额度查询失败，请稍后刷新。")?;
    if response.status() == 401 {
        return Err("登录或密钥已失效，请重新登录或配置。".into());
    }
    if !response.status().is_success() {
        return Err("暂时无法获取额度，请稍后刷新。".into());
    }
    network::bounded_json(response, 256 * 1024).await
}
pub fn official(value: &Value) -> Result<Value> {
    let mut rows = Vec::new();
    for field in ["primary_window", "secondary_window"] {
        let window = &value["rate_limit"][field];
        if let Some(used) = window["used_percent"].as_f64() {
            let seconds = window["limit_window_seconds"].as_u64().unwrap_or(0);
            let label = match seconds {
                18000 => "5 小时额度".to_owned(),
                604800 => "每周额度".to_owned(),
                0 => "用量额度".to_owned(),
                n => format!("{} 小时额度", n as f64 / 3600.0),
            };
            rows.push(json!({"label":label,"value":format!("剩余 {:.0}%", (100.0-used).clamp(0.0,100.0)),"remaining":(100.0-used).clamp(0.0,100.0),"resetAt":window["reset_at"]}));
        }
    }
    if rows.is_empty() {
        return Err("官方暂未返回额度信息。".into());
    }
    Ok(json!({"channel":"official","rows":rows,"planType":value["plan_type"]}))
}
pub async fn query(source: Source) -> Result<Value> {
    let client = network::client()?;
    match source {
        Source::Official(path) => {
            let bytes = std::fs::read(path).map_err(|_| {
                "未找到官方登录信息，请先在 Codex 登录；系统钥匙串登录暂不支持读取。"
            })?;
            let auth: Value =
                serde_json::from_slice(&bytes).map_err(|_| "无法读取官方登录信息，请重新登录。")?;
            let token = auth["tokens"]["access_token"]
                .as_str()
                .ok_or("请先在 Codex 登录官方账号。")?;
            let value = get(
                &client,
                "https://chatgpt.com/backend-api/wham/usage",
                Some(token),
                auth["tokens"]["account_id"].as_str(),
            )
            .await?;
            official(&value)
        }
        Source::Api(connection) => {
            let client = network::api_client()?;
            let base = crate::config::endpoint(&connection.base_url)?;
            let root = base.strip_suffix("/v1").unwrap_or(&base);
            let value = get(
                &client,
                &format!("{root}/api/usage/quota"),
                Some(&connection.api_key),
                None,
            )
            .await?;
            site_snapshot(&value)
        }
    }
}
fn amount(raw: f64, unit: &Value) -> String {
    let divisor = unit["quota_per_unit"].as_f64().filter(|n| *n > 0.0);
    match (unit["display_type"].as_str(), divisor) {
        (Some("USD"), Some(d)) => format!("${:.2}", raw / d),
        (Some("CNY"), Some(d)) if unit["usd_exchange_rate"].as_f64().is_some() => format!(
            "¥{:.2}",
            raw / d * unit["usd_exchange_rate"].as_f64().unwrap()
        ),
        _ => format!("{raw:.0} 额度单位"),
    }
}
fn site_snapshot(value: &Value) -> Result<Value> {
    let data = &value["data"];
    if value["success"] != true || data["object"] != "quota_snapshot" {
        return Err("站内额度响应无效。".into());
    }
    let unit = &data["unit"];
    let wallet = data["wallet"]["remaining"]
        .as_f64()
        .ok_or("余额响应无效。")?;
    let token = if data["token"]["unlimited"] == true {
        "不限".to_owned()
    } else {
        amount(
            data["token"]["remaining"]
                .as_f64()
                .ok_or("Key 额度响应无效。")?,
            unit,
        )
    };
    let mut groups = Vec::new();
    for sub in data["subscriptions"].as_array().ok_or("套餐响应无效。")? {
        let mut rows = Vec::new();
        for w in sub["windows"].as_array().ok_or("套餐窗口响应无效。")? {
            let label = match w["window_duration_seconds"].as_i64() {
                Some(18000) => "5 小时额度",
                Some(604800) => "每周额度",
                _ => w["name"].as_str().unwrap_or("额度"),
            };
            let text = if w["unlimited"] == true {
                "不限额".to_owned()
            } else {
                format!(
                    "{} / {}",
                    amount(w["remaining"].as_f64().ok_or("套餐剩余额度无效。")?, unit),
                    amount(w["total"].as_f64().ok_or("套餐总额度无效。")?, unit)
                )
            };
            rows.push(json!({"label":label,"value":text,
                "remaining": w["used_percent"].as_f64().map(|v| (100.0-v).clamp(0.0,100.0)),
                "resetAt":w["resets_at"],"resetPending":w["reset_pending"]}));
        }
        groups.push(
            json!({"id":sub["id"],"title":sub["name"],"expiresAt":sub["expires_at"],"rows":rows}),
        );
    }
    Ok(
        json!({"channel":"api","rows":[{"label":"余额","value":amount(wallet,unit)},{"label":"密钥余额","value":token}],"groups":groups}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_site_windows_and_unlimited_without_merging_plans() {
        let value = json!({"success":true,"data":{"object":"quota_snapshot","unit":{"display_type":"USD","quota_per_unit":500000},"wallet":{"remaining":64250000},"token":{"unlimited":true,"remaining":null},"subscriptions":[{"id":1,"name":"Plus 月卡","expires_at":123,"windows":[{"name":"主额度","window_duration_seconds":18000,"remaining":12000000,"total":15000000,"used_percent":20,"resets_at":456,"reset_pending":false}]},{"id":2,"name":"Ultra 月卡","windows":[{"name":"周额度","window_duration_seconds":604800,"remaining":480000000,"total":600000000,"used_percent":20,"reset_pending":true}]}]}});
        let parsed = site_snapshot(&value).unwrap();
        assert_eq!(parsed["rows"][0]["value"], "$128.50");
        assert_eq!(parsed["rows"][1]["value"], "不限");
        assert_eq!(parsed["groups"].as_array().unwrap().len(), 2);
        assert_eq!(parsed["groups"][0]["rows"][0]["value"], "$24.00 / $30.00");
        assert_eq!(parsed["groups"][1]["rows"][0]["remaining"], 80.0);
        assert_eq!(parsed["groups"][1]["rows"][0]["resetPending"], true);
        assert!(site_snapshot(&json!({"success":false})).is_err());
    }
    #[test]
    fn parses_windows_without_inventing_balance() {
        let result = official(&json!({"rate_limit":{"primary_window":{"used_percent":25,"limit_window_seconds":18000,"reset_at":123},"secondary_window":{"used_percent":110,"limit_window_seconds":604800}}})).unwrap();
        assert_eq!(result["rows"][0]["remaining"], 75.0);
        assert_eq!(result["rows"][1]["remaining"], 0.0);
        assert_eq!(result["rows"][0]["resetAt"], 123);
        assert!(official(&json!({})).is_err());
    }
}
