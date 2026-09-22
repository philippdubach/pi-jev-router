# Superseded runs

These results were scored under a criterion that has since changed, so the
evidence loader must not aggregate them alongside current runs.

`benchmark-2026-09-22T17-39-46-694Z` ran the three ceiling tasks before they
carried a turn budget. Every model reached a passing state, so the run records
12 passes and no failures. The same tasks now fail a model that needs more
than six turns, and re-running produced pass rates of 33% to 100%. Keeping both
files would mix the two criteria for the same task ids.

The loader only reads `benchmark-*.json` in the parent directory, so moving a
file here is enough to retire it.
