import type { Key } from "@lichess-org/chessground/types";
import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Modal,
  NumberInput,
  Progress,
  Stack,
  Switch,
  Text,
  TextInput,
  Timeline,
  Tooltip,
} from "@mantine/core";
import { IconArrowsSplit, IconSettings } from "@tabler/icons-react";
import { makeSquare, makeUci } from "chessops";
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { getDefaultStore, useAtom, useAtomValue, useSetAtom } from "jotai";
import { useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { commands } from "@/bindings";
import { TreeStateContext } from "@/components/TreeStateContext";
import {
  autoExplainAtom,
  chessRepertoirePathAtom,
  debugNumbersAtom,
  type ExplainSettings,
  explainSettingsAtom,
  liveExplanationFamily,
  previewFenAtom,
  previewShapesAtom,
} from "@/state/atoms";
import { ANNOTATION_INFO, NAG_INFO } from "@/utils/annotation";
import { positionFromFen } from "@/utils/chessops";
import type {
  BoardArrow,
  BoardHighlight,
  CandidateReportData,
  DepthSeriesEntry,
  InterpretabilityFeature,
  RichReport,
} from "@/utils/richReport";
import { pgnColorToBrush } from "@/utils/richReport";
import { treeIterator, type TreeNode } from "@/utils/treeReducer";
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
        <Text
          size="xs"
          c="dimmed"
          style={{ cursor: "pointer" }}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? t("features.board.analysis.explanation.showLess") : t("features.board.analysis.explanation.showMore", { count: all.length - 3 })}
        </Text>
      )}
    </Stack>
  );
}

/** Plays a sequence of SAN moves from `fen` and returns the resulting FEN plus the last
 * move's from/to squares, or `null` if any move fails to parse/apply -- used to preview
 * what a candidate or depth-series PV actually looks like on the board (via
 * `previewFenAtom`/`previewShapesAtom`) WITHOUT calling the tree store's makeMoves,
 * which would navigate the real game/re-trigger engine analysis just to look at a
 * candidate. Same play-it-out recipe AnalysisRow.tsx already uses for its own hover
 * preview. The returned squares are the *last* move's, not the first -- an arrow
 * overlaid on the resulting position should point at where the pieces actually just
 * moved to, not the first move of a possibly-longer PV whose piece has since moved on. */
function previewFromSan(
  fen: string,
  sanMoves: string[],
): { fen: string; lastMove: { orig: Key; dest: Key } | null } | null {
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
    ...arrows.map((a) => ({
      orig: a.from_square as Key,
      dest: a.to_square as Key,
      brush: pgnColorToBrush(a.color),
    })),
    ...highlights.map((h) => ({
      orig: h.square as Key,
      dest: h.square as Key,
      brush: pgnColorToBrush(h.color),
    })),
  ];
}

/** Position-level tactical motifs (pins, forks -- see board_viz.py's
 * pin_annotations/fork_annotations) -- unlike a candidate's own arrows/highlights,
 * these apply to the *current* position regardless of which candidate is expanded, so
 * they render once, above the accordion, not per-candidate. Hovering previews the
 * arrows/highlights on the board; nothing renders if there's nothing to show (no
 * fabricated "0 pins" badge). */
function TacticsBadges({ tactics }: { tactics: RichReport["tactics"] }) {
  const { t } = useTranslation();
  const setPreviewShapes = useSetAtom(previewShapesAtom);
  if (!tactics) return null;

  const items = [
    { key: "pins", label: t("features.board.analysis.explanation.pins"), data: tactics.pins },
    { key: "forks", label: t("features.board.analysis.explanation.forks"), data: tactics.forks },
    { key: "skewers", label: t("features.board.analysis.explanation.skewers"), data: tactics.skewers },
  ].filter((i) => i.data.highlights.length > 0);
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

function CandidatePanel({
  candidate,
  glossary,
  onSelectFeature,
}: {
  candidate: CandidateReportData;
  glossary?: Record<string, { display: string; text: string }>;
  onSelectFeature: (networkId: string, feature: InterpretabilityFeature) => void;
}) {
  const { t } = useTranslation();
  const debugNumbers = useAtomValue(debugNumbersAtom);

  return (
    <Stack gap="xs">
      {candidate.summary && (
        <Text size="sm" fw={500}>
          {candidate.summary}
        </Text>
      )}
      {candidate.structural_far.length > 0 && (
        <Text size="sm" c="dimmed">
          {candidate.structural_far.join("; ")}
        </Text>
      )}
      <TermBadges diffs={candidate.term_diffs_far} glossary={glossary} />

      {candidate.network_internals.map((net) => (
        <Stack key={net.network_id} gap={4}>
          <Text size="xs" c="dimmed" fw="bold">
            {net.network_id}
          </Text>
          <Group gap="xs">
            {net.top_features.length === 0 && (
              <Text size="xs" c="dimmed">
                {t("features.board.analysis.explanation.noFeaturesFired")}
              </Text>
            )}
            {net.top_features.map((feature) => (
              <Badge
                key={feature.feature_id}
                variant="outline"
                color={feature.concept_display ? "blue" : "gray"}
                style={{ cursor: "pointer" }}
                onClick={() => onSelectFeature(net.network_id, feature)}
              >
                #{feature.feature_id} {feature.concept_display ?? t("features.board.analysis.explanation.unlabeled")}
                {debugNumbers && (
                  <>
                    {" "}
                    a={feature.activation.toFixed(3)}
                    {feature.correlation !== null && ` r=${feature.correlation.toFixed(2)}`}
                  </>
                )}
              </Badge>
            ))}
          </Group>
        </Stack>
      ))}
    </Stack>
  );
}

/** Hovering a depth's PV previews what that line actually looks like on the board (the
 * resulting position, tinted, with the final move arrowed) -- purely visual, via
 * previewFenAtom/previewShapesAtom, never touching the real tree/currentNode.
 *
 * Rendered as a Mantine Timeline, not a plain table -- an honest "tree" reading of what
 * this data actually is: one line per depth, not a full minimax tree (that data was
 * never computed), but the connecting rail + a bullet that changes color/icon whenever
 * the engine's own top choice at that depth differs from the previous depth's is a
 * genuine tree-like read of "the search changing its mind," not a fabricated graph. */
function SearchProgression({ fen, series }: { fen: string; series: DepthSeriesEntry[] }) {
  const { t } = useTranslation();
  const setPreviewShapes = useSetAtom(previewShapesAtom);
  const setPreviewFen = useSetAtom(previewFenAtom);

  if (series.length === 0) return null;

  const clearPreview = () => {
    setPreviewShapes([]);
    setPreviewFen(null);
  };

  return (
    <Stack gap={4}>
      <Text size="xs" fw="bold" c="dimmed">
        {t("features.board.analysis.explanation.searchProgression")}
      </Text>
      <Timeline active={series.length} bulletSize={16} lineWidth={2}>
        {series.map((entry, i) => {
          const top = entry.candidates[0];
          const prevTop = i > 0 ? series[i - 1].candidates[0] : undefined;
          const changedMind = !!top && !!prevTop && top.move_san !== prevTop.move_san;
          return (
            <Timeline.Item
              key={entry.depth}
              title={t("features.board.analysis.explanation.depth") + ` ${entry.depth}`}
              color={changedMind ? "orange" : "blue"}
              bullet={changedMind ? <IconArrowsSplit size={10} /> : undefined}
            >
              <Group gap="xs" wrap="wrap">
                {entry.candidates.map((c) => (
                  <Text
                    key={c.rank}
                    span
                    size="sm"
                    style={{ cursor: c.pv_san.length > 0 ? "pointer" : undefined }}
                    onMouseEnter={() => {
                      const preview = previewFromSan(fen, c.pv_san);
                      if (!preview) return;
                      setPreviewFen(preview.fen);
                      setPreviewShapes(
                        preview.lastMove
                          ? [{ orig: preview.lastMove.orig, dest: preview.lastMove.dest, brush: "blue" }]
                          : [],
                      );
                    }}
                    onMouseLeave={clearPreview}
                  >
                    {c.pv_san.join(" ")} ({formatCandidateScore(c)})
                  </Text>
                ))}
              </Group>
            </Timeline.Item>
          );
        })}
      </Timeline>
    </Stack>
  );
}

/** "options for customization ... depth time whatever" -- the knobs `explain_cmd.py`
 * already exposes as CLI flags but this panel never surfaced: multipv, search depth,
 * opponent-branch depth/multipv, and how many network-internals features to report.
 * Persisted (`explainSettingsAtom`) so a preference set once (e.g. "always go deeper")
 * applies to every future generate/batch call, not just the next one. A Modal, not a
 * Popover -- matching ReportModal's own settings dialog for visual consistency, rather
 * than this panel being the only one in the analysis tabs using a hover-dropdown for
 * the same kind of "configure before running" settings. */
function ExplainOptionsModal() {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const [settings, setSettings] = useAtom(explainSettingsAtom);

  const field = (key: keyof ExplainSettings, label: string, min: number, max: number) => (
    <NumberInput
      label={label}
      min={min}
      max={max}
      value={settings[key] ?? undefined}
      placeholder={t("features.board.analysis.explanation.optionsDefault")}
      onChange={(v) => setSettings((prev) => ({ ...prev, [key]: typeof v === "number" ? v : null }))}
    />
  );

  return (
    <>
      <ActionIcon
        size="sm"
        variant="subtle"
        aria-label={t("features.board.analysis.explanation.options")}
        onClick={() => setOpened(true)}
      >
        <IconSettings size="1rem" />
      </ActionIcon>
      <Modal opened={opened} onClose={() => setOpened(false)} title={t("features.board.analysis.explanation.options")}>
        <Stack gap="sm">
          {field("multipv", t("features.board.analysis.explanation.multiPv"), 1, 10)}
          {field("depth", t("features.board.analysis.explanation.depth"), 1, 40)}
          {field("branchDepth", t("features.board.analysis.explanation.branchDepth"), 1, 40)}
          {field("branchMultipv", t("features.board.analysis.explanation.branchMultiPv"), 1, 10)}
          {field("featureTopK", t("features.board.analysis.explanation.featureTopK"), 1, 64)}
        </Stack>
      </Modal>
    </>
  );
}

function GenerateExplanationPrompt({
  fen,
  playedMoveUci,
  autoTriggered,
}: {
  fen: string;
  playedMoveUci: string | null;
  autoTriggered: boolean;
}) {
  const { t } = useTranslation();
  const [binaryPath, setBinaryPath] = useAtom(chessRepertoirePathAtom);
  const [, setLiveReport] = useAtom(liveExplanationFamily(fen));
  const settings = useAtomValue(explainSettingsAtom);
  const [generating, setGenerating] = useState(false);

  const generate = async () => {
    setGenerating(true);
    try {
      const raw = unwrap(
        await commands.explainPosition(binaryPath, fen, {
          multipv: settings.multipv,
          depth: settings.depth,
          classicalEval: null,
          branchAlternatives: null,
          interpretability: null,
          depthSeries: null,
          playedMoveUci,
          branchDepth: settings.branchDepth,
          branchMultipv: settings.branchMultipv,
          featureTopK: settings.featureTopK,
        }),
      );
      setLiveReport(JSON.parse(raw));
    } finally {
      setGenerating(false);
    }
  };

  // Auto-generate on navigation (see the effect in Explanation() that decides *when*
  // this prompt should trigger it) -- this component only exposes the action; the
  // decision of whether to call it automatically lives with the caller, which knows
  // about the auto-explain toggle.
  const autoFired = useRef(false);
  useEffect(() => {
    if (autoTriggered && binaryPath && !autoFired.current) {
      autoFired.current = true;
      generate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTriggered, binaryPath, fen]);

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
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {generating ? t("features.board.analysis.explanation.generating") : t("features.board.analysis.explanation.noRichReport")}
        </Text>
        <ExplainOptionsModal />
      </Group>
      <Button loading={generating} onClick={generate}>
        {t("features.board.analysis.explanation.generate")}
      </Button>
      <Text size="xs" c="dimmed">
        {t("features.board.analysis.explanation.generateFirstUseWarning")}
      </Text>
    </Stack>
  );
}

function BatchGenerateButton({ root }: { root: TreeNode }) {
  const { t } = useTranslation();
  const binaryPath = useAtomValue(chessRepertoirePathAtom);
  const settings = useAtomValue(explainSettingsAtom);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const cancelRef = useRef(false);

  const run = async () => {
    if (!binaryPath) return;
    const jotaiStore = getDefaultStore();

    // Every position not already carrying data (from an import) -- richReport is
    // checked, not the live cache, since a position could already have live data from
    // an earlier auto-generate/manual click and doesn't need redoing.
    const positions: { fen: string; playedMoveUci: string | null }[] = [];
    for (const { node } of treeIterator(root)) {
      if (node.richReport || jotaiStore.get(liveExplanationFamily(node.fen))) continue;
      const onlyChild = node.children.length === 1 ? node.children[0] : null;
      positions.push({ fen: node.fen, playedMoveUci: onlyChild?.move ? makeUci(onlyChild.move) : null });
    }

    cancelRef.current = false;
    setRunning(true);
    setProgress({ done: 0, total: positions.length });
    try {
      for (const { fen, playedMoveUci } of positions) {
        if (cancelRef.current) break;
        try {
          const raw = unwrap(
            await commands.explainPosition(binaryPath, fen, {
              multipv: settings.multipv,
              depth: settings.depth,
              classicalEval: null,
              branchAlternatives: null,
              interpretability: null,
              depthSeries: false,
              playedMoveUci,
              branchDepth: settings.branchDepth,
              branchMultipv: settings.branchMultipv,
              featureTopK: settings.featureTopK,
            }),
          );
          jotaiStore.set(liveExplanationFamily(fen), JSON.parse(raw));
        } catch {
          // one position failing shouldn't abort the whole batch -- move on.
        }
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
    } finally {
      setRunning(false);
    }
  };

  if (!binaryPath) return null;

  return (
    <Stack gap={4}>
      {running ? (
        <>
          <Progress value={(progress.done / Math.max(progress.total, 1)) * 100} />
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {progress.done} / {progress.total}
            </Text>
            <Button size="xs" variant="subtle" color="red" onClick={() => (cancelRef.current = true)}>
              {t("features.board.analysis.explanation.cancel")}
            </Button>
          </Group>
        </>
      ) : (
        <Button variant="light" onClick={run}>
          {t("features.board.analysis.explanation.generateForWholeGame")}
        </Button>
      )}
    </Stack>
  );
}

function Explanation() {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const currentNode = useStore(store, useShallow((s) => s.currentNode()));
  const root = useStore(store, (s) => s.root);
  const [autoExplain, setAutoExplain] = useAtom(autoExplainAtom);
  const [debugNumbers, setDebugNumbers] = useAtom(debugNumbersAtom);
  const setPreviewShapes = useSetAtom(previewShapesAtom);
  const setPreviewFen = useSetAtom(previewFenAtom);

  const [selected, setSelected] = useState<{ networkId: string; feature: InterpretabilityFeature } | null>(
    null,
  );

  // Navigating for real (via the notation tree, not this panel's own hover/expand
  // previews) must never leave a stale preview overriding the board -- previewFenAtom
  // is cleared whenever the actual current position changes, regardless of how it got
  // there.
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
    currentNode.children.length === 1 && currentNode.children[0].move
      ? makeUci(currentNode.children[0].move)
      : null;

  if (!richReport || richReport.candidates.length === 0) {
    return (
      <GenerateExplanationPrompt
        fen={currentNode.fen}
        playedMoveUci={playedMoveUci}
        autoTriggered={autoExplain}
      />
    );
  }

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Group gap="xs">
          <ExplainOptionsModal />
          <Switch
            size="xs"
            label={t("features.board.analysis.explanation.debug")}
            checked={debugNumbers}
            onChange={(e) => setDebugNumbers(e.currentTarget.checked)}
          />
        </Group>
        <Switch
          size="xs"
          label={t("features.board.analysis.explanation.autoGenerate")}
          checked={autoExplain}
          onChange={(e) => setAutoExplain(e.currentTarget.checked)}
        />
      </Group>
      {richReport.warnings && richReport.warnings.length > 0 && (
        <Alert color="yellow" title={t("features.board.analysis.explanation.warningsTitle")} py="xs">
          {richReport.warnings.join(" ")}
        </Alert>
      )}
      <TacticsBadges tactics={richReport.tactics} />
      <Divider />
      <Accordion
        variant="separated"
        defaultValue={richReport.candidates[0]?.move_uci}
        onChange={(value) => {
          const candidate = richReport.candidates.find((c) => c.move_uci === value);
          setPreviewShapes(candidate ? boardShapesFor(candidate) : []);
          // Expanding a candidate shows what its resulting position looks like -- via
          // previewFenAtom's tinted board override, NOT the real tree/makeMoves. Actually
          // navigating there turned out to be disruptive: it changed the real current
          // position, which re-triggers engine analysis on every click just to compare
          // candidates, and immediately blew away the very candidates/arrows being looked
          // at (the panel re-renders for the new position, which usually has no cached
          // explanation of its own).
          const preview = candidate ? previewFromSan(currentNode.fen, [candidate.move_san]) : null;
          setPreviewFen(preview?.fen ?? null);
        }}
      >
        {richReport.candidates.map((candidate) => (
          <Accordion.Item key={candidate.move_uci} value={candidate.move_uci}>
            <Accordion.Control>
              <Group gap="xs" wrap="nowrap">
                <Text fw="bold">{candidate.move_san}</Text>
                <Text c="dimmed">{formatCandidateScore(candidate)}</Text>
                <NagBadge nag={candidate.nag} />
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <CandidatePanel
                candidate={candidate}
                glossary={richReport.term_glossary}
                onSelectFeature={(networkId, feature) => setSelected({ networkId, feature })}
              />
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>
      {richReport.depth_series && (
        <>
          <Divider />
          <SearchProgression fen={currentNode.fen} series={richReport.depth_series} />
        </>
      )}
      <Divider />
      <BatchGenerateButton root={root} />
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
