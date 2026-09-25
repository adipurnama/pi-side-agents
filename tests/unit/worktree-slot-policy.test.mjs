/**
 * Focused unit tests for the pi-side-agents worktree slot reservation policy.
 *
 * Run from the package root:
 *   node --test tests/unit/worktree-slot-policy.test.mjs
 *
 * These tests exercise the pure selection policy directly. They never spawn an agent, never touch a
 * real repository, and never create a worktree. The atomicity of the critical section comes from the
 * pre-existing `withFileLock` registry lock (`fs.open(path, "wx")`); these tests cover the decision
 * logic that lock protects.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	ownsReservation,
	planSlotSelection,
	slotIndexFromPath,
	slotPathFor,
} from "../../src/worktree-slot-policy.js";

const REPO = "/tmp/tests-are-inert/repo-a";

/** Mirrors the extension's isTerminalStatus. */
const isTerminal = (status) =>
	status === "done" || status === "failed" || status === "crashed";

const empty = () => ({
	repoRoot: REPO,
	agentId: "a1",
	slots: [],
	records: [],
	isTerminal,
	lockedPaths: new Set(),
	unusablePaths: new Set(),
	registeredPaths: new Set(),
});

/**
 * Model one serialized critical section. Each step appends the previous step's reservation to the
 * registry exactly as the extension does inside `mutateRegistry`.
 */
function reserveSerially(agentIds, base, mutations = () => ({})) {
	const records = [...(base.records ?? [])];
	const results = [];
	for (const agentId of agentIds) {
		const plan = planSlotSelection({ ...base, agentId, records: [...records], ...mutations(agentId) });
		results.push(plan);
		records.push({ id: agentId, status: "allocating_worktree", worktreePath: plan.slot.path });
	}
	return results;
}

test("CASE A — two concurrent allocations with no reusable slots get distinct slots", () => {
	const results = reserveSerially(["a1", "a2"], empty());

	assert.deepEqual(
		results.map((r) => r.slot.index),
		[1, 2],
	);
	assert.notEqual(results[0].slot.path, results[1].slot.path);
	assert.equal(slotIndexFromPath(REPO, results[1].slot.path), 2);
});

test("CASE A2 — a reserved slot that does not exist on disk is still skipped", () => {
	// The reservation is written before the directory is created. The second start must not reuse it.
	const plan = planSlotSelection({
		...empty(),
		agentId: "a2",
		slots: [],
		records: [{ id: "a1", status: "allocating_worktree", worktreePath: slotPathFor(REPO, 1) }],
	});

	assert.equal(plan.slot.index, 2);
	assert.deepEqual(plan.reservedIndexes, [1]);
	assert.deepEqual(plan.unbackedClaims, [slotPathFor(REPO, 1)]);
	assert.match(plan.warnings.join(" "), /claimed by active agent/);
});

test("CASE B — one clean reusable registered slot goes to exactly one start", () => {
	const slot = { index: 1, path: slotPathFor(REPO, 1) };
	const base = {
		...empty(),
		slots: [slot],
		registeredPaths: new Set([slot.path]),
	};

	const results = reserveSerially(["a1", "a2"], base);

	assert.equal(results[0].slot.index, 1, "the first start takes the reusable slot");
	assert.equal(results[1].slot.index, 2, "the second start must not take it");
	assert.notEqual(results[0].slot.path, results[1].slot.path);
});

test("CASE B2 — an unusable (dirty) reusable slot is never selected", () => {
	const slot = { index: 1, path: slotPathFor(REPO, 1) };
	const plan = planSlotSelection({
		...empty(),
		slots: [slot],
		registeredPaths: new Set([slot.path]),
		unusablePaths: new Set([slot.path]),
	});

	assert.equal(plan.slot.index, 2, "a dirty reusable slot is skipped, a fresh slot is chosen");
	assert.equal(plan.isRegistered, false);
});

test("CASE C — a failed start releases only its own reservation", () => {
	const mine = { id: "a1", status: "allocating_worktree", worktreePath: slotPathFor(REPO, 1) };
	const theirs = { id: "a2", status: "allocating_worktree", worktreePath: slotPathFor(REPO, 2) };

	// Ownership-safe clear: this start owns a1/slot-1 and nothing else.
	assert.equal(ownsReservation(mine, "a1", slotPathFor(REPO, 1)), true);
	assert.equal(ownsReservation(mine, "a1", slotPathFor(REPO, 2)), false, "never clear another path");
	assert.equal(ownsReservation(theirs, "a1", slotPathFor(REPO, 2)), false, "never clear another start");

	// After cleanup, a1 has no worktreePath, so slot 1 is free again.
	const freed = { id: "a1", status: "allocating_worktree" };
	assert.equal(ownsReservation(freed, "a1", slotPathFor(REPO, 1)), false);

	// a2's reservation survives the cleanup untouched.
	const slot1 = { index: 1, path: slotPathFor(REPO, 1) };
	const plan = planSlotSelection({
		...empty(),
		agentId: "a3",
		slots: [slot1],
		registeredPaths: new Set([slot1.path]),
		records: [freed, theirs],
	});
	assert.deepEqual(plan.reservedIndexes, [2], "the released index stays released, a2 stays reserved");
	assert.equal(plan.slot.index, 1, "the released slot-1 is selectable again");
});

test("CASE C2 — a reservation that ends terminal stops blocking its index", () => {
	const plan = planSlotSelection({
		...empty(),
		agentId: "a2",
		records: [
			{ id: "a1", status: "failed", worktreePath: slotPathFor(REPO, 1) },
			{ id: "a3", status: "crashed", worktreePath: slotPathFor(REPO, 2) },
		],
	});

	assert.deepEqual(plan.reservedIndexes, []);
	assert.equal(plan.slot.index, 1, "no live reservation holds an index");
});

test("CASE D — an actively locked worktree is never selected, reset, or cleaned", () => {
	const locked = { index: 1, path: slotPathFor(REPO, 1) };
	const dirty = { index: 2, path: slotPathFor(REPO, 2) };

	const plan = planSlotSelection({
		...empty(),
		slots: [locked, dirty],
		registeredPaths: new Set([locked.path, dirty.path]),
		lockedPaths: new Set([locked.path]),
		unusablePaths: new Set([dirty.path]),
	});

	assert.equal(plan.slot.index, 3, "locked and dirty slots are both skipped");
});

test("CASE E — ten serialized starts reserve ten unique slots", () => {
	const ids = Array.from({ length: 10 }, (_, i) => `a${i + 1}`);
	// One reusable slot exists, so every start after the first must take a fresh index.
	const reusable = { index: 1, path: slotPathFor(REPO, 1) };
	const results = reserveSerially(ids, {
		...empty(),
		slots: [reusable],
		registeredPaths: new Set([reusable.path]),
	});

	const indexes = results.map((r) => r.slot.index);
	const paths = results.map((r) => r.slot.path);

	assert.equal(new Set(indexes).size, 10, "ten unique indexes");
	assert.equal(new Set(paths).size, 10, "ten unique paths");
	assert.equal(indexes[0], 1, "the first start takes the reusable slot");
	assert.deepEqual(
		indexes.slice(1),
		[2, 3, 4, 5, 6, 7, 8, 9, 10],
		"each later start grows past every reserved index",
	);
});

test("CASE E2 — reservations from another repository do not inflate this repository's index", () => {
	const otherRepo = "/tmp/tests-are-inert/repo-b";
	const plan = planSlotSelection({
		...empty(),
		records: [
			{ id: "b1", status: "allocating_worktree", worktreePath: slotPathFor(otherRepo, 9) },
		],
	});

	assert.deepEqual(plan.reservedIndexes, []);
	assert.equal(plan.slot.index, 1);
});

test("slotIndexFromPath ignores paths that are not this repository's slots", () => {
	assert.equal(slotIndexFromPath(REPO, slotPathFor(REPO, 7)), 7);
	assert.equal(slotIndexFromPath(REPO, "/tmp/tests-are-inert/repo-a-other-01"), undefined);
	assert.equal(slotIndexFromPath(REPO, "/tmp/tests-are-inert/elsewhere/repo-a-agent-worktree-0003"), undefined);
	assert.equal(slotIndexFromPath(REPO, ""), undefined);
	assert.equal(slotIndexFromPath(REPO, undefined), undefined);
});
