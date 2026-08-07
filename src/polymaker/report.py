"""Daily report to Notion: summarize state.db + journal and post a page.

Keeps the same Notion database schema as the legacy TS bot
(Name / Date / Type / Content), so the existing Notion database works
unchanged. No-ops cleanly when NOTION_TOKEN / NOTION_DATABASE_ID are absent.
"""

from __future__ import annotations

import json
import sqlite3
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from polymaker.config import Config
from polymaker.logging import get_logger

log = get_logger("report")

NOTION_VERSION = "2022-06-28"


def _day_start_ts() -> float:
    """Local midnight (timezone of the machine running the bot) as a unix ts."""
    now = datetime.now()
    return time.mktime(now.replace(hour=0, minute=0, second=0, microsecond=0).timetuple())


def _chunk(text: str, size: int = 2000) -> list[dict[str, Any]]:
    return [{"text": {"content": text[i : i + size]}} for i in range(0, len(text), size)]


class NotionReporter:
    """Minimal Notion API client for creating database pages."""

    def __init__(self, token: str | None, database_id: str | None, *, proxy: str | None = None) -> None:
        self._token = token or ""
        self._database_id = database_id or ""
        self._proxy = proxy
        self.enabled = bool(self._token and self._database_id)

    def post(self, name: str, content: str, *, type_: str = "dailysummary") -> bool:
        if not self.enabled:
            log.warning(
                "notion_not_configured",
                hint="set NOTION_TOKEN and NOTION_DATABASE_ID in .env for daily reports",
            )
            return False
        body = {
            "parent": {"database_id": self._database_id},
            "properties": {
                "Name": {"title": [{"text": {"content": name}}]},
                "Date": {"date": {"start": datetime.now().isoformat()}},
                "Type": {"select": {"name": type_}},
                "Content": {"rich_text": _chunk(content)},
            },
        }
        kwargs: dict[str, Any] = {"timeout": 15.0}
        if self._proxy:
            kwargs["proxy"] = self._proxy
        try:
            with httpx.Client(**kwargs) as client:
                resp = client.post(
                    "https://api.notion.com/v1/pages",
                    headers={
                        "Authorization": f"Bearer {self._token}",
                        "Notion-Version": NOTION_VERSION,
                        "Content-Type": "application/json",
                    },
                    json=body,
                )
            if resp.status_code in (200, 201):
                log.info("notion_page_created", name=name)
                return True
            log.warning("notion_post_failed", status=resp.status_code, body=resp.text[:300])
            return False
        except httpx.HTTPError as exc:
            log.warning("notion_post_error", err=str(exc))
            return False


def build_daily_report(cfg: Config, *, paper: bool = False) -> str:
    """Summarize today's fills / PnL / positions / journal into a text report."""
    day = "paper" if paper else "live"
    start = _day_start_ts()
    lines: list[str] = []
    lines.append(f"模式: {'PAPER' if paper else 'LIVE'}")
    lines.append(f"生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("")

    # PnL snapshots
    try:
        conn = sqlite3.connect(cfg.paths.db)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT equity, net_cash, inventory_value, daily_pnl FROM pnl_snapshots ORDER BY ts DESC LIMIT 1"
        ).fetchone()
        if row:
            sign = "+" if row["daily_pnl"] >= 0 else ""
            lines.append(f"equity: ${row['equity']:.2f} | inventory: ${row['inventory_value']:.2f} | "
                         f"net cash: ${row['net_cash']:.2f} | 当日 PnL: {sign}{row['daily_pnl']:.4f}")
        else:
            lines.append("PnL: 暂无快照（引擎尚未记录）")
        lines.append("")

        # Today's fills
        fills = conn.execute(
            "SELECT side, is_maker, COUNT(*) n, SUM(size) sz, SUM(price*size) notional "
            "FROM fills WHERE ts >= ? GROUP BY side, is_maker",
            (start,),
        ).fetchall()
        if fills:
            lines.append("今日成交:")
            for f in fills:
                maker = "maker" if f["is_maker"] else "taker"
                side = "SELL" if f["side"] == "SELL" else "BUY"
                lines.append(
                    f"  {side} {maker}: {f['n']} 笔, {f['sz']:.2f} 股, 名义 ${f['notional']:.2f}"
                )
        else:
            lines.append("今日成交: 0 笔")
        lines.append("")

        # Open positions
        pos = conn.execute("SELECT token_id, size, avg_price FROM positions WHERE size > 0").fetchall()
        if pos:
            lines.append("当前持仓:")
            for p in pos:
                lines.append(f"  {p['token_id'][:18]}… size={p['size']:.2f} avg={p['avg_price']:.3f}")
        else:
            lines.append("当前持仓: 无")
        lines.append("")
        conn.close()
    except sqlite3.Error as exc:
        lines.append(f"state.db 读取失败: {exc}")
        lines.append("")

    # Journal summary (today)
    jpath = Path(cfg.paths.journal_dir) / f"{day}.jsonl"
    kinds: dict[str, int] = {}
    n = 0
    if jpath.exists():
        try:
            with jpath.open() as fh:
                for line in fh:
                    try:
                        ev = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if float(ev.get("ts", 0)) >= start:
                        n += 1
                        kinds[ev.get("kind", "?")] = kinds.get(ev.get("kind", "?"), 0) + 1
        except OSError as exc:
            lines.append(f"journal 读取失败: {exc}")
    if n:
        top = ", ".join(f"{k}={v}" for k, v in sorted(kinds.items(), key=lambda x: -x[1])[:8])
        lines.append(f"今日事件: {n} 条 ({top})")
    else:
        lines.append("今日事件: 无（journal 为空或引擎未运行）")

    return "\n".join(lines)
