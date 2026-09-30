import { AreaChart } from "@mantine/charts";
import {
  Alert,
  Box,
  LoadingOverlay,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  useMantineTheme,
} from "@mantine/core";
import equal from "fast-deep-equal";
import { useAtom } from "jotai";
import { useCallback, useContext, useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart as RechartsAreaChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CategoricalChartFunc } from "recharts/types/chart/types";
import { useStore } from "zustand";
import { reportTypeAtom } from "@/state/atoms";
import { ANNOTATION_INFO } from "@/utils/annotation";
import { positionFromFen } from "@/utils/chessops";
import { skipWhile, takeWhile } from "@/utils/misc";
import { type ListNode, type TreeNode, treeIteratorMainLine } from "@/utils/treeReducer";
import * as classes from "./EvalChart.css";
import { TreeStateContext } from "./TreeStateContext";

interface EvalChartProps {
  isAnalysing: boolean;
  startAnalysis: () => void;
}

type DataPoint = {
  name: string;
  cpText: string;
  wdlText: string;
  yValue: number | "none";
  movePath: number[];
  color: string;
  White: number;
  Draw: number;
  Black: number;
};

function EvalChart(props: EvalChartProps) {
  const { t } = useTranslation();

  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const goToMove = useStore(store, (s) => s.goToMove);
  const theme = useMantineTheme();

  function getYValue(node: TreeNode): number | undefined {
    if (node.score) {
      let cp: number = node.score.value.value;
      if (node.score.value.type === "mate") {
        cp = node.score.value.value > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      }
      return 2 / (1 + Math.exp(-0.004 * cp)) - 1;
    }
    if (node.children.length === 0) {
      const [pos] = positionFromFen(node.fen);
      if (pos) {
        if (pos.isCheckmate()) {
          return pos?.turn === "white" ? -1 : 1;
        }
        if (pos.isStalemate()) {
          return 0;
        }
      }
    }
  }

  function getEvalText(node: TreeNode, type: "cp" | "wdl"): string {
    if (node.score) {
      if (type === "cp") {
        return `${t("features.board.analysis.advantage")}: ${t("units.score", { score: node.score.value })}`;
      }
      if (type === "wdl" && node.score.wdl) {
        return `
         White: ${node.score.wdl[0] / 10}%
         Draw: ${node.score.wdl[1] / 10}%
         Black: ${node.score.wdl[2] / 10}%`;
      }
    }
    if (node.children.length === 0) {
      const [pos] = positionFromFen(node.fen);
      if (pos) {
        if (pos.isCheckmate()) return t("chess.checkmate");
        if (pos.isStalemate()) return t("chess.stalemate");
      }
    }
    return t("features.board.analysis.notAnalysed");
  }

  function getNodes(): ListNode[] {
    const allNodes = treeIteratorMainLine(root);
    const withoutRoot = skipWhile(allNodes, (node: ListNode) => node.position.length === 0);
    const withMoves = takeWhile(withoutRoot, (node: ListNode) => node.node.move !== undefined);
    return [...withMoves];
  }

  function* getData(): Iterable<DataPoint> {
    const nodes = getNodes();
    for (let i = 0; i < nodes.length; i++) {
      const currentNode = nodes[i];
      const yValue = getYValue(currentNode.node);
      const [pos] = positionFromFen(currentNode.node.fen);
      const wdl = currentNode.node.score?.wdl;

      yield {
        name: `${Math.ceil(currentNode.node.halfMoves / 2)}.${
          pos?.turn === "black" ? "" : ".."
        } ${currentNode.node.san}${currentNode.node.annotations}`,
        cpText: getEvalText(currentNode.node, "cp"),
        wdlText: getEvalText(currentNode.node, "wdl"),
        yValue: yValue ?? "none",
        movePath: currentNode.position,
        color: ANNOTATION_INFO[currentNode.node.annotations[0]]?.color || "gray",
        White: wdl ? wdl[0] : 0,
        Draw: wdl ? wdl[1] : 0,
        Black: wdl ? wdl[2] : 0,
      };
    }
  }

  function gradientOffset(data: DataPoint[]) {
    const dataMax = Math.max(...data.map((i) => (i.yValue !== "none" ? i.yValue : 0)));
    const dataMin = Math.min(...data.map((i) => (i.yValue !== "none" ? i.yValue : 0)));

    if (dataMax <= 0) return 0;
    if (dataMin >= 0) return 1;

    return dataMax / (dataMax - dataMin);
  }

  const data = [...getData()];

  // chess.com's Game Review colors every move's own dot on the graph by that move's
  // quality (gray for an ordinary/"Best" move, green/orange/red for the notable ones) --
  // Mantine's <AreaChart dotProps> only accepts one static object applied to every
  // point, so getting a per-point color means dropping to raw recharts here and
  // supplying `dot` as a render function instead (splitId/gradient below replicate
  // Mantine's own "split" fill so the line/fill still look identical to before).
  const renderDot = useCallback(
    (props: any) => {
      const { cx, cy, index, payload } = props as {
        cx?: number;
        cy?: number;
        index: number;
        payload: DataPoint;
      };
      if (cx == null || cy == null || payload.yValue === "none") {
        return <g key={`dot-${index}`} />;
      }
      const fill =
        payload.color === "gray"
          ? theme.colors.gray[5]
          : theme.colors[payload.color][6];
      return <circle key={`dot-${index}`} cx={cx} cy={cy} r={2.5} fill={fill} stroke="none" />;
    },
    [theme],
  );

  const splitId = useId().replace(/:/g, "");

  const onChartClick: CategoricalChartFunc = useCallback(
    (event: any) => {
      if (event.activeLabel) {
        const match = data.find((d) => d.name === event.activeLabel);
        if (match) goToMove(match.movePath);
      }
    },
    [data, goToMove],
  );

  const currentPositionName = data.find((point) => equal(point.movePath, position))?.name;
  const colouroffset = gradientOffset(data);

  const [chartType, setChartType] = useAtom(reportTypeAtom);

  const isWDLDisabled = useMemo(() => {
    return !data.some((point) => point.White !== 0 || point.Black !== 0 || point.Draw !== 0);
  }, [data]);

  return (
    <Stack>
      <Box
        pos="relative"
        onFocusCapture={(e) => {
          (e.target as HTMLElement).blur?.();
        }}
      >
        <LoadingOverlay visible={props.isAnalysing === true} />
        <SegmentedControl
          data={["CP", "WDL"]}
          size="xs"
          value={chartType}
          onChange={(v) => setChartType(v as "CP" | "WDL")}
        />
        {chartType === "CP" && (
          <ResponsiveContainer width="100%" height={150}>
            <RechartsAreaChart data={data} onClick={onChartClick} style={{ cursor: "pointer" }}>
              <defs>
                <linearGradient id={splitId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset={colouroffset} stopColor={theme.colors.gray[1]} stopOpacity={1} />
                  <stop offset={colouroffset} stopColor="black" stopOpacity={1} />
                </linearGradient>
              </defs>
              <XAxis dataKey="name" hide />
              <YAxis domain={[-1, 1]} hide />
              <ReferenceLine x={currentPositionName} stroke={theme.colors[theme.primaryColor][7]} />
              <RechartsTooltip
                content={({ payload, active }) => (
                  <CustomTooltip active={active} payload={payload} type="cp" />
                )}
                animationDuration={0}
              />
              <Area
                type="monotone"
                dataKey="yValue"
                stroke={theme.colors[theme.primaryColor][7]}
                strokeWidth={2}
                fill={`url(#${splitId})`}
                fillOpacity={1}
                connectNulls={false}
                isAnimationActive={false}
                dot={renderDot}
                activeDot={{ r: 3, strokeWidth: 1 }}
              />
            </RechartsAreaChart>
          </ResponsiveContainer>
        )}
        {chartType === "WDL" &&
          (isWDLDisabled ? (
            <Alert variant="outline" title="Enable WDL" mt="sm">
              {t("features.board.analysis.enableWDL")}
            </Alert>
          ) : (
            <AreaChart
              h={150}
              curveType="monotone"
              data={data}
              dataKey={"name"}
              series={[
                { name: "White", color: "white" },
                { name: "Draw", color: "gray" },
                { name: "Black", color: "black" },
              ]}
              connectNulls={false}
              withXAxis={false}
              withYAxis={false}
              type="percent"
              fillOpacity={1}
              activeDotProps={{ r: 3, strokeWidth: 1 }}
              dotProps={{ r: 0 }}
              referenceLines={[
                {
                  x: currentPositionName,
                  color: theme.colors[theme.primaryColor][7],
                },
              ]}
              areaChartProps={{
                onClick: onChartClick,
                style: { cursor: "pointer" },
              }}
              gridAxis="none"
              tooltipProps={{
                content: ({ payload, active }) => (
                  <CustomTooltip active={active} payload={payload} type="wdl" />
                ),
              }}
            />
          ))}
      </Box>
    </Stack>
  );
}

function CustomTooltip({
  active,
  payload,
  type,
}: {
  active?: boolean;
  payload: any;
  type: "cp" | "wdl";
}) {
  if (active && payload && payload.length && payload[0].payload) {
    const dataPoint: DataPoint = payload[0].payload;
    return (
      <Paper px="md" py="sm" withBorder shadow="md" radius="md">
        <Text
          className={classes.tooltipTitle}
          c={dataPoint.color === "gray" ? undefined : dataPoint.color}
        >
          {dataPoint.name}
        </Text>
        <Text>{type === "cp" ? dataPoint.cpText : dataPoint.wdlText}</Text>
      </Paper>
    );
  }
  return null;
}

export default EvalChart;
