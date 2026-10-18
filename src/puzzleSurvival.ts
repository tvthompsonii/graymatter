/**
 * Survival mode's puzzle set: each bucket takes `count` puzzles rated within
 * SURVIVAL_BUCKET_RADIUS of `rating`. The run plays the whole set in rating order.
 */
export const SURVIVAL_BUCKETS: readonly { rating: number; count: number }[] = [
    { rating: 800, count: 1 },
    { rating: 900, count: 2 },
    { rating: 1050, count: 3 },
    { rating: 1150, count: 4 },
    { rating: 1300, count: 5 },
    { rating: 1450, count: 6 },
    { rating: 1600, count: 7 },
    { rating: 1750, count: 8 },
    { rating: 1900, count: 10 },
]

export const SURVIVAL_BUCKET_RADIUS = 75

/** Misses that end a run. */
export const SURVIVAL_MAX_MISSES = 3

/** How long a missed puzzle's wrong move stays on the board before the next puzzle loads. */
export const SURVIVAL_MISS_HOLD_MS = 1000
