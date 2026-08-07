"""Diagnose why `fills` is empty while the journal has user_trade events.

Replays livecfg/journal/live.jsonl through the REAL normalize_trade (the exact
code the engine runs) using the same wallet the engine loads, and prints why
each event did or did not become a fill. Also reports order_log (which does NOT
filter by address) to separate "parser mismatch" from "address mismatch".

Usage (from repo root, same CWD as the engine):
    uv run python scripts/diag_fills.py --config-dir livecfg
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from collections import Counter
from datetime import datetime
from pathlib import Path

from eth_account import Account

from polymaker.config import Config
from polymaker.userstream.parse import normalize_trade


def _other(token: str) -> str | None:
    return None  # only used for mint legs; fallback keeps token as-is


def _backfill(cdir: Path, jpath: Path, addr: str) -> None:
    """One-shot: insert journal fills into the fills ledger WITHOUT touching
    positions (positions are already correct from REST reconcile; applying the
    fills again would double count). Idempotent: INSERT OR IGNORE on trade_id."""
    import sqlite3

    conn = sqlite3.connect(cdir / "state.db")
    inserted = dup = 0
    seen: set[str] = set()
    for line in jpath.read_text().splitlines():
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("kind") != "user_trade":
            continue
        msg = rec["data"]
        for ev in normalize_trade(msg, addr, _other):
            if ev.trade_id in seen:
                continue
            seen.add(ev.trade_id)
            cur = conn.execute(
                "INSERT OR IGNORE INTO fills(trade_id,token_id,side,price,size,is_maker,ts)"
                " VALUES(?,?,?,?,?,1,?)",
                (ev.trade_id, ev.token_id, ev.our_side.value, ev.price, ev.size, ev.ts),
            )
            if cur.rowcount:
                inserted += 1
            else:
                dup += 1
    conn.commit()
    conn.close()
    print(f"[6] backfill: inserted {inserted} fills, {dup} duplicates (journal={jpath.name})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config-dir", default="livecfg")
    ap.add_argument("--journal", default=None,
                    help="journal path (default: <config-dir>/journal/live.jsonl)")
    ap.add_argument("--backfill", action="store_true",
                    help="insert journal fills into the fills ledger (positions untouched)")
    args = ap.parse_args()
    cdir = Path(args.config_dir)

    cfg = Config.load(cdir)  # loads .env from CWD, same as the engine
    eoa = Account.from_key(cfg.secrets.pk).address if cfg.secrets.pk else "(no PK)"
    browser = cfg.secrets.browser_address or "(none)"
    print(f"[1] engine addresses: signer EOA (from PK) = {eoa}")
    print(f"    browser_address (funder)           = {browser}")

    jpath = Path(args.journal or cdir / "journal" / "live.jsonl")
    recs = []
    if jpath.exists():
        for line in jpath.read_text().splitlines():
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get("kind") == "user_trade":
                recs.append(r)
    print(f"[2] journal user_trade events: {len(recs)}  ({jpath})")

    db = cdir / "state.db"
    if db.exists():
        c = sqlite3.connect(db)
        fills = c.execute("SELECT COUNT(*) FROM fills").fetchone()[0]
        olog = c.execute("SELECT COUNT(*) FROM order_log").fetchone()[0]
        poss = c.execute("SELECT COUNT(*) FROM positions WHERE size>0").fetchone()[0]
        mtime = datetime.fromtimestamp(db.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
        print(f"[3] state.db: fills={fills}  order_log={olog}  positions>0={poss}  (mtime {mtime})")
        print(f"    NOTE: order_log>0 means order events parsed fine -> parse works, suspect address.")
        c.close()
    else:
        print(f"[3] state.db NOT FOUND at {db}")

    if not recs:
        print("[4] no user_trade events to replay")
        return

    # wire-format eyeball: dump one full MATCHED event
    shown = next((r["data"] for r in recs
                  if str(r["data"].get("status", "")).upper() == "MATCHED"), recs[0]["data"])
    print(f"[4] raw event keys: {sorted(shown.keys())}")
    print(f"    status={shown.get('status')} side={shown.get('side')} outcome={shown.get('outcome')} "
          f"id={str(shown.get('id'))[:16]} asset={str(shown.get('asset_id'))[:12]}")
    for mo in shown.get("maker_orders", []) or []:
        print(f"    maker_order: addr={mo.get('maker_address')} amt={mo.get('matched_amount')} "
              f"price={mo.get('price')} outcome={mo.get('outcome')} side={mo.get('side')}")

    cand = {"EOA": eoa, "browser": browser}
    hits = Counter()
    for i, rec in enumerate(recs, 1):
        msg = rec["data"]
        per = {name: len(normalize_trade(msg, addr, _other)) for name, addr in cand.items()}
        hits.update(per)
        mo = msg.get("maker_orders") or []
        addrs = {str(m.get("maker_address", ""))[:12] for m in mo}
        if i <= 6 or sum(per.values()) > 0:
            print(f"    #{i:>3} status={msg.get('status'):<9} maker_orders={len(mo)} "
                  f"addrs={addrs} -> EOA matched:{per['EOA']}  browser matched:{per['browser']}")
    print(f"[5] replay verdict: EOA produced {hits['EOA']} events, browser produced {hits['browser']} events "
          f"across {len(recs)} journal events")

    if args.backfill:
        if isinstance(browser, str) and browser.startswith("0x"):
            _backfill(cdir, jpath, browser)
        else:
            print("[6] backfill skipped: no browser_address in .env")


if __name__ == "__main__":
    main()
