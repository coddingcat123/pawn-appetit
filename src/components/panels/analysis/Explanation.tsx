import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Paper,
  Popover,
  Progress,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconBolt,
  IconBulb,
  IconCheck,
  IconExclamationCircle,
  IconEyeExclamation,
  IconInfoCircle,
  IconSettings,
  IconThumbUp,
  IconX,
  type Icon,
} from "@tabler/icons-react";
import { makeSquare, makeUci } from "chessops";
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { commands } from "@/bindings";
import { TreeStateContext } from "@/components/TreeStateContext";
import {
  chessRepertoirePathAtom,
  explainGenerationSettingsAtom,
  explanationDisplaySettingsAtom,
  liveExplanationFamily,
  previewFenAtom,
  previewShapesAtom,
} from "@/state/atoms";
import { ANNOTATION_INFO, type Annotation, NAG_INFO } from "@/utils/annotation";
import { positionFromFen } from "@/utils/chessops";
import type {
  BestMoveNarrative,
  BoardArrow,
  BoardHighlight,
  CandidateReportData,
  DepthSeriesEntry,
  InterpretabilityFeature,
  NewFact,
  RichReport,
} from "@/utils/richReport";
import { pgnColorToBrush } from "@/utils/richReport";
import { unwrap } from "@/utils/unwrap";
import { CollapsibleSection } from "./CollapsibleSection";
import FeatureModal from "./FeatureModal";

/** chess.com's Game Review gives each reviewed move a colored icon avatar + quality
 * label ("Excellent", "Best", "Mistake"...) -- the same vocabulary this app's own
 * `ANNOTATION_INFO`/`NAG_INFO` already carries (color + translation key), just missing
 * an icon. One flat icon per quality tier, not a cartoon avatar -- the modernized take
 * on the same idea. */
const QUALITY_ICON: Partial<Record<Annotation, Icon>> = {
  "!!": IconBolt,
  "!": IconThumbUp,
  Best: IconCheck,
  "!?": IconBulb,
  "?!": IconAlertTriangle,
  "?": IconExclamationCircle,
  "??": IconX,
};

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

/** chess.com's Game Review card, modernized: a colored icon avatar (quality tier, from
 * NagBadge's own color/icon vocabulary) next to a tinted, rounded "speech bubble"
 * holding the move, its quality label + score, and everything this app knows about
 * why -- the verdict summary, "beware of" reply, and any deep reasons (desperado,
 * threat-response, etc.) for `candidate` specifically. One shared component for every
 * place a move's own review needs showing, so the played-move card (ReportPanel's
 * VerdictCard) and the live best-move card (Explanation's CandidatePanel) always look
 * and read identically. */
export function ReviewBubble({
  candidate,
  bewareOfLabel,
  children,
}: {
  candidate: CandidateReportData;
  /** The opponent's display name (e.g. "Black") for the "beware of ... playing Qa4"
   * line -- omit to suppress that line even when `reply_san` is present (the played-
   * move card has this; a live best-move card mid-exploration may not need it). */
  bewareOfLabel?: string;
  /** Extra content (term bars, structural facts, threats list, ...) rendered inside
   * the same bubble, below the standard verdict text. */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const glyph = candidate.nag !== null ? NAG_INFO.get(`$${candidate.nag}`) : undefined;
  const info = glyph ? ANNOTATION_INFO[glyph] : undefined;
  const color = info?.color ?? "gray";
  const Icon = (glyph && QUALITY_ICON[glyph]) || IconInfoCircle;
  const label = info?.translationKey ? t(`chess.annotate.${info.translationKey}`) : null;

  return (
    <Group align="flex-start" gap="sm" wrap="nowrap">
      <ThemeIcon size={38} radius="xl" color={color} variant="light" style={{ flexShrink: 0 }}>
        <Icon size={20} />
      </ThemeIcon>
      <Paper radius="lg" p="sm" flex={1} style={{ backgroundColor: `var(--mantine-color-${color}-light)` }}>
        <Group gap="xs" wrap="nowrap">
          <Text fw={700}>{candidate.move_san}</Text>
          <Text size="sm" c="dimmed">
            {formatCandidateScore(candidate)}
          </Text>
          {label && (
            <Badge color={color} variant="filled" size="sm">
              {label}
            </Badge>
          )}
          {candidate.is_sacrifice && (
            <Badge color="grape" variant="light" size="sm">
              {t("features.board.analysis.explanation.sacrifice", "Sacrifice")}
            </Badge>
          )}
        </Group>
        {candidate.summary && (
          <Text size="sm" c="dimmed" mt={4}>
            {candidate.summary}
          </Text>
        )}
        {candidate.reply_san && bewareOfLabel && (
          <Group gap={4} mt={4} wrap="nowrap">
            <IconEyeExclamation size={14} style={{ flexShrink: 0 }} />
            <Text size="sm">
              {t("features.board.analysis.explanation.bewareOf", { color: bewareOfLabel, move: candidate.reply_san })}
            </Text>
          </Group>
        )}
        {children}
      </Paper>
    </Group>
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

function boardShapesFor({ arrows, highlights }: { arrows: BoardArrow[]; highlights: BoardHighlight[] }): DrawShape[] {
  return [
    ...arrows.map((a) => ({ orig: a.from_square as Key, dest: a.to_square as Key, brush: pgnColorToBrush(a.color) })),
    ...highlights.map((h) => ({ orig: h.square as Key, dest: h.square as Key, brush: pgnColorToBrush(h.color) })),
  ];
}

/** Wraps a glyph (drawn in its own local coordinates, roughly centered on the
 * (50,50) midpoint of a 0-100 box) in a translucent colored circle badge, sized to sit
 * in the corner of a square without hiding the piece under it. This is what actually
 * renders per-tactic-type via chessground's `customSvg` shape field -- a REAL pictogram,
 * not text: chessground's `label` shape only ever draws short text (see `svg.ts`), which
 * is exactly what was rejected (pins/forks/etc. all need their own distinct glyph, not a
 * 3-4 letter abbreviation). `customSvg` renders a fixed 1x1-board-unit box with an
 * internal `viewBox="0 0 100 100"`, centered at a single point (`orig`/`dest`/`label`) --
 * confirmed by reading chessground's own `svg.ts` -- so every glyph below is authored in
 * that same 100x100 space, offset toward the top-right corner (cx=72,cy=28) so it reads
 * as a corner badge rather than covering the whole square. */
function badgeIcon(color: string, glyph: string): string {
  return `<circle cx="72" cy="28" r="20" fill="${color}" opacity="0.92" stroke="#1a1a1a" stroke-width="2"/>${glyph}`;
}

/** Real per-tactic-type pictograms (not text labels -- see `badgeIcon`'s docstring),
 * one simple, distinguishable glyph per motif, plus the same `board_viz.py`-echoing
 * color used before. All glyph coordinates are local to the (72,28) badge center. */
const TACTIC_ICONS: Record<string, { html: string; color: string }> = {
  // Pin: a ring (the pinned piece) threaded by a straight needle.
  pins: {
    color: "#3b82f6",
    html: badgeIcon(
      "#3b82f6",
      '<circle cx="72" cy="28" r="7" fill="none" stroke="#fff" stroke-width="3"/><line x1="72" y1="9" x2="72" y2="19" stroke="#fff" stroke-width="3" stroke-linecap="round"/><line x1="72" y1="37" x2="72" y2="47" stroke="#fff" stroke-width="3" stroke-linecap="round"/>',
    ),
  },
  // Fork: a trident/Y -- one piece attacking two others at once.
  forks: {
    color: "#ef4444",
    html: badgeIcon(
      "#ef4444",
      '<path d="M62,17 L72,29 L82,17 M72,29 L72,42" stroke="#fff" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    ),
  },
  // Skewer: a straight rod through a near piece and a far piece behind it.
  skewers: {
    color: "#22c55e",
    html: badgeIcon(
      "#22c55e",
      '<line x1="55" y1="28" x2="89" y2="28" stroke="#fff" stroke-width="3"/><circle cx="65" cy="28" r="5" fill="#fff"/><circle cx="80" cy="28" r="5" fill="none" stroke="#fff" stroke-width="2.5"/>',
    ),
  },
  // X-ray: a piece attacking through another, drawn as a dashed cross.
  xrays: {
    color: "#3b82f6",
    html: badgeIcon(
      "#3b82f6",
      '<line x1="60" y1="16" x2="84" y2="40" stroke="#fff" stroke-width="3" stroke-dasharray="4,3.5" stroke-linecap="round"/><line x1="84" y1="16" x2="60" y2="40" stroke="#fff" stroke-width="3" stroke-dasharray="4,3.5" stroke-linecap="round"/>',
    ),
  },
  // Battery: two stacked bars -- rook/queen lined up behind each other.
  batteries: {
    color: "#22c55e",
    html: badgeIcon(
      "#22c55e",
      '<rect x="62" y="17" width="20" height="7" rx="2" fill="#fff"/><rect x="62" y="28" width="20" height="7" rx="2" fill="#fff"/>',
    ),
  },
  // Relative pin: same needle-through-ring as an absolute pin, but the ring is dashed
  // (the piece CAN legally move, it's just costly to -- distinguishing it visually).
  relative_pins: {
    color: "#3b82f6",
    html: badgeIcon(
      "#3b82f6",
      '<circle cx="72" cy="28" r="7" fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="3,3"/><line x1="72" y1="9" x2="72" y2="19" stroke="#fff" stroke-width="3" stroke-linecap="round"/><line x1="72" y1="37" x2="72" y2="47" stroke="#fff" stroke-width="3" stroke-linecap="round"/>',
    ),
  },
  // Trapped: a piece boxed in by a cage/grid.
  trapped: {
    color: "#ef4444",
    html: badgeIcon(
      "#ef4444",
      '<rect x="61" y="17" width="22" height="22" fill="none" stroke="#fff" stroke-width="2.6"/><line x1="61" y1="28" x2="83" y2="28" stroke="#fff" stroke-width="2"/><line x1="72" y1="17" x2="72" y2="39" stroke="#fff" stroke-width="2"/>',
    ),
  },
  // Overloaded: an exclamation mark -- one defender doing too many jobs at once.
  overloaded: {
    color: "#ef4444",
    html: badgeIcon(
      "#ef4444",
      '<line x1="72" y1="16" x2="72" y2="30" stroke="#fff" stroke-width="4" stroke-linecap="round"/><circle cx="72" cy="38" r="2.6" fill="#fff"/>',
    ),
  },
};

/** `boardShapesFor` plus a real pictogram badge naming which tactic type this is (see
 * `TACTIC_ICONS`) -- shared by the persistent per-candidate view and the position-
 * level hover preview, so both actually look like the same visual language rather than
 * one having icons and the other not. */
function tacticShapesWithSymbol(key: string, entry: { arrows: BoardArrow[]; highlights: BoardHighlight[] }): DrawShape[] {
  const shapes: DrawShape[] = boardShapesFor(entry);
  const icon = TACTIC_ICONS[key];
  const firstSquare = entry.highlights[0]?.square ?? entry.arrows[0]?.to_square;
  if (icon && firstSquare) {
    shapes.push({ orig: firstSquare as Key, customSvg: { html: icon.html, center: "orig" } });
  }
  return shapes;
}

/** Flattens a candidate's own per-tactic-type arrows/highlights (pins/forks/skewers/...
 * in the position right after playing it) into board shapes, merged into the default
 * persistent view alongside the plain move arrow -- so the recommended move's own
 * tactics (a fork it creates, a pin it keeps) show with their real board_viz color, AND
 * a real pictogram badge naming which tactic it is, not just an unlabeled colored arrow
 * a person has to already know the color convention to read. */
function candidateTacticsShapes(tactics: CandidateReportData["candidate_tactics"]) {
  if (!tactics) return [];
  return Object.entries(tactics).flatMap(([key, entry]) => tacticShapesWithSymbol(key, entry));
}

/** A list of `NewFact`s -- text, a relative-importance bar from each fact's own real
 * `weight_cp` (not a fabricated number; see `NewFact`'s own docstring), and, for facts
 * that carry one, a hover preview of the square(s) that prove it. Shared by a
 * candidate's own `new_facts` and a threat's own `facts` -- same shape, same reasoning,
 * same rendering, rather than two ad-hoc lists that happen to look similar. */
function FactList({
  facts,
  defaultShapes,
}: {
  facts: NewFact[];
  defaultShapes: ReturnType<typeof boardShapesFor>;
}) {
  const setPreviewShapes = useSetAtom(previewShapesAtom);
  if (facts.length === 0) return null;
  const maxWeight = Math.max(...facts.map((f) => f.weight_cp), 1);

  return (
    <Stack gap={4}>
      {facts.map((f) => {
        const hoverable = f.arrows.length > 0 || f.highlights.length > 0;
        return (
          <Group
            key={f.text}
            gap="xs"
            wrap="nowrap"
            style={{ cursor: hoverable ? "pointer" : undefined }}
            onMouseEnter={() => hoverable && setPreviewShapes(boardShapesFor(f))}
            onMouseLeave={() => setPreviewShapes(defaultShapes)}
          >
            <Text size="sm" flex={1}>
              • {f.text}
            </Text>
            {f.weight_cp > 0 && (
              <Progress value={(f.weight_cp / maxWeight) * 100} color="teal" size="sm" w={50} />
            )}
          </Group>
        );
      })}
    </Stack>
  );
}

/** Position-level tactical motifs (pins, forks, skewers -- see board_viz.py) -- apply to
 * the current position regardless of which candidate is shown. Hovering previews the
 * arrows/highlights (restoring the persistent top-candidate shapes on mouse-leave, not
 * clearing the board to nothing); nothing renders if there's nothing to show (no
 * fabricated "0 pins" badge). */
function TacticsBadges({
  tactics,
  defaultShapes,
}: {
  tactics: RichReport["tactics"];
  defaultShapes: ReturnType<typeof boardShapesFor>;
}) {
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
    // live report or `[%creport]` tag genuinely may not have them (see richReport.ts).
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
          onMouseEnter={() => setPreviewShapes(tacticShapesWithSymbol(i.key, i.data))}
          onMouseLeave={() => setPreviewShapes(defaultShapes)}
        >
          {i.label} ({i.data.highlights.length})
        </Badge>
      ))}
    </Group>
  );
}

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
    candidate.underpromotion,
    candidate.greek_gift,
    candidate.zwischenzug,
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
 * alternatives this way). Hovering previews the reply on the board, restoring the
 * persistent default shapes on mouse-leave. */
function MajorThreats({
  candidate,
  fen,
  defaultShapes,
}: {
  candidate: CandidateReportData;
  fen: string;
  defaultShapes: ReturnType<typeof boardShapesFor>;
}) {
  const { t } = useTranslation();
  const setPreviewFen = useSetAtom(previewFenAtom);
  const setPreviewShapes = useSetAtom(previewShapesAtom);
  if (candidate.threats.length === 0) return null;

  return (
    <Stack gap={4} mt={4}>
      <Text size="xs" fw={700} tt="uppercase" c="dimmed">
        {t("features.board.analysis.explanation.majorThreats")}
      </Text>
      {candidate.threats.map((threat) => (
        <Paper
          key={threat.move_uci}
          radius="sm"
          p={6}
          withBorder
          style={{ cursor: "pointer" }}
          onMouseEnter={() => {
            // The compact threats list has no arrows/highlights of its own (see
            // BranchReportDataCompact) -- unlike every other hover-preview in this
            // panel, so the arrow here is built from the move's own from/to squares
            // directly (yellow, matching board_viz.py's own COLOR_THREAT convention)
            // rather than real computed tactics data.
            const preview = previewFromSan(fen, [candidate.move_san, threat.move_san]);
            setPreviewFen(preview?.fen ?? null);
            setPreviewShapes(preview?.lastMove ? [{ ...preview.lastMove, brush: "yellow" }] : defaultShapes);
          }}
          onMouseLeave={() => {
            setPreviewFen(null);
            setPreviewShapes(defaultShapes);
          }}
        >
          <Group gap={6} wrap="nowrap" align="flex-start">
            <ThemeIcon size={18} radius="xl" color="red" variant="light" style={{ flexShrink: 0, marginTop: 1 }}>
              <IconEyeExclamation size={12} />
            </ThemeIcon>
            <div style={{ minWidth: 0 }}>
              <Group gap="xs" wrap="nowrap">
                <Text size="sm" fw={700}>
                  {threat.move_san}
                </Text>
                <Text size="xs" c="dimmed">
                  {formatCandidateScore(threat)}
                </Text>
              </Group>
              {threat.facts.length > 0 ? (
                <FactList facts={threat.facts} defaultShapes={defaultShapes} />
              ) : (
                threat.structural_far.length > 0 && (
                  <Text size="xs" c="dimmed">
                    {threat.structural_far.join("; ")}
                  </Text>
                )
              )}
            </div>
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}

/** Position-level facts -- not tied to any one candidate: zugzwang and plain board facts
 * (pay-attention threats/defenders, advanced pawns, doubled 7th-rank rooks, weak back
 * rank, opposition). The single biggest threat right now lives in the Threats tab
 * instead (`ThreatsTab`), alongside the rest of what to be afraid of. Renders nothing
 * when the live report simply didn't run these (an older `[%creport]` tag, or
 * `--no-zugzwang`). */
function BoardFacts({
  richReport,
  defaultShapes,
}: {
  richReport: RichReport;
  defaultShapes: ReturnType<typeof boardShapesFor>;
}) {
  const setPreviewShapes = useSetAtom(previewShapesAtom);
  // `pay_attention_detailed` (arrows/highlights per fact) is the newer field -- fall
  // back to the plain-text `pay_attention` (no hover preview) for an older cached
  // report generated before it existed.
  const detailedFacts: { text: string; arrows: BoardArrow[]; highlights: BoardHighlight[] }[] =
    richReport.pay_attention_detailed ?? (richReport.pay_attention ?? []).map((text) => ({ text, arrows: [], highlights: [] }));
  const positionalFacts = richReport.positional_facts ?? [];
  const warnings = [richReport.zugzwang].filter((w): w is string => Boolean(w));
  if (warnings.length === 0 && detailedFacts.length === 0 && positionalFacts.length === 0) return null;

  return (
    <Paper radius="md" p="xs" withBorder>
      <Stack gap={6}>
        {warnings.map((warning) => (
          <Group key={warning} gap={6} wrap="nowrap" align="flex-start">
            <ThemeIcon size={18} radius="xl" color="orange" variant="light" style={{ flexShrink: 0, marginTop: 1 }}>
              <IconEyeExclamation size={12} />
            </ThemeIcon>
            <Text size="sm">{warning}</Text>
          </Group>
        ))}
        {detailedFacts.map((fact) => (
          <Group
            key={fact.text}
            gap={6}
            wrap="nowrap"
            align="flex-start"
            style={{ cursor: fact.arrows.length || fact.highlights.length ? "pointer" : undefined }}
            onMouseEnter={() => {
              if (fact.arrows.length || fact.highlights.length) setPreviewShapes(boardShapesFor(fact));
            }}
            onMouseLeave={() => setPreviewShapes(defaultShapes)}
          >
            <ThemeIcon size={18} radius="xl" color="gray" variant="light" style={{ flexShrink: 0, marginTop: 1 }}>
              <IconInfoCircle size={12} />
            </ThemeIcon>
            <Text size="xs" c="dimmed">
              {fact.text}
            </Text>
          </Group>
        ))}
        {positionalFacts.map((fact) => (
          <Group key={fact} gap={6} wrap="nowrap" align="flex-start">
            <ThemeIcon size={18} radius="xl" color="gray" variant="light" style={{ flexShrink: 0, marginTop: 1 }}>
              <IconInfoCircle size={12} />
            </ThemeIcon>
            <Text size="xs" c="dimmed">
              {fact}
            </Text>
          </Group>
        ))}
      </Stack>
    </Paper>
  );
}

/** The opponent's single best move with a free tempo right now, plus the top
 * candidate's own "major threats" reply list -- everything to be afraid of, in one
 * tab. Position-level tactics badges (pins/forks/x-rays/...) sit above both, since
 * they're facts about the board, not about any one candidate. */
function ThreatsTab({
  richReport,
  top,
  fen,
  defaultShapes,
}: {
  richReport: RichReport;
  top: CandidateReportData;
  fen: string;
  defaultShapes: ReturnType<typeof boardShapesFor>;
}) {
  const { t } = useTranslation();
  const hasTactics = richReport.tactics && Object.values(richReport.tactics).some((v) => (v?.highlights.length ?? 0) > 0);
  // `threats` (plural) is the newer field -- several of the opponent's top replies, not
  // just the worst one. Falls back to the older singular `biggest_threat` for a cached
  // report generated before `threats` existed, so this tab still shows *something* for
  // those rather than going blank.
  const threats =
    richReport.threats ??
    (richReport.biggest_threat ? [{ ...richReport.biggest_threat, facts: [] as NewFact[] }] : []);
  const refutationLines = top.threat_refutation_lines ?? [];
  if (!hasTactics && threats.length === 0 && top.threats.length === 0) {
    return (
      <Text size="sm" c="dimmed" p="xs">
        {t("features.board.analysis.explanation.noThreats", "Nothing threatening in this position.")}
      </Text>
    );
  }
  return (
    <Stack gap="sm" mt="xs">
      <TacticsBadges tactics={richReport.tactics} defaultShapes={defaultShapes} />
      {threats.length > 0 && (
        <Paper radius="md" p="xs" withBorder>
          <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={4}>
            {t("features.board.analysis.explanation.majorThreats")}
          </Text>
          <Stack gap={4}>
            {threats.map((threat) => (
              <Group key={threat.move_san} gap={6} wrap="nowrap" align="flex-start">
                <ThemeIcon size={18} radius="xl" color="orange" variant="light" style={{ flexShrink: 0, marginTop: 1 }}>
                  <IconEyeExclamation size={12} />
                </ThemeIcon>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Text size="sm">
                    {threat.move_san} ({formatCandidateScore(threat)})
                  </Text>
                  <FactList facts={threat.facts} defaultShapes={defaultShapes} />
                </div>
              </Group>
            ))}
          </Stack>
        </Paper>
      )}
      {refutationLines.length > 0 && (
        <Stack gap={4}>
          <Text size="xs" fw={700} tt="uppercase" c="teal">
            {t("features.board.analysis.explanation.howMoveResponds", "How {{move}} responds", {
              move: top.move_san,
            })}
          </Text>
          {refutationLines.map((line) => (
            <Text key={line} size="sm" c="teal">
              {line}
            </Text>
          ))}
        </Stack>
      )}
      <MajorThreats candidate={top} fen={fen} defaultShapes={defaultShapes} />
    </Stack>
  );
}

/** The best line played out (`pv_san`), the other candidates worth considering, and --
 * when chess-repertoire streamed it -- the engine's own depth-by-depth search
 * progression: the real, honest version of "what was the engine thinking at each
 * point", not a fabricated plan. */
function PlansTab({
  top,
  others,
  fen,
  depthSeries,
  narrative,
}: {
  top: CandidateReportData;
  others: CandidateReportData[];
  fen: string;
  depthSeries?: DepthSeriesEntry[];
  narrative?: BestMoveNarrative;
}) {
  const { t } = useTranslation();
  const setPreviewFen = useSetAtom(previewFenAtom);
  const setPreviewShapes = useSetAtom(previewShapesAtom);
  const [showProgression, setShowProgression] = useState(false);
  const [showNarrative, setShowNarrative] = useState(true);
  const display = useAtomValue(explanationDisplaySettingsAtom);

  return (
    <Stack gap="sm" mt="xs">
      {top.pv_san.length > 1 && (
        <Paper radius="md" p="xs" withBorder>
          <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={4}>
            {t("features.board.analysis.explanation.bestLine")}
          </Text>
          <Text size="sm">{top.pv_san.join(" ")}</Text>
        </Paper>
      )}
      {others.length > 0 && (
        <Stack gap={4}>
          <Text size="xs" fw={700} tt="uppercase" c="dimmed">
            {t("features.board.analysis.explanation.alsoConsidered", "Also considered")}
          </Text>
          <Group gap="xs" wrap="wrap">
            {others.map((candidate) => (
              <Badge
                key={candidate.move_uci}
                variant="light"
                color="gray"
                style={{ cursor: "pointer" }}
                onMouseEnter={() => {
                  const preview = previewFromSan(fen, [candidate.move_san]);
                  setPreviewFen(preview?.fen ?? null);
                  setPreviewShapes(boardShapesFor(candidate));
                }}
                onMouseLeave={() => {
                  setPreviewFen(null);
                  setPreviewShapes(boardShapesFor(top));
                }}
              >
                {candidate.move_san} ({formatCandidateScore(candidate)})
              </Badge>
            ))}
          </Group>
        </Stack>
      )}
      {!narrative && (
        <Text size="xs" c="dimmed" fs="italic">
          {others.length === 0
            ? t(
                "features.board.analysis.explanation.noNarrativeNoAlternatives",
                "No second candidate to contrast against -- nothing to walk through.",
              )
            : t(
                "features.board.analysis.explanation.noNarrativeNoRealTrap",
                "The other candidates don't have a real trap to contrast against -- this position doesn't need a guided walkthrough, any reasonable try is close in strength.",
              )}
        </Text>
      )}
      {narrative && (
        <Stack gap={4}>
          <Text
            size="xs"
            fw={700}
            tt="uppercase"
            c="dimmed"
            style={{ cursor: "pointer" }}
            onClick={() => setShowNarrative((v) => !v)}
          >
            {t("features.board.analysis.explanation.howToFindTheBestMove", "How to find the best move")}{" "}
            {showNarrative ? "▾" : "▸"}
          </Text>
          {showNarrative && (
            <Stack gap={6}>
              <div>
                <Text size="xs" fw={700} c="blue">
                  {t("features.board.analysis.explanation.narrativeIdea", "Idea")}
                </Text>
                <Text size="sm">{narrative.idea}</Text>
              </div>
              <div>
                <Text size="xs" fw={700} c="red">
                  {t("features.board.analysis.explanation.narrativeProblem", "Problem")}
                </Text>
                <Text size="sm">{narrative.problem}</Text>
              </div>
              <div>
                <Text size="xs" fw={700} c="green">
                  {t("features.board.analysis.explanation.narrativeSolution", "Solution")}
                </Text>
                <Text size="sm">{narrative.solution}</Text>
              </div>
              <div>
                <Text size="xs" fw={700} c="dimmed">
                  {t("features.board.analysis.explanation.narrativeOutcome", "Outcome")}
                </Text>
                <Text size="sm">{narrative.outcome}</Text>
              </div>
            </Stack>
          )}
        </Stack>
      )}
      {display.showSearchProgression && depthSeries && depthSeries.length > 0 && (
        <Stack gap={4}>
          <Text
            size="xs"
            fw={700}
            tt="uppercase"
            c="dimmed"
            style={{ cursor: "pointer" }}
            onClick={() => setShowProgression((v) => !v)}
          >
            {t("features.board.analysis.explanation.searchProgression")} {showProgression ? "▾" : "▸"}
          </Text>
          {showProgression && (
            <Stack gap={2}>
              {depthSeries.map((entry) => (
                <Group key={entry.depth} gap="xs" wrap="nowrap">
                  <Text size="xs" c="dimmed" w={50}>
                    depth {entry.depth}
                  </Text>
                  <Text size="xs" truncate>
                    {entry.candidates
                      .slice(0, 3)
                      .map((c) => `${c.move_san} (${formatCandidateScore(c)})`)
                      .join(", ")}
                  </Text>
                </Group>
              ))}
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/** The classical-term weighted bars, NNUE feature badges (filtered to labeled concepts
 * by default -- an "UNLABELED" pill is chess-repertoire internals leaking through, not
 * something a normal review needs), and the term glossary they draw from. */
function ConceptsTab({
  candidate,
  glossary,
  onSelectFeature,
}: {
  candidate: CandidateReportData;
  glossary?: Record<string, { display: string; text: string }>;
  onSelectFeature: (networkId: string, feature: InterpretabilityFeature) => void;
}) {
  const { t } = useTranslation();
  const display = useAtomValue(explanationDisplaySettingsAtom);

  const networks = candidate.network_internals
    .map((net) => {
      const seen = new Set<string>();
      const filtered = display.showUnlabeledFeatures
        ? net.top_features
        : net.top_features.filter((f) => f.concept_display);
      // Different raw SAE features (different `feature_id`s) routinely correlate with
      // the exact same labeled concept (e.g. three separate neurons all landing on
      // "king safety attackers avoided") -- a real property of the trained network, not
      // a bug, but showing the same text three times in a row reads as broken/cluttered
      // rather than as three independent pieces of evidence. Keep the first (typically
      // highest-activation) feature per unique label.
      const deduped = filtered.filter((f) => {
        const key = f.concept_display ?? `#${f.feature_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { ...net, top_features: deduped };
    })
    .filter((net) => net.top_features.length > 0);

  const hasTermBars = Object.entries(candidate.term_diffs_far).some(([, v]) => Math.abs(v) >= 0.03);

  if (!hasTermBars && (!display.showFeatureBadges || networks.length === 0)) {
    return (
      <Text size="sm" c="dimmed" p="xs">
        {t("features.board.analysis.explanation.noConcepts", "No labeled concepts for this position yet.")}
      </Text>
    );
  }

  return (
    <Stack gap="sm" mt="xs">
      {hasTermBars && <TermBadges diffs={candidate.term_diffs_far} glossary={glossary} />}
      {display.showFeatureBadges &&
        networks.map((net) => (
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
        ))}
    </Stack>
  );
}

/** Just the persistent header bubble -- icon, move, quality badge, verdict prose, and
 * its short structural-facts elaboration. Deliberately not the deep reasoning/term
 * bars/threats too (those live in the tabs below, each behind its own display toggle);
 * this always renders so there's always at least one thing to see at a glance. */
function CandidatePanel({ candidate }: { candidate: CandidateReportData }) {
  const { t } = useTranslation();
  const opponentColor = candidate.mover_is_white ? t("chess.black") : t("chess.white");

  return (
    <ReviewBubble candidate={candidate} bewareOfLabel={opponentColor}>
      {candidate.structural_far.length > 0 && (
        <Text size="sm" c="dimmed" mt={4}>
          {candidate.structural_far.join("; ")}
        </Text>
      )}
    </ReviewBubble>
  );
}

/** The settings popover shared by both the panel header (display-only toggles, cheap --
 * they just hide already-computed sections) and pointed at from the on-demand
 * "Generate" flow (which also reads `explainGenerationSettingsAtom` for what to
 * actually compute). Kept as plain checkboxes, not a modal -- these are flipped rarely,
 * while browsing a game, so a heavyweight dialog would be the wrong weight for it. */
function DisplaySettingsPopover() {
  const { t } = useTranslation();
  const [display, setDisplay] = useAtom(explanationDisplaySettingsAtom);

  const toggle = (key: keyof typeof display) => setDisplay((d) => ({ ...d, [key]: !d[key] }));

  return (
    <Popover width={260} position="bottom-end" shadow="md" withArrow>
      <Popover.Target>
        <Tooltip label={t("features.sidebar.settings")}>
          <ThemeIcon variant="subtle" color="gray" size="sm" style={{ cursor: "pointer" }}>
            <IconSettings size={16} />
          </ThemeIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={6}>
          <Text size="xs" fw={700} tt="uppercase" c="dimmed">
            {t("features.board.analysis.explanation.tabTitle")}
          </Text>
          <Checkbox
            size="xs"
            label={t("features.board.analysis.explanation.boardFacts")}
            checked={display.showBoardFacts}
            onChange={() => toggle("showBoardFacts")}
          />
          <Checkbox
            size="xs"
            label={t("features.board.analysis.explanation.majorThreats")}
            checked={display.showMajorThreats}
            onChange={() => toggle("showMajorThreats")}
          />
          <Checkbox
            size="xs"
            label={t("features.board.analysis.explanation.termBars", "Term importance bars")}
            checked={display.showTermBars}
            onChange={() => toggle("showTermBars")}
          />
          <Checkbox
            size="xs"
            label={t("features.board.analysis.explanation.deepReasons", "Tactical reasoning")}
            checked={display.showDeepReasons}
            onChange={() => toggle("showDeepReasons")}
          />
          <Checkbox
            size="xs"
            label={t("features.board.analysis.explanation.featureBadges", "Network concept badges")}
            checked={display.showFeatureBadges}
            onChange={() => toggle("showFeatureBadges")}
          />
          <Checkbox
            size="xs"
            label={t("features.board.analysis.explanation.debug")}
            description={t(
              "features.board.analysis.explanation.debugDesc",
              "Show unlabeled network features too",
            )}
            checked={display.showUnlabeledFeatures}
            onChange={() => toggle("showUnlabeledFeatures")}
          />
          <Checkbox
            size="xs"
            label={t("features.board.analysis.explanation.searchProgression")}
            checked={display.showSearchProgression}
            onChange={() => toggle("showSearchProgression")}
          />
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function GenerateExplanationPrompt({ fen, playedMoveUci }: { fen: string; playedMoveUci: string | null }) {
  const { t } = useTranslation();
  const [binaryPath, setBinaryPath] = useAtom(chessRepertoirePathAtom);
  const [, setLiveReport] = useAtom(liveExplanationFamily(fen));
  const genSettings = useAtomValue(explainGenerationSettingsAtom);
  const [generating, setGenerating] = useState(false);
  const [showPathInput, setShowPathInput] = useState(false);

  const generate = async () => {
    setGenerating(true);
    try {
      const raw = unwrap(
        await commands.explainPosition(binaryPath, fen, {
          multipv: genSettings.multipv,
          depth: genSettings.depth,
          classicalEval: genSettings.classicalEval,
          branchAlternatives: genSettings.branchAlternatives,
          interpretability: genSettings.interpretability,
          depthSeries: genSettings.depthSeries,
          playedMoveUci,
          branchDepth: genSettings.branchDepth,
          branchMultipv: genSettings.branchMultipv,
          featureTopK: genSettings.featureTopK,
        }),
      );
      setLiveReport(JSON.parse(raw));
    } finally {
      setGenerating(false);
    }
  };

  // Purely manual now, no auto-fire on navigation -- a big always-visible card (let
  // alone one that silently spawns a subprocess on every click-through of a game) was
  // the wrong weight for "no report on this move yet". Just a small button; the
  // per-move explanation is opt-in, one move at a time. The "generate for whole game"
  // checkbox in ReportModal is the batch path for when someone wants every move done
  // up front.
  if (!binaryPath) {
    if (!showPathInput) {
      return (
        <Group justify="center" p="xs">
          <Button
            size="xs"
            variant="subtle"
            leftSection={<IconBulb size={14} />}
            onClick={() => setShowPathInput(true)}
          >
            {t("features.board.analysis.explanation.generate")}
          </Button>
        </Group>
      );
    }
    return (
      <Stack p="xs" gap="xs">
        <TextInput
          size="xs"
          label={t("features.board.analysis.explanation.binaryPathLabel")}
          placeholder="/path/to/chess-repertoire/.venv/bin/chess-repertoire"
          defaultValue={binaryPath}
          onBlur={(e) => setBinaryPath(e.currentTarget.value)}
          autoFocus
        />
      </Stack>
    );
  }

  return (
    <Group justify="center" p="xs">
      <Button
        size="xs"
        variant="subtle"
        loading={generating}
        leftSection={<IconBulb size={14} />}
        onClick={generate}
      >
        {t("features.board.analysis.explanation.generate")}
      </Button>
    </Group>
  );
}

/** The lean, chess.com-style review, organized DecodeChess-style into tabs: a
 * persistent verdict bubble (icon + quality + summary prose) always on top -- the one
 * thing worth seeing at a glance without clicking anything -- then Threats / Plans /
 * Concepts tabs for everything else, each only as deep as the data actually goes. The
 * top candidate's own arrows/highlights stay drawn on the board by default (not just on
 * hover) so the position always shows *why*, matching chess-repertoire's own
 * board_viz-driven screenshots; hovering a threat/tactic/alternative temporarily
 * overrides them and restores this default on mouse-leave. */
function Explanation() {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const currentNode = useStore(store, useShallow((s) => s.currentNode()));
  const setPreviewShapes = useSetAtom(previewShapesAtom);
  const setPreviewFen = useSetAtom(previewFenAtom);
  const display = useAtomValue(explanationDisplaySettingsAtom);

  const [selected, setSelected] = useState<{ networkId: string; feature: InterpretabilityFeature } | null>(null);

  const liveReport = useAtomValue(liveExplanationFamily(currentNode.fen));
  const richReport: RichReport | null = currentNode.richReport ?? liveReport;
  const top = richReport && richReport.candidates.length > 0 ? richReport.candidates[0] : null;
  const defaultShapes = useMemo(
    () => (top ? [...boardShapesFor(top), ...candidateTacticsShapes(top.candidate_tactics)] : []),
    [top],
  );

  // Navigating for real (via the notation tree, not this panel's own hover previews)
  // must never leave a stale hover preview overriding the board -- but the top
  // candidate's own arrows/highlights ARE the default, persistent view for this
  // position (chess.com/DecodeChess both always show the recommended line's arrows),
  // not a transient hover state.
  useEffect(() => {
    setPreviewFen(null);
    setPreviewShapes(defaultShapes);
    return () => setPreviewShapes([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNode.fen, defaultShapes]);

  // "explain the best move and the one that was played" -- if there's exactly one
  // child (the line being explored), pass its move so it's guaranteed to be explained
  // even if it isn't one of the engine's own top-N choices.
  const playedMoveUci =
    currentNode.children.length === 1 && currentNode.children[0].move ? makeUci(currentNode.children[0].move) : null;

  if (!richReport || !top) {
    return <GenerateExplanationPrompt fen={currentNode.fen} playedMoveUci={playedMoveUci} />;
  }

  const others = richReport.candidates.slice(1);

  return (
    <Stack gap="0.4rem">
      {richReport.warnings && richReport.warnings.length > 0 && (
        <Alert color="yellow" title="chess-repertoire reported an issue" py="xs">
          {richReport.warnings.join(" ")}
        </Alert>
      )}
      <Group justify="flex-end">
        <DisplaySettingsPopover />
      </Group>
      {display.showBoardFacts && <BoardFacts richReport={richReport} defaultShapes={defaultShapes} />}
      <CandidatePanel candidate={top} />
      {/* One consistent layout for everything below the verdict -- stacked, individually
       * collapsible sections (the exact same `CollapsibleSection` the Accuracy chart and
       * move-type summary already use), never a tab bar. A tab hides its content until
       * clicked; a person scanning this panel for "is there anything about threats here"
       * shouldn't have to click four different tabs to find out. */}
      <CollapsibleSection title={t("features.board.analysis.explanation.tabSummary")}>
        <Stack gap="xs">
          {top.new_facts && <FactList facts={top.new_facts} defaultShapes={defaultShapes} />}
          {display.showDeepReasons && <DeepReasons candidate={top} />}
        </Stack>
      </CollapsibleSection>
      {display.showMajorThreats && (
        <CollapsibleSection title={t("features.board.analysis.explanation.tabThreats")}>
          <ThreatsTab richReport={richReport} top={top} fen={currentNode.fen} defaultShapes={defaultShapes} />
        </CollapsibleSection>
      )}
      <CollapsibleSection title={t("features.board.analysis.explanation.tabPlans")}>
        <PlansTab
          top={top}
          others={others}
          fen={currentNode.fen}
          depthSeries={richReport.depth_series}
          narrative={richReport.best_move_narrative}
        />
      </CollapsibleSection>
      <CollapsibleSection title={t("features.board.analysis.explanation.tabConcepts")} defaultOpened={false}>
        <ConceptsTab
          candidate={top}
          glossary={richReport.term_glossary}
          onSelectFeature={(networkId, feature) => setSelected({ networkId, feature })}
        />
      </CollapsibleSection>
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
