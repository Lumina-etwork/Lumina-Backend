use axum::{
    extract::{Request, State},
    http::{StatusCode, HeaderMap, HeaderValue},
    middleware::Next,
    response::{Response, IntoResponse},
    routing::get,
    Router,
};
use redis::AsyncCommands;
use sqlx::{PgPool, FromRow};
use std::sync::Arc;

#[derive(Clone)]
struct AppState {
    redis: redis::Client,
    db: PgPool,
}

#[derive(FromRow)]
struct ApiKeyRecord {
    tier: String,
}

struct TierConfig {
    limit: i64,
    refill_rate: f64,
}

fn get_tier_config(tier: &str) -> TierConfig {
    // Tiers: free (10 req/min), pro (100 req/min), enterprise (1000 req/min), internal (10000 req/min)
    match tier {
        "free" => TierConfig { limit: 10, refill_rate: 10.0 / 60.0 },
        "pro" => TierConfig { limit: 100, refill_rate: 100.0 / 60.0 },
        "enterprise" => TierConfig { limit: 1000, refill_rate: 1000.0 / 60.0 },
        "internal" => TierConfig { limit: 10000, refill_rate: 10000.0 / 60.0 },
        _ => TierConfig { limit: 10, refill_rate: 10.0 / 60.0 },
    }
}

async fn rate_limit_middleware(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let api_key = match extract_api_key(&headers) {
        Some(key) => key,
        None => return Err(StatusCode::UNAUTHORIZED),
    };

    let mut redis_conn = state.redis.get_multiplexed_async_connection().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    
    // Load tier configuration from PostgreSQL api_keys table (cached in Redis with 60s TTL)
    let tier_cache_key = format!("apikey_tier:{}", api_key);
    let cached_tier: Option<String> = redis_conn.get(&tier_cache_key).await.unwrap_or(None);
    
    let tier = if let Some(t) = cached_tier {
        t
    } else {
        // Fetch from DB
        let record = sqlx::query_as::<_, ApiKeyRecord>("SELECT tier FROM api_keys WHERE key = ")
            .bind(&api_key)
            .fetch_optional(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            
        let t = record.map(|r| r.tier).unwrap_or_else(|| "free".to_string());
        
        // Cache in Redis for 60s
        let _: () = redis_conn.set_ex(&tier_cache_key, &t, 60).await.unwrap_or(());
        t
    };

    let tier_config = get_tier_config(&tier);
    let limit = tier_config.limit;
    let refill_rate = tier_config.refill_rate;
    
    let endpoint_group = "public"; // default per-endpoint group
    let redis_key = format!("ratelimit:{}:{}", api_key, endpoint_group);
    
    // Implement TokenBucketRateLimiter in Redis: INCR key, EXPIRE key TTL, check count against limit.
    let current_count: i64 = redis::cmd("INCR").arg(&redis_key).query_async(&mut redis_conn).await.unwrap_or(0);
    if current_count == 1 {
        // EXPIRE key TTL
        let _: () = redis::cmd("EXPIRE").arg(&redis_key).arg(60).query_async(&mut redis_conn).await.unwrap_or(());
    }

    if current_count > limit {
        // Return 429 with Retry-After: ceil((current_count - limit) / refill_rate) when exceeded.
        let retry_after = ((current_count as f64 - limit as f64) / refill_rate).ceil() as i64;
        let mut response = StatusCode::TOO_MANY_REQUESTS.into_response();
        response.headers_mut().insert("Retry-After", HeaderValue::from_str(&retry_after.to_string()).unwrap());
        response.headers_mut().insert("X-RateLimit-Limit", HeaderValue::from_str(&limit.to_string()).unwrap());
        response.headers_mut().insert("X-RateLimit-Remaining", HeaderValue::from_str("0").unwrap());
        
        let ttl: i64 = redis::cmd("TTL").arg(&redis_key).query_async(&mut redis_conn).await.unwrap_or(0);
        let reset_time = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64 + ttl;
        response.headers_mut().insert("X-RateLimit-Reset", HeaderValue::from_str(&reset_time.to_string()).unwrap());
        
        // Metrics: rate_limit_hits, rate_limit_exceeded, current_usage per key.
        // Assuming metrics are logged or tracked somewhere, doing a basic print or tracking here.
        println!("rate_limit_exceeded: {}", api_key);
        
        return Ok(response);
    }
    
    let mut response = next.run(request).await;
    
    // Add rate limit headers to all responses
    response.headers_mut().insert("X-RateLimit-Limit", HeaderValue::from_str(&limit.to_string()).unwrap());
    let remaining = limit - current_count;
    response.headers_mut().insert("X-RateLimit-Remaining", HeaderValue::from_str(&remaining.to_string()).unwrap());
    let ttl: i64 = redis::cmd("TTL").arg(&redis_key).query_async(&mut redis_conn).await.unwrap_or(0);
    let reset_time = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64 + ttl;
    response.headers_mut().insert("X-RateLimit-Reset", HeaderValue::from_str(&reset_time.to_string()).unwrap());
    
    // Metrics
    println!("rate_limit_hits: {}, current_usage: {}", api_key, current_count);
    
    Ok(response)
}

fn extract_api_key(headers: &HeaderMap) -> Option<String> {
    // Extract API key from X-API-Key header or JWT claim.
    if let Some(key) = headers.get("X-API-Key").and_then(|h| h.to_str().ok()) {
        return Some(key.to_string());
    }
    
    // Check JWT claim (Authorization: Bearer <token>)
    if let Some(auth_header) = headers.get("Authorization").and_then(|h| h.to_str().ok()) {
        if auth_header.starts_with("Bearer ") {
            let token = &auth_header[7..];
            // Decode JWT without validating signature just to extract claim (for this example)
            // In a real scenario, you MUST validate the signature
            if let Ok(token_data) = jsonwebtoken::decode::<serde_json::Value>(
                token, 
                &jsonwebtoken::DecodingKey::from_secret("secret".as_ref()), 
                &jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256)
            ) {
                if let Some(api_key) = token_data.claims.get("api_key").and_then(|v| v.as_str()) {
                    return Some(api_key.to_string());
                }
            }
        }
    }
    
    None
}

#[tokio::main]
async fn main() {
    let redis_client = redis::Client::open("redis://127.0.0.1/").unwrap();
    let db_pool = PgPool::connect("postgres://postgres:postgres@localhost/db").await.unwrap_or_else(|_| {
        PgPool::connect_lazy("postgres://postgres:postgres@localhost/db").unwrap()
    });

    let state = AppState {
        redis: redis_client,
        db: db_pool,
    };

    let app = Router::new()
        .route("/", get(|| async { "Hello, World!" }))
        .route_layer(axum::middleware::from_fn_with_state(state.clone(), rate_limit_middleware))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
