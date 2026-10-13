// src/prompts.ts

export interface EditorContext {
  fileName: string;
  relativePath: string;
  languageId: string;
  selection: boolean;
  startLine: number;
  endLine: number;
  code: string;
  truncated: boolean;
}

/** An extra file attached to the chat (via @mention, the + File button, or open tabs). */
export interface FileContext {
  relativePath: string;
  languageId: string;
  code: string;
  truncated: boolean;
}

export const DEFAULT_SYSTEM_PROMPT = [
  'You are Errix, an expert AI pair programmer embedded in Visual Studio Code.',
  '',
  'Rules:',
  '- Be concise and concrete. Prefer short paragraphs and bullet points over walls of text.',
  '- Always put code in fenced blocks with the correct language tag.',
  '- When asked to change code, return the complete replacement block, not a diff fragment.',
  '- Never invent APIs, packages, or file paths. If you are unsure, say so.',
  '- When several files are provided, say which file each suggestion applies to.',
  '- Assume the user is an experienced engineer; skip basics unless asked.',
  "- Do not repeat the user's code back to them unless it is part of a change you are proposing."
].join('\n');

export type ActionId = 'explain' | 'refactor' | 'generateTests' | 'fix';

export const ACTION_PROMPTS: Record<ActionId, { label: string; prompt: string }> = {
  explain: {
    label: 'Explain this code',
    prompt: [
      'Explain the code in the context block.',
      '',
      '1. What it does, in one or two sentences.',
      '2. A step-by-step walkthrough of the important parts.',
      '3. Anything surprising, risky, or worth refactoring.',
      '',
      'Use headings and short bullets. Do not rewrite the code.'
    ].join('\n')
  },

  refactor: {
    label: 'Refactor this code',
    prompt: [
      'Refactor the code in the context block for readability, correctness, and idiomatic style.',
      '',
      'Return:',
      '- A short paragraph on what changed and why.',
      '- The full refactored code in a single fenced code block, ready to paste over the original.',
      '',
      'Preserve public behaviour unless it is clearly a bug. Do not add new dependencies.'
    ].join('\n')
  },

  generateTests: {
    label: 'Generate tests',
    prompt: [
      'Write tests for the code in the context block.',
      '',
      '- Match the testing framework already used in this project.',
      '- If you cannot tell which framework is in use, pick the most common one for the language and say which you chose.',
      '- Cover the happy path, edge cases, and error paths.',
      '- Return the complete test file in a single fenced code block.'
    ].join('\n')
  },

  fix: {
    label: 'Fix this code',
    prompt: [
      'Find and fix the bug in the code in the context block.',
      '',
      'Return:',
      '- The root cause, in one or two sentences.',
      '- The corrected code in a single fenced code block.',
      '',
      'If there is no bug, say so plainly and point out the most likely source of the problem.'
    ].join('\n')
  }
};

/**
 * Builds the <context> block. The active editor file comes first, then any extra files.
 * IMPORTANT: there must be exactly one </context> in the output, because chatProvider.ts
 * strips this block from older messages with a regex.
 */
export function buildContextBlock(ctx: EditorContext | null, extras: FileContext[] = []): string {
  if (!ctx && extras.length === 0) return '';

  const fence = '```';
  const parts: string[] = ['<context>'];

  if (ctx) {
    const scope = ctx.selection
      ? `selection, lines ${ctx.startLine}-${ctx.endLine}`
      : 'entire file';

    parts.push(
      `File: ${ctx.relativePath}`,
      `Language: ${ctx.languageId}`,
      `Scope: ${scope}${ctx.truncated ? ' (truncated to fit the context limit)' : ''}`,
      `${fence}${ctx.languageId}`,
      ctx.code,
      fence
    );
  }

  for (const file of extras) {
    parts.push(
      '',
      `Additional file: ${file.relativePath}${file.truncated ? ' (truncated to fit the context budget)' : ''}`,
      `Language: ${file.languageId}`,
      `${fence}${file.languageId}`,
      file.code,
      fence
    );
  }

  parts.push('</context>');
  return parts.join('\n');
}

/** System prompt for inline edits (Ctrl+Alt+K): the model must return only the new selection. */
export const EDIT_SYSTEM_PROMPT = [
  'You are the Errix code editing engine inside Visual Studio Code.',
  '',
  'You receive file context, a selected region, and an instruction.',
  '',
  'Rules:',
  '- Return ONLY the new version of the selected region, in exactly one fenced code block. No text before or after it.',
  '- Return the complete replacement for the selection, not a diff and not just the changed lines.',
  '- Match the existing indentation, quote style, and naming conventions.',
  '- Never include code from outside the selected region.',
  '- If the instruction cannot be done safely, return the selection unchanged.'
].join('\n');