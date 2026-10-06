export type RefChange = {
  /** Full ref name, such as `refs/heads/main` or `refs/tags/v1`. */
  readonly ref: string
  /** Object id at side setup. Absent when the contestant created the ref. */
  readonly before?: string
  /** Object id at finalize. Absent when the contestant deleted the ref. */
  readonly after?: string
}

export type RefOutcome = {
  readonly ref: string
  readonly action: "created" | "updated" | "deleted" | "skipped"
  /** Present only for `skipped`: one sentence the UI shows. */
  readonly reason?: string
  /** Where the value the write replaced is kept. Present when commits left the ref. */
  readonly backupRef?: string
  /** Commits the ref no longer reaches after the write. */
  readonly removed?: number
  /** How a branch both sides changed was combined, when Arena replayed one side onto the other. */
  readonly how?: "agent_on_yours" | "yours_on_agent"
}
