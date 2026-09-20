/**
 * The context-boundary rule appended to the kickoff prompt of every side agent.
 *
 * A side agent may use only its explicit handoff, its own checkpoint, explicit human answers, the
 * worktree and repository evidence, and the applicable Repo Contract.
 *
 * Why this exists. The kickoff prompt used to append the parent session file path:
 *
 *   Parent Pi session: /Users/.../sessions/<id>.jsonl
 *
 * Observed in a real run: a continuation packet reached a child in fragments, the child could not
 * find the human's answer among them, and it then recovered the answer by reading that parent
 * transcript. Reading an orchestration transcript is not a legitimate input, and it silently turns a
 * missing handoff into an unlogged dependency on control-plane state. The path is no longer sent, and
 * this rule states the boundary explicitly.
 *
 * The rule is a plain string so the runtime and its unit test share one source of truth.
 */
export const CONTEXT_BOUNDARY_RULE = [
	"",
	"",
	"## Context boundary",
	"You may use only these inputs: this handoff, your own checkpoint, explicit human answers, the",
	"worktree and repository evidence, and the applicable Repo Contract.",
	"A file the control plane names in a message is part of that handoff, and is permitted. Read it.",
	"Do not read a Pi session transcript, a parent session file, an orchestration log, or the state",
	"under .pi/side-agents/. Those are not inputs, even to recover a missing answer.",
	"When an input is missing or ambiguous, stop and report NEEDS_INPUT. Never rebuild a lost",
	"decision from orchestration artifacts.",
].join("\n");
