use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyValue {
    pub key: String,
    pub value: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "kind")]
pub enum FormPart {
    Text {
        key: String,
        value: String,
        #[serde(default = "default_true")]
        enabled: bool,
    },
    File {
        key: String,
        path: String,
        #[serde(default)]
        filename: Option<String>,
        #[serde(default)]
        content_type: Option<String>,
        #[serde(default = "default_true")]
        enabled: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "type", content = "content")]
pub enum Body {
    None,
    Text(String),
    Json(String),
    Xml(String),
    Form(Vec<KeyValue>),
    Urlencoded(Vec<KeyValue>),
    /// Multipart form-data with a mix of text and file parts.
    FormData(Vec<FormPart>),
    /// Single binary file body (sends raw bytes).
    Binary(BinaryBody),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryBody {
    pub path: String,
    #[serde(default)]
    pub content_type: Option<String>,
}

impl Default for Body {
    fn default() -> Self {
        Body::None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecuteRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<KeyValue>,
    #[serde(default)]
    pub query: Vec<KeyValue>,
    #[serde(default)]
    pub body: Body,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub follow_redirects: Option<bool>,
    /// Renderer-side auth config; persisted with saved requests but not
    /// applied by the backend (the renderer bakes auth into headers/query
    /// before calling /execute).
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub auth: serde_json::Value,
    /// Renderer-side post-response test script. Persisted with saved requests
    /// so chaining/assertion logic survives reload, but not interpreted by the
    /// backend in any way.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tests: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecuteResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub body_is_base64: bool,
    pub elapsed_ms: u128,
    pub size_bytes: usize,
    pub final_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub request: ExecuteRequest,
    pub response_status: Option<u16>,
    pub elapsed_ms: u128,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedRequest {
    pub id: String,
    pub name: String,
    pub request: ExecuteRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collection {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub requests: Vec<SavedRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Environment {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub variables: Vec<KeyValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProxyConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub bypass: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Workspace {
    #[serde(default)]
    pub collections: Vec<Collection>,
    #[serde(default)]
    pub environments: Vec<Environment>,
    #[serde(default)]
    pub active_environment_id: Option<String>,
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
    #[serde(default)]
    pub proxy: ProxyConfig,
}
