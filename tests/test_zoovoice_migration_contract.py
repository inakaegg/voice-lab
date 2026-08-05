import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


def test_zoovoice_migration_adds_its_table_without_changing_existing_schema_or_data() -> None:
    connection = sqlite3.connect(":memory:")
    for name in (
        "0001_public_demo_storage.sql",
        "0002_public_samples.sql",
        "0003_public_user_email.sql",
    ):
        connection.executescript((MIGRATIONS / name).read_text(encoding="utf-8"))
    connection.execute(
        """
        INSERT INTO public_users (
          email_hash, created_at, last_seen_at, email, last_login_at
        ) VALUES (?, ?, ?, ?, ?)
        """,
        ("hash-1", "2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z", "user@example.com", "2026-08-02T00:00:00Z"),
    )
    connection.commit()
    schema_before = _schema(connection)
    users_before = connection.execute("SELECT * FROM public_users ORDER BY email_hash").fetchall()

    zoovoice_migration = (MIGRATIONS / "0004_zoovoice_usage_counters.sql").read_text(encoding="utf-8")
    connection.executescript(zoovoice_migration)
    connection.executescript(zoovoice_migration)

    schema_after = _schema(connection)
    assert schema_after | schema_before == schema_after
    assert {name: sql for name, sql in schema_after.items() if name in schema_before} == schema_before
    assert connection.execute("SELECT * FROM public_users ORDER BY email_hash").fetchall() == users_before
    assert [
        (row[1], row[2], row[3], row[5])
        for row in connection.execute("PRAGMA table_info(zoovoice_usage_counters)")
    ] == [
        ("feature", "TEXT", 0, 1),
        ("usage_date", "TEXT", 1, 0),
        ("daily_count", "INTEGER", 1, 0),
        ("usage_month", "TEXT", 1, 0),
        ("monthly_count", "INTEGER", 1, 0),
        ("updated_at", "TEXT", 1, 0),
    ]


def _schema(connection: sqlite3.Connection) -> dict[str, str]:
    return {
        name: sql
        for name, sql in connection.execute(
            """
            SELECT name, sql
            FROM sqlite_master
            WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
            ORDER BY type, name
            """
        )
    }
