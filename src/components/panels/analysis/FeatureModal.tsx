import type { Key } from "@lichess-org/chessground/types";
import { Badge, Drawer, Group, ScrollArea, Stack, Table, Text } from "@mantine/core";
import { useAtomValue, useSetAtom } from "jotai";
import { useContext, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/TreeStateContext";
import { debugNumbersAtom, previewShapesAtom } from "@/state/atoms";
import type { InterpretabilityFeature } from "@/utils/richReport";
import { findFeatureExamples } from "@/utils/treeReducer";

/** A real heatmap, not a binary green/red split -- 4 magnitude tiers using brushes this
 * app already registers for its own engine-line arrows (`arrowColors` in BestMoves.tsx:
 * strong/pale green and red), so no new brush registration is needed. The threshold is
 * relative to this feature's own strongest square (not an absolute cutoff), since raw
 * attribution scores vary a lot feature to feature -- "strong" should mean "strong for
 * this feature", not an arbitrary fixed number. */
function heatmapBrush(score: number, maxAbsScore: number): string {
  if (maxAbsScore === 0) return score >= 0 ? "paleGreen" : "paleRed";
  const ratio = Math.abs(score) / maxAbsScore;
  if (score >= 0) return ratio >= 0.5 ? "green" : "paleGreen";
  return ratio >= 0.5 ? "red" : "paleRed";
}

function FeatureModal({
  networkId,
  feature,
  fen,
  onClose,
}: {
  networkId: string;
  feature: InterpretabilityFeature | null;
  fen: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const setPreviewShapes = useSetAtom(previewShapesAtom);
  const debugNumbers = useAtomValue(debugNumbersAtom);

  useEffect(() => {
    if (!feature) {
      setPreviewShapes([]);
      return;
    }
    const maxAbsScore = Math.max(0, ...feature.attribution_squares.map(([, score]) => Math.abs(score)));
    setPreviewShapes(
      feature.attribution_squares.map(([square, score]) => ({
        orig: square as Key,
        dest: square as Key,
        brush: heatmapBrush(score, maxAbsScore),
      })),
    );
    return () => setPreviewShapes([]);
  }, [feature, setPreviewShapes]);

  const examples = feature ? findFeatureExamples(root, networkId, feature.feature_id, fen) : [];

  return (
    // A centered Modal dims/covers the whole viewport, including the board -- exactly
    // where the heatmap this panel exists to explain gets drawn, so it hid its own
    // subject. A right-side Drawer with no dimming overlay stays out of the board's way
    // while the color-coded squares are visible underneath/beside it.
    <Drawer
      opened={feature !== null}
      onClose={onClose}
      title={feature ? `${networkId} #${feature.feature_id}` : ""}
      position="right"
      size="sm"
      withOverlay={false}
    >
      {feature && (
        <Stack gap="sm">
          <Group gap="xs">
            {feature.concept_display ? (
              <Badge color={feature.correlation !== null ? "blue" : "grape"}>
                {feature.concept_display}
              </Badge>
            ) : (
              <Badge color="gray">{t("features.board.analysis.explanation.unlabeled")}</Badge>
            )}
            {debugNumbers && feature.correlation !== null && (
              <Text size="sm" c="dimmed">
                r={feature.correlation >= 0 ? "+" : ""}
                {feature.correlation.toFixed(2)} {t("features.board.analysis.explanation.overPositions", { count: feature.correlation_n ?? 0 })}
              </Text>
            )}
          </Group>

          <Text size="sm">
            {t("features.board.analysis.explanation.attributionExplainer")}
          </Text>
          {feature.attribution_squares.length > 0 ? (
            <ScrollArea.Autosize mah={140}>
              <Group gap="xs">
                {feature.attribution_squares.map(([square, score]) => (
                  <Badge key={square} variant="light" color={score >= 0 ? "green" : "red"}>
                    {debugNumbers ? `${square} (${score >= 0 ? "+" : ""}${score.toFixed(2)})` : square}
                  </Badge>
                ))}
              </Group>
            </ScrollArea.Autosize>
          ) : (
            <Text size="sm" c="dimmed">
              {t("features.board.analysis.explanation.noAttributionSquares")}
            </Text>
          )}

          <Text size="sm" fw="bold" mt="xs">
            {t("features.board.analysis.explanation.examples")}
          </Text>
          {examples.length > 0 ? (
            <ScrollArea.Autosize mah={200}>
              <Table>
                <Table.Tbody>
                  {examples.map((example) => (
                    <Table.Tr key={example.fen}>
                      <Table.Td>{example.san ?? example.fen}</Table.Td>
                      {debugNumbers && <Table.Td>{example.activation.toFixed(2)}</Table.Td>}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea.Autosize>
          ) : (
            <Text size="sm" c="dimmed">
              {t("features.board.analysis.explanation.noExamplesYet")}
            </Text>
          )}
        </Stack>
      )}
    </Drawer>
  );
}

export default FeatureModal;
