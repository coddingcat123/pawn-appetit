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

/** Which parts of an already-generated report the Explanation panel actually renders --
 * independent of `explainGenerationSettingsAtom`, which controls what chess-repertoire
 * computes in the first place. Turning a section off here just hides it; the data (if
 * computed) is still there if turned back on. `showUnlabeledFeatures` defaults off: an
 * "UNLABELED" badge is chess-repertoire internals leaking through (a fired NNUE feature
 * with no trained concept label yet), not something a normal review needs to see -- the
 * `debug` toggle in the panel's settings surfaces it back for anyone who does. */
// "-v3": a persisted value from before a default in here changed would otherwise keep
// overriding the new default forever -- `atomWithStorage`'s default is only ever used
// the very first time a key has no stored value, never to migrate an existing one.
// Bump this suffix again any time a default changes and needs to actually take effect
// for someone who already has an old value saved.
export const explanationDisplaySettingsAtom = atomWithStorage("explanation-display-settings-v3", {
    showBoardFacts: true,
    showTactics: true,
    showMajorThreats: true,
    showTermBars: true,
    showDeepReasons: true,
    // On by default (moved back from an earlier off-by-default pass): with classical
    // eval retired, NNUE feature badges are the *only* remaining Concepts content --
    // hiding them by default left that whole section permanently empty. Duplicate/
    // unlabeled badges are already filtered out (see ConceptsTab's dedup), so what's
    // left is clean.
    showFeatureBadges: true,
    showUnlabeledFeatures: false,
    showSearchProgression: true,
});

/** What chess-repertoire actually computes when generating an explanation, live
 * (single position, the "Generate explanation" button) or in batch ("generate for
 * whole game" in ReportModal) -- mirrors `explain_cmd.py`'s own flags 1:1. A `null`
 * numeric field means "let chess-repertoire use its own default" (its CLI's own
 * defaults, not duplicated here, so this app's defaults can't silently drift from the
 * Python tool's). Persisted (like `reportSettingsAtom`) since these are the same kind
 * of "remember what I last configured" setting. */
// "-v2": same reasoning as explanationDisplaySettingsAtom above -- classicalEval's
// default just changed to false, and a stale persisted `true` would otherwise silently
// keep the classical engine on forever for anyone who already used this app.
export const explainGenerationSettingsAtom = atomWithStorage("explanation-generation-settings-v2", {
    multipv: null as number | null,
    depth: null as number | null,
    branchDepth: null as number | null,
    branchMultipv: null as number | null,
    featureTopK: null as number | null,
    // Off by default: the classical Stockfish-11 term breakdown ("Mobility +0.14") is
    // over a decade obsolete and a much weaker signal than the live verdict/new_facts
    // reasoning, which is all NNUE/geometric now. Still available as an opt-in for
    // anyone who wants the classical bars back in the Concepts section.
    classicalEval: false,
    branchAlternatives: true,
    interpretability: true,
    depthSeries: true,
});
