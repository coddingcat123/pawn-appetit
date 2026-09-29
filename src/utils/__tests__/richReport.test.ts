import { expect, test } from "vitest";
import { parseRichReport, stripRichReportTag, type RichReport } from "../richReport";

function encodeTag(payload: RichReport): string {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    return `[%creport ${btoa(binary)}]`;
}

const SAMPLE: RichReport = {
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
                            feature_id: 4674,
                            activation: 0.5,
                            concept_label: "king_safety",
                            concept_display: "King safety attackers avoided",
                            correlation: 0.36,
                            correlation_n: 70,
                            attribution_squares: [
                                ["e5", 0.9],
                                ["g8", 0.5],
                            ],
                        },
                    ],
                },
            ],
            arrows: [{ from_square: "e2", to_square: "e4", color: "B" }],
            highlights: [],
            is_brilliant: false,
            nag: null,
            summary: "favors White primarily via Material (+0.30).",
            reply_san: null,
            pv_san: ["e4"],
            check_kind: null,
            desperado: null,
            removed_defender: null,
            perpetual_check: null,
            windmill: null,
            threat_response: null,
            threats: [],
        },
    ],
};

test("parses a real [%creport] tag back into the original payload", () => {
    const comment = `${encodeTag(SAMPLE)} e4 (rank 1) -- engine's top choice.`;
    const parsed = parseRichReport(comment);
    expect(parsed).toEqual(SAMPLE);
});

test("returns null when no tag is present", () => {
    expect(parseRichReport("just a plain comment")).toBeNull();
});

test("returns null for a malformed tag rather than throwing", () => {
    expect(parseRichReport("[%creport not-valid-base64!!!]")).toBeNull();
});

test("round-trips non-ASCII text correctly (UTF-8, not latin1)", () => {
    const payload: RichReport = {
        ...SAMPLE,
        candidates: [
            { ...SAMPLE.candidates[0], move_san: "e4 – café ⚔" }, // en dash, café, crossed swords
        ],
    };
    const parsed = parseRichReport(encodeTag(payload));
    expect(parsed?.candidates[0].move_san).toBe("e4 – café ⚔");
});

test("strips the tag and adjoining space, leaving the rest of the comment intact", () => {
    const comment = `${encodeTag(SAMPLE)} e4 (rank 1) -- engine's top choice.`;
    expect(stripRichReportTag(comment)).toBe("e4 (rank 1) -- engine's top choice.");
});

test("stripRichReportTag is a no-op when there is no tag", () => {
    expect(stripRichReportTag("plain comment")).toBe("plain comment");
});
