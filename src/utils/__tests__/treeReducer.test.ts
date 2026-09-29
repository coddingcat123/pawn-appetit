import { parseUci } from "chessops";
import { expect, test } from "vitest";
import { findFeatureExamples, playedMoveCandidate, type TreeNode } from "../treeReducer";

function node(fen: string, children: TreeNode[] = [], featureId?: number, activation = 0.5): TreeNode {
    return {
        fen,
        move: null,
        san: fen === "root" ? null : fen,
        children,
        score: null,
        depth: null,
        halfMoves: 0,
        shapes: [],
        annotations: [],
        comment: "",
        richReport:
            featureId === undefined
                ? undefined
                : {
                      candidates: [
                          {
                              move_uci: "e2e4",
                              move_san: "e4",
                              rank: 1,
                              score_cp: 30,
                              score_mate: null,
                              mover_is_white: true,
                              term_diffs_far: {},
                              structural_far: [],
                              network_internals: [
                                  {
                                      network_id: "nnue",
                                      top_features: [
                                          {
                                              feature_id: featureId,
                                              activation,
                                              concept_label: null,
                                              concept_display: null,
                                              correlation: null,
                                              correlation_n: null,
                                              attribution_squares: [],
                                          },
                                      ],
                                  },
                              ],
                              arrows: [],
                              highlights: [],
                              is_brilliant: false,
                              nag: null,
                              summary: "",
                          },
                      ],
                  },
    };
}

test("finds other positions where the same feature fires, excluding the clicked-from position", () => {
    const clickedFrom = node("start", [], 4674, 0.9);
    const sameFeature = node("other-a", [], 4674, 0.3);
    const differentFeature = node("other-b", [], 9999, 0.9);
    const noRichReport = node("other-c");
    const root = node("root", [clickedFrom, sameFeature, differentFeature, noRichReport]);

    const examples = findFeatureExamples(root, "nnue", 4674, "start");

    expect(examples.map((e) => e.fen)).toEqual(["other-a"]);
});

test("ranks examples by |activation| descending", () => {
    const weak = node("weak", [], 42, 0.1);
    const strong = node("strong", [], 42, 0.9);
    const negative = node("negative", [], 42, -0.8);
    const root = node("root", [weak, strong, negative]);

    const examples = findFeatureExamples(root, "nnue", 42, "excluded-fen");

    expect(examples.map((e) => e.fen)).toEqual(["strong", "negative", "weak"]);
});

test("respects the limit", () => {
    const children = Array.from({ length: 10 }, (_, i) => node(`fen-${i}`, [], 1, i));
    const root = node("root", children);

    expect(findFeatureExamples(root, "nnue", 1, "excluded", 3)).toHaveLength(3);
});

test("only counts one example per position even with multiple matching candidates", () => {
    const child = node("dup", [], 7, 0.5);
    child.richReport!.candidates.push({ ...child.richReport!.candidates[0], move_uci: "d2d4" });
    const root = node("root", [child]);

    expect(findFeatureExamples(root, "nnue", 7, "excluded")).toHaveLength(1);
});

test("returns empty when no other position has the feature", () => {
    const root = node("root", [node("only", [], 1)]);
    expect(findFeatureExamples(root, "nnue", 999, "excluded")).toEqual([]);
});

test("playedMoveCandidate finds the candidate matching the node's own move", () => {
    // node()'s default richReport candidate is move_uci "e2e4".
    const child = node("after-e4", [], 1);
    child.move = parseUci("e2e4")!;
    child.richReport!.candidates[0].nag = 1;

    const candidate = playedMoveCandidate(child);

    expect(candidate?.move_uci).toBe("e2e4");
    expect(candidate?.nag).toBe(1);
});

test("playedMoveCandidate returns null when the node has no richReport", () => {
    const child = node("after-e4");
    child.move = parseUci("e2e4")!;
    expect(playedMoveCandidate(child)).toBeNull();
});

test("playedMoveCandidate returns null when the node's move isn't among the candidates", () => {
    const child = node("after-e4", [], 1); // richReport's only candidate is move_uci "e2e4"
    child.move = parseUci("d2d4")!;
    expect(playedMoveCandidate(child)).toBeNull();
});

test("playedMoveCandidate returns null for the root (no move led there)", () => {
    const root = node("root", [], 1);
    expect(playedMoveCandidate(root)).toBeNull();
});
