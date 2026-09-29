import type { DrawShape } from "@lichess-org/chessground/draw";
import { makeUci, type Move } from "chessops";
import { INITIAL_FEN } from "chessops/fen";
import type { Outcome, Score } from "@/bindings";
import type { Annotation } from "./annotation";
import { positionFromFen } from "./chessops";
import type { CandidateReportData, RichReport } from "./richReport";

export interface TreeState {
    root: TreeNode;
    headers: GameHeaders;
    position: number[];
    dirty: boolean;
    report: ReportState;
}

export interface TreeNode {
    fen: string;
    move: Move | null;
    san: string | null;
    children: TreeNode[];
    score: Score | null;
    depth: number | null;
    halfMoves: number;
    shapes: DrawShape[];
    annotations: Annotation[];
    comment: string;
    clock?: number;
    /** Parsed from a `[%creport <base64>]` PGN comment tag, if present (see
     * `richReport.ts`) -- the full deep-report data from `chess-repertoire export --rich`
     * (verdict terms, structural facts, network internals) for this position's
     * candidates, undefined for a plain-PGN-imported game or an ordinary move. */
    richReport?: RichReport;
}

export interface ReportState {
    progress: number;
    isCompleted: boolean;
    inProgress: boolean;
}

export type ListNode = {
    position: number[];
    node: TreeNode;
};

export function* treeIterator(node: TreeNode): Generator<ListNode> {
    const stack: ListNode[] = [{ position: [], node }];
    while (stack.length > 0) {
        const { position, node } = stack.pop()!;
        yield { position, node };
        for (let i = node.children.length - 1; i >= 0; i--) {
            stack.push({ position: [...position, i], node: node.children[i] });
        }
    }
}

export interface FeatureExample {
    position: number[];
    fen: string;
    san: string | null;
    activation: number;
}

/** Other positions in this same tree (any variation, not just the mainline) where the
 * given network's feature also fired -- built purely client-side by walking whatever's
 * already parsed from a `--rich` import (no extra query needed: every position's own
 * `richReport` already carries its own network internals). Excludes `excludeFen` (the
 * position the feature was clicked from) and only counts one example per position, even
 * if several candidates there both surface the same feature id. */
export function findFeatureExamples(
    root: TreeNode,
    networkId: string,
    featureId: number,
    excludeFen: string,
    limit = 5,
): FeatureExample[] {
    const examples: FeatureExample[] = [];
    for (const { position, node } of treeIterator(root)) {
        if (node.fen === excludeFen || !node.richReport) continue;
        for (const candidate of node.richReport.candidates) {
            const net = candidate.network_internals.find((n) => n.network_id === networkId);
            const feature = net?.top_features.find((f) => f.feature_id === featureId);
            if (feature) {
                examples.push({ position, fen: node.fen, san: node.san, activation: feature.activation });
                break;
            }
        }
    }
    examples.sort((a, b) => Math.abs(b.activation) - Math.abs(a.activation));
    return examples.slice(0, limit);
}

/** The played-move's own candidate entry from `node.richReport` -- i.e. "how good was
 * the move that was actually played to reach this node", not "what could be played from
 * here". Only meaningful for a PGN-imported (`--rich` export) node: `pgn_export.py`
 * attaches each move's `[%creport]` tag to the position *after* that move, built from
 * the *parent* position's full candidate list (see `_note_and_nag_for_move`), so
 * `node.richReport.candidates` already includes the move that got you here alongside
 * its alternatives -- this just finds which one that was. A live `explainPosition`
 * result has the opposite direction (options *from* this position, not leading *to*
 * it), so this deliberately returns null for a node whose richReport only came from
 * `liveExplanationFamily`, rather than matching the wrong thing by accident. */
export function playedMoveCandidate(node: TreeNode): CandidateReportData | null {
    if (!node.richReport || !node.move) return null;
    const uci = makeUci(node.move);
    return node.richReport.candidates.find((c) => c.move_uci === uci) ?? null;
}

export function findFen(fen: string, node: TreeNode): number[] {
    const iterator = treeIterator(node);
    for (const item of iterator) {
        if (item.node.fen === fen) {
            return item.position;
        }
    }
    return [];
}

export function* treeIteratorMainLine(node: TreeNode): Generator<ListNode> {
    let current: ListNode | undefined = { position: [], node };
    while (current?.node) {
        yield current;
        current = {
            position: [...current.position, 0],
            node: current.node.children[0],
        };
    }
}

export function countMainPly(node: TreeNode): number {
    let count = 0;
    let cur = node;
    while (cur.children.length > 0) {
        count++;
        cur = cur.children[0];
    }
    return count;
}

export function defaultTree(fen?: string): TreeState {
    const [pos] = positionFromFen(fen ?? INITIAL_FEN);

    return {
        dirty: false,
        position: [],
        root: {
            fen: fen?.trim() ?? INITIAL_FEN,
            move: null,
            san: null,
            children: [],
            score: null,
            depth: null,
            halfMoves: pos?.turn === "black" ? 1 : 0,
            shapes: [],
            annotations: [],
            comment: "",
        },
        headers: {
            id: 0,
            fen: fen ?? INITIAL_FEN,
            black: "",
            white: "",
            result: "*",
            event: "",
            site: "",
        },
        report: {
            progress: 0,
            isCompleted: false,
            inProgress: false,
        },
    };
}

export function createNode({
    fen,
    move,
    san,
    halfMoves,
    clock,
}: {
    move: Move;
    san: string;
    fen: string;
    halfMoves: number;
    clock?: number;
}): TreeNode {
    return {
        fen,
        move,
        san,
        clock: clock ? clock / 1000 : undefined,
        children: [],
        score: null,
        depth: null,
        halfMoves,
        shapes: [],
        annotations: [],
        comment: "",
    };
}

export type GameHeaders = {
    id: number;
    fen: string;
    event: string;
    site: string;
    date?: string | null;
    time?: string | null;
    round?: string | null;
    white: string;
    white_elo?: number | null;
    black: string;
    black_elo?: number | null;
    result: Outcome;
    time_control?: string | null;
    white_time_control?: string | null;
    black_time_control?: string | null;
    eco?: string | null;
    variant?: string | null;
    // Repertoire headers
    start?: number[];
    orientation?: "white" | "black";
};

export function getGameName(headers: GameHeaders) {
    if ((headers.white && headers.white !== "?") || (headers.black && headers.black !== "?")) {
        return `${headers.white} - ${headers.black}`;
    }
    if (headers.event) {
        return headers.event;
    }
    return "Unknown";
}

export const getNodeAtPath = (node: TreeNode, path: number[]): TreeNode => {
    let currentNode = node;
    for (const index of path) {
        if (!currentNode.children || index >= currentNode.children.length) {
            return currentNode;
        }
        currentNode = currentNode.children[index];
    }
    return currentNode;
};
