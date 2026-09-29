/**
 * Types + parsing for the `[%creport <base64-json>]` PGN comment tag emitted by
 * `chess-repertoire export --rich` (github.com/teo/chess-repertoire, a separate Python
 * tool). Field names deliberately match that tool's JSON wire format exactly (snake_case,
 * not camelCase) rather than translating them, so there's no silent drift between the
 * two if that tool's schema changes -- a schema mismatch shows up as a missing field
 * here, not a renamed one quietly meaning something else.
 *
 * Base64, not raw JSON, because python-chess's own PGN writer strips `{`/`}` from
 * comment text (PGN's own reserved comment delimiters) -- the producing side confirmed
 * this the hard way before switching to base64, so this parser only ever needs to
 * handle the base64 form; there is no raw-JSON fallback to support.
 */

export interface InterpretabilityFeature {
    feature_id: number;
    activation: number;
    concept_label: string | null;
    concept_display: string | null;
    correlation: number | null;
    correlation_n: number | null;
    attribution_squares: [square: string, score: number][];
}

export interface NetworkInternalsData {
    network_id: string;
    top_features: InterpretabilityFeature[];
}

export interface BoardArrow {
    from_square: string;
    to_square: string;
    color: string;
}

export interface BoardHighlight {
    square: string;
    color: string;
}

/**
 * A trimmed `BranchReportData` (`serialize_branch_data_compact` on the Python side) --
 * one of the opponent's alternative replies to a candidate, i.e. one entry in the
 * "major threats" list. Just move/score/why, not that branch's own near-term diffs --
 * nothing this app renders needs those.
 */
export interface BranchReportDataCompact {
    move_uci: string;
    move_san: string;
    score_cp: number | null;
    score_mate: number | null;
    structural_far: string[];
}

/**
 * Deliberately NOT the full shape `report.CandidateReportData` has on the Python side
 * (which also carries near-term data and full opponent_branches) -- the export tag is
 * trimmed to only what this fork actually renders (`serialize_candidate_data_compact`),
 * since `pgn_reader` (the Rust crate this app uses to parse imported PGN) has a hard
 * 16KB per-token buffer -- confirmed the hard way, a real export with the untrimmed
 * shape produced comments large enough to fail import outright.
 */
export interface CandidateReportData {
    move_uci: string;
    move_san: string;
    rank: number;
    score_cp: number | null;
    score_mate: number | null;
    mover_is_white: boolean;
    term_diffs_far: Record<string, number>;
    structural_far: string[];
    network_internals: NetworkInternalsData[];
    arrows: BoardArrow[];
    highlights: BoardHighlight[];
    is_brilliant: boolean;
    nag: number | null;
    /** One-sentence far-term verdict (e.g. "favors White primarily via Material
     * (+0.83)..."), the same prose `render_candidate_report`'s header used to build up
     * from -- rendered here directly instead of re-deriving anything from term_diffs_far/
     * structural_far, so report-imported and live-generated explanations read identically. */
    summary: string;
    /** SAN of the opponent's expected reply if this candidate is played (the second
     * move of its own PV) -- e.g. for a "beware of Black playing Qa4" line alongside
     * the verdict summary. `null` if the PV doesn't go that deep. */
    reply_san: string | null;
    /** The full principal variation in SAN -- "shows the best line" (chess.com's own
     * Game Review does exactly this). `reply_san` above is just `pv_san[1]`. */
    pv_san: string[];
    /** "simple"/"discovered"/"double"/"cross" if this candidate gives check, else
     * `null`. See `board_viz.check_kind`'s own docstring on the Python side for what
     * each one means. */
    check_kind: string | null;
    /** A one-sentence "desperado" explanation if this candidate's move is one -- the
     * piece playing it was already lost for free before it moved, so it grabs
     * material on its way out -- else `null`. */
    desperado: string | null;
    /** A one-sentence "removed the defense" explanation if this candidate captures an
     * opponent piece that was the sole defender of something else the mover was
     * already attacking, else `null`. */
    removed_defender: string | null;
    /** A one-sentence perpetual-check note if this candidate's own PV is a real,
     * repeating checking sequence, else `null`. */
    perpetual_check: string | null;
    /** A one-sentence windmill/see-saw note if this candidate's own PV contains 2+
     * discovered checks by the mover, else `null`. */
    windmill: string | null;
    /** A one-sentence "how this candidate addresses the opponent's biggest threat"
     * explanation -- the "Qa1 eliminates the threat of Qf6 because..." deep
     * explanation from the original design -- else `null`. See `RichReport.biggest_threat`
     * for what the threat itself was. */
    threat_response: string | null;
    /** The "major threats" list: the opponent's alternative replies to this candidate,
     * each with its own score and reasons -- chess.com's Game Review shows the
     * opponent's alternatives this way. Empty when `branch_alternatives` was off for
     * this report, or the position after this candidate is already game-over. */
    threats: BranchReportDataCompact[];
}

export interface DepthSeriesCandidate {
    rank: number;
    move_uci: string;
    move_san: string;
    score_cp: number | null;
    score_mate: number | null;
    pv_san: string[];
}

export interface DepthSeriesEntry {
    depth: number;
    candidates: DepthSeriesCandidate[];
}

export interface RichReport {
    candidates: CandidateReportData[];
    /** Absent from PGN-embedded (`--rich` export) reports -- only ever present on a
     * live `explainPosition` result, which defaults `--depth-series` on. */
    depth_series?: DepthSeriesEntry[];
    /** Classical-term name (e.g. "threats") -> its capitalized display label and
     * glossary definition, for every term appearing in any candidate's term_diffs_far
     * above the noise threshold -- present on both PGN-imported and live-generated
     * reports (`report.term_glossary_for_candidates` on the Python side), so a term
     * badge can show the same label/definition `render_candidate_report` uses without
     * this app maintaining its own copy of either. Optional only for backward
     * compatibility with older `[%creport]` tags written before this field existed. */
    term_glossary?: Record<string, { display: string; text: string }>;
    /** Degradation notices from chess-repertoire's own pipeline -- e.g. "nnue: no
     * trained SAE found" -- present whenever something (usually interpretability) was
     * silently skipped rather than computed. Absent (not just empty) when there's
     * nothing to report. Only ever present on a live `explainPosition` result: a
     * PGN-imported report has no live process to warn from. Surfacing these matters --
     * without them, an empty network_internals list looks identical to "nothing fired
     * here" and "the SAE model couldn't be found at all", which are very different
     * problems for a user to act on. */
    warnings?: string[];
    /** The mover's own tactical motifs against the opponent in the current position --
     * real, concrete geometric facts (python-chess's own is_pinned/attacks, plus manual
     * ray-walking for skewers/x-rays/batteries/relative pins), not tied to any
     * classical eval term. `trapped` has no arrows (a highlight-only fact: a mover
     * piece under attack with nowhere safe to go). Only ever present on a live
     * `explainPosition` result currently (not yet threaded through the `[%creport]`
     * tag). */
    tactics?: {
        pins: { arrows: BoardArrow[]; highlights: BoardHighlight[] };
        forks: { arrows: BoardArrow[]; highlights: BoardHighlight[] };
        skewers: { arrows: BoardArrow[]; highlights: BoardHighlight[] };
        // Optional, unlike pins/forks/skewers above -- added after those, so a cached
        // live report or an older `[%creport]` tag generated before this schema change
        // may genuinely lack them at runtime even though the TS type can't express
        // "present from version X onward". Components reading these must check before
        // indexing, the same way `tactics` itself is already optional.
        xrays?: { arrows: BoardArrow[]; highlights: BoardHighlight[] };
        batteries?: { arrows: BoardArrow[]; highlights: BoardHighlight[] };
        relative_pins?: { arrows: BoardArrow[]; highlights: BoardHighlight[] };
        trapped?: { arrows: BoardArrow[]; highlights: BoardHighlight[] };
        overloaded?: { arrows: BoardArrow[]; highlights: BoardHighlight[] };
    };
    /** Board-wide "pay attention to" facts -- undefended attacked pieces and their
     * defenders -- color-neutral (not mover-vs-opponent like `tactics`). Only ever
     * present on a live `explainPosition` result. */
    pay_attention?: string[];
    /** Plain positional facts from the target motif list: advanced pawns, doubled
     * rooks on the 7th/2nd rank, weak back rank, king opposition. Only ever present on
     * a live `explainPosition` result. */
    positional_facts?: string[];
    /** A one-sentence zugzwang note if the side to move is genuinely in zugzwang here
     * (real null-move engine test, not a heuristic) -- `null` if not, absent if
     * `--zugzwang` wasn't run (a PGN-imported report never has this). */
    zugzwang?: string | null;
    /** The opponent's single best move with a free tempo right now -- the concrete
     * "beware of ... playing Qa4" threat, computed once per position (not the same as
     * any one candidate's own `reply_san`, which is the opponent's best reply *after*
     * that specific candidate). `null` when there's no significant threat. Each
     * candidate's own `threat_response` explains what it does about this. Absent if
     * `--threat-analysis` wasn't run (a PGN-imported report never has this). */
    biggest_threat?: { move_san: string; score_cp: number | null; score_mate: number | null } | null;
}

const CREPORT_PATTERN = /\[%creport ([A-Za-z0-9+/=]+)\]/;

/**
 * Extracts and decodes a `[%creport <base64>]` tag from a PGN comment string, if
 * present. Returns `null` (never throws) for a comment with no tag, or one whose
 * payload fails to decode/parse -- a malformed tag degrades to "no rich report for this
 * move" rather than breaking import of the rest of the game.
 */
export function parseRichReport(comment: string): RichReport | null {
    const match = comment.match(CREPORT_PATTERN);
    if (!match) return null;
    try {
        // atob() alone would mis-decode any multi-byte UTF-8 sequence (it treats the
        // decoded bytes as a latin1 string) -- the Python side encodes the JSON as
        // UTF-8 before base64, so this needs the same round trip back.
        const bytes = Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0));
        const json = new TextDecoder("utf-8").decode(bytes);
        return JSON.parse(json) as RichReport;
    } catch {
        return null;
    }
}

/** The comment with the `[%creport ...]` tag (and one adjoining space, if present)
 * removed -- for displaying the human-readable remainder without the embedded payload. */
export function stripRichReportTag(comment: string): string {
    return comment.replace(new RegExp(`${CREPORT_PATTERN.source} ?`), "").trim();
}

const PGN_COLOR_TO_BRUSH: Record<string, string> = { G: "green", R: "red", Y: "yellow", B: "blue" };

/** `board_viz.py`'s single-letter PGN colors (G/R/Y/B) -> chessground's brush names --
 * the same mapping chessops's own `[%csl]`/`[%cal]` parser applies (confirmed by reading
 * its source), needed here too since `attribution_squares`/`arrows`/`highlights` carry
 * the raw PGN letter, not a chessground-ready brush name. */
export function pgnColorToBrush(color: string): string {
    return PGN_COLOR_TO_BRUSH[color] ?? "blue";
}
