"""polymaker command-line interface.

  polymaker scan                 sweep Gamma for political markets -> SQLite
  polymaker markets              rank/browse the catalog
  polymaker markets-add <slug>   append a market to config/markets.toml
  polymaker status               positions / open orders / PnL (reads SQLite)
  polymaker doctor               preflight: wallet auth, balances, WS reachability
  polymaker run [--paper]        start the market maker
  polymaker cancel-all           panic button
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import typer
from rich.console import Console
from rich.table import Table

from polymaker import __version__
from polymaker.catalog.scoring import BookStats, MarketScore
from polymaker.config import Config
from polymaker.domain import MarketMeta

app = typer.Typer(
    name="polymaker",
    help="Maker-only market maker for Polymarket CLOB V2.",
    no_args_is_help=True,
    add_completion=False,
)
console = Console()


@app.command()
def version() -> None:
    """Print the polymaker version."""
    console.print(f"polymaker {__version__}")


@app.command()
def scan(
    config_dir: str = typer.Option("config", help="config directory"),
    min_liquidity: float = typer.Option(1000.0, help="minimum market liquidity (USDC)"),
    all_markets: bool = typer.Option(False, "--all", help="include non-rewards markets"),
) -> None:
    """Sweep Gamma for political markets, score, and persist to SQLite."""
    from polymaker.catalog.scanner import ScanConfig, run_scan
    from polymaker.catalog.store import CatalogStore

    cfg = Config.load(config_dir)
    store = CatalogStore(cfg.paths.db)

    async def _go() -> int:
        metas = await run_scan(store, ScanConfig(min_liquidity=min_liquidity, rewards_only=not all_markets))
        return len(metas)

    n = asyncio.run(_go())
    csv_path = Path(config_dir).parent / "markets.csv"
    written = store.export_csv(csv_path)
    console.print(f"[green]Scanned and stored {n} markets.[/green] "
                  f"Wrote [bold]{csv_path}[/bold] ({written} rows) — open it, pick markets, "
                  f"then `polymaker markets-add <slug>`.")
    store.close()


@app.command()
def markets(
    config_dir: str = typer.Option("config", help="config directory"),
    limit: int = typer.Option(25, help="rows to show"),
) -> None:
    """Show the top scored markets from the catalog."""
    from polymaker.catalog.store import CatalogStore

    cfg = Config.load(config_dir)
    store = CatalogStore(cfg.paths.db)
    rows = store.top(limit)
    if not rows:
        console.print("[yellow]Catalog empty. Run `polymaker scan` first.[/yellow]")
        raise typer.Exit()

    table = Table(title="Political markets by reward yield per $ of capital")
    for col in ("score", "$/day", "yield%/d", "capital", "compet.", "tox", "spread",
                "tick", "neg", "question"):
        table.add_column(col, justify="right" if col != "question" else "left")
    for meta, sc in rows:
        table.add_row(
            f"{sc.score:.2f}", f"{sc.reward_daily_income:.4f}",
            f"{sc.reward_yield_pct:.3f}", f"{sc.capital_usdc:.0f}",
            f"{sc.competition:.0f}", f"{sc.toxicity:.2f}",
            f"{sc.spread:.3f}", f"{meta.tick_size:g}", "Y" if meta.neg_risk else "-",
            meta.question[:52],
        )
    console.print(table)
    console.print(
        "\n[dim]score = risk-adjusted reward yield per $ of capital deployed; "
        "$/day = our share of the pool at the market's minimum scoring size; "
        "compet. = score-weighted shares already inside the reward band; "
        "tox = 0 safest .. 1 most likely to be run over.[/dim]"
    )
    console.print("\nAdd one with: [bold]polymaker markets-add <slug>[/bold]  (slugs are in the catalog)")


@app.command(name="markets-add")
def markets_add(
    slug: str,
    profile: str = typer.Option("political-longdated", help="strategy profile"),
    config_dir: str = typer.Option("config", help="config directory"),
) -> None:
    """Append a market (by slug) to config/markets.toml."""
    from polymaker.catalog.store import CatalogStore

    cfg = Config.load(config_dir)
    store = CatalogStore(cfg.paths.db)
    meta = store.get_by_slug(slug)
    store.close()
    if meta is None:
        console.print(f"[red]No market with slug {slug!r} in the catalog. Run `polymaker scan`.[/red]")
        raise typer.Exit(1)

    path = Path(config_dir) / "markets.toml"
    block = f'\n[[markets]]\nslug    = "{slug}"\nprofile = "{profile}"\nenabled = true\n'
    with path.open("a") as fh:
        fh.write(block)
    console.print(f"[green]Added[/green] {meta.question[:60]!r} to {path}")


@app.command()
def status(config_dir: str = typer.Option("config", help="config directory")) -> None:
    """Show positions, open orders, and marks from the local state DB."""
    from polymaker.state.store import StateStore

    cfg = Config.load(config_dir)
    store = StateStore(cfg.paths.db)
    snap = store.snapshot()
    console.print(f"[bold]Open orders:[/bold] {snap['open_orders']}")
    positions: dict[str, Any] = snap["positions"]  # type: ignore[assignment]
    if not positions:
        console.print("[dim]No open positions.[/dim]")
    else:
        table = Table(title="Positions")
        table.add_column("token")
        table.add_column("size", justify="right")
        table.add_column("avg", justify="right")
        for tok, p in positions.items():
            table.add_row(tok[:16] + "…", f"{p['size']:.2f}", f"{p['avg_price']:.3f}")
        console.print(table)
    store.close()


@app.command()
def pnl(config_dir: str = typer.Option("config", help="config directory")) -> None:
    """Show PnL from the recorded snapshots (equity, daily PnL, fills)."""
    import sqlite3

    cfg = Config.load(config_dir)
    conn = sqlite3.connect(cfg.paths.db)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT ts, equity, net_cash, inventory_value, daily_pnl FROM pnl_snapshots "
        "ORDER BY ts DESC LIMIT 1"
    ).fetchall()
    if not rows:
        console.print("[yellow]No PnL snapshots yet (run the engine first).[/yellow]")
    else:
        r = rows[0]
        color = "green" if r["daily_pnl"] >= 0 else "red"
        console.print(f"[bold]equity:[/bold] {r['equity']:.4f}  "
                      f"[bold]inventory:[/bold] {r['inventory_value']:.4f}  "
                      f"[bold]net cash:[/bold] {r['net_cash']:.4f}")
        console.print(f"[bold]daily PnL:[/bold] [{color}]{r['daily_pnl']:+.4f}[/{color}] pUSD")
    nfills = conn.execute("SELECT COUNT(*) n FROM fills").fetchone()["n"]
    console.print(f"[dim]total fills recorded: {nfills}[/dim]")
    conn.close()


@app.command(name="export-csv")
def export_csv(
    config_dir: str = typer.Option("config", help="config directory"),
    out: str = typer.Option("markets.csv", help="output CSV path"),
    limit: int = typer.Option(500, help="max rows"),
) -> None:
    """Export the scored market catalog to a CSV for easy picking."""
    from polymaker.catalog.store import CatalogStore

    cfg = Config.load(config_dir)
    store = CatalogStore(cfg.paths.db)
    n = store.export_csv(out, limit)
    store.close()
    console.print(f"[green]Wrote {n} markets to {out}.[/green]")


@app.command()
def doctor(config_dir: str = typer.Option("config", help="config directory")) -> None:
    """Preflight checks: config, wallet auth, balance/allowance, WS reachability."""
    from polymaker.doctor import run_doctor

    cfg = Config.load(config_dir)
    ok = asyncio.run(run_doctor(cfg, console))
    raise typer.Exit(0 if ok else 1)


@app.command()
def run(
    config_dir: str = typer.Option("config", help="config directory"),
    paper: bool = typer.Option(False, "--paper", help="paper mode: full pipeline, no orders posted"),
) -> None:
    """Start the market maker."""
    from polymaker.engine import Engine
    from polymaker.logging import configure

    cfg = Config.load(config_dir)

    # Fail fast on configuration that would only surface mid-session (unknown profile
    # -> KeyError on the first quote; dead proxy -> every call fails; no market enabled
    # -> the bot runs and does nothing). Warnings in paper mode, fatal when live.
    issues = cfg.preflight() + ([] if paper else cfg.require_live_secrets())
    if issues:
        for issue in issues:
            console.print(f"[red]✗[/red] {issue}")
        if not paper:
            console.print("[red]Refusing to start live with the above problems.[/red] "
                          "Fix them, or run with --paper.")
            raise typer.Exit(1)
        console.print("[yellow]! continuing in paper mode despite the above[/yellow]")

    configure(json_file=Path(cfg.paths.log_dir) / ("paper.jsonl" if paper else "live.jsonl"))
    if cfg.engine.loop == "uvloop":
        try:
            import uvloop

            uvloop.install()
        except Exception:  # noqa: BLE001
            pass

    engine = Engine(cfg, paper=paper)

    async def _go() -> None:
        try:
            await engine.run_forever()
        except (KeyboardInterrupt, asyncio.CancelledError):
            pass
        finally:
            await engine.shutdown()

    console.print(f"[bold green]Starting polymaker[/bold green] ({'PAPER' if paper else 'LIVE'})…")
    try:
        asyncio.run(_go())
    except KeyboardInterrupt:
        console.print("\n[yellow]Stopped.[/yellow]")


@app.command()
def livetest(
    config_dir: str = typer.Option("config", help="config directory"),
    notional: float = typer.Option(5.0, help="order notional in USDC"),
) -> None:
    """Live wallet round-trip: place a deep post-only order and cancel it (~$5)."""
    from polymaker.livetest import run_livetest

    cfg = Config.load(config_dir)
    ok = asyncio.run(run_livetest(cfg, console, notional))
    raise typer.Exit(0 if ok else 1)


@app.command()
def moneydoctor(
    config_dir: str = typer.Option("config", help="config directory"),
) -> None:
    """LIVE trading self-test: rest a limit, then market buy + sell (spends a little)."""
    from polymaker.moneydoctor import run_moneydoctor

    cfg = Config.load(config_dir)
    ok = asyncio.run(run_moneydoctor(cfg, console))
    raise typer.Exit(0 if ok else 1)


@app.command(name="report")
def report(
    config_dir: str = typer.Option("config", help="config directory"),
    paper: bool = typer.Option(False, "--paper", help="report paper-mode data"),
) -> None:
    """Generate today's summary and push it to Notion (daily report)."""
    from datetime import datetime

    from polymaker.config import Config
    from polymaker.report import NotionReporter, build_daily_report

    cfg = Config.load(config_dir)
    content = build_daily_report(cfg, paper=paper)
    console.print(content)
    reporter = NotionReporter(
        cfg.secrets.notion_token, cfg.secrets.notion_database_id, proxy=cfg.proxy
    )
    mode = "PAPER" if paper else "LIVE"
    ok = reporter.post(f"polymaker {mode} 日报 {datetime.now():%Y-%m-%d}", content)
    if ok:
        console.print("[green]已推送 Notion.[/green]")
    elif not reporter.enabled:
        console.print("[yellow]未配置 NOTION_TOKEN/NOTION_DATABASE_ID，仅打印本地日报.[/yellow]")
    else:
        console.print("[red]Notion 推送失败，详见日志.[/red]")

@app.command(name="select")
def select(
    capital: float = typer.Option(100.0, help="USDC available to deploy across the experiment"),
    config_dir: str = typer.Option("config", help="config directory"),
    limit: int = typer.Option(15, help="rows to show"),
    rescan: bool = typer.Option(False, "--rescan", help="re-scan Gamma + measure books first"),
    min_pool: float = typer.Option(20.0, help="ignore markets below this daily pool"),
) -> None:
    """Pick markets whose reward floor FITS `capital`, ranked by expected yield.

    The reward program pays by the smallest qualifying order rather than by account
    size, so a market is only reachable when BOTH legs can be quoted at
    `rewardsMinSize`. A two-sided quote costs `shares * (p_yes + p_no)` = `shares`
    dollars, because the pair redeems for one. This filters to reachable markets and
    ranks them by risk-adjusted reward yield per dollar of capital deployed.
    """
    from polymaker.catalog.gamma import GammaClient
    from polymaker.catalog.scanner import ScanConfig, measure_volatility, run_scan
    from polymaker.catalog.scoring import score_market
    from polymaker.catalog.store import CatalogStore

    cfg = Config.load(config_dir)
    store = CatalogStore(cfg.paths.db)

    async def _go() -> None:
        if rescan:
            console.print("[dim]scanning Gamma + measuring books…[/dim]")
            await run_scan(store, ScanConfig(rewards_only=True))

        # `top` carries the score the scanner computed WITH a measured book.
        candidates = [(m, sc) for m, sc in store.top(300)
                      if m.rewards_daily_rate >= min_pool
                      and 0 < m.rewards_min_size <= capital]
        if not candidates:
            console.print(f"[yellow]No rewarded market needs less than ${capital:.0f} "
                          f"on each leg. Raise --capital or lower --min-pool.[/yellow]")
            return

        console.print(f"[dim]measuring volatility for {len(candidates)} reachable markets…[/dim]")
        scored = []
        async with GammaClient(cfg.wallet.gamma_host):
            import httpx as _httpx

            async with _httpx.AsyncClient(base_url=cfg.wallet.clob_host.rstrip("/"),
                                          timeout=20.0) as cl:
                sem = asyncio.Semaphore(6)

                async def _one(meta: MarketMeta, base: MarketScore) -> None:
                    try:
                        async with sem:
                            vol = await measure_volatility(meta, cl)
                    except Exception:  # noqa: BLE001 - a missing history is not fatal
                        vol = None
                    # Re-score with measured volatility, reusing the book stats the
                    # scanner already gathered (competition dominates the income).
                    sc = score_market(meta, _book_of(base), vol_1m=vol)
                    if sc.reward_daily_income > 0:
                        scored.append((sc, meta, vol))

                await asyncio.gather(*(_one(m, sc) for m, sc in candidates))

        if not scored:
            console.print("[yellow]No reachable market had a measurable reward share. "
                          "Re-run with --rescan for fresh book data.[/yellow]")
            return
        scored.sort(key=lambda t: -t[0].score)
        table = Table(title=f"Markets reachable with ${capital:.0f} (each leg at the reward floor)")
        for col in ("score", "$/day", "yield%/d", "need$", "pool", "compet", "tox", "σ1m", "mid", "slug"):
            table.add_column(col, justify="right" if col != "slug" else "left")
        for sc, meta, vol in scored[:limit]:
            mid = (meta.best_bid + meta.best_ask) / 2 if meta.best_bid and meta.best_ask else 0.0
            table.add_row(
                f"{sc.score:.2f}", f"{sc.reward_daily_income:.3f}", f"{sc.reward_yield_pct:.2f}",
                f"{meta.rewards_min_size:.0f}", f"{meta.rewards_daily_rate:.0f}",
                f"{sc.competition:.0f}", f"{sc.toxicity:.2f}", f"{(vol or 0):.5f}",
                f"{mid:.4f}", meta.slug[:36],
            )
        console.print(table)
        console.print(
            "\n[dim]need$ = shares needed on EACH leg (1 share ≈ $1 for the pair). "
            f"With ${capital:.0f} you can run about "
            f"{capital / max(1.0, scored[0][1].rewards_min_size):.1f} markets at once.\n"
            "tox 0 = safest .. 1 = price crosses the whole reward band within ~15min.[/dim]"
        )

    asyncio.run(_go())
    store.close()


def _book_of(scored: MarketScore) -> BookStats | None:
    """Recover the book stats implied by a stored score.

    The catalog does not persist raw book levels, but competition is the only book
    field the scorer needs and it is already stored on the score. Returning None when
    competition is unknown keeps the scorer's "no measurement -> no income" rule.
    """
    if not scored.competition:
        return None
    return BookStats(weighted_shares=float(scored.competition),
                     spread=float(scored.spread or 0.0))


@app.command(name="experiment")
def experiment(
    config_dir: str = typer.Option("config", help="config directory"),
    day: str = typer.Option("live", help="journal day file to analyse (e.g. live, paper)"),
) -> None:
    """Summarize the measurement experiment from the journal.

    Reports the two numbers the go/no-go decision rests on: markout (adverse
    selection) and fill pairing (whether we are making markets or taking a
    directional position), plus reward income estimated from the collateral balance
    change net of trading flows.
    """
    import json
    from collections import defaultdict

    cfg = Config.load(config_dir)
    path = Path(cfg.paths.journal_dir) / f"{day}.jsonl"
    if not path.exists():
        console.print(f"[red]No journal at {path}[/red] — the bot has not run yet.")
        raise typer.Exit(1)

    fills: list[dict[str, Any]] = []
    marks: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    for line in path.read_text().splitlines():
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind, data = rec.get("kind"), rec.get("data") or {}
        if kind == "fill":
            fills.append(data)
        elif kind == "markout":
            marks.append(data)
        elif kind == "markout_summary":
            summaries.append(data)

    console.print(f"[bold]Experiment summary[/bold]  ({path})")
    console.print(f"  fills recorded : [bold]{len(fills)}[/bold]")
    if not fills:
        console.print("  [yellow]No fills: nothing measured. The quotes are not being "
                      "taken — this alone fails the experiment's sample-size gate.[/yellow]")
        return

    # Reward eligibility: a fill only earns if its size meets the market's floor.
    by_token: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for f in fills:
        by_token[str(f.get("token_id", ""))].append(f)

    # Pairing: a market is "paired" when both outcome legs were bought.
    conditions: dict[str, set[str]] = defaultdict(set)
    for f in fills:
        cid = str(f.get("condition_id", ""))
        if f.get("side") == "BUY":
            conditions[cid].add(str(f.get("token_id", "")))
    paired = sum(1 for toks in conditions.values() if len(toks) >= 2)
    total = len(conditions)
    single_ratio = (total - paired) / total if total else 0.0
    console.print(f"  markets traded : {total}   paired (both legs) {paired}   "
                  f"single-leg ratio [bold]{single_ratio:.0%}[/bold]")

    if marks:
        vals = [float(m.get("markout", 0.0)) for m in marks]
        sizes = [float(f.get("size", 0.0)) for f in fills]
        avg_size = sum(sizes) / len(sizes) if sizes else 0.0
        adverse = [v for v in vals if v < 0]
        # A = fill-weighted adverse cost; markout is per share.
        a_cost = sum(vals) * avg_size
        console.print(f"  markout samples: {len(vals)}")
        console.print(f"    mean {sum(vals) / len(vals):+.5f}/share   "
                      f"adverse rate {len(adverse) / len(vals):.0%}   "
                      f"worst {min(vals):+.5f}   best {max(vals):+.5f}")
        console.print(f"  [bold]A (markout cost, approx) = {a_cost:+.2f} USDC[/bold] "
                      f"[dim](sum(markout) x avg fill size {avg_size:.2f})[/dim]")
        console.print("  [dim]R (reward income) must be measured from the collateral "
                      "balance delta net of trading flows — see EXPERIMENT_PROTOCOL.md. "
                      "Continue only if R > A with >=30 fills and single-leg ratio < 60%.[/dim]")
    else:
        console.print("  [yellow]No markout samples yet: fills have not aged past the "
                      "horizon, or fair value was never updated.[/yellow]")
    if summaries:
        last = summaries[-1]
        console.print(f"  last summary   : n={last.get('samples')} "
                      f"mean={last.get('mean')} adverse={last.get('adverse_rate')}")


@app.command(name="cancel-all")
def cancel_all(config_dir: str = typer.Option("config", help="config directory")) -> None:
    """Cancel all open orders for the wallet (panic button)."""
    from polymaker.execution.gateway import ExecutionGateway

    cfg = Config.load(config_dir)
    gw = ExecutionGateway(cfg)

    async def _go() -> None:
        await gw.connect()
        await gw.cancel_all()

    asyncio.run(_go())
    console.print("[green]Sent cancel-all.[/green]")


if __name__ == "__main__":
    app()
