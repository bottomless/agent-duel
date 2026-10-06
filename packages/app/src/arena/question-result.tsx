import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ArenaQuestionResult } from "./question";

export function ArenaQuestionResultView({ result }: { result: ArenaQuestionResult }) {
  const answered = result.questions.filter((question) => question.answers.length > 0).length;
  return (
    <View style={styles.exchange} testID="arena-question-result">
      <Text style={styles.heading}>
        Questions{" "}
        <Text style={styles.muted}>
          {answered}/{result.questions.length} answered{result.interrupted ? " (interrupted)" : ""}
        </Text>
      </Text>
      {result.questions.map((question, index) => (
        <View key={JSON.stringify([question.question, index])} style={styles.question}>
          <Text selectable style={styles.prompt}>
            {question.question}
            {question.answers.length === 0 ? <Text style={styles.muted}> (unanswered)</Text> : null}
          </Text>
          {question.answers.map((answer, answerIndex) => (
            <Text key={JSON.stringify([answer, answerIndex])} selectable style={styles.answer}>
              <Text style={styles.muted}>answer: </Text>
              {answer}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  exchange: {
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
  },
  question: {
    gap: theme.spacing[1],
  },
  prompt: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  answer: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.sm,
    paddingLeft: theme.spacing[3],
  },
}));
