import {
  Button,
  Checkbox,
  Collapse,
  Divider,
  Grid,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { makeUci } from "chessops";
import { useAtom, useAtomValue } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { memo, useContext, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { commands, type GoMode } from "@/bindings";
import { TreeStateContext } from "@/components/TreeStateContext";
import { chessRepertoirePathAtom, enginesAtom, explainGenerationSettingsAtom, referenceDbAtom } from "@/state/atoms";
import type { LocalEngine } from "@/utils/engines";
import { treeIteratorMainLine } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";

const reportSettingsAtom = atomWithStorage("report-settings", {
  novelty: true,
  reversed: true,
  goMode: { t: "Time", c: 500 } as Exclude<GoMode, { t: "Infinite" }>,
  engine: "",
  /** "Generate for whole game" (merges chess-repertoire's per-move deep report into
   * this same report run, one `explainPosition` call per main-line move, immediately
   * after the eval analysis finishes) -- see `runExplanationBatch` below. Off by
   * default: it's meaningfully slower than the eval-only report (a real subprocess
   * call per move, see `generateFirstUseWarning`), so it stays opt-in per report run. */
  generateExplanations: false,
});

function ReportModal({
  tab,
  initialFen,
  moves,
  is960,
  reportingMode,
  toggleReportingMode,
  setInProgress,
  inProgress,
}: {
  tab: string;
  initialFen: string;
  moves: string[];
  is960: boolean;
  reportingMode: boolean;
  toggleReportingMode: () => void;
  setInProgress: (progress: boolean) => void;
  inProgress: boolean;
}) {
  const { t } = useTranslation();

  const referenceDb = useAtomValue(referenceDbAtom);
  const engines = useAtomValue(enginesAtom);
  const localEngines = engines.filter((e): e is LocalEngine => e.type === "local");
  const store = useContext(TreeStateContext)!;
  const addAnalysis = useStore(store, (s) => s.addAnalysis);
  const setRichReportAtPath = useStore(store, (s) => s.setRichReportAtPath);
  const setCompleted = useStore(store, (s) => s.setReportCompleted);
  const setProgress = useStore(store, (s) => s.setReportProgress);
  // Store-backed (not local component state): this modal closes itself the moment
  // Analyze is clicked (`toggleReportingMode()` below), but the batch keeps running --
  // ReportPanel's own progress line (outside this modal) reads the same store field so
  // the batch's progress stays visible after the modal is gone.
  const setExplainProgress = useStore(store, (s) => s.setExplainProgress);

  const [reportSettings, setReportSettings] = useAtom(reportSettingsAtom);
  const [binaryPath, setBinaryPath] = useAtom(chessRepertoirePathAtom);
  const [genSettings, setGenSettings] = useAtom(explainGenerationSettingsAtom);
  const analysisEngineRef = useRef<{ engine: string; tab: string } | null>(null);
  const explainCancelRef = useRef(false);

  const form = useForm({
    initialValues: reportSettings,
    validate: {
      engine: (value) => {
        if (!value) return t("features.board.analysis.engineRequired");
      },
      novelty: (value) => {
        if (value && !referenceDb) return t("features.board.analysis.refDBRequired");
      },
    },
  });

  useEffect(() => {
    const engine =
      localEngines.length === 0
        ? ""
        : !reportSettings.engine || !localEngines.some((l) => l.path === reportSettings.engine)
          ? localEngines[0].path
          : reportSettings.engine;

    form.setValues({ ...reportSettings, engine });
  }, [localEngines.length, reportSettings]);

  const handleStop = async () => {
    if (analysisEngineRef.current) {
      try {
        await commands.stopEngine(analysisEngineRef.current.engine, analysisEngineRef.current.tab);
      } catch (error) {
        console.error("Error stopping engine:", error);
      }
      // Doesn't kill an in-flight chess-repertoire subprocess call (no cancel plumbing
      // for that yet) -- just stops the batch from starting its *next* position, so
      // Stop takes effect within one call's worth of latency, not instantly.
      explainCancelRef.current = true;
      analysisEngineRef.current = null;
      setInProgress(false);
      setExplainProgress(null);
    }
  };

  /** "Generate for whole game": one `explainPosition` call per main-line move, each
   * scored from the position *before* that move with the move itself pinned as
   * `playedMoveUci` -- the same shape a `--rich` PGN import's `[%creport]` tags carry,
   * so `setRichReportAtPath` populates exactly the field `playedMoveCandidate`/the
   * verdict card and the Explanation panel already know how to read. Continues past a
   * single position's failure (logged, not fatal) rather than aborting the whole game
   * over one bad call. */
  async function runExplanationBatch() {
    if (!binaryPath) return;
    explainCancelRef.current = false;
    const mainLine = [...treeIteratorMainLine(store.getState().root)].filter(
      (entry) => entry.node.move !== undefined,
    );
    if (mainLine.length === 0) return;
    const total = mainLine.length;
    let done = 0;
    setExplainProgress({ done, total });

    let prevFen = store.getState().root.fen;
    for (const entry of mainLine) {
      if (explainCancelRef.current) break;
      try {
        const raw = unwrap(
          await commands.explainPosition(binaryPath, prevFen, {
            multipv: genSettings.multipv,
            depth: genSettings.depth,
            classicalEval: genSettings.classicalEval,
            branchAlternatives: genSettings.branchAlternatives,
            interpretability: genSettings.interpretability,
            depthSeries: genSettings.depthSeries,
            playedMoveUci: makeUci(entry.node.move!),
            branchDepth: genSettings.branchDepth,
            branchMultipv: genSettings.branchMultipv,
            featureTopK: genSettings.featureTopK,
          }),
        );
        setRichReportAtPath(entry.position, JSON.parse(raw));
      } catch (error) {
        console.error(`Failed to explain move ${entry.node.san}:`, error);
      }
      prevFen = entry.node.fen;
      done += 1;
      setExplainProgress({ done, total });
    }
  }

  function analyze() {
    setReportSettings(form.values);
    // `isCompleted`/`progress` from a *previous* run were never reset here -- clicking
    // Analyze again left `isCompleted: true` in the store, so ProgressButton's label
    // logic (`if (completed) label = labels.completed`) kept showing "Report generated"
    // statically through the whole new run instead of a moving progress bar, even
    // though `inProgress` correctly disabled the button underneath it.
    setCompleted(false);
    setProgress(0);
    setInProgress(true);
    toggleReportingMode();
    const engine = localEngines.find((e) => e.path === form.values.engine);
    const engineSettings = (engine?.settings ?? []).map((s) => ({
      ...s,
      value: s.value?.toString() ?? "",
    }));

    if (is960 && !engineSettings.find((o) => o.name === "UCI_Chess960")) {
      engineSettings.push({ name: "UCI_Chess960", value: "true" });
    }

    const analysisId = `report_${tab}`;
    analysisEngineRef.current = { engine: form.values.engine, tab: analysisId };

    commands
      .analyzeGame(
        analysisId,
        form.values.engine,
        form.values.goMode,
        {
          annotateNovelties: form.values.novelty,
          fen: initialFen,
          referenceDb,
          reversed: form.values.reversed,
          moves,
        },
        engineSettings,
      )
      .then(async (analysis) => {
        if (analysisEngineRef.current) {
          const analysisData = unwrap(analysis);
          addAnalysis(analysisData);
        }
        // The eval engine's own `reportProgress` Tauri event (ReportProgressSubscriber)
        // already flipped `inProgress` false the moment analyzeGame's search finished --
        // re-assert it true here so the "generating" state (and the Analyze button's
        // disabled/Stop-instead-of-Analyze state) stays correct through this second,
        // TS-driven phase too.
        if (form.values.generateExplanations && analysisEngineRef.current) {
          setInProgress(true);
          await runExplanationBatch();
        }
      })
      .catch((error) => {
        console.error("Analysis error:", error);
      })
      .finally(() => {
        analysisEngineRef.current = null;
        setInProgress(false);
        setExplainProgress(null);
      });
  }

  return (
    <Modal
      opened={reportingMode}
      onClose={() => toggleReportingMode()}
      title={t("features.board.analysis.generateReport")}
    >
      <form onSubmit={form.onSubmit(() => analyze())}>
        <Stack>
          <Select
            allowDeselect={false}
            withAsterisk
            label={t("common.engine")}
            placeholder="Pick one"
            data={
              localEngines.map((engine) => {
                return {
                  value: engine.path,
                  label: engine.name,
                };
              }) ?? []
            }
            {...form.getInputProps("engine")}
          />
          <Group wrap="nowrap">
            <Select
              allowDeselect={false}
              comboboxProps={{
                position: "bottom",
                middlewares: { flip: false, shift: false },
              }}
              data={[
                { label: t("chess.goMode.depth"), value: "Depth" },
                { label: t("features.board.analysis.time"), value: "Time" },
                { label: t("chess.goMode.nodes"), value: "Nodes" },
              ]}
              value={form.values.goMode.t}
              onChange={(v) => {
                const newGo = form.values.goMode;
                newGo.t = v as "Depth" | "Time" | "Nodes";
                form.setFieldValue("goMode", newGo);
              }}
            />
            <NumberInput
              min={1}
              value={form.values.goMode.c as number}
              onChange={(v) =>
                form.setFieldValue("goMode", {
                  ...(form.values.goMode as any),
                  c: (v || 1) as number,
                })
              }
            />
          </Group>

          <Checkbox
            label={t("features.board.analysis.reversed")}
            description={t("features.board.analysis.reversedDesc")}
            {...form.getInputProps("reversed", { type: "checkbox" })}
          />

          <Checkbox
            label={t("features.board.analysis.annotateNovelties")}
            description={t("features.board.analysis.annotateNoveltiesDesc")}
            {...form.getInputProps("novelty", { type: "checkbox" })}
          />

          <Divider />

          <Checkbox
            label={t("features.board.analysis.explanation.generateForWholeGame")}
            {...form.getInputProps("generateExplanations", { type: "checkbox" })}
          />
          <Collapse expanded={form.values.generateExplanations}>
            <Stack gap="xs">
              <Text size="xs" c="dimmed">
                {t("features.board.analysis.explanation.generateFirstUseWarning")}
              </Text>
              {!binaryPath && (
                <TextInput
                  size="xs"
                  label={t("features.board.analysis.explanation.binaryPathLabel")}
                  placeholder="/path/to/chess-repertoire/.venv/bin/chess-repertoire"
                  defaultValue={binaryPath}
                  onBlur={(e) => setBinaryPath(e.currentTarget.value)}
                />
              )}
              <Text size="xs" fw={700} tt="uppercase" c="dimmed">
                {t("features.board.analysis.explanation.options")}
              </Text>
              <Grid gap="xs">
                <Grid.Col span={6}>
                  <NumberInput
                    size="xs"
                    min={1}
                    label={t("features.board.analysis.explanation.multiPv")}
                    placeholder={t("features.board.analysis.explanation.optionsDefault")}
                    value={genSettings.multipv ?? ""}
                    onChange={(v) => setGenSettings((s) => ({ ...s, multipv: v === "" ? null : Number(v) }))}
                  />
                </Grid.Col>
                <Grid.Col span={6}>
                  <NumberInput
                    size="xs"
                    min={1}
                    label={t("features.board.analysis.explanation.depth")}
                    placeholder={t("features.board.analysis.explanation.optionsDefault")}
                    value={genSettings.depth ?? ""}
                    onChange={(v) => setGenSettings((s) => ({ ...s, depth: v === "" ? null : Number(v) }))}
                  />
                </Grid.Col>
                <Grid.Col span={6}>
                  <NumberInput
                    size="xs"
                    min={1}
                    label={t("features.board.analysis.explanation.branchDepth")}
                    placeholder={t("features.board.analysis.explanation.optionsDefault")}
                    value={genSettings.branchDepth ?? ""}
                    onChange={(v) => setGenSettings((s) => ({ ...s, branchDepth: v === "" ? null : Number(v) }))}
                  />
                </Grid.Col>
                <Grid.Col span={6}>
                  <NumberInput
                    size="xs"
                    min={1}
                    label={t("features.board.analysis.explanation.branchMultiPv")}
                    placeholder={t("features.board.analysis.explanation.optionsDefault")}
                    value={genSettings.branchMultipv ?? ""}
                    onChange={(v) => setGenSettings((s) => ({ ...s, branchMultipv: v === "" ? null : Number(v) }))}
                  />
                </Grid.Col>
                <Grid.Col span={6}>
                  <NumberInput
                    size="xs"
                    min={1}
                    label={t("features.board.analysis.explanation.featureTopK")}
                    placeholder={t("features.board.analysis.explanation.optionsDefault")}
                    value={genSettings.featureTopK ?? ""}
                    onChange={(v) => setGenSettings((s) => ({ ...s, featureTopK: v === "" ? null : Number(v) }))}
                  />
                </Grid.Col>
              </Grid>
              <Group gap="lg">
                <Checkbox
                  size="xs"
                  label={t("features.board.analysis.explanation.classicalEval", "Classical eval terms")}
                  checked={genSettings.classicalEval}
                  onChange={() => setGenSettings((s) => ({ ...s, classicalEval: !s.classicalEval }))}
                />
                <Checkbox
                  size="xs"
                  label={t("features.board.analysis.explanation.branchAlternatives", "Opponent alternatives")}
                  checked={genSettings.branchAlternatives}
                  onChange={() => setGenSettings((s) => ({ ...s, branchAlternatives: !s.branchAlternatives }))}
                />
              </Group>
              <Group gap="lg">
                <Checkbox
                  size="xs"
                  label={t("features.board.analysis.explanation.interpretability", "Network internals")}
                  checked={genSettings.interpretability}
                  onChange={() => setGenSettings((s) => ({ ...s, interpretability: !s.interpretability }))}
                />
                <Checkbox
                  size="xs"
                  label={t("features.board.analysis.explanation.searchProgression")}
                  checked={genSettings.depthSeries}
                  onChange={() => setGenSettings((s) => ({ ...s, depthSeries: !s.depthSeries }))}
                />
              </Group>
            </Stack>
          </Collapse>

          <Group justify="right">
            {inProgress ? (
              <Button variant="filled" color="red" onClick={handleStop}>
                {t("keybindings.stopEngine")}
              </Button>
            ) : (
              <Button type="submit">{t("features.board.analysis.analyze")}</Button>
            )}
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export default memo(ReportModal);
