/**
 * Explanation panel (chess-repertoire integration) atoms.
 * Covers the live explainPosition cache, board preview overrides for candidate/PV
 * hovers, and the chess-repertoire binary path setting.
 */
import type { DrawShape } from "@lichess-org/chessground/draw";
import { atom } from "jotai";
import { atomFamily, atomWithStorage } from "jotai/utils";
import type { RichReport } from "@/utils/richReport";

/** Temporary board shapes shown while a network-internals feature chip's popup is
 * open (its attribution squares), or a candidate/PV is being previewed -- never
 * persisted, cleared on modal close / preview end. Kept as a plain top-level atom (not
 * per-tab) since only one such preview can be active at a time across the whole app. */
export const previewShapesAtom = atom<DrawShape[]>([]);

/** Overrides the main board's displayed FEN while non-null -- e.g. hovering/expanding a
 * candidate move or a depth-series PV in the Explanation panel shows what the resulting
 * position actually looks like, without touching the real tree/currentNode (no
 * makeMoves call, so no re-triggering engine analysis on every hover). The board
 * renders a tint overlay whenever this is set, so it's visually obvious the board isn't
 * showing the real, current position. Cleared (set back to null) when the preview ends. */
export const previewFenAtom = atom<string | null>(null);

/** Path to the `chess-repertoire` console script (e.g. `<project>/.venv/bin/chess-repertoire`)
 * -- a plain path string, not assumed to be on PATH. Used by the "Generate explanation"
 * button to invoke `explainPosition`. */
export const chessRepertoirePathAtom = atomWithStorage<string>("chess-repertoire-path", "");

/** Live-generated explanations (via `explainPosition`, not parsed from an imported
 * `--rich` PGN), cached per FEN so revisiting an already-explained position doesn't
 * re-invoke the subprocess. Deliberately NOT written back into `TreeNode.richReport` --
 * that field stays reserved for what an imported PGN actually carries, so "parsed from a
 * file" and "generated live" remain visibly distinct data sources even though the
 * Explanation panel renders both the same way. Ephemeral (not persisted across
 * restarts), same as `previewShapesAtom`.
 */
export const liveExplanationFamily = atomFamily((_fen: string) => atom<RichReport | null>(null));
