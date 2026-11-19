import { diffLines } from 'diff';

export type HunkDecision = 'pending' | 'accepted' | 'rejected';

export interface ReviewHunk {
  id: string;
  oldStart: number;
  newStart: number;
  oldOffset: number;
  oldText: string;
  newText: string;
  decision: HunkDecision;
}

export interface ReviewProposal {
  id: string;
  path: string;
  /** null distinguishes a new file from an existing empty file. */
  original: string | null;
  proposed: string;
  hunks: ReviewHunk[];
}

export interface AcceptedEdit {
  path: string;
  original: string | null;
  updated: string;
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    normalized.length === 0 ||
    /[\u0000-\u001f:]/u.test(normalized) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('An edit must use a relative workspace file path without traversal.');
  }
  return normalized;
}

function copyProposal(proposal: ReviewProposal): ReviewProposal {
  return { ...proposal, hunks: proposal.hunks.map((hunk) => ({ ...hunk })) };
}

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split(/\r\n|\r|\n/u).length;
}

/** Builds independent edit groups, retaining exact line endings and byte offsets. */
function makeHunks(id: string, original: string, proposed: string): ReviewHunk[] {
  const hunks: ReviewHunk[] = [];
  let oldOffset = 0;
  let newOffset = 0;
  let pending: ReviewHunk | undefined;

  for (const change of diffLines(original, proposed)) {
    if (!change.added && !change.removed) {
      if (pending) hunks.push(pending);
      pending = undefined;
      oldOffset += change.value.length;
      newOffset += change.value.length;
      continue;
    }

    pending ??= {
      id: `${id}/hunk-${hunks.length + 1}`,
      oldStart: lineAt(original, oldOffset),
      newStart: lineAt(proposed, newOffset),
      oldOffset,
      oldText: '',
      newText: '',
      decision: 'pending',
    };
    if (change.removed) {
      pending.oldText += change.value;
      oldOffset += change.value.length;
    } else {
      pending.newText += change.value;
      newOffset += change.value.length;
    }
  }

  if (pending) hunks.push(pending);
  return hunks;
}

/** In-memory review state. All mutations of workspace documents belong to the caller. */
export class ReviewStore {
  private readonly proposals = new Map<string, ReviewProposal>();
  private nextId = 1;

  propose(path: string, original: string | null, proposed: string): ReviewProposal {
    const normalizedPath = normalizePath(path);
    const existing = this.proposals.get(normalizedPath);
    if (existing) {
      // Retried tool calls preserve the user's decisions and their hunk identifiers.
      if (original === existing.original && proposed === existing.proposed) {
        return copyProposal(existing);
      }
      if (original !== existing.proposed) {
        throw new Error(`The proposal for ${normalizedPath} is stale. Read the staged file again.`);
      }
    }

    const baseline = existing ? existing.original : original;
    const id = `proposal-${this.nextId++}`;
    const hunks = makeHunks(id, baseline ?? '', proposed);
    // Creating an empty file is still an operation requiring a decision.
    if (baseline === null && hunks.length === 0) {
      hunks.push({
        id: `${id}/hunk-1`,
        oldStart: 1,
        newStart: 1,
        oldOffset: 0,
        oldText: '',
        newText: '',
        decision: 'pending',
      });
    }

    const proposal: ReviewProposal = {
      id,
      path: normalizedPath,
      original: baseline,
      proposed,
      hunks,
    };
    this.proposals.set(normalizedPath, proposal);
    return copyProposal(proposal);
  }

  list(): ReviewProposal[] {
    return [...this.proposals.values()].map(copyProposal);
  }

  get(path: string): ReviewProposal | undefined {
    const proposal = this.proposals.get(normalizePath(path));
    return proposal ? copyProposal(proposal) : undefined;
  }

  decide(hunkId: string, accept: boolean): void {
    for (const proposal of this.proposals.values()) {
      const hunk = proposal.hunks.find((candidate) => candidate.id === hunkId);
      if (hunk) {
        hunk.decision = accept ? 'accepted' : 'rejected';
        return;
      }
    }
    throw new Error('This hunk has expired. Open the current proposal before reviewing it.');
  }

  acceptedEdits(): AcceptedEdit[] {
    const edits: AcceptedEdit[] = [];
    for (const proposal of this.proposals.values()) {
      const accepted = proposal.hunks.filter((hunk) => hunk.decision === 'accepted');
      if (accepted.length === 0) continue;

      const original = proposal.original ?? '';
      let offset = 0;
      const parts: string[] = [];
      for (const hunk of accepted) {
        parts.push(original.slice(offset, hunk.oldOffset), hunk.newText);
        offset = hunk.oldOffset + hunk.oldText.length;
      }
      parts.push(original.slice(offset));
      const updated = parts.join('');
      if (proposal.original === null || updated !== original) {
        edits.push({ path: proposal.path, original: proposal.original, updated });
      }
    }
    return edits;
  }

  clear(): void {
    this.proposals.clear();
    // Keep identifiers monotonic so a late UI action cannot target another run.
  }
}
