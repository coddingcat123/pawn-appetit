import type { Key } from "@lichess-org/chessground/types";
import { Alert, Badge, Button, Group, Progress, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { makeSquare, makeUci } from "chessops";
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { commands } from "@/bindings";
import { TreeStateContext } from "@/components/TreeStateContext";
import { chessRepertoirePathAtom, liveExplanationFamily, previewFenAtom, previewShapesAtom } from "@/state/atoms";
import { ANNOTATION_INFO, NAG_INFO } from "@/utils/annotation";
import { positionFromFen } from "@/utils/chessops";
import type { BoardArrow, BoardHighlight, CandidateReportData, InterpretabilityFeature, RichReport } from "@/utils/richReport";
import { pgnColorToBrush } from "@/utils/richReport";
import { unwrap } from "@/utils/unwrap";
import FeatureModal from "./FeatureModal";

export function formatCandidateScore(candidate: { score_cp: number | null; score_mate: number | null }): string {
  if (candidate.score_mate !== null) {
    return `M${Math.abs(candidate.score_mate)}`;
  }
  if (candidate.score_cp !== null) {
    const pawns = candidate.score_cp / 100;
    return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(2)}`;
  }
  return "?";
}

export function NagBadge({ nag }: { nag: number | null }) {
  if (nag === null) return null;
  const glyph = NAG_INFO.get(`$${nag}`);
  if (!glyph) return null;
  const info = ANNOTATION_INFO[glyph];
  return (
    <Badge color={info.color} variant="filled">
      {glyph}
    </Badge>
  );
}

/** Weighted-importance bars, not just badges with numbers -- each term's bar length is
 * relative to the *strongest* term diff shown (not an absolute cp scale, which would
 * make most bars look tiny), so at a glance the most important reason is visually the
 * longest, matching the "weights the importance of these with a little bar" ask. */
function TermBadges({
  diffs,
  glossary,
}: {
  diffs: Record<string, number>;
  glossary?: Record<string, { display: string; text: string }>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const all = Object.entries(diffs)
    .filter(([, v]) => Math.abs(v) >= 0.03)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  if (all.length === 0) return null;
  const entries = expanded ? all : all.slice(0, 3);
  const maxAbs = Math.max(...all.map(([, v]) => Math.abs(v)));

  return (
    <Stack gap={4}>
      {entries.map(([name, value]) => {
        const term = glossary?.[name];
        const color = value >= 0 ? "green" : "red";
        const row = (
          <Group key={name} gap="xs" wrap="nowrap">
            <Text size="xs" w={110} truncate>
              {term?.display ?? name}
            </Text>
            <Progress value={maxAbs === 0 ? 0 : (Math.abs(value) / maxAbs) * 100} color={color} size="sm" flex={1} />
            <Text size="xs" w={44} ta="right" c={color}>
              {value >= 0 ? "+" : ""}
              {value.toFixed(2)}
            </Text>
          </Group>
        );
        // A classical term has no per-square attribution data (unlike an NNUE feature,
        // whose click opens a real heatmap) -- a glossary tooltip is the honest
        // "explanation" a term badge can actually offer.
        return term ? (
          <Tooltip key={name} label={term.text} multiline w={240} withArrow>
            {row}
          </Tooltip>
        ) : (
          row
        );
      })}
      {all.length > 3 && (
        <Text size="xs" c="dimmed" style={{ cursor: "pointer" }} onClick={() => setExpanded((v) => !v)}>
          {expanded
            ? t("features.board.analysis.explanation.showLess")
            : t("features.board.analysis.explanation.showMore", { count: all.length - 3 })}
        </Text>
      )}
    </Stack>
  );
}

/** Plays a sequence of SAN moves from `fen` and returns the resulting FEN plus the last
 * move's from/to squares, or `null` if any move fails to parse/apply -- used to preview
 * what a candidate actually looks like on the board (via `previewFenAtom`/
 * `previewShapesAtom`) WITHOUT calling the tree store's makeMoves, which would navigate
 * the real game/re-trigger engine analysis just to look at a candidate. */
function previewFromSan(fen: string, sanMoves: string[]): { fen: string; lastMove: { orig: Key; dest: Key } | null } | null {
  const [pos] = positionFromFen(fen);
  if (!pos) return null;
  let lastMove: { orig: Key; dest: Key } | null = null;
  for (const san of sanMoves) {
    const move = parseSan(pos, san);
    if (!move) return null;
    if ("from" in move && "to" in move) {
      lastMove = { orig: makeSquare(move.from) as Key, dest: makeSquare(move.to) as Key };
    }
    pos.play(move);
  }
  return { fen: makeFen(pos.toSetup()), lastMove };
}

function boardShapesFor({ arrows, highlights }: { arrows: BoardArrow[]; highlights: BoardHighlight[] }) {
  return [
    ...arrows.map((a) => ({ orig: a.from_square as Key, dest: a.to_square as Key, brush: pgnColorToBrush(a.color) })),
    ...highlights.map((h) => ({ orig: h.square as Key, dest: h.square as Key, brush: pgnColorToBrush(h.color) })),
  ];
}

/** Position-level tactical motifs (pins, forks, skewers -- see board_viz.py) -- apply to
 * the current position regardless of which candidate is shown, so they render once,
 * above the verdict. Hovering previews the arrows/highlights; nothing renders if
 * there's nothing to show (no fabricated "0 pins" badge). */
function TacticsBadges({ tactics }: { tactics: RichReport["tactics"] }) {
  const { t } = useTranslation();
  const setPreviewShapes = useSetAtom(previewShapesAtom);
  if (!tactics) return null;

  const items = [
    { key: "pins", label: t("features.board.analysis.explanation.pins"), data: tactics.pins },
    { key: "forks", label: t("features.board.analysis.explanation.forks"), data: tactics.forks },
    { key: "skewers", label: t("features.board.analysis.explanation.skewers"), data: tactics.skewers },
    { key: "xrays", label: t("features.board.analysis.explanation.xrays"), data: tactics.xrays },
    { key: "batteries", label: t("features.board.analysis.explanation.batteries"), data: tactics.batteries },
    { key: "relative_pins", label: t("features.board.analysis.explanation.relativePins"), data: tactics.relative_pins },
    { key: "trapped", label: t("features.board.analysis.explanation.trapped"), data: tactics.trapped },
    { key: "overloaded", label: t("features.board.analysis.explanation.overloaded"), data: tactics.overloaded },
    // `data` is optional on every key beyond pins/forks/skewers -- an older cached
    // report or `[%creport]` tag genuinely may not have them (see richReport.ts).
  ].filter((i): i is typeof i & { data: NonNullable<typeof i.data> } => (i.data?.highlights.length ?? 0) > 0);
  if (items.length === 0) return null;

  return (
    <Group gap="xs">
      {items.map((i) => (
        <Badge
          key={i.key}
          variant="light"
          color="grape"
          style={{ cursor: "pointer" }}
          onMouseEnter={() => setPreviewShapes(boardShapesFor(i.data))}
          onMouseLeave={() => setPreviewShapes([])}
        >
          {i.label} ({i.data.highlights.length})
        </Badge>
      ))}
    </Group>
  );
}

/** The best move's own reasoning: verdict prose (rendered by the caller, via the
 * verdict card), structural facts, and weighted term-diff bars. NNUE feature badges
 * stay reachable (click opens the real heatmap in FeatureModal) but aren't the focus. */
/** The deep, causal, per-move sentences -- desperado/removed-defender/perpetual-
 * check/windmill/threat-response are already full sentences from the Python side
 * (deliberately not fabricated here); check_kind is the one bare enum value needing a
 * translated wrapper. Each is independently null most of the time -- only real,
 * honestly-detected motifs ever render a line here. */
function DeepReasons({ candidate }: { candidate: CandidateReportData }) {
  const { t } = useTranslation();
  const lines = [
    candidate.check_kind && t("features.board.analysis.explanation.checkKind", { kind: candidate.check_kind }),
    candidate.threat_response,
    candidate.desperado,
    candidate.removed_defender,
    candidate.perpetual_check,
    candidate.windmill,
  ].filter((l): l is string => Boolean(l));
  if (lines.length === 0) return null;
  return (
    <Stack gap={2}>
      {lines.map((line) => (
        <Text key={line} size="sm" c="teal">
          {line}
        </Text>
      ))}
    </Stack>
  );
}

/** The "major threats" list -- the opponent's alternative replies to this candidate,
 * each with its own score and reasons (chess.com's Game Review shows the opponent's
 * alternatives this way). Hovering previews the reply on the board. */
function MajorThreats({ candidate, fen }: { candidate: CandidateReportData; fen: string }) {
  const { t } = useTranslation();
  const setPreviewFen = useSetAtom(previewFenAtom);
  if (candidate.threats.length === 0) return null;

  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed" fw="bold">
        {t("features.board.analysis.explanation.majorThreats")}
      </Text>
      {candidate.threats.map((threat) => (
        <Group
          key={threat.move_uci}
          gap="xs"
          wrap="nowrap"
          style={{ cursor: "pointer" }}
          onMouseEnter={() => {
            const preview = previewFromSan(fen, [candidate.move_san, threat.move_san]);
            setPreviewFen(preview?.fen ?? null);
          }}
          onMouseLeave={() => setPreviewFen(null)}
        >
          <Text size="sm" fw="bold">
            {threat.move_san}
          </Text>
          <Text size="xs" c="dimmed">
            {formatCandidateScore(threat)}
          </Text>
          {threat.structural_far.length > 0 && (
            <Text size="xs" c="dimmed" truncate>
              {threat.structural_far.join("; ")}
            </Text>
          )}
        </Group>
      ))}
    </Stack>
  );
}

/** Position-level facts -- not tied to any one candidate: the biggest threat right now
 * (before any candidate is chosen), zugzwang, and plain board facts (pay-attention
 * threats/defenders, advanced pawns, doubled 7th-rank rooks, weak back rank,
 * opposition). Renders nothing when the live report simply didn't run these (an older
 * `[%creport]` tag, or `--no-zugzwang`/`--no-threat-analysis`). */
function BoardFacts({ richReport }: { richReport: RichReport }) {
  const { t } = useTranslation();
  const facts = [...(richReport.pay_attention ?? []), ...(richReport.positional_facts ?? [])];
  const hasBiggestThreat = richReport.biggest_threat != null;
  if (!hasBiggestThreat && !richReport.zugzwang && facts.length === 0) return null;

  return (
    <Stack gap={2}>
      {richReport.biggest_threat && (
        <Text size="sm" c="orange">
          {t("features.board.analysis.explanation.biggestThreat", {
            move: richReport.biggest_threat.move_san,
            score: formatCandidateScore(richReport.biggest_threat),
          })}
        </Text>
      )}
      {richReport.zugzwang && (
        <Text size="sm" c="orange">
          {richReport.zugzwang}
        </Text>
      )}
      {facts.length > 0 && (
        <>
          <Text size="xs" c="dimmed" fw="bold">
            {t("features.board.analysis.explanation.boardFacts")}
          </Text>
          {facts.map((fact) => (
            <Text key={fact} size="xs" c="dimmed">
              {fact}
            </Text>
          ))}
        </>
      )}
    </Stack>
  );
}

function CandidatePanel({
  candidate,
  glossary,
  fen,
  onSelectFeature,
}: {
  candidate: CandidateReportData;
  glossary?: Record<string, { display: string; text: string }>;
  fen: string;
  onSelectFeature: (networkId: string, feature: InterpretabilityFeature) => void;
}) {
  const { t } = useTranslation();

  return (
    <Stack gap="xs">
      {candidate.pv_san.length > 1 && (
        <Text size="xs" c="dimmed">
          <Text span fw="bold" size="xs" c="dimmed">
            {t("features.board.analysis.explanation.bestLine")}:{" "}
          </Text>
          {candidate.pv_san.join(" ")}
        </Text>
      )}
      {candidate.structural_far.length > 0 && (
        <Text size="sm" c="dimmed">
          {candidate.structural_far.join("; ")}
        </Text>
      )}
      <DeepReasons candidate={candidate} />
      <TermBadges diffs={candidate.term_diffs_far} glossary={glossary} />
      {candidate.network_internals.map(
        (net) =>
          net.top_features.length > 0 && (
            <Group key={net.network_id} gap="xs">
              {net.top_features.map((feature) => (
                <Badge
                  key={feature.feature_id}
                  variant="outline"
                  size="xs"
                  color={feature.concept_display ? "blue" : "gray"}
                  style={{ cursor: "pointer" }}
                  onClick={() => onSelectFeature(net.network_id, feature)}
                >
                  {feature.concept_display ?? t("features.board.analysis.explanation.unlabeled")}
                </Badge>
              ))}
            </Group>
          ),
      )}
      <MajorThreats candidate={candidate} fen={fen} />
    </Stack>
  );
}

function GenerateExplanationPrompt({ fen, playedMoveUci }: { fen: string; playedMoveUci: string | null }) {
  const { t } = useTranslation();
  const [binaryPath, setBinaryPath] = useAtom(chessRepertoirePathAtom);
  const [, setLiveReport] = useAtom(liveExplanationFamily(fen));
  const [generating, setGenerating] = useState(false);

  const generate = async () => {
    setGenerating(true);
    try {
      const raw = unwrap(
        await commands.explainPosition(binaryPath, fen, {
          multipv: null,
          depth: null,
          classicalEval: null,
          branchAlternatives: null,
          interpretability: null,
          depthSeries: false,
          playedMoveUci,
          branchDepth: null,
          branchMultipv: null,
          featureTopK: null,
        }),
      );
      setLiveReport(JSON.parse(raw));
    } finally {
      setGenerating(false);
    }
  };

  // Always auto-generates on navigating to a position with no cached explanation yet --
  // no visible toggle for this; the whole point is a review that's just there, matching
  // the chess.com-style flow this was modeled on rather than an exploratory tool with
  // knobs to turn before every request.
  const autoFired = useRef(false);
  useEffect(() => {
    if (binaryPath && !autoFired.current) {
      autoFired.current = true;
      generate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binaryPath, fen]);

  if (!binaryPath) {
    return (
      <Stack p="md" gap="xs">
        <Text size="sm" c="dimmed">
          {t("features.board.analysis.explanation.noRichReport")}
        </Text>
        <TextInput
          label={t("features.board.analysis.explanation.binaryPathLabel")}
          placeholder="/path/to/chess-repertoire/.venv/bin/chess-repertoire"
          defaultValue={binaryPath}
          onBlur={(e) => setBinaryPath(e.currentTarget.value)}
        />
      </Stack>
    );
  }

  return (
    <Stack p="md" gap="xs">
      <Text size="sm" c="dimmed">
        {generating ? t("features.board.analysis.explanation.generating") : t("features.board.analysis.explanation.noRichReport")}
      </Text>
      <Button loading={generating} onClick={generate}>
        {t("features.board.analysis.explanation.generate")}
      </Button>
    </Stack>
  );
}

/** The lean, chess.com-style review: the best move's own reasoning (verdict prose
 * lives in the caller's VerdictCard; this renders structural facts, weighted term
 * bars, and NNUE feature badges for the top candidate), plus tactics badges and a
 * short "also considered" list for the alternatives -- not a full accordion of every
 * candidate with its own expandable detail. No debug/options/batch-generate chrome:
 * generation is always automatic and always uses chess-repertoire's own defaults. */
function Explanation() {
  const store = useContext(TreeStateContext)!;
  const currentNode = useStore(store, useShallow((s) => s.currentNode()));
  const setPreviewShapes = useSetAtom(previewShapesAtom);
  const setPreviewFen = useSetAtom(previewFenAtom);

  const [selected, setSelected] = useState<{ networkId: string; feature: InterpretabilityFeature } | null>(null);

  // Navigating for real (via the notation tree, not this panel's own hover previews)
  // must never leave a stale preview overriding the board.
  useEffect(() => {
    setPreviewShapes([]);
    setPreviewFen(null);
  }, [currentNode.fen, setPreviewShapes, setPreviewFen]);

  const liveReport = useAtomValue(liveExplanationFamily(currentNode.fen));
  const richReport: RichReport | null = currentNode.richReport ?? liveReport;

  // "explain the best move and the one that was played" -- if there's exactly one
  // child (the line being explored), pass its move so it's guaranteed to be explained
  // even if it isn't one of the engine's own top-N choices.
  const playedMoveUci =
    currentNode.children.length === 1 && currentNode.children[0].move ? makeUci(currentNode.children[0].move) : null;

  if (!richReport || richReport.candidates.length === 0) {
    return <GenerateExplanationPrompt fen={currentNode.fen} playedMoveUci={playedMoveUci} />;
  }

  const [top, ...others] = richReport.candidates;

  return (
    <Stack gap="sm">
      {richReport.warnings && richReport.warnings.length > 0 && (
        <Alert color="yellow" title="chess-repertoire reported an issue" py="xs">
          {richReport.warnings.join(" ")}
        </Alert>
      )}
      <BoardFacts richReport={richReport} />
      <TacticsBadges tactics={richReport.tactics} />
      <CandidatePanel
        candidate={top}
        glossary={richReport.term_glossary}
        fen={currentNode.fen}
        onSelectFeature={(networkId, feature) => setSelected({ networkId, feature })}
      />
      {others.length > 0 && (
        <Group gap="xs" wrap="wrap">
          {others.map((candidate) => (
            <Badge
              key={candidate.move_uci}
              variant="light"
              color="gray"
              style={{ cursor: "pointer" }}
              onMouseEnter={() => {
                const preview = previewFromSan(currentNode.fen, [candidate.move_san]);
                setPreviewFen(preview?.fen ?? null);
                setPreviewShapes(boardShapesFor(candidate));
              }}
              onMouseLeave={() => {
                setPreviewFen(null);
                setPreviewShapes([]);
              }}
            >
              {candidate.move_san} ({formatCandidateScore(candidate)})
            </Badge>
          ))}
        </Group>
      )}
      <FeatureModal
        networkId={selected?.networkId ?? ""}
        feature={selected?.feature ?? null}
        fen={currentNode.fen}
        onClose={() => setSelected(null)}
      />
    </Stack>
  );
}

export default Explanation;
