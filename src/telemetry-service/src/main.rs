use axum::{
    routing::{get, post},
    Router,
    extract::State,
};
use std::sync::Arc;
use tokio::net::TcpListener;
use tracing::{info, instrument, span, Level};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use opentelemetry::{
    global,
    trace::{TraceContextExt, Tracer, TraceError},
    KeyValue,
};
use opentelemetry_sdk::{
    trace::{self, RandomIdGenerator, Sampler},
    Resource,
};
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_semantic_conventions::resource;

struct AppState {
    db: sqlx::PgPool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Initialize OpenTelemetry Exporter & Tracer
    let tracer = init_tracer()?;

    // 2. Initialize tracing subscriber with OpenTelemetry
    let telemetry = tracing_opentelemetry::layer().with_tracer(tracer);
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("INFO"))
        .with(telemetry)
        .init();

    info!("Starting telemetry service");

    // Initialize mock database pool
    let db = sqlx::PgPoolOptions::new()
        .max_connections(5)
        .connect("postgres://postgres:password@localhost/telemetry").await
        .unwrap_or_else(|_| sqlx::PgPoolOptions::new().connect_lazy("postgres://postgres:password@localhost/telemetry").unwrap());
        
    let state = Arc::new(AppState { db });

    let app = Router::new()
        .route("/ingest", post(ingest_telemetry_handler))
        .route("/tariff", get(evaluate_tariff_handler))
        .route("/settlement", post(submit_settlement_handler))
        .with_state(state);

    let listener = TcpListener::bind("0.0.0.0:8080").await?;
    axum::serve(listener, app).await?;

    // Shutdown tracer provider
    global::shutdown_tracer_provider();

    Ok(())
}

fn init_tracer() -> Result<opentelemetry_sdk::trace::Tracer, TraceError> {
    opentelemetry_otlp::new_pipeline()
        .tracing()
        .with_exporter(
            opentelemetry_otlp::new_exporter()
                .grpc()
                .with_endpoint("http://otel-collector:4317"),
        )
        .with_trace_config(
            trace::config()
                .with_sampler(Sampler::TraceIdRatioBased(0.01)) // 1% sampling
                .with_id_generator(RandomIdGenerator::default())
                .with_resource(Resource::new(vec![
                    KeyValue::new(resource::SERVICE_NAME, "telemetry-service"),
                    KeyValue::new(resource::SERVICE_VERSION, "1.0.0"),
                ])),
        )
        .install_batch(opentelemetry_sdk::runtime::Tokio)
}

#[instrument(skip(state))]
async fn ingest_telemetry_handler(State(state): State<Arc<AppState>>) -> &'static str {
    ingestTelemetry(&state.db).await;
    "Telemetry Ingested"
}

#[instrument(skip(db))]
async fn ingestTelemetry(db: &sqlx::PgPool) {
    info!("Ingesting telemetry data");
    // Database query instrumentation
    let _ = sqlx::query("SELECT 1").execute(db).await;
}

#[instrument(skip(state))]
async fn evaluate_tariff_handler(State(state): State<Arc<AppState>>) -> &'static str {
    evaluateTariff().await;
    "Tariff Evaluated"
}

#[instrument]
async fn evaluateTariff() {
    info!("Evaluating tariff");
}

#[instrument(skip(state))]
async fn submit_settlement_handler(State(state): State<Arc<AppState>>) -> &'static str {
    submitSettlement().await;
    "Settlement Submitted"
}

#[instrument]
async fn submitSettlement() {
    info!("Submitting settlement");
}
