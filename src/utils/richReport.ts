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
 * Deliberately NOT the full shape `report.CandidateReportData` has on the Python side
 * (which also carries near-term data and opponent_branches) -- the export tag is
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
