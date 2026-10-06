import { Text, View, type StyleProp, type TextStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/** A path that wraps only at slashes, so a segment like `generation-2-a` never splits at a hyphen. */
export function WrappedPath({
  path,
  style,
  testID,
}: {
  path: string;
  style: StyleProp<TextStyle>;
  testID?: string;
}) {
  const segments = path.split("/");
  const pieces = segments.map((segment, index) => ({
    // The prefix up to this segment is unique within one path, unlike the segment itself.
    key: segments.slice(0, index + 1).join("/"),
    text: index < segments.length - 1 ? `${segment}/` : segment,
  }));
  return (
    <View style={styles.row} testID={testID}>
      {pieces.map((piece) => (
        <Text key={piece.key} style={style} numberOfLines={1}>
          {piece.text}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    minWidth: 0,
  },
}));
