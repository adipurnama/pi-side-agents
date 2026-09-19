/**
 * Pure worktree slot selection policy for pi-side-agents.
 *
 * Extracted from `allocateWorktree` so the reservation rule can be tested without git, tmux, or the
 * Pi runtime. This module performs no I/O and reads no clock.
 *
 * The rule this module exists for: a slot reserved by an in-flight `agent-start` must be invisible to
 * every other in-flight `agent-start`, even before the slot exists on disk and before its worktree
 * lock file has been written.
 *
 * Plain JavaScript with JSDoc types on purpose: the caller loads it through the Pi extension runtime,
 * and the unit tests load it with plain `node --test`.
 */

import { basename, dirname, join, resolve } from "node:path";

/**
 * @typedef {{ index: number, path: string }} SlotRef
 * @typedef {{ id?: string, status?: string, worktreePath?: string }} SlotPolicyRecord
 * @typedef {{
 *   repoRoot: string,
 *   agentId: string,
 *   slots: SlotRef[],
 *   records: SlotPolicyRecord[],
 *   isTerminal: (status: string | undefined) => boolean,
 *   lockedPaths: Set<string>,
 *   unusablePaths: Set<string>,
 *   registeredPaths: Set<string>,
 * }} SlotPolicyInput
 * @typedef {{
 *   slot: SlotRef,
 *   isRegistered: boolean,
 *   claimedPaths: string[],
 *   reservedIndexes: number[],
 *   unbackedClaims: string[],
 *   warnings: string[],
 * }} SlotPolicyResult
 */

/** Slot name convention: `<repo>-agent-worktree-<4 digits>`, as a sibling of the repository. */
export function slotName(repoRoot, index) {
	return `${basename(repoRoot)}-agent-worktree-${String(index).padStart(4, "0")}`;
}

/** Slot path for an index, using the same convention as `listWorktreeSlots`. */
export function slotPathFor(repoRoot, index) {
	return join(dirname(repoRoot), slotName(repoRoot, index));
}

/**
 * Index of a slot path that belongs to this repository, or `undefined` when the path is not a slot of
 * this repository. Used to count reserved indexes, including slots that do not exist on disk yet.
 *
 * @returns {number | undefined}
 */
export function slotIndexFromPath(repoRoot, path) {
	if (typeof path !== "string" || path.length === 0) return undefined;
	const resolvedPath = resolve(path);
	if (dirname(resolvedPath) !== resolve(dirname(repoRoot))) return undefined;
	const prefix = `${basename(repoRoot)}-agent-worktree-`;
	const name = basename(resolvedPath);
	if (!name.startsWith(prefix)) return undefined;
	const suffix = name.slice(prefix.length);
	if (!/^\d+$/.test(suffix)) return undefined;
	const index = Number(suffix);
	return Number.isFinite(index) && index > 0 ? index : undefined;
}

/** True when this record is the reservation held by this start for this path. */
export function ownsReservation(record, agentId, path) {
	if (!record) return false;
	if (record.id !== agentId) return false;
	if (typeof record.worktreePath !== "string" || record.worktreePath.length === 0) return false;
	return resolve(record.worktreePath) === resolve(path);
}

/**
 * Select a slot and report every reservation it observed.
 *
 * Skip precedence: on-disk lock, another start's reservation, a reserved slot index, then unusable
 * state (non-empty unregistered directory, or an unlocked dirty worktree).
 *
 * A new slot index is chosen above both the highest index on disk and every reserved index, so two
 * concurrent starts that both need a fresh slot cannot compute the same index.
 *
 * @param {SlotPolicyInput} input
 * @returns {SlotPolicyResult}
 */
export function planSlotSelection(input) {
	const { repoRoot, agentId, slots, records, isTerminal, lockedPaths, unusablePaths, registeredPaths } =
		input;

	const warnings = [];
	const claimedPaths = [];
	const reservedIndexes = [];
	const unbackedClaims = [];

	const claimed = new Set();
	const reserved = new Set();

	// Reservation visibility: a non-terminal record with a worktreePath owns that slot, even when the
	// directory does not exist yet and no worktree lock file has been written.
	for (const record of records) {
		if (!record || record.id === agentId) continue;
		if (typeof record.worktreePath !== "string" || record.worktreePath.length === 0) continue;
		if (isTerminal(record.status)) continue;

		const resolvedPath = resolve(record.worktreePath);
		claimed.add(resolvedPath);
		claimedPaths.push(resolvedPath);

		const index = slotIndexFromPath(repoRoot, record.worktreePath);
		if (index !== undefined) {
			reserved.add(index);
			reservedIndexes.push(index);
		}

		// A claim without an on-disk lock is the exact window the allocation lock closes.
		if (!lockedPaths.has(resolvedPath)) {
			unbackedClaims.push(resolvedPath);
			warnings.push(`Worktree claimed by active agent in registry (missing lock): ${record.worktreePath}`);
		}
	}

	let chosen;
	let maxIndex = 0;

	for (const slot of slots) {
		maxIndex = Math.max(maxIndex, slot.index);
		const resolvedSlotPath = resolve(slot.path);

		if (lockedPaths.has(resolvedSlotPath)) continue;
		if (claimed.has(resolvedSlotPath)) continue;
		if (reserved.has(slot.index)) continue;
		if (unusablePaths.has(resolvedSlotPath)) continue;

		chosen = slot;
		break;
	}

	if (!chosen) {
		const next = Math.max(maxIndex, ...reserved, 0) + 1;
		chosen = { index: next, path: slotPathFor(repoRoot, next) };
	}

	return {
		slot: chosen,
		isRegistered: registeredPaths.has(resolve(chosen.path)),
		claimedPaths,
		reservedIndexes,
		unbackedClaims,
		warnings,
	};
}
