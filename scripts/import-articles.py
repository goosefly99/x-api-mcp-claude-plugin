"""
import-articles.py

Populates the articles table from all x-posts JSON data files.

Sources (processed in priority order — longer content wins on conflict):
  1. bookmarks.json              — is_article tweets, full body text
  2. trading_strategies.json     — has_article_content posts, full content text
  3. agent_methods_x_posts.json  — has_article posts, raw_excerpt text

Run:
    python scripts/import-articles.py
"""

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path("W:/x_posts_db/x-data.db")

FILES = {
    "bookmarks":         Path("C:/Users/olive/Documents/x_posts/bookmarks.json"),
    "trading":           Path("C:/Users/olive/Documents/x_posts/trading_strategies.json"),
    "agent_methods":     Path("C:/Users/olive/Documents/x_posts/agent_methods_x_posts.json"),
}


def load_json(path: Path) -> dict | list:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _handle(raw: str) -> str:
    return raw.lstrip("@")


def _tweet_url(username: str, tweet_id: str) -> str:
    return f"https://x.com/{username}/status/{tweet_id}"


def collect_articles(files: dict[str, Path]) -> dict[str, dict]:
    """
    Returns a map of tweet_id → article dict.
    Where a tweet_id appears in multiple sources, keeps the longest content.
    """
    articles: dict[str, dict] = {}

    def _add(tweet_id: str, author_id: str, author_username: str,
             content: str | None, source: str, url: str) -> None:
        if not content:
            return
        tweet_id = str(tweet_id)
        existing = articles.get(tweet_id)
        if existing and len(existing["content"] or "") >= len(content):
            return  # keep the longer/existing content
        articles[tweet_id] = {
            "id":              tweet_id,
            "tweet_id":        tweet_id,
            "author_id":       author_id,
            "author_username": author_username,
            "content":         content,
            "source":          source,
            "url":             url,
        }

    # ── 1. bookmarks.json ────────────────────────────────────────────────────
    bk = load_json(files["bookmarks"])
    bk_articles = 0
    for tweet in bk["tweets"]:
        if not tweet.get("is_article"):
            continue
        tid      = str(tweet["id"])
        username = tweet.get("author_handle", "")
        _add(
            tweet_id=tid,
            author_id=username,
            author_username=username,
            content=tweet.get("body"),
            source="bookmarks",
            url=_tweet_url(username, tid),
        )
        bk_articles += 1
    print(f"bookmarks.json:         {bk_articles} article tweets processed")

    # ── 2. trading_strategies.json ───────────────────────────────────────────
    ts = load_json(files["trading"])
    ts_articles = 0
    for post in ts["posts"]:
        if not post.get("has_article_content"):
            continue
        tid      = str(post["tweet_id"])
        username = _handle(post.get("profile", {}).get("handle", ""))
        _add(
            tweet_id=tid,
            author_id=username,
            author_username=username,
            content=post.get("content"),
            source="trading_strategies",
            url=post.get("url") or _tweet_url(username, tid),
        )
        ts_articles += 1
    print(f"trading_strategies.json: {ts_articles} article tweets processed")

    # ── 3. agent_methods_x_posts.json ────────────────────────────────────────
    am = load_json(files["agent_methods"])
    am_articles = 0
    for post in am["posts"]:
        if not post.get("has_article"):
            continue
        tid      = str(post["tweet_id"])
        username = _handle(post.get("author", ""))
        _add(
            tweet_id=tid,
            author_id=username,
            author_username=username,
            content=post.get("raw_excerpt"),
            source="agent_methods",
            url=post.get("url") or _tweet_url(username, tid),
        )
        am_articles += 1
    print(f"agent_methods.json:      {am_articles} article tweets processed")

    return articles


def import_articles(db: sqlite3.Connection, articles: dict[str, dict]) -> int:
    now = datetime.now(timezone.utc).isoformat()
    upsert = db.execute.__self__  # just a check; we use executemany below

    sql = """
        INSERT INTO articles (id, tweet_id, author_id, author_username, content, source, url, saved_at)
        VALUES (:id, :tweet_id, :author_id, :author_username, :content, :source, :url, :saved_at)
        ON CONFLICT(id) DO UPDATE SET
            content         = CASE
                                WHEN length(excluded.content) > length(articles.content)
                                THEN excluded.content
                                ELSE articles.content
                              END,
            author_id       = COALESCE(articles.author_id,       excluded.author_id),
            author_username = COALESCE(articles.author_username, excluded.author_username),
            url             = COALESCE(articles.url,             excluded.url),
            source          = excluded.source
    """
    rows = [{**a, "saved_at": now} for a in articles.values()]
    with db:
        db.executemany(sql, rows)
    return len(rows)


def main() -> None:
    print(f"DB: {DB_PATH}\n")
    db = sqlite3.connect(DB_PATH)

    # Snapshot before
    before = db.execute("SELECT COUNT(*) FROM articles").fetchone()[0]

    articles = collect_articles(FILES)
    print(f"\nTotal unique article tweet_ids collected: {len(articles)}")

    imported = import_articles(db, articles)

    # Stats after
    after       = db.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
    null_content = db.execute("SELECT COUNT(*) FROM articles WHERE content IS NULL OR content = ''").fetchone()[0]
    by_source   = db.execute(
        "SELECT source, COUNT(*) as cnt FROM articles GROUP BY source ORDER BY cnt DESC"
    ).fetchall()

    print(f"\nArticles before: {before}")
    print(f"Rows upserted:   {imported}")
    print(f"Articles after:  {after}")
    print(f"Null content:    {null_content}")
    print("\nBy source:")
    for src, cnt in by_source:
        print(f"  {src}: {cnt}")

    db.close()


if __name__ == "__main__":
    main()
