import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { describeWorkspaceFilePath } from "@/command-center/workspace-file-search-model";
import { MaterialFileIcon } from "@/components/material-file-icon";

/** A merge can conflict in hundreds of files; every surface names a few and counts the rest. */
export const PATH_LIST_LIMIT = 5;

/**
 * The one way Arena lists the files a Git problem is about.
 *
 * Never comma-joined into prose: repo-relative paths are long, and five of them in one sentence
 * is unreadable, which is what moved the battle card off that shape. Rows instead, each its own
 * line, filename first with its directory muted behind it — a bare basename is ambiguous in any
 * project with several `index` files. Mono, because a path is code.
 *
 * A labeled conflict list has one count heading followed by compact file rows.
 */
export function ArenaPathList({ paths, label }: { paths: readonly string[]; label?: string }) {
  const hidden = paths.length - PATH_LIST_LIMIT;
  return (
    <View style={[styles.list, label ? styles.conflictList : undefined]} accessibilityLabel={label}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      {paths.slice(0, PATH_LIST_LIMIT).map((path) => {
        const { name, directory } = describeWorkspaceFilePath(path);
        if (label) {
          return (
            <View key={path} style={styles.conflictRow}>
              <MaterialFileIcon fileName={name} size={16} />
              <Text style={styles.conflictFile} numberOfLines={1}>
                {name}
                {directory ? <Text style={styles.directory}> {directory}</Text> : null}
              </Text>
            </View>
          );
        }
        return (
          <Text key={path} style={styles.file} numberOfLines={1}>
            {name}
            {directory ? <Text style={styles.directory}> {directory}</Text> : null}
          </Text>
        );
      })}
      {hidden > 0 ? (
        <Text style={styles.directory}>
          and {hidden} more {hidden === 1 ? "file" : "files"}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: 2,
    paddingVertical: theme.spacing[1],
  },
  conflictList: {
    gap: theme.spacing[2],
  },
  conflictRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  conflictFile: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily?.mono,
    fontSize: theme.fontSize.sm,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  file: {
    color: theme.colors.destructive,
    fontFamily: theme.fontFamily?.mono,
    fontSize: theme.fontSize.xs,
  },
  directory: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily?.mono,
    fontSize: theme.fontSize.xs,
  },
}));
