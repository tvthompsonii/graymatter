const fs = require('fs')
const path = require('path')

function parseCsvLine(line) {
    const result = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"') {
            inQuotes = !inQuotes
        }
        else if (ch === ',' && !inQuotes) {
            result.push(current)
            current = ''
        }
        else {
            current += ch
        }
    }
    result.push(current)
    return result
}

function parsePuzzleRow(cols, indices) {
    const id = cols[indices.id]?.trim()
    const fen = cols[indices.fen]?.trim()
    const movesRaw = cols[indices.moves]?.trim()
    const rating = Number(cols[indices.rating])
    const nbPlays = indices.nbPlays >= 0 ? Number(cols[indices.nbPlays]) : 0
    const themesRaw = cols[indices.themes]?.trim() ?? ''

    if (!id || !fen || !movesRaw || !Number.isFinite(rating)) return null

    const moves = movesRaw.split(/\s+/).filter(Boolean)
    if (!moves.length) return null

    return {
        id,
        fen,
        moves,
        rating,
        nbPlays: Number.isFinite(nbPlays) ? nbPlays : 0,
        themes: themesRaw.split(/\s+/).filter(Boolean),
    }
}

function puzzleMatchesFilters(puzzle, lo, hi, themeSet) {
    if (puzzle.rating < lo || puzzle.rating > hi) return false
    if (themeSet.size === 0) return true
    return puzzle.themes.some((theme) => themeSet.has(theme))
}


const HEADER_PROBE_BYTES = 64 * 1024

/**
 * Read the CSV header line and resolve column indices.
 * Returns the indices plus the byte offset where data rows begin.
 */
async function readCsvHeader(filePath) {
    const handle = await fs.promises.open(filePath, 'r')
    try {
        const buf = Buffer.alloc(HEADER_PROBE_BYTES)
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
        const newline = buf.subarray(0, bytesRead).indexOf(0x0a)
        if (newline < 0) throw new Error('Puzzle CSV header line not found.')

        const header = parseCsvLine(
            buf.toString('utf8', 0, newline).replace(/^﻿/, '').trim(),
        )
        const idIdx = header.indexOf('PuzzleId')
        const fenIdx = header.indexOf('FEN')
        const movesIdx = header.indexOf('Moves')
        const ratingIdx = header.indexOf('Rating')
        const nbPlaysIdx = header.indexOf('NbPlays')
        const themesIdx = header.indexOf('Themes')

        if (idIdx < 0 || fenIdx < 0 || movesIdx < 0 || ratingIdx < 0 || themesIdx < 0) {
            throw new Error('Puzzle CSV header is missing required columns.')
        }

        return {
            indices: {
                id: idIdx,
                fen: fenIdx,
                moves: movesIdx,
                rating: ratingIdx,
                nbPlays: nbPlaysIdx >= 0 ? nbPlaysIdx : -1,
                themes: themesIdx,
            },
            dataStart: newline + 1,
        }
    }
    finally {
        await handle.close()
    }
}

/**
 * Yield { text, start, end } for each line from byte offset `start`, where
 * start/end are the byte offsets of the line and of the byte after its newline.
 */
async function* readLinesFrom(filePath, start) {
    const stream = fs.createReadStream(filePath, { start })
    let pending = null
    let pendingStart = start

    try {
        for await (const chunk of stream) {
            const buf = pending ? Buffer.concat([pending, chunk]) : chunk
            const bufStart = pendingStart
            let pos = 0
            let newline
            while ((newline = buf.indexOf(0x0a, pos)) >= 0) {
                yield {
                    text: buf.toString('utf8', pos, newline),
                    start: bufStart + pos,
                    end: bufStart + newline + 1,
                }
                pos = newline + 1
            }
            pending = pos < buf.length ? buf.subarray(pos) : null
            pendingStart = bufStart + pos
        }

        if (pending) {
            yield {
                text: pending.toString('utf8'),
                start: pendingStart,
                end: pendingStart + pending.length,
            }
        }
    }
    finally {
        stream.destroy()
    }
}

/**
 * Stream the CSV from byte offset `afterOffset` and yield { puzzle, end } for each parsed
 * row whose line starts before `untilOffset`, where `end` is the byte offset of the line
 * after it (so a later scan can resume there without rereading).
 * An offset of 0 (or one past the end of the file) starts at the first data row.
 */
async function* scanPuzzles(filePath, afterOffset, untilOffset = Infinity) {
    const stopAt = Number.isFinite(untilOffset) ? untilOffset : Infinity

    const { indices, dataStart } = await readCsvHeader(filePath)
    const { size } = await fs.promises.stat(filePath)

    const resume = Number.isFinite(afterOffset) && afterOffset > dataStart && afterOffset < size
    // When resuming, start one byte early and discard the first line: it is either the
    // empty remainder of the previous line's newline, or (if the file changed under a
    // saved offset) the tail of a partial line.
    let skipFirst = resume
    const readFrom = resume ? afterOffset - 1 : dataStart

    for await (const line of readLinesFrom(filePath, readFrom)) {
        if (skipFirst) {
            skipFirst = false
            continue
        }
        if (line.start >= stopAt) break

        const trimmed = line.text.trim()
        if (!trimmed) continue

        const puzzle = parsePuzzleRow(parseCsvLine(trimmed), indices)
        if (puzzle) yield { puzzle, end: line.end }
    }
}

/**
 * Return the first puzzle matching `filters` scanning from `afterOffset` up to `untilOffset`,
 * with `nextByteOffset` set to where the line after the match begins.
 */
async function findNextPuzzleFromCsv(filePath, afterOffset, filters, untilOffset = Infinity) {
    const lo = Math.min(filters.minRating, filters.maxRating)
    const hi = Math.max(filters.minRating, filters.maxRating)
    const themeSet = new Set(filters.themes ?? [])

    for await (const { puzzle, end } of scanPuzzles(filePath, afterOffset, untilOffset)) {
        if (puzzleMatchesFilters(puzzle, lo, hi, themeSet)) {
            return { ...puzzle, nextByteOffset: end }
        }
    }

    return null
}

/**
 * Collect a Survival run's puzzle set in one pass from `startOffset` (wrapping to the first
 * data row and stopping back at `startOffset`). Each bucket { rating, count } takes up to
 * `count` puzzles rated within `radius` of `rating`; a puzzle goes to the nearest bucket by
 * center that still has room (ties go to the lower bucket). The scan stops once every bucket
 * is full and reports `nextByteOffset` just past the line that filled the last one; if a full
 * lap can't fill them all, `nextByteOffset` is null (the lap ended back at the cursor).
 * Puzzles are returned sorted by rating ascending.
 */
async function collectSurvivalSet(filePath, startOffset, { buckets, radius, themes }) {
    const themeSet = new Set(themes ?? [])
    const slots = buckets
        .filter((bucket) => bucket.count > 0)
        .map((bucket) => ({ rating: bucket.rating, count: bucket.count, puzzles: [] }))
    const lo = Math.min(...slots.map((slot) => slot.rating)) - radius
    const hi = Math.max(...slots.map((slot) => slot.rating)) + radius
    const seenIds = new Set()

    const sortedPuzzles = () => slots
        .flatMap((slot) => slot.puzzles)
        .sort((a, b) => a.rating - b.rating)

    const place = (puzzle) => {
        const open = slots
            .filter((slot) => slot.puzzles.length < slot.count
                && Math.abs(puzzle.rating - slot.rating) <= radius)
            .sort((a, b) => Math.abs(puzzle.rating - a.rating) - Math.abs(puzzle.rating - b.rating)
                || a.rating - b.rating)
        if (!open.length) return false
        open[0].puzzles.push(puzzle)
        return true
    }

    if (!slots.length) return { puzzles: [], nextByteOffset: null, lastPuzzleId: null }

    const passes = [[startOffset, Infinity]]
    if (startOffset > 0) passes.push([0, startOffset])

    for (const [from, until] of passes) {
        for await (const { puzzle, end } of scanPuzzles(filePath, from, until)) {
            // An out-of-range saved offset makes the first pass cover the whole file, so the
            // wrap pass could see the same rows again.
            if (seenIds.has(puzzle.id)) continue
            seenIds.add(puzzle.id)
            if (!puzzleMatchesFilters(puzzle, lo, hi, themeSet)) continue
            if (!place(puzzle)) continue
            if (slots.every((slot) => slot.puzzles.length >= slot.count)) {
                return { puzzles: sortedPuzzles(), nextByteOffset: end, lastPuzzleId: puzzle.id }
            }
        }
    }

    return { puzzles: sortedPuzzles(), nextByteOffset: null, lastPuzzleId: null }
}

const DEFAULT_PUZZLE_STATUS = {
    nextByteOffset: 0,
    lastPuzzleId: null,
}

async function readPuzzleStatus(statusPath) {
    try {
        const text = await fs.promises.readFile(statusPath, 'utf8')
        const parsed = JSON.parse(text)
        return {
            nextByteOffset: Number.isFinite(parsed.nextByteOffset) && parsed.nextByteOffset >= 0
                ? parsed.nextByteOffset
                : DEFAULT_PUZZLE_STATUS.nextByteOffset,
            lastPuzzleId: parsed.lastPuzzleId ?? null,
            updatedAt: parsed.updatedAt ?? null,
        }
    }
    catch {
        return { ...DEFAULT_PUZZLE_STATUS, updatedAt: null }
    }
}

async function writePuzzleStatus(statusPath, status) {
    await fs.promises.mkdir(path.dirname(statusPath), { recursive: true })
    await fs.promises.writeFile(
        statusPath,
        JSON.stringify({
            nextByteOffset: status.nextByteOffset,
            lastPuzzleId: status.lastPuzzleId,
            updatedAt: new Date().toISOString(),
        }, null, 4),
        'utf8',
    )
}

module.exports = {
    collectSurvivalSet,
    findNextPuzzleFromCsv,
    readPuzzleStatus,
    writePuzzleStatus,
    DEFAULT_PUZZLE_STATUS,
}
