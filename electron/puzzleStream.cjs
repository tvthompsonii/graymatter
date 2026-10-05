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
 * Stream the CSV from byte offset `afterOffset` and return the first matching puzzle
 * whose line starts before `untilOffset`. The returned `nextByteOffset` is where the
 * line after the match begins, so the next call can resume there without rereading.
 * An offset of 0 (or one past the end of the file) starts at the first data row.
 */
async function findNextPuzzleFromCsv(filePath, afterOffset, filters, untilOffset = Infinity) {
    const lo = Math.min(filters.minRating, filters.maxRating)
    const hi = Math.max(filters.minRating, filters.maxRating)
    const themeSet = new Set(filters.themes ?? [])
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
        if (puzzle && puzzleMatchesFilters(puzzle, lo, hi, themeSet)) {
            return { ...puzzle, nextByteOffset: line.end }
        }
    }

    return null
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
    findNextPuzzleFromCsv,
    readPuzzleStatus,
    writePuzzleStatus,
    DEFAULT_PUZZLE_STATUS,
}
