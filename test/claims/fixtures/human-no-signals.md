Bumps the connection pool ceiling for the reporting replica.

The nightly rollup was starving the interactive dashboard overnight, because both share
the reporting pool. Raising the ceiling on the replica keeps the dashboard responsive
without touching the primary.

I looked at pool metrics for the last two weeks before picking the new ceiling; the
replica sits well under its connection limit at the new value.
