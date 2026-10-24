use urbanflip_backend::api::{routes, state};
use urbanflip_backend::gate_now;

#[tokio::main]
async fn main() {
    let config = urbanflip_backend::Config::from_env();
    let bind = config.bind.clone();
    let addr = state::build_state(config);
    let app = routes::router(addr);
    println!("[{}] urbanflip-backend listening on {bind}", gate_now());
    let listener = tokio::net::TcpListener::bind(&bind).await.expect("bind failed");
    axum::serve(listener, app).await.expect("server error");
}
