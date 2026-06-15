**#324 complete + full headroom integration verified end-to-end!**

Compression events now capture full metrics (original_size_bytes, compressed_size_bytes, compression_ratio, method). Dashboard shows real data:
- 58B bytes saved across 4 compression events
- 99.8% avg compression ratio (test data: repeated 'x' chars)
- Method distribution: 1 headroom event, 3 legacy (unknown) events
- Per-agent breakdown working

**Testing verified:**
1. Created test task with 25KB result → orchestrator compressed post-hoc
2. Compression event logged with all 7 fields
3. Dashboard API `/api/compression/summary` returns non-null aggregates
4. Dashboard UI shows health panel, timeseries chart, role breakdown, method distribution
5. All metrics flowing through correctly

**Full epic complete: headroom integration (FG-314) + dashboard (FG-313) + metrics capture (#324).**

**Session commits:**
- cdab09b: forge learn (FG-320)
- 3fdabf8: dashboard API (FG-321)
- 6ae22b0: dashboard UI (FG-322)  
- 4bf956c: per-task detail (FG-323)
- 5db8b0d: compression metrics (#324)

18 commits total on main. All pushed.
