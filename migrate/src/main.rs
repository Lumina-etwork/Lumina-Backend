use clap::{Parser, Subcommand};
use regex::Regex;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;
use tokio_postgres::{Client, NoTls};

#[derive(Parser)]
#[command(name = "migrate")]
#[command(about = "Database Migration Versioning with Rollback and Dry-Run Support")]
struct Cli {
    #[arg(short, long, default_value = "migrations")]
    dir: PathBuf,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Apply {
        #[arg(long)]
        allow_data_loss: bool,
    },
    Rollback {
        n: usize,
    },
    DryRun {
        #[arg(long)]
        allow_data_loss: bool,
    },
    Status,
}

#[derive(Debug, Clone)]
struct Migration {
    version: String,
    description: String,
    path: PathBuf,
    is_forward: bool,
}

async fn get_client() -> Result<Client, tokio_postgres::Error> {
    let url = env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://postgres:postgres@localhost:5432/lumina".to_string());
    let (client, connection) = tokio_postgres::connect(&url, NoTls).await?;
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("connection error: {}", e);
        }
    });
    Ok(client)
}

async fn ensure_schema_migrations(client: &mut Client) -> Result<(), tokio_postgres::Error> {
    client.batch_execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version VARCHAR(255) PRIMARY KEY,
            applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            checksum VARCHAR(255),
            duration_ms BIGINT
        )"
    ).await
}

fn scan_migrations(dir: &PathBuf) -> Vec<Migration> {
    let mut migrations = Vec::new();
    let re = Regex::new(r"^(V|U)([a-zA-Z0-9\.]+)__(.+)\.sql$").unwrap();

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if let Some(caps) = re.captures(name) {
                        let prefix = caps.get(1).unwrap().as_str();
                        let version = caps.get(2).unwrap().as_str().to_string();
                        let description = caps.get(3).unwrap().as_str().to_string();
                        migrations.push(Migration {
                            version,
                            description,
                            path,
                            is_forward: prefix == "V",
                        });
                    }
                }
            }
        }
    }
    migrations
}

fn contains_dml(sql: &str) -> bool {
    let sql_upper = sql.to_uppercase();
    sql_upper.contains("INSERT ") || 
    sql_upper.contains("UPDATE ") || 
    sql_upper.contains("DELETE ") || 
    sql_upper.contains("TRUNCATE ")
}

async fn apply_migrations(client: &mut Client, migrations: Vec<Migration>, allow_data_loss: bool) -> Result<(), Box<dyn std::error::Error>> {
    let mut forwards: Vec<_> = migrations.into_iter().filter(|m| m.is_forward).collect();
    forwards.sort_by(|a, b| a.version.cmp(&b.version));

    let rows = client.query("SELECT version FROM schema_migrations", &[]).await?;
    let applied: Vec<String> = rows.iter().map(|r| r.get("version")).collect();

    for m in forwards {
        if applied.contains(&m.version) {
            continue;
        }

        println!("Applying: V{}__{}", m.version, m.description);
        let sql = fs::read_to_string(&m.path)?;
        
        if contains_dml(&sql) && !allow_data_loss {
            return Err("Migration contains DML, but --allow-data-loss not provided".into());
        }

        let start = Instant::now();
        
        let tx = client.transaction().await?;
        
        let res = tokio::time::timeout(std::time::Duration::from_secs(300), tx.batch_execute(&sql)).await;
        if res.is_err() {
            tx.rollback().await?;
            return Err(format!("Migration {} timed out after 5 minutes", m.version).into());
        }
        res.unwrap()?;
        
        let duration_ms = start.elapsed().as_millis() as i64;
        tx.execute(
            "INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)",
            &[&m.version, &"TODO".to_string(), &duration_ms]
        ).await?;
        
        tx.commit().await?;
        println!("Successfully applied V{} in {}ms", m.version, duration_ms);
    }
    Ok(())
}

async fn rollback_migrations(client: &mut Client, migrations: Vec<Migration>, n: usize) -> Result<(), Box<dyn std::error::Error>> {
    let mut backwards: Vec<_> = migrations.into_iter().filter(|m| !m.is_forward).collect();
    
    let rows = client.query("SELECT version FROM schema_migrations ORDER BY version DESC", &[]).await?;
    let mut applied: Vec<String> = rows.iter().map(|r| r.get("version")).collect();
    
    applied.truncate(n);
    
    for version in applied {
        if let Some(m) = backwards.iter().find(|m| m.version == version) {
            println!("Rolling back: U{}__{}", m.version, m.description);
            let sql = fs::read_to_string(&m.path)?;
            
            let tx = client.transaction().await?;
            tx.batch_execute(&sql).await?;
            
            tx.execute("DELETE FROM schema_migrations WHERE version = $1", &[&m.version]).await?;
            tx.commit().await?;
            println!("Successfully rolled back U{}", m.version);
        } else {
            return Err(format!("Rollback file for version {} not found", version).into());
        }
    }
    Ok(())
}

async fn dry_run_migrations(client: &mut Client, migrations: Vec<Migration>, allow_data_loss: bool) -> Result<(), Box<dyn std::error::Error>> {
    let mut forwards: Vec<_> = migrations.into_iter().filter(|m| m.is_forward).collect();
    forwards.sort_by(|a, b| a.version.cmp(&b.version));

    let rows = client.query("SELECT version FROM schema_migrations", &[]).await?;
    let applied: Vec<String> = rows.iter().map(|r| r.get("version")).collect();

    for m in forwards {
        if applied.contains(&m.version) {
            continue;
        }

        println!("Dry run for: V{}__{}", m.version, m.description);
        let sql = fs::read_to_string(&m.path)?;
        
        if contains_dml(&sql) && !allow_data_loss {
            return Err("Migration contains DML, but --allow-data-loss not provided".into());
        }

        let tx = client.transaction().await?;
        tx.batch_execute(&sql).await?;
        println!("Planned to apply: V{}__{}\n{}", m.version, m.description, sql);
        
        tx.rollback().await?;
    }
    Ok(())
}

async fn status_migrations(client: &mut Client, migrations: Vec<Migration>) -> Result<(), Box<dyn std::error::Error>> {
    let mut forwards: Vec<_> = migrations.into_iter().filter(|m| m.is_forward).collect();
    forwards.sort_by(|a, b| a.version.cmp(&b.version));

    let rows = client.query("SELECT version, applied_at FROM schema_migrations", &[]).await?;
    let applied: Vec<String> = rows.iter().map(|r| r.get("version")).collect();

    println!("{:<10} | {:<40} | {}", "Version", "Description", "Status");
    println!("{:-<10}-+-{:-<40}-+-{:-<10}", "", "", "");
    
    for m in forwards {
        let status = if applied.contains(&m.version) { "Applied" } else { "Pending" };
        println!("{:<10} | {:<40} | {}", m.version, m.description, status);
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let mut client = get_client().await?;
    ensure_schema_migrations(&mut client).await?;

    let migrations = scan_migrations(&cli.dir);

    match cli.command {
        Commands::Apply { allow_data_loss } => {
            apply_migrations(&mut client, migrations, allow_data_loss).await?;
        }
        Commands::Rollback { n } => {
            rollback_migrations(&mut client, migrations, n).await?;
        }
        Commands::DryRun { allow_data_loss } => {
            dry_run_migrations(&mut client, migrations, allow_data_loss).await?;
        }
        Commands::Status => {
            status_migrations(&mut client, migrations).await?;
        }
    }
    Ok(())
}
