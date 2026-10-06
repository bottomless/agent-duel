import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { registry, setStoreForTest } from "@/arena/runtime"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import type { ReviewAnswer, ReviewItem } from "@/arena/branch-review"
import { arenaRequest, installOpenRouterStub, json, memoryStore, type PublicSnapshot, waitForTurn } from "./harness"

/** The three namespaces a battle carries over, as `for-each-ref` arguments. */
const CARRIED_NAMESPACES = ["refs/heads/", "refs/tags/", "refs/remotes/"]

async function refNames(directory: string) {
  const listing = await $`git for-each-ref --format="%(refname)" ${CARRIED_NAMESPACES}`.cwd(directory).quiet().text()
  return listing.trim().split("\n").filter(Boolean).sort()
}

/**
 * A commit on top of `parent` that keeps its tree. The developer's own commits in these tests land
 * on branches their checkout is not on, so nothing rewrites the working tree mid-battle and the
 * commit is still an ordinary one with a parent, an author, and an object id of its own.
 */
async function commitOnto(directory: string, parent: string, message: string) {
  const tip = (await $`git rev-parse ${parent}`.cwd(directory).quiet().text()).trim()
  const treeSpec = `${parent}^{tree}`
  const tree = (await $`git rev-parse ${treeSpec}`.cwd(directory).quiet().text()).trim()
  return (await $`git commit-tree ${tree} -p ${tip} -m ${message}`.cwd(directory).quiet().text()).trim()
}

/** Move a branch under the same guard the developer's own `git` would use. */
async function moveBranch(directory: string, branch: string, to: string, from: string) {
  await $`git update-ref ${`refs/heads/${branch}`} ${to} ${from}`.cwd(directory).quiet()
}

async function revision(directory: string, ref: string) {
  return (await $`git rev-parse ${ref}`.cwd(directory).quiet().text()).trim()
}

/**
 * Run one battle in `directory` where both contestants execute `command`, vote for A, and return
 * the winning run and the completed turn. The command drives the scenario, so each test states
 * exactly which refs the contestant touched instead of hoping a model touches them.
 *
 * `beforeVote` runs in the window between `awaiting_vote` and the vote: both runs are finished and
 * their refs are imported under the turn's battle refs, and carry-over has written nothing to the
 * developer's repository yet. That window is the only place a mid-battle change can be staged.
 */
async function carryOverBattle(input: {
  readonly directory: string
  readonly title: string
  readonly prompt: string
  readonly command: string
  readonly beforeVote?: () => Promise<void>
  /** Answers the review, when the vote parks on one. Each call gets the items still open. */
  readonly answer?: (items: readonly ReviewItem[]) => readonly ReviewAnswer[]
}) {
  const memory = memoryStore()
  const router = installOpenRouterStub({
    contestantCommands: { 1: input.command, 2: input.command },
  })
  process.env.OPENCODE_ARENA = "1"
  setStoreForTest(memory.store)
  const request = arenaRequest
  const headers = {
    "content-type": "application/json",
    "x-opencode-directory": input.directory,
  }

  try {
    const source = await json<{ id: string }>(
      await request("/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: input.title }),
      }),
    )
    const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
    const admitted = await json<PublicSnapshot>(
      await request(`/arena/chats/${attached.chat.id}/turns`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: input.prompt }),
      }),
    )
    const turnID = admitted.turn?.id
    if (!turnID) throw new Error("Arena did not return an admitted carry-over turn")
    await waitForTurn(memory.store, turnID, "awaiting_vote")
    if (input.beforeVote) await input.beforeVote()
    await json<PublicSnapshot>(
      await request(`/arena/turns/${turnID}/vote`, {
        method: "POST",
        headers,
        body: JSON.stringify({ vote: "a" }),
      }),
    )
    const reviews: (readonly ReviewItem[])[] = []
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const current = await memory.store.turn(turnID)
      if (current?.state === "complete") break
      const items = current?.state === "application_failed" ? current.gitApplication?.review?.items : undefined
      if (items && current?.gitApplication?.state === "review") {
        if (!input.answer) throw new Error(`Arena parked on a review nobody answers: ${JSON.stringify(items)}`)
        reviews.push(items)
        await json<PublicSnapshot>(
          await request(`/arena/turns/${turnID}/retry-resolution`, {
            method: "POST",
            headers,
            body: JSON.stringify({ answers: input.answer(items) }),
          }),
        )
      }
      await Bun.sleep(100)
    }
    await waitForTurn(memory.store, turnID, "complete")
    const winner = (await memory.store.runsForTurn(turnID)).find((run) => run.side === "a")
    const turn = await memory.store.turn(turnID)
    if (!winner || !turn) throw new Error("Arena did not record the winning run and the completed turn")
    if (!winner.refChanges) throw new Error("Arena did not record the winner's ref changes")
    return { winner, turn, refChanges: winner.refChanges, reviews }
  } finally {
    router.restore()
  }
}

/** Answer every open ref item with `choice`, and fail on any other kind of question. */
function answerRefs(choice: ReviewAnswer["choice"]) {
  return (items: readonly ReviewItem[]) =>
    items.map((item) => {
      if (item.kind !== "ref") throw new Error(`Unexpected review item: ${item.kind}`)
      return { key: item.key, fingerprint: item.fingerprint, choice }
    })
}

afterEach(async () => {
  delete process.env.OPENCODE_ARENA
  setStoreForTest(undefined)
  registry.assignments.clear()
  await disposeAllInstances()
  await resetDatabase()
})

describe("Arena winner ref carry-over", () => {
  test("creates a branch the winner left behind", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure created branch fixture"`.cwd(directory.path).quiet()
    const sourceBranch = (await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()
    const sourceHead = (await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()

    const { refChanges, turn } = await carryOverBattle({
      directory: directory.path,
      title: "Arena carry over created branch",
      prompt: "Spike on a new branch, then come back.",
      command: `git switch -q -c spike && printf 'spike\\n' > spike.txt && git add spike.txt && git commit -q -m "spike" && git switch -q ${sourceBranch}`,
    })

    // The run recorded one created branch: no `before`, and an `after` the chat branch never had.
    expect(refChanges).toHaveLength(1)
    const spike = refChanges[0]
    expect(spike?.ref).toBe("refs/heads/spike")
    expect(spike?.before).toBeUndefined()
    expect(spike?.after).toBeString()
    expect(spike?.after).not.toBe(sourceHead)

    // The checkout stayed where it was and gained the branch.
    expect((await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()).toBe(sourceBranch)
    expect((await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()).toBe(sourceHead)
    expect((await $`git rev-parse refs/heads/spike`.cwd(directory.path).quiet().text()).trim()).toBe(spike?.after)
    expect((await $`git rev-parse refs/heads/spike^`.cwd(directory.path).quiet().text()).trim()).toBe(sourceHead)

    expect(turn.gitApplication).toMatchObject({
      state: "applied",
      refs: [{ ref: "refs/heads/spike", action: "created" }],
    })
  }, 60_000)

  test("deletes a branch the winner removed once the developer agrees", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure deleted branch fixture"`.cwd(directory.path).quiet()
    await $`git branch stale HEAD`.cwd(directory.path).quiet()
    const staleTip = (await $`git rev-parse refs/heads/stale`.cwd(directory.path).quiet().text()).trim()
    const sourceBranch = (await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()

    const { refChanges, turn, reviews } = await carryOverBattle({
      directory: directory.path,
      title: "Arena carry over deleted branch",
      prompt: "Delete the stale branch.",
      command: "git branch -D stale",
      answer: answerRefs("agent"),
    })

    // A delete takes the developer's branch away, so it waits for them even with a backup.
    expect(reviews).toEqual([[expect.objectContaining({ key: "refs/heads/stale", proposal: "agent" })]])

    // The run recorded the deletion: a `before` at the tip the fixture set, and no `after`.
    expect(refChanges).toHaveLength(1)
    const stale = refChanges[0]
    expect(stale?.ref).toBe("refs/heads/stale")
    expect(stale?.before).toBe(staleTip)
    expect(stale?.after).toBeUndefined()

    // The branch is gone from the checkout, which is still on its own branch.
    expect(await refNames(directory.path)).not.toContain("refs/heads/stale")
    expect((await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()).toBe(sourceBranch)

    expect(turn.gitApplication).toMatchObject({
      state: "applied",
      refs: [{ ref: "refs/heads/stale", action: "deleted", backupRef: expect.stringContaining("/replaced/heads/stale") }],
    })
  }, 60_000)

  test("moves a lightweight tag the winner retagged once the developer agrees", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure lightweight tag fixture"`.cwd(directory.path).quiet()
    await $`git tag v1 HEAD`.cwd(directory.path).quiet()
    const firstTag = (await $`git rev-parse refs/tags/v1`.cwd(directory.path).quiet().text()).trim()
    const sourceBranch = (await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()

    // A detached commit keeps the scenario to the tag: no branch of the contestant's own moves.
    const { refChanges, turn, reviews } = await carryOverBattle({
      directory: directory.path,
      title: "Arena carry over lightweight tag",
      prompt: "Retag the release on a fresh commit.",
      command: `git checkout -q --detach && printf 'retagged\\n' > retagged.txt && git add retagged.txt && git commit -q -m "retagged" && git tag -f v1 HEAD && git checkout -q ${sourceBranch}`,
      answer: answerRefs("agent"),
    })

    expect(refChanges).toHaveLength(1)
    const tag = refChanges[0]
    expect(tag?.ref).toBe("refs/tags/v1")
    expect(tag?.before).toBe(firstTag)
    expect(tag?.after).toBeString()
    expect(tag?.after).not.toBe(firstTag)

    // Moving the developer's tag waits for them, even when they left it alone.
    expect(reviews).toEqual([[expect.objectContaining({ key: "refs/tags/v1", proposal: "agent" })]])

    // The tag in the checkout points at the contestant's commit and is still lightweight.
    expect((await $`git rev-parse refs/tags/v1`.cwd(directory.path).quiet().text()).trim()).toBe(tag?.after)
    expect((await $`git cat-file -t refs/tags/v1`.cwd(directory.path).quiet().text()).trim()).toBe("commit")

    expect(turn.gitApplication).toMatchObject({
      state: "applied",
      refs: [{ ref: "refs/tags/v1", action: "updated" }],
    })
  }, 60_000)

  test("creates an annotated tag as a tag object rather than the commit it points at", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure annotated tag fixture"`.cwd(directory.path).quiet()
    const sourceHead = (await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()

    const { refChanges, turn } = await carryOverBattle({
      directory: directory.path,
      title: "Arena carry over annotated tag",
      prompt: "Tag the current commit for release.",
      command: 'git tag -a v2 -m "release two" HEAD',
    })

    expect(refChanges).toHaveLength(1)
    const tag = refChanges[0]
    expect(tag?.ref).toBe("refs/tags/v2")
    expect(tag?.before).toBeUndefined()
    // The recorded object is the tag object, not the commit the tag points at.
    expect(tag?.after).toBeString()
    expect(tag?.after).not.toBe(sourceHead)

    expect((await $`git rev-parse refs/tags/v2`.cwd(directory.path).quiet().text()).trim()).toBe(tag?.after)
    expect((await $`git cat-file -t refs/tags/v2`.cwd(directory.path).quiet().text()).trim()).toBe("tag")
    expect((await $`git rev-parse refs/tags/v2^{commit}`.cwd(directory.path).quiet().text()).trim()).toBe(sourceHead)

    expect(turn.gitApplication).toMatchObject({
      state: "applied",
      refs: [{ ref: "refs/tags/v2", action: "created" }],
    })
  }, 60_000)

  test("moves a remote-tracking ref the winner advanced", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure remote-tracking fixture"`.cwd(directory.path).quiet()
    await $`git remote add origin https://example.invalid/carry.git`.cwd(directory.path).quiet()
    await $`git update-ref refs/remotes/origin/main HEAD`.cwd(directory.path).quiet()
    const remoteTip = (await $`git rev-parse refs/remotes/origin/main`.cwd(directory.path).quiet().text()).trim()
    const sourceBranch = (await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()

    const { refChanges, turn } = await carryOverBattle({
      directory: directory.path,
      title: "Arena carry over remote ref",
      prompt: "Advance the tracked remote branch.",
      command: `git checkout -q --detach && printf 'fetched\\n' > fetched.txt && git add fetched.txt && git commit -q -m "fetched" && git update-ref refs/remotes/origin/main HEAD && git checkout -q ${sourceBranch}`,
    })

    expect(refChanges).toHaveLength(1)
    const remote = refChanges[0]
    expect(remote?.ref).toBe("refs/remotes/origin/main")
    expect(remote?.before).toBe(remoteTip)
    expect(remote?.after).toBeString()
    expect(remote?.after).not.toBe(remoteTip)

    expect((await $`git rev-parse refs/remotes/origin/main`.cwd(directory.path).quiet().text()).trim()).toBe(
      remote?.after,
    )
    expect((await $`git rev-parse refs/remotes/origin/main^`.cwd(directory.path).quiet().text()).trim()).toBe(remoteTip)

    expect(turn.gitApplication).toMatchObject({
      state: "applied",
      refs: [{ ref: "refs/remotes/origin/main", action: "updated" }],
    })
  }, 60_000)

  test("switches the workspace to an existing branch that does not contain the chat branch", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure switched branch fixture"`.cwd(directory.path).quiet()
    await $`git branch -m chat-work`.cwd(directory.path).quiet()
    // The feature branch forks before the chat branch's newest commit, so the chat branch's HEAD
    // is not in its history -- the case the old ancestry guard refused.
    await $`git branch feature HEAD`.cwd(directory.path).quiet()
    const featureTip = await revision(directory.path, "refs/heads/feature")
    await Bun.write(`${directory.path}/chat.txt`, "chat\n")
    await $`git add chat.txt && git commit -q -m "chat only"`.cwd(directory.path).quiet()
    const chatTip = await revision(directory.path, "HEAD")

    const { winner, turn, reviews } = await carryOverBattle({
      directory: directory.path,
      title: "Arena carry over switched branch",
      prompt: "Move the work to the feature branch.",
      command: `git checkout -q feature && printf 'feature\\n' > feature.txt && git add feature.txt && git commit -q -m "winner on feature"`,
    })

    // The agent only added commits to a branch nobody else moved, so nothing is asked.
    expect(reviews).toEqual([])
    expect(turn.gitApplication?.state).toBe("applied")
    expect((await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()).toBe("feature")
    expect(await revision(directory.path, "HEAD")).toBe(winner.rawHead)
    expect(await revision(directory.path, "HEAD^")).toBe(featureTip)
    // The chat branch is left where it was.
    expect(await revision(directory.path, "refs/heads/chat-work")).toBe(chatTip)
  }, 60_000)

  test("stays quiet when the winner touched nothing but its own branch", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure quiet fixture"`.cwd(directory.path).quiet()
    await $`git branch untouched HEAD`.cwd(directory.path).quiet()
    await $`git tag v0 HEAD`.cwd(directory.path).quiet()
    const sourceBranch = (await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()
    const sourceHead = (await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()
    const namesBefore = await refNames(directory.path)

    const { winner, refChanges, turn } = await carryOverBattle({
      directory: directory.path,
      title: "Arena carry over quiet battle",
      prompt: "Record the result on this branch only.",
      command: `printf 'quiet\\n' > quiet.txt && git add quiet.txt && git commit -q -m "quiet"`,
    })

    // The run recorded its own branch moving forward, and nothing else.
    expect(refChanges).toEqual([{ ref: `refs/heads/${sourceBranch}`, before: sourceHead, after: winner.agentCommit }])

    // The commit landed on the chat branch and nothing else in the three namespaces moved.
    expect((await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()).toBe(sourceBranch)
    expect((await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()).toBe(winner.agentCommit)
    expect((await $`git rev-parse HEAD^`.cwd(directory.path).quiet().text()).trim()).toBe(sourceHead)
    expect(await refNames(directory.path)).toEqual(namesBefore)
    expect((await $`git rev-parse refs/heads/untouched`.cwd(directory.path).quiet().text()).trim()).toBe(sourceHead)
    expect((await $`git rev-parse refs/tags/v0`.cwd(directory.path).quiet().text()).trim()).toBe(sourceHead)

    // The trunk's own branch moves with the checkout, not in the outcome list, so the battle
    // summary shows no carry-over notice.
    expect(turn.gitApplication?.state).toBe("applied")
    expect(turn.gitApplication?.refs).toBeUndefined()
  }, 60_000)

  test("carries two branches the winner moved in one battle", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure two branch fixture"`.cwd(directory.path).quiet()
    await $`git branch alpha HEAD`.cwd(directory.path).quiet()
    await $`git branch beta HEAD`.cwd(directory.path).quiet()
    const alphaTip = (await $`git rev-parse refs/heads/alpha`.cwd(directory.path).quiet().text()).trim()
    const betaTip = (await $`git rev-parse refs/heads/beta`.cwd(directory.path).quiet().text()).trim()
    const sourceBranch = (await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()
    const sourceHead = (await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()

    const { refChanges, turn } = await carryOverBattle({
      directory: directory.path,
      title: "Arena carry over two branches",
      prompt: "Commit on both feature branches, then come back.",
      command: `git checkout -q alpha && printf 'alpha\\n' > alpha.txt && git add alpha.txt && git commit -q -m "alpha" && git checkout -q beta && printf 'beta\\n' > beta.txt && git add beta.txt && git commit -q -m "beta" && git checkout -q ${sourceBranch}`,
    })

    // `diffHostRefs` sorts by ref name, so alpha precedes beta.
    expect(refChanges).toHaveLength(2)
    const [alpha, beta] = refChanges
    expect(alpha?.ref).toBe("refs/heads/alpha")
    expect(alpha?.before).toBe(alphaTip)
    expect(alpha?.after).toBeString()
    expect(beta?.ref).toBe("refs/heads/beta")
    expect(beta?.before).toBe(betaTip)
    expect(beta?.after).toBeString()

    // Both branches advanced by one commit in the checkout; the chat branch did not move.
    expect((await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()).toBe(sourceHead)
    expect((await $`git rev-parse refs/heads/alpha`.cwd(directory.path).quiet().text()).trim()).toBe(alpha?.after)
    expect((await $`git rev-parse refs/heads/alpha^`.cwd(directory.path).quiet().text()).trim()).toBe(alphaTip)
    expect((await $`git rev-parse refs/heads/beta`.cwd(directory.path).quiet().text()).trim()).toBe(beta?.after)
    expect((await $`git rev-parse refs/heads/beta^`.cwd(directory.path).quiet().text()).trim()).toBe(betaTip)

    // Exactly those two entries, nothing else.
    expect(turn.gitApplication?.state).toBe("applied")
    expect(turn.gitApplication?.refs).toEqual([
      { ref: "refs/heads/alpha", action: "updated" },
      { ref: "refs/heads/beta", action: "updated" },
    ])
  }, 60_000)

  test("combines a branch the developer moved elsewhere during the battle", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure diverged branch fixture"`.cwd(directory.path).quiet()
    // `git init` names the first branch from `init.defaultBranch`, which is `main` on many
    // machines, and the promotion owns the chat branch and never reports it. Rename the chat
    // branch so `main` is a branch of the developer's own, whatever git called the first one.
    await $`git branch -m chat-work`.cwd(directory.path).quiet()
    await $`git branch main HEAD`.cwd(directory.path).quiet()
    const mainTip = await revision(directory.path, "refs/heads/main")

    let developerTip = ""
    const { winner, refChanges, turn, reviews } = await carryOverBattle({
      directory: directory.path,
      title: "Arena carry over diverged branch",
      prompt: "Commit on main, then come back.",
      command: `git checkout -q main && printf 'winner\\n' > winner.txt && git add winner.txt && git commit -q -m "winner on main" && git checkout -q chat-work`,
      beforeVote: async () => {
        // The developer commits their own work on `main` while the battle waits for the vote.
        developerTip = await commitOnto(directory.path, "refs/heads/main", "developer on main")
        await moveBranch(directory.path, "main", developerTip, mainTip)
      },
    })

    expect(refChanges).toHaveLength(1)
    const main = refChanges[0]
    expect(main?.ref).toBe("refs/heads/main")
    expect(main?.before).toBe(mainTip)
    expect(main?.after).toBeString()
    expect(main?.after).not.toBe(developerTip)

    // The two commits are siblings and the replay is clean, so Arena replays the winner's commit
    // onto the developer's without a question, and says so.
    expect(reviews).toEqual([])
    expect(turn.gitApplication).toMatchObject({
      state: "applied",
      refs: [{ ref: "refs/heads/main", action: "updated", how: "agent_on_yours" }],
    })

    // The developer's commit stays in the branch, with the winner's replayed on top of it.
    expect(await revision(directory.path, "refs/heads/main^")).toBe(developerTip)
    expect((await $`git log -1 --format=%s refs/heads/main`.cwd(directory.path).quiet().text()).trim()).toBe(
      "winner on main",
    )
    // The winner's own tip stays under the turn's battle ref.
    expect(winner.permanentRef).toBeString()
    expect(await revision(directory.path, `${winner.permanentRef}-refs/heads/main`)).toBe(main?.after)
  }, 60_000)

  test("follows the developer forward on one branch and replays the winner onto their rewind on another", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure fast-forward fixture"`.cwd(directory.path).quiet()
    const sourceBranch = (await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()
    const baseTip = await revision(directory.path, "HEAD")
    const olderTip = await revision(directory.path, "HEAD^")
    await $`git branch alpha HEAD`.cwd(directory.path).quiet()
    await $`git branch beta HEAD`.cwd(directory.path).quiet()
    // A line of commits past `alpha` that both sides can reach, which is what a shared remote
    // gives them in real life: the contestant takes all of it, the developer takes the first.
    const sharedFirst = await commitOnto(directory.path, "HEAD", "shared one")
    const sharedSecond = await commitOnto(directory.path, sharedFirst, "shared two")
    await $`git update-ref refs/heads/upstream ${sharedSecond}`.cwd(directory.path).quiet()

    const { winner, refChanges, turn, reviews } = await carryOverBattle({
      directory: directory.path,
      title: "Arena carry over fast forward",
      prompt: "Take the upstream work on alpha, commit on both, then come back.",
      command: `git checkout -q alpha && git merge -q --ff-only upstream && printf 'alpha\\n' > alpha.txt && git add alpha.txt && git commit -q -m "alpha" && git checkout -q beta && printf 'beta\\n' > beta.txt && git add beta.txt && git commit -q -m "beta" && git checkout -q ${sourceBranch}`,
      beforeVote: async () => {
        // `alpha` moves forward along the same line the winner took, and `beta` is rewound.
        await moveBranch(directory.path, "alpha", sharedFirst, baseTip)
        await moveBranch(directory.path, "beta", olderTip, baseTip)
      },
    })

    // `upstream` did not move, so only the two branches the contestant touched are reported.
    expect(refChanges).toHaveLength(2)
    const [alpha, beta] = refChanges
    expect(alpha?.ref).toBe("refs/heads/alpha")
    expect(alpha?.before).toBe(baseTip)
    expect(beta?.ref).toBe("refs/heads/beta")
    expect(beta?.before).toBe(baseTip)

    // Neither is a question: `alpha` follows the developer forward, and the winner's commit on
    // `beta` replays cleanly onto the developer's rewind.
    expect(reviews).toEqual([])
    expect(turn.gitApplication?.state).toBe("applied")
    expect(turn.gitApplication?.refs).toEqual([
      { ref: "refs/heads/alpha", action: "updated" },
      { ref: "refs/heads/beta", action: "updated", how: "agent_on_yours" },
    ])

    // `alpha`: the developer advanced it to a commit the winner already had, so Arena follows them
    // forward and the commit they took is still on the branch.
    expect(await revision(directory.path, "refs/heads/alpha")).toBe(alpha?.after)
    expect(await revision(directory.path, `${sharedFirst}^`)).toBe(baseTip)
    await $`git merge-base --is-ancestor ${sharedFirst} refs/heads/alpha`.cwd(directory.path).quiet()

    // `beta`: the developer's rewind stays, with the winner's commit on top of it.
    expect(await revision(directory.path, "refs/heads/beta^")).toBe(olderTip)
    expect((await $`git log -1 --format=%s refs/heads/beta`.cwd(directory.path).quiet().text()).trim()).toBe("beta")
    expect(winner.permanentRef).toBeString()
    expect(await revision(directory.path, `${winner.permanentRef}-refs/heads/beta`)).toBe(beta?.after)
  }, 60_000)

  test("skips a name git cannot hold and still applies the rest of the list", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure colliding name fixture"`.cwd(directory.path).quiet()
    const sourceBranch = (await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()
    const baseTip = await revision(directory.path, "HEAD")
    await $`git branch docs HEAD`.cwd(directory.path).quiet()

    const { refChanges, turn } = await carryOverBattle({
      directory: directory.path,
      title: "Arena carry over colliding name",
      prompt: "Commit on docs and open a release branch.",
      command: `git checkout -q docs && printf 'docs\\n' > docs.txt && git add docs.txt && git commit -q -m "docs" && git checkout -q ${sourceBranch} && git branch release/2 HEAD`,
      beforeVote: async () => {
        // The developer opens `release` while the battle runs. Git cannot hold that name and
        // `release/2` at once. The branch cannot exist at setup instead: the host mirrors the
        // canonical refs, so the contestant could not have created `release/2` there either.
        await $`git branch release HEAD`.cwd(directory.path).quiet()
      },
    })

    // `diffHostRefs` sorts by ref name, so `docs` precedes `release/2`.
    expect(refChanges).toHaveLength(2)
    const [docs, release] = refChanges
    expect(docs?.ref).toBe("refs/heads/docs")
    expect(docs?.after).toBeString()
    expect(release?.ref).toBe("refs/heads/release/2")
    expect(release?.before).toBeUndefined()
    expect(release?.after).toBe(baseTip)

    // The turn completed, and the one impossible name did not strand the branch beside it.
    expect(turn.state).toBe("complete")
    expect(turn.gitApplication?.state).toBe("applied")
    const outcomes = turn.gitApplication?.refs ?? []
    expect(outcomes).toHaveLength(2)
    expect(outcomes[0]).toEqual({ ref: "refs/heads/docs", action: "updated" })
    expect(outcomes[1]?.ref).toBe("refs/heads/release/2")
    expect(outcomes[1]?.action).toBe("skipped")
    // Git's own message, so the developer reads the collision rather than a guess at it.
    expect(outcomes[1]?.reason).toStartWith("release/2 could not be written: ")
    expect(outcomes[1]?.reason).toContain("'refs/heads/release' exists")

    expect(await revision(directory.path, "refs/heads/docs")).toBe(docs?.after)
    expect(await revision(directory.path, "refs/heads/release")).toBe(baseTip)
    expect(await refNames(directory.path)).not.toContain("refs/heads/release/2")
  }, 60_000)

  test("takes a branch another worktree has checked out only when the developer agrees", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await using elsewhere = await tmpdir()
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure checked out branch fixture"`.cwd(directory.path).quiet()
    // The chat branch is renamed for the same reason as in the diverged-branch test above.
    await $`git branch -m chat-work`.cwd(directory.path).quiet()
    await $`git branch main HEAD`.cwd(directory.path).quiet()
    const mainTip = await revision(directory.path, "refs/heads/main")
    const second = path.join(elsewhere.path, "arena-second-worktree")

    const { winner, refChanges, turn, reviews } = await carryOverBattle({
      answer: answerRefs("agent"),
      directory: directory.path,
      title: "Arena carry over checked out branch",
      prompt: "Commit on main, then come back.",
      command: `git checkout -q main && printf 'winner\\n' > winner.txt && git add winner.txt && git commit -q -m "winner on main" && git checkout -q chat-work`,
      beforeVote: async () => {
        // The developer opens a second worktree on `main` while the battle waits for the vote.
        await $`git worktree add ${second} main`.cwd(directory.path).quiet()
      },
    })

    expect(refChanges).toHaveLength(1)
    const main = refChanges[0]
    expect(main?.ref).toBe("refs/heads/main")
    expect(main?.before).toBe(mainTip)
    expect(main?.after).toBeString()

    // A lossless move is still asked, because the other worktree loses its branch.
    expect(reviews[0]).toMatchObject([{ key: "refs/heads/main", proposal: "agent", choices: ["agent", "yours"] }])
    expect(reviews[0]?.[0]?.kind === "ref" && reviews[0][0].checkedOutAt).toEndWith("/arena-second-worktree")
    expect(turn.gitApplication).toMatchObject({ state: "applied", refs: [{ ref: "refs/heads/main", action: "updated" }] })

    // The branch moved, and the other worktree stayed on its commit, detached, with its files.
    expect(await revision(directory.path, "refs/heads/main")).toBe(main?.after)
    expect(await revision(second, "HEAD")).toBe(mainTip)
    expect((await $`git branch --show-current`.cwd(second).quiet().text()).trim()).toBe("")
    expect(winner.permanentRef).toBeString()
  }, 60_000)
})
