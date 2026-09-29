/**
 * Explanation panel (chess-repertoire integration) atoms.
 * Covers the live explainPosition cache, board preview overrides for candidate/PV
 * hovers, and persisted user preferences for that panel (binary path, auto-generate,
 * debug numbers, and explain-options like depth/multipv).
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

/** Whether navigating to a new position with no cached explanation should generate one
 * automatically, rather than requiring a manual click every time. Persisted -- a real
 * per-position latency preference, not ephemeral UI state. Default on: an easy toggle
 * exists for when that gets too slow navigating quickly through a line. */
export const autoExplainAtom = atomWithStorage<boolean>("auto-explain", true);

/** "a debug to show the numbers" -- when on, network-internals feature badges show
 * their raw activation/correlation numbers inline instead of only the concept label,
 * without needing to open the feature modal for every one of them. Persisted like
 * `autoExplainAtom`: a standing preference, not per-session UI state. */
export const debugNumbersAtom = atomWithStorage<boolean>("explain-debug-numbers", false);

/** User-adjustable knobs for `explainPosition` -- `null` for any field means "let
 * chess-repertoire use its own CLI default", not "explicitly zero"; the options dialog
 * only ever writes a field once the user actually touches its input, matching how the
 * Rust-side `ExplainOptions` (`push_flag`/plain Option<T>) already treats absence.
 * Named `ExplainSettings` (not `ExplainOptions`) to stay visually distinct from the
 * generated Rust-command type of that name in `@/bindings`. */
export interface ExplainSettings {
    multipv: number | null;
    depth: number | null;
    branchDepth: number | null;
    branchMultipv: number | null;
    featureTopK: number | null;
}

export const explainSettingsAtom = atomWithStorage<ExplainSettings>("explain-options", {
    multipv: null,
    depth: null,
    branchDepth: null,
    branchMultipv: null,
    featureTopK: null,
});
