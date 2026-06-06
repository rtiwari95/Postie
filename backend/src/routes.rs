use crate::http_client;
use crate::models::*;
use crate::storage::Store;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post, put},
    Json, Router,
};
use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

pub fn router(store: Store) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/execute", post(execute))
        .route("/workspace", get(get_workspace))
        .route("/collections", post(create_collection))
        .route("/collections/:id", put(update_collection).delete(delete_collection))
        .route("/collections/:id/requests", post(add_request))
        .route(
            "/collections/:cid/requests/:rid",
            put(update_request).delete(delete_request),
        )
        .route("/environments", post(create_environment))
        .route(
            "/environments/:id",
            put(update_environment).delete(delete_environment),
        )
        .route("/environments/active", post(set_active_environment))
        .route("/proxy", put(set_proxy))
        .route("/history", delete(clear_history))
        .with_state(store)
}

fn err(msg: impl Into<String>) -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg.into() })))
}

async fn execute(
    State(store): State<Store>,
    Json(req): Json<ExecuteRequest>,
) -> impl IntoResponse {
    let proxy = store.read(|w| w.proxy.clone());
    let result = http_client::execute(&req, Some(&proxy)).await;

    let history = HistoryEntry {
        id: Uuid::new_v4().to_string(),
        timestamp: Utc::now(),
        request: req.clone(),
        response_status: result.as_ref().ok().map(|r| r.status),
        elapsed_ms: result
            .as_ref()
            .map(|r| r.elapsed_ms)
            .unwrap_or(0),
        error: result.as_ref().err().cloned(),
    };

    let _ = store.write(|w| {
        w.history.insert(0, history);
        if w.history.len() > 200 {
            w.history.truncate(200);
        }
    });

    match result {
        Ok(resp) => (StatusCode::OK, Json(json!(resp))).into_response(),
        Err(e) => (StatusCode::OK, Json(json!({ "error": e }))).into_response(),
    }
}

async fn get_workspace(State(store): State<Store>) -> impl IntoResponse {
    let ws = store.read(|w| w.clone());
    Json(ws)
}

async fn create_collection(
    State(store): State<Store>,
    Json(payload): Json<Collection>,
) -> impl IntoResponse {
    let mut c = payload;
    if c.id.is_empty() {
        c.id = Uuid::new_v4().to_string();
    }
    let stored = c.clone();
    store.write(|w| w.collections.push(c)).unwrap();
    Json(stored)
}

async fn update_collection(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(payload): Json<Collection>,
) -> impl IntoResponse {
    let res = store.write(|w| {
        if let Some(c) = w.collections.iter_mut().find(|c| c.id == id) {
            *c = Collection { id: id.clone(), ..payload };
            true
        } else {
            false
        }
    });
    match res {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        _ => err("collection not found").into_response(),
    }
}

async fn delete_collection(
    State(store): State<Store>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    store.write(|w| w.collections.retain(|c| c.id != id)).unwrap();
    Json(json!({ "ok": true }))
}

async fn add_request(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(mut req): Json<SavedRequest>,
) -> impl IntoResponse {
    if req.id.is_empty() {
        req.id = Uuid::new_v4().to_string();
    }
    let res = store.write(|w| {
        if let Some(c) = w.collections.iter_mut().find(|c| c.id == id) {
            c.requests.push(req.clone());
            Some(req)
        } else {
            None
        }
    });
    match res {
        Ok(Some(r)) => Json(json!(r)).into_response(),
        _ => err("collection not found").into_response(),
    }
}

async fn update_request(
    State(store): State<Store>,
    Path((cid, rid)): Path<(String, String)>,
    Json(payload): Json<SavedRequest>,
) -> impl IntoResponse {
    let res = store.write(|w| {
        if let Some(c) = w.collections.iter_mut().find(|c| c.id == cid) {
            if let Some(r) = c.requests.iter_mut().find(|r| r.id == rid) {
                *r = SavedRequest { id: rid.clone(), ..payload };
                return true;
            }
        }
        false
    });
    match res {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        _ => err("not found").into_response(),
    }
}

async fn delete_request(
    State(store): State<Store>,
    Path((cid, rid)): Path<(String, String)>,
) -> impl IntoResponse {
    store
        .write(|w| {
            if let Some(c) = w.collections.iter_mut().find(|c| c.id == cid) {
                c.requests.retain(|r| r.id != rid);
            }
        })
        .unwrap();
    Json(json!({ "ok": true }))
}

async fn create_environment(
    State(store): State<Store>,
    Json(payload): Json<Environment>,
) -> impl IntoResponse {
    let mut e = payload;
    if e.id.is_empty() {
        e.id = Uuid::new_v4().to_string();
    }
    let stored = e.clone();
    store.write(|w| w.environments.push(e)).unwrap();
    Json(stored)
}

async fn update_environment(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(payload): Json<Environment>,
) -> impl IntoResponse {
    let res = store.write(|w| {
        if let Some(e) = w.environments.iter_mut().find(|e| e.id == id) {
            *e = Environment { id: id.clone(), ..payload };
            true
        } else {
            false
        }
    });
    match res {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        _ => err("environment not found").into_response(),
    }
}

async fn delete_environment(
    State(store): State<Store>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    store
        .write(|w| {
            w.environments.retain(|e| e.id != id);
            if w.active_environment_id.as_deref() == Some(&id) {
                w.active_environment_id = None;
            }
        })
        .unwrap();
    Json(json!({ "ok": true }))
}

#[derive(serde::Deserialize)]
struct ActiveEnvPayload {
    id: Option<String>,
}

async fn set_active_environment(
    State(store): State<Store>,
    Json(payload): Json<ActiveEnvPayload>,
) -> impl IntoResponse {
    store.write(|w| w.active_environment_id = payload.id).unwrap();
    Json(json!({ "ok": true }))
}

async fn set_proxy(
    State(store): State<Store>,
    Json(payload): Json<ProxyConfig>,
) -> impl IntoResponse {
    store.write(|w| w.proxy = payload).unwrap();
    Json(json!({ "ok": true }))
}

async fn clear_history(State(store): State<Store>) -> impl IntoResponse {
    store.write(|w| w.history.clear()).unwrap();
    Json(json!({ "ok": true }))
}
