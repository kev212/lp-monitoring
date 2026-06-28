"""Meteora Portfolio API-based position valuation.

Uses Meteora's own PnL calculation instead of computing from price oracle.
Portfolio API returns: pnlPctChange, pnlSol, balancesSol, totalDepositSol per pool.
Per-position PnL is derived by matching pool address to the position's pool.
"""
import asyncio
import logging
from typing import Optional

logger = logging.getLogger("valuation")

PORTFOLIO_API = "https://dlmm.datapi.meteora.ag/portfolio/open"
PORTFOLIO_TIMEOUT = 10
CACHE_TTL = 5  # 5 seconds cache

# In-memory cache: {wallet: {ts: float, pools: {pool_address: PoolData}}}
_cache: dict[str, dict] = {}


class PoolPnLData:
    """PnL data from Meteora Portfolio API for a single pool."""
    __slots__ = (
        "pool_address", "pnl_pct_change", "pnl_sol", "pnl",
        "balances_sol", "total_deposit_sol", "unclaimed_fees_sol",
        "token_x", "token_y", "pool_price", "sol_usd_price",
    )

    def __init__(self, data: dict, sol_price: float):
        self.pool_address = data.get("poolAddress", "")
        self.pnl_pct_change = float(data.get("pnlPctChange", 0) or 0)
        self.pnl_sol = float(data.get("pnlSol", 0) or 0)
        self.pnl = float(data.get("pnl", 0) or 0)
        self.balances_sol = float(data.get("balancesSol", 0) or 0)
        self.total_deposit_sol = float(data.get("totalDepositSol", 0) or 0)
        self.unclaimed_fees_sol = float(data.get("unclaimedFeesSol", 0) or 0)
        self.token_x = data.get("tokenX", "?")
        self.token_y = data.get("tokenY", "?")
        self.pool_price = float(data.get("poolPrice", 0) or 0)
        self.sol_usd_price = sol_price


async def fetch_portfolio(wallet: str) -> Optional[dict]:
    """Fetch Portfolio API data for a wallet."""
    import aiohttp
    try:
        url = f"{PORTFOLIO_API}?user={wallet}&page_size=50"
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=PORTFOLIO_TIMEOUT)) as resp:
                if resp.status != 200:
                    logger.warning(f"Portfolio API HTTP {resp.status} for {wallet}")
                    return None
                return await resp.json()
    except asyncio.TimeoutError:
        logger.warning(f"Portfolio API timeout for {wallet}")
        return None
    except Exception as e:
        logger.error(f"Portfolio API error: {e}")
        return None


async def get_pool_pnl(wallet: str, pool_address: str) -> Optional[PoolPnLData]:
    """Get PnL for a specific pool from Meteora Portfolio API.

    Uses cache (TTL=5s) to avoid hammering the API on every monitoring cycle.
    Returns PoolPnLData or None if pool not found / API error.
    """
    import time
    now = time.time()

    # Check cache
    cached = _cache.get(wallet)
    if cached and (now - cached["ts"]) < CACHE_TTL:
        pool_data = cached["pools"].get(pool_address)
        if pool_data:
            return pool_data  # type: ignore
        # Pool not in cache — might have been just opened. Refetch.
        logger.debug(f"Pool {pool_address[:8]} not in cache, refetching portfolio")

    # Fetch from API
    data = await fetch_portfolio(wallet)
    if not data:
        # Return stale cache if available
        if cached:
            return cached["pools"].get(pool_address)
        return None

    sol_price = float(data.get("solPrice", 0) or 0)
    pools_dict = {}
    for pool in data.get("pools", []):
        pa = pool.get("poolAddress", "")
        if pa:
            pools_dict[pa] = PoolPnLData(pool, sol_price)

    # Update cache
    _cache[wallet] = {"ts": now, "pools": pools_dict}

    return pools_dict.get(pool_address)


async def get_position_pnl_from_portfolio(
    wallet: str,
    position_pubkey: str,
    pool_pubkey: str,
) -> Optional[PoolPnLData]:
    """Get PnL for a position by matching its pool address.

    Since Portfolio API returns per-pool data (not per-position),
    we match by pool address. This is accurate when there's 1 position
    per pool (which is the typical case).
    """
    return await get_pool_pnl(wallet, pool_pubkey)
