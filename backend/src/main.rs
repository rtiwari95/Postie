mod http_client;
mod storage;
mod models;
mod routes;

use axum::Router;
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let store = storage::Store::open()?;

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app: Router = routes::router(store).layer(cors);

    let port: u16 = std::env::var("POSTIE_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;

    // Print the bound port on stdout so Electron can read it.
    println!("POSTIE_BACKEND_READY {}", bound.port());

    tracing::info!("postie-backend listening on {bound}");
    axum::serve(listener, app).await?;
    Ok(())
}
