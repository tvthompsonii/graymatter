const fs = require('fs')
const path = require('path')
const readline = require('readline')

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

/**
 * Stream the CSV and return the first matching puzzle after afterLine (up to untilLine).
 * Stops reading as soon as a match is found.
 */
async function findNextPuzzleFromCsv(filePath, afterLine, filters, untilLine = Infinity) {
    const lo = Math.min(filters.minRating, filters.maxRating)
    const hi = Math.max(filters.minRating, filters.maxRating)
    const themeSet = new Set(filters.themes ?? [])
    const startAfter = Number.isFinite(afterLine) ? afterLine : -1
    const stopAt = Number.isFinite(untilLine) ? untilLine : Infinity

    let indices = null
    let lineNumber = 0

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    try {
        for await (const line of rl) {
            const trimmed = line.trim()
            if (!trimmed) {
                lineNumber++
                continue
            }

            if (!indices) {
                const header = parseCsvLine(trimmed)
                const idIdx = header.indexOf('PuzzleId')
                const fenIdx = header.indexOf('FEN')
                const movesIdx = header.indexOf('Moves')
                const ratingIdx = header.indexOf('Rating')
                const nbPlaysIdx = header.indexOf('NbPlays')
                const themesIdx = header.indexOf('Themes')

                if (idIdx < 0 || fenIdx < 0 || movesIdx < 0 || ratingIdx < 0 || themesIdx < 0) {
                    throw new Error('Puzzle CSV header is missing required columns.')
                }

                indices = {
                    id: idIdx,
                    fen: fenIdx,
                    moves: movesIdx,
                    rating: ratingIdx,
                    nbPlays: nbPlaysIdx >= 0 ? nbPlaysIdx : -1,
                    themes: themesIdx,
                }
                lineNumber++
                continue
            }

            if (lineNumber > startAfter && lineNumber <= stopAt) {
                const cols = parseCsvLine(trimmed)
                const puzzle = parsePuzzleRow(cols, indices)
                if (puzzle && puzzleMatchesFilters(puzzle, lo, hi, themeSet)) {
                    return { ...puzzle, lineNumber }
                }
            }

            lineNumber++
        }
    }
    finally {
        rl.close()
        stream.destroy()
    }

    return null
}

const DEFAULT_PUZZLE_STATUS = {
    lastLineNumber: -1,
    lastPuzzleId: null,
}

async function readPuzzleStatus(statusPath) {
    try {
        const text = await fs.promises.readFile(statusPath, 'utf8')
        const parsed = JSON.parse(text)
        return {
            lastLineNumber: Number.isFinite(parsed.lastLineNumber)
                ? parsed.lastLineNumber
                : DEFAULT_PUZZLE_STATUS.lastLineNumber,
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
            lastLineNumber: status.lastLineNumber,
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
