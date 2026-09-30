import { ActionIcon, Collapse, Group, Paper, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import type React from "react";

/** The single layout pattern for every section of the Report panel -- board facts,
 * why-a-move-is-good, threats, plans, concepts, the accuracy chart, the move-type
 * summary. All of it stacks as one of these, open by default, instead of some pieces
 * being tabs (hidden until clicked) and others being rows (always visible) -- a
 * genuinely inconsistent mix a person has to learn two different navigation patterns
 * for, not a design choice. Extracted to its own module (not defined inline in
 * ReportPanel.tsx, which itself imports `Explanation`) so `Explanation.tsx` can use the
 * exact same component without a circular import between the two. */
export function CollapsibleSection({
  title,
  defaultOpened = true,
  withPaper = true,
  children,
}: {
  title: string;
  defaultOpened?: boolean;
  /** GameStats already renders its own bordered Paper -- set false there to avoid a
   * Paper nested inside a Paper. */
  withPaper?: boolean;
  children: React.ReactNode;
}) {
  const [opened, { toggle }] = useDisclosure(defaultOpened);

  const header = (
    <Group justify="space-between" wrap="nowrap" onClick={toggle} style={{ cursor: "pointer" }}>
      <Text size="sm" fw="bold" c="dimmed">
        {title}
      </Text>
      <ActionIcon size="sm" variant="subtle">
        {opened ? <IconChevronDown size="1rem" /> : <IconChevronRight size="1rem" />}
      </ActionIcon>
    </Group>
  );

  if (!withPaper) {
    return (
      <Stack gap="xs">
        {header}
        <Collapse expanded={opened}>{children}</Collapse>
      </Stack>
    );
  }

  return (
    <Paper withBorder p={opened ? "md" : "xs"}>
      <div style={{ marginBottom: opened ? "var(--mantine-spacing-xs)" : 0 }}>{header}</div>
      <Collapse expanded={opened}>{children}</Collapse>
    </Paper>
  );
}
